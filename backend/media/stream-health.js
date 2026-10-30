// STREAM-01/02. Bounded, read-only instrumentation of actual WebTorrent Range
// readers. A caller-provided offset is never proof of a video playhead.
const MAX_ACTIVE_READERS = 48;
const MAX_RECENT_READERS = 16;
const SLOW_AFTER_MS = 8_000;
const SLOW_BYTES_PER_SECOND = 16 * 1024;

const safeNumber = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function pieceAt(torrent, file, offset) {
  const fileLength = safeInteger(file?.length);
  const fileOffset = safeInteger(file?.offset);
  const pieceLength = safeInteger(torrent?.pieceLength);
  if (fileLength === null || fileOffset === null || !pieceLength ||
      !torrent?.bitfield || typeof torrent.bitfield.get !== 'function' ||
      !Number.isSafeInteger(offset) || offset < 0 || offset >= fileLength) return null;
  const absoluteOffset = fileOffset + offset;
  if (!Number.isSafeInteger(absoluteOffset)) return null;
  const pieceIndex = Math.floor(absoluteOffset / pieceLength);
  try {
    const result = torrent.bitfield.get(pieceIndex);
    return typeof result === 'boolean' ? result : result === 1 ? true : result === 0 ? false : null;
  } catch { return null; }
}

function condition({ requestedRangeActive, piecePresent, peers, speed, ageMs, firstByteMs }) {
  if (!requestedRangeActive) return 'offset-not-active';
  if (piecePresent === true) return 'available';
  if (piecePresent === null) return 'unknown';
  if (peers === 0) return 'no-peers';
  if (peers === null) return 'missing-piece';
  if (firstByteMs !== null) return 'missing-piece';
  if (ageMs >= SLOW_AFTER_MS && speed !== null && speed < SLOW_BYTES_PER_SECOND) return 'slow-source';
  return 'waiting-for-piece';
}

