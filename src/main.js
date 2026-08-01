import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { runResyncTick, computeInitialCorrection, updateResyncGate, LIVE_EDGE_S, RESYNC_THRESHOLD_OFFSET_S } from "./live-sync.js";
import { shouldRefreshGrid, buildThumbnailUrl } from "./grid-refresh.js";

const isPlayerWindow = window.location.hash.startsWith("#player/");
const chatChannel = isPlayerWindow ? window.location.hash.slice("#player/".length) : null;
let myTwitchUsername = null;
let pendingLocalEchoes = 0;
const pendingLocalMessages = [];
const ECHO_TIMEOUT_MS = 5000;

const connectBtn = document.getElementById("connect-btn");
const channelInput = document.getElementById("channel-input");
const backToGridBtn = document.getElementById("back-to-grid-btn");
const connectScreen = document.getElementById("connect-screen");
const streamLayout = document.getElementById("stream-layout");
const videoPlayer = document.getElementById("player");
let chatIframe = document.getElementById("chat");
const errorMsg = document.getElementById("error-msg");
const qualitySelect = document.getElementById("quality-select");
const authBtn = document.getElementById("auth-btn");
const latencyDisplay = document.getElementById("latency-display");
const livesyncInput = document.getElementById("livesync-input");
const targetLatencyDisplay = document.getElementById("target-latency-display");
const stallCountDisplay = document.getElementById("stall-count-display");
const resetInfoDisplay = document.getElementById("reset-info-display");
const speedSelect = document.getElementById("speed-select");
const pipBtn = document.getElementById("pip-btn");
const chatToggleBtn = document.getElementById("chat-toggle-btn");
const autoSpeedDisplay = document.getElementById("auto-speed-display");
const goLiveBtn = document.getElementById("go-live-btn");
const qualityLabel = document.querySelector('label[for="quality-select"]');
const speedLabel = document.querySelector(".speed-label");
const gridScreen = document.getElementById("grid-screen");
const gridHeader = document.querySelector(".grid-header");
const gridContainer = document.getElementById("grid-container");
const gridTitle = document.getElementById("grid-title");
const gridRefreshBtn = document.getElementById("grid-refresh-btn");
const gridManualBtn = document.getElementById("grid-manual-btn");
const readonlyChat = document.getElementById("readonly-chat");
const readonlyChatMessages = document.getElementById("readonly-chat-messages");
const chatRoomState = document.getElementById("chat-room-state");
const newMessagesBtn = document.getElementById("new-messages-btn");

const USE_CUSTOM_CHAT = true;
const MAX_CHAT_MESSAGES = 500;
let chatUserScrolled = false;
let pendingMessages = 0;
let lastMessageUser = "";
let emoteSize = 2;
let channelEmotes = new Map();
let channelBadges = new Map();
let bttvEmotes = new Map();
let bttvGlobalsLoaded = false;
let currentChannelId = "";
let chatUsers = new Set();
let chatUserRoles = new Map();
let userListVisible = false;

const GLOBAL_BADGES = {
  "broadcaster/1": "https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1",
  "moderator/1": "https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1",
  "vip/1": "https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1",
  "turbo/1": "https://static-cdn.jtvnw.net/badges/v1/d7342363-a016-4aab-9585-4e6e6f1b80c7/1",
  "premium/1": "https://static-cdn.jtvnw.net/badges/v1/bbbe0db0-a598-423e-86d0-f9fb98ca1933/1",
  "partner/1": "https://static-cdn.jtvnw.net/badges/v1/d12a2e27-16f6-41d0-ab77-b780518f00a3/1",
  "staff/1": "https://static-cdn.jtvnw.net/badges/v1/d97c37bd-a6f5-4c38-8f57-4e4bef88af34/1",
  "founder/1": "https://static-cdn.jtvnw.net/badges/v1/511b78a9-ab37-472f-9569-457753bbe7d3/1",
  "no_audio/1": "https://static-cdn.jtvnw.net/badges/v1/aef2cd08-f29b-45a1-8c12-d44d7fd5e6f0/1",
  "no_video/1": "https://static-cdn.jtvnw.net/badges/v1/199a0dba-58f3-494e-a7fc-1fa0a1001fb8/1",
  "subscriber/0": "https://static-cdn.jtvnw.net/badges/v1/5d9f2208-5dd8-11e7-8513-2ff4adfae661/1",
  "bits-charity/1": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/1",
  "bits-charity/2": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/2",
  "bits-charity/3": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/3",
  "bits-charity/4": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/4",
  "bits-charity/5": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/5",
  "bits-charity/6": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/6",
  "bits-charity/7": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/7",
  "bits-charity/8": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/8",
  "bits-charity/9": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/9",
  "bits-charity/10": "https://static-cdn.jtvnw.net/badges/v1/87498e9a-c32e-488f-9ff8-b7eeabcfda14/10",
  "sub-gift-leader/1": "https://static-cdn.jtvnw.net/badges/v1/0e789e74-1a8e-4b4e-a4d7-12d3b098112e/1",
  "sub-gift-leader/2": "https://static-cdn.jtvnw.net/badges/v1/0e789e74-1a8e-4b4e-a4d7-12d3b098112e/2",
  "sub-gift-leader/3": "https://static-cdn.jtvnw.net/badges/v1/0e789e74-1a8e-4b4e-a4d7-12d3b098112e/3",
  "sub-gift-leader/4": "https://static-cdn.jtvnw.net/badges/v1/0e789e74-1a8e-4b4e-a4d7-12d3b098112e/4",
  "sub-gift-leader/5": "https://static-cdn.jtvnw.net/badges/v1/0e789e74-1a8e-4b4e-a4d7-12d3b098112e/5",
  "sub-gifter/1": "https://static-cdn.jtvnw.net/badges/v1/2f342852-c7a0-4cab-8728-4d1b81e1b643/1",
  "sub-gifter/2": "https://static-cdn.jtvnw.net/badges/v1/2f342852-c7a0-4cab-8728-4d1b81e1b643/2",
  "sub-gifter/3": "https://static-cdn.jtvnw.net/badges/v1/2f342852-c7a0-4cab-8728-4d1b81e1b643/3",
  "sub-gifter/4": "https://static-cdn.jtvnw.net/badges/v1/2f342852-c7a0-4cab-8728-4d1b81e1b643/4",
  "sub-gifter/5": "https://static-cdn.jtvnw.net/badges/v1/2f342852-c7a0-4cab-8728-4d1b81e1b643/5",
  "artist-badge/1": "https://static-cdn.jtvnw.net/badges/v1/4300a897-03dc-4e83-8c0e-c332fee7057f/1",
  "bot-badge/1": "https://static-cdn.jtvnw.net/badges/v1/bf3f5a34-c2dd-45f0-bc58-31fbbae78f87/1",
  "glhf-pledge/1": "https://static-cdn.jtvnw.net/badges/v1/5baea951-d4fb-4114-988f-b27d22fc0537/1",
};

let hls = null;
let streamsCache = [];
let savedTime = 0;
let currentChannel = "";
let latencyInterval = null;
let isIncognito = sessionStorage.getItem("twitch_incognito") === "true";
let isDarkChat = sessionStorage.getItem("twitch_darkchat") === "true";
let isChatNativos = sessionStorage.getItem("twitch_chat_nativos") === "true";
let isCustomSession = false;
let readonlyChatConnected = false;
let isHideTimestamps = sessionStorage.getItem("twitch_hide_timestamps") === "true";
let renderedMessageKeys = new Set();
let lastPrependUser = "";
let chatLayoutMode = 0;
let currentLiveSyncDuration = 2;
let stallResetTimeout = null;
let stallResetCount = 0;
let lastResyncAt = 0;
let initialCorrectionDone = true;
let manualSeekPending = false;
let lastPlayheadPosition = null;
const INITIAL_CORRECT_DELAY_MS = 2500;
let nextResetTime = 0;
let lastGridRefreshAt = 0;
let gridFocusWatcherStarted = false;
let needsForceVerify = false;

let _isDevMode = null;
async function isDevMode() {
  if (_isDevMode === null) {
    _isDevMode = await invoke("is_dev_mode");
  }
  return _isDevMode;
}

function getChatParent() {
  return window.location.hostname;
}

