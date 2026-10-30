import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function piece(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return app.slice(from, to);
}
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(initial, { legacyDirty = null, tabPending = null } = {}) {
  let remote = clone(initial);
  let revision = 10;
  let writes = [];
  let releaseSuccessAck = null;
  let holdNextSuccessAck = false;
  let successAckHeld = false;
  let holdNextPutBeforeServer = false;
  let releaseBeforeServerPut = null;
  let putHeldBeforeServer = false;
  const warnings = [];
  const stored = new Map([
    ['blackline-db-migrated-v1', '1'],
    ['blackline-db-preferences-v2', '1'],
  ]);
  if (legacyDirty) stored.set('blackline-db-dirty-sections-v1', JSON.stringify({
    library: { mode: 'replace', expectedUpdatedAt: 2 },
  }));
  const tabStorage = new Map();
  if (tabPending) tabStorage.set('blackline-db-library-pending-tab-v1', JSON.stringify(tabPending));
  const state = { library: clone(legacyDirty || []) };
  const ctx = vm.createContext({
    JSON, Number, Map, Set, Date, console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    setTimeout, clearTimeout,
    state,
    sessionStorage: {
      getItem: key => tabStorage.get(key) ?? null,
      setItem: (key, value) => tabStorage.set(key, String(value)),
      removeItem: key => tabStorage.delete(key),
    },
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: key => stored.delete(key),
    },
    localCopyUnloaded: new Set(),
    localCopyMissing: () => new Set(),
    LOCAL_COPY_SECTIONS: {},
    persistentAppSnapshot: () => ({ library: state.library }),
    persistentPreferencesSnapshot: () => ({}),
    applyPersistentAppState: snap => { state.library = clone(snap.library); },
    storeLocalCopy() {},
    migrateLearningState() {}, backfillPersistedChapterAutoCards() {}, renderAll() {}, applySubtitleStyle() {},
    learningEnabled: false,
    postJson: async (url, data) => {
      if (url === '/api/app-state/bootstrap')
        return { initialized: true, revisions: { library: revision }, state: { library: clone(remote) } };
      assert.equal(url, '/api/app-state/library');
      if (holdNextPutBeforeServer) {
        holdNextPutBeforeServer = false;
        putHeldBeforeServer = true;
        await new Promise(resolve => { releaseBeforeServerPut = resolve; });
      }
      writes.push({ data: clone(data), revisionAtRequest: revision });
      if (data.expectedUpdatedAt !== revision) {
        const error = Error('Persistent library changed in another app session');
        error.status = 409;
        error.data = { error: 'app_state_conflict', section: 'library', currentUpdatedAt: revision };
        throw error;
      }
      remote = clone(data.value);
      revision++;
      const result = { updatedAt: revision };
      if (holdNextSuccessAck) {
        holdNextSuccessAck = false;
        successAckHeld = true;
        return new Promise(resolve => { releaseSuccessAck = () => resolve(result); });
      }
      return result;
    },
    fetchJson: async url => {
      if (url === '/api/app-state/library')
        return { section: 'library', value: clone(remote), updatedAt: revision };
      assert.equal(url, '/api/app-state');
      return { state: { library: clone(remote) }, revisions: { library: revision } };
    },
  });
  vm.runInContext(piece('const APP_DB_MIGRATION_KEY =', '\nconst artworkFetches'), ctx);
  vm.runInContext(piece('function persistBlockedLibraryChange(', '\nfunction persistPreferences('), ctx);
  vm.runInContext(piece('async function hydratePersistentAppState(', '\nconst SPEECH_LOCALES'), ctx);
  const hydrate = () => vm.runInContext('hydratePersistentAppState', ctx)();
  const save = items => {
    state.library = clone(items);
    vm.runInContext('persistAppSection', ctx)('library', state.library, { immediate: true });
  };
  const drain = async () => { for (let i = 0; i < 7; i++) await tick(); };
  return { ctx, state, hydrate, save, drain, warnings,
    get remote() { return clone(remote); }, get revision() { return revision; },
    get writes() { return writes; },
    holdNextAcceptedAck() { holdNextSuccessAck = true; },
    holdNextPutBeforeServer() { holdNextPutBeforeServer = true; },
    get hasHeldPutBeforeServer() { return putHeldBeforeServer; },
    releaseHeldServerPut() {
      assert.ok(releaseBeforeServerPut, 'server-side PUT gate was not reached');
      releaseBeforeServerPut();
      releaseBeforeServerPut = null;
    },
    get hasHeldAck() { return successAckHeld; },
    releaseAcceptedAck() {
      assert.ok(releaseSuccessAck, 'successful CAS acknowledgment has not been deferred');
      releaseSuccessAck();
      releaseSuccessAck = null;
    },
    get dirty() { return JSON.parse(stored.get('blackline-db-dirty-sections-v1') || '{}'); },
    get tabPending() {
      const pending = JSON.parse(tabStorage.get('blackline-db-library-pending-tab-v1') || 'null');
      return Array.isArray(pending) ? pending : pending?.value ?? null;
    },
    get tabPendingRecord() {
      return clone(JSON.parse(tabStorage.get('blackline-db-library-pending-tab-v1') || 'null'));
    },
    // A page crash discards queued JS jobs but preserves its sessionStorage and
    // the on-disk state. Give the next VM an isolated snapshot of both stores.
    reopenAfterCrash() {
      const saved = JSON.parse(tabStorage.get('blackline-db-library-pending-tab-v1') || 'null');
      const next = fixture(remote, { legacyDirty: saved?.value ?? saved ?? [], tabPending: saved });
      next.replaceDisk(remote, revision);
      return next;
    },
    replaceDisk(items, newRevision) {
      remote = clone(items);
      revision = newRevision;
    },
    forgeSharedDirtyRevision(updatedAt) {
      stored.set('blackline-db-dirty-sections-v1',
        JSON.stringify({ library: { mode: 'replace', expectedUpdatedAt: updatedAt } }));
    },
    otherTabSet(items) { remote = clone(items); revision++; },
  };
}

