import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { createClipStore } from "../learning/clips.js";

const DAY_MS = 86_400_000;

function duration(file) {
  const result = spawnSync(ffprobe.path, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr));
  return Number(String(result.stdout).trim());
}

test("existing clip rows gain language and video metadata without losing their media records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-clips-migration-"));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE clips (id TEXT PRIMARY KEY, kind TEXT NOT NULL, library_id TEXT NOT NULL, file_index INTEGER NOT NULL,
      audio INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, lang TEXT NOT NULL,
      text TEXT NOT NULL, base_text TEXT NOT NULL, series TEXT NOT NULL, chapter TEXT NOT NULL,
      has_image INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL)`);
    const id = "a".repeat(24);
    db.prepare("INSERT INTO clips VALUES (?, 'card', 'library', 0, 0, 1000, 2000, 'JA', 'hello', 'translation', 'Show', 'E01', 1, 1234, 1, 1)").run(id);
    const store = createClipStore({ db, root: directory, ffmpegPath, sourceUrl: () => "" });
    assert.equal(store.get(id).baseText, "translation");
    assert.equal(store.get(id).baseLang, "");
    assert.equal(store.get(id).videoUrl, "");
    assert.equal(store.get(id).imageUrl, `/api/clips/${id}/image`);
    assert.deepEqual(store.stats().card, { count: 1, bytes: 1234 });
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a line's audio and still frame are cut, reused, listed, and cleaned up by the budget", { timeout: 60_000 }, async (t) => {
  if (!ffmpegPath) {
    t.skip("bundled FFmpeg is not available");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-clips-test-"));
  const source = path.join(directory, "source.mp4");
  const made = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ], { windowsHide: true });
  assert.equal(made.status, 0, String(made.stderr || ""));
  const db = new DatabaseSync(path.join(directory, "app.sqlite3"));
  const store = createClipStore({ db, root: path.join(directory, "clips"), ffmpegPath, sourceUrl: () => source });
  const line = { sessionId: "session", libraryId: "a".repeat(40), fileIndex: 0, audio: 0, lang: "ja", baseLang: "en", text: "こんにちは", baseText: "Hello", series: "Show", chapter: "S01E01" };
  try {
    const card = await store.create({ ...line, startMs: 2000, endMs: 4000, kind: "card" });
    assert.match(card.id, /^[a-f0-9]{24}$/);
    assert.equal(card.kind, "card");
    assert.equal(card.lang, "JA");
    assert.equal(card.baseLang, "EN", "listening quizzes retain the translation's language");
    assert.equal(card.audioUrl, `/api/clips/${card.id}/audio?v=2`);
    assert.equal(card.imageUrl, `/api/clips/${card.id}/image`, "a still frame was saved");
    assert.equal(card.videoUrl, `/api/clips/${card.id}/video?v=2`, "card playback has an offline video");
    const savedVideo = store.file(card.id, "video");
    assert.equal(savedVideo.type, "video/mp4");
    assert.ok(savedVideo.bytes > 1000);
    assert.ok(Math.abs(duration(savedVideo.file) - 2) < 0.06, "video contains exactly the selected two seconds");
    const audio = store.file(card.id, "audio");
    assert.equal(audio.type, "audio/mp4");
    assert.ok(audio.bytes > 1000, `audio is ${audio.bytes} bytes`);
    assert.ok(Math.abs(duration(audio.file) - 2) < 0.06, "audio contains exactly the selected two seconds");
    const image = store.file(card.id, "image");
    assert.equal(image.type, "image/jpeg");
    assert.ok(image.bytes > 500, `image is ${image.bytes} bytes`);

    // The same line again is not cut twice, and a card clip stays a card clip.
    const again = await store.create({ ...line, startMs: 2000, endMs: 4000, kind: "dictation" });
    assert.equal(again.id, card.id);
    assert.equal(again.kind, "card");

    const other = await store.create({ ...line, startMs: 6000, endMs: 8000, kind: "dictation", text: "元気？" });
    assert.equal(other.kind, "dictation");
    assert.equal(other.videoUrl, "", "dictation keeps its smaller audio/frame storage");
    assert.deepEqual(store.list({ lang: "JA" }).map((clip) => clip.text), ["こんにちは", "元気？"], "listed in time order");
    assert.equal(store.list({ kind: "dictation" }).length, 1);
    assert.deepEqual(Object.keys(store.stats()).sort(), ["card", "dictation"]);

    await assert.rejects(store.create({ ...line, startMs: 0, endMs: 20_000 }), /must be/);
    await assert.rejects(store.create({ ...line, startMs: 1000, endMs: 1100 }), /must be/);
    assert.equal(store.get("not-an-id"), null);

    // A clip a card still points at stays; one no card points at becomes a dictation clip after a
    // day, and dictation clips over the budget go, least recently used first.
    assert.deepEqual(store.collectGarbage([card.id], { now: Date.now() + 2 * DAY_MS }), { demoted: 0, removed: 0 });
    // One byte budget for everything: over it, dictation lines go first, then card lines.
    const total = store.list().reduce((sum, clip) => sum + ["audio", "image", "video"].reduce((bytes, kind) => bytes + (store.file(clip.id, kind)?.bytes || 0), 0), 0);
    assert.equal(Object.values(store.stats()).reduce((sum, kind) => sum + kind.bytes, 0), total);
    assert.deepEqual(store.collectGarbage([card.id], { maxBytes: total - 1 }), { demoted: 0, removed: 1 });
    assert.deepEqual(store.list().map((clip) => clip.id), [card.id], "the dictation line went, the card's stayed");
    assert.deepEqual(store.collectGarbage([card.id], { maxBytes: 1 }), { demoted: 0, removed: 1 }, "a card line goes too when cards alone are over");
    assert.equal(store.list().length, 0);
    // Rebuild two clips for the count and grace rules.
    const again2 = await store.create({ ...line, startMs: 2000, endMs: 4000, kind: "card" });
    const other2 = await store.create({ ...line, startMs: 6000, endMs: 8000, kind: "dictation", text: "元気？" });
    assert.deepEqual(store.collectGarbage([], { now: Date.now() + 2 * DAY_MS, maxDictation: 1 }), { demoted: 1, removed: 1 });
    const left = store.list();
    assert.equal(left.length, 1);
    assert.equal(left[0].id, other2.id, "the most recently used clip is kept");
    assert.equal(store.file(again2.id, "audio"), null, "removed clips' files are gone");
    assert.equal(fs.existsSync(savedVideo.file), false, "removed clips' videos are gone");
    assert.equal(store.remove(other2.id), true);
    assert.equal(store.list().length, 0);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent requests share a cut, and an audio-only saved line can gain a bounded video", { timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-clips-promotion-"));
  const db = new DatabaseSync(":memory:");
  let server;
  try {
    const source = path.join(directory, "source.mp4");
    const made = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=20", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source], { windowsHide: true });
    assert.equal(made.status, 0, String(made.stderr));
    let requests = 0;
    const bytes = fs.readFileSync(source);
    server = http.createServer((req, res) => {
      requests += 1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      res.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}) });
      res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const stream = `http://127.0.0.1:${server.address().port}/source.mp4`;
    const store = createClipStore({ db, root: path.join(directory, "clips"), ffmpegPath, sourceUrl: () => stream });
    const line = { sessionId: "test", libraryId: "b".repeat(40), fileIndex: 0, startMs: 1000, endMs: 2500, kind: "dictation", lang: "JA" };
    const results = await Promise.allSettled([store.create(line), store.create(line)]);
    assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results.map(result => result.reason?.message)));
    const saved = results[0].value;
    assert.equal(saved.videoUrl, "");
    const upgraded = await store.create({ ...line, kind: "card" });
    assert.equal(upgraded.id, saved.id);
    assert.equal(upgraded.createdAt, saved.createdAt);
    assert.ok(upgraded.videoUrl, "a card request upgrades saved audio to video");
    assert.ok(Math.abs(duration(store.file(saved.id, "video").file) - 1.5) < 0.06);
    assert.equal(store.list().length, 1);
    assert.ok(requests >= 3, "media was cut from an HTTP range stream rather than a local file");
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("older padded media is trimmed offline once, and failed trimming preserves the saved files", { timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-clips-legacy-"));
  const db = new DatabaseSync(":memory:");
  try {
    const source = path.join(directory, "source.mp4");
    assert.equal(spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=20", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source], { windowsHide: true }).status, 0);
    const root = path.join(directory, "clips");
    let originalAvailable = true;
    const store = createClipStore({ db, root, ffmpegPath, sourceUrl: () => { assert.ok(originalAvailable, "legacy preparation must not need the torrent"); return source; } });
    const saved = await store.create({ sessionId: "test", libraryId: "c".repeat(40), fileIndex: 0, startMs: 2000, endMs: 4000, kind: "card" });
    const audio = store.file(saved.id, "audio").file;
    const video = store.file(saved.id, "video").file;
    for (const file of [audio, video]) {
      const made = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1.750", "-i", source, "-t", "2.600", ...(file === audio ? ["-vn", "-c:a", "aac"] : ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]), file], { windowsHide: true });
      assert.equal(made.status, 0, String(made.stderr));
      assert.ok(duration(file) > 2.5);
    }
    db.prepare("UPDATE clips SET media_version = 1 WHERE id = ?").run(saved.id);
    originalAvailable = false;
    const originalAudio = fs.readFileSync(audio);
    const originalVideo = fs.readFileSync(video);
    const rename = fs.renameSync;
    let failed = false;
    fs.renameSync = (from, to) => {
      if (!failed && to === video) { failed = true; throw Object.assign(new Error("file is temporarily locked"), { code: "EPERM" }); }
      return rename(from, to);
    };
    try { await assert.rejects(store.prepare(saved.id), /temporarily locked/); } finally { fs.renameSync = rename; }
    assert.deepEqual(fs.readFileSync(audio), originalAudio, "a replacement failure restores the original padded audio");
    assert.deepEqual(fs.readFileSync(video), originalVideo);
    assert.equal(store.get(saved.id).mediaVersion, 1);
    const copy = fs.copyFileSync;
    let restoreFailed = false;
    failed = false;
    fs.renameSync = (from, to) => {
      if (!failed && to === video) { failed = true; throw Object.assign(new Error("file is temporarily locked"), { code: "EPERM" }); }
      return rename(from, to);
    };
    fs.copyFileSync = (from, to) => {
      if (!restoreFailed && from.includes(".previous.") && to === audio) { restoreFailed = true; throw new Error("restoration is temporarily blocked"); }
      return copy(from, to);
    };
    try { await assert.rejects(store.prepare(saved.id), /temporarily locked/); } finally { fs.renameSync = rename; fs.copyFileSync = copy; }
    assert.ok(fs.existsSync(path.join(root, `${saved.id}.previous.m4a`)), "an unsuccessful restoration keeps the original");
    const prepared = await store.prepare(saved.id);
    assert.equal(prepared.mediaVersion, 2);
    assert.equal(prepared.createdAt, saved.createdAt);
    assert.equal(prepared.startMs, 2000);
    assert.equal(prepared.endMs, 4000);
    assert.ok(Math.abs(duration(audio) - 2) < 0.06);
    assert.ok(Math.abs(duration(video) - 2) < 0.06);
    const before = fs.readFileSync(audio);
    await store.prepare(saved.id);
    assert.deepEqual(fs.readFileSync(audio), before, "a second preparation does not trim the line again");

    db.prepare("UPDATE clips SET media_version = 1 WHERE id = ?").run(saved.id);
    fs.writeFileSync(video, "invalid cached video");
    await assert.rejects(store.prepare(saved.id));
    assert.deepEqual(fs.readFileSync(audio), before, "a failed video trim leaves the audio intact");
    assert.equal(fs.readFileSync(video, "utf8"), "invalid cached video");
    assert.equal(store.get(saved.id).mediaVersion, 1);
    assert.ok(!fs.readdirSync(root).some(name => name.includes(".work")), "temporary files are cleaned up");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
