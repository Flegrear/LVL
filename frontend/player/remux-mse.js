// Optional browser MSE consumer for the existing ONE FFmpeg remux response.
// Fail closed: only copied H.264 SDR + AAC, exact avcC codec, one active
// SourceBuffer. The server records these same bytes in its bounded disk cache.
const MAX_INIT_BYTES = 4 * 1024 * 1024;
const MAX_ATOM_BYTES = 128 * 1024 * 1024;
const MAX_AHEAD_SECONDS = 45;
const KEEP_BEHIND_SECONDS = 90;
const MAX_APPEND_BYTES = 96 * 1024 * 1024;
const MAX_FRAGMENT_BYTES = 16 * 1024 * 1024;
const LIVE_APPEND_CHUNK_BYTES = 256 * 1024;
const MAX_LIVE_MOOF_BYTES = 1024 * 1024;
const RESTORED_GAP_CHECK_MS = 250;
const RESTORED_GAP_APPROACH_SECONDS = 0.5;
const RESTORED_STALL_MS = 5000;
const TOKEN = /^[0-9a-f]{48}$/;

function combine(parts) {
  const total = parts.reduce((count, bytes) => count + bytes.length, 0);
  if (total > MAX_FRAGMENT_BYTES) throw Error('MP4 fragment exceeds MSE budget');
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const bytes of parts) { joined.set(bytes, offset); offset += bytes.length; }
  return joined;
}

// Keep the live SourceBuffer between complete MP4 boxes. A warm disk window
// may only be appended while the parser is at an atom boundary, otherwise a
// replayed moof can be mistaken for bytes belonging to the live mdat.
function createAtomAssembler() {
  let header = new Uint8Array(16), headerBytes = 0, box = null, written = 0;
  return {
    push(input) {
      const ready = [];
      for (let at = 0; at < input.length;) {
        if (!box) {
          const needed = headerBytes >= 8 && new DataView(header.buffer).getUint32(0) === 1
            ? 16 : 8;
          const take = Math.min(needed - headerBytes, input.length - at);
          header.set(input.subarray(at, at + take), headerBytes);
          headerBytes += take;
          at += take;
          if (headerBytes < 8 || (new DataView(header.buffer).getUint32(0) === 1 && headerBytes < 16))
            continue;
          const meta = boxedLength(header.subarray(0, headerBytes), 0);
          if (!meta || meta.size > MAX_FRAGMENT_BYTES) throw Error('Oversized MP4 media atom');
          box = { type: meta.type, bytes: new Uint8Array(meta.size) };
          box.bytes.set(header.subarray(0, headerBytes));
          written = headerBytes;
          headerBytes = 0;
          if (written === meta.size) { ready.push(box); box = null; written = 0; }
          continue;
        }
        const take = Math.min(box.bytes.length - written, input.length - at);
        box.bytes.set(input.subarray(at, at + take), written);
        written += take;
        at += take;
        if (written === box.bytes.length) {
          ready.push(box); box = null; written = 0;
        }
      }
      return ready;
    },
    get complete() { return !box && headerBytes === 0; },
  };
}

function createFragmentAssembler() {
  const atoms = createAtomAssembler();
  let moof = null, prefix = [];
  return {
    push(bytes) {
      const segments = [];
      for (const atom of atoms.push(bytes)) {
        if (atom.type === 'styp' && !moof) prefix.push(atom.bytes);
        else if (atom.type === 'moof' && !moof) moof = atom.bytes;
        else if (atom.type === 'mdat' && moof) {
          segments.push(combine([...prefix, moof, atom.bytes]));
          prefix = []; moof = null;
        } else if (['mfra', 'sidx', 'free', 'skip'].includes(atom.type) && !moof) {
          // These atoms do not carry media samples.
        } else throw Error('Unpaired or unsupported MP4 media atom');
      }
      return segments;
    },
    get complete() { return atoms.complete && !moof && !prefix.length; },
  };
}

