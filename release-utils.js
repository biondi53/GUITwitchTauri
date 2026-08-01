import { readFileSync } from "fs";

export const TAG_PREFIX = "v";

export function readCurrentVersion(tauriConfPath) {
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf-8"));
  return conf.version;
}

export function nextVersion(current, type) {
  const parts = current.split(".").map(Number);
  if (parts.some((n) => Number.isNaN(n))) {
    throw new Error(`versión actual inválida: ${current}`);
  }
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
      throw new Error(`tipo inválido: '${type}' (usa patch, minor, major o X.Y.Z)`);
  }
}