function shouldUseReadonlyChat() {
  return USE_CUSTOM_CHAT && !isChatNativos;
}

async function connectReadonlyChat(channel, { clearMessages = true, authType = "anonymous" } = {}) {
  if (!shouldUseReadonlyChat()) {
    return;
  }
  try {
    const windowLabel = getCurrentWebviewWindow().label;
    invoke("log_frontend_msg", { msg: `connectReadonlyChat channel='${channel}' authType='${authType}'` });
    if (clearMessages) {
      readonlyChatMessages.innerHTML = "";
      renderedMessageKeys.clear();
    }
    readonlyChatMessages.classList.toggle("hide-timestamps", isHideTimestamps);
    lastMessageUser = "";
    pendingMessages = 0;
    newMessagesBtn.classList.add("hidden");
    chatRoomState.classList.add("hidden");
    readonlyChat.classList.remove("hidden");
    destroyChatIframe();

    const userListBtn = document.getElementById("user-list-btn");
    if (userListBtn) userListBtn.classList.remove("hidden");
    const userListPanel = document.getElementById("user-list-panel");
    if (userListPanel) userListPanel.classList.add("hidden");
    userListVisible = false;

    if (currentChannelId || channel) {
      fetchChannelEmotesAndBadges(channel);
    }

    await invoke("connect_readonly_chat", { channel, windowLabel, authType });
    readonlyChatConnected = true;
    updateChatInputVisibility();
    loadChatHistory(channel);
  } catch (err) {
    console.error("[CHAT] connect error:", err);
  }
}

async function disconnectReadonlyChat() {
  try {
    await invoke("disconnect_readonly_chat", { windowLabel: getCurrentWebviewWindow().label });
    readonlyChatConnected = false;
    readonlyChatMessages.innerHTML = "";
    renderedMessageKeys.clear();
    lastPrependUser = "";
    readonlyChat.classList.add("hidden");
    chatRoomState.classList.add("hidden");
    channelEmotes.clear();
    channelBadges.clear();
    bttvEmotes.clear();
    bttvGlobalsLoaded = false;
    clearChatUsers();
    currentChannelId = "";
    lastMessageUser = "";
    pendingMessages = 0;
    const userListBtn = document.getElementById("user-list-btn");
    if (userListBtn) userListBtn.classList.add("hidden");
    const userListPanel = document.getElementById("user-list-panel");
    if (userListPanel) userListPanel.classList.add("hidden");
    userListVisible = false;
    updateChatInputVisibility();
  } catch (err) {
    console.error("[CHAT] disconnect error:", err);
  }
}

async function loadChatHistory(channel) {
  if (!shouldUseReadonlyChat()) return;
  if (chatChannel && channel !== chatChannel) return;
  let history = [];
  try {
    history = await invoke("fetch_chat_history", { channel, limit: 50 });
  } catch (err) {
    console.error("[CHAT] history error:", err);
    return;
  }
  if (chatChannel && channel !== chatChannel) return;
  if (!readonlyChatConnected) return;
  lastPrependUser = "";
  for (let i = history.length - 1; i >= 0; i--) {
    renderChatMessage(history[i], { prepend: true });
  }
  lastMessageUser = "";
}

function hideReadonlyChat() {
  readonlyChat.classList.add("hidden");
  const userListBtn = document.getElementById("user-list-btn");
  if (userListBtn) userListBtn.classList.add("hidden");
  const userListPanel = document.getElementById("user-list-panel");
  if (userListPanel) userListPanel.classList.add("hidden");
  userListVisible = false;
  updateChatInputVisibility();
}

function showReadonlyChat() {
  readonlyChat.classList.remove("hidden");
  const userListBtn = document.getElementById("user-list-btn");
  if (userListBtn) userListBtn.classList.remove("hidden");
  updateChatInputVisibility();
}

async function fetchChannelEmotesAndBadges(channel) {
  try {
    const channelId = currentChannelId || await invoke("lookup_channel_id", { channel });
    if (!channelId) { return; }
    currentChannelId = channelId;

    const [emotesResp, badgesResp] = await Promise.all([
      invoke("fetch_chat_emotes", { channelId }),
      invoke("fetch_chat_badges", { channelId })
    ]);

    channelEmotes.clear();
    channelBadges.clear();

    if (emotesResp && emotesResp.data) {
      emotesResp.data.forEach((set) => {
        if (set.emotes && Array.isArray(set.emotes)) {
          set.emotes.forEach((emote) => {
            if (emote.id && emote.images) {
              const url = emote.images.url_1x || "";
              const url2 = emote.images.url_2x || url;
              const url4 = emote.images.url_4x || url2;
              channelEmotes.set(emote.name, {
                id: emote.id,
                type: emote.emote_type,
                set: emote.emote_set_id,
                url1: url,
                url2: url2,
                url4: url4
              });
            }
          });
        }
      });
    }

    if (badgesResp && badgesResp.data) {
      badgesResp.data.forEach((badge) => {
        if (badge.set_id && badge.versions) {
          badge.versions.forEach((ver) => {
            channelBadges.set(`${badge.set_id}/${ver.id}`, {
              id: ver.id,
              name: badge.set_id,
              url1: ver.image_url_1x || "",
              url2: ver.image_url_2x || ver.image_url_1x || "",
              url4: ver.image_url_4x || ver.image_url_2x || ver.image_url_1x || ""
            });
          });
        }
      });
    }

    refreshRenderedBadges();
    await fetchBttvEmotes(channelId);

  } catch (err) {
    console.error("[BADGES-FETCH] Failed:", err);
  }
}

async function fetchBttvEmotes(channelId) {
  try {
    const resp = await invoke("fetch_bttv_emotes", { channelId });
    if (!resp) return;

    const channelAll = [
      ...(resp.channelEmotes || []),
      ...(resp.sharedEmotes || [])
    ];

    channelAll.forEach((emote) => {
      if (emote.id && emote.code) {
        bttvEmotes.set(emote.code, {
          id: emote.id,
          animated: emote.animated || false,
          imageType: emote.imageType || "png"
        });
      }
    });

    if (!bttvGlobalsLoaded && resp.globalEmotes) {
      resp.globalEmotes.forEach((emote) => {
        if (emote.id && emote.code) {
          bttvEmotes.set(emote.code, {
            id: emote.id,
            animated: emote.animated || false,
            imageType: emote.imageType || "png"
          });
        }
      });
      bttvGlobalsLoaded = true;
    }

    console.log(`[BTTV] Loaded ${bttvEmotes.size} emotes`);
  } catch (err) {
    console.error("[BTTV-FETCH] Failed:", err);
  }
}

function getBttvEmoteUrl(name) {
  const emote = bttvEmotes.get(name);
  if (!emote) return null;
  const ext = emote.imageType === "gif" ? "gif" : "png";
  return `https://cdn.betterttv.net/emote/${emote.id}/2x.${ext}`;
}

function getBadgeUrl(badgeName, badgeVersion) {
  const exact = channelBadges.get(`${badgeName}/${badgeVersion}`);
  if (exact) { return exact.url2; }
  const def = channelBadges.get(`${badgeName}/1`);
  if (def) { return def.url2; }
  for (const [key, val] of channelBadges) {
    if (key.startsWith(badgeName + "/")) { return val.url2; }
  }
  const globalExact = GLOBAL_BADGES[`${badgeName}/${badgeVersion}`];
  if (globalExact) return globalExact;
  const globalDef = GLOBAL_BADGES[`${badgeName}/1`];
  if (globalDef) return globalDef;
  return null;
}

function refreshRenderedBadges() {
  for (const div of readonlyChatMessages.children) {
    if (!div.__msg) continue;
    const newDiv = buildMessageDiv(div.__msg, div.classList.contains("grouped"));
    div.replaceWith(newDiv);
  }
}

function getEmoteUrl(emoteId, name) {
  const channelEmote = channelEmotes.get(name);
  if (channelEmote) return channelEmote.url4 || channelEmote.url2 || channelEmote.url1;
  return `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/2.0`;
}

