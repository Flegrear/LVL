import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const begin = app.indexOf('$("#storage-remux-cache-enabled")?.addEventListener("change", async (event) => {');
const end = app.indexOf('\n  const playerSlider =', begin);
assert.ok(begin >= 0 && end > begin, 'production storage toggle handler exists');

function setup() {
  let listener;
  const events = [], toggle = { checked: false, disabled: false };
  let resolveSwitch;
  const switchPromise = new Promise(resolve => { resolveSwitch = resolve; });
  const video = { dataset: { mode: 'transcode', indexed: '1' } };
  const ctx = vm.createContext({
    video,
    $: () => ({ addEventListener(_type, fn) { listener = fn; } }),
    absolutePlaybackSeconds: () => 123.45,
    playerIsPlaying: () => true,
    async restartTranscodeAt(_seconds, { forceNative }) {
      events.push(`native-start:${forceNative}`);
      return switchPromise;
    },
    async saveStorageLimits(changes) {
      events.push(`save:${changes.remuxCacheEnabled}`);
      return true;
    },
    setToolStatus() { events.push('status'); },
    async renderSettingsStorage() { events.push('repaint'); },
  });
  vm.runInContext(app.slice(begin, end), ctx);
  return { toggle, video, events, resolveSwitch, click: () => listener({ currentTarget: toggle }) };
}

test('switching cache off while playing indexed MP4 waits for native takeover before server purge', async () => {
  const h = setup();
  const change = h.click();
  assert.equal(h.toggle.disabled, true);
  assert.deepEqual(h.events, ['native-start:true']);
  h.resolveSwitch(true);
  await change;
  assert.deepEqual(h.events, ['native-start:true', 'save:false']);
  assert.equal(h.toggle.disabled, false);
});

test('failed native takeover leaves setting enabled and does not purge an active indexed reader', async () => {
  const h = setup();
  const change = h.click();
  h.resolveSwitch(false);
  await change;
  assert.equal(h.toggle.checked, true);
  assert.deepEqual(h.events, ['native-start:true', 'status']);
  assert.equal(h.toggle.disabled, false);
});
