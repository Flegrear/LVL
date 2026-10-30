// Temporary, opt-in memory-only playback measurements. Never store URLs, filenames,
// magnets, hashes or raw FFmpeg stderr. No overhead on untraced sessions.
const MAX_EVENTS = 160;
const MAX_TRACES = 3;
const TTL_MS = 15 * 60_000;
const enumValue = (value, choices) => typeof value === "string" && choices.includes(value) ? value : null;
const VIDEO_CODECS = ["h264", "hevc", "av1", "vp8", "vp9", "mpeg4", "mpeg2video", "mpeg1video", "vc1", "prores", "theora", "wmv3", "mjpeg"];
const VIDEO_REASONS = ["dolby-vision-profile-not-browser-verified", "seek-requires-reencode", "hevc-client-opt-in-required", "av1-client-opt-in-required", "source-video-not-safe-to-copy"];
const AUDIO_REASONS = ["metadata-unavailable", "original", "seek-timestamp-safety", "channel-downmix", "compatibility"];

export function parseFfmpegProgress(line) {
  const match = /^speed=\s*(\d+(?:\.\d+)?)x\s*$/.exec(String(line));
  return match ? Number(match[1]) : null;
}

export function createPlaybackTrace({ now = Date.now } = {}) {
  const traces = new Map();
  function find(id) {
    const entry = traces.get(id);
    if (entry && now() - entry.touched > TTL_MS) { traces.delete(id); return null; }
    return entry || null;
  }
  function event(id, type, fields = {}) {
    const trace = find(id);
    if (!trace) return;
    trace.touched = now();
    trace.events.push({ elapsedMs: now() - trace.started, type, ...fields });
    if (trace.events.length > MAX_EVENTS) trace.events.shift();
  }
  function start(id, fileIndex) {
    for (const key of traces.keys()) find(key);
    if (!find(id) && traces.size >= MAX_TRACES) traces.delete(traces.keys().next().value);
    traces.set(id, { started: now(), touched: now(), fileIndex, events: [], readers: new Map(), nextReader: 0, plan: null, speed: null, conversionId: 0 });
    event(id, "trace-started");
  }
  function reader(id, fileIndex, { start: offset = 0, end = null } = {}) {
    const trace = find(id);
    if (!trace || trace.fileIndex !== fileIndex) return { firstByte() {}, end() {} };
    const number = ++trace.nextReader;
    const started = now();
    trace.readers.set(number, { offset, end, started });
    event(id, "reader-start", { reader: number, offset, end, activeReaders: trace.readers.size });
    let first = false;
    return {
      firstByte() {
        if (first || find(id) !== trace) return;
        first = true;
        event(id, "reader-first-byte", { reader: number, ms: now() - started });
      },
      end(reason) {
        if (!trace.readers.delete(number)) return;
        if (find(id) !== trace) return;
        event(id, "reader-end", { reader: number, reason: ["complete", "cancel", "error"].includes(reason) ? reason : "closed", activeReaders: trace.readers.size });
      },
    };
  }
  function captureToken(id, fileIndex) {
    const trace = find(id);
    if (!trace || trace.fileIndex !== fileIndex) return null;
    trace.conversionId += 1;
    trace.speed = null;
    return { trace, conversionId: trace.conversionId };
  }
  const tokenCurrent = (trace, token) => !token || (token.trace === trace && token.conversionId === trace.conversionId);
  function plan(id, fileIndex, details, token = null) {
    const trace = find(id);
    if (!trace || trace.fileIndex !== fileIndex || !tokenCurrent(trace, token)) return;
    // Explicitly select safe enum/number fields: never spread request or probe data.
    trace.plan = {
      mode: details.videoMode === "copy" ? "remux" : "transcode",
      videoMode: enumValue(details.videoMode, ["copy", "h264"]),
      videoReason: enumValue(details.videoReason, VIDEO_REASONS),
      sourceVideoCodec: enumValue(details.sourceVideoCodec, VIDEO_CODECS),
      audioMode: enumValue(details.audioMode, ["auto", "stereo", "surround"]),
      audioReason: enumValue(details.audioReason, AUDIO_REASONS),
      audioOutputCodec: enumValue(details.audioOutputCodec, ["aac", "mp3"]),
      audioOutputChannels: Number.isInteger(details.audioOutputChannels) && details.audioOutputChannels >= 1 && details.audioOutputChannels <= 6 ? details.audioOutputChannels : null,
      startSeconds: Number.isFinite(details.startSeconds) && details.startSeconds >= 0 && details.startSeconds <= 86400 ? details.startSeconds : null,
    };
    event(id, "transcode-plan", trace.plan);
  }
  function progress(id, line, token = null) {
    const trace = find(id);
    if (!trace || !tokenCurrent(trace, token)) return;
    const value = parseFfmpegProgress(line);
    if (value === null) return;
    trace.speed = value;
    event(id, "ffmpeg-speed", { speed: value });
  }
  function snapshot(id, { torrent = null, file = null, fileIndex = null } = {}) {
    const trace = find(id);
    if (!trace) return null;
    const activeReaders = [...trace.readers.entries()].map(([reader, r]) => ({ reader, offset: r.offset, end: r.end, elapsedMs: now() - r.started }));
    const pieceLength = Number(torrent?.pieceLength) || 0;
    const fileOffset = Number(file?.offset) || 0;
    const playheadOffset = activeReaders[0]?.offset ?? null;
    const piece = playheadOffset === null || !pieceLength || !torrent?.bitfield ? null : Math.floor((fileOffset + playheadOffset) / pieceLength);
    return {
      enabled: true, elapsedMs: now() - trace.started, fileIndex: fileIndex ?? trace.fileIndex,
      readers: activeReaders, activeReaderCount: trace.readers.size,
      peers: typeof torrent?.numPeers === "number" ? torrent.numPeers : null,
      downloadBytesPerSecond: Number.isFinite(torrent?.downloadSpeed) ? torrent.downloadSpeed : null,
      observedReaderPiece: piece,
      observedReaderPiecePresent: piece === null ? null : Boolean(torrent.bitfield.get(piece)),
      // The earliest active reader may be a probe or subtitle job, not the
      // playback reader. Never misreport this as confirmed playhead availability.
      playheadPiecePresent: null,
      plan: trace.plan, ffmpegSpeed: trace.speed, ffmpegCpuPercent: null,
      events: [...trace.events],
    };
  }
  return { start, stop: (id) => traces.delete(id), enabled: (id) => Boolean(find(id)), event, reader, captureToken, plan, progress, snapshot };
}