// Playback consumes a byte stream, not whole GOP allocations. An individual
// mdat can legitimately exceed the 16 MiB cap used for a *cached read window*.
// Track complete atom boundaries without retaining the large media payload in
// JavaScript; SourceBuffer accepts partial mdat data in ordered append calls.
function createLiveAtomTracker() {
  const header = new Uint8Array(16);
  let headerBytes = 0, remaining = 0, kind = null, pendingMoof = false;
  const headerView = new DataView(header.buffer);
  return {
    push(bytes) {
      for (let at = 0; at < bytes.length;) {
        if (kind === null) {
          const wide = headerBytes >= 8 && headerView.getUint32(0) === 1;
          const needed = wide ? 16 : 8;
          const take = Math.min(needed - headerBytes, bytes.length - at);
          header.set(bytes.subarray(at, at + take), headerBytes);
          headerBytes += take;
          at += take;
          if (headerBytes < 8 || (headerView.getUint32(0) === 1 && headerBytes < 16))
            continue;
          const meta = boxedLength(header.subarray(0, headerBytes), 0);
          if (!meta || meta.type === 'moof' && meta.size > MAX_LIVE_MOOF_BYTES)
            throw Error('Invalid MP4 fragment metadata');
          if (meta.type === 'moof' && !pendingMoof) pendingMoof = true;
          else if (meta.type === 'mdat' && pendingMoof) {}
          else if (!pendingMoof && ['free', 'skip', 'sidx', 'mfra', 'styp'].includes(meta.type)) {}
          else throw Error('Unpaired MP4 fragment atom');
          kind = meta.type;
          remaining = meta.size - meta.header;
          headerBytes = 0;
          if (remaining === 0) {
            if (kind === 'mdat') pendingMoof = false;
            kind = null;
          }
          continue;
        }
        const take = Math.min(bytes.length - at, remaining);
        at += take;
        remaining -= take;
        if (remaining === 0) {
          if (kind === 'mdat') pendingMoof = false;
          kind = null;
        }
      }
    },
    get boundary() { return kind === null && !pendingMoof && !headerBytes; },
  };
}

function boxedLength(bytes, at) {
  if (bytes.length < at + 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + at);
  let size = view.getUint32(0);
  const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
  let header = 8;
  if (size === 1) {
    if (bytes.length < at + 16) return null;
    const wide = view.getBigUint64(8);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Unbounded MP4 box');
    size = Number(wide);
    header = 16;
  }
  if (size < header || size > MAX_ATOM_BYTES) throw Error('Invalid MP4 box');
  return { size, type, header };
}

function initialMp4Bytes(bytes) {
  let at = 0, ftyp = false, moov = false;
  while (at < bytes.length) {
    const box = boxedLength(bytes, at);
    if (!box) return null;
    if (box.type === 'moof') {
      if (!ftyp || !moov) throw Error('Missing MP4 init');
      return { init: bytes.subarray(0, at), remainder: bytes.subarray(at) };
    }
    if (box.type === 'ftyp') ftyp = true;
    else if (box.type === 'moov') moov = true;
    else if (!['free', 'skip', 'sidx', 'styp'].includes(box.type))
      throw Error('Unexpected MP4 initialization atom');
    if (box.type === 'moov' && box.size > MAX_INIT_BYTES) throw Error('Oversized MP4 init');
    if (at + box.size > bytes.length) return null;
    at += box.size;
  }
  return null;
}

function copiedAvcMime(init) {
  // avcC is contained in the moov sample entry. An exact RFC 6381 codec is
  // necessary: a generic avc1 decoder claim is insufficient for a copied GOP.
  let at = -1;
  for (let i = 4; i + 8 < init.length; i += 1) {
    if (init[i] === 97 && init[i + 1] === 118 && init[i + 2] === 99 && init[i + 3] === 67) {
      at = i;
      break;
    }
  }
  if (at < 4 || init[at + 4] !== 1) throw Error('Unverified H.264 decoder config');
  const codec = Array.from(init.subarray(at + 5, at + 8),
    value => value.toString(16).padStart(2, '0')).join('');
  return `video/mp4; codecs="avc1.${codec}, mp4a.40.2"`;
}