test('RED: disjoint Library additions from two tabs survive one bounded CAS rebase', async () => {
  const f = fixture([{ id: 'original', title: 'Keep' }]);
  await f.hydrate();
  f.otherTabSet([{ id: 'original', title: 'Keep' }, { id: 'other-tab', title: 'Other' }]);
  f.save([...f.state.library, { id: 'my-new', title: 'Mine' }]);
  await f.drain();
  assert.deepEqual(f.remote.map(x => x.id), ['original', 'other-tab', 'my-new']);
  assert.equal(f.writes.length, 2, 'exactly one CAS retry after conflict');
  assert.equal(f.dirty.library, undefined);
  assert.deepEqual(f.state.library.map(x => x.id), ['original', 'other-tab', 'my-new']);
});

test('forged newer revision in shared localStorage never authorizes stale full-section overwrite', async () => {
  const f = fixture([{ id: 'first', title: 'Original' }]);
  await f.hydrate();
  f.otherTabSet([{ id: 'first', title: 'Original' }, { id: 'from-second-tab', title: 'Added elsewhere' }]);
  // Simulate a race where tab B wrote its valid N+1 revision into the origin-
  // shared dirty metadata that tab A is reading before posting stale contents.
  f.forgeSharedDirtyRevision(f.revision);
  f.save([{ id: 'first', title: 'Original' }, { id: 'mine', title: 'Mine' }]);
  await f.drain();
  assert.equal(f.writes[0].data.expectedUpdatedAt, 10,
    'must use the revision verified by this tab, NEVER the shared dirty marker');
  assert.deepEqual(f.remote.map(x => x.id), ['first', 'from-second-tab', 'mine']);
});

test('legacy dirty startup preserves tab-local pending data and safely saves later disjoint edits', async () => {
  const pending = [{ id: 'deleted-by-other-tab', title: 'Unsaved old view' }];
  const f = fixture([{ id: 'authoritative', title: 'In SQLite' }], {
    legacyDirty: [{ id: 'stale-localStorage-copy', title: 'Wrong tab cache' }],
    tabPending: pending,
  });
  await f.hydrate();
  assert.deepEqual(f.state.library.map(x => x.id), ['deleted-by-other-tab']);
  assert.equal(f.writes.length, 0, 'legacy dirty whole-section snapshot cannot automatically replace SQLite');
  f.save([...f.state.library, { id: 'new-intent', title: 'New addition' }]);
  await f.drain();
  assert.deepEqual(f.remote.map(x => x.id), ['authoritative', 'new-intent']);
  assert.deepEqual(f.state.library.map(x => x.id), ['deleted-by-other-tab', 'new-intent']);
  assert.ok(f.dirty.library, 'original ambiguous unsaved intent is not cleared');
  assert.deepEqual(f.tabPending.map(x => x.id), ['deleted-by-other-tab', 'new-intent']);
});

