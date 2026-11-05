// Shared source-ID selection for source-backed Comics views. The catalog from
// AniList has no source identity; never pretend this choice filters AniList.
export const SOURCE_FILTER_KEY = "lvl-comics-source-filter-v1";
export const ALL_SOURCES = "";
const VALID_SOURCE = /^-?\d{1,20}$/;

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
