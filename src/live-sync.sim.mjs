import { runResyncTick } from "./live-sync.js";

export const SIM_CFG = {
  liveSyncDuration: 2,
  lowLatencyMode: true,
  playbackRate: 1,
  bufferWindowS: 8,
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(x, hi));

export function liveState({ edge, age, partTarget, targetduration, totalduration }) {
  const stalledScale = 3 * (SIM_CFG.lowLatencyMode && partTarget || targetduration);
  return {
    edge,
    age,
    partTarget,
    targetduration,
    totalduration,
    edgeStalled: Math.max(age - stalledScale, 0),
  };
}

export function hlsLatency(state, currentTime) {
  return state.edge + state.age - currentTime;
}

export function hlsTargetLatency(state) {
  return SIM_CFG.liveSyncDuration + Math.min(0, state.targetduration);
}

export function hlsLiveSyncPosition(state) {
  const targetLatency = hlsTargetLatency(state);
  const n = state.edge + state.age - targetLatency - state.edgeStalled;
  const lo = state.edge - state.totalduration;
  const hi = state.edge - (SIM_CFG.lowLatencyMode && state.partTarget || state.targetduration);
  return clamp(n, lo, hi);
}

export function makeBufferCovers(state) {
  return (pos) => pos >= state.edge - SIM_CFG.bufferWindowS && pos <= state.edge;
}

export function simulate({
  ticks,
  edge: initialEdge,
  age,
  currentTime: initialCurrentTime,
  partTarget,
  targetduration = 4,
  totalduration = 24,
  lastResyncAt = -Infinity,
  isAuto = true,
}) {
  const state = liveState({ edge: initialEdge, age, partTarget, targetduration, totalduration });
  const bufferCovers = makeBufferCovers(state);
  const frames = [];
  let currentTime = initialCurrentTime;
  let resyncAt = lastResyncAt;
  let virtualNow = 0;
  for (let t = 1; t <= ticks; t++) {
    state.edge += 1;
    virtualNow += 1000;
    const latency = hlsLatency(state, currentTime);
    const targetLatency = hlsTargetLatency(state);
    const liveSyncPosition = hlsLiveSyncPosition(state);
    const resync = runResyncTick({
      latency,
      targetLatency,
      liveSyncPosition,
      currentTime,
      edge: state.edge,
      lastResyncAt: resyncAt,
      now: virtualNow,
      isAuto,
      bufferCovers,
    });
    let action = "idle";
    if (resync.target != null) {
      action = resync.target >= currentTime ? "seek-forward" : "seek-backward";
      currentTime = resync.target;
      resyncAt = virtualNow;
    } else {
      currentTime += SIM_CFG.playbackRate;
    }
    frames.push({
      t,
      edge: state.edge,
      age: state.age,
      currentTime,
      latency,
      targetLatency,
      liveSyncPosition,
      action,
    });
  }
  return { frames, state };
}
