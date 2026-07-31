import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const PORT = 8642;
const DURATION_MS = 150000;
const SETTLE_S = 60;

const server = spawn(process.execPath, ["tests/e2e/server.mjs"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((r) => setTimeout(r, 2000));

let browser;
let page;
let consoleMsgs = [];
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  });
  page = await browser.newPage();
  page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleMsgs.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(
    () => window.__telemetry && window.__telemetry.length >= 2,
    { timeout: 90000 }
  );

  const startWall = Date.now();
  while (Date.now() - startWall < DURATION_MS) {
    const tel = await page.evaluate(() => window.__telemetry);
    if (tel.some((t) => t.error)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const telemetry = await page.evaluate(() => window.__telemetry);
  await writeFile("D:/TEMP/opencode/e2e-telemetry.json", JSON.stringify(telemetry, null, 2));
  const cutoff = startWall + DURATION_MS - SETTLE_S * 1000;
  const late = telemetry.filter((t) => t.t >= cutoff && !t.error);
  const backward = telemetry.filter((t) => t.action === "seek-backward");
  const median = (a) => {
    if (!a.length) return Infinity;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const realDelays = late.map((t) => t.realDelay);
  const maxDelay = Math.max(...realDelays, 0);
  const hlsLatencies = late.map((t) => t.hlsLatency).filter((v) => v != null);
  const maxHlsLatency = Math.max(...hlsLatencies, 0);
  const stalled = late.filter((t) => t.stalled).length;
  const actions = late.map((t) => t.action);
  const seeksLate = actions.filter((a) => a !== "idle");

  console.log("=== E2E RESULT ===");
  console.log("frames totales:", telemetry.length, "| frames ultimos 60s:", late.length);
  console.log("backward seeks (todos):", backward.length);
  console.log("seeks en ultimos 60s:", seeksLate.length);
  console.log("realDelay mediana (ult 60s):", median(realDelays).toFixed(2), "s");
  console.log("realDelay max (ult 60s):", maxDelay.toFixed(2), "s");
  console.log("hlsLatency mediana (ult 60s):", median(hlsLatencies).toFixed(2), "s");
  console.log("hlsLatency max (ult 60s):", maxHlsLatency.toFixed(2), "s");
  console.log("stalls (ult 60s):", stalled);
  console.log("console msg:", consoleMsgs.length);

  let ok = true;
  if (backward.length) {
    console.log("FAIL: seeks hacia atras detectados");
    ok = false;
  }
  if (median(realDelays) > 3.5) {
    console.log(`FAIL: delay no converge (mediana ${median(realDelays).toFixed(2)}s)`);
    ok = false;
  }
  if (maxDelay > 6) {
    console.log(`FAIL: picos de delay altos (max ${maxDelay.toFixed(2)}s)`);
    ok = false;
  }
  if (median(hlsLatencies) > 5) {
    console.log(`FAIL: hlsLatency (delay vs Twitch) no converge (mediana ${median(hlsLatencies).toFixed(2)}s)`);
    ok = false;
  }
  if (maxHlsLatency > 8) {
    console.log(`FAIL: picos de hlsLatency altos (max ${maxHlsLatency.toFixed(2)}s)`);
    ok = false;
  }
  const ageNeg = late.filter(
    (t) => t.realDelay != null && t.hlsLatency != null && t.hlsLatency < t.realDelay - 0.05
  );
  if (ageNeg.length) {
    console.log("FAIL: hlsLatency < realDelay (age negativo):", ageNeg.length);
    ok = false;
  }
  if (stalled > Math.max(2, late.length * 0.1)) {
    console.log("FAIL: demasiados frames con stall:", stalled);
    ok = false;
  }
  const errors = consoleMsgs.filter((m) => m.startsWith("error") || m.startsWith("pageerror"));
  if (errors.length) {
    console.log("errores de consola:");
    errors.slice(0, 5).forEach((e) => console.log("  " + e));
  }
  console.log(ok ? "E2E PASS" : "E2E FAIL");
  process.exitCode = ok ? 0 : 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
