import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const args = process.argv.slice(2);
const type = args[0] || "patch";
const noTag = args.includes("--no-tag");

const CONFIG = {
  tauri: { path: "src-tauri/tauri.conf.json", kind: "json", key: "version" },
  pkg: { path: "package.json", kind: "json", key: "version" },
  lock: { path: "package-lock.json", kind: "json", keys: ["version", "packages..version"] },
  cargoToml: { path: "src-tauri/Cargo.toml", kind: "toml-package" },
  cargoLock: { path: "src-tauri/Cargo.lock", kind: "toml-crate" },
};

const TAG_PREFIX = "v";

function fail(msg) {
  console.error(`[bump] ${msg}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function setJsonPath(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let node = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const key = part === "" ? "" : part;
    if (isLast) {
      node[key] = value;
    } else {
      node = node[key];
    }
  }
}

function tomlPackageVersion(content) {
  return content.match(/^version = "([^"]+)"/m)?.[1];
}

function tomlCrateVersion(content) {
  const re = /^name = "twitch-ultra-ligero"\r?\nversion = "([^"]+)"/m;
  return content.match(re)?.[1];
}

function replaceTomlPackageVersion(content, newVersion) {
  return content.replace(/^version = "([^"]+)"/m, `version = "${newVersion}"`);
}

function replaceTomlCrateVersion(content, newVersion) {
  return content.replace(
    /^(name = "twitch-ultra-ligero"\r?\n)version = "[^"]+"/m,
    `$1version = "${newVersion}"`
  );
}

function syncFile(cfg, newVersion) {
  switch (cfg.kind) {
    case "json": {
      const obj = readJson(cfg.path);
      if (cfg.keys) {
        for (const k of cfg.keys) setJsonPath(obj, k, newVersion);
      } else {
        obj[cfg.key] = newVersion;
      }
      writeJson(cfg.path, obj);
      break;
    }
    case "toml-package": {
      const content = readFileSync(cfg.path, "utf-8");
      const current = tomlPackageVersion(content);
      if (current === undefined) fail(`no se encontró version en ${cfg.path}`);
      writeFileSync(cfg.path, replaceTomlPackageVersion(content, newVersion));
      break;
    }
    case "toml-crate": {
      const content = readFileSync(cfg.path, "utf-8");
      const current = tomlCrateVersion(content);
      if (current === undefined) fail(`no se encontró el crate twitch-ultra-ligero en ${cfg.path}`);
      writeFileSync(cfg.path, replaceTomlCrateVersion(content, newVersion));
      break;
    }
  }
}

function readCurrentVersion() {
  const obj = readJson(CONFIG.tauri.path);
  return obj[CONFIG.tauri.key];
}

function nextVersion(current, type) {
  const parts = current.split(".").map(Number);
  if (parts.some((n) => Number.isNaN(n))) fail(`versión actual inválida: ${current}`);
  const [major, minor, patch] = parts;
  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+$/.test(type)) return type;
      fail(`tipo inválido: '${type}' (usa patch, minor, major o X.Y.Z)`);
  }
}

const current = readCurrentVersion();
const newVersion = nextVersion(current, type);
if (newVersion === current) fail(`la versión ya es ${current}`);

for (const cfg of Object.values(CONFIG)) {
  syncFile(cfg, newVersion);
}
console.log(`[bump] ${current} → ${newVersion}`);

const tag = `${TAG_PREFIX}${newVersion}`;
if (noTag) {
  console.log("[bump] commit y tag omitidos (--no-tag)");
  process.exit(0);
}

try {
  const files = Object.values(CONFIG).map((c) => c.path);
  execSync(`git add ${files.join(" ")}`, { stdio: "inherit" });
  execSync(`git commit -m "release: ${tag}"`, { stdio: "inherit" });
  execSync(`git tag ${tag}`, { stdio: "inherit" });
  console.log(`[bump] commit + tag ${tag} creados`);
} catch (e) {
  fail(`error al crear commit/tag: ${e.message}`);
}
