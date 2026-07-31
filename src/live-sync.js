export const RESYNC_COOLDOWN_MS = 3000;
export const RESYNC_THRESHOLD_OFFSET_S = 2;
export const INITIAL_CORRECT_MARGIN_S = 1;

export function computeResync({
  latency,
  targetLatency,
  liveSyncPosition,
  lastResyncAt,
  now,
  isAuto,
  bufferCovers,
}) {
  if (!isAuto) return null;
  if (latency == null || liveSyncPosition == null) return null;
  if (latency <= targetLatency + RESYNC_THRESHOLD_OFFSET_S) return null;
  if (now - lastResyncAt < RESYNC_COOLDOWN_MS) return null;
  if (!bufferCovers(liveSyncPosition)) return null;
  return { target: liveSyncPosition };
}

export function runResyncTick({
  latency,
  targetLatency,
  liveSyncPosition,
  currentTime,
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
  initialCorrectionDone,
  bufferCovers,
}) {
  if (initialCorrectionDone) return null;
  if (liveSyncPosition == null) return null;
  if (liveSyncPosition - currentTime <= INITIAL_CORRECT_MARGIN_S) return null;
  if (!bufferCovers(liveSyncPosition)) return null;
  return { target: liveSyncPosition };
}
