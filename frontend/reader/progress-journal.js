// Durable, bounded reader save-intent journal. This is not page authority:
// only a verified backend response for the SAME operation retires the entry.
// Replaying without server CAS is deliberately disabled; a stale number cannot
// overwrite a later accepted page or a new provider/source generation.
export const READER_PROGRESS_JOURNAL_KEY = "lvl-comics-reader-progress-pending-v1";
export const READER_PROGRESS_JOURNAL_MAX = 128;
const WORK = /^(?:anilist-[1-9]\d{0,9}|local-[0-9a-f]{12})$/;
const UNIT = /^(?:f[0-9a-f]{16}|ex-[0-9a-f]{20})$/;
const SOURCE = /^[A-Za-z0-9_.:-]{1,100}$/;
const REVISION = /^[A-Za-z0-9-]{1,120}$/;
const WITNESS = /^[0-9a-f]{24}$/;
const OPERATION = /^[0-9a-f-]{20,72}$/i;
const MAX_BYTES = 128 * 1024;
const isInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const identityKey = (workId, fileId) => JSON.stringify([workId, fileId]);

// Only an actual successful response for this exact operation, work, unit
// and page may retire a durable pending snapshot.
export function matchesReaderProgressReceipt(response, sent) {
  const receipt = response?.progressReceipt;
  const payload = sent?.payload;
  const version = payload?.version ?? 1;
  return Boolean(receipt && sent?.operationId && payload
    && receipt.operationId === sent.operationId && receipt.workId === sent.workId
    && receipt.fileId === sent.payload?.fileId
    && receipt.page === sent.payload?.page && receipt.pages === sent.payload?.pages
    && receipt.version === version && (version === 1 || version === 2)
    && isInteger(receipt.generation) && isInteger(receipt.expectedGeneration)
    && receipt.generation > receipt.expectedGeneration
    && receipt.sourceId === sent.payload.sourceId
    && receipt.contentWitness === sent.payload.contentWitness
    && receipt.expectedGeneration === sent.payload.expectedGeneration
    && (version !== 2 || (receipt.predecessorOperationId === sent.payload.predecessorOperationId
      && receipt.predecessorGeneration === sent.payload.predecessorGeneration)));
}

// A late accepted response may belong to a previous mounted provider or an
// earlier peer generation. It can acknowledge its exact durable journal row,
// but must never replace the GET-established generation of the current owner.
export function reconcileReaderProgressGeneration(prior, { sourceId, contentWitness,
  generation, receipt = null, sent = null, duplicate = false } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 0) return prior ?? null;
  const same = prior != null && prior.sourceId === sourceId && prior.contentWitness === contentWitness;
  if (!receipt) return { sourceId, contentWitness,
    generation: same ? Math.max(prior.generation, generation) : generation,
    lastAccepted: null };
  if (!same || receipt.operationId !== sent?.operationId
    || receipt.sourceId !== sourceId || receipt.contentWitness !== contentWitness
    || receipt.expectedGeneration !== sent?.payload?.expectedGeneration
    || receipt.generation !== generation) return prior ?? null;
  const accepted = duplicate === true
    ? sent?.recovered === true && prior.generation === generation
    : prior.generation === receipt.expectedGeneration && generation > prior.generation;
  // Do not promote a stale/out-of-order receipt into current causal authority.
  if (!accepted) return prior;
  return { sourceId, contentWitness, generation,
    lastAccepted: { operationId: receipt.operationId,
      previousGeneration: receipt.expectedGeneration, generation } };
}

// Current mounted HTTP GET must prove exact canonical owner, unit, source,
// manifest/content witness and page count before an old operation is retried.
// A different server generation is acceptable for the exact SAME operation:
// the server will return its original receipt or a safe 409 CAS conflict.
export function canReplayReaderProgress(pending, { workId, fileId, sourceId,
  contentWitness, pages, generation } = {}) {
  return Boolean(pending && (pending.version === 1 || pending.version === 2) && pending.workId === workId
    && pending.fileId === fileId && pending.sourceId === sourceId
    && (fileId?.startsWith("ex-") ? pending.pageWitness : pending.revision) === contentWitness
    && pending.pages === pages && Number.isSafeInteger(pending.expectedGeneration)
    && pending.expectedGeneration >= 0 && Number.isSafeInteger(generation)
    && generation >= 0 && OPERATION.test(pending.operationId || "")
    && (pending.version === 1 ? pending.predecessorOperationId == null
      && pending.predecessorGeneration == null
      : OPERATION.test(pending.predecessorOperationId || "")
        && pending.predecessorOperationId !== pending.operationId
        && pending.predecessorGeneration === pending.expectedGeneration));
}