function buildMessageDiv(msg, isGrouped) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.__msg = msg;

  if (msg.bits && parseInt(msg.bits) > 0) {
    div.classList.add("bits-msg");
  }

  if (isGrouped) {
    div.classList.add("grouped");
  }

  const timeSpan = document.createElement("span");
  timeSpan.className = "chat-msg-time timestamp";
  if (msg.timestamp) {
    const ts = new Date(msg.timestamp);
    timeSpan.textContent = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  div.appendChild(timeSpan);

  if (msg.badges && msg.badges.length > 0) {
    msg.badges.forEach((badge) => {
      const badgeUrl = getBadgeUrl(badge.name, badge.version);
      if (badgeUrl) {
        const img = document.createElement("img");
        img.className = "badge-img";
        img.src = badgeUrl;
        img.alt = badge.name;
        img.title = badge.name;
        img.loading = "lazy";
        div.appendChild(img);
      } else {
        const el = document.createElement("span");
        el.className = `badge badge-${badge.name}`;
        el.title = badge.name;
        const labels = {
          moderator: "MOD", broadcaster: "B", subscriber: "SUB",
          vip: "VIP", turbo: "T", partner: "P", premium: "PR",
          "no_audio": "NO A", "no_video": "NO V",
          "bits-charity": "♥", "founder": "F",
          "staff": "S", "artist-badge": "ART"
        };
        el.textContent = labels[badge.name] || badge.name.replace(/-/g, " ").slice(0, 6);
        div.appendChild(el);
      }
    });
  }

  if (msg.badge_info && msg.badge_info.length > 0) {
    msg.badge_info.forEach((info) => {
      if (info.name === "subscriber") {
        const span = document.createElement("span");
        span.className = "badge badge-sub";
        span.textContent = info.version;
        div.appendChild(span);
      }
    });
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "username";
  nameSpan.style.color = msg.color || "#FFFFFF";
  nameSpan.textContent = msg.display_name || msg.username;
  div.appendChild(nameSpan);

  if (msg.is_action) {
    const actionSpan = document.createElement("span");
    actionSpan.className = "message";
    actionSpan.style.color = msg.color || "#FFFFFF";
    actionSpan.textContent = "\u00A0";
    renderMessageText(actionSpan, msg.message, msg.emotes, msg.bits);
    div.appendChild(actionSpan);
  } else {
    const msgSpan = document.createElement("span");
    msgSpan.className = "message";
    renderMessageText(msgSpan, msg.message, msg.emotes, msg.bits);
    div.appendChild(msgSpan);
  }

  if (msg.bits && parseInt(msg.bits) > 0) {
    const bitsSpan = document.createElement("span");
    bitsSpan.className = "bits";
    bitsSpan.textContent = ` \u2728${msg.bits} `;
    div.appendChild(bitsSpan);
  }

  return div;
}

function renderChatMessage(msg, opts = {}) {
  if (!readonlyChatConnected) return null;
  if (msg.username) addChatUser(msg.username);

  if (msg.system_type) {
    const div = document.createElement("div");
    div.className = "chat-msg";
    renderSystemMessage(div, msg);
    readonlyChatMessages.appendChild(div);
    trimMessages();
    return null;
  }

  if (opts.replaceNode && opts.replaceNode.isConnected) {
    const isGrouped = opts.replaceNode.classList.contains("grouped");
    const newDiv = buildMessageDiv(msg, isGrouped);
    opts.replaceNode.replaceWith(newDiv);
    return newDiv;
  }

  const msgKey = `${msg.timestamp}|${msg.username}|${msg.message}`;

  if (opts.prepend) {
    if (renderedMessageKeys.has(msgKey)) return null;
    renderedMessageKeys.add(msgKey);
    const isGrouped = lastPrependUser === msg.username && lastPrependUser !== "";
    lastPrependUser = msg.username || "";
    const div = buildMessageDiv(msg, isGrouped);
    readonlyChatMessages.insertBefore(div, readonlyChatMessages.firstChild);
    trimMessages();
    return div;
  }

  if (renderedMessageKeys.has(msgKey)) return null;
  renderedMessageKeys.add(msgKey);

  const isGrouped = lastMessageUser === msg.username && lastMessageUser !== "";
  lastMessageUser = msg.username || "";

  const div = buildMessageDiv(msg, isGrouped);
  readonlyChatMessages.appendChild(div);
  trimMessages();

  if (!chatUserScrolled) {
    readonlyChatMessages.scrollTop = readonlyChatMessages.scrollHeight;
  } else {
    pendingMessages++;
    newMessagesBtn.textContent = `${pendingMessages} nuevo${pendingMessages !== 1 ? "s" : ""} mensaje${pendingMessages !== 1 ? "s" : ""}`;
    newMessagesBtn.classList.remove("hidden");
  }

  return div;
}

function renderSystemMessage(div, msg) {
  div.classList.add("system-msg");
  const typeLabels = {
    sub: "Suscripcion",
    resub: "Resuscripcion",
    subgift: "Regalo de suscripcion",
    submysterygift: "Regalo misterioso",
    giftpaidupgrade: "Upgrade de regalo",
    raid: "Raid",
    ritual: "Ritual",
    bitsbadgetier: "Badge de bits"
  };

  const typeSpan = document.createElement("span");
  typeSpan.className = "msg-type";
  typeSpan.textContent = typeLabels[msg.system_type] || msg.system_type;
  div.appendChild(typeSpan);

  if (msg.system_login) {
    const nameSpan = document.createElement("span");
    nameSpan.className = "username";
    nameSpan.textContent = msg.system_login;
    div.appendChild(nameSpan);
  }

  if (msg.system_msg) {
    const msgSpan = document.createElement("span");
    msgSpan.className = "message";
    msgSpan.textContent = msg.system_msg;
    div.appendChild(msgSpan);
  }
}

function trimMessages() {
  while (readonlyChatMessages.children.length > MAX_CHAT_MESSAGES) {
    readonlyChatMessages.removeChild(readonlyChatMessages.firstChild);
  }
}

function addChatUser(username) {
  if (!username) return;
  chatUsers.add(username.toLowerCase());
  updateUserCount();
  if (userListVisible) renderChatUserList();
}

function addBulkChatUsers(usernames) {
  if (!usernames || !Array.isArray(usernames)) return;
  usernames.forEach((u) => chatUsers.add(u.toLowerCase()));
  updateUserCount();
  if (userListVisible) renderChatUserList();
}

function setUserRole(username, role) {
  if (!username) return;
  chatUserRoles.set(username.toLowerCase(), role);
  if (userListVisible) renderChatUserList();
}

function removeChatUser(username) {
  if (!username) return;
  chatUsers.delete(username.toLowerCase());
  updateUserCount();
  if (userListVisible) renderChatUserList();
}

function clearChatUsers() {
  chatUsers.clear();
  chatUserRoles.clear();
  updateUserCount();
  if (userListVisible) renderChatUserList();
}

function updateUserCount() {
  const countEl = document.getElementById("user-count");
  if (countEl) countEl.textContent = chatUsers.size;
  const listCountEl = document.getElementById("user-list-count");
  if (listCountEl) listCountEl.textContent = chatUsers.size;
}

function renderChatUserList() {
  const listEl = document.getElementById("user-list-items");
  if (!listEl) return;
  listEl.innerHTML = "";

  const roleOrder = ["broadcaster", "moderator", "vip"];
  const roleLabels = {
    broadcaster: "Creador del canal",
    moderator: "Moderadores",
    vip: "VIP",
  };

  const groups = { broadcaster: [], moderator: [], vip: [], viewer: [] };
  chatUsers.forEach((user) => {
    const role = chatUserRoles.get(user) || "viewer";
    if (groups[role]) {
      groups[role].push(user);
    } else {
      groups.viewer.push(user);
    }
  });

  for (const role of roleOrder) {
    if (groups[role].length === 0) continue;
    groups[role].sort((a, b) => a.localeCompare(b));

    const header = document.createElement("div");
    header.className = "user-list-section-header";
    header.textContent = `${roleLabels[role]} (${groups[role].length})`;
    listEl.appendChild(header);

    groups[role].forEach((user) => {
      const item = document.createElement("div");
      item.className = "user-list-item";
      item.textContent = user;
      listEl.appendChild(item);
    });
  }

  if (groups.viewer.length > 0) {
    groups.viewer.sort((a, b) => a.localeCompare(b));

    const header = document.createElement("div");
    header.className = "user-list-section-header";
    header.textContent = `Espectadores (${groups.viewer.length})`;
    listEl.appendChild(header);

    groups.viewer.forEach((user) => {
      const item = document.createElement("div");
      item.className = "user-list-item";
      item.textContent = user;
      listEl.appendChild(item);
    });
  }
}

function toggleUserList() {
  const panel = document.getElementById("user-list-panel");
  const btn = document.getElementById("user-list-btn");
  if (!panel || !btn) return;
  userListVisible = !userListVisible;
  if (userListVisible) {
    panel.classList.remove("hidden");
    btn.classList.add("active");
    renderChatUserList();
    document.getElementById("user-list-count").textContent = chatUsers.size;
  } else {
    panel.classList.add("hidden");
    btn.classList.remove("active");
  }
}

function renderMessageText(container, text, emotes, bits) {
  if (!text) return;

  let segments = [{ type: "text", start: 0, end: text.length }];

  if (emotes && emotes.length > 0) {
    const emoteSegments = emotes.map((e) => ({
      type: "emote",
      id: e.id,
      name: text.slice(e.start, e.end + 1),
      start: e.start,
      end: e.end + 1
    }));

    const all = [...emoteSegments].sort((a, b) => a.start - b.start);
    segments = [];
    let cursor = 0;
    all.forEach((seg) => {
      if (seg.start > cursor) {
        segments.push({ type: "text", start: cursor, end: seg.start });
      }
      segments.push(seg);
      cursor = seg.end;
    });
    if (cursor < text.length) {
      segments.push({ type: "text", start: cursor, end: text.length });
    }
  }

  segments.forEach((seg) => {
    if (seg.type === "emote") {
      const img = document.createElement("img");
      img.className = "emote";
      img.src = getEmoteUrl(seg.id, seg.name);
      img.alt = seg.name;
      img.title = seg.name;
      img.loading = "lazy";

      if (img.src.includes("/1.0") || img.src.includes("/default/dark/1")) {
        img.classList.add("emote-large");
      }

      container.appendChild(img);
    } else {
      const segmentText = text.slice(seg.start, seg.end);
      renderTextWithBttv(container, segmentText, bits);
    }
  });
}

function renderTextWithBttv(container, text, bits) {
  const words = text.split(/(\s+)/);
  let hasBttv = false;
  const parts = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (/^\s+$/.test(word)) {
      parts.push({ type: "text", value: word });
      continue;
    }
    const bttvUrl = getBttvEmoteUrl(word);
    if (bttvUrl) {
      hasBttv = true;
      parts.push({ type: "bttv", value: word, url: bttvUrl });
    } else {
      parts.push({ type: "text", value: word });
    }
  }

  if (!hasBttv) {
    highlightText(container, text, bits);
    return;
  }

  parts.forEach((part) => {
    if (part.type === "bttv") {
      const img = document.createElement("img");
      img.className = "emote bttv-emote";
      img.src = part.url;
      img.alt = part.value;
      img.title = part.value;
      img.loading = "lazy";
      container.appendChild(img);
    } else {
      highlightText(container, part.value, bits);
    }
  });
}

