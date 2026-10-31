import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('storage report paints persisted cache setting rather than hardcoded HTML default', () => {
  const start = app.indexOf('  const remuxCacheSwitch = $("#storage-remux-cache-enabled");');
  const end = app.indexOf('  if (playerInput && document.activeElement', start);
  assert.ok(start > 0 && end > start);
  const switchNode = { checked: true };
  const paint = (enabled) => vm.runInNewContext(app.slice(start, end), {
    $: selector => selector === '#storage-remux-cache-enabled' ? switchNode : null,
    report: { limits: { remuxCacheEnabled: enabled } },
  });
  paint(false);
  assert.equal(switchNode.checked, false, 'disabled option is reflected even though markup defaults checked');
  paint(true);
  assert.equal(switchNode.checked, true);
  paint(undefined);
  assert.equal(switchNode.checked, false,
    'missing cache permission fails closed rather than silently authorizing disk-backed seeking');
});

test('cache toggle persists a boolean; rejected save reverts and refreshes without disabling streaming', async () => {
  const start = app.indexOf('  $("#storage-remux-cache-enabled")?.addEventListener("change",');
  const end = app.indexOf('\n  const playerSlider =', start);
  assert.ok(start > 0 && end > start, 'single handler is in Storage settings wiring');
  const calls = [];
  const toggle = { checked: false, disabled: false, addEventListener(event, handler) {
    assert.equal(event, 'change');
    this.handler = handler;
  } };
  let succeeds = true;
  let refreshes = 0;
  vm.runInNewContext(app.slice(start, end), {
    video: { dataset: { mode: 'torrent-direct' } },
    $: selector => selector === '#storage-remux-cache-enabled' ? toggle : null,
    saveStorageLimits: async changes => { calls.push({ ...changes }); return succeeds; },
    renderSettingsStorage: async () => { refreshes++; },
  });
  await toggle.handler({ currentTarget: toggle });
  assert.deepEqual(calls, [{ remuxCacheEnabled: false }]);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  succeeds = false;
  toggle.checked = true;
  await toggle.handler({ currentTarget: toggle });
  assert.deepEqual(calls[1], { remuxCacheEnabled: true });
  assert.equal(toggle.checked, false, 'failure rolls back the displayed state');
  assert.equal(refreshes, 1);
  assert.equal(toggle.disabled, false);
});
