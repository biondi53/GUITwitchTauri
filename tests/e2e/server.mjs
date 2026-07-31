import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const ROOT = resolve(import.meta.dirname, "../..");
const exe = join(homedir(), "AppData", "Local", "twitch-ultralight", "streamlink", "bin", "streamlink.exe");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

let cachedCdnUrl = null;

function getCdnUrl() {
  if (cachedCdnUrl) return cachedCdnUrl;
  const args = [
    "twitch.tv/argentumunitedtv",
    "--json",
    "--twitch-supported-codecs",
    "h264,h265,av1",
    "--twitch-low-latency",
  ];
  const json = JSON.parse(execFileSync(exe, args, { encoding: "utf8" }));
  cachedCdnUrl = json.streams?.["720p"]?.url ?? json.streams?.best?.url ?? null;
  return cachedCdnUrl;
}

async function proxyPlaylist() {
  const cdn = getCdnUrl();
  if (!cdn) return null;
  const text = await (await fetch(cdn)).text();
  return text
    .replace(/#EXT-X-TWITCH-PREFETCH:[^\n]*\n/g, "")
    .replace(/https:\/\/[^\s"]+\.ts\?dna=[^\s"]+/g, (m) => "/__proxy/seg?u=" + encodeURIComponent(m));
}

const server = createServer(async (req, res) => {
  try {
    const [pathname, query] = (req.url || "/").split("?");
    if (pathname === "/__proxy/playlist") {
      const text = await proxyPlaylist();
      if (text == null) {
        res.statusCode = 502;
        res.end("no stream");
        return;
      }
      res.setHeader("content-type", MIME[".json"] || "application/vnd.apple.mpegurl");
      res.end(text);
      return;
    }
    if (pathname === "/__proxy/seg") {
      const u = new URL(req.url, "http://localhost").searchParams.get("u");
      if (!u) {
        res.statusCode = 400;
        res.end("bad seg");
        return;
      }
      const seg = await fetch(u);
      if (!seg.ok) {
        res.statusCode = seg.status;
        res.end("seg fetch failed");
        return;
      }
      const buf = Buffer.from(await seg.arrayBuffer());
      res.setHeader("content-type", "video/mp2t");
      res.setHeader("content-length", buf.length);
      res.end(buf);
      return;
    }
    if (pathname === "/__stream") {
      const url = getCdnUrl();
      res.setHeader("content-type", MIME[".json"]);
      res.end(JSON.stringify({ url }));
      return;
    }
    let localPath = decodeURIComponent(pathname || "/");
    if (localPath === "/") localPath = "/tests/e2e/player.html";
    let filePath = normalize(join(ROOT, localPath));
    if (!filePath.startsWith(ROOT)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      data = await readFile(normalize(join(ROOT, "public", localPath)));
    }
    res.setHeader("content-type", MIME[extname(filePath)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found: " + req.url);
  }
});

const port = Number(process.env.E2E_PORT || 8642);
server.listen(port, () => console.log(`e2e server on http://127.0.0.1:${port}`));
