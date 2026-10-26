import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const begin = app.indexOf("let pendingLibraryRemoval = null;");
const end = app.indexOf('\n$("#library-custom-image-input")', begin);
assert.ok(begin > 0 && end > begin, "real Library action handlers are available");
const code = app.slice(begin, end);

function harness({ currentView = "title" } = {}) {
  const events = new Map();
  const dialog = {
    open: false,
    showModal() { this.open = true; },
    close() {
      if (!this.open) return;
      this.open = false;
      events.get("library-remove-dialog:close")?.();
    },
    addEventListener(kind, fn) { events.set(`library-remove-dialog:${kind}`, fn); },
  };
  const elements = {
    "#library-remove-dialog": dialog,
    "#library-remove-cancel": { focus() {}, addEventListener(kind, fn) { events.set(`cancel:${kind}`, fn); } },
    "#library-remove-entry": { addEventListener(kind, fn) { events.set(`entry:${kind}`, fn); } },
    "#library-remove-chapters": { addEventListener(kind, fn) { events.set(`chapters:${kind}`, fn); } },
    "#library-context-menu": { addEventListener(kind, fn) { events.set(`context:${kind}`, fn); } },
    "#library-words-dialog": { close() {} },
  };
  const state = { library: [
    { seriesKey: "fma", title: "Fullmetal Alchemist: Brotherhood", id: "catalog:fma", catalogOnly: true, episodes: [] },
    { seriesKey: "fma", title: "Fullmetal Alchemist: Brotherhood", id: "source:fma", episodes: [{ code: "S01E01", progress: { positionMs: 21000 } }] },
    { seriesKey: "another", title: "Another anime", fileIndex: 0 },
  ] };
  const actions = { saved: 0, rendered: 0, refreshed: 0, navigation: 0, toast: "" };
  const context = vm.createContext({
    state,
    $: (selector) => elements[selector] || null,
    buildLibrarySeries: () => [{ key: "fma", title: "Fullmetal Alchemist: Brotherhood" }],
    librarySeriesKey: (title) => title === "Another anime" ? "another" : "fma",
    libraryContextSeriesKey: "fma",
    closeLibraryContextMenu() {},
    saveLibrary() { actions.saved++; },
    renderLibrary() { actions.rendered++; },
    refreshTitlePage() { actions.refreshed++; },
    viewActive: (view) => view === currentView,
    switchView() { actions.navigation++; },
    toast(message) { actions.toast = message; },
  });
  vm.runInContext(code, context);
  const start = () => events.get("context:click")({
    target: { closest: (selector) => selector === "[data-library-action]" ? { dataset: { libraryAction: "delete" } } : null },
  });
  return { state, dialog, actions, start, elements,
    cancel: () => events.get("cancel:click")(),
    removeEntry: () => events.get("entry:click")(),
    removeChapters: () => events.get("chapters:click")(),
  };
}

test("Library removal offers only a heading and three in-page actions", () => {
  assert.match(html, /<dialog id="library-remove-dialog"[^>]*aria-labelledby="library-remove-title"/);
  const dialog = html.match(/<dialog id="library-remove-dialog"[\s\S]*?<\/dialog>/)?.[0] || "";
  assert.match(dialog, /id="library-remove-title">Remove from Library<\/h2>/);
  assert.match(html, /id="library-remove-cancel"/);
  assert.match(dialog, /id="library-remove-entry"[^>]*>Remove entry<\/button>/);
  assert.match(dialog, /id="library-remove-chapters"[^>]*>Remove entry and chapters<\/button>/);
  assert.doesNotMatch(dialog, /library-remove-message|library-remove-note|Saved chapters and sources/);
  assert.doesNotMatch(code, /window\.confirm\s*\(/, "native confirmation would leave the app view");
  const f = harness();
  f.start();
  assert.equal(f.dialog.open, true);
  assert.equal(f.state.library.length, 3);
});

test("Cancel or native Escape closes removal without deleting or navigating", () => {
  const f = harness();
  f.start();
  f.cancel();
  assert.equal(f.dialog.open, false);
  f.start();
  f.dialog.close(); // Native dialog cancel/Escape follows this close event.
  f.removeChapters(); // a late click must not remove a now-dismissed title.
  assert.equal(f.state.library.length, 3);
  assert.equal(f.actions.saved, 0);
  assert.equal(f.actions.navigation, 0);
});

test("Remove entry hides Library listing but preserves chapters, progress and original records", () => {
  const f = harness({ currentView: "title" });
  f.start();
  f.removeEntry();
  assert.equal(f.state.library.length, 3);
  assert.equal(f.state.library[0].libraryHidden, true);
  assert.equal(f.state.library[1].libraryHidden, true);
  assert.equal(f.state.library[1].episodes[0].progress.positionMs, 21000);
  assert.equal(f.state.library[2].libraryHidden, undefined);
  assert.equal(f.actions.saved, 1);
  assert.equal(f.actions.rendered, 1);
  assert.equal(f.actions.refreshed, 1);
  assert.equal(f.actions.navigation, 0);
  assert.match(f.actions.toast, /chapters retained/);
  assert.match(app, /if \(entry\.libraryHidden === true\) return;/);
  assert.match(app, /delete item\.libraryHidden/, "re-adding must restore retained records");
});

test("Remove entry and chapters removes only intended saved records and stays on Title", () => {
  const f = harness({ currentView: "title" });
  f.start();
  f.removeChapters();
  assert.deepEqual(f.state.library.map(({ seriesKey }) => seriesKey), ["another"]);
  assert.equal(f.actions.saved, 1);
  assert.equal(f.actions.rendered, 1);
  assert.equal(f.actions.refreshed, 1);
  assert.equal(f.actions.navigation, 0);
  assert.equal(f.dialog.open, false);
  assert.match(f.actions.toast, /saved chapters removed from your Library/);
});

test("Confirm from Watch preserves the Watch view and does not force a Title refresh", () => {
  const f = harness({ currentView: "watch" });
  f.start();
  f.removeChapters();
  assert.equal(f.state.library.length, 1);
  assert.equal(f.actions.refreshed, 0);
  assert.equal(f.actions.navigation, 0);
});
