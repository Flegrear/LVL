// Shared source-ID selection for source-backed Comics views. The catalog from
// AniList has no source identity; never pretend this choice filters AniList.
export const SOURCE_FILTER_KEY = "lvl-comics-source-filter-v1";
export const SOURCE_FILTER_EVENT = "comics:source-filter-change";
export const ALL_SOURCES = "";
const VALID_SOURCE = /^-?\d{1,20}$/;
const mountedListeners = new WeakMap();

// Source changes are document-wide, but each consumer is a replaceable DOM
// section. Watch the stable document for removal so navigation releases the
// listener even if nobody changes Source again. A remount of the same section
// also closes the previous subscription before installing a replacement.
export function watchFavoriteSource(section, onChange, onDispose = () => {}) {
  mountedListeners.get(section)?.();
  const doc = section.ownerDocument || document;
  let listening = true;
  const dispose = () => {
    if (!listening) return;
    listening = false;
    doc.removeEventListener(SOURCE_FILTER_EVENT, changed);
    observer.disconnect();
    if (mountedListeners.get(section) === dispose) mountedListeners.delete(section);
    onDispose();
  };
  const changed = (event) => {
    if (!section.isConnected) return dispose();
    onChange(event);
  };
  const observer = new MutationObserver(() => {
    if (!section.isConnected) dispose();
  });
  doc.addEventListener(SOURCE_FILTER_EVENT, changed);
  observer.observe(doc, { childList: true, subtree: true });
  mountedListeners.set(section, dispose);
  if (!section.isConnected) dispose();
  return { isActive: () => listening && section.isConnected, dispose };
}

export function sourceChoice(value, sources = []) {
  const id = String(value || "");
  return VALID_SOURCE.test(id) && sources.some((item) => String(item.id) === id) ? id : ALL_SOURCES;
}

export function sourceChoices(sources = []) {
  const seen = new Set();
  return sources.filter((source) => VALID_SOURCE.test(String(source?.id || ""))
    && !seen.has(String(source.id)) && seen.add(String(source.id)));
}

export function filterSources(sources = [], selected = ALL_SOURCES) {
  const id = sourceChoice(selected, sources);
  return id ? sources.filter((source) => String(source.id) === id) : [...sources];
}

export function readSourceChoice(store) {
  try { return String((store === undefined ? globalThis.localStorage : store)?.getItem(SOURCE_FILTER_KEY) || ""); }
  catch { return ALL_SOURCES; }
}

export function saveSourceChoice(id, store) {
  try {
    const target = store === undefined ? globalThis.localStorage : store;
    if (id) target?.setItem(SOURCE_FILTER_KEY, id);
    else target?.removeItem(SOURCE_FILTER_KEY);
  } catch { /* Storage may be disabled in a private WebView. */ }
}

// The same persisted ID is shared by Comics discovery, source browsing,
// Settings' extension list and an individual comic's Sources tab. All changes
// are validated against the actual favorites, never against AniList catalog
// records (which do not identify a provider).
export function selectFavoriteSource(id, favorites = [], store) {
  const selected = sourceChoice(id, favorites);
  saveSourceChoice(selected, store);
  if (typeof globalThis.document?.dispatchEvent === "function") {
    const event = typeof globalThis.CustomEvent === "function"
      ? new CustomEvent(SOURCE_FILTER_EVENT, { detail: { sourceId: selected, favorites: sourceChoices(favorites) } })
      : Object.assign(new Event(SOURCE_FILTER_EVENT), { detail: { sourceId: selected, favorites: sourceChoices(favorites) } });
    globalThis.document.dispatchEvent(event);
  }
  return selected;
}

export function reconcileFavoriteSource(favorites = [], store) {
  const saved = readSourceChoice(store);
  const selected = sourceChoice(saved, favorites);
  if (saved && !selected) selectFavoriteSource(ALL_SOURCES, favorites, store);
  return selected;
}