function highlightText(container, text, bits) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const mentionRegex = /@(\w+)/g;
  const bitsRegex = /(\d+)\s*(bits?)/gi;

  let combined = [];
  let match;

  const urls = [];
  const mentions = [];

  urlRegex.lastIndex = 0;
  while ((match = urlRegex.exec(text)) !== null) {
    urls.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
  }

  mentionRegex.lastIndex = 0;
  while ((match = mentionRegex.exec(text)) !== null) {
    mentions.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
  }

  const allMatches = [...urls, ...mentions].sort((a, b) => a.start - b.start);

  let cursor = 0;
  allMatches.forEach((m) => {
    if (m.start > cursor) {
      container.appendChild(document.createTextNode(text.slice(cursor, m.start)));
    }

    if (urls.includes(m)) {
      const a = document.createElement("a");
      a.className = "link";
      a.href = m.value;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = m.value;
      container.appendChild(a);
    } else if (mentions.includes(m)) {
      const span = document.createElement("span");
      span.className = "mention";
      span.textContent = m.value;
      container.appendChild(span);
    }

    cursor = m.end;
  });

  if (cursor < text.length) {
    container.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

newMessagesBtn.addEventListener("click", () => {
  readonlyChatMessages.scrollTop = readonlyChatMessages.scrollHeight;
  pendingMessages = 0;
  newMessagesBtn.classList.add("hidden");
  chatUserScrolled = false;
});

readonlyChatMessages.addEventListener("scroll", () => {
  const el = readonlyChatMessages;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  chatUserScrolled = !atBottom;

  if (atBottom) {
    pendingMessages = 0;
    newMessagesBtn.classList.add("hidden");
  }
});

if (chatChannel) {
  setInterval(() => {
    const now = Date.now();
    for (let i = pendingLocalMessages.length - 1; i >= 0; i--) {
      if (now - pendingLocalMessages[i].ts > ECHO_TIMEOUT_MS) {
        pendingLocalMessages.splice(i, 1);
      }
    }
    pendingLocalEchoes = pendingLocalMessages.length;
  }, 2000);

  listen("chat-message", (event) => {
    if (event.payload.channel !== chatChannel) return;
    const data = event.payload.payload;
    const label = getCurrentWebviewWindow().label;
    const username = data?.username || "?";
    const msg = data?.message?.substring(0, 30) || "";

    if (myTwitchUsername && data.username && data.username.toLowerCase() === myTwitchUsername.toLowerCase()) {
      const incomingText = (data.message || "").trim().toLowerCase();
      const matchIdx = pendingLocalMessages.findIndex(m => m.text === incomingText);
      if (matchIdx !== -1) {
        const entry = pendingLocalMessages[matchIdx];
        pendingLocalMessages.splice(matchIdx, 1);
        pendingLocalEchoes = pendingLocalMessages.length;
        if (entry.node && entry.node.isConnected) {
          renderChatMessage(data, { replaceNode: entry.node });
          return;
        }
      }
    }

    console.log(`[CHAT-EVENT] chat-message → window='${label}' user='${username}' msg='${msg}'`);
    renderChatMessage(data);
  });

  listen("chat-room-state", (event) => {
    if (event.payload.channel !== chatChannel) return;
    if (!readonlyChatConnected) return;
    const state = event.payload.payload;

    const parts = [];
    if (state.slow && state.slow > 0) parts.push(`Slow: ${state.slow}s`);
    if (state.followers_only && state.followers_only > 0) parts.push(`Followers: ${state.followers_only}min`);
    if (state.subs_only) parts.push("Subs only");

    if (parts.length > 0) {
      chatRoomState.textContent = parts.join(" \u00B7 ");
      chatRoomState.classList.remove("hidden");
    } else {
      chatRoomState.classList.add("hidden");
    }
  });

  listen("chat-reconnect", (event) => {
    if (event.payload.channel !== chatChannel) return;
    if (!readonlyChatConnected) return;
    const status = event.payload.payload;
    if (status === "connecting") {
      clearChatUsers();
      return;
    }
    const msg = document.createElement("div");
    msg.className = "chat-msg system-msg";
    const typeSpan = document.createElement("span");
    typeSpan.className = "msg-type";
    typeSpan.textContent = status === "reconnecting" ? "Reconectando..." : status === "connected" ? "Conectado" : "";
    msg.appendChild(typeSpan);
    readonlyChatMessages.appendChild(msg);
    trimMessages();
    if (!chatUserScrolled) {
      readonlyChatMessages.scrollTop = readonlyChatMessages.scrollHeight;
    }
  });

  listen("chat-auth-failed", async (event) => {
    if (event.payload.channel !== chatChannel) return;
    const msg = document.createElement("div");
    msg.className = "chat-msg system-msg";
    const typeSpan = document.createElement("span");
    typeSpan.className = "msg-type";
    typeSpan.textContent = "Token inválido. Por favor inicie sesión de nuevo.";
    msg.appendChild(typeSpan);
    readonlyChatMessages.appendChild(msg);
    trimMessages();

    isCustomSession = false;
    myTwitchUsername = null;
    pendingLocalEchoes = 0;
    pendingLocalMessages.length = 0;
    updateChatInputVisibility();
    await updateAuthButtons();
  });

  listen("chat-user-join", (event) => {
    if (event.payload.channel !== chatChannel) return;
    if (!readonlyChatConnected) return;
    addChatUser(event.payload.payload.username);
  });

  listen("chat-user-leave", (event) => {
    if (event.payload.channel !== chatChannel) return;
    if (!readonlyChatConnected) return;
    removeChatUser(event.payload.payload.username);
  });

  listen("chat-user-bulk-add", (event) => {
    if (event.payload.channel !== chatChannel) return;
    if (!readonlyChatConnected) return;
    const label = getCurrentWebviewWindow().label;
    const data = event.payload.payload;
    console.log(`[CHAT-EVENT] chat-user-bulk-add → window='${label}' count=${data.usernames?.length || 0}`);
    addBulkChatUsers(data.usernames);
  });

  listen("chat-user-role", (event) => {
    if (event.payload.channel !== chatChannel) return;
    if (!readonlyChatConnected) return;
    const data = event.payload.payload;
    setUserRole(data.username, data.role);
  });
}

function getStallResetDelay(count) {
  const delays = [60000, 120000, 240000, 600000];
  return delays[Math.min(count, delays.length - 1)];
}

function syncSpeedSelect() {
  const rate = videoPlayer.playbackRate;
  speedSelect.value = String(rate);
}

videoPlayer.addEventListener("waiting", () => {
  if (speedSelect.value !== "auto" && videoPlayer.playbackRate > 1) {
    videoPlayer.playbackRate = 1;
  }
});

videoPlayer.addEventListener("ratechange", () => {
  if (speedSelect.value === "auto") {
    autoSpeedDisplay.textContent = `x${videoPlayer.playbackRate.toFixed(2)}`;
  } else {
    autoSpeedDisplay.textContent = "";
    syncSpeedSelect();
  }
});

speedSelect.addEventListener("change", () => {
  if (speedSelect.value === "auto") {
    if (hls) hls.config.maxLiveSyncPlaybackRate = 1.05;
    autoSpeedDisplay.textContent = "";
  } else {
    if (hls) hls.config.maxLiveSyncPlaybackRate = 1;
    videoPlayer.playbackRate = parseFloat(speedSelect.value);
    autoSpeedDisplay.textContent = "";
    currentLiveSyncDuration = 2;
    livesyncInput.value = 2;
    if (hls) hls.targetLatency = 2;
  }
});

livesyncInput.addEventListener("change", () => {
  const val = Math.max(1, Math.min(3, parseInt(livesyncInput.value) || 2));
  currentLiveSyncDuration = val;
  livesyncInput.value = val;
  if (hls) hls.targetLatency = val;
});

pipBtn.addEventListener("click", () => {
  videoPlayer.requestPictureInPicture();
});

chatToggleBtn?.addEventListener("click", () => {
  chatLayoutMode = (chatLayoutMode + 1) % 3;
  streamLayout.classList.remove("chat-left", "chat-hidden");
  if (chatLayoutMode === 1) {
    streamLayout.classList.add("chat-left");
  } else if (chatLayoutMode === 2) {
    streamLayout.classList.add("chat-hidden");
  }
  chatToggleBtn.classList.toggle("active", chatLayoutMode !== 0);
});

goLiveBtn?.addEventListener("click", () => {
  if (!hls) return;
  const details = hls.levels?.[hls.currentLevel]?.details;
  const edge = details?.edge;
  const target = edge != null ? edge - LIVE_EDGE_S : hls.liveSyncPosition;
  if (target != null) {
    videoPlayer.currentTime = target;
    videoPlayer.play().catch(() => {});
  }
  manualSeekPending = false;
  lastPlayheadPosition = videoPlayer.currentTime;
  goLiveBtn?.classList.add("hidden");
});

function createChatIframe(channel, incognito, darkMode) {
  const iframe = document.createElement("iframe");
  iframe.id = "chat";
  iframe.allowFullscreen = true;
  if (incognito) {
    iframe.setAttribute("credentialless", "");
  }
  let url = `https://www.twitch.tv/embed/${channel}/chat?parent=${getChatParent()}`;
  if (darkMode) url += "&darkpopout";
  iframe.src = url;

  iframe.addEventListener("load", () => {
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.querySelector(".twitch-chat")) {
        hideError();
      } else if (!currentChannel) {
        showError("Error al cargar el chat de Twitch.");
      }
    } catch (e) {
      if (!currentChannel && !iframe.src.includes("/embed/chat")) {
        hideError();
      }
    }
  });

  return iframe;
}