test('interrupted tab-owned Library PUT safely resumes at the exact verified unchanged SQLite revision', async () => {
  const before = [{ id: 'old', title: 'Original' }];
  const pending = [...before, { id: 'new', title: 'Unsaved before restart' }];
  const f = fixture(before, {
    legacyDirty: pending,
    tabPending: { value: pending, expectedUpdatedAt: 10, certifiedBaseRevision: 10, safeToReplay: true },
  });
  await f.hydrate();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].data.expectedUpdatedAt, 10);
  assert.deepEqual(f.remote.map(x => x.id), ['old', 'new']);
  assert.equal(f.dirty.library, undefined);
  assert.equal(f.tabPending, null);
});

test('tab-owned interrupted PUT cannot override SQLite after another tab advanced the revision', async () => {
  const pending = [{ id: 'stale', title: 'Waiting' }];
  const f = fixture([{ id: 'current', title: 'Still saved' }], {
    legacyDirty: pending,
    tabPending: { value: pending, expectedUpdatedAt: 9, certifiedBaseRevision: 9, safeToReplay: true },
  });
  await f.hydrate();
  assert.equal(f.writes.length, 0, 'verified revision 9 cannot authorize replacing revision 10');
  assert.deepEqual(f.remote.map(x => x.id), ['current']);
  assert.deepEqual(f.state.library.map(x => x.id), ['stale']);
  assert.ok(f.dirty.library);
  assert.deepEqual(f.tabPending.map(x => x.id), ['stale']);
});

test('legacy pending shadow without explicit replay certificate cannot CAS even on a matching revision', async () => {
  const original = [{ id: 'X', title: 'Remote X survives' }];
  const unsafe = [{ id: 'X', title: 'Old X from stale visible Library' }];
  const f = fixture(original, {
    legacyDirty: unsafe,
    tabPending: { value: unsafe, expectedUpdatedAt: 10 },
  });
  await f.hydrate();
  assert.equal(f.writes.length, 0, 'a revision match without safeToReplay is not proof of an untouched base');
  assert.equal(f.remote[0].title, 'Remote X survives');
  assert.equal(f.state.library[0].title, 'Old X from stale visible Library');
  assert.ok(f.dirty.library);
});

test('clean in-tab unsaved Library snapshot alone receives a bound replay certificate', async () => {
  const f = fixture([{ id: 'X', title: 'Clean original' }]);
  await f.hydrate();
  f.save([{ id: 'X', title: 'Clean original' }, { id: 'Y', title: 'New' }]);
  const pending = f.tabPendingRecord;
  assert.equal(pending.safeToReplay, true);
  assert.equal(pending.expectedUpdatedAt, 10);
  assert.equal(pending.certifiedBaseRevision, 10);
  // The original page disappears before its queued PUT executes.
  const restarted = f.reopenAfterCrash();
  await restarted.hydrate();
  assert.equal(restarted.writes.length, 1);
  assert.deepEqual(restarted.remote.map(x => x.id), ['X', 'Y']);
  assert.equal(restarted.tabPending, null);
});

test('same-title conflict does not freeze subsequent safe additions or clear original dirty intent', async () => {
  const f = fixture([{ id: 'same', title: 'Original' }]);
  await f.hydrate();
  f.otherTabSet([{ id: 'same', title: 'Changed remotely' }]);
  f.save([{ id: 'same', title: 'Edited locally' }]);
  await f.drain();
  assert.equal(f.remote[0].title, 'Changed remotely');
  f.save([{ id: 'same', title: 'Edited locally' }, { id: 'fresh', title: 'Mine' }]);
  await f.drain();
  assert.deepEqual(f.remote.map(x => x.id), ['same', 'fresh']);
  assert.equal(f.remote[0].title, 'Changed remotely');
  assert.equal(f.state.library[0].title, 'Edited locally');
  assert.ok(f.dirty.library, 'original contested edit still unsaved');
  assert.ok(f.writes.length <= 3);
});

