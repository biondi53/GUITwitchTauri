import { readFileSync, writeFileSync } from "fs";

const args = process.argv.slice(2);
const type = args[0] || "patch";

const confPath = "src-tauri/tauri.conf.json";
const pkgPath = "package.json";

const conf = JSON.parse(readFileSync(confPath, "utf-8"));
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const [major, minor, patch] = conf.version.split(".").map(Number);

let newVersion;
switch (type) {
  case "major":
    newVersion = `${major + 1}.0.0`;
    break;
  case "minor":
    newVersion = `${major}.${minor + 1}.0`;
    break;
  default:
    newVersion = `${major}.${minor}.${patch + 1}`;
}

conf.version = newVersion;
pkg.version = newVersion;

writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`Version bumped to ${newVersion}`);
