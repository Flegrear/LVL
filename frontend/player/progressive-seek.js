/**
 * OPTIONAL progressive indexed-video frontend contract; no DOM/network access
 * at import time and no dependency on torrent download-piece statistics.
 *
 * PRIME/backend integration contract:
 *  - Publish a status as soon as ONE independently decodable, movie-clock
 *    verified fMP4 section is committed; a full-episode MP4 is NOT required.
 *  - {kind:'indexed-video-segments',status:'building'|'partial-ready'|'ready',
 *     sourceKey,generation,audioIndex,audioMode,durationSeconds,
 *     videoCodec:'h264',audioCodec:'aac',container:'fmp4',
 *     mime:'video/mp4; codecs="avc1.<actual avcC hex>, mp4a.40.2"',
 *     initVerified:true,sourceVerified:true,
 *     segments:[{id,startSeconds,endSeconds,bytes,complete:true,
 *       verified:true,independentlyDecodable:true,keyframeStart:true,
 *       movieClockVerified:true}]}
 *  - Every flag attests BACKEND validation, not merely that bytes downloaded.
 *    Publish a section only after its complete moof/mdat, compatible init,
 *    IDR/sample timing and original source identity have been verified.
 *    Segment IDs are opaque; this module never constructs media URLs.
 *  - The caller supplies loadWindow() that only reads a bounded, committed
 *    section and safely appends/attaches it to an MSE SourceBuffer (in the
 *    existing remux MSE consumer or a new backend-owned reader). This helper
 *    does not fetch bytes, create FFmpeg jobs or mutate playback intent.
 *  - getContext() MUST return the currently selected sourceKey, audioIndex,
 *    audioMode and a monotonically increasing generation. Call cancel() on
 *    navigation/source/audio changes; guard all callbacks again regardless.
 *
 * Return ranges[] from normalizeProgressiveSeekStatus() to render MULTIPLE
 * bright, disjoint portions of the timeline. Never color the torrent piece map
 * with these ranges, and never represent a missing gap as seekable.
 */

const MAX_DURATION_SECONDS = 4 * 60 * 60;
// Backend permits up to 7,200 verified GOPs (4h at 2s GOPs). A 58-minute
// episode can exceed 1,700; rejecting its ENTIRE index at 1,024 would make
// previously bright sections suddenly disappear halfway through the movie.
const MAX_SEGMENTS = 8192;
const MAX_SECTION_SECONDS = 180;
const MAX_SECTION_BYTES = 64 * 1024 * 1024;
const SEEK_AHEAD_SECONDS = 0.25;
const MAX_STATUS_DURATION_DELTA_SECONDS = 0.05;
const FRAME_TOLERANCE_SECONDS = 0.125;
const MAX_SEEK_TIMEOUT_MS = 12000;
// Exact codec must originate from the VERIFIED fMP4 init avcC bytes, not an
// assumed High-profile string. Baseline/Main/High can each be legitimate.
const AVC_AAC_MIME = /^video\/mp4; codecs="avc1\.[0-9a-fA-F]{6}, mp4a\.40\.2"$/;
const SOURCE_KEY = /^[a-zA-Z0-9:_-]{1,160}$/;
const SECTION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const AUDIO_MODES = new Set(['auto', 'stereo', 'surround']);
const STATUS_NAMES = new Set(['building', 'partial-ready', 'ready']);
const validatedSnapshots = new WeakSet();
const boundedInt = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validContext(value) {
  return value && typeof value === 'object'
    && SOURCE_KEY.test(value.sourceKey)
    && boundedInt(value.generation, Number.MAX_SAFE_INTEGER)
    && boundedInt(value.audioIndex, 64)
    && AUDIO_MODES.has(value.audioMode)
    && finite(value.durationSeconds) && value.durationSeconds > 0
    && value.durationSeconds <= MAX_DURATION_SECONDS;
}