test('RED: unresolved X conflict then safe Y and pending Z must not whole-CAS stale X on same-revision reload', async () => {
  const xOriginal = { id: 'X', title: 'Original' };
  const xMine = { id: 'X', title: 'My unsaved conflicting change' };
  const xOther = { id: 'X', title: 'Another tab changed X' };
  const f = fixture([xOriginal]);
  await f.hydrate();
  f.otherTabSet([xOther]);
  f.save([xMine]);
  await f.drain();
  assert.equal(f.remote[0].title, xOther.title);
  f.save([xMine, { id: 'Y', title: 'Safe Y' }]);
  await f.drain();
  assert.deepEqual(f.remote.map(x => x.id), ['X', 'Y']);
  assert.equal(f.remote[0].title, xOther.title);

  // preservePendingLibraryForTab runs synchronously before the queued write;
  // the page crashes just afterward. SQLite stays at the revision from Y.
  f.save([xMine, { id: 'Y', title: 'Safe Y' }, { id: 'Z', title: 'Pending Z' }]);
  const pending = f.tabPendingRecord;
  assert.equal(pending.expectedUpdatedAt, f.revision,
    'the collision sequence previously certified the new remote revision');
  assert.equal(pending.safeToReplay, false,
    'a disjoint partial save must permanently invalidate whole-snapshot replay eligibility');
  assert.equal(pending.certifiedBaseRevision, null);
  const crash = f.reopenAfterCrash();
  await crash.hydrate();
  await crash.drain();

  assert.equal(crash.remote.find(x => x.id === 'X').title, xOther.title,
    'a full-snapshot crash replay must never replace the other tab\'s X');
  assert.deepEqual(crash.remote.map(x => x.id), ['X', 'Y']);
  assert.equal(crash.writes.length, 0, 'unsafe shadow cannot be retried even if revision is unchanged');
  assert.equal(crash.state.library.find(x => x.id === 'X').title, xMine.title,
    'preserve contested unsaved intent locally');
  assert.deepEqual(crash.tabPending.map(x => x.id), ['X', 'Y', 'Z']);
  assert.ok(crash.dirty.library);
});

test('RED: concurrent edits to one item never clobber the other tab; local intent remains dirty', async () => {
  const f = fixture([{ id: 'same', title: 'Original', watched: false }]);
  await f.hydrate();
  f.otherTabSet([{ id: 'same', title: 'Other edit', watched: false }]);
  f.save([{ id: 'same', title: 'Original', watched: true }]);
  await f.drain();
  assert.equal(f.remote[0].title, 'Other edit');
  assert.equal(f.remote[0].watched, false);
  assert.equal(f.state.library[0].watched, true, 'pending in-memory intent must survive');
  assert.ok(f.dirty.library, 'unsaved local change remains durable/flagged');
  assert.equal(f.writes.length, 1, 'unsafe conflict must not retry with newest revision');
});

test('RED: remote deletion cannot be resurrected by local update during conflict', async () => {
  const f = fixture([{ id: 'gone', title: 'Title', watched: false }, { id: 'kept', title: 'Keep' }]);
  await f.hydrate();
  f.otherTabSet([{ id: 'kept', title: 'Keep' }]);
  f.save([{ id: 'gone', title: 'Title', watched: true }, { id: 'kept', title: 'Keep' }]);
  await f.drain();
  assert.deepEqual(f.remote.map(x => x.id), ['kept']);
  assert.ok(f.dirty.library);
  assert.equal(f.writes.length, 1);
});

test('RED: local deletion of unchanged item can rebase without restoring remote additions', async () => {
  const f = fixture([{ id: 'remove', title: 'Remove' }, { id: 'keep', title: 'Keep' }]);
  await f.hydrate();
  f.otherTabSet([{ id: 'remove', title: 'Remove' }, { id: 'keep', title: 'Keep' }, { id: 'remote', title: 'New remote' }]);
  f.save([{ id: 'keep', title: 'Keep' }]);
  await f.drain();
  assert.deepEqual(f.remote.map(x => x.id), ['keep', 'remote']);
  assert.equal(f.dirty.library, undefined);
});

test('RED: a newer local generation does not get cleared by an older in-flight write', async () => {
  const f = fixture([{ id: 'base', title: 'Original' }]);
  await f.hydrate();
  f.otherTabSet([{ id: 'base', title: 'Original' }, { id: 'other', title: 'Other' }]);
  f.save([{ id: 'base', title: 'Original' }, { id: 'one', title: 'First' }]);
  f.save([{ id: 'base', title: 'Original' }, { id: 'one', title: 'First' }, { id: 'two', title: 'Second' }]);
  await f.drain();
  assert.deepEqual(f.remote.map(x => x.id), ['base', 'other', 'one', 'two']);
  assert.equal(f.dirty.library, undefined);
  assert.ok(f.writes.length <= 4, 'single bounded retry per generation');
});