function destroyChatIframe() {
  if (chatIframe && chatIframe.isConnected) {
    chatIframe.src = "about:blank";
    chatIframe.remove();
  }
}

function mountChatIframe(channel, incognito, darkMode) {
  destroyChatIframe();
  const newIframe = createChatIframe(channel, incognito, darkMode);
  document.querySelector(".chat-container").appendChild(newIframe);
  chatIframe = newIframe;
  return newIframe;
}

connectBtn.addEventListener("click", async () => {
  const channel = channelInput.value.trim();
  if (!channel) {
    showError("Ingresa el nombre del canal.");
    return;
  }
  hideError();
  let displayName = channel;
  let title = channel;
  try {
    const info = await invoke("lookup_stream_info", { channel });
    if (info.displayName) displayName = info.displayName;
    if (info.title) title = info.title;
  } catch (e) {
    console.error("[STREAM] lookup_stream_info error:", e);
  }
  await openPlayerWindow(channel, displayName, title);
});
channelInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") connectBtn.click();
});

qualitySelect.addEventListener("change", () => {
  const idx = parseInt(qualitySelect.value);
  if (idx < 0 || idx >= streamsCache.length) return;
  savedTime = videoPlayer.currentTime;
  videoPlayer.classList.toggle("audio-mode", streamsCache[idx].name === "audio_only");
  startPlayback(streamsCache[idx].url);
});

async function handleLogin() {
  const hasSession = await invoke("has_twitch_session", { windowLabel: getCurrentWebviewWindow().label });

  if (hasSession && currentChannel) {
    if (isChatNativos) {
      if (readonlyChatConnected) {
        await disconnectReadonlyChat();
      }
      isIncognito = false;
      sessionStorage.removeItem("twitch_incognito");
      mountChatIframe(currentChannel, false, isDarkChat);
    } else {
      isIncognito = false;
      sessionStorage.removeItem("twitch_incognito");
      isCustomSession = true;
      await connectReadonlyChat(currentChannel, { clearMessages: true, authType: "session" });
    }
    await updateAuthButtons();
    return;
  }

  if (currentChannel) {
    localStorage.setItem("twitch_channel", currentChannel);
  }
  sessionStorage.removeItem("twitch_incognito");
  try {
    authBtn.disabled = true;
    authBtn.textContent = "Redirigiendo...";
    const myLabel = getCurrentWebviewWindow().label;
    await invoke("open_login_window", {
      windowLabel: myLabel,
    });
  } catch (err) {
    alert("Error al open login: " + String(err));
    localStorage.removeItem("twitch_channel");
    await updateAuthButtons();
  }
}

async function handleLogout() {
  try {
    await invoke("logout_twitch");

    isIncognito = true;
    sessionStorage.setItem("twitch_incognito", "true");

    if (currentChannel) {
      if (readonlyChatConnected) {
        await disconnectReadonlyChat();
      }
      currentChannel = "";
      streamLayout.classList.add("hidden");
    }

    await updateAuthButtons();
  } catch (err) {
    alert("Error al cerrar sesion: " + String(err));
  }
}

authBtn.addEventListener("click", async () => {
  if (!currentChannel) return;

  const hasSession = await invoke("has_twitch_session", { windowLabel: getCurrentWebviewWindow().label });
  invoke("log_frontend_msg", { msg: `authBtn click: hasSession=${hasSession} isChatNativos=${isChatNativos} isIncognito=${isIncognito} isCustomSession=${isCustomSession}` });

  if (!hasSession) {
    await handleLogin();
    return;
  }

  if (isChatNativos) {
    if (isIncognito) {
      await handleLogin();
    } else {
      isIncognito = true;
      sessionStorage.setItem("twitch_incognito", "true");
      if (currentChannel) {
        mountChatIframe(currentChannel, true, isDarkChat);
      }
      await updateAuthButtons();
    }
  } else {
    isCustomSession = !isCustomSession;
    await reconnectCustomChat();
  }
});