function sameContext(expected, actual) {
  return validContext(actual)
    && expected.sourceKey === actual.sourceKey
    && expected.generation === actual.generation
    && expected.audioIndex === actual.audioIndex
    && expected.audioMode === actual.audioMode
    && Math.abs(expected.durationSeconds - actual.durationSeconds)
      <= MAX_STATUS_DURATION_DELTA_SECONDS
    // Optional frontend-selected stream nonce may guard navigation even if a
    // caller reuses an audio/source generation. Prime should provide one.
    && expected.mediaToken === actual.mediaToken;
}

function verifiedSection(section, duration) {
  const offset = section?.timelineOffsetSeconds ?? 0;
  return section && SECTION_ID.test(section.id)
    && section.complete === true && section.verified === true
    && section.independentlyDecodable === true && section.keyframeStart === true
    && section.movieClockVerified === true
    && finite(section.startSeconds) && finite(section.endSeconds)
    && section.startSeconds >= 0
    && finite(offset) && offset >= 0 && offset <= duration
    && (section.mediaStartSeconds === undefined
      ? offset === 0
      : (finite(section.mediaStartSeconds) && section.mediaStartSeconds >= 0
        && section.mediaStartSeconds + offset <= section.endSeconds + 0.05
        && Math.abs(section.mediaStartSeconds + offset - section.startSeconds) <= 0.25))
    && section.endSeconds > section.startSeconds
    && section.endSeconds <= duration + 0.001
    && section.endSeconds - section.startSeconds <= MAX_SECTION_SECONDS
    && boundedInt(section.bytes, MAX_SECTION_BYTES) && section.bytes >= 1024;
}

function mergeIntervals(segments) {
  const ranges = [];
  for (const item of segments) {
    const last = ranges[ranges.length - 1];
    // Never bridge even a small positive gap; a downloaded-only 1ms section is
    // not a decoded-ready 1ms section. Adjacent boundaries may touch exactly.
    if (last && item.startSeconds <= last.end)
      last.end = Math.max(last.end, item.endSeconds);
    else ranges.push({ start: item.startSeconds, end: item.endSeconds });
  }
  return ranges;
}

function seekableIntervals(segments) {
  // A published GOP may be fully decoded yet the final 250ms cannot warm-seek
  // as a standalone window with the same 250ms presentation/lookahead proof.
  // Likewise an audio packet can precede its first presentation video frame.
  // The bright UI must mark target instants supported by THIS reader, never
  // the wider raw section bounds or a downloaded-only gap.
  return segments.map(item => ({
    startSeconds: Math.max(item.startSeconds,
      item.mediaStartSeconds === undefined ? item.startSeconds
        : item.mediaStartSeconds + (item.timelineOffsetSeconds || 0)),
    endSeconds: Math.max(0, item.endSeconds - SEEK_AHEAD_SECONDS),
  })).filter(item => item.endSeconds > item.startSeconds);
}

/** Null means no proven seek-ready segments, not even if torrent=100% saved. */
export function normalizeProgressiveSeekStatus(status, expected) {
  if (!validContext(expected) || !sameContext(expected, status)
    || status.kind !== 'indexed-video-segments' || !STATUS_NAMES.has(status.status)
    || status.videoCodec !== 'h264' || status.audioCodec !== 'aac'
    || status.container !== 'fmp4' || !AVC_AAC_MIME.test(status.mime)
    || status.initVerified !== true || status.sourceVerified !== true
    || !Array.isArray(status.segments) || status.segments.length > MAX_SEGMENTS)
    return null;
  const seen = new Set();
  const segments = [];
  for (const item of status.segments) {
    if (!verifiedSection(item, expected.durationSeconds) || seen.has(item.id)) continue;
    seen.add(item.id);
    // Do NOT carry through media URLs, piece bitfields, torrent metadata, or
    // unvalidated nested properties from backend JSON.
    segments.push({
      id: item.id, startSeconds: item.startSeconds,
      endSeconds: item.endSeconds, bytes: item.bytes,
      ...(item.mediaStartSeconds !== undefined
        ? { mediaStartSeconds: item.mediaStartSeconds } : {}),
      timelineOffsetSeconds: item.timelineOffsetSeconds ?? 0,
      ...(typeof item.initHash === 'string' && /^[0-9a-f]{64}$/i.test(item.initHash)
        ? { initHash: item.initHash } : {}),
    });
  }
  if (!segments.length) return null;
  segments.sort((a, b) => a.startSeconds - b.startSeconds
    || a.endSeconds - b.endSeconds || a.id.localeCompare(b.id));
  const normalized = {
    sourceKey: expected.sourceKey, generation: expected.generation,
    audioIndex: expected.audioIndex, audioMode: expected.audioMode,
    durationSeconds: expected.durationSeconds, mime: status.mime,
    ...(typeof status.identityKey === 'string'
      && /^[a-f0-9]{64}$/i.test(status.identityKey)
      ? { identityKey: status.identityKey } : {}),
    // Freeze validated snapshots so another UI callback cannot silently
    // mutate a validated range/section into an unverified bright interval.
    segments: Object.freeze(segments.map(item => Object.freeze(item))),
    ranges: Object.freeze(mergeIntervals(seekableIntervals(segments))
      .map(item => Object.freeze(item))),
  };
  Object.freeze(normalized);
  validatedSnapshots.add(normalized);
  return normalized;
}

