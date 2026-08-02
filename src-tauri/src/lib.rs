use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::WebviewWindowBuilder;
use tauri::WebviewUrl;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::Mutex;



static MENU_REFRESH_PENDING: AtomicBool = AtomicBool::new(false);

struct AppState {
    login_active: AtomicBool,
}

type WsSender = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>
    >,
    tokio_tungstenite::tungstenite::Message,
>;

struct ChatConnection {
    sender: Mutex<Option<WsSender>>,
    connected: AtomicBool,
    stop_requested: AtomicBool,
    connection_id: AtomicU64,
    sent_messages: Mutex<VecDeque<(u64, String)>>,
    user_state: Mutex<Option<UserState>>,
}

struct ChatState {
    connections: tokio::sync::RwLock<std::collections::HashMap<String, Arc<ChatConnection>>>,
}

fn token_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    std::path::PathBuf::from(home).join(".twitch-ultra-ligero-oauth-token")
}

fn username_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    std::path::PathBuf::from(home).join(".twitch-ultra-ligero-username")
}

fn load_oauth_token() -> Option<String> {
    std::fs::read_to_string(token_path()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn load_twitch_username() -> Option<String> {
    std::fs::read_to_string(username_path()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn save_twitch_username(username: &str) {
    let _ = std::fs::write(username_path(), username);
}

async fn get_helix_token(app: &tauri::AppHandle) -> Result<String, String> {
    if let Some(token) = load_oauth_token() {
        log_to_file(&format!("[HELIX-TOKEN] Got file token: {}...", &token[..token.len().min(8)]));
        return Ok(token);
    }
    log_to_file("[HELIX-TOKEN] No file token, trying cookie fallback...");

    let handle = app.clone();
    let cookies: Vec<_> = tokio::task::spawn_blocking(move || {
        let webview = handle
            .get_webview_window("main")
            .ok_or("Ventana principal no encontrada")?;
        webview.cookies().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let token = cookies
        .iter()
        .find(|c| {
            c.name() == "auth-token"
                && c.domain()
                    .map(|d: &str| d.contains("twitch.tv"))
                    .unwrap_or(false)
        })
        .map(|c| c.value().to_string());

    if let Some(login_cookie) = cookies.iter().find(|c| {
        c.name() == "login"
            && c.domain()
                .map(|d: &str| d.contains("twitch.tv"))
                .unwrap_or(false)
    }) {
        let username = login_cookie.value().to_string();
        if !username.is_empty() {
            save_twitch_username(&username);
            log_to_file(&format!("[HELIX-TOKEN] Username from cookie: {}", username));
        }
    }

    match &token {
        Some(t) => log_to_file(&format!("[HELIX-TOKEN] Got cookie token: {}...", &t[..t.len().min(8)])),
        None => log_to_file("[HELIX-TOKEN] No cookie token found either!"),
    }

    token.ok_or_else(|| "No hay token disponible (ni archivo ni cookie)".to_string())
}

fn save_oauth_token(token: &str) {
    let preview = if token.len() > 5 { &token[..5] } else { token };
    log_to_file(&format!("[TOKEN] Saving token: len={} preview='{}...'", token.len(), preview));
    let _ = std::fs::write(token_path(), token);
}

fn log_to_file(msg: &str) {
    let path = std::env::temp_dir().join("twitch_ultra_log.txt");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] {}", chrono_like_time(), msg);
    }
}

fn debug_chat(msg: &str) {
    let path = std::env::temp_dir().join("twitch_chat_debug.txt");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] {}", chrono_like_time(), msg);
    }
}

fn chrono_like_time() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() % 86400;
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    let ms = d.subsec_millis();
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

#[derive(Debug, Clone, Serialize)]
struct StreamInfo {
    name: String,
    url: String,
}

const TWITCH_PUBLIC_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TWITCH_GQL_ENDPOINT: &str = "https://gql.twitch.tv/gql";
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[tauri::command]
async fn list_streams(app: tauri::AppHandle, channel: &str) -> Result<Vec<StreamInfo>, String> {
    let (sig, token) = playback_access_token(&app, channel).await?;

    let master_url = reqwest::Url::parse_with_params(
        &format!("https://usher.ttvnw.net/api/channel/hls/{}.m3u8", channel),
        &[
            ("allow_source", "true"),
            ("allow_audio_only", "true"),
            ("allow_spectre", "true"),
            ("fast_bread", "true"),
            ("playlist_include_framerate", "true"),
            ("reassignments_supported", "true"),
            ("supported_codecs", "avc1,hvc1,av01"),
            ("p", TWITCH_PUBLIC_CLIENT_ID),
            ("player", "twitchweb"),
            ("sig", &sig),
            ("token", &token),
        ],
    )
    .map_err(|e| format!("Error construyendo la URL del CDN: {}", e))?;

    let resp = reqwest::Client::new()
        .get(master_url.clone())
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("Error consultando el CDN de Twitch: {}", e))?;

    if !resp.status().is_success() {
        return Err("El canal esta offline o no existe.".into());
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;

    let master_url_str = master_url.as_str().to_string();
    let mut streams = parse_master_playlist(&text, &master_url_str);

    streams.sort_by(|a, b| {
        let ka = quality_sort_key(&a.name);
        let kb = quality_sort_key(&b.name);
        kb.cmp(&ka)
    });

    Ok(streams)
}

async fn playback_access_token(
    app: &tauri::AppHandle,
    channel: &str,
) -> Result<(String, String), String> {
    let oauth = {
        let app = app.clone();
        tokio::task::spawn_blocking(move || get_auth_token(&app))
            .await
            .map_err(|e| e.to_string())?
    };

    let body = serde_json::json!({
        "query": "query PlaybackAccessToken_Template($login: String!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) { value signature __typename } }",
        "variables": {
            "login": channel,
            "playerType": "embed"
        }
    });

    let mut req = reqwest::Client::new()
        .post(TWITCH_GQL_ENDPOINT)
        .header("Client-ID", TWITCH_PUBLIC_CLIENT_ID)
        .header("Content-Type", "application/json")
        .header("User-Agent", BROWSER_UA)
        .json(&body);

    if let Some(tok) = oauth {
        req = req.header("Authorization", format!("OAuth {}", tok));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Error contactando la API de Twitch: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Error parseando la respuesta de Twitch: {}", e))?;

    if let Some(err) = json["error"].as_str() {
        return Err(format!("Twitch: {}", err));
    }

    let data = &json["data"]["streamPlaybackAccessToken"];
    let token = data["value"]
        .as_str()
        .ok_or("El canal esta offline o no existe.")?
        .to_string();
    let sig = data["signature"]
        .as_str()
        .ok_or("No se pudo obtener la firma de acceso.")?
        .to_string();

    Ok((sig, token))
}

fn parse_master_playlist(text: &str, master_url: &str) -> Vec<StreamInfo> {
    let mut result = Vec::new();
    let mut pending: Option<String> = None;
    let mut seen: HashMap<String, u32> = HashMap::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let mut name = None;
            for attr in split_attributes(rest) {
                if let Some(v) = attr.strip_prefix("VIDEO=") {
                    name = Some(v.trim_matches('"').to_string());
                }
            }
            if name.is_none() {
                for attr in split_attributes(rest) {
                    if let Some(v) = attr.strip_prefix("AUDIO=") {
                        if v.trim_matches('"') == "audio_only" {
                            name = Some("audio_only".to_string());
                        }
                    }
                }
            }
            pending = name;
        } else if !line.starts_with('#') {
            if let Some(base) = pending.take() {
                let url = resolve_playlist_url(master_url, line);
                if !url.is_empty() {
                    result.push(StreamInfo {
                        name: unique_stream_name(normalize_stream_name(&base).to_string(), &mut seen),
                        url,
                    });
                }
            }
        }
    }

    result
}

fn normalize_stream_name(name: &str) -> &str {
    if name == "chunked" {
        return "source";
    }
    if let Some(stripped) = name.strip_suffix("30") {
        if stripped.ends_with('p') {
            return stripped;
        }
    }
    name
}

fn split_attributes(rest: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for c in rest.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                cur.push(c);
            }
            ',' if !in_quotes => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

fn resolve_playlist_url(master_url: &str, child: &str) -> String {
    if child.starts_with("http://") || child.starts_with("https://") {
        return child.to_string();
    }
    let base = master_url.rsplit_once('/').map(|(b, _)| b).unwrap_or("");
    format!("{}/{}", base, child)
}

fn unique_stream_name(base: String, seen: &mut HashMap<String, u32>) -> String {
    let n = seen.entry(base.clone()).or_insert(0);
    *n += 1;
    if *n == 1 {
        base
    } else {
        format!(
            "{}_{}",
            base,
            if *n == 2 {
                "alt".to_string()
            } else {
                format!("alt{}", *n - 1)
            }
        )
    }
}

fn quality_sort_key(name: &str) -> (u32, u8, bool) {
    let is_alt = name.ends_with("_alt");
    let base = name.trim_end_matches("_alt");
    let is_60 = base.ends_with("60");
    let num = base.trim_end_matches("p60").trim_end_matches("p");
    let res = num.parse::<u32>().unwrap_or(0);
    (u32::MAX - res, if is_60 { 1 } else { 0 }, !is_alt)
}

fn get_auth_token(app: &tauri::AppHandle) -> Option<String> {
    let webview = app.get_webview_window("main")?;
    let cookies = webview.cookies().ok()?;
    cookies
        .iter()
        .find(|c| {
            c.name() == "auth-token" && c.domain().map(|d| d.contains("twitch.tv")).unwrap_or(false)
        })
        .map(|c| c.value().to_string())
}

#[tauri::command]
fn open_login_window(app: tauri::AppHandle, window_label: String) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        state.login_active.store(true, Ordering::SeqCst);
    }

    let target = app
        .get_webview_window(&window_label)
        .ok_or_else(|| format!("Ventana '{}' no encontrada", window_label))?;

    let saved_url = target.url().map(|u| u.to_string()).unwrap_or_else(|_| "http://localhost:1420/".to_string());
    log_to_file(&format!("[LOGIN] window='{}' saved_url={}", window_label, saved_url));

    let twitch_url = "https://www.twitch.tv/login"
        .parse()
        .map_err(|e| format!("URL invalida: {}", e))?;

    target.navigate(twitch_url)
        .map_err(|e| format!("Error al navegar: {}", e))?;

    let escaped_url = saved_url.replace('\\', "\\\\").replace('\'', "\\'");
    let label_clone = window_label.clone();

    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));

        let check = format!(
            "if(location.href.indexOf('twitch.tv')!==-1&&location.href.indexOf('/login')===-1){{location.href='{}';}}",
            escaped_url
        );

        let mut saved = false;
        for _ in 0..120 {
            let st = app_clone.state::<AppState>();
            if !st.login_active.load(Ordering::SeqCst) {
                break;
            }
            if let Some(w) = app_clone.get_webview_window(&label_clone) {
                if !saved {
                    if let Ok(cookies) = w.cookies() {
                        let auth_token = cookies.iter().find(|c| {
                            c.name() == "auth-token"
                                && c.domain().map(|d: &str| d.contains("twitch.tv")).unwrap_or(false)
                        }).map(|c| c.value().to_string());

                        if let Some(token) = auth_token {
                            if !token.is_empty() {
                                save_oauth_token(&token);
                                log_to_file(&format!("[LOGIN] Token saved from cookies (window='{}')", label_clone));

                                if let Some(login_cookie) = cookies.iter().find(|c| {
                                    c.name() == "login"
                                        && c.domain().map(|d: &str| d.contains("twitch.tv")).unwrap_or(false)
                                }) {
                                    let username = login_cookie.value().to_string();
                                    if !username.is_empty() {
                                        save_twitch_username(&username);
                                        log_to_file(&format!("[LOGIN] Username saved: {}", username));
                                    }
                                }
                                saved = true;
                            }
                        }
                    }
                }
                let _ = w.eval(&check);
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });

    Ok(())
}

