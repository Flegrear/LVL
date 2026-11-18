// The pop-up player: a borderless, always-on-top window (LVL-Popup.exe, WebView2) that
// shows LVL's own player page (/watch?popup=<token>). The server starts the program hidden
// the first time LVL asks (so a pop-out only has to load the page), talks to it over
// stdin/stdout (one JSON object per line) and stops it with the server.
// The handoff: LVL's window sends what is playing (POST /api/popup/open); the pop-up page
// reads it once it loads, plays from there, reports its position every second, and on
// Return or close reports a last time. LVL's window polls /api/popup/status and continues
// from that position. Without the program or the WebView2 runtime, `available` is false
// and the page uses the browser's own pop-up.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const START_TIMEOUT_MS = 20_000;
const HANDOFF_TTL_MS = 2 * 60_000;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
// A report is untrusted page input. Only an actual finite numeric rate within
// the player's supported range can replace the current handoff's rate.
export const validPopupRate = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0.25 && value <= 4 ? value : null;

// What the pop-up continues from. Only Library sources (a torrent and a file in it) can be
// opened again in another window; a file opened from disk stays in the browser's pop-up.
export function cleanPlayback(input = {}) {
  const libraryId = String(input.libraryId || "").toLowerCase();
  const fileIndex = Number(input.fileIndex);
  if (!/^[0-9a-f]{40}$/.test(libraryId) || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 100_000) return null;
  return {
    libraryId, fileIndex,
    positionSeconds: Math.max(0, finite(input.positionSeconds)),
    paused: Boolean(input.paused),
    volume: Math.min(1, Math.max(0, finite(input.volume, 1))),
    muted: Boolean(input.muted),
    rate: Math.min(4, Math.max(0.25, finite(input.rate, 1))),
    title: String(input.title || "").slice(0, 200),
  };
}

// The player's saved settings (subtitle style, languages, volume…) from LVL's window, for the
// pop-up's own profile, plus the two markers that tell the page the database is already set
// up and holds the preferences. Account tokens and the Library copies stay in LVL's window.
const POPUP_APP_STATE_KEYS = new Set(["blackline-db-migrated-v1", "blackline-db-preferences-v2"]);
export function cleanStorage(input) {
  const out = {};
  let bytes = 0;
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || /anilist|token|oauth|secret|letterboxd|coach|account/i.test(key)) continue;
    if (!/^lvl[-_][\w.:-]{1,80}$/i.test(key) && !POPUP_APP_STATE_KEYS.has(key)) continue;
    bytes += key.length + value.length;
    if (bytes > MAX_STORAGE_BYTES) break;
    out[key] = value;
  }
  return out;
}

