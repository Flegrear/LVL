// LVL's extension runner, Node side. The runner is a Java helper
// built from ext-runner/ that runs Mihon/Tachiyomi extensions (Android APKs) with
// Suwayomi's Android layer, so every repository source works, including the ones LVL
// has no engine for. It starts when a source needs it, talks over stdin/stdout (one
// JSON object per line, no network port), and stops after 10 idle minutes or when the
// Comics feature stops. Nothing runs when the runner isn't installed or Comics is off.
// In LVL's Android app the same protocol goes to the app's extension host (connectHost).
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IDLE_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 90_000;
const STDERR_LINES = 40;

// Where the built runner is: LVL_EXT_RUNNER_HOME, the build output, or an installed copy.
export function runnerHome(env = process.env, root = ROOT, exists = fs.existsSync) {
  const candidates = [env.LVL_EXT_RUNNER_HOME, path.join(root, "ext-runner", "build", "dist"), path.join(root, "ext-runner")].filter(Boolean);
  return candidates.find((dir) => exists(path.join(dir, "lvl-ext-runner.jar")) && exists(path.join(dir, "lib"))) || null;
}

// The runner's own Java runtime (jlink), else JAVA_HOME's.
export function runnerJava(home, env = process.env, exists = fs.existsSync, platform = process.platform) {
  if (!home) return null;
  const name = platform === "win32" ? "java.exe" : "java";
  const own = path.join(home, "runtime", "bin", name);
  if (exists(own)) return own;
  const fromEnv = env.JAVA_HOME ? path.join(env.JAVA_HOME, "bin", name) : "";
  return fromEnv && exists(fromEnv) ? fromEnv : null;
}

export function runnerArgs(home, dataDir) {
  return ["-Xmx384m", "-XX:+UseSerialGC", "-Dfile.encoding=UTF-8", "-cp",
    `${path.join(home, "lvl-ext-runner.jar")}${path.delimiter}${path.join(home, "lib", "*")}`, "lvl.runner.MainKt", "--data", dataDir];
}

const failure = (message, status = 502, code = "") => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// In LVL's Android app the extensions run inside the app itself (Android loads them as
// they are, as Mihon does), and the app passes the Unix socket of its extension host in
// LVL_EXT_HOST_SOCKET. It speaks the same protocol as the Java runner; this wraps the
// connection so it looks like that runner's process.
export function connectHost(socketPath, connect = (target) => net.connect(target)) {
  const socket = connect(socketPath);
  const proc = new EventEmitter();
  proc.stdin = socket;
  proc.stdout = socket;
  proc.stderr = new PassThrough();
  proc.kill = () => socket.destroy();
  socket.on("error", (error) => proc.emit("error", error));
  socket.on("close", () => proc.emit("exit", null));
  return proc;
}

export function createExtRunner({ home = runnerHome(), java = runnerJava(home), dataDir, spawnImpl = spawn, idleMs = IDLE_MS, log = console,
  hostSocket = process.env.LVL_EXT_HOST_SOCKET || "", connectImpl = connectHost } = {}) {
  let child = null;
  let ready = null;
  let nextId = 0;
  let lastUsed = 0;
  let idleTimer = null;
  let lastError = "";
  const pending = new Map();
  const stderr = [];
  const loaded = new Map(); // "pkg@version" -> Promise<load result>

  const available = () => Boolean(dataDir && (hostSocket || (home && java)));

  function settleAll(error) {
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }

  function start() {
    if (ready) return ready;
    if (!available()) return Promise.reject(failure("The extension runner isn't installed", 503, "no-runner"));
    fs.mkdirSync(dataDir, { recursive: true });
    const proc = hostSocket ? connectImpl(hostSocket) : spawnImpl(java, runnerArgs(home, dataDir), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(failure("The extension runner didn't start")); stop(); }, START_TIMEOUT_MS);
      proc.on("error", (error) => { clearTimeout(timer); lastError = error.message; reject(failure(`The extension runner couldn't start (${error.message})`)); });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (child === proc) { child = null; ready = null; loaded.clear(); }
        const error = failure(`The extension runner stopped${code ? ` (exit ${code})` : ""}`);
        reject(error);
        settleAll(error);
      });
      // readline re-emits its input's errors; the process's own "error" handler reports them.
      readline.createInterface({ input: proc.stdout }).on("error", () => {}).on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.ready) { clearTimeout(timer); resolve(message); return; }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error !== undefined) entry.reject(failure(String(message.error), Number(message.status) || 502, message.code || ""));
        else entry.resolve(message.result);
      });
      proc.stderr.on("data", (chunk) => {
        for (const text of String(chunk).split(/\r?\n/)) {
          if (!text.trim()) continue;
          stderr.push(text.slice(0, 400));
          if (stderr.length > STDERR_LINES) stderr.shift();
        }
      });
    });
    ready.catch((error) => { lastError = error.message; log.warn?.("Extension runner:", error.message); });
    return ready;
  }

  function touch() {
    lastUsed = Date.now();
    if (idleTimer) return;
    idleTimer = setInterval(() => { if (child && !pending.size && Date.now() - lastUsed > idleMs) stop(); }, 60_000);
    idleTimer.unref?.();
  }

  async function call(op, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    await start();
    touch();
    const proc = child;
    if (!proc) throw failure("The extension runner stopped");
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(failure("The extension took too long to answer", 504)); }, timeoutMs);
      pending.set(id, { resolve: (value) => { touch(); resolve(value); }, reject, timer });
      proc.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
    });
  }

  // Loads an extension once per version (the runner converts it on first use and keeps the result).
  // fingerprint: the repository's signing-key fingerprint; the Android host refuses an APK
  // signed with another key (the Java runner doesn't check signatures).
  function load(apkPath, key, { fingerprint = "" } = {}) {
    if (!loaded.has(key)) {
      const loading = call("load", { apk: apkPath, ...(fingerprint ? { fingerprint } : {}) }, { timeoutMs: 180_000 });
      loaded.set(key, loading);
      loading.catch(() => loaded.delete(key));
    }
    return loaded.get(key);
  }

  function stop() {
    const proc = child;
    child = null;
    ready = null;
    loaded.clear();
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    settleAll(failure("The extension runner stopped"));
    if (!proc) return;
    try { proc.stdin.end(); } catch {}
    const kill = setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
    kill.unref?.();
  }

  return {
    available, call, load, stop,
    running: () => Boolean(child),
    status: () => ({ available: available(), running: Boolean(child), home: hostSocket ? "android-app" : home, lastError, log: [...stderr] }),
  };
}