#[tauri::command]
fn save_session_from_cookies(app: tauri::AppHandle, window_label: String) -> Result<bool, String> {
    let webview = app
        .get_webview_window(&window_label)
        .ok_or_else(|| format!("Ventana '{}' no encontrada", window_label))?;

    let cookies = webview.cookies().map_err(|e| e.to_string())?;

    let auth_token = cookies
        .iter()
        .find(|c| {
            c.name() == "auth-token"
                && c.domain()
                    .map(|d: &str| d.contains("twitch.tv"))
                    .unwrap_or(false)
        })
        .map(|c| c.value().to_string());

    let token = match auth_token {
        Some(t) if !t.is_empty() => t,
        _ => return Ok(false),
    };

    save_oauth_token(&token);
    log_to_file(&format!("[SESSION] Token saved from cookies (window='{}')", window_label));

    if let Some(login_cookie) = cookies.iter().find(|c| {
        c.name() == "login"
            && c.domain()
                .map(|d: &str| d.contains("twitch.tv"))
                .unwrap_or(false)
    }) {
        let username = login_cookie.value().to_string();
        if !username.is_empty() {
            save_twitch_username(&username);
            log_to_file(&format!("[SESSION] Username saved from cookie: {}", username));
            return Ok(true);
        }
    }

    log_to_file("[SESSION] No login cookie found, trying Helix");
    Ok(false)
}

#[tauri::command]
async fn save_username_from_token(_app: tauri::AppHandle) -> Result<(), String> {
    let token = load_oauth_token().ok_or("No hay token guardado")?;

    let resp = reqwest::Client::new()
        .get("https://api.twitch.tv/helix/users")
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Helix error: {}", e))?;

    let json: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    if let Some(login) = json["data"][0]["login"].as_str() {
        save_twitch_username(login);
        log_to_file(&format!("[SESSION] Username saved from Helix: {}", login));
        Ok(())
    } else {
        Err("No se pudo obtener username de Helix".to_string())
    }
}

#[tauri::command]
async fn logout_twitch(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.login_active.store(false, Ordering::SeqCst);

    if let Some(token) = load_oauth_token() {
        let client = reqwest::Client::new();
        let resp = client
            .post("https://id.twitch.tv/oauth2/revoke")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!("client_id={}&token={}", TWITCH_CLIENT_ID, token))
            .send()
            .await;

        match resp {
            Ok(r) => {
                log_to_file(&format!("[LOGOUT] Token revocado - status: {}", r.status()));
            }
            Err(e) => {
                log_to_file(&format!("[LOGOUT] Error al revocar token: {}", e));
            }
        }
    }

    let _ = std::fs::remove_file(token_path());
    Ok(())
}

#[tauri::command]
fn is_dev_mode() -> bool {
    tauri::is_dev()
}

#[tauri::command]
fn log_frontend_msg(msg: String) {
    debug_chat(&format!("[FE] {}", msg));
}