// home: the folder with LVL-Popup.exe, or resolveHome(): looked up each time, since an
// installed LVL downloads the program after it starts (popup-program.js).
export function createPopupWindow({ home = null, resolveHome = null, profileDir, boundsFile, spawnImpl = spawn, log = console, platform = process.platform, now = Date.now } = {}) {
  let child = null;
  let ready = null;
  let stoppingChild = null;
  let stopPromise = null;
  let resolveStop = null;
  let stopTimers = [];
  let disposed = false;
  let visible = false;
  // What the program last said about its window (shown/hidden), apart from what LVL asked.
  let windowShown = false;
  // The program couldn't start (no WebView2 runtime): unavailable until LVL restarts.
  let broken = false;
  let started = false;
  let lastError = "";
  // { id, token, playback, storage, createdAt, report: { positionSeconds, paused, at }, result: { action, positionSeconds, paused, at } }
  let handoff = null;
  let finished = null;
  let openGeneration = 0;
  const latestOpenByClient = new Map();

  const where = () => (resolveHome ? resolveHome() : home);
  const available = () => Boolean(where() && platform === "win32" && !broken && !disposed);

  function readBounds() {
    try {
      const saved = JSON.parse(fs.readFileSync(boundsFile, "utf8"));
      return ["x", "y", "width", "height"].every((key) => Number.isInteger(saved[key])) ? saved : null;
    } catch { return null; }
  }

  function writeBounds(event) {
    try {
      fs.mkdirSync(path.dirname(boundsFile), { recursive: true });
      fs.writeFileSync(boundsFile, JSON.stringify({ x: event.x, y: event.y, width: event.width, height: event.height }));
    } catch (error) { log.warn?.("Pop-up player:", error.message); }
  }

  function finish(action, fields = {}) {
    if (!handoff || finished?.id === handoff.id) return;
    const last = handoff.report || {};
    finished = {
      id: handoff.id, action,
      positionSeconds: finite(fields.positionSeconds, finite(last.positionSeconds, handoff.playback.positionSeconds)),
      rate: validPopupRate(fields.rate) ?? validPopupRate(last.rate) ?? handoff.playback.rate,
      paused: fields.paused ?? last.paused ?? handoff.playback.paused, at: now(),
    };
  }

  function start() {
    if (disposed || stoppingChild || child && !ready)
      return Promise.reject(Object.assign(new Error("The pop-up player is shutting down"), { status: 503 }));
    if (ready) return ready;
    if (!available()) return Promise.reject(Object.assign(new Error("The pop-up player isn't installed"), { status: 503 }));
    fs.mkdirSync(profileDir, { recursive: true });
    const proc = spawnImpl(path.join(where(), "LVL-Popup.exe"), ["--profile", profileDir], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    started = false;
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("The pop-up player didn't start")); void stop(); }, START_TIMEOUT_MS);
      proc.on("error", (error) => {
        // A late error from a retired process cannot stop a new WebView2
        // child or mark its program permanently unavailable.
        if (child !== proc && stoppingChild !== proc) return;
        clearTimeout(timer);
        lastError = error.message;
        broken = true;
        reject(error);
        void stop();
        // A failed spawn has no OS process and may never emit close.
        if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) {
          try { proc.stdin?.destroy(); proc.stdout?.destroy(); proc.stderr?.destroy(); } catch {}
          processClosed(proc, true);
        }
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`The pop-up player stopped${code ? ` (exit ${code})` : ""}`));
      });
      proc.on("close", () => {
        clearTimeout(timer);
        processClosed(proc, true);
        reject(new Error("The pop-up player closed"));
      });
      proc.stderr?.on("data", () => {});
      const reader = readline.createInterface({ input: proc.stdout });
      proc.once("close", () => reader.close());
      reader.on("line", (line) => {
        if (child !== proc || stoppingChild === proc) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.event === "ready") { started = true; clearTimeout(timer); resolve(proc); }
        else if (event.event === "error") {
          lastError = String(event.message || "").slice(0, 300);
          log.warn?.("Pop-up player:", lastError);
          // Before it is ready (no WebView2 runtime): the browser's own pop-up from now on.
          if (!started) {
            broken = true;
            clearTimeout(timer);
            reject(new Error(lastError || "The pop-up player couldn't start"));
            void stop();
          }
        }
        else if (event.event === "shown") { visible = true; windowShown = true; }
        else if (event.event === "hidden") { visible = false; windowShown = false; finish(event.reason === "user" ? "close" : "return"); }
        else if (event.event === "bounds") writeBounds(event);
      });
    });
    ready.catch((error) => { lastError = error.message; });
    return ready;
  }

  function send(command) {
    if (!child?.stdin?.writable) return false;
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  // A frameless, always-on-top window must never stay up after a close: if the program
  // doesn't confirm the hide within 3 s, it is stopped (it starts again on the next pop-out).
  let hideWatch = null;
  function hideWindow() {
    visible = false;
    if (!child) return;
    const owner = child;
    const ownerHandoffId = handoff?.id;
    send({ op: "hide" });
    clearTimeout(hideWatch);
    hideWatch = setTimeout(() => {
      if (!windowShown || child !== owner || handoff?.id !== ownerHandoffId) return;
      log.warn?.("Pop-up player: the window didn't confirm it closed; stopping it");
      stop();
    }, 3000);
    hideWatch.unref?.();
  }

  function processClosed(proc, confirmed) {
    if (child === proc) {
      child = null;
      ready = null;
      started = false;
      if (visible) finish("close");
      visible = false;
      windowShown = false;
    }
    if (stoppingChild !== proc) return;
    for (const timer of stopTimers) clearTimeout(timer);
    stopTimers = [];
    stoppingChild = null;
    const done = resolveStop;
    resolveStop = null;
    stopPromise = null;
    done?.(confirmed);
  }

  // Resolve after actual child close, or report an unconfirmed bounded stop.
  // An unconfirmed process keeps the profile reserved until a later close:
  // opening another child against the same WebView2 profile is never safe.
  function stop() {
    if (stopPromise) return stopPromise;
    const proc = child;
    visible = false;
    windowShown = false;
    clearTimeout(hideWatch);
    hideWatch = null;
    if (!proc) return Promise.resolve(true);
    stoppingChild = proc;
    stopPromise = new Promise(resolve => { resolveStop = resolve; });
    try { proc.stdin.end(); } catch {}
    const term = setTimeout(() => { if (stoppingChild === proc) try { proc.kill("SIGTERM"); } catch {} }, 500);
    const kill = setTimeout(() => { if (stoppingChild === proc) try { proc.kill("SIGKILL"); } catch {} }, 3000);
    const deadline = setTimeout(() => {
      if (stoppingChild !== proc) return;
      for (const timer of stopTimers) clearTimeout(timer);
      stopTimers = [];
      const done = resolveStop;
      resolveStop = null;
      // Keep stoppingChild and child until a real close event. A second stop
      // call can await the same already-settled outcome without spawning.
      done?.(false);
    }, 6000);
    stopTimers = [term, kill, deadline];
    for (const timer of stopTimers) timer.unref?.();
    return stopPromise;
  }

  return {
    available,
    // Starts the program hidden, so the next pop-out only loads the page.
    warm() {
      if (!available() || disposed) return;
      try { Promise.resolve(start()).catch(() => {}); }
      catch (error) { lastError = String(error?.message || error); }
    },
    async open({ playback, storage, origin, clientId = null, clientSequence = null }) {
      const clean = cleanPlayback(playback);
      if (!clean) throw Object.assign(new Error("Only Library videos can play in the pop-up"), { status: 400 });
      // A tab can switch A -> B while its first HTTP open is still awaiting
      // WebView2 startup. Compare the originating tab's serial even when the
      // older HTTP request arrives out of order at the server.
      const owner = typeof clientId === "string" && /^[a-f0-9-]{36}$/i.test(clientId) ? clientId : null;
      const sequence = Number.isSafeInteger(clientSequence) && clientSequence > 0 ? clientSequence : null;
      if (owner && sequence !== null) {
        if (sequence <= (latestOpenByClient.get(owner) ?? 0))
          throw Object.assign(new Error("Stale pop-up open request"), { status: 409 });
        latestOpenByClient.set(owner, sequence);
        // No persistent identity: limit retained per-tab serials to active use.
        if (latestOpenByClient.size > 64) {
          for (const key of latestOpenByClient.keys()) {
            if (key !== owner) { latestOpenByClient.delete(key); break; }
          }
        }
      }
      const generation = ++openGeneration;
      const proc = await start();
      if (disposed || stoppingChild || child !== proc)
        throw Object.assign(new Error("The pop-up player is shutting down"), { status: 503 });
      if (generation !== openGeneration || owner && latestOpenByClient.get(owner) !== sequence)
        throw Object.assign(new Error("Stale pop-up open request"), { status: 409 });
      clearTimeout(hideWatch);
      hideWatch = null;
      const token = crypto.randomBytes(24).toString("base64url");
      handoff = { id: crypto.randomUUID(), token, playback: clean, storage: cleanStorage(storage), createdAt: now(), report: null };
      finished = null;
      const url = `${origin}/watch?popup=${token}`;
      if (!send({ op: "show", url, bounds: readBounds() })) throw new Error("The pop-up player stopped");
      visible = true;
      return { id: handoff.id };
    },
    // The pop-up page reads what to play; the token is good while this handoff is current.
    handoff(token) {
      if (!handoff || typeof token !== "string" || !TOKEN.test(token) || token.length !== handoff.token.length
        || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(handoff.token))) return null;
      // Active playback renews its own short-lived token by reporting its
      // position; once finished or idle, the old authority cannot be revived.
      if (finished?.id === handoff.id || now() - (handoff.report?.at ?? handoff.createdAt) > HANDOFF_TTL_MS)
        return null;
      return { id: handoff.id, playback: handoff.playback, storage: handoff.storage };
    },
    // The pop-up page's position every second, and its last report (action: return, close, ended).
    report(token, input = {}) {
      if (!this.handoff(token)) return false;
      const previous = handoff.report || handoff.playback;
      handoff.report = {
        positionSeconds: Math.max(0, finite(input.positionSeconds, previous.positionSeconds)),
        paused: typeof input.paused === "boolean" ? input.paused : previous.paused,
        rate: validPopupRate(input.rate) ?? previous.rate,
        at: now(),
      };
      if (["return", "close", "ended"].includes(input.action)) {
        finish(input.action, handoff.report);
        hideWindow();
      }
      return true;
    },
    // LVL's window takes the video back (Return to Watch in LVL, or another video started there).
    close(expectedId) {
      // Caller identity is an exact handoff UUID. A late A take-back or
      // dismissal must never hide B, even after a second /open completed.
      if (!handoff || typeof expectedId !== "string" || handoff.id !== expectedId) return null;
      hideWindow();
      finish("return");
      return finished;
    },
    status() {
      return {
        available: available(), running: Boolean(child), visible,
        id: handoff?.id || null,
        position: handoff?.report?.positionSeconds ?? null,
        rate: handoff?.report?.rate ?? handoff?.playback.rate ?? null,
        result: finished && finished.id === handoff?.id ? finished : null,
        lastError,
      };
    },
    stop,
    async dispose() {
      disposed = true;
      handoff = null;
      return stop();
    },
  };
}