async function reconnectCustomChat() {
  if (!currentChannel || !shouldUseReadonlyChat()) {
    invoke("log_frontend_msg", { msg: `reconnectCustomChat BLOCKED: channel='${currentChannel}' shouldUseReadonly=${shouldUseReadonlyChat()}` });
    return;
  }

  if (isCustomSession && !myTwitchUsername) {
    try { myTwitchUsername = await invoke("get_twitch_username"); } catch (_) {}
  }

  const windowLabel = getCurrentWebviewWindow().label;
  const authType = isCustomSession ? "session" : "anonymous";
  invoke("log_frontend_msg", { msg: `reconnectCustomChat: channel='${currentChannel}' authType='${authType}'` });
  pendingLocalEchoes = 0;
  pendingLocalMessages.length = 0;
  await invoke("disconnect_readonly_chat", { windowLabel });

  await invoke("connect_readonly_chat", {
    channel: currentChannel,
    windowLabel,
    authType,
  });

  updateChatInputVisibility();
  await updateAuthButtons();
}

let chatInputListenersAttached = false;

function setupChatInput() {
  if (chatInputListenersAttached) return;

  const container = document.getElementById("chat-input-container");
  if (!container) return;

  async function sendMessage() {
    const input = document.getElementById("chat-input");
    const msg = input?.value?.trim();
    if (!msg || !currentChannel) {
      invoke("log_frontend_msg", { msg: `send blocked: msg='${msg}' currentChannel='${currentChannel}'` });
      return;
    }
    invoke("log_frontend_msg", { msg: `send: channel='${currentChannel}' msg='${msg}'` });
    try {
      const us = await invoke("send_chat_message", {
        channel: currentChannel,
        message: msg,
        windowLabel: getCurrentWebviewWindow().label,
      });
      if (myTwitchUsername) {
        const node = renderChatMessage({
          username: myTwitchUsername,
          display_name: us?.display_name || myTwitchUsername,
          color: us?.color || "#9147FF",
          message: msg,
          emotes: [],
          badges: us?.badges || [],
          timestamp: Date.now(),
          bits: null,
          subscriber: false,
          is_action: false,
        });
        pendingLocalMessages.push({ text: msg.trim().toLowerCase(), ts: Date.now(), node });
        pendingLocalEchoes = pendingLocalMessages.length;
      }
      input.value = "";
      invoke("log_frontend_msg", { msg: "send OK" });
    } catch (err) {
      invoke("log_frontend_msg", { msg: `send ERROR: ${err}` });
    }
  }

  container.addEventListener("click", (e) => {
    if (e.target.closest("#chat-send-btn")) {
      sendMessage();
    }
  });

  container.addEventListener("keydown", (e) => {
    if (e.target.id === "chat-input" && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatInputListenersAttached = true;
  invoke("log_frontend_msg", { msg: "setupChatInput: listeners attached via delegation" });
}

function updateChatInputVisibility() {
  const chatInputContainer = document.getElementById("chat-input-container");
  if (!chatInputContainer) return;

  const isCustom = !isChatNativos;
  const isVisible = isCustom && isCustomSession;
  chatInputContainer.classList.toggle("hidden", !isVisible);

  invoke("log_frontend_msg", { msg: `chatInput visible=${isVisible} isChatNativos=${isChatNativos} isCustomSession=${isCustomSession}` });

  setupChatInput();
}

gridRefreshBtn.addEventListener("click", () => {
  refreshGrid({ forceFresh: true });
});

gridManualBtn.addEventListener("click", async () => {
  if (readonlyChatConnected) {
    await disconnectReadonlyChat();
  }
  hideError();
  gridScreen.classList.add("hidden");
  connectScreen.classList.remove("hidden");
  channelInput.focus();
});

document.getElementById("back-to-grid-btn")?.addEventListener("click", () => {
  hideError();
  showGridScreen();
});

document.getElementById("grid-logout-btn")?.addEventListener("click", async () => {
  needsForceVerify = true;
  await handleLogout();
  await showGridScreen();
});

async function startConnection() {
  const channel = channelInput.value.trim();
  if (!channel) {
    showError("Ingresa el nombre del canal.");
    return;
  }

  setConnecting(true);
  hideError();

  try {
    streamsCache = await invoke("list_streams", { channel });

    if (streamsCache.length === 0) {
      showError("No hay streams available for this canal.");
      return;
    }

    currentChannel = channel;
    populateQualitySelect(streamsCache);

    connectScreen.classList.add("hidden");
    gridScreen.classList.add("hidden");
    streamLayout.classList.remove("hidden");

    if (shouldUseReadonlyChat()) {
      await connectReadonlyChat(channel, { authType: isCustomSession ? "session" : "anonymous" });
    } else {
      mountChatIframe(channel, isIncognito, isDarkChat);
    }
    videoPlayer.classList.toggle("audio-mode", streamsCache[qualitySelect.selectedIndex].name === "audio_only");
    startPlayback(streamsCache[qualitySelect.selectedIndex].url);
  } catch (error) {
    showError(String(error));
  } finally {
    setConnecting(false);
  }
}

function populateQualitySelect(streams) {
  qualitySelect.innerHTML = "";
  streams.forEach((s, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = formatQualityName(s.name);
    qualitySelect.appendChild(opt);
  });
  qualitySelect.selectedIndex = qualitySelect.options.length - 1;
}

function formatQualityName(name) {
  if (name === "audio_only") return "Solo audio";
  const altStr = String.fromCharCode(32, '(', 'a', 'l', 't', ')');
  return name.replace("_alt", altStr);
}

function scheduleStallReset() {
  const delay = getStallResetDelay(stallResetCount);
  nextResetTime = Date.now() + delay;
  stallResetTimeout = setTimeout(() => {
    if (hls?.latencyController) {
      const currentTarget = hls.targetLatency;
      hls.latencyController.stallCount = 0;
      currentLiveSyncDuration = Math.max(2, currentTarget - 0.5);
      hls.config.liveSyncDuration = currentLiveSyncDuration;
      livesyncInput.value = currentLiveSyncDuration;
    }
    stallResetCount++;
    stallResetTimeout = null;
    scheduleStallReset();
  }, delay);
}

function stopLatencyDisplay() {
  if (latencyInterval) {
    clearInterval(latencyInterval);
    latencyInterval = null;
  }
  if (stallResetTimeout) {
    clearTimeout(stallResetTimeout);
    stallResetTimeout = null;
  }
  resetInfoDisplay.textContent = "";
  latencyDisplay.textContent = "";
  targetLatencyDisplay.textContent = "";
  stallCountDisplay.textContent = "";
}

function isPositionBuffered(pos) {
  const buffered = videoPlayer.buffered;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= pos && buffered.end(i) >= pos) return true;
  }
  return false;
}

function startPlayback(url) {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  stopLatencyDisplay();
  currentLiveSyncDuration = 2;
  stallResetCount = 0;
  lastResyncAt = 0;
  initialCorrectionDone = false;
  manualSeekPending = false;
  lastPlayheadPosition = null;
  goLiveBtn?.classList.add("hidden");
  livesyncInput.value = 2;

  if (typeof Hls !== "undefined" && Hls.isSupported()) {
    hls = new Hls({
      liveSyncDuration: currentLiveSyncDuration,
      liveMaxLatencyDuration: 3600,
      maxBufferLength: 5,
      maxMaxBufferLength: 15,
      backBufferLength: 0,
      lowLatencyMode: true,
      maxLiveSyncPlaybackRate: 1.05,
      liveSyncOnStallIncrease: 0,
    });
    speedSelect.value = "auto";
    hls.loadSource(url);
    hls.attachMedia(videoPlayer);

    let initialSeekDone = false;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (savedTime > 0) {
        videoPlayer.currentTime = savedTime;
        savedTime = 0;
        initialSeekDone = true;
      }
      videoPlayer.play().catch(() => {});
      latencyInterval = setInterval(() => {
        if (hls && hls.latency != null) {
          const details = hls.levels?.[hls.currentLevel]?.details;
          const edge = details?.edge;
          const targetLatency = hls.targetLatency ?? currentLiveSyncDuration;
          const currentTime = videoPlayer.currentTime;
          manualSeekPending = updateResyncGate({
            manualSeekPending,
            currentTime,
            lastPosition: lastPlayheadPosition,
            latency: hls.latency,
            targetLatency,
          });
          const resync = runResyncTick({
            latency: hls.latency,
            targetLatency,
            liveSyncPosition: hls.liveSyncPosition,
            currentTime,
            edge,
            lastResyncAt,
            now: Date.now(),
            isAuto: speedSelect.value === "auto",
            bufferCovers: isPositionBuffered,
            manualSeekPending,
          });
          if (resync.target != null) {
            console.log("[resync]", {
              from: videoPlayer.currentTime,
              to: resync.target,
              latency: hls.latency,
              liveSyncPosition: hls.liveSyncPosition,
              edge,
            });
            videoPlayer.currentTime = resync.target;
            lastResyncAt = resync.lastResyncAt;
          }
          lastPlayheadPosition = videoPlayer.currentTime;
          const displayDelay = Math.max(0, hls.latency);
          latencyDisplay.textContent = `Delay: ${displayDelay.toFixed(1)}s`;
          latencyDisplay.classList.toggle("latency-high", displayDelay > 7);
          if (goLiveBtn) {
            const behind = manualSeekPending && displayDelay > targetLatency + RESYNC_THRESHOLD_OFFSET_S;
            goLiveBtn.classList.toggle("hidden", !behind);
          }
          targetLatencyDisplay.textContent = `Target: ${hls.targetLatency?.toFixed(1) ?? "?"}s`;
          const stallCount = hls.latencyController?.stallCount;
          stallCountDisplay.textContent = stallCount != null ? `Stalls: ${stallCount}` : "";
          if (stallCount > 0 && stallResetCount === 0 && !stallResetTimeout) {
            scheduleStallReset();
          }
          if (stallResetTimeout) {
            const secsLeft = Math.max(0, Math.ceil((nextResetTime - Date.now()) / 1000));
            resetInfoDisplay.textContent = `Resets: ${stallResetCount} · Next: ${secsLeft}s`;
          } else if (stallResetCount > 0) {
            resetInfoDisplay.textContent = `Resets: ${stallResetCount}`;
          }
        }
      }, 1000);
    });

    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (!initialSeekDone && hls.latency != null) {
        const liveEdge = hls.latency + videoPlayer.currentTime;
        const target = hls.liveSyncPosition ?? liveEdge - 1;
        const buffered = videoPlayer.buffered;
        for (let i = 0; i < buffered.length; i++) {
          if (buffered.start(i) <= target && buffered.end(i) >= target) {
            initialSeekDone = true;
            videoPlayer.currentTime = target;
            videoPlayer.play().catch(() => {});
            setTimeout(() => {
              if (!hls || initialCorrectionDone) return;
              const correction = computeInitialCorrection({
                currentTime: videoPlayer.currentTime,
                liveSyncPosition: hls.liveSyncPosition,
                edge: hls.levels?.[hls.currentLevel]?.details?.edge,
                initialCorrectionDone,
                bufferCovers: isPositionBuffered,
              });
              if (correction) {
                videoPlayer.currentTime = correction.target;
                videoPlayer.play().catch(() => {});
              }
              initialCorrectionDone = true;
            }, INITIAL_CORRECT_DELAY_MS);
            break;
          }
        }
      }
    });
  } else if (videoPlayer.canPlayType("application/vnd.apple.mpegurl")) {
    videoPlayer.src = url;
    videoPlayer.addEventListener(
      "loadedmetadata",
      () => {
        if (savedTime > 0) {
          videoPlayer.currentTime = savedTime;
          savedTime = 0;
        }
      videoPlayer.play().catch(() => {});
      },
      { once: true }
    );
  } else {
    showError("Tu browser no support HLS reproduccion.");
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
}

