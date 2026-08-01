import { execSync } from "child_process";
import { readFileSync } from "fs";
import { readCurrentVersion, nextVersion, TAG_PREFIX } from "./release-utils.js";

const args = process.argv.slice(2);
const type = args[0] || "patch";
const dryRun = args.includes("--dry-run");

const TAURI_CONF_PATH = "src-tauri/tauri.conf.json";
const INSTALLER_REL = "src-tauri/target/release/bundle/nsis";

function fail(msg) {
  console.error(`[release] ${msg}`);
  process.exit(1);
}

function run(cmd, { inherit = true } = {}) {
  const label = cmd;
  if (dryRun) {
    console.log(`[release] (dry-run) ${label}`);
    return;
  }
  console.log(`[release] > ${label}`);
  execSync(cmd, { stdio: inherit ? "inherit" : "pipe" });
}

function checkCleanTree() {
  const out = execSync("git status --porcelain", { encoding: "utf8" }).trim();
  if (out.length > 0) {
    fail("el working tree no está limpio. Commit o stash tus cambios antes de releasear.\n" + out);
  }
}

function checkGhAuth() {
  try {
    execSync("gh auth status", { stdio: "pipe" });
  } catch (_) {
    fail("gh no está autenticado. Ejecuta 'gh auth login' primero.");
  }
}

function getProductName() {
  const conf = JSON.parse(readFileSync(TAURI_CONF_PATH, "utf-8"));
  return conf.productName;
}

function getInstallerPath(productName, version) {
  return `${INSTALLER_REL}/${productName}_${version}_x64-setup.exe`;
}

checkCleanTree();
checkGhAuth();

const current = readCurrentVersion(TAURI_CONF_PATH);
let newVersion;
try {
  newVersion = nextVersion(current, type);
} catch (e) {
  fail(e.message);
}
if (newVersion === current) fail(`la versión ya es ${current}`);

const tag = `${TAG_PREFIX}${newVersion}`;
console.log(`[release] ${current} → ${newVersion} (tag ${tag})`);

run(`node bump-version.js ${type}`);
run("npm run tauri build -- --bundles nsis");

const productName = getProductName();
const installer = getInstallerPath(productName, newVersion);
if (newVersion && !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  fail("versión no semver");
}
run(`git push origin main`);
run(`git push origin ${tag}`);

const releaseCmd =
  `gh release create ${tag} "${installer}" --title "${productName} ${newVersion}" ` +
  `--generate-notes --draft`;
run(releaseCmd);

console.log(`[release] listo. Revisa el borrador en GitHub: gh release view ${tag}`);
