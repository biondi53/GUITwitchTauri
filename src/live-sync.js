export const RESYNC_COOLDOWN_MS = 3000;
export const RESYNC_THRESHOLD_OFFSET_S = 2;
export const INITIAL_CORRECT_MARGIN_S = 1;
export const FORWARD_MARGIN_S = 1;
export const LIVE_EDGE_S = 2;

export function computeResync({
  latency,
  targetLatency,
  liveSyncPosition,
  currentTime,
  edge,
  lastResyncAt,
  now,
  isAuto,
  bufferCovers,
}) {
  if (!isAuto) return null;
  if (latency == null || liveSyncPosition == null) return null;
  if (latency <= targetLatency + RESYNC_THRESHOLD_OFFSET_S) return null;
  if (now - lastResyncAt < RESYNC_COOLDOWN_MS) return null;
  const aggressive = edge != null ? edge - LIVE_EDGE_S : null;
  let target = null;
  if (aggressive != null && bufferCovers(aggressive)) {
    target = aggressive;
  } else if (bufferCovers(liveSyncPosition)) {
    target = liveSyncPosition;
  }
  if (target == null) return null;
  if (target - currentTime <= FORWARD_MARGIN_S) return null;
  return { target };
}

export function runResyncTick({
  latency,
  targetLatency,
  liveSyncPosition,
  currentTime,
  edge,
  lastResyncAt,
  now,
  isAuto,
  bufferCovers,
}) {
  const resync = computeResync({
    latency,
    targetLatency,
    liveSyncPosition,
    currentTime,
    edge,
    lastResyncAt,
    now,
    isAuto,
    bufferCovers,
  });
  if (resync) {
    return { target: resync.target, lastResyncAt: now };
  }
  return { target: null, lastResyncAt };
}

export function computeInitialCorrection({
  currentTime,
  liveSyncPosition,
  edge,
  initialCorrectionDone,
  bufferCovers,
}) {
  if (initialCorrectionDone) return null;
  if (liveSyncPosition == null) return null;
  const target = edge != null ? edge - LIVE_EDGE_S : liveSyncPosition;
  if (target - currentTime <= INITIAL_CORRECT_MARGIN_S) return null;
  if (!bufferCovers(target)) return null;
  return { target };
}