#[tauri::command]
async fn has_twitch_session(app: tauri::AppHandle, window_label: Option<String>) -> Result<bool, String> {
    if load_oauth_token().is_some() {
        log_to_file("[GQL] has_twitch_session: true (file token)");
        return Ok(true);
    }

    let label = window_label.unwrap_or_else(|| "main".to_string());
    let handle = app.clone();
    let label_clone = label.clone();
    let cookies: Vec<_> = tokio::task::spawn_blocking(move || {
        let webview = handle
            .get_webview_window(&label_clone)
            .ok_or(format!("Ventana '{}' no encontrada", label_clone))?;
        webview.cookies().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let has_session = cookies.iter().any(|c| {
        c.name() == "auth-token"
            && c.domain()
                .map(|d: &str| d.contains("twitch.tv"))
                .unwrap_or(false)
    });

    log_to_file(&format!("[GQL] has_twitch_session: {} (window='{}')", has_session, label));
    Ok(has_session)
}

const TWITCH_CLIENT_ID: &str = "hw3wyjrf3nmg3ljsdxkmyawahb25ir";

#[tauri::command]
async fn save_oauth_token_cmd(app: tauri::AppHandle, token: String) -> Result<(), String> {
    save_oauth_token(&token);
    log_to_file("[OAUTH] Token saved via command from frontend");

    let helix_result = reqwest::Client::new()
        .get("https://api.twitch.tv/helix/users")
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    match helix_result {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(login) = json["data"][0]["login"].as_str() {
                    save_twitch_username(login);
                    log_to_file(&format!("[OAUTH] Username saved from Helix: {}", login));
                    return Ok(());
                }
            }
        }
        Err(e) => log_to_file(&format!("[OAUTH] Helix fetch failed: {}", e)),
    }

    let handle = app.clone();
    if let Ok(cookies) = tokio::task::spawn_blocking(move || {
        handle.get_webview_window("main")
            .ok_or("no main window".to_string())
            .and_then(|w| w.cookies().map_err(|e| e.to_string()))
    }).await.unwrap_or(Err("task failed".into())) {
        if let Some(login_cookie) = cookies.iter().find(|c| {
            c.name() == "login" && c.domain().map(|d: &str| d.contains("twitch.tv")).unwrap_or(false)
        }) {
            let username = login_cookie.value().to_string();
            if !username.is_empty() {
                save_twitch_username(&username);
                log_to_file(&format!("[OAUTH] Username saved from cookie: {}", username));
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn twitch_oauth_login(app: tauri::AppHandle, force_verify: Option<bool>) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Ventana principal no encontrada")?;

    let redirect_port = if tauri::is_dev() { 1420 } else { 9527 };
    let verify_param = if force_verify.unwrap_or(false) { "&force_verify=true" } else { "" };
    let auth_url = format!(
        "https://id.twitch.tv/oauth2/authorize?client_id={}&redirect_uri=http%3A%2F%2Flocalhost%3A{}&response_type=token&scope=user%3Aread%3Afollows+chat%3Aread+chat%3Aedit{}",
        TWITCH_CLIENT_ID, redirect_port, verify_param
    );

    log_to_file(&format!("[OAUTH] Navigating to OAuth URL (redirect port={}, force_verify={})", redirect_port, force_verify.unwrap_or(false)));
    main.navigate(auth_url.parse().map_err(|e| format!("URL invalida: {}", e))?)
        .map_err(|e| format!("Error al navegar: {}", e))?;

    Ok(())
}

#[tauri::command]
fn has_twitch_oauth() -> Result<bool, String> {
    Ok(load_oauth_token().is_some())
}

#[tauri::command]
async fn fetch_followed_streams(_app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    log_to_file("[HELIX] fetch_followed_streams called");

    let oauth_token = load_oauth_token()
        .ok_or("No hay token de Twitch. Inicia sesion primero.")?;

    log_to_file("[HELIX] Got saved OAuth token");
    let client = reqwest::Client::new();

    let users_resp = client
        .get("https://api.twitch.tv/helix/users")
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", oauth_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Error fetching user info: {}", e))?;

    let status = users_resp.status();
    if !status.is_success() {
        let body = users_resp.text().await.unwrap_or_default();
        log_to_file(&format!("[HELIX] Users endpoint failed: {} - {}", status, &body[..body.len().min(200)]));
        return Err(format!("Error getting user info: {}", status));
    }

    let users_json: serde_json::Value = users_resp.json().await
        .map_err(|e| format!("Error parsing user info: {}", e))?;

    let user_id = users_json["data"][0]["id"].as_str()
        .ok_or("No user ID in response")?
        .to_string();

    log_to_file("[HELIX] Got user_id OK");

    let streams_resp = client
        .get("https://api.twitch.tv/helix/streams/followed")
        .query(&[("user_id", user_id.as_str()), ("first", "100")])
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", oauth_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Error fetching followed streams: {}", e))?;

    let status = streams_resp.status();
    if !status.is_success() {
        let body = streams_resp.text().await.unwrap_or_default();
        log_to_file(&format!("[HELIX] Streams endpoint failed: {} - {}", status, &body[..body.len().min(200)]));
        return Err(format!("Error getting followed streams: {}", status));
    }

    let streams_json: serde_json::Value = streams_resp.json().await
        .map_err(|e| format!("Error parsing followed streams: {}", e))?;

    let streams = streams_json["data"].as_array()
        .ok_or("No streams data in response")?;

    log_to_file(&format!("[HELIX] Got {} followed streams", streams.len()));

    let user_ids: Vec<&str> = streams.iter()
        .filter_map(|s| s["user_id"].as_str())
        .collect();

    let mut profile_images: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if !user_ids.is_empty() {
        let query_pairs: Vec<(&str, &str)> = user_ids.iter()
            .map(|id| ("id", *id))
            .collect();
        log_to_file(&format!("[HELIX] Fetching profiles for {} users", user_ids.len()));
        if let Ok(resp) = client
            .get("https://api.twitch.tv/helix/users")
            .query(&query_pairs)
            .header("Client-ID", TWITCH_CLIENT_ID)
            .header("Authorization", format!("Bearer {}", oauth_token))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            let status = resp.status();
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(data) = json["data"].as_array() {
                    log_to_file(&format!("[HELIX] Got {} profiles back", data.len()));
                    for user in data {
                        if let (Some(id), Some(img)) = (user["id"].as_str(), user["profile_image_url"].as_str()) {
                            profile_images.insert(id.to_string(), img.to_string());
                        }
                    }
                } else {
                    log_to_file(&format!("[HELIX] Profiles response ({}): {}", status, &json.to_string()[..json.to_string().len().min(200)]));
                }
            }
        }
    }

    let edges: Vec<serde_json::Value> = streams.iter()
        .filter(|s| s["type"].as_str() == Some("live"))
        .map(|stream| {
            let uid = stream["user_id"].as_str().unwrap_or("");
            serde_json::json!({
                "node": {
                    "login": stream["user_login"],
                    "displayName": stream["user_name"],
                    "profileImageURL": profile_images.get(uid).cloned().unwrap_or_default(),
                    "stream": {
                        "title": stream["title"],
                        "game": { "name": stream["game_name"] },
                        "viewersCount": stream["viewer_count"]
                    }
                }
            })
        })
        .collect();

    log_to_file(&format!("[HELIX] Returning {} live channels", edges.len()));

    Ok(serde_json::json!({
        "data": {
            "currentUser": {
                "follows": {
                    "edges": edges
                }
            }
        }
    }))
}

fn incognito_config_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    std::path::PathBuf::from(home).join(".twitch-ultra-ligero-incognito")
}

fn read_incognito_config() -> bool {
    std::fs::read_to_string(incognito_config_path())
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

fn write_incognito_config(checked: bool) {
    let _ = std::fs::write(incognito_config_path(), checked.to_string());
}

#[tauri::command]
fn get_incognito_default() -> Result<bool, String> {
    Ok(read_incognito_config())
}

fn darkchat_config_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    std::path::PathBuf::from(home).join(".twitch-ultralight-darkchat")
}

fn read_darkchat_config() -> bool {
    std::fs::read_to_string(darkchat_config_path())
        .map(|s| s.trim() == "true")
        .unwrap_or(true)
}

fn write_darkchat_config(checked: bool) {
    let _ = std::fs::write(darkchat_config_path(), checked.to_string());
}

#[tauri::command]
fn get_darkchat_default() -> Result<bool, String> {
    log_to_file("[APP] get_darkchat_default called");
    Ok(read_darkchat_config())
}

fn chat_nativos_config_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    std::path::PathBuf::from(home).join(".twitch-ultralight-chat-nativos")
}

fn read_chat_nativos_config() -> bool {
    std::fs::read_to_string(chat_nativos_config_path())
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

fn write_chat_nativos_config(checked: bool) {
    let _ = std::fs::write(chat_nativos_config_path(), checked.to_string());
}

#[tauri::command]
fn get_chat_nativos_default() -> Result<bool, String> {
    Ok(read_chat_nativos_config())
}

#[tauri::command]
fn get_hide_timestamps_default() -> Result<bool, String> {
    Ok(read_hide_timestamps_config())
}

fn hide_timestamps_config_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    std::path::PathBuf::from(home).join(".twitch-ultralight-hide-timestamps")
}

