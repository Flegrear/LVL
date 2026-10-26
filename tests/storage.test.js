import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { STORAGE_DEFAULTS, createStorageManager, diskSpace, folderUsage, recommendedLimits } from "../backend/persistence/storage.js";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

const appSource = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const settingsHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function write(file, bytes, mtime = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

function setup({ onRemoveSession = null } = {}) {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-storage-test-"));
  const own = path.join(shared, "port-4999");
  const meta = new Map();
  const live = new Map();
  const removed = [];
  const manager = createStorageManager({
    appDatabase: { getMeta: (key) => meta.get(key) ?? null, setMeta: (key, value) => meta.set(key, value) },
    sessionsRoot: own,
    sharedRoot: shared,
    sessions: () => [...live.values()],
    removeSession: async (id) => {
      removed.push(id);
      if (onRemoveSession) return onRemoveSession(id, live);
      live.delete(id);
      fs.rmSync(path.join(own, id), { recursive: true, force: true });
    },
    clipStore: { stats: () => ({ card: { count: 2, bytes: 3 * MB }, dictation: { count: 5, bytes: 1 * MB } }), collectGarbage: () => ({ demoted: 0, removed: 0 }) },
    ankiStore: { listDecks: () => [{ id: "d", mediaBytes: 7 * MB }] },
  });
  return { shared, own, meta, live, removed, manager, cleanup: () => fs.rmSync(shared, { recursive: true, force: true }) };
}

test("limits default to 20 GB and 2 GB, are kept in the database and stay within their ranges", () => {
  const { manager, meta, cleanup } = setup();
  try {
    assert.equal(STORAGE_DEFAULTS.playerBytes, 20 * GB);
    assert.equal(STORAGE_DEFAULTS.clipBytes, 2 * GB);
    assert.deepEqual(manager.limits(), { playerBytes: 20 * GB, clipBytes: 2 * GB });
    manager.setLimits({ playerBytes: 50 * GB });
    assert.equal(manager.limits().playerBytes, 50 * GB);
    assert.equal(manager.limits().clipBytes, 2 * GB, "the other limit is unchanged");
    assert.ok(meta.get("storage_limits"), "saved");
    manager.setLimits({ playerBytes: 1, clipBytes: 10_000 * GB });
    assert.equal(manager.limits().playerBytes, 2 * GB, "raised to the minimum");
    assert.equal(manager.limits().clipBytes, 200 * GB, "lowered to the maximum");
    manager.setLimits({ clipBytes: "not a number" });
    assert.equal(manager.limits().clipBytes, 200 * GB, "invalid input keeps the current value");
  } finally {
    cleanup();
  }
});

test("over the limit, idle downloads go least recently used first; the playing one never does", async () => {
  const { own, live, removed, manager, cleanup } = setup();
  try {
    const now = Date.now();
    write(path.join(own, "playing", "a.mkv"), 3 * MB);
    write(path.join(own, "old", "b.mkv"), 2 * MB);
    write(path.join(own, "newer", "c.mkv"), 2 * MB);
    write(path.join(own, "recent", "d.mkv"), 2 * MB);
    live.set("playing", { id: "playing", lastUsedAt: now - 30 * 60_000, busy: true });
    live.set("old", { id: "old", lastUsedAt: now - 40 * 60_000, busy: false });
    live.set("newer", { id: "newer", lastUsedAt: now - 20 * 60_000, busy: false });
    live.set("recent", { id: "recent", lastUsedAt: now - 10_000, busy: false });
    assert.equal((await folderUsage(own)).bytes, 9 * MB);
    assert.deepEqual((await manager.enforcePlayer({ now })).evicted, [], "9 MB is far under 20 GB");
    const result = await manager.enforcePlayer({ now, limitBytes: 6 * MB });
    assert.deepEqual(result.evicted, ["old", "newer"], "oldest first, until it fits");
    assert.deepEqual(removed, ["old", "newer"]);
    assert.equal(result.usedBytes, 5 * MB);
    assert.ok(fs.existsSync(path.join(own, "playing", "a.mkv")), "the video being watched stays");
    assert.ok(fs.existsSync(path.join(own, "recent", "d.mkv")), "used in the last minute: kept");
    const freed = await manager.clearPlayer();
    assert.equal(freed.freedBytes, 0, "nothing idle is left to free");
  } finally {
    cleanup();
  }
});

test("failed cache evictions do not lie about freed disk space or stop the cleanup early", async () => {
  const { own, live, manager, cleanup } = setup({
    onRemoveSession(id, active) {
      if (id === "locked") return; // deletion silently failed, as can happen to a store
      active.delete(id);
      fs.rmSync(path.join(own, id), { recursive: true, force: true });
    },
  });
  try {
    const now = Date.now();
    write(path.join(own, "playing", "video.mkv"), 2 * MB);
    write(path.join(own, "locked", "stuck.mkv"), 2 * MB);
    write(path.join(own, "deletable", "cache.mkv"), 3 * MB);
    live.set("playing", { id: "playing", busy: true, lastUsedAt: now });
    live.set("locked", { id: "locked", busy: false, lastUsedAt: now - 600_000 });
    live.set("deletable", { id: "deletable", busy: false, lastUsedAt: now - 300_000 });
    const result = await manager.enforcePlayer({ now, limitBytes: 3 * MB });
    assert.deepEqual(result.evicted, ["deletable"], "only a cache actually removed is marked evicted");
    assert.equal(result.usedBytes, 4 * MB, "remaining locked cache is still counted");
    assert.equal((await manager.report()).player.usedBytes, result.usedBytes);
    assert.ok(fs.existsSync(path.join(own, "playing", "video.mkv")));
    assert.ok(fs.existsSync(path.join(own, "locked", "stuck.mkv")));
  } finally {
    cleanup();
  }
});

test("clear player returns the actual bytes removed and leaves active and recent videos untouched", async () => {
  const { own, live, manager, cleanup } = setup();
  try {
    const now = Date.now();
    write(path.join(own, "playing", "a.mkv"), 3 * MB);
    write(path.join(own, "old", "b.mkv"), 2 * MB);
    write(path.join(own, "recent", "c.mkv"), MB);
    live.set("playing", { id: "playing", lastUsedAt: now - 300000, busy: true });
    live.set("old", { id: "old", lastUsedAt: now - 300000, busy: false });
    live.set("recent", { id: "recent", lastUsedAt: now, busy: false });
    assert.deepEqual(await manager.clearPlayer(), { freedBytes: 2 * MB });
    assert.equal((await manager.report()).player.usedBytes, 4 * MB);
    assert.deepEqual(await manager.clearPlayer(), { freedBytes: 0 });
    assert.ok(fs.existsSync(path.join(own, "playing", "a.mkv")));
    assert.ok(fs.existsSync(path.join(own, "recent", "c.mkv")));
  } finally {
    cleanup();
  }
});

test("storage cap is an interactive slider synchronized with the editable numeric limit", () => {
  assert.match(settingsHtml, /id="storage-player-slider" class="storage-limit-slider" type="range"/);
  assert.doesNotMatch(settingsHtml, /id="storage-player-meter"/);
  assert.match(appSource, /playerSlider\?\.addEventListener\("input",/);
  assert.match(appSource, /playerSlider\?\.addEventListener\("change",/);
  assert.match(appSource, /saveStorageLimits\(\{ playerGB: Number\(playerSlider\.value\) \}\)/);
  const from = appSource.indexOf("function updateStorageLimitSlider(");
  const to = appSource.indexOf("\nfunction paintStorageReport(", from);
  assert.ok(from > 0 && to > from);
  const set = new Map();
  const slider = {
    min: "2", max: "1000", value: "75",
    style: { setProperty: (key, value) => set.set(key, value) },
    setAttribute: (key, value) => set.set(key, value),
  };
  vm.runInNewContext(appSource.slice(from, to) + "\nupdateStorageLimitSlider(slider);", { slider });
  assert.equal(set.get("aria-valuetext"), "75 GB maximum");
  assert.equal(set.get("--storage-cap-percent"), "7.31%");
});

test("Free space now reports nothing when empty, or the exact reclaimed amount", async () => {
  const from = appSource.indexOf('$("#storage-player-clear")?.addEventListener("click"');
  const to = appSource.indexOf('\n  $("#storage-leftovers-clear")?', from);
  assert.ok(from > 0 && to > from);
  let clicked;
  let freedBytes = 0;
  let status = "";
  const button = { disabled: false };
  vm.runInNewContext(appSource.slice(from, to), {
    $: () => ({ addEventListener: (_type, handler) => { clicked = handler; } }),
    postJson: async () => ({ freedBytes, report: {} }),
    paintStorageReport: () => {},
    setToolStatus: (_where, text) => { status = text; },
    formatStorage: (bytes) => String(bytes / MB) + " MB",
  });
  await clicked({ currentTarget: button });
  assert.equal(status, "Nothing to clear.");
  assert.equal(button.disabled, false);
  freedBytes = 2 * MB;
  await clicked({ currentTarget: button });
  assert.equal(status, "Cleared 2 MB of unused video downloads.");
  assert.equal(button.disabled, false);
});

test("leftovers from other runs are found and deleted; the server's own orphans go at startup", async () => {
  const { shared, own, live, manager, cleanup } = setup();
  try {
    const now = Date.now();
    const old = now - 2 * 60 * 60 * 1000;
    write(path.join(shared, "0d3f2a47-40d6-4f41-919f-fc42b2ed99d9", "x.mkv"), 2 * MB, old);
    write(path.join(shared, "port-4173", "11111111-2222-4333-8444-555555555555", "y.mkv"), 3 * MB, old);
    write(path.join(shared, "22222222-2222-4333-8444-555555555555", "z.mkv"), MB);
    write(path.join(shared, "not-ours", "w.bin"), MB, old);
    for (const folder of ["0d3f2a47-40d6-4f41-919f-fc42b2ed99d9", "port-4173", "not-ours"]) fs.utimesSync(path.join(shared, folder), old / 1000, old / 1000);
    write(path.join(own, "live", "a.mkv"), MB);
    write(path.join(own, "crashed", "b.mkv"), MB);
    live.set("live", { id: "live", lastUsedAt: now, busy: false });
    const leftovers = await manager.leftovers({ now });
    assert.equal(leftovers.folders.length, 1, "only safely identifiable legacy orphan folders");
    assert.equal(leftovers.bytes, 2 * MB);
    const report = await manager.report();
    assert.equal(report.player.leftoverBytes, 2 * MB);
    const cleared = await manager.clearLeftovers();
    assert.deepEqual(cleared, { removed: 1, freedBytes: 2 * MB });
    assert.ok(fs.existsSync(path.join(shared, "port-4173", "11111111-2222-4333-8444-555555555555", "y.mkv")), "another live LVL port is never removed, even if its mtime is old");
    assert.ok(fs.existsSync(path.join(shared, "22222222-2222-4333-8444-555555555555")), "a recently used folder is kept");
    assert.ok(fs.existsSync(path.join(shared, "not-ours")), "folders that aren't the app's are never touched");
    assert.ok(fs.existsSync(own), "the server's own folder is not a leftover");
    assert.equal(await manager.clearOrphans(), 1);
    assert.ok(!fs.existsSync(path.join(own, "crashed")));
    assert.ok(fs.existsSync(path.join(own, "live")), "live sessions are kept");
  } finally {
    cleanup();
  }
});

test("the report adds up player, clip and deck usage", async () => {
  const { own, live, manager, cleanup } = setup();
  try {
    write(path.join(own, "s1", "a.mkv"), 2 * MB);
    live.set("s1", { id: "s1", lastUsedAt: Date.now(), busy: false });
    const report = await manager.report();
    assert.equal(report.player.usedBytes, 2 * MB);
    assert.equal(report.player.videos, 1);
    assert.equal(report.clips.usedBytes, 4 * MB);
    assert.equal(report.clips.cardCount, 2);
    assert.equal(report.clips.dictationCount, 5);
    assert.equal(report.decks.mediaBytes, 7 * MB);
    assert.deepEqual(report.limits, { playerBytes: 20 * GB, clipBytes: 2 * GB });
  } finally {
    cleanup();
  }
});


test("recommended sizes: defaults on a roomy drive, less on a nearly full one, room for card clips", async () => {
  const GiB = 1024 ** 3;
  assert.deepEqual(
    { player: recommendedLimits({ playerFreeBytes: 200 * GiB, dataFreeBytes: 200 * GiB }).playerBytes / GiB, clip: recommendedLimits({ dataFreeBytes: 200 * GiB }).clipBytes / GiB },
    { player: 20, clip: 2 },
  );
  assert.equal(recommendedLimits({ playerFreeBytes: 30 * GiB }).playerBytes / GiB, 7, "a quarter of the free space");
  assert.equal(recommendedLimits({ playerFreeBytes: 1 * GiB }).playerBytes / GiB, 2, "never under the smallest budget");
  assert.equal(recommendedLimits({ playerFreeBytes: 10 * GiB, playerUsedBytes: 10 * GiB }).playerBytes / GiB, 5, "what the player already uses counts as room");
  assert.equal(recommendedLimits({ cardClipBytes: 3 * GiB }).clipBytes / GiB, 6, "twice what card clips use");
  assert.equal(recommendedLimits({ cardClipBytes: 3 * GiB, dataFreeBytes: 20 * GiB, clipBytes: 3 * GiB }).clipBytes / GiB, 2.25, "at most a tenth of the free space");
  assert.equal(recommendedLimits({ clipCount: 100, clipBytes: 100 * 100 * 1024 }).linesPerGB, 10486);
  const space = await diskSpace(path.join(os.tmpdir(), "a-folder-that-does-not-exist-yet", "deeper"));
  assert.ok(space && space.freeBytes > 0 && space.totalBytes >= space.freeBytes, JSON.stringify(space));
});