function hideError() {
  errorMsg.classList.add("hidden");
}

function setConnecting(state) {
  connectBtn.disabled = state;
  channelInput.disabled = state;
  if (backToGridBtn) backToGridBtn.disabled = state;
  connectBtn.textContent = state ? "CONECTANDO..." : "CONECTAR";
}

async function fetchFollowedStreams({ forceFresh = false } = {}) {
  const hasOAuth = await invoke("has_twitch_oauth");
  if (!hasOAuth) return null;

  try {
    const result = await invoke("fetch_followed_streams");
    console.log("[HELIX DEBUG] Result:", JSON.stringify(result, null, 2));
    const edges = result?.data?.currentUser?.follows?.edges || [];
    return edges
      .filter((edge) => edge.node.stream)
      .map((edge) => ({
        login: edge.node.login,
        displayName: edge.node.displayName,
        title: edge.node.stream.title || "",
        game: edge.node.stream.game?.name || "",
        viewers: edge.node.stream.viewersCount || 0,
        thumbnail: buildThumbnailUrl(edge.node.login, { forceFresh }),
        profileImage: edge.node.profileImageURL || "",
      }));
  } catch (err) {
    console.error("Error fetching followed streams:", err);
    return null;
  }
}

async function startTwitchOAuthLogin() {
  gridContainer.innerHTML = `<div class="grid-loading">Redirigiendo a Twitch...</div>`;
  try {
    const forceVerify = needsForceVerify;
    needsForceVerify = false;
    await invoke("twitch_oauth_login", { forceVerify });
  } catch (err) {
    console.error("OAuth login error:", err);
    gridContainer.innerHTML = `<div class="grid-loading">
      <div>Error: ${err}</div>
      <button onclick="showGridScreen()" style="margin-top:12px;padding:8px 16px;background:#9147ff;color:white;border:none;border-radius:4px;cursor:pointer;">Reintentar</button>
    </div>`;
  }
}

function renderGrid(streams) {
  gridContainer.innerHTML = "";

  if (!streams || streams.length === 0) {
    gridContainer.innerHTML = `<div class="grid-loading">No hay canales en vivo</div>`;
    gridTitle.textContent = "Canales en vivo";
    return;
  }

  const incomplete = streams.filter(s => !s.displayName || !s.title || !s.thumbnail);
  if (incomplete.length > 0) {
    console.warn("[GRID-DBG] Streams with missing fields:", JSON.stringify(incomplete[0]));
  }

  streams.forEach((stream) => {
    const card = document.createElement("div");
    card.className = "channel-card";
    card.innerHTML = `
      <div class="thumbnail-wrap">
        <img class="thumbnail" src="${stream.thumbnail}" alt="${stream.displayName}" loading="lazy" />
        <div class="spinner"></div>
      </div>
      <div class="card-info">
        <img class="avatar" src="${stream.profileImage}" alt="" />
        <div class="card-details">
          <div class="channel-name">${stream.displayName}</div>
          <div class="stream-title">${stream.title}</div>
          <div class="stream-meta">
            <span class="viewer-badge">EN VIVO</span>
            <span>${stream.viewers.toLocaleString()} espectadores</span>
            <span>${stream.game}</span>
          </div>
        </div>
      </div>
    `;
    card.addEventListener("click", () => connectToChannel(stream.login, card, stream.displayName, stream.title));
    gridContainer.appendChild(card);
  });

  gridTitle.textContent = `${streams.length} Canales en vivo`;
}

async function refreshGrid({ forceFresh = false } = {}) {
  const streams = await fetchFollowedStreams({ forceFresh });
  if (!streams) return;
  renderGrid(streams);
  lastGridRefreshAt = Date.now();
}

async function maybeRefreshGrid() {
  if (!shouldRefreshGrid({ lastRefreshAt: lastGridRefreshAt })) return;
  await refreshGrid();
}

function startGridFocusWatcher() {
  if (gridFocusWatcherStarted) return;
  gridFocusWatcherStarted = true;
  getCurrentWindow()
    .onFocusChanged(({ payload }) => {
      if (payload) maybeRefreshGrid();
    })
    .catch((e) => console.error("[GRID] onFocusChanged error:", e));
  setInterval(() => {
    if (document.hasFocus()) maybeRefreshGrid();
  }, 30000);
}

