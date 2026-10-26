// clips.js: short extracts of watched episodes, kept in <data>/clips so cards and dictation keep
// working after the torrent is gone (a torrent's downloaded pieces are deleted when its session
// ends). Each clip is one subtitle line: audio, a still frame, and (for cards) a short MP4, cut with
// FFmpeg from the stretch that already played (so nothing extra is downloaded).
// - "card" clips belong to a card and stay as long as the card exists;
// - "dictation" clips are kept up to a budget (count and bytes), least recently used go first.
// Node only (server.js).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const MAX_CLIP_MS = 15_000;
const MIN_CLIP_MS = 300;
const LEGACY_PAD_BEFORE_MS = 250;
const MEDIA_VERSION = 2;
const JOB_TIMEOUT_MS = 45_000;

export function clipId({ libraryId, fileIndex, audio = 0, startMs, endMs }) {
  return crypto.createHash("sha1").update(`${libraryId}:${fileIndex}:${audio}:${Math.round(startMs)}:${Math.round(endMs)}`).digest("hex").slice(0, 24);
}

function runFfmpeg(ffmpegPath, args, timeoutMs = JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Cutting the clip took too long")); }, timeoutMs);
    timer.unref?.();
    child.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split("\n").pop() || `FFmpeg exited with ${code}`));
    });
  });
}