fn read_hide_timestamps_config() -> bool {
    std::fs::read_to_string(hide_timestamps_config_path())
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

fn write_hide_timestamps_config(checked: bool) {
    let _ = std::fs::write(hide_timestamps_config_path(), checked.to_string());
}

#[derive(Debug, Clone, Serialize)]
struct ChatMessage {
    username: String,
    display_name: String,
    color: String,
    message: String,
    emotes: Vec<EmoteInfo>,
    badges: Vec<BadgeInfo>,
    timestamp: u64,
    bits: Option<u64>,
    subscriber: bool,
    is_action: bool,
    system_type: Option<String>,
    system_msg: Option<String>,
    system_login: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct EmoteInfo {
    id: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, Serialize)]
struct BadgeInfo {
    name: String,
    version: String,
}

#[derive(Debug, Clone, Serialize)]
struct RoomState {
    slow: Option<u32>,
    subs_only: bool,
    followers_only: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
struct UserState {
    display_name: String,
    color: String,
    badges: Vec<BadgeInfo>,
}

fn parse_irc_tags(tag_str: &str) -> HashMap<String, String> {
    let mut tags = HashMap::new();
    for part in tag_str.split(';') {
        if let Some((key, value)) = part.split_once('=') {
            tags.insert(key.to_string(), value.to_string());
        }
    }
    tags
}

fn parse_emotes(emote_str: &str) -> Vec<EmoteInfo> {
    let mut emotes = Vec::new();
    if emote_str.is_empty() {
        return emotes;
    }
    for emote_group in emote_str.split('/') {
        let parts: Vec<&str> = emote_group.split(':').collect();
        if parts.len() < 2 {
            continue;
        }
        let id = parts[0].to_string();
        for range in parts[1].split(',') {
            let range_parts: Vec<&str> = range.split('-').collect();
            if range_parts.len() == 2 {
                if let (Ok(start), Ok(end)) = (
                    range_parts[0].parse::<usize>(),
                    range_parts[1].parse::<usize>(),
                ) {
                    emotes.push(EmoteInfo { id: id.clone(), start, end });
                }
            }
        }
    }
    emotes
}

fn parse_irc_message(raw: &str) -> Option<ChatMessage> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    let (tags_str, rest) = if raw.starts_with('@') {
        let (tags, rest) = raw[1..].split_once(' ')?;
        (tags, rest)
    } else {
        ("", raw)
    };

    let tags = parse_irc_tags(tags_str);

    let msg_text = if let Some(pos) = rest.find(" :") {
        &rest[pos + 2..]
    } else {
        return None;
    };

    let display_name = tags.get("display-name").cloned().unwrap_or_default();
    let username = if let Some(bang) = rest.find('!') {
        if let Some(at) = rest[bang..].find('@') {
            &rest[bang + 1..bang + at]
        } else {
            ""
        }
    } else {
        ""
    };

    if username.is_empty() {
        return None;
    }

    let color = tags.get("color").cloned().unwrap_or_else(|| "#FFFFFF".to_string());
    let badges_str = tags.get("badges").cloned().unwrap_or_default();
    let badges: Vec<BadgeInfo> = if badges_str.is_empty() {
        Vec::new()
    } else {
        badges_str.split(',').filter(|b| !b.is_empty()).map(|b| {
            let parts: Vec<&str> = b.split('/').collect();
            BadgeInfo {
                name: parts.get(0).unwrap_or(&"").to_string(),
                version: parts.get(1).unwrap_or(&"1").to_string(),
            }
        }).collect()
    };
    let emote_str = tags.get("emotes").cloned().unwrap_or_default();
    let emotes = parse_emotes(&emote_str);
    let timestamp = tags.get("tmi-sent-ts")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let bits = tags.get("bits").and_then(|s| s.parse::<u64>().ok());
    let subscriber = tags.get("subscriber").map(|s| s == "1").unwrap_or(false);

    let is_action = msg_text.starts_with("\x01ACTION ");
    let clean_msg = if is_action {
        msg_text.strip_prefix("\x01ACTION ").unwrap_or(msg_text).trim_end_matches('\x01')
    } else {
        msg_text
    };

    Some(ChatMessage {
        username: username.to_string(),
        display_name: if display_name.is_empty() { username.to_string() } else { display_name },
        color,
        message: clean_msg.to_string(),
        emotes,
        badges,
        timestamp,
        bits,
        subscriber,
        is_action,
        system_type: None,
        system_msg: None,
        system_login: None,
    })
}

fn parse_usernotice(raw: &str) -> Option<ChatMessage> {
    let raw = raw.trim();
    if raw.is_empty() || !raw.contains(" USERNOTICE ") {
        return None;
    }

    let (tags_str, rest) = if raw.starts_with('@') {
        let (tags, rest) = raw[1..].split_once(' ')?;
        (tags, rest)
    } else {
        ("", raw)
    };

    let tags = parse_irc_tags(tags_str);

    let username = if let Some(bang) = rest.find('!') {
        if let Some(at) = rest[bang..].find('@') {
            &rest[bang + 1..bang + at]
        } else { "" }
    } else { "" };

    let display_name = tags.get("display-name").cloned()
        .unwrap_or_else(|| username.to_string());

    let msg_text = if let Some(pos) = rest.find(" :") {
        rest[pos + 2..].to_string()
    } else {
        String::new()
    };

    let msg_id = tags.get("msg-id").cloned().unwrap_or_default();
    let system_msg = tags.get("system-msg").cloned().unwrap_or_default();
    let color = tags.get("color").cloned().unwrap_or_else(|| "#FF0000".to_string());
    let timestamp = tags.get("tmi-sent-ts")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let badges_str = tags.get("badges").cloned().unwrap_or_default();
    let badges: Vec<BadgeInfo> = if badges_str.is_empty() {
        Vec::new()
    } else {
        badges_str.split(',').filter(|b| !b.is_empty()).map(|b| {
            let parts: Vec<&str> = b.split('/').collect();
            BadgeInfo {
                name: parts.get(0).unwrap_or(&"").to_string(),
                version: parts.get(1).unwrap_or(&"1").to_string(),
            }
        }).collect()
    };
    let subscriber = tags.get("subscriber").map(|s| s == "1").unwrap_or(false);

    let system_type = match msg_id.as_str() {
        "sub" => Some("sub".to_string()),
        "resub" => Some("resub".to_string()),
        "subgift" => Some("subgift".to_string()),
        "anonsubgift" => Some("anonsubgift".to_string()),
        "submysterygift" => Some("submysterygift".to_string()),
        "giftpaidupgrade" => Some("giftpaidupgrade".to_string()),
        "anongiftpaidupgrade" => Some("anongiftpaidupgrade".to_string()),
        "primepaidupgrade" => Some("primepaidupgrade".to_string()),
        "raid" => Some("raid".to_string()),
        "unraid" => Some("unraid".to_string()),
        "ritual" => Some("ritual".to_string()),
        "bitsbadgetier" => Some("bitsbadgetier".to_string()),
        _ => Some(msg_id.clone()),
    };

    let system_login = tags.get("msg-param-login").cloned()
        .or_else(|| tags.get("msg-param-recipient-login").cloned());

    Some(ChatMessage {
        username: username.to_string(),
        display_name,
        color,
        message: msg_text,
        emotes: Vec::new(),
        badges,
        timestamp,
        bits: None,
        subscriber,
        is_action: false,
        system_type,
        system_msg: Some(system_msg),
        system_login,
    })
}

fn parse_roomstate(raw: &str) -> Option<RoomState> {
    let raw = raw.trim();
    if !raw.contains(" ROOMSTATE ") {
        return None;
    }

    let tags_str = if raw.starts_with('@') {
        raw[1..].split_once(' ')?.0
    } else {
        return None;
    };

    let tags = parse_irc_tags(tags_str);

    Some(RoomState {
        slow: tags.get("slow").and_then(|s| s.parse::<u32>().ok()),
        subs_only: tags.get("subs-only").map(|s| s == "1").unwrap_or(false),
        followers_only: tags.get("followers-only").and_then(|s| s.parse::<i32>().ok()),
    })
}

fn parse_userstate(raw: &str) -> Option<UserState> {
    let raw = raw.trim();
    if !raw.starts_with('@') {
        return None;
    }
    if !raw.contains(" USERSTATE ") && !raw.contains(" GLOBALUSERSTATE ") {
        return None;
    }

    let (tags_str, _rest) = raw[1..].split_once(' ')?;
    let tags = parse_irc_tags(tags_str);

    let display_name = tags.get("display-name").cloned().unwrap_or_default();
    let color = tags.get("color").cloned().unwrap_or_default();
    let badges_str = tags.get("badges").cloned().unwrap_or_default();
    let badges: Vec<BadgeInfo> = if badges_str.is_empty() {
        Vec::new()
    } else {
        badges_str.split(',').filter(|b| !b.is_empty()).map(|b| {
            let parts: Vec<&str> = b.split('/').collect();
            BadgeInfo {
                name: parts.get(0).unwrap_or(&"").to_string(),
                version: parts.get(1).unwrap_or(&"1").to_string(),
            }
        }).collect()
    };

    Some(UserState { display_name, color, badges })
}

fn parse_membership_event(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    let raw_stripped = if raw.starts_with('@') {
        match raw.find(" :") {
            Some(i) => &raw[i + 2..],
            None => raw,
        }
    } else {
        raw
    };

    if let Some(join_idx) = raw_stripped.find(" JOIN ") {
        let prefix = &raw_stripped[..join_idx];
        if let Some(excl) = prefix.rfind('!') {
            let username = &prefix[1..excl];
            return Some(("join".to_string(), username.to_string()));
        }
    }
    if let Some(part_idx) = raw_stripped.find(" PART ") {
        let prefix = &raw_stripped[..part_idx];
        if let Some(excl) = prefix.rfind('!') {
            let username = &prefix[1..excl];
            return Some(("part".to_string(), username.to_string()));
        }
    }
    None
}

fn parse_names_reply(raw: &str) -> Option<(String, String, Vec<String>)> {
    let raw = raw.trim();

    // 353 (RPL_NAMREPLY): :tmi.twitch.tv 353 nick = #canal :user1 user2 user3
    if let Some(idx) = raw.find(" 353 ") {
        let rest = &raw[idx + 5..];
        if let Some(colon_pos) = rest.find(" :") {
            let before_colon = &rest[..colon_pos];
            if let Some(eq_pos) = before_colon.find('#') {
                let channel = &before_colon[eq_pos..];
                let channel = channel.trim_end_matches(|c: char| c.is_whitespace());
                let users_str = &rest[colon_pos + 2..];
                let users: Vec<String> = users_str
                    .split_whitespace()
                    .map(|u| {
                        // Limpiar caracteres de formato IRC y dejar solo [a-zA-Z0-9_]
                        u.to_lowercase()
                            .chars()
                            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                            .collect::<String>()
                    })
                    .filter(|u| !u.is_empty())
                    .collect();
                return Some(("names".to_string(), channel.to_string(), users));
            }
        }
    }

    // 366 (RPL_ENDOFNAMES): :tmi.twitch.tv 366 nick #canal :End of /NAMES list
    if let Some(idx) = raw.find(" 366 ") {
        let rest = &raw[idx + 5..];
        let parts: Vec<&str> = rest.split_whitespace().collect();
        if parts.len() >= 2 {
            let channel = parts[1];
            return Some(("names_end".to_string(), channel.to_string(), vec![]));
        }
    }

    None
}

#[tauri::command]
async fn connect_readonly_chat(
    app: tauri::AppHandle,
    channel: String,
    window_label: String,
    auth_type: Option<String>,
) -> Result<(), String> {
    let at = auth_type.clone().unwrap_or_default();
    debug_chat(&format!("connect_readonly_chat channel='{}' label='{}' auth_type='{}'", channel, window_label, at));
    use futures_util::{SinkExt, StreamExt};

    let chat_state = app.state::<Arc<ChatState>>();

    // Desconectar si ya hay conexión para esta ventana
    {
        let conns = chat_state.connections.write().await;
        if let Some(existing) = conns.get(&window_label) {
            log_to_file(&format!("[CHAT] Already connected for window {}, disconnecting first", window_label));
            existing.connected.store(false, Ordering::SeqCst);
            existing.stop_requested.store(true, Ordering::SeqCst);
            if let Some(mut sender) = existing.sender.lock().await.take() {
                let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text("QUIT :bye".into())).await;
                let _ = sender.close().await;
            }
        }
    }

    let connection = {
        let conn = Arc::new(ChatConnection {
            sender: Mutex::new(None),
            connected: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
            connection_id: AtomicU64::new(0),
            sent_messages: Mutex::new(VecDeque::new()),
            user_state: Mutex::new(None),
        });
        let mut conns = chat_state.connections.write().await;
        conns.insert(window_label.clone(), conn.clone());
        conn
    };

    let my_id = connection.connection_id.fetch_add(1, Ordering::SeqCst) + 1;

    let app_clone = app.clone();
    let channel_for_task = channel.clone();
    let label_for_task = window_label.clone();
    let auth_type_for_task = auth_type.unwrap_or_else(|| "anonymous".to_string());

    tokio::spawn(async move {
        let emit_chat = |event: &str, payload: serde_json::Value| {
            let wrapped = serde_json::json!({
                "channel": channel_for_task,
                "payload": payload
            });
            match app_clone.get_webview_window(&label_for_task) {
                Some(win) => {
                    log_to_file(&format!("[EMIT] event='{}' label='{}' channel='{}'", event, label_for_task, channel_for_task));
                    let _ = win.emit(event, wrapped);
                }
                None => {
                    log_to_file(&format!("[EMIT-ERROR] Window '{}' NOT FOUND for event='{}' channel='{}'", event, label_for_task, channel_for_task));
                }
            }
        };

        let mut backoff_secs = 1u64;
        let mut was_connected = false;
        loop {
            let current_id = connection.connection_id.load(Ordering::SeqCst);
            if current_id != my_id {
                log_to_file(&format!("[CHAT] Stale task detected (my_id={}, current={}), exiting", my_id, current_id));
                break;
            }
            if connection.stop_requested.load(Ordering::SeqCst) {
                break;
            }

            log_to_file(&format!("[CHAT] Connecting to #{} for window {}", channel_for_task, label_for_task));
            let _ = emit_chat("chat-reconnect", serde_json::json!("connecting"));

            let ws_result = tokio_tungstenite::connect_async("wss://irc-ws.chat.twitch.tv:443").await;
            let (ws_stream, _) = match ws_result {
                Ok(v) => v,
                Err(e) => {
                    log_to_file(&format!("[CHAT] Connect error: {}, retrying in {}s", e, backoff_secs));
                    let _ = emit_chat("chat-reconnect", serde_json::json!("reconnecting"));
                    tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                    backoff_secs = (backoff_secs * 2).min(30);
                    continue;
                }
            };

            let (mut write, mut read) = ws_stream.split();

            log_to_file("[CHAT-IRC] → CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands");
            if write.send(tokio_tungstenite::tungstenite::Message::Text(
                "CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands".into(),
            )).await.is_err() { continue; }

            log_to_file("[CHAT-IRC] Esperando CAP ACK...");
            let mut got_ack = false;
            while let Some(msg) = read.next().await {
                if let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg {
                    let text_str = text.to_string();
                    let preview = if text_str.len() > 200 { &text_str[..200] } else { &text_str };
                    log_to_file(&format!("[CHAT-IRC] ← {}", preview));
                    if text_str.contains("CAP * ACK") {
                        log_to_file("[CHAT-IRC] CAP ACK recibido, membership activo");
                        got_ack = true;
                        break;
                    }
                    if text_str.starts_with("PING") {
                        if let Some(sender) = connection.sender.lock().await.as_mut() {
                            let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(
                                "PONG :tmi.twitch.tv".into(),
                            )).await;
                        }
                    }
                }
            }

            if !got_ack {
                log_to_file("[CHAT-IRC] No se recibió CAP ACK, abortando conexión");
                continue;
            }

            let (pass_cmd, nick_cmd) = if auth_type_for_task == "session" {
                match load_oauth_token() {
                    Some(token) => {
                        let username = load_twitch_username().unwrap_or_else(|| "justinfan12345".to_string());
                        debug_chat(&format!("PASS session token_len={} nick={}", token.len(), username));
                        (format!("PASS oauth:{}", token), format!("NICK {}", username))
                    }
                    None => {
                        debug_chat("PASS session: NO TOKEN FOUND, fallback anonymous");
                        ("PASS oauth:justinfan12345".to_string(), "NICK justinfan12345".to_string())
                    }
                }
            } else {
                debug_chat("PASS anonymous");
                ("PASS oauth:justinfan12345".to_string(), "NICK justinfan12345".to_string())
            };
            if write.send(tokio_tungstenite::tungstenite::Message::Text(pass_cmd.into())).await.is_err() { continue; }
            if write.send(tokio_tungstenite::tungstenite::Message::Text(nick_cmd.into())).await.is_err() { continue; }
            log_to_file(&format!("[CHAT-IRC] → JOIN #{}", channel_for_task));
            let join_sent_at = std::time::Instant::now();
            if write.send(tokio_tungstenite::tungstenite::Message::Text(
                format!("JOIN #{}", channel_for_task).into(),
            )).await.is_err() { continue; }

            *connection.sender.lock().await = Some(write);
            connection.connected.store(true, Ordering::SeqCst);
            backoff_secs = 1;
            was_connected = true;

            debug_chat(&format!("IRC connected to #{} auth='{}'", channel_for_task, auth_type_for_task));
            emit_chat("chat-reconnect", serde_json::json!("connected"));

            let connected_since = std::time::Instant::now();
            let mut pending_names: Vec<String> = Vec::new();
            let mut names_complete = false;
            let mut tags_requested = false;

            while let Some(msg_result) = read.next().await {
                let current_id = connection.connection_id.load(Ordering::SeqCst);
                if current_id != my_id {
                    log_to_file(&format!("[CHAT] Stale task detected in read loop (my_id={}, current={}), exiting", my_id, current_id));
                    break;
                }
                if !connection.connected.load(Ordering::SeqCst) {
                    break;
                }
                match msg_result {
                    Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                        let raw_frame = text.to_string();
                        for text_str in raw_frame.split("\r\n").filter(|l| !l.is_empty()) {

                        let preview = if text_str.len() > 200 { &text_str[..200] } else { text_str };
                        log_to_file(&format!("[CHAT-IRC] ← {}", preview));

                        if text_str.contains("CAP * ACK") {
                            log_to_file(&format!("[CHAT-IRC] ← CAP ACK: {}", text_str));
                        }

                        if let Some(us) = parse_userstate(text_str) {
                            let badge_names: Vec<String> = us.badges.iter().map(|b| b.name.clone()).collect();
                            log_to_file(&format!("[USERSTATE] display='{}' color='{}' badges={:?}", us.display_name, us.color, badge_names));
                            *connection.user_state.lock().await = Some(us);
                            continue;
                        }

                        if text_str.contains("Login unsuccessful") || text_str.contains("Login authentication failed") {
                            log_to_file(&format!("[CHAT-AUTH] Token inválido detectado: {}", &text_str[..text_str.len().min(200)]));
                            let _ = std::fs::remove_file(token_path());
                            log_to_file("[CHAT-AUTH] Token file eliminado");
                            emit_chat("chat-auth-failed", serde_json::json!({ "reason": "Token inválido" }));
                            connection.stop_requested.store(true, Ordering::SeqCst);
                            break;
                        } else if text_str.contains("NOTICE") {
                            debug_chat(&format!("IRC NOTICE: {}", &text_str[..text_str.len().min(200)]));
                        }

                        if text_str.starts_with("PING") {
                            log_to_file("[CHAT-IRC] ← PING, enviando PONG");
                            if let Some(sender) = connection.sender.lock().await.as_mut() {
                                let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(
                                    "PONG :tmi.twitch.tv".into(),
                                )).await;
                            }
                            continue;
                        }

                        if let Some((event_type, username)) = parse_membership_event(text_str) {
                            if username.to_lowercase() == "justinfan12345" { continue; }
                            log_to_file(&format!("[CHAT-IRC] ← {} {}", event_type.to_uppercase(), username));
                            if event_type == "join" {
                                emit_chat("chat-user-join", serde_json::json!({ "username": username }));
                            } else {
                                emit_chat("chat-user-leave", serde_json::json!({ "username": username }));
                            }
                            continue;
                        }

                        if let Some((names_type, _channel, users)) = parse_names_reply(text_str) {
                            if names_type == "names" {
                                let elapsed_ms = join_sent_at.elapsed().as_millis();
                                log_to_file(&format!("[CHAT-USERS] ← 353 recibido ({}ms después de JOIN): {} usuarios", elapsed_ms, users.len()));
                                let filtered: Vec<String> = users.into_iter()
                                    .filter(|u| u.to_lowercase() != "justinfan12345")
                                    .collect();
                                pending_names.extend(filtered);
                                if !pending_names.is_empty() {
                                    log_to_file(&format!("[CHAT-USERS] Emitiendo bulk add: {} usuarios", pending_names.len()));
                                    let usernames: Vec<String> = pending_names.drain(..).collect();
                                    emit_chat("chat-user-bulk-add", serde_json::json!({
                                        "usernames": usernames
                                    }));
                                }
                            } else if names_type == "names_end" {
                                names_complete = true;
                                let elapsed_ms = join_sent_at.elapsed().as_millis();
                                log_to_file(&format!("[CHAT-USERS] ← 366 (NAMES end) recibido ({}ms después de JOIN)", elapsed_ms));
                            }
                            continue;
                        }

                        if let Some(room_state) = parse_roomstate(text_str) {
                            if let Ok(val) = serde_json::to_value(&room_state) {
                                emit_chat("chat-room-state", val);
                            }
                            continue;
                        }

                        if let Some(msg) = parse_usernotice(text_str) {
                            if let Ok(val) = serde_json::to_value(&msg) {
                                emit_chat("chat-message", val);
                            }
                            continue;
                        }

                        if let Some(msg) = parse_irc_message(text_str) {
                            let badge_names: Vec<&str> = msg.badges.iter().map(|b| b.name.as_str()).collect();
                            log_to_file(&format!(
                                "[PRIVMSG] user='{}' display='{}' text='{}' color='{}' badges={:?} emotes={}",
                                msg.username, msg.display_name, msg.message, msg.color, badge_names, msg.emotes.len()
                            ));
                            let incoming_lower = msg.message.trim().to_lowercase();
                            if !incoming_lower.is_empty() {
                                let echo_match = connection.sent_messages.lock().await.iter().any(|(_, t)| t == &incoming_lower);
                                if echo_match {
                                    log_to_file(&format!(
                                        "[ECHO-MATCH] mensaje propio recibido: user='{}' display='{}' text='{}' color='{}' badges={:?}",
                                        msg.username, msg.display_name, msg.message, msg.color, badge_names
                                    ));
                                }
                            }
                            let role = if msg.badges.iter().any(|b| b.name == "broadcaster") {
                                "broadcaster"
                            } else if msg.badges.iter().any(|b| b.name == "moderator") {
                                "moderator"
                            } else if msg.badges.iter().any(|b| b.name == "vip") {
                                "vip"
                            } else {
                                "viewer"
                            };
                            emit_chat("chat-user-role", serde_json::json!({
                                "username": msg.username,
                                "role": role
                            }));
                            if let Ok(val) = serde_json::to_value(&msg) {
                                emit_chat("chat-message", val);
                            }
                        }

                        } // fin for lines

                        if names_complete && !tags_requested {
                            if let Some(sender) = connection.sender.lock().await.as_mut() {
                                log_to_file("[CHAT] Solicitando twitch.tv/tags después del NAMES reply");
                                let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(
                                    "CAP REQ :twitch.tv/tags".into(),
                                )).await;
                            }
                            tags_requested = true;
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        debug_chat(&format!("IRC read error: {}", e));
                        break;
                    }
                }

                if connected_since.elapsed().as_secs() > 30 {
                    backoff_secs = 1;
                }
            }

            *connection.sender.lock().await = None;
            connection.connected.store(false, Ordering::SeqCst);

            debug_chat(&format!("IRC disconnected, stop_requested={}", connection.stop_requested.load(Ordering::SeqCst)));

            let current_id = connection.connection_id.load(Ordering::SeqCst);
            if !was_connected || current_id != my_id || connection.stop_requested.load(Ordering::SeqCst) {
                break;
            }

            log_to_file(&format!("[CHAT] Disconnected from #{}, reconnecting in {}s", channel_for_task, backoff_secs));
            emit_chat("chat-reconnect", serde_json::json!("reconnecting"));
            tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
            backoff_secs = (backoff_secs * 2).min(30);
        }

        log_to_file(&format!("[CHAT] IRC listener loop ended for window {}", label_for_task));
    });

    Ok(())
}

