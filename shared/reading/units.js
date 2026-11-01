// Volume and chapter numbers for comics (and later books). Shared by the
// browser and the server. Numbers stay strings ("136.5", "0") so nothing is
// lost; sorting compares them numerically. A missing volume is null: those
// chapters haven't been collected into a volume yet.

const NUMBER = /^\d{1,5}(?:\.\d{1,3})?$/;

export function normalizeUnitNumber(value) {
  const text = String(value ?? "").trim().replace(/^0+(?=\d)/, "");
  return NUMBER.test(text) ? text : null;
}

export function compareUnitNumbers(a, b) {
  const left = normalizeUnitNumber(a);
  const right = normalizeUnitNumber(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return Number(left) - Number(right) || left.localeCompare(right);
}

// Stable key for one unit, used in URLs, progress and file matches.
export function unitKey({ volume = null, chapter = null } = {}) {
  const v = normalizeUnitNumber(volume);
  const c = normalizeUnitNumber(chapter);
  if (c !== null) return v !== null ? `v${v}-c${c}` : `c${c}`;
  return v !== null ? `v${v}` : "";
}

export function parseUnitKey(key) {
  const match = /^(?:v(\d{1,5}(?:\.\d{1,3})?))?(?:-?c(\d{1,5}(?:\.\d{1,3})?))?$/.exec(String(key || ""));
  if (!match || (!match[1] && !match[2])) return null;
  return { volume: match[1] ?? null, chapter: match[2] ?? null };
}

// [{ volume, chapters: [{ chapter, ... }] }] sorted, with the volume-less group last.
export function sortVolumes(volumes = []) {
  return [...volumes]
    .map((group) => ({ ...group, chapters: [...(group.chapters || [])].sort((x, y) => compareUnitNumbers(x.chapter, y.chapter)) }))
    .sort((x, y) => compareUnitNumbers(x.volume, y.volume));
}

export function countChapters(volumes = []) {
  return volumes.reduce((total, group) => total + (group.chapters?.length || 0), 0);
}