export function createClipStore({ db, root, ffmpegPath, sourceUrl }) {
  fs.mkdirSync(root, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, library_id TEXT NOT NULL, file_index INTEGER NOT NULL,
      audio INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, lang TEXT NOT NULL,
      text TEXT NOT NULL, base_text TEXT NOT NULL, series TEXT NOT NULL, chapter TEXT NOT NULL,
      has_image INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS clips_by_source ON clips (library_id, file_index);
    CREATE INDEX IF NOT EXISTS clips_by_kind ON clips (kind, lang, used_at);
  `);
  // Earlier clips stored translation text without its language. Keep those rows intact;
  // the client can recover the language from a matching card when one exists.
  const columns = new Set(db.prepare("PRAGMA table_info(clips)").all().map((column) => column.name));
  for (const [name, definition] of [["base_lang", "TEXT NOT NULL DEFAULT ''"], ["has_video", "INTEGER NOT NULL DEFAULT 0"], ["media_version", "INTEGER NOT NULL DEFAULT 1"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE clips ADD COLUMN ${name} ${definition}`);
  }
  const statements = {
    get: db.prepare("SELECT * FROM clips WHERE id = ?"),
    insert: db.prepare(`INSERT INTO clips (id, kind, library_id, file_index, audio, start_ms, end_ms, lang, text, base_text, series, chapter, has_image, bytes, created_at, used_at, base_lang, has_video, media_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    media: db.prepare("UPDATE clips SET has_image = ?, has_video = ?, bytes = ?, media_version = ?, used_at = ? WHERE id = ?"),
    translate: db.prepare("UPDATE clips SET base_text = ?, base_lang = ? WHERE id = ?"),
    promote: db.prepare("UPDATE clips SET kind = 'card', used_at = ? WHERE id = ?"),
    touch: db.prepare("UPDATE clips SET used_at = ? WHERE id = ?"),
    remove: db.prepare("DELETE FROM clips WHERE id = ?"),
    demote: db.prepare("UPDATE clips SET kind = 'dictation' WHERE id = ?"),
    cardClips: db.prepare("SELECT id, created_at FROM clips WHERE kind = 'card'"),
    cardByAge: db.prepare("SELECT id, bytes FROM clips WHERE kind = 'card' ORDER BY used_at ASC"),
    dictation: db.prepare("SELECT id, bytes FROM clips WHERE kind = 'dictation' ORDER BY used_at DESC"),
    totals: db.prepare("SELECT kind, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM clips GROUP BY kind"),
  };
  const queue = [];
  const pendingJobs = new Map();
  let running = false;

  const filesFor = (id) => ({ audio: path.join(root, `${id}.m4a`), image: path.join(root, `${id}.jpg`), video: path.join(root, `${id}.mp4`) });
  function recoverMedia(id) {
    const row = statements.get.get(id);
    const files = filesFor(id);
    const backups = filesFor(`${id}.previous`);
    // Copy every original before deleting any backup; a failed recovery stays retryable.
    for (const kind of Object.keys(files)) {
      if (row && row.media_version < MEDIA_VERSION && fs.existsSync(backups[kind])) fs.copyFileSync(backups[kind], files[kind]);
    }
    for (const file of Object.values(backups)) fs.rmSync(file, { force: true });
  }
  // Recover originals if a previous process stopped between replacing legacy files and
  // updating their version. A successful migration only needs its leftover backups removed.
  for (const name of fs.readdirSync(root)) {
    const match = /^([a-f0-9]{24})\.previous\.(m4a|jpg|mp4)$/.exec(name);
    if (!match) continue;
    recoverMedia(match[1]);
  }
  const record = (row) => row && ({
    id: row.id,
    kind: row.kind,
    libraryId: row.library_id,
    fileIndex: row.file_index,
    audio: row.audio,
    startMs: row.start_ms,
    endMs: row.end_ms,
    lang: row.lang,
    text: row.text,
    baseText: row.base_text,
    baseLang: row.base_lang || "",
    series: row.series,
    chapter: row.chapter,
    mediaVersion: row.media_version,
    audioUrl: `/api/clips/${row.id}/audio?v=${row.media_version}`,
    imageUrl: row.has_image ? `/api/clips/${row.id}/image` : "",
    videoUrl: row.has_video ? `/api/clips/${row.id}/video?v=${row.media_version}` : "",
    createdAt: row.created_at,
  });

  const fileSize = (file) => fs.existsSync(file) ? fs.statSync(file).size : 0;
  function updateMedia(id) {
    const files = filesFor(id);
    const hasImage = fileSize(files.image) > 0;
    const hasVideo = fileSize(files.video) > 256;
    const bytes = fileSize(files.audio) + fileSize(files.image) + fileSize(files.video);
    statements.media.run(Number(hasImage), Number(hasVideo), bytes, MEDIA_VERSION, Date.now(), id);
  }

  function replaceMedia(id, temporary, commit) {
    const files = filesFor(id);
    const backups = filesFor(`${id}.previous`);
    const changes = Object.keys(files).filter(kind => fileSize(temporary[kind]) > 0);
    const originals = new Set();
    const installed = [];
    let safeToClean = true;
    try {
      for (const kind of changes) {
        if (fs.existsSync(files[kind])) { fs.copyFileSync(files[kind], backups[kind]); originals.add(kind); }
      }
      for (const kind of changes) { fs.renameSync(temporary[kind], files[kind]); installed.push(kind); }
      commit();
    } catch (error) {
      for (const kind of installed) {
        try {
          if (originals.has(kind)) fs.copyFileSync(backups[kind], files[kind]);
          else fs.rmSync(files[kind], { force: true });
        } catch { safeToClean = false; } // Keep originals for recovery on the next startup.
      }
      throw error;
    } finally {
      if (safeToClean) for (const file of Object.values(backups)) fs.rmSync(file, { force: true });
    }
  }

  async function normalizeLegacy(row) {
    recoverMedia(row.id);
    if (row.media_version >= MEDIA_VERSION) return;
    const files = filesFor(row.id);
    const temporary = filesFor(`${row.id}.work`);
    const from = Math.min(row.start_ms, LEGACY_PAD_BEFORE_MS) / 1000;
    const seconds = (row.end_ms - row.start_ms) / 1000;
    const head = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", from.toFixed(3)];
    try {
      // Trim cached files, so older cards still work without their original torrent.
      if (fileSize(files.audio)) {
        await runFfmpeg(ffmpegPath, [...head, "-i", files.audio, "-t", seconds.toFixed(3), "-vn", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", temporary.audio]);
      }
      if (row.has_video && fileSize(files.video)) {
        await runFfmpeg(ffmpegPath, [...head, "-i", files.video, "-t", seconds.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", temporary.video]);
      }
      replaceMedia(row.id, temporary, () => updateMedia(row.id));
    } finally {
      for (const file of Object.values(temporary)) fs.rmSync(file, { force: true });
    }
  }

  async function cut(job) {
    const { id, sessionId, fileIndex, audio, startMs, endMs } = job;
    const files = filesFor(id);
    const temporary = filesFor(`${id}.work`);
    const existing = statements.get.get(id);
    if (existing) await normalizeLegacy(existing);
    const from = startMs / 1000;
    const seconds = (endMs - startMs) / 1000;
    const source = sourceUrl(sessionId, fileIndex);
    const network = /^https?:/i.test(source) ? ["-rw_timeout", "20000000"] : [];
    const head = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...network];
    if (!existing || fileSize(files.audio) < 256) {
      await runFfmpeg(ffmpegPath, [...head, "-ss", from.toFixed(3), "-i", source, "-t", seconds.toFixed(3), "-map", `0:a:${audio}`, "-vn", "-sn", "-dn", "-ac", "2", "-ar", "44100", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", temporary.audio]);
    }
    if (!existing || !fileSize(files.image)) try {
      // The frame from the middle of the line.
      const stillAt = (startMs + (endMs - startMs) / 2) / 1000;
      await runFfmpeg(ffmpegPath, [...head, "-ss", stillAt.toFixed(3), "-i", source, "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", temporary.image], 30_000);
    } catch {
      fs.rmSync(temporary.image, { force: true });
    }
    if (job.kind === "card" && (!existing || !fileSize(files.video))) {
      try {
        await runFfmpeg(ffmpegPath, [...head, "-ss", from.toFixed(3), "-i", source, "-t", seconds.toFixed(3),
          "-map", "0:v:0", "-map", `0:a:${audio}`, "-sn", "-dn", "-vf", "scale='min(854,iw)':-2",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-ac", "2",
          "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", temporary.video]);
      } catch {
        // An audio-only source still gives a useful saved line.
        fs.rmSync(temporary.video, { force: true });
      }
    }
    if (fileSize(temporary.audio) < 256 && fileSize(files.audio) < 256) throw new Error("No audio was cut for this line");
    const now = Date.now();
    replaceMedia(id, temporary, () => {
      if (!existing) statements.insert.run(id, job.kind, job.libraryId, fileIndex, audio, startMs, endMs, job.lang, job.text, job.baseText, job.series, job.chapter, 0, 0, now, now, job.baseLang, 0, MEDIA_VERSION);
      else if (job.kind === "card") statements.promote.run(now, id);
      if (job.baseText && job.baseLang) statements.translate.run(job.baseText, job.baseLang, id);
      updateMedia(id);
    });
    return record(statements.get.get(id));
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          const result = job.normalize ? (await normalizeLegacy(statements.get.get(job.id)), get(job.id)) : await cut(job);
          pendingJobs.delete(job.id);
          job.resolve(result);
        } catch (error) {
          for (const file of Object.values(filesFor(`${job.id}.work`))) fs.rmSync(file, { force: true });
          pendingJobs.delete(job.id);
          job.reject(error);
        }
      }
    } finally {
      running = false;
    }
  }

  function enqueue(job) {
    if (queue.length >= 24) return Promise.reject(Object.assign(new Error("Clip queue is full; try again shortly"), { statusCode: 429 }));
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    pendingJobs.set(job.id, job);
    queue.push(job);
    void drain();
    return job.promise;
  }

  async function prepare(id) {
    const row = statements.get.get(String(id));
    if (!row) return null;
    const pending = pendingJobs.get(row.id);
    if (pending) return pending.promise;
    recoverMedia(row.id);
    if (row.media_version >= MEDIA_VERSION) return record(row);
    return enqueue({ id: row.id, normalize: true });
  }

  /**
   * Cuts (or returns) the clip of one line. input: { sessionId, libraryId, fileIndex, audio,
   * startMs, endMs (video time), kind: "card" | "dictation", lang, text, baseText, series, chapter }.
   */
  function create(input) {
    const startMs = Math.round(Number(input.startMs));
    const endMs = Math.round(Number(input.endMs));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs - startMs < MIN_CLIP_MS || endMs - startMs > MAX_CLIP_MS) {
      return Promise.reject(Object.assign(new Error(`A clip must be ${MIN_CLIP_MS} ms to ${MAX_CLIP_MS / 1000} s long`), { statusCode: 400 }));
    }
    const job = {
      sessionId: String(input.sessionId),
      libraryId: String(input.libraryId).toLowerCase(),
      fileIndex: Math.trunc(Number(input.fileIndex)),
      audio: Math.max(0, Math.trunc(Number(input.audio) || 0)),
      startMs,
      endMs,
      kind: input.kind === "card" ? "card" : "dictation",
      lang: String(input.lang || "").toUpperCase().slice(0, 8),
      text: String(input.text || "").slice(0, 600),
      baseText: String(input.baseText || "").slice(0, 600),
      baseLang: String(input.baseLang || "").toUpperCase().slice(0, 8),
      series: String(input.series || "").slice(0, 200),
      chapter: String(input.chapter || "").slice(0, 40),
    };
    job.id = clipId(job);
    const pending = pendingJobs.get(job.id);
    if (pending) {
      if (pending.normalize || (job.kind === "card" && pending.kind !== "card")) return pending.promise.then(() => create(input));
      return pending.promise;
    }
    const existing = statements.get.get(job.id);
    if (existing && fs.existsSync(filesFor(job.id).audio) && (job.kind !== "card" || fileSize(filesFor(job.id).video) > 256)) {
      if (job.baseText && job.baseLang) statements.translate.run(job.baseText, job.baseLang, job.id);
      if (job.kind === "card" && existing.kind !== "card") statements.promote.run(Date.now(), job.id);
      else statements.touch.run(Date.now(), job.id);
      return prepare(job.id);
    }
    return enqueue(job);
  }

  function get(id) {
    return /^[a-f0-9]{24}$/.test(String(id)) ? record(statements.get.get(String(id))) : null;
  }

  function file(id, kind) {
    const row = get(id);
    if (!row) return null;
    if (!["audio", "image", "video"].includes(kind)) return null;
    const target = filesFor(row.id)[kind];
    if (!fs.existsSync(target)) return null;
    statements.touch.run(Date.now(), row.id);
    return { file: target, type: kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : "audio/mp4", bytes: fs.statSync(target).size };
  }

  function list({ kind = "", lang = "", libraryId = "", fileIndex = null, limit = 400 } = {}) {
    const clauses = [];
    const values = [];
    if (kind) { clauses.push("kind = ?"); values.push(kind); }
    if (lang) { clauses.push("lang = ?"); values.push(String(lang).toUpperCase()); }
    if (libraryId) { clauses.push("library_id = ?"); values.push(String(libraryId).toLowerCase()); }
    if (fileIndex !== null && fileIndex !== undefined && fileIndex !== "") { clauses.push("file_index = ?"); values.push(Math.trunc(Number(fileIndex))); }
    const sql = `SELECT * FROM clips${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY library_id, file_index, start_ms LIMIT ?`;
    return db.prepare(sql).all(...values, Math.max(1, Math.min(5000, Number(limit) || 400))).map(record);
  }

  function remove(id) {
    const row = get(id);
    if (!row) return false;
    for (const target of Object.values(filesFor(row.id))) fs.rmSync(target, { force: true });
    statements.remove.run(row.id);
    return true;
  }

  /**
   * Housekeeping, within one byte budget for all saved lines:
   * 1. card clips no card points at any more become dictation clips (after a day, so an undo or a
   *    re-import still finds them);
   * 2. dictation clips are kept newest-used first while they fit next to the card clips;
   * 3. if card clips alone are over the budget, the least recently used go too (the card keeps
   *    its text, and its line is cut again the next time the episode plays).
   */
  function collectGarbage(referencedIds, { maxDictation = Infinity, maxBytes = 2 * 1024 ** 3, graceMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
    const referenced = new Set(referencedIds || []);
    let demoted = 0;
    let removed = 0;
    for (const row of statements.cardClips.all()) {
      if (pendingJobs.has(row.id)) continue;
      if (!referenced.has(row.id) && now - row.created_at > graceMs) {
        statements.demote.run(row.id);
        demoted += 1;
      }
    }
    const cards = statements.cardByAge.all();
    let cardBytes = cards.reduce((sum, row) => sum + row.bytes, 0);
    let count = 0;
    let bytes = cardBytes;
    for (const row of statements.dictation.all()) {
      count += 1;
      bytes += row.bytes;
      if ((count > maxDictation || bytes > maxBytes) && !pendingJobs.has(row.id)) {
        remove(row.id);
        removed += 1;
        bytes -= row.bytes;
      }
    }
    for (const row of cards) {
      if (cardBytes <= maxBytes) break;
      if (pendingJobs.has(row.id)) continue;
      remove(row.id);
      removed += 1;
      cardBytes -= row.bytes;
    }
    return { demoted, removed };
  }

  function stats() {
    return Object.fromEntries(statements.totals.all().map((row) => [row.kind, { count: row.count, bytes: row.bytes }]));
  }

  return { create, prepare, get, file, list, remove, collectGarbage, stats };
}
