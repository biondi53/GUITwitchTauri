import { runResyncTick } from "/src/live-sync.js";

const video = document.getElementById("v");
const statusEl = document.getElementById("status");
const telemetry = [];
window.__telemetry = telemetry;

const CFG = {
  liveSyncDuration: 2,
  liveMaxLatencyDuration: 3.5,
  maxBufferLength: 5,
  maxMaxBufferLength: 15,
  backBufferLength: 0,
  lowLatencyMode: true,
  maxLiveSyncPlaybackRate: 1.25,
  liveSyncOnStallIncrease: 0,
};

let lastResyncAt = -Infinity;
let lastTick = null;
let stalledSince = null;

function isBuffered(pos) {
  const b = video.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= pos && b.end(i) >= pos) return true;
  }
  return false;
}

async function main() {
  const hls = new Hls(CFG);
  window.__hls = hls;
  hls.loadSource("/__proxy/playlist");
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    video.play().catch(() => {});
  });

  setInterval(() => {
    if (!window.__hls) return;
    const details = hls.levels?.[hls.currentLevel]?.details;
    const edge = details?.edge;
    const currentTime = video.currentTime;
    const resync = runResyncTick({
      latency: hls.latency,
      targetLatency: hls.targetLatency ?? CFG.liveSyncDuration,
      liveSyncPosition: hls.liveSyncPosition,
      currentTime,
      edge,
      lastResyncAt,
      now: Date.now(),
      isAuto: true,
      bufferCovers: isBuffered,
    });
    let action = "idle";
    if (resync.target != null) {
      action = resync.target >= currentTime ? "seek-forward" : "seek-backward";
      video.currentTime = resync.target;
      lastResyncAt = resync.lastResyncAt;
    }
    const realDelay = edge != null ? Math.max(0, edge - currentTime) : null;
    if (lastTick != null && currentTime - lastTick < 0.01) {
      stalledSince = stalledSince ?? Date.now();
    } else {
      stalledSince = null;
    }
    lastTick = currentTime;
    telemetry.push({
      t: Date.now(),
      currentTime: +currentTime.toFixed(3),
      edge: edge != null ? +edge.toFixed(3) : null,
      hlsLatency: hls.latency ? +hls.latency.toFixed(3) : null,
      liveSyncPosition: hls.liveSyncPosition != null ? +hls.liveSyncPosition.toFixed(3) : null,
      action,
      realDelay: realDelay != null ? +realDelay.toFixed(3) : null,
      playing: !video.paused,
      stalled: stalledSince != null,
      readyState: video.readyState,
    });
    statusEl.textContent = `t=${telemetry.length} delay=${realDelay?.toFixed(1)}s action=${action} playing=${!video.paused}`;
  }, 1000);
}

main().catch((e) => {
  statusEl.textContent = "ERROR: " + e.message;
  telemetry.push({ t: Date.now(), error: String(e && e.stack || e) });
});