/** Session is an in-memory object key; no name, URL, hash or session ID is serialized. */
export function createStreamHealth({ now = Date.now, maxActive = MAX_ACTIVE_READERS } = {}) {
  const states = new WeakMap();
  const capacity = Math.max(1, Math.min(MAX_ACTIVE_READERS, Number.isInteger(maxActive) ? maxActive : MAX_ACTIVE_READERS));
  function stateFor(session) {
    let state = states.get(session);
    if (!state) {
      state = { active: new Map(), recent: [], nextId: 0, overflow: 0 };
      states.set(session, state);
    }
    return state;
  }
  function begin(session, { fileIndex, start, end, role = 'unknown' } = {}) {
    if (!session || typeof session !== 'object' || safeInteger(fileIndex) === null ||
        safeInteger(start) === null || safeInteger(end) === null || end < start) {
      return { firstByte() {}, progress() {}, end() {} };
    }
    const state = stateFor(session);
    if (state.active.size >= capacity) {
      state.overflow++;
      let closed = false;
      return { firstByte() {}, progress() {}, end() { if (!closed) { closed = true; state.overflow = Math.max(0, state.overflow - 1); } } };
    }
    const id = ++state.nextId;
    const startAt = now();
    // Internal callers must supply this fixed vocabulary. Never trust a role
    // supplied by a query string, Origin, User-Agent or Sec-Fetch header.
    const reader = { fileIndex, start, end, role: ['browser-direct', 'probe', 'subtitle', 'speech', 'conversion'].includes(role)
      ? role : 'unknown', startAt, firstByteMs: null, bytesDelivered: 0 };
    state.active.set(id, reader);
    let closed = false;
    return {
      firstByte() {
        if (closed || state.active.get(id) !== reader || reader.firstByteMs !== null) return;
        reader.firstByteMs = Math.max(0, Math.round(now() - startAt));
      },
      progress(bytes) {
        if (closed || state.active.get(id) !== reader ||
            !Number.isSafeInteger(bytes) || bytes <= 0) return;
        if (reader.firstByteMs === null) reader.firstByteMs = Math.max(0, Math.round(now() - startAt));
        // Readable data events establish delivered bytes, not the media playhead.
        // Clamp to the actual requested range, including a one-byte final piece.
        reader.bytesDelivered = Math.min(end - start + 1, reader.bytesDelivered + bytes);
      },
      end(reason = 'closed') {
        if (closed) return;
        closed = true;
        if (state.active.get(id) !== reader) return;
        state.active.delete(id);
        state.recent.push({ fileIndex, role: reader.role, start, end, firstByteMs: reader.firstByteMs,
          bytesDelivered: reader.bytesDelivered,
          elapsedMs: Math.max(0, Math.round(now() - startAt)),
          outcome: ['complete', 'cancel', 'error'].includes(reason) ? reason : 'closed' });
        if (state.recent.length > MAX_RECENT_READERS) state.recent.shift();
      },
    };
  }
  function snapshot(session, { torrent = session?.torrent, fileIndex = null, offset = null } = {}) {
    const state = states.get(session);
    const allActive = state ? [...state.active.values()] : [];
    const selectedFile = safeInteger(fileIndex);
    const selectedOffset = safeInteger(offset);
    const file = selectedFile === null ? null : torrent?.files?.[selectedFile];
    const peers = safeInteger(torrent?.numPeers);
    const speed = safeNumber(torrent?.downloadSpeed);
    const observed = allActive.filter(reader => selectedFile === null || reader.fileIndex === selectedFile);
    const readerPosition = reader => Math.min(reader.end, reader.start + reader.bytesDelivered);
    const pendingPiece = reader => reader.bytesDelivered >= reader.end - reader.start + 1
      ? null : pieceAt(torrent, torrent?.files?.[reader.fileIndex], readerPosition(reader));
    const readers = observed.map(reader => ({
      role: reader.role, start: reader.start, end: reader.end,
      ageMs: Math.max(0, Math.round(now() - reader.startAt)), firstByteMs: reader.firstByteMs,
      bytesDelivered: reader.bytesDelivered, nextByteOffset: readerPosition(reader),
      nextPiecePresent: pendingPiece(reader),
      firstPiecePresent: pieceAt(torrent, torrent?.files?.[reader.fileIndex], reader.start),
    }));
    // A read observed on this session is an actual byte request, but it might
    // be a probe or subtitle extractor. Only the next undelivered byte can
    // describe a stalled Range; a piece served earlier is not current availability.
    // All offsets here are byte positions within the file, NEVER the playhead.
    const waitingReaders = observed.filter(reader => reader.bytesDelivered < reader.end - reader.start + 1);
    const latestObserved = waitingReaders.length ? waitingReaders[waitingReaders.length - 1] : null;
    const latestPiecePresent = latestObserved ? pendingPiece(latestObserved) : null;
    const observedRangeStatus = latestObserved
      ? condition({ requestedRangeActive: true, piecePresent: latestPiecePresent, peers, speed,
        ageMs: Math.max(0, now() - latestObserved.startAt), firstByteMs: latestObserved.firstByteMs })
      : (observed.length ? 'unknown' : 'no-active-reader');
    const matched = selectedOffset === null ? null : allActive
      .filter(reader => reader.fileIndex === selectedFile && reader.start <= selectedOffset && reader.end >= selectedOffset)
      .sort((a, b) => b.startAt - a.startAt)[0] || null;
    const requestedRangeActive = Boolean(matched);
    const requestedPiecePresent = matched ? pieceAt(torrent, file, selectedOffset) : null;
    const conditionCode = selectedOffset === null ? observedRangeStatus
      : condition({ requestedRangeActive, piecePresent: requestedPiecePresent, peers, speed,
        ageMs: matched ? Math.max(0, now() - matched.startAt) : 0, firstByteMs: matched?.firstByteMs ?? null });
    return {
      activeReaderCount: allActive.length + (state?.overflow || 0),
      observedReaderCount: observed.length,
      competingReaderCount: matched ? Math.max(0, allActive.length + (state?.overflow || 0) - 1) : null,
      observationComplete: !state?.overflow, peers, downloadBytesPerSecond: speed,
      readers, observedMissingActiveRange: readers.some(reader => reader.nextPiecePresent === false),
      observedRangeStatus, requestedOffset: selectedOffset, requestedRangeActive,
      requestedPiecePresent, status: conditionCode,
      statusSource: selectedOffset === null ? (latestObserved ? 'observed-reader' : 'none') : 'requested-offset',
      playheadVerified: false,
      recentReaders: (state?.recent || []).filter(reader => selectedFile === null || reader.fileIndex === selectedFile)
        .slice(-MAX_RECENT_READERS).map(({ role, start, end, firstByteMs, bytesDelivered, elapsedMs, outcome }) =>
          ({ role, start, end, firstByteMs, bytesDelivered, elapsedMs, outcome })),
    };
  }
  return { begin, snapshot, clear: session => states.delete(session) };
}