async function showGridScreen() {
  startGridFocusWatcher();
  connectScreen.classList.add("hidden");
  streamLayout.classList.add("hidden");
  gridScreen.classList.remove("hidden");

  const hasOAuth = await invoke("has_twitch_oauth");
  gridHeader.classList.toggle("hidden", !hasOAuth);
  const gridLogoutBtn = document.getElementById("grid-logout-btn");
  if (gridLogoutBtn) gridLogoutBtn.classList.toggle("hidden", !hasOAuth);
  if (!hasOAuth) {
    gridContainer.classList.add("grid-center");
    gridContainer.innerHTML = `<div class="grid-loading">
      <img src="/twitch-logo.svg" alt="Twitch" class="twitch-logo" />
      <div>Conecta tu cuenta de Twitch para ver tus canales en vivo.</div>
      <button id="oauth-login-btn" class="oauth-login-btn">Conectar con Twitch</button>
      <button id="grid-loading-manual-btn" class="oauth-login-btn">Ingresar canal manualmente</button>
    </div>`;
    gridTitle.textContent = "Canales en vivo";
    document.getElementById("oauth-login-btn").addEventListener("click", async () => {
      const success = await startTwitchOAuthLogin();
      if (success) {
        await showGridScreen();
      }
    });
    document.getElementById("grid-loading-manual-btn")?.addEventListener("click", async () => {
      gridScreen.classList.add("hidden");
      connectScreen.classList.remove("hidden");
      channelInput.focus();
    });
    return;
  }

  gridContainer.classList.remove("grid-center");
  gridContainer.innerHTML = `<div class="grid-loading">Cargando canales en vivo...</div>`;
  gridTitle.textContent = "Canales en vivo";

  const streams = await fetchFollowedStreams();
  renderGrid(streams);
  if (streams) {
    lastGridRefreshAt = Date.now();
  }
}

async function openPlayerWindow(channel, displayName, title) {
  const label = "player-" + channel;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    existing.setFocus();
    return;
  }
  const isDev = await invoke("is_dev_mode");
  const url = isDev
    ? "index.html#player/" + channel
    : "http://localhost:9527/index.html#player/" + channel;
  new WebviewWindow(label, {
    url,
    title: (displayName || channel) + " - " + (title || ""),
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 450,
    resizable: true,
    maximized: true,
  });
}

async function connectToChannel(channel, cardEl, displayName, title) {
  await openPlayerWindow(channel, displayName, title);
}

const hashChannel = isPlayerWindow ? "" : window.location.hash.slice(1);
const isOAuthRedirect = hashChannel.includes("access_token=");
const savedChannel = isOAuthRedirect ? null : (hashChannel || localStorage.getItem("twitch_channel"));

async function updateAuthButtons() {
  const isActive = isChatNativos ? !isIncognito : isCustomSession;
  authBtn.textContent = isActive ? "Cerrar sesión" : "Iniciar sesión";

  authBtn.disabled = false;
  authBtn.classList.remove("btn-disabled");
}

async function loadBttvGlobals() {
  if (bttvGlobalsLoaded) return;
  try {
    const resp = await invoke("fetch_bttv_emotes", {});
    if (!resp || !resp.globalEmotes) return;
    resp.globalEmotes.forEach((emote) => {
      if (emote.id && emote.code) {
        bttvEmotes.set(emote.code, {
          id: emote.id,
          animated: emote.animated || false,
          imageType: emote.imageType || "png"
        });
      }
    });
    bttvGlobalsLoaded = true;
    console.log(`[BTTV] Globals loaded: ${resp.globalEmotes.length} emotes`);
  } catch (err) {
    console.error("[BTTV] Failed to load globals:", err);
  }
}

async function init() {
  loadBttvGlobals();

  const [defaultIncognito, defaultDarkchat, defaultChatNativos, defaultHideTimestamps] = await Promise.all([
    invoke("get_incognito_default"),
    invoke("get_darkchat_default"),
    invoke("get_chat_nativos_default").catch(() => false),
    invoke("get_hide_timestamps_default").catch(() => false)
  ]);
  isIncognito = defaultIncognito || sessionStorage.getItem("twitch_incognito") === "true";
  isDarkChat = defaultDarkchat || sessionStorage.getItem("twitch_darkchat") === "true";
  isChatNativos = defaultChatNativos || sessionStorage.getItem("twitch_chat_nativos") === "true";
  isHideTimestamps = defaultHideTimestamps || sessionStorage.getItem("twitch_hide_timestamps") === "true";

  if (isPlayerWindow) {
    const channel = window.location.hash.slice("#player/".length);
    if (channel) {
      connectScreen.classList.add("hidden");
      gridScreen.classList.add("hidden");
      streamLayout.classList.remove("hidden");
      channelInput.value = channel;

  const hasSession = await invoke("has_twitch_session", { windowLabel: getCurrentWebviewWindow().label });
      if (hasSession) {
        isCustomSession = !isIncognito && !isChatNativos;
        try { myTwitchUsername = await invoke("get_twitch_username"); } catch (_) {}
      }

      await startConnection();
      await updateAuthButtons();
    }
    return;
  }

  const oauthHash = window.location.hash;
  if (oauthHash.includes("access_token=")) {
    const params = new URLSearchParams(oauthHash.substring(1));
    const token = params.get("access_token");
    if (token) {
      try {
        await invoke("save_oauth_token_cmd", { token });
        console.log("[OAUTH] Token saved from redirect");
      } catch (e) {
        console.error("[OAUTH] Error saving token:", e);
      }
    }
    window.history.replaceState({}, "", window.location.pathname);
  }

  if (savedChannel) {
    localStorage.removeItem("twitch_channel");

    const hasSession = await invoke("has_twitch_session");
    if (hasSession) {
      isCustomSession = !isIncognito && !isChatNativos;
    }

    channelInput.value = savedChannel;
    setTimeout(() => connectBtn.click(), 500);
  } else {
    try {
      await showGridScreen();
    } catch (e) {
      console.error("[INIT] showGridScreen failed:", e);
      gridScreen.classList.add("hidden");
      connectScreen.classList.remove("hidden");
      showError("No se pudo cargar la grilla de canales");
    }
  }

  await updateAuthButtons();
}
init();

listen("go-to-home", async () => {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  stopLatencyDisplay();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  manualSeekPending = false;
  lastPlayheadPosition = null;
  goLiveBtn?.classList.add("hidden");
  if (readonlyChatConnected) {
    await disconnectReadonlyChat();
  }
  destroyChatIframe();
  currentChannel = "";
  streamsCache = [];
  await showGridScreen();
});

listen("darkchat-mode", async (event) => {
  isDarkChat = event.payload;
  sessionStorage.setItem("twitch_darkchat", isDarkChat);
  if (currentChannel && !shouldUseReadonlyChat()) {
    mountChatIframe(currentChannel, isIncognito, isDarkChat);
  }
});

listen("chat-nativos", async (event) => {
  isChatNativos = event.payload;
  sessionStorage.setItem("twitch_chat_nativos", isChatNativos);
  if (currentChannel) {
    if (isChatNativos) {
      isIncognito = !isCustomSession;
      hideReadonlyChat();
      mountChatIframe(currentChannel, isIncognito, isDarkChat);
    } else {
      isCustomSession = !isIncognito;
      destroyChatIframe();
      if (readonlyChatConnected) {
        showReadonlyChat();
      } else {
        await connectReadonlyChat(currentChannel, { clearMessages: false, authType: isCustomSession ? "session" : "anonymous" });
      }
    }
    await updateAuthButtons();
  }
});

listen("hide-timestamps", async (event) => {
  isHideTimestamps = event.payload;
  sessionStorage.setItem("twitch_hide_timestamps", isHideTimestamps);
  readonlyChatMessages.classList.toggle("hide-timestamps", isHideTimestamps);
});

listen("cerrar-sesion", async () => {
  await handleLogout();
});

document.addEventListener("fullscreenchange", async () => {
  await invoke("set_menu_visible", { visible: !document.fullscreenElement });
});

listen("show-pip", () => pipBtn.classList.toggle("hidden"));
listen("show-quality", () => {
  qualityLabel.classList.toggle("hidden");
  qualitySelect.classList.toggle("hidden");
});
listen("show-speed", () => {
  speedLabel.classList.toggle("hidden");
  speedSelect.classList.toggle("hidden");
});
listen("show-latency", () => latencyDisplay.classList.toggle("hidden"));
document.getElementById("user-list-btn")?.addEventListener("click", toggleUserList);