test('RED: newer queued generation after 409-rebased write ACK preserves another tab’s X and local Y/Z', async () => {
  const A = { id: 'A', title: 'Unchanged base' };
  const X = { id: 'X', title: 'Remote tab X' };
  const Y = { id: 'Y', title: 'Local Y' };
  const Z = { id: 'Z', title: 'Local Z' };
  const f = fixture([A]);
  await f.hydrate();
  // Tab B changes the database at N+1 while tab A still has verified base N.
  f.otherTabSet([A, X]);
  f.holdNextAcceptedAck();
  f.save([A, Y]);
  await f.drain();
  assert.equal(f.hasHeldAck, true, 'gen1 should have retried its first 409 and committed its rebased value');
  assert.deepEqual(f.remote.map(x => x.id), ['A', 'X', 'Y']);
  assert.equal(f.writes.length, 2, 'gen1 first stale CAS and exactly one recovery CAS');
  // While gen1's server-side transaction has finished but its HTTP response is
  // still pending, the stale tab A view cannot yet include the remote X.
  assert.deepEqual(f.state.library.map(x => x.id), ['A', 'Y']);
  f.save([A, Y, Z]);
  f.releaseAcceptedAck();
  await f.drain();

  assert.deepEqual(f.remote.map(x => x.id), ['A', 'X', 'Y', 'Z'],
    'gen2 must not use gen1 ACK revision to replace a stale Library lacking remote X');
  assert.deepEqual(f.state.library.map(x => x.id), ['A', 'X', 'Y', 'Z']);
  assert.equal(f.remote.find(item => item.id === 'X').title, X.title);
  assert.equal(f.writes.length, 3, 'gen2 should commit safely without an unbounded retry loop');
  assert.deepEqual(f.writes[2].data.value.map(x => x.id), ['A', 'X', 'Y', 'Z']);
  assert.equal(f.dirty.library, undefined);
});

test('newer same-tab Y update after its prior rebased ACK preserves remote X and commits latest Y', async () => {
  const A = { id: 'A', title: 'Unchanged base' };
  const X = { id: 'X', title: 'Remote tab X' };
  const Yfirst = { id: 'Y', title: 'First in-flight local value' };
  const Ynewer = { id: 'Y', title: 'Newer local value before gen1 ACK' };
  const Z = { id: 'Z', title: 'Another local addition' };
  const f = fixture([A]);
  await f.hydrate();
  f.otherTabSet([A, X]);
  f.holdNextAcceptedAck();
  f.save([A, Yfirst]);
  await f.drain();
  assert.equal(f.hasHeldAck, true);
  assert.deepEqual(f.remote.map(item => item.id), ['A', 'X', 'Y']);
  f.save([A, Ynewer, Z]);
  f.releaseAcceptedAck();
  await f.drain();

  assert.deepEqual(f.remote.map(item => item.id), ['A', 'X', 'Y', 'Z']);
  assert.equal(f.remote.find(item => item.id === 'Y').title, Ynewer.title,
    'a new update to the same tab-authored Y is safe once the older Y has committed');
  assert.equal(f.remote.find(item => item.id === 'X').title, X.title);
  assert.equal(f.writes.length, 3, 'one bounded recovery CAS followed by one safe newer generation');
  assert.equal(f.state.library.find(item => item.id === 'Y').title, Ynewer.title,
    'newer user intent remains visible after the merged CAS');
  assert.equal(f.tabPending, null);
  assert.equal(f.dirty.library, undefined);
});

