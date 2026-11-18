// LVL's extension runner, Node side. The runner is a Java helper
// built from ext-runner/ that runs Mihon/Tachiyomi extensions (Android APKs) with
// Suwayomi's Android layer, so every repository source works, including the ones LVL
// has no engine for. It starts when a source needs it, talks over stdin/stdout (one
// JSON object per line, no network port), and stops after 10 idle minutes or when the
// Comics feature stops. Nothing runs when the runner isn't installed or Comics is off.
// In LVL's Android app the same protocol goes to the app's extension host (connectHost).
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  let child = null, ready = null, nextId = 0, generation = null;
  let retiring = null, retirementTimer = null, idleTimer = null;
  let lastUsed = 0, lastError = "", cancelSupported = false, quarantinedHost = false;
  const pending = new Map();
  const stderr = [];
  const loaded = new Map();
  const available = () => Boolean(dataDir && (hostSocket || (home && java)));

  function settle(id, entry, error, value) {
    if (pending.get(id) !== entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    clearTimeout(entry.cancelTimer);
    if (entry.signal && entry.abort) entry.signal.removeEventListener("abort", entry.abort);
    if (error) entry.reject(error);
    else { touch(); entry.resolve(value); }
  }

  function stop(reason = failure("The extension runner stopped", 503)) {
    const proc = child;
    const hadRequests = pending.size > 0;
    child = null; ready = null; generation = null; cancelSupported = false;
    loaded.clear();
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    for (const [id, entry] of [...pending]) settle(id, entry, reason);
    if (!proc) return;
    // The Android host is not our child process. Reconnection is prohibited
    // after abandoning work until its separate owner proves a fresh host.
    if (hostSocket && hadRequests) quarantinedHost = true;
    retiring = proc;
    try { proc.stdin.end(); } catch {}
    clearTimeout(retirementTimer);
    retirementTimer = setTimeout(() => {
      if (retiring === proc) try { proc.kill(); } catch {}
    }, 3000);
    retirementTimer.unref?.();
  }

  function retire(proc, reason) {
    if (child !== proc) return;
    lastError = reason;
    // stop() quarantines a socket only when that host has abandoned requests.
    stop(failure(reason, 503, "runner-retired"));
  }

  function start() {
    if (ready) return ready;
    if (retiring) return Promise.reject(failure("The old runner has not exited", 503, "runner-retiring"));
    if (quarantinedHost) return Promise.reject(failure("The extension host requires an externally verified restart", 503, "runner-quarantined"));
    if (!available()) return Promise.reject(failure("The extension runner isn't installed", 503, "no-runner"));
    fs.mkdirSync(dataDir, { recursive: true });
    const proc = hostSocket ? connectImpl(hostSocket) : spawnImpl(java, runnerArgs(home, dataDir), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    generation = randomUUID();
    cancelSupported = false;
    ready = new Promise((resolve, reject) => {
      let handshook = false;
      const timeout = setTimeout(() => {
        reject(failure("Extension runner readiness timed out"));
        retire(proc, "Extension runner readiness timed out");
      }, START_TIMEOUT_MS);
      proc.on("error", (error) => {
        if (child !== proc) return;
        clearTimeout(timeout);
        const message = handshook ? "Extension runner transport failed" : "The extension runner couldn't start";
        reject(failure(message, 503, handshook ? "runner-transport-failed" : "runner-start-failed"));
        const details = message + ": " + String(error?.message || "unknown").slice(0, 120);
        if (!handshook && !hostSocket && proc.pid == null) {
          // A failed spawn has no PID and no native owner to await.
          lastError = details;
          stop(failure(details, 503, "runner-start-failed"));
          if (retiring === proc) {
            retiring = null;
            clearTimeout(retirementTimer);
            retirementTimer = null;
          }
          return;
        }
        retire(proc, details);
      });
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        if (retiring === proc) { retiring = null; clearTimeout(retirementTimer); retirementTimer = null; }
        if (child !== proc) return;
        child = null; ready = null; generation = null; cancelSupported = false; loaded.clear();
        if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
        const error = failure("Extension runner exited: " + String(code), 503, "runner-exited");
        reject(error);
        for (const [id, entry] of [...pending]) settle(id, entry, error);
      });
      const reader = readline.createInterface({ input: proc.stdout });
      reader.on("error", () => {});
      reader.on("close", () => {
        if (child === proc) retire(proc, "Extension runner response stream closed");
      });
      reader.on("line", (line) => {
        if (child !== proc) return;
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (!message || typeof message !== "object") return;
        if (message.ready) {
          if (handshook) { retire(proc, "Extension runner repeated its readiness handshake"); return; }
          handshook = true;
          clearTimeout(timeout);
          cancelSupported = Number(message.version) >= 2 && message.cancelQuiesced === true;
          resolve(message);
          return;
        }
        const entry = pending.get(message.id);
        if (!entry || entry.proc !== proc) return;
        if (entry.state === "cancelling") {
          if (message.cancelAck !== true || message.generation !== entry.generation) return;
          if (message.quiesced === true) settle(message.id, entry, entry.cancelError);
          else retire(proc, "Cancellation did not prove terminal quiescence");
          return;
        }
        if (entry.state !== "pending") return;
        // A version-2 owner must echo the exact epoch for every response;
        // missing or foreign epochs are not legacy compatibility evidence.
        if (cancelSupported && message.generation !== entry.generation) {
          retire(proc, "Extension response generation mismatch");
          return;
        }
        if (message.generation !== undefined && message.generation !== entry.generation) return;
        if (message.cancelAck === true) { retire(proc, "Unexpected cancellation acknowledgment"); return; }
        if (message.error !== undefined) settle(message.id, entry, failure(String(message.error), Number(message.status) || 502, message.code || ""));
        else settle(message.id, entry, null, message.result);
      });
      proc.stderr.on("data", (chunk) => {
        if (child !== proc) return;
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue;
          stderr.push(line.slice(0, 400));
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
    idleTimer = setInterval(() => {
      if (child && pending.size === 0 && Date.now() - lastUsed > idleMs) stop();
    }, 60_000);
    idleTimer.unref?.();
  }

  function requestCancel(proc, id, entry, error) {
    if (child !== proc || pending.get(id) !== entry || entry.state !== "pending") return;
    entry.state = "cancelling";
    entry.cancelError = error;
    clearTimeout(entry.timer);
    if (!cancelSupported) {
      retire(proc, "The extension host lacks a terminal cancellation protocol");
      return;
    }
    entry.cancelTimer = setTimeout(() => {
      if (child === proc && pending.get(id) === entry)
        retire(proc, "The extension did not quiesce before its cancellation deadline");
    }, 3000);
    // A pending request must retain a real bounded retirement deadline even
    // when the socket/child goes silent and there are no other active handles.
    const frame = { op: "cancel", id: "cancel-" + id, cancelOf: id, generation: entry.generation };
    try {
      proc.stdin.write(JSON.stringify(frame) + "\n", (error) => {
        if (error && child === proc && pending.get(id) === entry) retire(proc, "Cancellation frame write failed");
      });
    } catch { retire(proc, "Cancellation frame transport failed"); }
  }

  async function call(op, args = {}, { timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
    if (signal?.aborted) throw failure("The extension request was aborted", 499, "aborted");
    await start();
    touch();
    const proc = child, owner = generation;
    if (!proc || !owner) throw failure("The extension runner stopped", 503);
    if (signal?.aborted) throw failure("The extension request was aborted", 499, "aborted");
    if (!Number.isSafeInteger(nextId + 1)) {
      retire(proc, "Extension request ID exhausted");
      throw failure("Extension request ID exhausted", 503);
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const entry = { proc, generation: owner, state: "pending", resolve, reject,
        signal, abort: null, timer: null, cancelTimer: null, cancelError: null };
      pending.set(id, entry);
      entry.timer = setTimeout(() => requestCancel(proc, id, entry,
        failure("The extension took too long to answer", 504, "extension-timeout")),
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CALL_TIMEOUT_MS);
      // Keep the deadline alive until response or terminal cancellation; do
      // not let an unresponsive legacy host strand an unsettled promise.
      if (signal) {
        entry.abort = () => requestCancel(proc, id, entry, failure("The extension request was aborted", 499, "aborted"));
        signal.addEventListener("abort", entry.abort, { once: true });
      }
      try {
        proc.stdin.write(JSON.stringify({ ...args, id, op, generation: owner }) + "\n", (error) => {
          if (error && child === proc && pending.get(id) === entry) retire(proc, "Extension request write failed");
        });
      } catch { retire(proc, "Extension request transport failed"); }
      if (signal?.aborted) entry.abort();
    });
  }

  function load(apkPath, key, { fingerprint = "", packageName = "" } = {}) {
    const signer = String(fingerprint).replaceAll(":", "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(signer) || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageName))
      return Promise.reject(failure("The extension's approved package and signing fingerprint are required", 403, "extension-trust"));
    let contentHash;
    try {
      const stat = fs.statSync(apkPath);
      if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw new Error("invalid size");
      contentHash = createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex");
    } catch { return Promise.reject(failure("The extension file could not be read", 403, "extension-trust")); }
    const cacheKey = JSON.stringify([key, packageName, signer, contentHash]);
    if (!loaded.has(cacheKey)) {
      const loading = call("load", { apk: apkPath, packageName, fingerprint: signer }, { timeoutMs: 180_000 });
      loaded.set(cacheKey, loading);
      loading.catch(() => { if (loaded.get(cacheKey) === loading) loaded.delete(cacheKey); });
    }
    return loaded.get(cacheKey);
  }

  return {
    available, call, load, stop,
    running: () => Boolean(child),
    status: () => ({ available: available(), running: Boolean(child), home: hostSocket ? "android-app" : home,
      lastError, log: [...stderr], retiring: Boolean(retiring), quarantinedHost, outstanding: pending.size }),
  };
}
