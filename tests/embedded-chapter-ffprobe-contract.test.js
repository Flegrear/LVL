import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import vm from "node:vm";
import { normalizeEmbeddedChapterMarkers } from "../shared/media/embedded-chapter-markers.js";

// Run the production FFprobe metadata parser against a fake child process.
// This exercises the *same* argument construction and JSON normalizer without
// spawning FFprobe, reading a torrent, or contacting a running LVL service.
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf("function runFfprobe(sourceUrl, file,");
const end = server.indexOf("\nasync function runFfprobeWithRetry(", start);
assert.ok(start >= 0 && end > start, "production FFprobe parser must be present");
const parser = server.slice(start, end);

function probeHarness(outputs) {
  const calls = [];
  const context = vm.createContext({
    ffprobePath: "synthetic-ffprobe",
    MEDIA_PROBE_TIMEOUT_MS: 3_000,
    MAX_PROBE_OUTPUT_BYTES: 128 * 1024,
    normalizeEmbeddedChapterMarkers,
    inspectMediaCompatibility: () => ({ checked: true }),
    dolbyVisionFromProbe: () => null,
    parseFrameRate: () => 24,
    setTimeout, clearTimeout, path,
    spawn(executable, args, options) {
      const current = calls.length;
      calls.push({ executable, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; };
      queueMicrotask(() => {
        const raw = JSON.stringify(outputs[current] ?? { format: { duration: "1440" }, streams: [] });
        child.stdout.emit("data", Buffer.from(raw));
        child.emit("close", 0);
      });
      return child;
    },
  });
  vm.runInContext(parser, context);
  return { calls, run: (url, file, options = { includeChapters: true }) => vm.runInContext("runFfprobe", context)(url, file, options) };
}

const mkvMetadata = (chapters, duration = 1440) => ({
  format: { format_name: "matroska,webm", duration: String(duration), bit_rate: "2500000" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "24/1" },
    { index: 1, codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "jpn" } },
    { index: 2, codec_type: "subtitle", codec_name: "ass", tags: { title: "English", language: "eng" } },
  ],
  chapters,
});
const chapter = (title, start, end) => ({
  start_time: String(start), end_time: String(end), tags: { title },
});

test("one selected MKV metadata probe includes chapters with normal codec tracks, no separate chapter fetch", async () => {
  const h = probeHarness([mkvMetadata([
    chapter("Private Scene One", 0, 60), chapter("OP", 60, 150),
    chapter("Private Scene Two", 150, 1280), chapter("ED", 1280, 1390),
    chapter("Private Ending", 1390, 1440),
  ])]);
  const url = "http://127.0.0.1:5000/api/torrents/session-a/files/7/stream";
  const media = await h.run(url, { name: "private-release.mkv" });
  assert.equal(h.calls.length, 1, "video, audio, subtitles and chapter markers share one FFprobe");
  assert.equal(h.calls[0].executable, "synthetic-ffprobe");
  assert.equal(h.calls[0].args.at(-1), url, "the selected file stream is the only input");
  assert.ok(h.calls[0].args.includes("-show_chapters"), "FFprobe must be instructed to emit chapters");
  const entryArg = h.calls[0].args[h.calls[0].args.indexOf("-show_entries") + 1];
  assert.match(entryArg, /chapter=start_time,end_time:chapter_tags=title/);
  assert.match(entryArg, /format=duration/);
  assert.match(entryArg, /stream_tags=language,title/);
  assert.equal(media.durationSeconds, 1440);
  assert.equal(media.durationMs, 1_440_000);
  assert.equal(media.video.codec, "h264");
  assert.equal(media.audioTracks[0].codec, "aac");
  assert.equal(media.subtitleTracks[0].codec, "ass");
  assert.deepEqual(JSON.parse(JSON.stringify(media.embeddedSkipMarkers)), {
    intro: { start_ms: 60_000, end_ms: 150_000, match: "exact", confidence: 1, source: "embedded-chapter" },
    outro: { start_ms: 1_280_000, end_ms: 1_390_000, match: "exact", confidence: 1, source: "embedded-chapter" },
  });
  assert.equal(media.chapters, undefined, "private chapter titles are not exposed in local API responses");
  assert.doesNotMatch(JSON.stringify(media), /Private Scene One|Private Scene Two|Private Ending/);
});

test("Opus chapter scans are disabled for incomplete files, preserving original codec startup probe", async () => {
  const h = probeHarness([mkvMetadata([chapter("OP", 60, 150)])]);
  const media = await h.run("http://127.0.0.1:5000/api/torrents/session-a/files/1/stream",
    { name: "incomplete.mkv" }, { includeChapters: false });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.includes("-show_chapters"), false);
  assert.doesNotMatch(h.calls[0].args[h.calls[0].args.indexOf("-show_entries") + 1], /chapter=/);
  assert.equal(media.video.codec, "h264");
  assert.match(server, /const includeChapters = isTorrentFileFullyVerified\(session\.torrent, fileIndex\)/,
    "real startup route must not treat a partially downloaded file as safe for optional chapter scanning");
});

test("two file indices are probed independently; absent/ambiguous chapter data never leaks", async () => {
  const h = probeHarness([
    mkvMetadata([chapter("Opening", 60, 150)], 1440),
    mkvMetadata([chapter("Opening", 60, 150), chapter("Intro", 150, 240)], 1800),
  ]);
  const first = await h.run("http://127.0.0.1:5000/api/torrents/session-a/files/2/stream", { name: "a.mkv" });
  const next = await h.run("http://127.0.0.1:5000/api/torrents/session-a/files/3/stream", { name: "b.mkv" });
  assert.equal(first.embeddedSkipMarkers.intro.end_ms, 150_000);
  assert.deepEqual(JSON.parse(JSON.stringify(next.embeddedSkipMarkers)), { intro: null, outro: null },
    "conflicting marker names on a second file must not inherit a first-file OP");
  assert.equal(next.durationSeconds, 1800);
  assert.equal(h.calls.length, 2, "each separately requested file gets its own single probe");
  assert.match(h.calls[0].args.at(-1), /files\/2\/stream$/);
  assert.match(h.calls[1].args.at(-1), /files\/3\/stream$/);
  assert.match(server, /probeCacheKey\(session\.id, fileIndex\)/, "metadata cache partitions selected file indices");
  assert.match(server, /\/api\/torrents\/\$\{encodeURIComponent\(session\.id\)\}\/files\/\$\{fileIndex\}\/stream/,
    "metadata fallback URL remains scoped to the selected session and file index");
});

test("malformed chapter metadata is non-fatal to the one-file media probe and never yields a guessed skip", async () => {
  const h = probeHarness([
    mkvMetadata([{ start_time: "120.000", tags: { title: "Opening" } }], 1440),
    mkvMetadata([], 1440),
  ]);
  const missingEnd = await h.run("http://127.0.0.1:5000/api/torrents/session-a/files/1/stream", { name: "bad-chapter.mkv" });
  const noChapters = await h.run("http://127.0.0.1:5000/api/torrents/session-a/files/2/stream", { name: "no-chapters.mkv" });
  assert.deepEqual(JSON.parse(JSON.stringify(missingEnd.embeddedSkipMarkers)), { intro: null, outro: null });
  assert.deepEqual(JSON.parse(JSON.stringify(noChapters.embeddedSkipMarkers)), { intro: null, outro: null });
  assert.equal(missingEnd.video.codec, "h264", "invalid chapters must not disable otherwise valid playback");
  assert.equal(noChapters.subtitleTracks.length, 1, "missing chapters do not affect subtitle probing");
  assert.equal(h.calls.length, 2);
});
