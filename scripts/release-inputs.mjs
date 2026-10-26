// Shared source-file boundary for the new LVL 0.1.0 setup builder.
// This module selects program inputs only; it never copies files or builds a setup.
// The installer must enumerate files through this rule rather than recursively
// packaging the repository or relying on Git's index.

const applicationRoots = Object.freeze([
  "assets/", "backend/", "frontend/", "learning/", "shared/",
]);
const applicationEntries = new Set([
  "app.js", "index.html", "server.js", "package.json", "CHANGELOG.md",
]);
// Development-only generator. Its generated preset data is needed at runtime,
// but the recipe is not executable application content.
const sourceOnlyFiles = new Set(["learning/build-presets.mjs"]);

export function isSetupSourceFile(relativePath) {
  if (typeof relativePath !== "string" || !relativePath) return false;
  const name = relativePath.replaceAll("\\", "/");
  if (name.startsWith("/") || name.includes(":") || name.includes("\0")) return false;
  const components = name.split("/");
  if (components.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  if (sourceOnlyFiles.has(name)) return false;
  if (/(?:\.env|\.log|\.db|\.db-wal|\.db-shm|\.sqlite|\.sqlite3|\.sqlite3-wal|\.sqlite3-shm|\.pem|\.key|\.p12|\.pfx|\.bak|\.tmp)$/i.test(name)) return false;
  if (applicationEntries.has(name)) return true;
  return applicationRoots.some((prefix) => name.startsWith(prefix));
}

// Explicitly not allowed: docs/, tests/, devtools/, scripts/, old installer
// directories, local user data, Git metadata and generated build artifacts.
// Runtime dependencies/Node/FFmpeg are handled separately by the future setup.
