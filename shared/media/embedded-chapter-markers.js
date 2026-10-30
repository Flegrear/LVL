// Parse only explicit chapter titles from the *selected media file's* FFprobe
// metadata. Never infer skip times from chapter order, names of other files,
// episode averages, or a missing end boundary. The caller must keep the result
// scoped to the same probed file; these markers are not transferable to a dub,
// alternate cut, or another torrent file.

const MAX_CHAPTERS = 512;
const MAX_DURATION_SECONDS = 24 * 60 * 60;
const MAX_DECIMAL_LENGTH = 48;
const EMPTY = () => ({ intro: null, outro: null });

const TITLES = new Map([
  ['op', 'intro'], ['opening', 'intro'], ['intro', 'intro'],
  ['ed', 'outro'], ['ending', 'outro'], ['outro', 'outro'], ['credits', 'outro'],
]);

function decimalSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // FFprobe ordinarily emits start_time/end_time as decimal strings. Reject
  // coercions like null, blank strings, exponential notation and clock labels.
  if (typeof value !== 'string' || value.length > MAX_DECIMAL_LENGTH ||
      !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
}

function exactChapterKind(chapter) {
  if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) return { invalid: true };
  const labels = [chapter.title, chapter.tags?.title, chapter.tags?.TITLE]
    .filter(value => value !== undefined && value !== null);
  if (labels.some(value => typeof value !== 'string' || value.length > 80)) return { invalid: true };
  const names = labels.map(value => value.trim().toLowerCase()).filter(Boolean);
  // Contradictory titles on the same chapter must not be resolved by choosing
  // whichever one happens to say "Opening" or "Ending".
  if (names.some(name => name !== names[0])) return { invalid: true };
  return { kind: TITLES.get(names[0]) || null };
}

/**
 * @param {unknown} chapters FFprobe `chapters` array from the selected MKV only.
 * @param {number|string} durationSeconds Verified total duration of that file.
 * @returns {{intro: null|object, outro: null|object}}
 * A marker uses `{start_ms, end_ms, match:'exact', confidence:1,
 * source:'embedded-chapter'}` so the existing interval validator can consume
 * it. `exact` means same-file explicit times, not a provider's cut match.
 */
export function normalizeEmbeddedChapterMarkers(chapters, durationSeconds) {
  const duration = decimalSeconds(durationSeconds);
  if (duration === null || duration <= 0 || duration > MAX_DURATION_SECONDS ||
      !Array.isArray(chapters) || chapters.length > MAX_CHAPTERS) return EMPTY();

  const parsed = [];
  const candidates = { intro: [], outro: [] };
  for (const chapter of chapters) {
    const label = exactChapterKind(chapter);
    if (label.invalid) return EMPTY();
    const start = decimalSeconds(chapter.start_time);
    const end = decimalSeconds(chapter.end_time);
    // All intervals must be usable to exclude overlapping generic chapters.
    // A malformed chapter could mask a conflicting section, so fail closed.
    if (start === null || end === null || start < 0 || end <= start || end > duration)
      return EMPTY();
    const record = { kind: label.kind, start, end };
    parsed.push(record);
    if (record.kind) candidates[record.kind].push(record);
  }

  if (candidates.intro.length > 1 || candidates.outro.length > 1) return EMPTY();
  const result = EMPTY();
  for (const kind of ['intro', 'outro']) {
    const candidate = candidates[kind][0];
    if (!candidate || candidate.end - candidate.start <= 4 ||
        (kind === 'intro' && (candidate.start > duration * .4 || candidate.end > duration * .5)) ||
        (kind === 'outro' && candidate.start < duration * .6)) continue;
    // Requiring a non-overlapping chapter also rejects nested, contradictory,
    // and overlapping intro/outro metadata rather than picking a plausible one.
    if (parsed.some(other => other !== candidate &&
        candidate.start < other.end && other.start < candidate.end)) continue;
    const startMs = Math.round(candidate.start * 1000);
    const endMs = Math.round(candidate.end * 1000);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) ||
        endMs - startMs <= 4000) continue;
    result[kind] = { start_ms: startMs, end_ms: endMs,
      match: 'exact', confidence: 1, source: 'embedded-chapter' };
  }
  return result;
}