async fn disconnect_chat_for_window(app: &tauri::AppHandle, window_label: &str) {
    use futures_util::SinkExt;

    let chat_state = app.state::<Arc<ChatState>>();
    let mut conns = chat_state.connections.write().await;

    if let Some(connection) = conns.remove(window_label) {
        connection.connected.store(false, Ordering::SeqCst);
        connection.stop_requested.store(true, Ordering::SeqCst);

        if let Some(mut sender) = connection.sender.lock().await.take() {
            let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(
                "QUIT :bye".into(),
            )).await;
            let _ = sender.close().await;
        }

        log_to_file(&format!("[CHAT] Disconnected window {}", window_label));
    }
}

#[tauri::command]
async fn disconnect_readonly_chat(app: tauri::AppHandle, window_label: String) -> Result<(), String> {
    disconnect_chat_for_window(&app, &window_label).await;
    Ok(())
}

#[tauri::command]
fn get_twitch_username() -> Option<String> {
    load_twitch_username()
}

#[tauri::command]
async fn send_chat_message(
    app: tauri::AppHandle,
    channel: String,
    message: String,
    window_label: String,
) -> Result<Option<UserState>, String> {
    use futures_util::SinkExt;

    debug_chat(&format!("send_chat_message channel='{}' label='{}' msg='{}'", channel, window_label, message));

    let chat_state = app.state::<Arc<ChatState>>();
    let connection = {
        let conns = chat_state.connections.read().await;
        match conns.get(&window_label) {
            Some(c) => c.clone(),
            None => {
                debug_chat("send_chat_message: NO CONNECTION for this label");
                return Err("No hay conexion de chat para esta ventana".to_string());
            }
        }
    };

    let connected = connection.connected.load(Ordering::SeqCst);
    debug_chat(&format!("send_chat_message: connected={}", connected));
    if !connected {
        return Err("La conexion de chat no esta activa".to_string());
    }

    let irc_msg = format!("PRIVMSG #{} :{}", channel, message);
    let mut sender_guard = connection.sender.lock().await;
    let sender = match sender_guard.as_mut() {
        Some(s) => s,
        None => {
            debug_chat("send_chat_message: sender is None");
            return Err("No hay sender disponible".to_string());
        }
    };

    match sender.send(tokio_tungstenite::tungstenite::Message::Text(irc_msg.into())).await {
        Ok(()) => {
            debug_chat(&format!("send_chat_message: PRIVMSG sent OK"));
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let mut sent = connection.sent_messages.lock().await;
            sent.push_back((now_ms, message.trim().to_lowercase()));
            while sent.len() > 20 {
                sent.pop_front();
            }
            drop(sent);
            let us = connection.user_state.lock().await.clone();
            debug_chat(&format!("send_chat_message: user_state available={}", us.is_some()));
            Ok(us)
        }
        Err(e) => {
            debug_chat(&format!("send_chat_message: send ERROR '{}'", e));
            Err(format!("Error al enviar mensaje: {}", e))
        }
    }
}

