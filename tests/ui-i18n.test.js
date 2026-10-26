import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as i18n from "../frontend/ui/ui-i18n.js";
import { badgeMarkup, buttonMarkup, cardMarkup, emptyMarkup, helpTipMarkup, heroMarkup, iconButtonMarkup, metaMarkup } from "../frontend/ui/ui.js";

// A small DOM fixture keeps the translator tests independent of a browser package.
const text = (value) => ({ nodeType: 3, nodeValue: value });
function element(tag, attrs = {}, children = []) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs: { ...attrs }, childNodes: children,
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
    matches(selector) { return selector.split(",").some((part) => {
      const value = part.trim();
      return value.startsWith("[") ? this.hasAttribute(value.slice(1, -1)) : value.toUpperCase() === this.tagName;
    }); },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
    querySelectorAll(selector) { return this.childNodes.filter((child) => child.nodeType === 1).flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]); },
  };
  children.forEach((child) => { child.parentElement = node; });
  return node;
}

test("translations accept explicit keys and English source aliases", () => {
  assert.equal(i18n.t("nav.home", {}, "es"), "Inicio");
  assert.equal(i18n.t("Show answer", {}, "es"), "Mostrar respuesta");
  assert.equal(i18n.t("Again", {}, "es"), "Otra vez");
  assert.equal(i18n.t("Unknown source", {}, "es"), "Unknown source");
  for (const key of ["constructor", "toString", "__proto__"]) assert.equal(i18n.t(key, {}, "es"), key);
  assert.equal(i18n.t("Save", {}, "fr"), "Save");
});

test("Watch navigation toggle announces its live expanded state in the current language", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("function setSidebarExpanded(");
  const end = source.indexOf('\n$("#sidebar-toggle").addEventListener', start);
  assert.ok(start > 0 && end > start);
  const toggle = element("button", { "data-i18n-aria-label": "Expand navigation", "data-i18n-title": "Expand navigation" });
  const watchToggle = element("button", { "data-i18n-aria-label": "Expand navigation", "data-i18n-title": "Expand navigation" });
  let expanded = false;
  const shell = { classList: { toggle: (key, value) => { assert.equal(key, "sidebar-expanded"); expanded = value; } } };
  const ctx = vm.createContext({ window: { innerWidth: 1200 }, $: (selector) => selector === ".app-shell" ? shell : selector === "#sidebar-toggle" ? toggle : watchToggle,
    localStorage: {}, persistPreferences: () => {}, t: i18n.t,
    closeUpdateNotificationPopover() {} });
  vm.runInContext(source.slice(start, end), ctx);
  const setSidebarExpanded = vm.runInContext("setSidebarExpanded", ctx);
  i18n.setInterfaceLanguage("es", { root: null });
  try {
    setSidebarExpanded(true, { persist: false });
    assert.equal(expanded, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("data-i18n-aria-label"), "Collapse navigation");
    assert.equal(toggle.getAttribute("aria-label"), "Contraer menú");
    assert.equal(watchToggle.getAttribute("aria-expanded"), "true");
    assert.equal(watchToggle.getAttribute("aria-label"), "Contraer menú");
    i18n.translateUi(toggle, "es");
    i18n.translateUi(watchToggle, "es");
    assert.equal(toggle.getAttribute("aria-label"), "Contraer menú", "Re-translation must not announce the opposite state");
    assert.equal(watchToggle.getAttribute("aria-label"), "Contraer menú");
    setSidebarExpanded(false, { persist: false });
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("data-i18n-aria-label"), "Expand navigation");
    assert.equal(toggle.getAttribute("aria-label"), "Expandir menú");
    assert.equal(watchToggle.getAttribute("aria-expanded"), "false");
    assert.equal(watchToggle.getAttribute("aria-label"), "Expandir menú");
  } finally { i18n.setInterfaceLanguage("en", { root: null }); }
});

