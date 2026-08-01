import { test } from "node:test";
import assert from "node:assert/strict";

import { GRID_STALE_MS, shouldRefreshGrid, buildThumbnailUrl } from "./grid-refresh.js";

const lastRefreshAt = 1_000_000;

test("shouldRefreshGrid devuelve false si pasaron menos de 5 min", () => {
  const now = lastRefreshAt + GRID_STALE_MS - 1;
  assert.equal(shouldRefreshGrid({ lastRefreshAt, now }), false);
});

test("shouldRefreshGrid devuelve true si pasaron exactamente 5 min", () => {
  const now = lastRefreshAt + GRID_STALE_MS;
  assert.equal(shouldRefreshGrid({ lastRefreshAt, now }), true);
});

test("shouldRefreshGrid devuelve true si pasaron mas de 5 min", () => {
  const now = lastRefreshAt + GRID_STALE_MS + 60_000;
  assert.equal(shouldRefreshGrid({ lastRefreshAt, now }), true);
});

test("shouldRefreshGrid sin carga previa (0) siempre refresca", () => {
  assert.equal(shouldRefreshGrid({ lastRefreshAt: 0, now: lastRefreshAt }), true);
});

test("buildThumbnailUrl sin forceFresh devuelve la URL base sin query", () => {
  const url = buildThumbnailUrl("mychannel");
  assert.equal(url, "https://static-cdn.jtvnw.net/previews-ttv/live_user_mychannel-320x180.jpg");
});

test("buildThumbnailUrl con forceFresh agrega cache-buster t=now", () => {
  const now = 1_700_000_000_000;
  const url = buildThumbnailUrl("mychannel", { forceFresh: true, now });
  assert.equal(url, `https://static-cdn.jtvnw.net/previews-ttv/live_user_mychannel-320x180.jpg?t=${now}`);
});