/**
 * Adapter for PRIME's backend worker12 committed GOP-index status:
 * {status:'building'|'ready',identityKey:<sha256>,complete,
 *  ranges:[{id:<sha256>,sequence,start,end,mediaStart,baseSeconds:0,
 *           seekOffsetSeconds:0,initHash:<sha256>,bytes}]}.
 *
 * The server's readIndex() must already have atomically verified the source,
 * init, IDR, timestamps and committed file. Never adapt arbitrary torrent
 * download maps. captureContext is taken when issuing the STATUS GET; compare
 * liveContext from getContext() immediately before drawing or seeking. The
 * exact avcC-derived MIME must be supplied as raw.mime or verifiedMime from
 * the same backend-verified init; never guess High profile.
 *
 * A ready snapshot is only for this precise source, audio, generation, and
 * 64-hex index identity. A refreshed status from an earlier request therefore
 * cannot become bright or seekable after source/audio navigation.
 */
export function normalizeCommittedProgressiveIndexStatus(raw, captureContext,
  liveContext, { verifiedMime = '' } = {}) {
  const hex = /^[0-9a-f]{64}$/i;
  if (!raw || !validContext(captureContext)
    || !sameContext(captureContext, liveContext)
    || !hex.test(raw.identityKey)
    || (captureContext.identityKey && captureContext.identityKey !== raw.identityKey)
    || !['building', 'partial', 'ready'].includes(raw.status)
    || !Array.isArray(raw.ranges) || raw.ranges.length > MAX_SEGMENTS)
    return null;
  const mime = raw.mime || verifiedMime;
  if (!AVC_AAC_MIME.test(mime)) return null;
  const segments = raw.ranges.map(section => {
    if (!section || !hex.test(section.id) || !hex.test(section.initHash)
      || !boundedInt(section.sequence, MAX_SEGMENTS * 4)
      || !finite(section.start) || !finite(section.end)
      || !finite(section.mediaStart) || !finite(section.baseSeconds)
      || !finite(section.seekOffsetSeconds)
      || section.baseSeconds !== (section.timelineOffsetSeconds??0)
      || section.seekOffsetSeconds !== 0)
      return null;
    return {
      id: section.id, startSeconds: section.start, endSeconds: section.end,
      mediaStartSeconds: section.mediaStart,
      timelineOffsetSeconds: section.timelineOffsetSeconds??0,
      initHash: section.initHash,
      bytes: section.bytes,
      // These are server-published *completed and indexed* files, not
      // a claim about arbitrary unverified partial torrent content.
      complete: true, verified: true, independentlyDecodable: true,
      keyframeStart: true, movieClockVerified: true,
    };
  });
  const snapshot = normalizeProgressiveSeekStatus({
    ...captureContext, kind:'indexed-video-segments',
    status:raw.status==='partial'?'partial-ready':raw.status,
    identityKey:raw.identityKey,
    videoCodec:'h264', audioCodec:'aac', container:'fmp4',
    mime, initVerified:true, sourceVerified:true, segments,
  }, captureContext);
  return snapshot;
}

