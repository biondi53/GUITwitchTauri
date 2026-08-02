import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const CHANNEL = process.env.E2E_CHANNEL || "argentumunitedtv";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
let cachedCdnUrl = null;

async function resolveUrl(channel) {
  const gql = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "Client-ID": CLIENT_ID,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
      body: JSON.stringify({
      query:
        "query PlaybackAccessToken_Template($login: String!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"site\", playerType: $playerType}) { value signature __typename } }",
      variables: { login: channel, playerType: "embed" },
    }),
  });
  const j = await gql.json();
  const t = j?.data?.streamPlaybackAccessToken;
  if (!t) return null;
  const p = Date.now() % 999999;
  const master = await fetch(
    `https://usher.ttvnw.net/api/v2/channel/hls/${channel}.m3u8?platform=web&p=${p}&allow_source=true&allow_audio_only=true&playlist_include_framerate=true&supported_codecs=h264,h265,av1&fast_bread=true&sig=${t.signature}&token=${encodeURIComponent(t.value)}`,
    { headers: { "User-Agent": UA, Referer: "https://player.twitch.tv", Origin: "https://player.twitch.tv" } }
  );
  if (!master.ok) return null;
  const entries = parseMaster(await master.text(), master.url);
  return (
    entries.find((e) => e.name === "720p")?.url ??
    entries.find((e) => e.name === "720p60")?.url ??
    entries[entries.length - 1]?.url ??
    null
  );
}

function parseMaster(text, base) {
  const out = [];
  let pending = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = line.match(/VIDEO="([^"]+)"/)?.[1]
        ?? line.match(/STABLE-VARIANT-ID="([^"]+)"/)?.[1]
        ?? line.match(/IVS-NAME="([^"]+)"/)?.[1]
        ?? (line.includes('AUDIO="audio_only"') ? "audio_only" : null);
      if (pending === "chunked") pending = sourceLabel(line) || pending;
    } else if (!line.startsWith("#")) {
      if (pending) out.push({ name: normName(pending), url: new URL(line, base).href });
      pending = null;
    }
  }
  return out;
}

function sourceLabel(line) {
  const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
  if (!res) return null;
  const fr = line.match(/FRAME-RATE=([\d.]+)/);
  const is60 = fr && parseFloat(fr[1]) >= 50;
  return `${res[2]}${is60 ? "p60" : "p"}`;
}

function normName(v) {
  if (v === "chunked") return "source";
  return v.endsWith("p30") ? v.slice(0, -2) : v;
}

async function getCdnUrl() {
  if (cachedCdnUrl) return cachedCdnUrl;
  cachedCdnUrl = await resolveUrl(CHANNEL);
  return cachedCdnUrl;
}

async function proxyPlaylist() {
  const cdn = await getCdnUrl();
  if (!cdn) return null;
  const text = await (await fetch(cdn)).text();
  return text
    .replace(/#EXT-X-TWITCH-PREFETCH:[^\n]*\n/g, "")
    .replace(/https:\/\/[^\s"]+\.ts\?dna=[^\s"]+/g, (m) => "/__proxy/seg?u=" + encodeURIComponent(m));
}

const server = createServer(async (req, res) => {
  try {
    const [pathname, query] = (req.url || "/").split("?");
    if (pathname === "/__proxy/playlist") {
      const text = await proxyPlaylist();
      if (text == null) {
        res.statusCode = 502;
        res.end("no stream");
        return;
      }
      res.setHeader("content-type", MIME[".json"] || "application/vnd.apple.mpegurl");
      res.end(text);
      return;
    }
    if (pathname === "/__proxy/seg") {
      const u = new URL(req.url, "http://localhost").searchParams.get("u");
      if (!u) {
        res.statusCode = 400;
        res.end("bad seg");
        return;
      }
      const seg = await fetch(u);
      if (!seg.ok) {
        res.statusCode = seg.status;
        res.end("seg fetch failed");
        return;
      }
      const buf = Buffer.from(await seg.arrayBuffer());
      res.setHeader("content-type", "video/mp2t");
      res.setHeader("content-length", buf.length);
      res.end(buf);
      return;
    }
    if (pathname === "/__stream") {
      const url = await getCdnUrl();
      res.setHeader("content-type", MIME[".json"]);
      res.end(JSON.stringify({ url }));
      return;
    }
    let localPath = decodeURIComponent(pathname || "/");
    if (localPath === "/") localPath = "/tests/e2e/player.html";
    let filePath = normalize(join(ROOT, localPath));
    if (!filePath.startsWith(ROOT)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      data = await readFile(normalize(join(ROOT, "public", localPath)));
    }
    res.setHeader("content-type", MIME[extname(filePath)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found: " + req.url);
  }
});

const port = Number(process.env.E2E_PORT || 8642);
server.listen(port, () => console.log(`e2e server on http://127.0.0.1:${port}`));
