import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const exe = join(homedir(), "AppData", "Local", "twitch-ultralight", "streamlink", "bin", "streamlink.exe");
const args = [
  "twitch.tv/argentumunitedtv",
  "--json",
  "--twitch-supported-codecs",
  "h264,h265,av1",
  "--twitch-low-latency",
];

let json;
try {
  json = JSON.parse(execFileSync(exe, args, { encoding: "utf8" }));
} catch (e) {
  console.error("streamlink fallo:", e.stderr || e.message);
  process.exit(1);
}

const url = json.streams?.["720p"]?.url ?? json.streams?.best?.url;
if (!url) {
  console.error("no se obtuvo URL de stream; streams:", Object.keys(json.streams ?? {}));
  process.exit(1);
}
console.error(`URL 720p: ${url.slice(0, 60)}...`);

function parsePlaylist(text) {
  const out = {
    targetduration: 0,
    partTarget: 0,
    holdBack: 0,
    partHoldBack: 0,
    mediaSequence: 0,
    segs: 0,
    prefetch: 0,
    lastSegDur: 0,
    lastSegPDT: null,
    edgeMedia: 0,
  };
  const segs = [];
  let lastPDT = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-TARGETDURATION:")) out.targetduration = parseFloat(line.split(":")[1]);
    else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) out.mediaSequence = parseInt(line.split(":")[1], 10);
    else if (line.startsWith("#EXT-X-SERVER-CONTROL:")) {
      const phb = line.match(/PART-HOLD-BACK=([\d.]+)/);
      const pt = line.match(/PART-TARGET=([\d.]+)/);
      const hb = line.match(/HOLD-BACK=([\d.]+)/);
      if (phb) out.partHoldBack = parseFloat(phb[1]);
      if (pt) out.partTarget = parseFloat(pt[1]);
      if (hb) out.holdBack = parseFloat(hb[1]);
    } else if (line.startsWith("#EXT-X-PART-INF:")) {
      const pt = line.match(/PART-TARGET=([\d.]+)/);
      if (pt) out.partTarget = parseFloat(pt[1]);
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      lastPDT = line.slice(23).trim();
    } else if (line.startsWith("#EXTINF:")) {
      const m = line.match(/^#EXTINF:([\d.]+)/);
      if (m) {
        segs.push(parseFloat(m[1]));
        out.lastSegDur = parseFloat(m[1]);
      }
    } else if (line.startsWith("#EXT-X-TWITCH-PREFETCH:")) {
      out.prefetch++;
    }
  }
  out.segs = segs.length;
  out.lastSegPDT = lastPDT;
  out.edgeMedia = segs.reduce((a, b) => a + b, 0);
  return out;
}

const DURATION_MS = 90000;
const STEP_MS = 500;
const samples = [];
const start = Date.now();
let prev = null;

while (Date.now() - start < DURATION_MS) {
  const t0 = Date.now();
  let p = null;
  try {
    const res = await fetch(url);
    p = parsePlaylist(await res.text());
  } catch (e) {
    p = { ...prev, error: e.message };
  }
  const atMs = Date.now() - start;
  const delta = prev && !p.error
    ? { wallMs: atMs - prev.atMs, media: p.edgeMedia - prev.edgeMedia, seq: p.mediaSequence - prev.mediaSequence, segs: p.segs - prev.segs, prefetch: p.prefetch - prev.prefetch }
    : null;
  samples.push({ atMs, ...p, delta });
  prev = p;
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, Math.max(0, STEP_MS - elapsed)));
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

const good = samples.filter((s) => !s.error);
const dMediaPerSec = samples.filter((s) => s.delta && s.delta.wallMs > 0).map((s) => (s.delta.media / s.delta.wallMs) * 1000);
const seqPerSec = samples.filter((s) => s.delta && s.delta.wallMs > 0).map((s) => (s.delta.seq / s.delta.wallMs) * 1000);
const segsPerSample = good.map((s) => s.segs);
const prefetchPerSample = good.map((s) => s.prefetch);
const segGapSamples = [];
for (let i = 1; i < good.length; i++) {
  if (good[i].delta && good[i].delta.seq > 0) {
    segGapSamples.push({ gapMs: good[i].atMs - good[i - 1].atMs, newSegs: good[i].delta.seq });
  }
}
const gapMs = segGapSamples.map((g) => g.gapMs);

const lastPDTs = good.map((s) => s.lastSegPDT && Date.parse(s.lastSegPDT)).filter(Boolean);
const nowUtcMs = Date.now();
const lastDur = good[0].lastSegDur;
const mediaEndLag = lastPDTs.map((p) => (nowUtcMs - p) / 1000 - lastDur);

const valid = samples.filter((s) => s.delta);
const firstV = valid[0];
const lastV = valid[valid.length - 1];
const wallS = (lastV.atMs - firstV.atMs) / 1000;
const seqDelta = lastV.mediaSequence - firstV.mediaSequence;
const mediaRate = (seqDelta * lastDur) / wallS;

console.log("\n=== REPORTE SONIDO PIPELINE (argentumunitedtv, HLS CDN no-LL) ===");
console.log(`muestras: ${samples.length} en ${DURATION_MS / 1000}s (paso ${STEP_MS}ms)`);
const first = good[0];
console.log(`formato: VERSION no-LL (sin EXT-X-PART) | targetduration: ${first.targetduration}s | segmentos de ${first.lastSegDur}s`);
console.log(`ventana: ${first.segs} segmentos + ${first.prefetch} prefetch`);
console.log(`avance real del edge: mediaSequence +${seqDelta} en ${wallS.toFixed(1)}s => ${mediaRate.toFixed(3)}x tiempo real (ideal 1.0)`);
console.log(`lag de ingesta (fin del ultimo segmento publicado vs ahora): mediana=${median(mediaEndLag).toFixed(2)}s`);
console.log(`age hls.js estimado (intervalo refresh segmentos): ~2s`);
console.log(`clamp hls.js liveSyncPosition en no-LL = edge - targetduration = edge - ${first.targetduration}s`);
console.log(`=> delay DISPLAY actual ~= ${first.targetduration}s + age + 1 = 7-10s (sintoma del usuario)`);
console.log(`=> piso REAL alcanzable = posicion cerca del edge (segmento 2s) + ingesta ~= ${(first.lastSegDur / 2 + median(mediaEndLag)).toFixed(1)}s`);

const errCount = samples.filter((s) => s.error).length;
if (errCount) console.log(`errores de fetch: ${errCount}/${samples.length}`);

const fs = await import("node:fs");
fs.writeFileSync("D:/TEMP/opencode/probe-samples.json", JSON.stringify(samples, null, 2));
console.log("\nmuestras guardadas en D:/TEMP/opencode/probe-samples.json");