// /api/popup/*: local requests only (server.js checks the host and origin first).
// program: where the window program comes from (popup-program.js); it may still be downloading.
export function createPopupRoutes({ popup, program = null, port, json, readJsonBody, methodNotAllowed }) {
  const downloading = () => Boolean(program?.status?.().downloading);
  return async function handlePopupApi(req, res, url) {
    const route = url.pathname.slice("/api/popup/".length);
    const fail = (error) => json(res, Number(error.status) || 500, { error: error.message || "The pop-up player failed" });
    if (route === "status") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      json(res, 200, { ...popup.status(), downloading: downloading() });
      return true;
    }
    if (route === "handoff") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const found = popup.handoff(url.searchParams.get("token"));
      if (!found) json(res, 404, { error: "This pop-up link has expired" });
      else json(res, 200, found);
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (route === "warm") {
      // An installed LVL downloads the program the first time; then it starts hidden.
      const ready = program ? program.ensure() : Promise.resolve();
      void Promise.resolve(ready).then(() => popup.warm()).catch(() => {});
      json(res, 200, { available: popup.available(), downloading: downloading() });
      return true;
    }
    if (route === "open") {
      const input = await readJsonBody(req, 3 * 1024 * 1024);
      try { json(res, 200, await popup.open({
        playback: input.playback, storage: input.storage,
        clientId: input.clientId, clientSequence: input.clientSequence,
        origin: `http://127.0.0.1:${port}`,
      })); } catch (error) { fail(error); }
      return true;
    }
    if (route === "report") {
      const input = await readJsonBody(req, 4096);
      if (!popup.report(input.token, input)) json(res, 404, { error: "This pop-up link has expired" });
      else json(res, 200, { ok: true });
      return true;
    }
    if (route === "close") {
      const input = await readJsonBody(req, 1024);
      if (typeof input?.expectedId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.expectedId)) {
        json(res, 400, { error: "Expected pop-up handoff ID is required" });
        return true;
      }
      const result = popup.close(input.expectedId);
      json(res, 200, { matched: result !== null, result });
      return true;
    }
    json(res, 404, { error: "API route not found" });
    return true;
  };
}
