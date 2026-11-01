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

  const where = () => (resolveHome ? resolveHome() : home);
  const available = () => Boolean(where() && platform === "win32" && !broken);

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
      paused: fields.paused ?? last.paused ?? handoff.playback.paused, at: now(),
    };
  }

  function start() {
    if (ready) return ready;
    if (!available()) return Promise.reject(Object.assign(new Error("The pop-up player isn't installed"), { status: 503 }));
    fs.mkdirSync(profileDir, { recursive: true });
    const proc = spawnImpl(path.join(where(), "LVL-Popup.exe"), ["--profile", profileDir], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    started = false;
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("The pop-up player didn't start")); stop(); }, START_TIMEOUT_MS);
      proc.on("error", (error) => { clearTimeout(timer); lastError = error.message; broken = true; reject(error); });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (child === proc) { child = null; ready = null; }
        if (visible) { visible = false; finish("close"); }
        reject(new Error(`The pop-up player stopped${code ? ` (exit ${code})` : ""}`));
      });
      proc.stderr?.on("data", () => {});
      readline.createInterface({ input: proc.stdout }).on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.event === "ready") { started = true; clearTimeout(timer); resolve(); }
        else if (event.event === "error") {
          lastError = String(event.message || "").slice(0, 300);
          log.warn?.("Pop-up player:", lastError);
          // Before it is ready (no WebView2 runtime): the browser's own pop-up from now on.
          if (!started) {
            broken = true;
            clearTimeout(timer);
            reject(new Error(lastError || "The pop-up player couldn't start"));
            stop();
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
    send({ op: "hide" });
    clearTimeout(hideWatch);
    hideWatch = setTimeout(() => {
      if (!windowShown || !child) return;
      log.warn?.("Pop-up player: the window didn't confirm it closed; stopping it");
      stop();
    }, 3000);
    hideWatch.unref?.();
  }

  function stop() {
    const proc = child;
    child = null;
    ready = null;
    visible = false;
    windowShown = false;
    clearTimeout(hideWatch);
    if (!proc) return;
    try { proc.stdin.end(); } catch {}
    const kill = setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
    kill.unref?.();
  }

  return {
    available,
    // Starts the program hidden, so the next pop-out only loads the page.
    warm() { if (available()) start().catch(() => {}); },
    async open({ playback, storage, origin }) {
      const clean = cleanPlayback(playback);
      if (!clean) throw Object.assign(new Error("Only Library videos can play in the pop-up"), { status: 400 });
      await start();
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
      if (!handoff.report && now() - handoff.createdAt > HANDOFF_TTL_MS) return null;
      return { id: handoff.id, playback: handoff.playback, storage: handoff.storage };
    },
    // The pop-up page's position every second, and its last report (action: return, close, ended).
    report(token, input = {}) {
      if (!this.handoff(token)) return false;
      handoff.report = { positionSeconds: Math.max(0, finite(input.positionSeconds)), paused: Boolean(input.paused), at: now() };
      if (["return", "close", "ended"].includes(input.action)) {
        finish(input.action, handoff.report);
        hideWindow();
      }
      return true;
    },
    // LVL's window takes the video back (Return to Watch in LVL, or another video started there).
    close() {
      if (!handoff) return null;
      hideWindow();
      finish("return");
      return finished;
    },
    status() {
      return {
        available: available(), running: Boolean(child), visible,
        id: handoff?.id || null,
        position: handoff?.report?.positionSeconds ?? null,
        result: finished && finished.id === handoff?.id ? finished : null,
        lastError,
      };
    },
    stop,
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
      try { json(res, 200, await popup.open({ playback: input.playback, storage: input.storage, origin: `http://127.0.0.1:${port}` })); } catch (error) { fail(error); }
      return true;
    }
    if (route === "report") {
      const input = await readJsonBody(req, 4096);
      if (!popup.report(input.token, input)) json(res, 404, { error: "This pop-up link has expired" });
      else json(res, 200, { ok: true });
      return true;
    }
    if (route === "close") {
      await readJsonBody(req, 1024);
      json(res, 200, { result: popup.close() });
      return true;
    }
    json(res, 404, { error: "API route not found" });
    return true;
  };
}
