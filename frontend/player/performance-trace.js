// PERF-02. Diagnostic-only, kept out of the normal playback path unless
// explicitly enabled for this browser tab. The trace contains no media names,
// torrent identities, source URLs, subtitle content or user preferences.
const LIMIT = 180;

export function createBrowserPlaybackTrace(video, { clock = () => performance.now(), request = fetch } = {}) {
  const started = clock();
  const events = [];
  let session = null;
  let backendTransition = Promise.resolve();
  let generation = 0;
  let mode = "unknown";
  let reason = null;
  let loadAt = null;
  let seek = null;
  let firstFrameMs = null;
  let frameRequest = null;
  let frameDeadline = 0;
  let frameChecks = 0;

  function record(type, fields = {}) {
    events.push({ elapsedMs: Math.round(clock() - started), type, ...fields });
    if (events.length > LIMIT) events.shift();
  }
  const safeLabel = (value) => /^[a-z0-9][a-z0-9-]{0,70}$/i.test(String(value || "")) ? value : null;
  const quality = () => {
    const q = video.getVideoPlaybackQuality?.();
    return {
      decodedFrames: Number.isFinite(q?.totalVideoFrames) ? q.totalVideoFrames : null,
      droppedFrames: Number.isFinite(q?.droppedVideoFrames) ? q.droppedVideoFrames : null,
    };
  };
  function cancelFrame() {
    if (frameRequest !== null) video.cancelVideoFrameCallback?.(frameRequest);
    frameRequest = null;
  }
  function watchFrame() {
    if (typeof video.requestVideoFrameCallback !== "function") return;
    cancelFrame();
    const token = generation;
    frameChecks = 0;
    frameDeadline = clock() + 10_000;
    const next = () => {
      if (token !== generation || clock() > frameDeadline || frameChecks++ >= 240) return;
      frameRequest = video.requestVideoFrameCallback((_at, data) => {
        frameRequest = null;
        if (token !== generation) return;
        const mediaTime = Number(data?.mediaTime);
        if (video.seeking || !Number.isFinite(mediaTime)) { next(); return; }
        if (firstFrameMs === null && loadAt !== null) {
          firstFrameMs = Math.round(clock() - loadAt);
          record("first-presented-frame", { ms: firstFrameMs, mediaTimeSeconds: mediaTime, ...quality() });
        }
        if (seek) {
          // Discard frames still displaying the old position. Native seeks and
          // transcode reopening both require a frame at the target position.
          if (Math.abs(mediaTime - seek.expectedLocalSeconds) <= 1.5) {
            record("seek-presented-frame", { ms: Math.round(clock() - seek.at), targetSeconds: seek.targetSeconds,
              displayedLocalSeconds: mediaTime, ...quality() });
            seek = null;
          }
        }
        if (seek) next();
      });
    };
    next();
  }
  function newSource({ playbackMode = "unknown", startSeconds = 0, seekReopen = false } = {}) {
    generation += 1;
    cancelFrame();
    mode = playbackMode === "torrent-direct" ? "direct"
      : playbackMode === "transcode" ? (["remux", "transcode"].includes(mode) ? mode : "unknown-conversion") : "local";
    loadAt = clock();
    firstFrameMs = null;
    record("source-load", { mode, startSeconds, seekReopen });
    // A remux/transcode seek reopens the video src without a `seeking` event.
    if (seekReopen && seek === null) seek = { at: clock(), targetSeconds: startSeconds, expectedLocalSeconds: 0 };
    if (seekReopen && seek) seek.expectedLocalSeconds = 0;
    // The previous video's frame may still be queued until the new src loads.
    // Start observing at loadeddata, after the source generation has changed.
  }
  function selection({ playbackMode, playbackReason } = {}) {
    const selected = safeLabel(playbackMode);
    if (selected) mode = selected;
    reason = safeLabel(playbackReason);
    record("playback-decision", { mode, reason });
  }
  function trackTorrent(sessionId, fileIndex) {
    if (!/^[0-9a-f-]{36}$/i.test(String(sessionId)) || !Number.isInteger(Number(fileIndex))) return;
    if (session?.id === sessionId && session.fileIndex === Number(fileIndex)) return backendTransition;
    const previous = session;
    const next = { id: sessionId, fileIndex: Number(fileIndex) };
    session = next;
    const post = (action, source) => request("/api/diagnostics/playback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, session: source.id, ...(action === "start" ? { fileIndex: source.fileIndex } : {}) }),
    });
    // A slow stop request must never overtake the following start for the
    // same session. Skip obsolete starts when the user switches again.
    backendTransition = backendTransition.catch(() => {}).then(async () => {
      if (previous) {
        try { await post("stop", previous); } catch { record("backend-trace-unavailable"); }
      }
      if (session !== next) return;
      try {
        const response = await post("start", next);
        if (!response.ok) record("backend-trace-unavailable", { status: response.status });
      } catch { record("backend-trace-unavailable"); }
    });
    return backendTransition;
  }
  video.addEventListener("seeking", () => {
    seek = { at: clock(), targetSeconds: Number(video.currentTime) || 0, expectedLocalSeconds: Number(video.currentTime) || 0 };
    record("seeking", { targetSeconds: seek.targetSeconds });
    watchFrame();
  });
  for (const type of ["loadstart", "loadeddata", "canplay", "play", "playing", "waiting", "stalled", "pause", "seeked", "error"]) {
    video.addEventListener(type, () => {
      record(type, { playbackSeconds: Number(video.currentTime) || 0, readyState: video.readyState,
        ...(type === "error" ? { mediaErrorCode: video.error?.code ?? null } : {}) });
      if (type === "loadeddata" || type === "playing" || type === "seeked") watchFrame();
    });
  }
  async function snapshot() {
    let backend = null;
    if (session) {
      try {
        const response = await request(`/api/diagnostics/playback?session=${encodeURIComponent(session.id)}`);
        if (response.ok) backend = await response.json();
      } catch {}
    }
    return {
      kind: "LVL opt-in PERF-02", startedAt: new Date(Date.now() - (clock() - started)).toISOString(),
      mode, reason, firstPresentedFrameMs: firstFrameMs, ...quality(),
      firstAudibleOutputMs: null, audibleOutputNote: "Not observable through HTMLMediaElement",
      subtitleTimingNote: "Cue offset / audio onset require a separate synchronized probe",
      backend, events: [...events],
    };
  }
  async function download() {
    const content = await snapshot();
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lvl-playback-trace.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return content;
  }
  record("trace-enabled");
  return { newSource, selection, trackTorrent, record, snapshot, download };
}

export function installPlaybackTrace(video, options = {}) {
  try {
    if (window.sessionStorage.getItem("lvl-performance-trace") !== "1") return null;
  } catch { return null; }
  const trace = createBrowserPlaybackTrace(video, options);
  window.lvlPlaybackTrace = trace;
  return trace;
}