/** UI-only bright intervals; retain every disjoint section. */
export function progressiveReadyRanges(snapshot) {
  return snapshot && validatedSnapshots.has(snapshot)
    ? snapshot.ranges.map(({ start, end }) => ({ start, end })) : [];
}

/**
 * Match ONE independently decodable/verified window containing target plus
 * decoding look-ahead. Adjacent sections may be painted as one continuous
 * interval but must not be implicitly spliced into an unverified MSE window.
 */
export function findProgressiveReadySegment(snapshot, seconds,
  { lookAheadSeconds = SEEK_AHEAD_SECONDS } = {}) {
  if (!snapshot || !validatedSnapshots.has(snapshot)
    || !finite(seconds) || seconds < 0 || seconds >= snapshot.durationSeconds
    || !finite(lookAheadSeconds) || lookAheadSeconds < 0
    || lookAheadSeconds > 3) return null;
  return snapshot.segments.find(item => seconds >= Math.max(item.startSeconds,
      item.mediaStartSeconds ?? item.startSeconds)
    && seconds + lookAheadSeconds <= item.endSeconds) || null;
}

const rejected = reason => ({ ok: false, reason });

/**
 * Optional playback handoff, not an autonomous player.
 *
 * loadWindow({segment,targetSeconds,context,signal}) is caller-owned and MUST
 * return {ready:true,baseSeconds,mediaSrc?} only after a complete verified
 * section is safely attached/appended in MSE. If it changes video.src, it MUST
 * return that exact mediaSrc for identity verification.
 *
 * seekVideo({video,targetSeconds,localSeconds,context,signal}) defaults to
 * setting video.currentTime. This helper NEVER calls play(), pause(), changes
 * muted, or destroys a user source. Caller controls loading UI and fallback.
 * A successful result requires requestVideoFrameCallback to prove the first
 * visible, non-seeking frame is within 125ms of the requested movie clock.
 */