test('genuine remote Y edit during a queued newer same-tab Y update is refused after a second 409', async () => {
  const A = { id: 'A', title: 'Base' };
  const X = { id: 'X', title: 'Remote X' };
  const Yinitial = { id: 'Y', title: 'Initial same-tab Y' };
  const Ynew = { id: 'Y', title: 'Newer same-tab Y' };
  const Yremote = { id: 'Y', title: 'Remote Y collision' };
  const f = fixture([A]);
  await f.hydrate();
  f.otherTabSet([A, X]);
  f.holdNextAcceptedAck();
  f.save([A, Yinitial]);
  await f.drain();
  f.save([A, Ynew]);
  // External tab edits Y after gen1 has committed [A,X,Yinitial], but BEFORE
  // its ACK is delivered. That edit must not be hidden by this tab's newer Y.
  f.otherTabSet([A, X, Yremote]);
  f.releaseAcceptedAck();
  await f.drain();

  assert.deepEqual(f.remote.map(item => item.id), ['A', 'X', 'Y']);
  assert.equal(f.remote.find(item => item.id === 'Y').title, Yremote.title);
  assert.equal(f.state.library.find(item => item.id === 'Y').title, Ynew.title);
  assert.equal(f.writes.length, 3, 'single bounded retry only, not an infinite conflict loop');
  assert.equal(f.tabPendingRecord.safeToReplay, false);
  assert.ok(f.dirty.library);
});

test('later generation still rebases against original visible baseline if older ACK skipped the visible update', async () => {
  const A = { id: 'A', title: 'Base' };
  const X = { id: 'X', title: 'Remote X' };
  const Y = { id: 'Y', title: 'Local Y' };
  const Z = { id: 'Z', title: 'Local Z' };
  const W = { id: 'W', title: 'Local W' };
  const f = fixture([A]);
  await f.hydrate();
  f.otherTabSet([A, X]);
  f.holdNextAcceptedAck();
  f.save([A, Y]);
  await f.drain();
  f.save([A, Y, Z]);
  f.releaseAcceptedAck();
  // Before gen2 writes its result, a subsequent generation is created on the
  // same stale view, which still lacks X. The earlier generations can be
  // superseded, but the next CAS cannot silently drop X or Y.
  f.save([A, Y, Z, W]);
  await f.drain();
  assert.deepEqual(f.remote.map(item => item.id), ['A', 'X', 'Y', 'Z', 'W']);
  assert.equal(f.dirty.library, undefined);
  assert.ok(f.writes.length <= 4, 'bounded retries even with several superseded generations');
});

test('stale visible Library cannot receive a crash replay certificate after older rebased ACK advances DB', async () => {
  const A = { id: 'A', title: 'Base' };
  const X = { id: 'X', title: 'Another tab X' };
  const Y = { id: 'Y', title: 'Local Y' };
  const Z = { id: 'Z', title: 'Queued Z' };
  const W = { id: 'W', title: 'New pending W' };
  const f = fixture([A]);
  await f.hydrate();
  f.otherTabSet([A, X]);
  f.holdNextAcceptedAck();
  f.save([A, Y]);
  await f.drain();
  assert.equal(f.hasHeldAck, true);
  assert.deepEqual(f.remote.map(item => item.id), ['A', 'X', 'Y']);

  // Gen2 begins after gen1 ACK but is blocked before reaching SQLite. The
  // database remains at gen1's N+2 while this tab is still showing [A,Y,Z].
  f.save([A, Y, Z]);
  f.holdNextPutBeforeServer();
  f.releaseAcceptedAck();
  await f.drain();
  assert.equal(f.hasHeldPutBeforeServer, true);
  assert.deepEqual(f.remote.map(item => item.id), ['A', 'X', 'Y']);
  assert.deepEqual(f.state.library.map(item => item.id), ['A', 'Y', 'Z']);

  // Gen3 updates the shadow synchronously and the tab crashes before gen2's
  // queued HTTP request ever reaches the server. A stale full-CAS of gen3
  // against the newly acknowledged revision would silently delete X.
  f.save([A, Y, Z, W]);
  const pending = f.tabPendingRecord;
  assert.equal(pending.expectedUpdatedAt, f.revision,
    'the tab has learned N+2 while its visible view still lacks X');
  assert.equal(pending.safeToReplay, false);
  assert.equal(pending.certifiedBaseRevision, null);
  const restart = f.reopenAfterCrash();
  await restart.hydrate();
  await restart.drain();
  assert.equal(restart.writes.length, 0, 'no unsafe whole-Library PUT despite exact revision equality');
  assert.deepEqual(restart.remote.map(item => item.id), ['A', 'X', 'Y']);
  assert.equal(restart.remote.find(item => item.id === 'X').title, X.title);
  assert.deepEqual(restart.state.library.map(item => item.id), ['A', 'Y', 'Z', 'W']);
  assert.ok(restart.dirty.library);
});