function appendBuffer(sourceBuffer, bytes, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || Error('MSE closed'));
    const done = () => {
      sourceBuffer.removeEventListener('updateend', succeed);
      sourceBuffer.removeEventListener('error', failed);
      signal.removeEventListener('abort', failed);
    };
    const succeed = () => { done(); resolve(); };
    const failed = () => { done(); reject(Error('MSE append interrupted')); };
    sourceBuffer.addEventListener('updateend', succeed, { once: true });
    sourceBuffer.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', failed, { once: true });
    try { sourceBuffer.appendBuffer(bytes); }
    catch (error) { done(); reject(error); }
  });
}

function removeBuffer(sourceBuffer, from, to, signal) {
  if (to <= from + 0.1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('MSE closed'));
    const done = () => {
      sourceBuffer.removeEventListener('updateend', succeed);
      sourceBuffer.removeEventListener('error', failed);
      signal.removeEventListener('abort', failed);
    };
    const succeed = () => { done(); resolve(); };
    const failed = () => { done(); reject(Error('MSE eviction failed')); };
    sourceBuffer.addEventListener('updateend', succeed, { once: true });
    sourceBuffer.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', failed, { once: true });
    try { sourceBuffer.remove(from, to); }
    catch (error) { done(); reject(error); }
  });
}

function bufferedAt(ranges, time, lookAhead = 0.18) {
  try {
    for (let i = 0; i < ranges.length; i += 1) {
      if (time >= ranges.start(i) - 0.02 && time + lookAhead <= ranges.end(i))
        return true;
    }
  } catch {}
  return false;
}