export function createProgressiveSeekController({
  video, getContext, loadWindow, seekVideo = ({video: element, localSeconds}) => {
    element.currentTime = localSeconds;
  }, canUseMse = mime => Boolean(globalThis.MediaSource?.isTypeSupported?.(mime)),
  isVisible = () => video?.style?.visibility !== 'hidden',
  timeoutMs = 5000,
} = {}) {
  if (!video || typeof getContext !== 'function'
    || typeof loadWindow !== 'function' || typeof seekVideo !== 'function'
    || typeof canUseMse !== 'function' || typeof isVisible !== 'function')
    throw new TypeError('Progressive seek requires video, context, bounded MSE loader, and callbacks');
  if (!finite(timeoutMs) || timeoutMs < 20 || timeoutMs > MAX_SEEK_TIMEOUT_MS)
    throw new RangeError('Invalid bounded progressive seek timeout');
  let active = null, closed = false, retainedDispose = null;
  function cancel() { active?.finish(false, 'cancelled'); }
  function close() {
    closed = true; cancel();
    if (retainedDispose) {
      try { retainedDispose(); } catch {}
      retainedDispose = null;
    }
  }
  function seek(status, targetSeconds) {
    if (closed) return Promise.resolve(rejected('closed'));
    cancel();
    let context;
    try { context = getContext(); }
    catch { return Promise.resolve(rejected('invalid-context')); }
    const ready = normalizeProgressiveSeekStatus(status, context);
    if (!ready) return Promise.resolve(rejected('no-verified-ready-sections'));
    const section = findProgressiveReadySegment(ready, targetSeconds);
    if (!section) return Promise.resolve(rejected('target-not-ready'));
    if (typeof video.requestVideoFrameCallback !== 'function'
      || typeof video.cancelVideoFrameCallback !== 'function'
      || !canUseMse(ready.mime))
      return Promise.resolve(rejected('unsupported-mse'));
    const originalSrc = video.src || video.currentSrc || '';
    const aborter = new AbortController();
    return new Promise(resolve => {
      let settled = false, frameId = null, timer = null, stagedDispose = null;
      let expectedSrc = originalSrc, localSeconds = null, baseSeconds = null;
      const sameSelection = () => {
        try { return sameContext(context, getContext()); }
        catch { return false; }
      };
      const current = () => !settled && !closed && active === attempt
        && !aborter.signal.aborted && sameSelection()
        && (video.src || video.currentSrc || '') === expectedSrc;
      const finish = (ok, reason = '', mediaTime = null) => {
        if (settled) return;
        settled = true;
        if (active === attempt) active = null;
        clearTimeout(timer);
        if (frameId !== null) {
          try { video.cancelVideoFrameCallback(frameId); } catch {}
          frameId = null;
        }
        if (!ok && stagedDispose) {
          try { stagedDispose(); } catch {}
        }
        if (ok) {
          if (retainedDispose && retainedDispose !== stagedDispose) {
            try { retainedDispose(); } catch {}
          }
          retainedDispose = stagedDispose;
        }
        aborter.abort();
        resolve(ok
          ? {ok:true,mediaTime,absoluteSeconds:baseSeconds + mediaTime}
          : rejected(reason));
      };
      const attempt = { finish };
      active = attempt;
      const nextFrame = () => {
        if (!current()) { finish(false, 'stale-source'); return; }
        try {
          frameId = video.requestVideoFrameCallback((_now, metadata) => {
            frameId = null;
            if (!current()) { finish(false, 'stale-source'); return; }
            const mediaTime = metadata?.mediaTime;
            const position = Number(video.currentTime);
            let visible = false;
            try { visible = isVisible() === true; } catch {}
            if (visible && !video.seeking && video.readyState >= 2
              && finite(mediaTime) && finite(position)
              && Math.abs(position - localSeconds) <= 0.35
              && Math.abs(mediaTime - localSeconds) <= FRAME_TOLERANCE_SECONDS) {
              finish(true, '', mediaTime);
            } else nextFrame();
          });
        } catch { finish(false, 'frame-callback-unavailable'); }
      };
      timer = setTimeout(() => finish(false, sameSelection() ? 'timeout' : 'stale-source'), timeoutMs);
      void (async () => {
        let windowResult;
        try {
          windowResult = await loadWindow({
            segment: { ...section }, targetSeconds, context: { ...context, mime: ready.mime },
            signal: aborter.signal,
            // Before creating a new media element source, the window reader
            // must validate freshness itself, not merely after it returns.
            isCurrent: () => !settled && !closed && active === attempt
              && !aborter.signal.aborted && sameSelection()
              && (video.src || video.currentSrc || '') === originalSrc,
          });
        } catch {
          if (current()) finish(false, 'window-load-failed');
          return;
        }
        if (settled) {
          try { windowResult?.dispose?.(); } catch {}
          return;
        }
        if (!sameSelection()) { finish(false, 'stale-source'); return; }
        if (!windowResult || windowResult.ready !== true
          || !finite(windowResult.baseSeconds) || windowResult.baseSeconds < 0
          || windowResult.baseSeconds > targetSeconds)
          return finish(false, 'unverified-window');
        // MSE window loader may attach a new blob URL, but must explicitly
        // authorize its exact resulting source. Otherwise any src change fails.
        if (windowResult.mediaSrc !== undefined) {
          if (typeof windowResult.mediaSrc !== 'string'
            || !windowResult.mediaSrc) return finish(false, 'invalid-media-source');
          expectedSrc = windowResult.mediaSrc;
        }
        if (typeof windowResult.dispose === 'function')
          stagedDispose = windowResult.dispose;
        if (!current()) return finish(false, 'stale-source');
        baseSeconds = windowResult.baseSeconds;
        localSeconds = targetSeconds - baseSeconds;
        nextFrame(); // Arm BEFORE applying seek to avoid losing the first frame.
        if (settled) return;
        try {
          await seekVideo({
            video, targetSeconds, localSeconds, context: { ...context },
            signal: aborter.signal,
          });
        } catch { if (!settled) finish(false, 'seek-failed'); return; }
        if (!settled && !current()) finish(false, 'stale-source');
      })();
    });
  }
  return { seek, cancel, close, get busy() { return active !== null; } };
}