#[tauri::command]
async fn lookup_channel_id(app: tauri::AppHandle, channel: String) -> Result<String, String> {
    log_to_file(&format!("[HELIX] lookup_channel_id(\"{}\") called", channel));
    let oauth_token = get_helix_token(&app).await?;

    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.twitch.tv/helix/users")
        .query(&[("login", channel.as_str())])
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", oauth_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Error looking up channel: {}", e))?;

    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("Error parsing response: {}", e))?;

    let id = body["data"][0]["id"].as_str().map(|s| s.to_string());
    match &id {
        Some(id) => log_to_file(&format!("[HELIX] lookup_channel_id OK → {}", id)),
        None => log_to_file(&format!("[HELIX] lookup_channel_id FAILED → channel '{}' not found, body: {}", channel, &body.to_string()[..body.to_string().len().min(200)])),
    }
    id.ok_or_else(|| format!("Channel '{}' not found", channel))
}

#[tauri::command]
async fn lookup_stream_info(app: tauri::AppHandle, channel: String) -> Result<serde_json::Value, String> {
    log_to_file(&format!("[HELIX] lookup_stream_info(\"{}\") called", channel));
    let oauth_token = get_helix_token(&app).await?;

    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.twitch.tv/helix/streams")
        .query(&[("user_login", channel.as_str())])
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", oauth_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Error looking up stream: {}", e))?;

    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("Error parsing response: {}", e))?;

    let stream = body["data"][0].as_object();
    match stream {
        Some(s) => {
            let display_name = s.get("user_name").and_then(|v| v.as_str()).unwrap_or(&channel);
            let title = s.get("title").and_then(|v| v.as_str()).unwrap_or("");
            log_to_file(&format!("[HELIX] lookup_stream_info OK → displayName='{}' title='{}'", display_name, title));
            Ok(serde_json::json!({ "displayName": display_name, "title": title }))
        }
        None => {
            log_to_file(&format!("[HELIX] lookup_stream_info: no stream found for '{}'", channel));
            Ok(serde_json::json!({ "displayName": channel, "title": "" }))
        }
    }
}