// Pure provenance gate: only a NEW, durably unsent v1 snapshot may inherit
// the exact preceding acknowledged generation of the same owner and content.
// A GET token (no lastAccepted), already-sent record or intervening generation
// cannot create a successor; the SQLite v2 producer verifies it again.
export function readerProgressChainProof(pending, token) {
  const proof = token?.lastAccepted;
  const witness = pending?.fileId?.startsWith("ex-") ? pending.pageWitness : pending?.revision;
  if (!pending || pending.version !== 1 || pending.dispatched !== false
    || !OPERATION.test(pending.operationId || "") || !proof
    || !OPERATION.test(proof.operationId || "") || proof.operationId === pending.operationId
    || pending.sourceId !== token.sourceId || witness !== token.contentWitness
    || pending.expectedGeneration !== proof.previousGeneration
    || token.generation !== proof.generation
    || !isInteger(proof.previousGeneration) || !isInteger(proof.generation)
    || proof.generation <= proof.previousGeneration) return null;
  return { previousGeneration: proof.previousGeneration,
    predecessorOperationId: proof.operationId, predecessorGeneration: proof.generation,
    sourceId: pending.sourceId, contentWitness: witness };
}

export function createReaderProgressJournal({ storage, key = READER_PROGRESS_JOURNAL_KEY,
  maxEntries = READER_PROGRESS_JOURNAL_MAX, operationId = () => globalThis.crypto.randomUUID() } = {}) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function")
    throw new Error("Durable reading-progress storage is unavailable");
  const read = () => {
    const raw = storage.getItem(key);
    if (raw == null) return { version: 1, nextSequence: 0, records: {}, inflight: {} };
    if (raw.length > MAX_BYTES) throw new Error("Reading-progress journal exceeds its safety budget");
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error("Unreadable reading-progress journal; preserving original bytes"); }
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.nextSequence)
      || value.nextSequence < 0 || !value.records || typeof value.records !== "object"
      || Array.isArray(value.records) || (value.inflight !== undefined
        && (!value.inflight || typeof value.inflight !== "object" || Array.isArray(value.inflight))))
      throw new Error("Unsupported reading-progress journal; preserving original bytes");
    if ([...Object.values(value.records), ...Object.values(value.inflight || {})]
      .some((row) => row?.version !== 1 && row?.version !== 2))
      throw new Error("Unsupported reading-progress journal entries; preserving original bytes");
    // Additive v1 root shape. Unknown future row types remain opaque in both
    // maps and must never be silently replaced or retired.
    value.inflight ||= {};
    return value;
  };
  const write = (value) => {
    const raw = JSON.stringify(value);
    if (raw.length > MAX_BYTES) throw new Error("Reading-progress journal is full; no records discarded");
    storage.setItem(key, raw);
  };
  const valid = (entry) => {
    if (!WORK.test(String(entry?.workId || "")) || !UNIT.test(String(entry?.fileId || ""))) return false;
    const remote = entry.fileId.startsWith("ex-");
    if (remote && (!SOURCE.test(String(entry.sourceId || "")) || !WITNESS.test(String(entry.pageWitness || "")))) return false;
    if (!remote && (entry.sourceId !== "local" || !REVISION.test(String(entry.revision || "")))) return false;
    return isInteger(entry.page) && isInteger(entry.pages) && entry.pages > 0 && entry.page < entry.pages
      && typeof entry.finished === "boolean"
      && (entry.expectedGeneration === undefined || isInteger(entry.expectedGeneration));
  };
  const understood = (row) => Boolean(row && (row.version === 1 || row.version === 2)
    && valid(row) && OPERATION.test(row.operationId || "")
    && (row.version === 1 ? row.predecessorOperationId == null
      && row.predecessorGeneration == null
      : OPERATION.test(row.predecessorOperationId || "")
        && row.predecessorOperationId !== row.operationId
        && row.predecessorGeneration === row.expectedGeneration));
  const size = (value) => Object.keys(value.records).length + Object.keys(value.inflight).length;
  return {
    pending(workId, fileId) {
      if (!WORK.test(String(workId)) || !UNIT.test(String(fileId))) return null;
      const value = read();
      const older = Object.values(value.inflight).filter((row) =>
        row?.workId === workId && row?.fileId === fileId).sort((a, b) => a.sequence - b.sequence);
      const row = older[0] || value.records[identityKey(workId, fileId)];
      return understood(row) ? { ...row } : null;
    },
    record(entry) {
      if (!valid(entry)) throw new Error("Unverified work, unit or source cannot enter the reading-progress journal");
      if (!isInteger(entry.expectedGeneration))
        throw new Error("Reader progress generation is unavailable; pending record not replaced");
      const value = read();
      const owner = identityKey(entry.workId, entry.fileId);
      const previous = value.records[owner];
      if (previous && !understood(previous))
        throw new Error("Unknown pending reader operation; preserving its original bytes");
      if (Object.values(value.inflight).some((row) => row?.workId === entry.workId
        && row?.fileId === entry.fileId && !understood(row)))
        throw new Error("Unknown in-flight reader operation; preserving its original bytes");
      const preservePrevious = previous && previous.dispatched !== false;
      if (size(value) + (!previous || preservePrevious ? 1 : 0) > maxEntries)
        throw new Error("Reading-progress journal has reached its capacity; existing saves are preserved");
      if (!Number.isSafeInteger(value.nextSequence + 1)) throw new Error("Reading-progress sequence overflow");
      const op = String(operationId());
      if (!OPERATION.test(op)) throw new Error("No cryptographically unique reading-progress operation ID");
      if (Object.values(value.records).some((row) => row?.operationId === op)
        || Object.hasOwn(value.inflight, op))
        throw new Error("Reading-progress operation ID collision; existing saves preserved");
      const row = { version: 1, dispatched: false, workId: entry.workId, fileId: entry.fileId,
        sourceId: entry.sourceId, ...(entry.revision ? { revision: entry.revision } : {}),
        ...(entry.pageWitness ? { pageWitness: entry.pageWitness } : {}),
        page: entry.page, pages: entry.pages, finished: entry.finished,
        expectedGeneration: entry.expectedGeneration, chapter: entry.chapter ?? null,
        volume: entry.volume ?? null,
        sequence: value.nextSequence + 1, operationId: op };
      value.nextSequence = row.sequence;
      // Never overwrite an already-sent or uncertain operation with a new
      // snapshot. Keep its original ID, digest inputs and generation across
      // close/reload so an eventual duplicate receipt can be reconciled first.
      if (preservePrevious) value.inflight[previous.operationId] = previous;
      value.records[owner] = row;
      write(value); // synchronous durable admission BEFORE network dispatch
      return { ...row };
    },
    // A queued, never-dispatched replacement can use the generation returned
    // by the immediately preceding same-unit accepted operation. The caller
    // MUST NOT rebase a previously sent/crashed operation: its original digest
    // is required for exact idempotent duplicate recognition.
    rebaseUnsent(workId, fileId, operationId, { previousGeneration, predecessorOperationId,
      predecessorGeneration, sourceId, contentWitness } = {}) {
      if (!isInteger(previousGeneration) || !isInteger(predecessorGeneration)
        || predecessorGeneration <= previousGeneration || !OPERATION.test(predecessorOperationId || ""))
        throw new Error("Unverified predecessor operation generation");
      const value = read();
      const row = value.records[identityKey(workId, fileId)];
      if (!understood(row) || row.version !== 1 || row.dispatched !== false
        || row.operationId !== operationId || row.operationId === predecessorOperationId
        || row.expectedGeneration !== previousGeneration || row.sourceId !== sourceId
        || (fileId.startsWith("ex-") ? row.pageWitness : row.revision) !== contentWitness)
        return null;
      row.version = 2;
      row.expectedGeneration = predecessorGeneration;
      row.predecessorOperationId = predecessorOperationId;
      row.predecessorGeneration = predecessorGeneration;
      write(value);
      return { ...row };
    },
    hasUncertainPredecessor(workId, fileId, operationId) {
      const value = read();
      return Object.values(value.inflight).some((row) => row?.workId === workId
        && row?.fileId === fileId && row.operationId !== operationId);
    },
    markDispatched(workId, fileId, op) {
      const value = read();
      const row = value.records[identityKey(workId, fileId)]?.operationId === op
        ? value.records[identityKey(workId, fileId)] : value.inflight[op];
      if (!understood(row) || row.workId !== workId || row.fileId !== fileId) return null;
      if (row.dispatched !== true) { row.dispatched = true; write(value); }
      return { ...row };
    },
    acknowledge(workId, fileId, op) {
      if (!WORK.test(String(workId)) || !UNIT.test(String(fileId)) || !OPERATION.test(String(op))) return false;
      const value = read();
      const owner = identityKey(workId, fileId);
      if (value.records[owner]?.operationId === op && understood(value.records[owner]))
        delete value.records[owner];
      else if (value.inflight[op]?.workId === workId && value.inflight[op]?.fileId === fileId
        && understood(value.inflight[op])) delete value.inflight[op];
      else return false;
      write(value);
      return true;
    },
    retireWork(workId) {
      if (!WORK.test(String(workId))) return false;
      const value = read();
      let count = 0;
      for (const [key, row] of Object.entries(value.records)) {
        if (row?.workId !== workId) continue;
        if (!understood(row)) continue; // unknown schema/data is never silently destroyed
        delete value.records[key];
        count++;
      }
      for (const [key, row] of Object.entries(value.inflight)) {
        if (row?.workId !== workId || !understood(row)) continue;
        delete value.inflight[key];
        count++;
      }
      if (count) write(value);
      return count > 0;
    },
    inspect() {
      const value = read();
      return { version: value.version, nextSequence: value.nextSequence,
        pending: size(value), maxEntries };
    },
  };
}