/**
 * Optional concrete standalone fMP4/MSE window handoff. This does NOT depend
 * on the older remuxMseSession or an existing live FFmpeg SourceBuffer.
 *
 * requestWindow({segment,context,signal}) is supplied by PRIME's authenticated
 * same-origin backend adapter. It must do ONE bounded GET of a published
 * complete/verified section and return:
 *
 * {segmentId,sourceKey,generation,audioIndex,audioMode,startSeconds,endSeconds,
 *  mediaStartSeconds,contentType,complete:true,verified:true,initVerified:true,
 *  bytes:Uint8Array}
 *
 * The backend determines mediaStartSeconds from the verified fragment's first
 * presentation timestamp. SourceBuffer.timestampOffset is computed as
 * segment.startSeconds - mediaStartSeconds (zero for absolute movie PTS), so
 * video.currentTime AND rVFC mediaTime are always absolute movie seconds.
 *
 * No downloaded piece map, speculative FFmpeg work, URL construction, media
 * parsing of movie data by callers, or hidden source switching is performed.
 * This helper allocates at most one verified <=64MiB fMP4 window per call.
 * A source change is returned to the controller as mediaSrc for explicit
 * guarding, and each attachment has an explicit dispose() lifecycle.
 */
function completeStandaloneFmp4(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32
    || bytes.byteLength > MAX_SECTION_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0, ftyp = false, moov = false, moof = false, media = 0;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return false;
    const raw = view.getUint32(at);
    const wide = raw === 1;
    if (wide && at + 16 > bytes.length) return false;
    const size = wide ? Number(view.getBigUint64(at + 8)) : raw;
    const minSize = wide ? 16 : 8;
    if (!Number.isSafeInteger(size) || size < minSize || at + size > bytes.length)
      return false;
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (kind === 'ftyp' && !ftyp && !moov && !moof) ftyp = true;
    else if (kind === 'moov' && ftyp && !moov && !moof) moov = true;
    else if (kind === 'moof' && moov && !moof) moof = true;
    else if (kind === 'mdat' && moof) { moof = false; media++; }
    else if (!['free','skip','sidx','styp','mfra'].includes(kind)
      || (kind === 'styp' && !moov) || moof) return false;
    at += size;
  }
  return ftyp && moov && !moof && media >= 1;
}

function boundedWindowResponse(result, section, context, mime) {
  return result && result.complete === true && result.verified === true
    && result.initVerified === true
    && result.segmentId === section.id
    && result.sourceKey === context.sourceKey
    && result.generation === context.generation
    && result.audioIndex === context.audioIndex
    && result.audioMode === context.audioMode
    && finite(result.startSeconds) && finite(result.endSeconds)
    && Math.abs(result.startSeconds - section.startSeconds) <= 0.003
    && Math.abs(result.endSeconds - section.endSeconds) <= 0.003
    && finite(result.mediaStartSeconds) && result.mediaStartSeconds >= 0
    && result.mediaStartSeconds <= section.endSeconds
    && result.contentType === mime
    && (!section.initHash || result.initHash === section.initHash)
    && result.bytes?.byteLength === section.bytes
    && completeStandaloneFmp4(result.bytes);
}

function awaitMseEvent(source, success, signal, timeoutMs, begin = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.removeEventListener(success, ok);
      source.removeEventListener('error', bad);
      source.removeEventListener('abort', bad);
      signal.removeEventListener('abort', bad);
      if (error) reject(error);
      else resolve();
    };
    const ok = () => done();
    const bad = () => done(Error('MSE window unavailable'));
    const timer = setTimeout(bad, timeoutMs);
    source.addEventListener(success, ok);
    source.addEventListener('error', bad);
    source.addEventListener('abort', bad);
    signal.addEventListener('abort', bad, { once: true });
    if (signal.aborted) bad();
    else {
      try { begin(); }
      catch { bad(); }
    }
  });
}

