export const RESYNC_COOLDOWN_MS = 3000;
export const RESYNC_THRESHOLD_OFFSET_S = 2;
export const INITIAL_CORRECT_MARGIN_S = 1;
export const FORWARD_MARGIN_S = 1;
export const LIVE_EDGE_S = 2;
export const USER_SEEK_BACK_THRESHOLD_S = 0.5;

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
  manualSeekPending = false,
}) {
  if (!isAuto) return null;
  if (manualSeekPending) return null;
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
  manualSeekPending = false,
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
    manualSeekPending,
  });
  if (resync) {
    return { target: resync.target, lastResyncAt: now };
  }
  return { target: null, lastResyncAt };
}

export function updateResyncGate({
  manualSeekPending,
  currentTime,
  lastPosition,
  latency,
  targetLatency,
}) {
  if (manualSeekPending) {
    if (
      latency != null &&
      targetLatency != null &&
      latency <= targetLatency + RESYNC_THRESHOLD_OFFSET_S
    ) {
      return false;
    }
    return true;
  }
  if (
    currentTime != null &&
    lastPosition != null &&
    currentTime < lastPosition - USER_SEEK_BACK_THRESHOLD_S
  ) {
    return true;
  }
  return false;
}

export function computeTrueLatency({ realDelay, pdtMs, lastDur, now }) {
  if (realDelay == null || pdtMs == null) return null;
  const segEndS = pdtMs / 1000 + (lastDur ?? 0);
  const ingest = Math.max(0, now / 1000 - segEndS);
  return realDelay + ingest;
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