#[tauri::command]
async fn fetch_chat_emotes(app: tauri::AppHandle, channel_id: String) -> Result<serde_json::Value, String> {
    log_to_file(&format!("[HELIX] fetch_chat_emotes(\"{}\") called", channel_id));
    let oauth_token = get_helix_token(&app).await?;

    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.twitch.tv/helix/chat/emotes")
        .query(&[("broadcaster_id", channel_id.as_str())])
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", oauth_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Error fetching emotes: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        log_to_file(&format!("[HELIX] fetch_chat_emotes FAILED: {} - {}", status, &body[..body.len().min(200)]));
        return Err(format!("Error: {}", status));
    }

    let result: Result<serde_json::Value, _> = resp.json().await;
    match &result {
        Ok(val) => {
            let count = val["data"].as_array().map_or(0, |a| a.len());
            log_to_file(&format!("[HELIX] fetch_chat_emotes OK → {} emote sets", count));
        }
        Err(e) => log_to_file(&format!("[HELIX] fetch_chat_emotes parse error: {}", e)),
    }
    result.map_err(|e| format!("Error parsing emotes: {}", e))
}

#[tauri::command]
async fn fetch_chat_badges(app: tauri::AppHandle, channel_id: String) -> Result<serde_json::Value, String> {
    log_to_file(&format!("[HELIX] fetch_chat_badges(\"{}\") called", channel_id));
    let oauth_token = get_helix_token(&app).await?;
    let client = reqwest::Client::new();

    // 1) Fetch global badges (moderator, turbo, vip, broadcaster, bits, subscriber, etc.)
    let global_resp = client
        .get("https://api.twitch.tv/helix/chat/badges/global")
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", oauth_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Error fetching global badges: {}", e))?;

    let mut merged: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();

    if global_resp.status().is_success() {
        if let Ok(global_json) = global_resp.json::<serde_json::Value>().await {
            if let Some(data) = global_json["data"].as_array() {
                for set in data {
                    if let Some(set_id) = set["set_id"].as_str() {
                        merged.insert(set_id.to_string(), set.clone());
                    }
                }
            }
            log_to_file(&format!("[HELIX] fetch_chat_badges global OK → {} badge sets", merged.len()));
        }
    } else {
        let gs = global_resp.status();
        let body = global_resp.text().await.unwrap_or_default();
        log_to_file(&format!("[HELIX] fetch_chat_badges global FAILED: {} - {}", gs, &body[..body.len().min(200)]));
    }

    // 2) Fetch channel-specific badges (subscriber tiers etc.) — these override global
    let channel_resp = client
        .get("https://api.twitch.tv/helix/chat/badges")
        .query(&[("broadcaster_id", channel_id.as_str())])
        .header("Client-ID", TWITCH_CLIENT_ID)
        .header("Authorization", format!("Bearer {}", oauth_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Error fetching channel badges: {}", e))?;

    if channel_resp.status().is_success() {
        if let Ok(channel_json) = channel_resp.json::<serde_json::Value>().await {
            if let Some(data) = channel_json["data"].as_array() {
                for set in data {
                    if let Some(set_id) = set["set_id"].as_str() {
                        merged.insert(set_id.to_string(), set.clone());
                    }
                }
            }
        }
    } else {
        let cs = channel_resp.status();
        let body = channel_resp.text().await.unwrap_or_default();
        log_to_file(&format!("[HELIX] fetch_chat_badges channel FAILED: {} - {}", cs, &body[..body.len().min(200)]));
    }

    // 3) Build merged response
    let sets_count = merged.len();
    let mut total_versions = 0;
    let data_array: Vec<serde_json::Value> = merged.into_values().collect();
    for set in &data_array {
        if let Some(versions) = set["versions"].as_array() {
            total_versions += versions.len();
        }
    }

    log_to_file(&format!("[HELIX] fetch_chat_badges MERGED → {} badge sets, {} total versions", sets_count, total_versions));

    Ok(serde_json::json!({ "data": data_array }))
}

#[tauri::command]
async fn fetch_bttv_emotes(channel_id: Option<String>) -> Result<serde_json::Value, String> {
    let cid = channel_id.unwrap_or_default();
    log_to_file(&format!("[BTTV] fetch_bttv_emotes(\"{}\") called", cid));
    let client = reqwest::Client::new();
    let timeout = std::time::Duration::from_secs(10);

    let mut channel_emotes: Vec<serde_json::Value> = Vec::new();
    let mut shared_emotes: Vec<serde_json::Value> = Vec::new();

    if !cid.is_empty() && cid != "0" {
        let channel_url = format!("https://api.betterttv.net/3/cached/users/twitch/{}", cid);
        match client.get(&channel_url).timeout(timeout).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(ce) = json["channelEmotes"].as_array() {
                        channel_emotes = ce.clone();
                    }
                    if let Some(se) = json["sharedEmotes"].as_array() {
                        shared_emotes = se.clone();
                    }
                    log_to_file(&format!("[BTTV] channel OK → {} channel + {} shared", channel_emotes.len(), shared_emotes.len()));
                }
            }
            Ok(resp) => {
                log_to_file(&format!("[BTTV] channel FAILED: {}", resp.status()));
            }
            Err(e) => {
                log_to_file(&format!("[BTTV] channel error: {}", e));
            }
        }
    }

    let mut global_emotes: Vec<serde_json::Value> = Vec::new();
    match client.get("https://api.betterttv.net/3/cached/emotes/global").timeout(timeout).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = json.as_array() {
                    global_emotes = arr.clone();
                }
                log_to_file(&format!("[BTTV] global OK → {} emotes", global_emotes.len()));
            }
        }
        Ok(resp) => {
            log_to_file(&format!("[BTTV] global FAILED: {}", resp.status()));
        }
        Err(e) => {
            log_to_file(&format!("[BTTV] global error: {}", e));
        }
    }

    Ok(serde_json::json!({
        "channelEmotes": channel_emotes,
        "sharedEmotes": shared_emotes,
        "globalEmotes": global_emotes
    }))
}