export function createStandaloneProgressiveMseLoader({
  video, requestWindow,
  createMediaSource = () => new MediaSource(),
  createObjectURL = mediaSource => URL.createObjectURL(mediaSource),
  revokeObjectURL = url => URL.revokeObjectURL(url),
  timeoutMs = 5000,
} = {}) {
  if (!video || typeof requestWindow !== 'function'
    || typeof createMediaSource !== 'function'
    || typeof createObjectURL !== 'function'
    || typeof revokeObjectURL !== 'function')
    throw new TypeError('Standalone progressive MSE requires video and verified window reader');
  if (!finite(timeoutMs) || timeoutMs < 20 || timeoutMs > MAX_SEEK_TIMEOUT_MS)
    throw new RangeError('Invalid bounded MSE window timeout');
  const attachments = new Set();
  let closed = false;
  let currentWindow = null;
  let continuing = false;
  const load = async ({ segment, targetSeconds, context, signal, isCurrent = () => true }) => {
    const selected = () => !closed && !signal?.aborted
      && typeof isCurrent === 'function' && isCurrent();
    if (closed || signal?.aborted || !validContext(context)
      || !verifiedStandaloneParams(segment, targetSeconds)) return { ready: false };
    const mime = typeof context.mime === 'string' ? context.mime : '';
    if (!AVC_AAC_MIME.test(mime)) return { ready: false };
    let result;
    try {
      result = await requestWindow({segment: {...segment}, targetSeconds,
        context: {...context}, signal});
    } catch { return { ready: false }; }
    if (!selected() || !boundedWindowResponse(result, segment, context, mime))
      return { ready: false };
    // Backend-authenticated parsed window: no URL/filename used as a decoder
    // selector. Only append its validated and bounded byte payload.
    const offset = segment.startSeconds - result.mediaStartSeconds;
    // The first decoded H.264 frame may follow an earlier AAC packet. A small
    // negative timestampOffset is valid MSE timing, not an unsafe clock.
    if (!Number.isFinite(offset) || Math.abs(offset) > MAX_DURATION_SECONDS)
      return { ready: false };
    let mediaSource = null, objectUrl = null, disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (currentWindow?.objectUrl === objectUrl) currentWindow = null;
      attachments.delete(dispose);
      if (objectUrl) { try { revokeObjectURL(objectUrl); } catch {} }
    };
    try {
      if (!selected()) return { ready: false };
      mediaSource = createMediaSource();
      if (!mediaSource?.addSourceBuffer || !mediaSource.addEventListener
        || !mediaSource.removeEventListener) return { ready: false };
      objectUrl = createObjectURL(mediaSource);
      attachments.add(dispose);
      await awaitMseEvent(mediaSource, 'sourceopen', signal, timeoutMs, () => {
        if (!selected()) throw Error('Stale selected source');
        video.src = objectUrl;
        video.load?.();
      });
      if (closed || signal?.aborted || mediaSource.readyState !== 'open')
        throw Error('MSE source obsolete');
      mediaSource.duration = context.durationSeconds;
      const buffer = mediaSource.addSourceBuffer(mime);
      buffer.mode = 'segments';
      buffer.timestampOffset = offset;
      await awaitMseEvent(buffer, 'updateend', signal, timeoutMs,
        () => buffer.appendBuffer(result.bytes));
      if (closed || signal?.aborted || buffer.updating || !buffer.buffered)
        throw Error('MSE append unavailable');
      let covered = false;
      for (let i = 0; i < buffer.buffered.length; i++) {
        if (buffer.buffered.start(i) <= targetSeconds + 0.02
          && buffer.buffered.end(i) >= targetSeconds + SEEK_AHEAD_SECONDS) {
          covered = true; break;
        }
      }
      if (!covered) throw Error('Window does not buffer requested movie frame');
      // Do NOT endOfStream here: the next independently verified GOP may
      // already exist on disk and can be appended to this SAME SourceBuffer.
      // Closing it after every 2s GOP would force a new FFmpeg stream on EOF.
      currentWindow = {mediaSource,buffer,objectUrl,dispose,
        endSeconds:segment.endSeconds,id:segment.id,initHash:segment.initHash,
        sourceKey:context.sourceKey,generation:context.generation,
        audioIndex:context.audioIndex,audioMode:context.audioMode,
        durationSeconds:context.durationSeconds,mime};
      return {ready:true, baseSeconds:0, mediaSrc:objectUrl, dispose};
    } catch {
      dispose();
      return {ready:false};
    }
  };
  load.appendNext = async ({segment,context,signal,isCurrent=()=>true}={}) => {
    const win=currentWindow;
    if (closed || continuing || !win || signal?.aborted
      || typeof isCurrent !== 'function' || !isCurrent()
      || !validContext(context) || !segment || !SECTION_ID.test(segment.id)
      || segment.id === win.id || !finite(segment.startSeconds)
      || !finite(segment.endSeconds) || segment.endSeconds <= segment.startSeconds
      || segment.startSeconds < win.endSeconds - 0.15
      || segment.startSeconds > win.endSeconds + 0.15
      || !segment.initHash || segment.initHash !== win.initHash
      || context.sourceKey !== win.sourceKey
      || context.generation !== win.generation
      || context.audioIndex !== win.audioIndex
      || context.audioMode !== win.audioMode
      || context.durationSeconds !== win.durationSeconds
      || context.mime !== win.mime || video.src !== win.objectUrl
      || win.mediaSource.readyState !== 'open'
      || win.buffer.updating || win.endSeconds - Number(video.currentTime) > 45)
      return false;
    continuing = true;
    try {
      const response=await requestWindow({segment:{...segment},targetSeconds:segment.startSeconds,
        context:{...context},signal});
      if (closed || signal?.aborted || !isCurrent()
        || currentWindow !== win || video.src !== win.objectUrl
        || !boundedWindowResponse(response,segment,context,win.mime)) return false;
      const offset=segment.startSeconds-response.mediaStartSeconds;
      if (!Number.isFinite(offset) || Math.abs(offset)>MAX_DURATION_SECONDS) return false;
      win.buffer.timestampOffset=offset;
      await awaitMseEvent(win.buffer,'updateend',signal,timeoutMs,
        ()=>win.buffer.appendBuffer(response.bytes));
      if (closed || signal?.aborted || !isCurrent() || currentWindow !== win
        || video.src !== win.objectUrl) return false;
      const buffered=win.buffer.buffered;
      let extended=false;
      for(let i=0;i<(buffered?.length||0);i++){
        if(buffered.start(i)<=segment.startSeconds+0.15
          && buffered.end(i)>=segment.endSeconds-0.35){extended=true;break;}
      }
      if (!extended) return false;
      // Retain only a bounded amount of already-consumed playback. Without
      // explicit eviction a 58-minute episode could append ~1,700 finished
      // GOPs into one SourceBuffer and exhaust the browser's media memory.
      // Removing behind the decoder is safe; a failed optional trim must not
      // undo a genuinely appended and verified next GOP.
      const played = Number(video.currentTime);
      if (Number.isFinite(played) && played > 45
        && typeof win.buffer.remove === 'function') {
        const trimBefore = played - 30;
        const oldest = buffered.length ? buffered.start(0) : trimBefore;
        if (oldest < trimBefore - 10 && win.mediaSource.readyState === 'open'
          && !win.buffer.updating) {
          try {
            await awaitMseEvent(win.buffer,'updateend',signal,timeoutMs,
              () => win.buffer.remove(0,trimBefore));
          } catch { /* browser may temporarily retain an older decoder frame */ }
        }
      }
      win.endSeconds=segment.endSeconds;
      win.id=segment.id;
      return true;
    }catch{return false;}
    finally{continuing=false;}
  };
  Object.defineProperty(load,'currentWindow',{get(){return currentWindow&&{
    endSeconds:currentWindow.endSeconds,id:currentWindow.id,
    initHash:currentWindow.initHash};}});
  function close() {
    closed = true;
    for (const dispose of [...attachments]) dispose();
  }
  load.close = close;
  return load;
}

function verifiedStandaloneParams(segment, targetSeconds) {
  return segment && SECTION_ID.test(segment.id)
    && finite(segment.startSeconds) && finite(segment.endSeconds)
    && boundedInt(segment.bytes, MAX_SECTION_BYTES)
    && segment.bytes >= 1024
    && finite(targetSeconds) && targetSeconds >= segment.startSeconds
    && targetSeconds + SEEK_AHEAD_SECONDS <= segment.endSeconds;
}