export function canUseRemuxMse({ video, media, context } = {}) {
  if (!context?.copyVideo || context.forceH264 || !media?.video) return false;
  const source = media.video;
  if (!['h264', 'avc'].includes(String(source.codec || '').toLowerCase())) return false;
  if (source.dolbyVision || source.hdrKind || source.colorTransfer &&
    !/^(?:bt709|iec61966-2-1)$/i.test(source.colorTransfer)) return false;
  if (source.colorPrimaries && !/^(?:bt709|smpte170m|bt470bg)$/i.test(source.colorPrimaries))
    return false;
  const pixels = String(source.pixelFormat || '').toLowerCase();
  const depth = Number(source.bitDepth || source.bitsPerRawSample) ||
    (/p10|10le|10be|p12|12le|12be/.test(pixels) ? 10 : 8);
  if (depth > 8 || !/^(?:yuvj?420p|nv12)$/.test(pixels))
    return false;
  if (!globalThis.MediaSource?.isTypeSupported ||
    !MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.40.2"')) return false;
  return Boolean(video?.requestVideoFrameCallback && globalThis.fetch && globalThis.AbortController);
}

// Separate opt-in path for video that the backend has actually encoded to
// browser-compatible H.264. Unlike an HEVC copy it needs no original-HEVC
// decoder, but it still must not inherit the H.264-copy disk GOP-cache lease.
// The HTTP response independently confirms the output codec and rejects HDR.
export function canUseEncodedH264Mse({ video, media, context, query } = {}) {
  if (!context?.baseUrl || !media?.video || !query ||
    query.get('video') !== 'h264') return false;
  const source = media.video;
  if (String(source.codec || '').toLowerCase() !== 'hevc'
    || source.dolbyVision || source.hdrKind
    || media.compatibility?.video?.hdr || media.compatibility?.video?.hdrKind
    || ['smpte2084','arib-std-b67'].includes(String(source.colorTransfer || '').toLowerCase())
    || ['bt2020','bt2020nc','bt2020ncl','bt2020c','bt2020cl'].includes(String(source.colorPrimaries || '').toLowerCase())
    || /^bt2020/i.test(String(source.colorSpace || ''))) return false;
  const depth = Number(source.bitDepth || media.compatibility?.video?.bitDepth)
    || (/p10|10le|10be/i.test(String(source.pixelFormat || '')) ? 10 : 8);
  if (depth !== 10) return false;
  if (!globalThis.MediaSource?.isTypeSupported ||
    !MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.40.2"')) return false;
  return Boolean(video?.requestVideoFrameCallback && globalThis.fetch && globalThis.AbortController);
}

export function createRemuxMseSession({video, url, windowUrl, onFailure, isCurrent, fetchImpl = fetch,
  allowEncodedH264 = false} = {}) {
  if (!globalThis.MediaSource || !video || !url) return null;
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  const controller = new AbortController();
  const signal = controller.signal;
  let buffer = null, reader = null, failed = false, ended = false, producerToken = '';
  let liveInit = null, liveTracker = null, windowSerial = 0, windowRequest = null;
  let restoreBlock = null, releaseRestore = null, parkedFailure = null;
  let historicalWindow = null, gapTimer = null;
  let operations = Promise.resolve();
  let totalSinceTrim = 0;
  const isActive = () => !signal.aborted && isCurrent();
  const clearGapTimer = () => {
    if (gapTimer !== null) { clearTimeout(gapTimer); gapTimer = null; }
  };
  const clearHistoricalWindow = () => {
    clearGapTimer();
    historicalWindow = null;
  };
  const serialize = work => {
    const running = operations.then(() => {
      if (!isActive()) throw Error('Old remux playback session');
      return work();
    });
    operations = running.catch(() => {});
    return running;
  };
  const close = () => {
    if (signal.aborted) return;
    clearHistoricalWindow();
    windowSerial++;
    windowRequest?.abort();
    releaseRestore?.();
    for (const event of ['timeupdate', 'waiting', 'playing', 'seeked', 'seeking', 'pause'])
      video.removeEventListener(event, checkPlaybackGap);
    controller.abort('remux source replaced');
    try { reader?.cancel('remux source replaced').catch(() => {}); } catch {}
    URL.revokeObjectURL(objectUrl);
  };
  const fail = error => {
    if (failed || !isActive()) return;
    failed = true;
    clearHistoricalWindow();
    onFailure?.(error);
  };
  const checkPlaybackGap = (event) => {
    if (!isActive() || failed) { clearGapTimer(); return; }
    if (video.paused || video.seeking) { clearGapTimer(); return; }
    const now = Number(video.currentTime) || 0;
    if (parkedFailure) {
      if (!bufferedAt(buffer?.buffered, now, 0.6)) fail(parkedFailure);
      return;
    }
    const historical = historicalWindow;
    if (!historical) return;
    // A restored historical RAP is a finite, verified interval. The live
    // producer might be far ahead, or the only buffered interval may be the
    // restored one. Neither case promises the next decode sample at its end.
    if (now < historical.start - 0.1 || now > historical.end + 0.3) {
      if (historical.entered || event?.type === 'seeked') clearHistoricalWindow();
      return;
    }
    if (!historical.entered) {
      // A restored append alone is not evidence that the new media has played.
      // Gate recovery on an actual playing event (or measurable playback
      // movement) once the browser has data and finished seeking.
      if (Number(video.readyState) < 2) return;
      if (event?.type === 'playing' || event?.type === 'timeupdate' &&
        Number.isFinite(historical.lastTime) && now > historical.lastTime + 0.04) {
        historical.entered = true;
        historical.lastTime = now;
        historical.lastAdvanceAt = Date.now();
      } else {
        historical.lastTime = now;
        return;
      }
    }
    if (now > historical.lastTime + 0.04) {
      historical.lastTime = now;
      historical.lastAdvanceAt = Date.now();
    }
    // Contiguous buffered intervals, even if exposed as separate TimeRanges,
    // are safe to play through. A distant [190,200] cannot extend [30,32].
    let continuousEnd = null;
    try {
      for (let i = 0; i < (buffer?.buffered?.length || 0); i++) {
        const start = buffer.buffered.start(i), end = buffer.buffered.end(i);
        if (continuousEnd === null) {
          if (start <= now + 0.08 && end >= now - 0.08) continuousEnd = end;
        } else if (start <= continuousEnd + 0.08) continuousEnd = Math.max(continuousEnd, end);
        else break;
      }
    } catch {}
    if (continuousEnd !== null && continuousEnd >= historical.end + 0.3) {
      clearHistoricalWindow();
      return;
    }
    // One-way existing native fallback. The bounded poll covers browsers that
    // stop emitting timeupdate/waiting when their last cached GOP runs out.
    const nearGap = historical.end - now <= RESTORED_GAP_APPROACH_SECONDS;
    const stalled = Date.now() - historical.lastAdvanceAt >= RESTORED_STALL_MS;
    if ((nearGap || stalled) && event?.type === 'restored-gap-check') {
      fail(Error('Cached GOP ended before next live GOP'));
      return;
    }
    if (gapTimer === null) gapTimer = setTimeout(() => {
      gapTimer = null;
      checkPlaybackGap({type: 'restored-gap-check'});
    }, RESTORED_GAP_CHECK_MS);
  };
  for (const event of ['timeupdate', 'waiting', 'playing', 'seeked', 'seeking', 'pause'])
    video.addEventListener(event, checkPlaybackGap);
  async function waitUntilOpen() {
    if (mediaSource.readyState === 'open') return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        mediaSource.removeEventListener('sourceopen', ready);
        signal.removeEventListener('abort', aborted);
      };
      const ready = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(Error('MSE closed')); };
      mediaSource.addEventListener('sourceopen', ready, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
  async function throttle() {
    while (isActive()) {
      const now = Number(video.currentTime || 0);
      // The last extent measures producer lead for bounded memory. It might
      // be disjoint from a restored old GOP; checkPlaybackGap handles that
      // separate decode discontinuity without endlessly appending far ahead.
      const ahead = buffer?.buffered?.length
        ? buffer.buffered.end(buffer.buffered.length - 1) - now : 0;
      const tooManyBytes = totalSinceTrim >= MAX_APPEND_BYTES;
      // At high bitrate the 96 MiB limit can arrive before 90 seconds.
      // Retain at least two seconds of decoded context instead of freezing
      // the producer until the playhead reaches an unrelated 90s threshold.
      const keepBehind = tooManyBytes ? 2 : KEEP_BEHIND_SECONDS;
      const trimBefore = now - keepBehind;
      if (trimBefore > 0.5 && buffer?.buffered?.length &&
        buffer.buffered.start(0) + 0.25 < trimBefore) {
        const previousStart = buffer.buffered.start(0);
        const previousEnd = buffer.buffered.end(buffer.buffered.length - 1);
        await serialize(() => removeBuffer(buffer, 0, trimBefore, signal));
        const removedRatio = Math.max(0, Math.min(1,
          (trimBefore - previousStart) / Math.max(0.01, previousEnd - previousStart)));
        // Byte accounting is conservative between trims; SourceBuffer has
        // its own quota guard and failures still fall back to native playback.
        totalSinceTrim = Math.ceil(totalSinceTrim * (1 - removedRatio));
      }
      if (ahead <= MAX_AHEAD_SECONDS && totalSinceTrim < MAX_APPEND_BYTES) return;
      await new Promise(resolve => {
        const settle = () => {
          clearTimeout(timer);
          video.removeEventListener('timeupdate', settle);
          video.removeEventListener('seeking', settle);
          signal.removeEventListener('abort', settle);
          resolve();
        };
        const timer = setTimeout(settle, 600);
        video.addEventListener('timeupdate', settle, { once: true });
        video.addEventListener('seeking', settle, { once: true });
        signal.addEventListener('abort', settle, { once: true });
      });
    }
  }
  async function restoreWindow(absoluteSeconds, baseSeconds) {
    // A distinct GET reads already recorded disk bytes. It never creates a
    // second remux/transcode producer and never alters torrent source state.
    if (!isActive() || failed || !buffer || !liveInit || !windowUrl ||
      !TOKEN.test(producerToken) || !Number.isFinite(absoluteSeconds) ||
      !Number.isFinite(baseSeconds) || absoluteSeconds < baseSeconds || restoreBlock) return false;
    clearHistoricalWindow();
    const serial = ++windowSerial;
    let response = null;
    let releaseThisRestore;
    const thisBlock = new Promise(resolve => { releaseThisRestore = resolve; });
    restoreBlock = thisBlock;
    releaseRestore = releaseThisRestore;
    try {
      windowRequest?.abort();
      windowRequest = new AbortController();
      const query = new URLSearchParams({
        producer: producerToken, start: absoluteSeconds.toFixed(3),
      });
      const requestSignal = AbortSignal.any([signal, windowRequest.signal, AbortSignal.timeout(8000)]);
      response = await fetchImpl(`${windowUrl}?${query}`,
        { signal: requestSignal, cache: 'no-store' });
      if (!isActive() || serial !== windowSerial || !response.ok ||
        response.headers.get('X-LVL-Window-Producer') !== producerToken ||
        response.headers.get('X-LVL-Window-Source-Generation') !== producerToken ||
        !/^video\/mp4(?:;|$)/i.test(response.headers.get('Content-Type') || '')) return false;
      const start = Number(response.headers.get('X-LVL-Window-Start-Seconds'));
      const end = Number(response.headers.get('X-LVL-Window-End-Seconds'));
      const origin = Number(response.headers.get('X-LVL-Window-Base-Seconds'));
      const length = Number(response.headers.get('Content-Length'));
      if (![start,end,origin,length].every(Number.isFinite) ||
        Math.abs(origin - baseSeconds) > 0.003 || start > absoluteSeconds + 0.001 ||
        end < absoluteSeconds + 0.28 || end <= start || length < liveInit.length + 16 ||
        !Number.isSafeInteger(length) || length > MAX_FRAGMENT_BYTES || !response.body) return false;
      const parts = [], windowReader = response.body.getReader();
      let received = 0;
      try {
        for (;;) {
          const part = await windowReader.read();
          if (part.done) break;
          received += part.value.length;
          if (received > length) return false;
          parts.push(part.value);
        }
      } finally { windowReader.releaseLock(); }
      if (received !== length || !isActive() || serial !== windowSerial) return false;
      const bytes = combine(parts);
      const parsed = initialMp4Bytes(bytes);
      if (!parsed || parsed.init.length !== liveInit.length) return false;
      for (let i = 0; i < liveInit.length; i++) {
        if (parsed.init[i] !== liveInit[i]) return false;
      }
      const complete = createFragmentAssembler();
      const fragments = complete.push(parsed.remainder);
      if (!complete.complete || !fragments.length) return false;
      // Do not splice a cached moof into a live mdat. Wait briefly for the
      // ongoing atom to finish, then the producer parks at that boundary.
      const deadline = Date.now() + 2000;
      while (!liveTracker?.boundary && isActive() && serial === windowSerial &&
        Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 30));
      if (!liveTracker?.boundary || !isActive() || serial !== windowSerial) return false;
      await serialize(async () => {
        if (serial !== windowSerial || !isActive() || !liveTracker?.boundary)
          throw Error('Stale cached window');
        for (const fragment of fragments) {
          if (serial !== windowSerial || !isActive())
            throw Error('Cancelled cached window append');
          await appendBuffer(buffer, fragment, signal);
          totalSinceTrim += fragment.length;
        }
      });
      const restored = isActive() && serial === windowSerial &&
        bufferedAt(buffer.buffered, absoluteSeconds - baseSeconds);
      if (restored) historicalWindow = {
        start: start - baseSeconds, end: end - baseSeconds,
        entered: false, lastTime: NaN, lastAdvanceAt: 0,
      };
      return restored;
    } catch { return false; }
    finally {
      if (response?.body && !response.body.locked)
        void response.body.cancel().catch(() => {});
      releaseThisRestore();
      if (restoreBlock === thisBlock) {
        releaseRestore = null;
        restoreBlock = null;
      }
      if (serial === windowSerial) windowRequest = null;
    }
  }
  async function feed() {
    try {
      // The native video element never requests /transcode; this is the one
      // actual remux producer, with normal HTTP backpressure into FFmpeg.
      const response = await fetchImpl(url, {signal, cache:'no-store'});
      if (!isActive()) return;
      const isH264Copy = response.headers.get('X-Media-Video-Mode') === 'copy'
        && response.headers.get('X-Media-Video-Source-Codec') === 'h264';
      const isH264Encode = allowEncodedH264 && response.headers.get('X-Media-Video-Mode') === 'h264'
        && response.headers.get('X-Media-Video-Output-Codec') === 'h264';
      if (!response.ok || !response.body || !(isH264Copy || isH264Encode) ||
        response.headers.get('X-Media-Audio-Output-Codec') !== 'aac' ||
        response.headers.has('X-Media-HDR-Source')) throw Error('Unsupported remux output');
      producerToken = response.headers.get('X-LVL-Remux-Producer') || '';
      reader = response.body.getReader();
      let prefix = new Uint8Array(0), init = null, remainder = null;
      while (!init) {
        const {done, value} = await reader.read();
        if (done) throw Error('No complete MP4 initialization');
        // A single fetch read may contain both a tiny init and megabytes of
        // media. Bound only the actual initialization, not the whole read.
        for (let at = 0; at < value.length && !init;) {
          const take = Math.min(16 * 1024, value.length - at);
          if (prefix.length + take > MAX_INIT_BYTES) throw Error('Oversized MP4 initialization');
          const joined = new Uint8Array(prefix.length + take);
          joined.set(prefix);
          joined.set(value.subarray(at, at + take), prefix.length);
          prefix = joined;
          at += take;
          const parsed = initialMp4Bytes(prefix);
          if (parsed) {
            init = parsed.init;
            remainder = [parsed.remainder, value.subarray(at)];
          }
        }
      }
      const mime = copiedAvcMime(init);
      if (!MediaSource.isTypeSupported(mime)) throw Error('Unsupported H.264 profile for MSE');
      await waitUntilOpen();
      if (!isActive()) return;
      buffer = mediaSource.addSourceBuffer(mime);
      buffer.mode = 'segments';
      liveInit = new Uint8Array(init);
      liveTracker = createLiveAtomTracker();
      await serialize(() => appendBuffer(buffer, init, signal));
      const appendLive = async data => {
        for (let at = 0; at < data.length && isActive();) {
          if (restoreBlock && liveTracker.boundary) await restoreBlock;
          if (!isActive()) return;
          const end = Math.min(data.length, at + LIVE_APPEND_CHUNK_BYTES);
          const part = data.subarray(at, end);
          liveTracker.push(part);
          await serialize(() => appendBuffer(buffer, part, signal));
          totalSinceTrim += part.length;
          at = end;
        }
      };
      for (const part of remainder) if (part.length) await appendLive(part);
      while (isActive()) {
        if (restoreBlock && liveTracker.boundary) await restoreBlock;
        if (liveTracker.boundary) await throttle();
        if (!isActive()) return;
        const {done, value} = await reader.read();
        if (done) { ended = true; break; }
        if (value.length > MAX_ATOM_BYTES) throw Error('Unbounded remux response');
        await appendLive(value);
      }
      if (ended && !liveTracker.boundary) throw Error('Incomplete final MP4 fragment');
      await operations;
      if (ended && isActive() && mediaSource.readyState === 'open' && !buffer.updating)
        mediaSource.endOfStream();
    } catch (error) {
      if (isActive()) {
        if (video.paused && buffer?.buffered &&
          bufferedAt(buffer.buffered, Number(video.currentTime) || 0, 0.1)) {
          parkedFailure = error;
          // No new producer while intentionally paused with valid frames.
          // Recover only when resumed playback approaches the real end.
        } else fail(error);
      }
    } finally {
      try { reader?.releaseLock(); } catch {}
    }
  }
  void feed();
  return {objectUrl, close, restoreWindow,
    cancelRestore() {
      windowSerial++; windowRequest?.abort(); windowRequest = null;
      releaseRestore?.();
      clearHistoricalWindow();
    },
    get producerToken(){return producerToken;},
    // Browser TimeRanges may outlive the underlying HTTP/FFmpeg producer
    // after a very long pause. Expose transport liveness separately from the
    // presence of one cached frame so resuming can make forward progress.
    get needsResumeRefresh(){return failed || Boolean(parkedFailure) || ended;},
    contains(localTime) {
      return isActive() && Boolean(buffer?.buffered) &&
        bufferedAt(buffer.buffered, localTime);
    },
    get buffered(){ return buffer?.buffered || null; },
    get ended(){return ended;},
  };
}