#[tauri::command]
async fn fetch_chat_history(channel: String, limit: Option<u32>) -> Vec<ChatMessage> {
    log_to_file(&format!("[RM] fetch_chat_history(\"{}\") called", channel));
    let limit = limit.unwrap_or(50).clamp(1, 800);
    let url = format!(
        "https://recent-messages.robotty.de/api/v2/recent-messages/{}?limit={}",
        channel, limit
    );

    #[derive(serde::Deserialize)]
    struct RecentMessagesResponse {
        messages: Vec<String>,
        error_code: Option<String>,
    }

    let client = reqwest::Client::new();
    let resp = match client
        .get(&url)
        .header("User-Agent", "GUITwitchTauri/1.0")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log_to_file(&format!("[RM] fetch_chat_history error: {}", e));
            return Vec::new();
        }
    };

    let status = resp.status();
    if !status.is_success() {
        log_to_file(&format!("[RM] fetch_chat_history FAILED: {}", status));
        return Vec::new();
    }

    let body: RecentMessagesResponse = match resp.json().await {
        Ok(b) => b,
        Err(e) => {
            log_to_file(&format!("[RM] fetch_chat_history parse error: {}", e));
            return Vec::new();
        }
    };

    if let Some(err) = &body.error_code {
        log_to_file(&format!("[RM] fetch_chat_history error_code={}", err));
    }

    let mut messages: Vec<ChatMessage> = Vec::new();
    for line in &body.messages {
        if !line.contains("PRIVMSG") {
            continue;
        }
        if let Some(msg) = parse_irc_message(line) {
            if msg.timestamp > 0 {
                messages.push(msg);
            }
        }
    }

    messages.sort_by_key(|m| m.timestamp);
    log_to_file(&format!("[RM] fetch_chat_history OK → {} messages", messages.len()));
    messages
}

#[tauri::command]
fn set_menu_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Ventana principal no encontrada")?;

    if visible {
        main.show_menu().map_err(|e| e.to_string())?;
    } else {
        main.hide_menu().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn rebuild_menu(app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let ir_inicio =
        MenuItem::with_id(app_handle, "go-to-home", "Ir al inicio", true, None::<&str>)?;
    let explorar =
        MenuItem::with_id(app_handle, "explorar", "Explorar", true, None::<&str>)?;
    let incognito_check =
        CheckMenuItemBuilder::with_id("incognito-mode", "Iniciar en modo incognito")
            .checked(read_incognito_config())
            .build(app_handle)?;
    let darkchat_check = CheckMenuItemBuilder::with_id("darkchat-mode", "Modo oscuro")
        .checked(read_darkchat_config())
        .build(app_handle)?;
    let chat_nativos_check =
        CheckMenuItemBuilder::with_id("chat-nativos", "Chat nativos")
            .checked(read_chat_nativos_config())
            .build(app_handle)?;
    let hide_timestamps_check =
        CheckMenuItemBuilder::with_id("hide-timestamps", "Ocultar timestamps")
            .checked(read_hide_timestamps_config())
            .build(app_handle)?;
    let cerrar_sesion = MenuItemBuilder::with_id("cerrar-sesion", "Cerrar sesion")
        .build(app_handle)?;
    let opciones_menu = SubmenuBuilder::new(app_handle, "Opciones")
        .item(&ir_inicio)
        .item(&explorar)
        .item(&incognito_check)
        .item(&darkchat_check)
        .item(&chat_nativos_check)
        .item(&hide_timestamps_check)
        .item(&cerrar_sesion)
        .build()?;
    let show_pip = CheckMenuItemBuilder::with_id("show-pip", "PIP")
        .checked(true)
        .build(app_handle)?;
    let show_quality = CheckMenuItemBuilder::with_id("show-quality", "Calidad")
        .checked(true)
        .build(app_handle)?;
    let show_speed = CheckMenuItemBuilder::with_id("show-speed", "Velocidad")
        .checked(true)
        .build(app_handle)?;
    let show_latency = CheckMenuItemBuilder::with_id("show-latency", "Delay")
        .checked(true)
        .build(app_handle)?;
    let ver_menu = SubmenuBuilder::new(app_handle, "Ver")
        .item(&show_pip)
        .item(&show_quality)
        .item(&show_speed)
        .item(&show_latency)
        .build()?;
    let menu = MenuBuilder::new(app_handle)
        .item(&opciones_menu)
        .item(&ver_menu)
        .build()?;
    if let Some(main) = app_handle.get_webview_window("main") {
        main.set_menu(menu)?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(9527).build())
        .manage(AppState {
            login_active: AtomicBool::new(false),
        })
        .manage(Arc::new(ChatState {
            connections: tokio::sync::RwLock::new(std::collections::HashMap::new()),
        }))
        .invoke_handler(tauri::generate_handler![
            list_streams,
            open_login_window,
            logout_twitch,
            has_twitch_session,
            has_twitch_oauth,
            save_oauth_token_cmd,
            fetch_followed_streams,
            twitch_oauth_login,
            get_incognito_default,
            get_darkchat_default,
            get_chat_nativos_default,
            get_hide_timestamps_default,
            set_menu_visible,
            is_dev_mode,
            log_frontend_msg,
            connect_readonly_chat,
            disconnect_readonly_chat,
            send_chat_message,
            lookup_channel_id,
            lookup_stream_info,
            fetch_chat_emotes,
            fetch_chat_badges,
            fetch_bttv_emotes,
            fetch_chat_history,
            save_session_from_cookies,
            save_username_from_token,
            get_twitch_username
        ])
        .setup(|app| {
            log_to_file("[APP] Tauri setup started");

            let url = if tauri::is_dev() {
                WebviewUrl::App("index.html".into())
            } else {
                WebviewUrl::External("http://localhost:9527".parse().unwrap())
            };
            WebviewWindowBuilder::new(app, "main".to_string(), url)
                .title("Twitch Ultralight")
                .inner_size(1280.0, 720.0)
                .min_inner_size(800.0, 450.0)
                .resizable(true)
                .maximized(true)
                .build()?;

            rebuild_menu(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Destroyed => {
                    let label = window.label();
                    if label.starts_with("player") {
                        log_to_file(&format!("[WINDOW] Player '{}' destroyed, pending menu refresh", label));
                        MENU_REFRESH_PENDING.store(true, Ordering::SeqCst);
                        let app_handle = window.app_handle().clone();
                        let label_owned = label.to_string();
                        tauri::async_runtime::spawn(async move {
                            disconnect_chat_for_window(&app_handle, &label_owned).await;
                        });
                    }
                }
                tauri::WindowEvent::Focused(true) => {
                    if window.label() == "main" && MENU_REFRESH_PENDING.swap(false, Ordering::SeqCst) {
                        log_to_file("[WINDOW] Main focused with pending refresh, rebuilding menu");
                        let _ = rebuild_menu(window.app_handle());
                    }
                }
                _ => {}
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "go-to-home" => {
                if let Some(main) = app.get_webview_window("main") {
                    let url = if tauri::is_dev() {
                        "http://localhost:1420"
                    } else {
                        "http://localhost:9527"
                    };
                    let _ = main.navigate(url.parse().unwrap());
                }
            }
            "explorar" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.navigate("https://www.twitch.tv/directory".parse().unwrap());
                }
            }
            "incognito-mode" => {
                let current = read_incognito_config();
                write_incognito_config(!current);
            }
            "darkchat-mode" => {
                let current = read_darkchat_config();
                let new = !current;
                write_darkchat_config(new);
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("darkchat-mode", new);
                }
            }
            "chat-nativos" => {
                let current = read_chat_nativos_config();
                let new = !current;
                write_chat_nativos_config(new);
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("chat-nativos", new);
                }
            }
            "hide-timestamps" => {
                let current = read_hide_timestamps_config();
                let new = !current;
                write_hide_timestamps_config(new);
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("hide-timestamps", new);
                }
            }
            "show-pip" | "show-quality" | "show-speed" | "show-latency" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit(event.id().as_ref(), ());
                }
            }
            "cerrar-sesion" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("cerrar-sesion", ());
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