test("dynamic count templates interpolate data without interpreting HTML", () => {
  assert.equal(i18n.t("{count} cards", { count: 4 }, "es"), "4 tarjetas");
  assert.equal(i18n.t("Quiz score: {correct}/{total}", { correct: 3, total: 4 }, "es"), "Resultado: 3/4");
  assert.equal(i18n.t("{count} cards", { count: "<img src=x>" }, "es"), "<img src=x> tarjetas");
  assert.equal(i18n.t("{count} cards", {}, "es"), "{count} tarjetas");
});

test("translated DOM templates preserve literal dollar replacement tokens", () => {
  const label = text("3 cards");
  const root = element("span", { "data-i18n": "{count} cards", "data-i18n-params": JSON.stringify({ count: "$& $` $' $$" }) }, [label]);
  i18n.translateUi(root, "es");
  assert.equal(label.nodeValue, "$& $` $' $$ tarjetas");
  i18n.translateUi(root, "en");
  assert.equal(label.nodeValue, "$& $` $' $$ cards");
  const insertedSpanish = text("$& tarjetas");
  const inserted = element("span", { "data-i18n": "{count} cards", "data-i18n-params": JSON.stringify({ count: "$&" }) }, [insertedSpanish]);
  i18n.translateUi(inserted, "en");
  assert.equal(insertedSpanish.nodeValue, "$& cards");
});

test("Review prompts and empty state text have English and Spanish messages", () => {
  const messages = [
    "All {language} cards", "Which word completes the line?", "What does this line mean?", "Play line", "Loading saved lines…", "Not enough translated lines",
    "Listening needs four saved lines with different translations in your current language pair. Watch a chapter with both subtitle languages to save lines.",
    "Video vocabulary", "No chapters in Library", "Replay line", "Replay clip", "Preparing video clip…", "Open this chapter once to save this line’s timing.", "Video unavailable", "Close", "This line has no saved clip or video source.", "Loading line…",
    "Cached results: AnkiWeb is temporarily unavailable.", "Word → meaning", "Meaning → word", "Mixed", "Enter for next, 1–4 to answer", "Right", "Not quite", "Question direction",
    "Not enough cards to quiz", "A quiz needs at least four cards with a meaning. Add Top words or a deck in Study.", "or",
  ];
  for (const source of messages) {
    assert.equal(i18n.t(source, {}, "en"), source);
    assert.notEqual(i18n.t(source, {}, "es"), source, source);
  }
});

test("UI factory labels translate known source keys with reversible annotations", () => {
  i18n.setInterfaceLanguage("es", { root: null });
  try {
    const button = buttonMarkup({ label: "Show answer", icon: "play", attrs: { title: "Replay line" } });
    assert.match(button, /<svg class="ui-icon"/);
    assert.match(button, /<span data-i18n="Show answer">Mostrar respuesta<\/span>/);
    assert.match(button, /title="Repetir frase"/);
    assert.match(button, /data-i18n-title="Replay line"/);
    const iconButton = iconButtonMarkup({ icon: "close", label: "Close", tooltip: "Close" });
    assert.match(iconButton, /aria-label="Cerrar"/);
    assert.match(iconButton, /data-i18n-aria-label="Close"/);
    assert.match(iconButton, /data-ui-tooltip="Cerrar"/);
    assert.match(iconButton, /data-i18n-ui-tooltip="Close"/);
    const empty = emptyMarkup({ title: "No decks yet", text: "This deck is done for today." });
    assert.match(empty, /data-i18n="No decks yet">Aún no hay mazos/);
    assert.match(empty, /data-i18n="This deck is done for today\.">/);
    assert.match(badgeMarkup("Mastered", { i18n: true }), /data-i18n="Mastered">Dominadas/);
    assert.match(helpTipMarkup({ label: "More information", content: "This deck is done for today." }), /aria-label="Más información"/);
    assert.match(helpTipMarkup({ content: "This deck is done for today." }), /data-i18n="This deck is done for today\."/);
  } finally { i18n.setInterfaceLanguage("en", { root: null }); }
});

