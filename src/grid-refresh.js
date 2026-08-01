export const GRID_STALE_MS = 5 * 60 * 1000;

export function shouldRefreshGrid({ lastRefreshAt, now = Date.now(), staleMs = GRID_STALE_MS }) {
  return now - lastRefreshAt >= staleMs;
}

export function buildThumbnailUrl(login, { forceFresh = false, now = Date.now() } = {}) {
  const base = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-320x180.jpg`;
  return forceFresh ? `${base}?t=${now}` : base;
}