test("factory opt-outs, content metadata and unknown labels remain untouched", () => {
  i18n.setInterfaceLanguage("es", { root: null });
  try {
    assert.match(buttonMarkup({ label: "Save", i18n: false }), /<span>Save<\/span>/);
    assert.doesNotMatch(buttonMarkup({ label: "Save", i18n: false }), /data-i18n/);
    assert.match(buttonMarkup({ label: "My deck's title" }), /My deck&#39;s title/);
    assert.doesNotMatch(buttonMarkup({ label: "My deck's title" }), /data-i18n/);
    assert.match(badgeMarkup("New"), />New<\/span>/, "badges are opt-in because cards use external metadata");
    const card = cardMarkup({ title: "Save", description: "Words", badge: "New", meta: ["Spanish"] }, { variant: "wide", actions: false });
    assert.match(card, /ui-card__title">Save/);
    assert.match(card, /ui-card__text">Words/);
    assert.match(card, /ui-badge">New/);
    assert.doesNotMatch(card, /data-i18n/);
    assert.match(metaMarkup(["Spanish", "New"]), /<span>Spanish<\/span><span>New<\/span>/);
    assert.match(heroMarkup([{ title: "Save", description: "Words" }]), /ui-hero__synopsis">Words/);
    const featured = heroMarkup([{ title: "Cyberpunk", eyebrow: { badge: "Anime series", text: "Popular in action" } }]);
    assert.doesNotMatch(featured, /ui-hero__eyebrow|Anime series|Popular in action/,
      "the shared Home hero no longer renders category/genre labels above the title");
    assert.match(featured, /ui-hero__title-text">Cyberpunk/);
    const trustedContent = '<strong>Save</strong><code>ES</code>';
    assert.ok(helpTipMarkup({ content: trustedContent }).includes(trustedContent));
  } finally { i18n.setInterfaceLanguage("en", { root: null }); }
});

test("explicit factory templates interpolate safely and preserve their keys", () => {
  i18n.setInterfaceLanguage("es", { root: null });
  try {
    const html = buttonMarkup({ label: "ignored", i18n: { label: "{count} cards", params: { count: '<img src=x>"' } } });
    assert.match(html, /data-i18n="\{count\} cards"/);
    assert.match(html, /data-i18n-params="\{&quot;count&quot;:/);
    assert.match(html, /&lt;img src=x&gt;&quot; tarjetas/);
    assert.ok(!html.includes("<img src=x>"));
  } finally { i18n.setInterfaceLanguage("en", { root: null }); }
});

test("translation switches text and accessible labels without removing icons or counts", () => {
  const svg = element("svg");
  const count = element("b", {}, [text("7")]);
  const label = text("  Save  ");
  const button = element("button", { "data-i18n": "Save", "data-i18n-title": "Save", title: "Save" }, [svg, label, count]);
  const root = element("section", {}, [button]);
  i18n.translateUi(root, "es");
  assert.equal(label.nodeValue, "  Guardar  ");
  assert.equal(button.getAttribute("title"), "Guardar");
  assert.equal(button.childNodes[0], svg);
  assert.equal(count.childNodes[0].nodeValue, "7");
  i18n.translateUi(root, "en");
  assert.equal(label.nodeValue, "  Save  ");
  assert.equal(button.getAttribute("title"), "Save");
});

test("unannotated learning content, input values and protected markup stay intact", () => {
  const subtitle = element("p", {}, [text("Save")]);
  const ignored = element("section", { "data-i18n-ignore": "" }, [element("p", { "data-i18n": "Save" }, [text("Save")])]);
  const code = element("code", { "data-i18n": "Save" }, [text("Save")]);
  const field = element("input", { value: "ES", "data-i18n-placeholder": "Search", placeholder: "Search" });
  const option = element("option", { value: "EN", "data-i18n": "English" }, [text("English")]);
  i18n.translateUi(element("section", {}, [subtitle, ignored, code, field, option]), "es");
  assert.equal(subtitle.childNodes[0].nodeValue, "Save");
  assert.equal(ignored.childNodes[0].childNodes[0].nodeValue, "Save");
  assert.equal(code.childNodes[0].nodeValue, "Save");
  assert.equal(field.getAttribute("value"), "ES");
  assert.equal(field.getAttribute("placeholder"), "Buscar");
  assert.equal(option.getAttribute("value"), "EN");
  assert.equal(option.childNodes[0].nodeValue, "Inglés");
});

test("English switching restores original capitalization and unknown-key text", () => {
  const label = text("HOME");
  const unknown = text("Unchanged original");
  const root = element("div", {}, [element("span", { "data-i18n": "nav.home" }, [label]), element("span", { "data-i18n": "unknown.key" }, [unknown])]);
  i18n.translateUi(root, "es");
  assert.equal(label.nodeValue, "Inicio");
  assert.equal(unknown.nodeValue, "Unchanged original");
  i18n.translateUi(root, "en");
  assert.equal(label.nodeValue, "HOME");
});

test("dynamically inserted Spanish labels can switch back to English", () => {
  const label = text("Guardar");
  const root = element("button", { "data-i18n": "Save" }, [label]);
  i18n.translateUi(root, "es");
  i18n.translateUi(root, "en");
  assert.equal(label.nodeValue, "Save");
});

test("installed controllers resolve auto language and update document language", () => {
  const root = element("html", {}, [element("button", { "data-i18n": "Save" }, [text("Save")])]);
  const controller = i18n.installUiI18n({ root, interfaceLanguage: "auto", baseLanguage: "ES" });
  assert.equal(root.getAttribute("lang"), "es");
  assert.equal(controller.t("Save"), "Guardar");
  assert.equal(controller.setLanguage("en", "ES"), "en");
  assert.equal(root.getAttribute("lang"), "en");
  assert.equal(controller.t("Save"), "Save");
  assert.doesNotThrow(() => controller.destroy());
});

test("insertion observers translate annotated UI and ignore their own text changes", () => {
  let callback;
  let options;
  let disconnected = false;
  class Observer {
    constructor(handler) { callback = handler; }
    observe(root, settings) { options = settings; }
    disconnect() { disconnected = true; }
  }
  const root = element("section");
  root.ownerDocument = { defaultView: { MutationObserver: Observer } };
  const controller = i18n.installUiI18n({ root, interfaceLanguage: "es" });
  assert.deepEqual(options, { childList: true, subtree: true });
  const label = text("Save");
  const added = element("button", { "data-i18n": "Save" }, [label]);
  callback([{ target: root, addedNodes: [added] }]);
  assert.equal(label.nodeValue, "Guardar");
  callback([{ target: added, addedNodes: [label] }]);
  assert.equal(label.nodeValue, "Guardar");
  const replacement = text("Save");
  added.childNodes = [replacement];
  callback([{ target: added, addedNodes: [replacement] }]);
  assert.equal(replacement.nodeValue, "Guardar");
  controller.destroy();
  assert.equal(disconnected, true);
});

test("every annotation in the static interface has English and Spanish text", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder|tooltip|ui-tooltip))?="([^"]+)"/g)].map((match) => match[1].replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&#x27;", "'").replaceAll("&amp;", "&"));
  assert.ok(keys.length > 100, "the main static UI is explicitly annotated");
  for (const key of keys) {
    assert.ok(Object.hasOwn(i18n.UI_TRANSLATIONS.en, key), `English: ${key}`);
    assert.ok(Object.hasOwn(i18n.UI_TRANSLATIONS.es, key), `Spanish: ${key}`);
  }
  for (const id of ["settings-interface-language", "settings-base-locale", "settings-learning-locale"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<option value="auto"/);
  assert.match(html, /<option value="es-AR"/);
});
