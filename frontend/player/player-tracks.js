// Audio and subtitle track choice for the current source.
import { embeddedTrackMatchesSource, mediaSourceOwnerKey, mediaSourcesMatch } from "../../shared/subtitles/subtitle-stream.js";
import { resolveVerifiedSubtitleCueReference } from "../../shared/subtitles/subtitle-identity.js";
import { normalizeAudioMode } from "../../shared/media/audio-policy.js";
import { renderSubtitleWorkspace, state, video } from "../../app.js";
import { $ } from "../app/dom.js";
import { audioOutputMode, preferredAudioLanguage } from "./player-menus.js";
import { libraryChapterName } from "../library/library-page.js";
import { browserCanPlay } from "./browser-media.js";
import { serverCanConvertVideo } from "./video-conversion-capability.js";
import {
  FILE_AUDIO_PREFERENCES_KEY, FILE_AUDIO_PREFERENCES_SCHEMA, fileAudioChoice,
  matchFileAudioChoice, verifiedAudioFileOwner,
} from "./audio-file-preference.js";

export const LANGUAGE_NAMES = { EN: "English", ES: "Spanish", FR: "French", DE: "German", IT: "Italian", PT: "Portuguese", JA: "Japanese", KO: "Korean", ZH: "Chinese", RU: "Russian", NL: "Dutch", PL: "Polish", TR: "Turkish" };
export const languageName = (code) => LANGUAGE_NAMES[String(code || "").toUpperCase()] || String(code || "");

export function preferredLanguagePair() {
  return [state.targetLanguage, state.baseLanguage].filter((value, index, array) => value && array.indexOf(value) === index);
}

export function normalizeTrackLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  const map = {
    eng: "EN", en: "EN", spa: "ES", es: "ES", fre: "FR", fra: "FR", fr: "FR",
    ger: "DE", deu: "DE", de: "DE", ita: "IT", it: "IT", por: "PT", pt: "PT",
    jpn: "JA", ja: "JA", jp: "JA", kor: "KO", ko: "KO", chi: "ZH", zho: "ZH", zh: "ZH",
    rus: "RU", ru: "RU", dut: "NL", nld: "NL", nl: "NL", pol: "PL", pl: "PL", tur: "TR", tr: "TR",
  };
  return map[raw] || raw.slice(0, 2).toUpperCase();
}

export function normalizeCollectionTitle(...candidates) {
  const source = candidates.find((value) => String(value || "").trim()) || "Untitled source";
  const raw = String(source)
    .replace(/\.(mp4|m4v|webm|mkv|avi|mov|ogv)$/i, "")
    .replace(/^\s*\[?pseudo\]?\s*/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const qualityTag = raw.match(/\[(BDRip|BluRay|WEB[- .]?DL|WEBRip|HDTV|DVDRip)\]/i)?.[1];
  let base = raw
    .replace(/\bSeason\s+\d+\b.*$/i, "")
    .replace(/\bS\d{1,2}E\d{1,4}\b.*$/i, "")
    .replace(/\b\d{1,2}x\d{1,4}\b.*$/i, "")
    .replace(/\s+(?:19|20)\d{2}\s+(?=(?:2160p|1080p|720p|576p|480p|4K|WEB[- .]?DL|WEBRip|BluRay|BDRip|HDTV|DVDRip)\b).*$/i, "")
    .replace(/\s+\b(?:2160p|1080p|720p|576p|480p|4K|WEB[- .]?DL|WEBRip|BluRay|BDRip|HDTV|DVDRip|REMUX)\b.*$/i, "")
    .replace(/\[(?:UNCENSORED|1080p|720p|2160p|4K|HEVC|H\.?26[45]|x26[45]|10bit|8bit|AAC[^\]]*|DTS[^\]]*)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) base = raw.replace(/\[[^\]]+\]/g, "").trim() || "Untitled source";
  const canonicalQuality = qualityTag ? qualityTag.replace(/web[- .]?dl/i, "WEB-DL") : "";
  return `${base}${canonicalQuality ? ` [${canonicalQuality}]` : ""}`.trim();
}

export function episodeIdentity(fileName) {
  const raw = String(fileName || "").replace(/\.[^.]+$/, "").replace(/[._]+/g, " ");
  const match = raw.match(/\bS(\d{1,2})E(\d{1,4})\b/i) || raw.match(/(?:^|\D)(\d{1,2})x(\d{1,4})(?:\D|$)/i);
  if (!match) return { code: "VIDEO", title: cleanMediaTitle(fileName) };
  const code = `S${match[1].padStart(2, "0")}E${match[2].padStart(2, "0")}`;
  const marker = match[0].trim();
  const markerIndex = raw.toLowerCase().indexOf(marker.toLowerCase());
  let title = markerIndex >= 0 ? raw.slice(markerIndex + marker.length) : "";
  title = title
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\b(?:BDRip|BluRay|WEB[- .]?DL|WEBRip|HDTV|HEVC|H\.?26[45]|x26[45]|1080p|720p|2160p)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { code, title: title || code };
}

export function sourceTagFor(file, collectionTitle) {
  const episode = episodeIdentity(file?.name || "");
  return episode.code === "VIDEO" ? collectionTitle : `${collectionTitle} - ${episode.code}`;
}

export function updatePlayerIdentity(title, episode = null) {
  const mainTitle = String(title || "Untitled").trim() || "Untitled";
  const code = String(episode?.code || "VIDEO").toUpperCase();
  const match = code.match(/^S(\d{1,2})E(\d{1,4})$/);
  $("#media-title").textContent = mainTitle;
  const label = match ? `${mainTitle}: S${Number(match[1])} E${Number(match[2])}` : mainTitle;
  if ($("#player-now-title")) $("#player-now-title").textContent = label;
}

// Remember the *series* audio choice, not a fragile episode-specific FFprobe
// index. The same dub often moves between stream 0 and stream 1 in new files.
const SERIES_AUDIO_PREFERENCES_KEY = "lvl-series-audio-preferences-v1";
const seriesAudioPreferences = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(SERIES_AUDIO_PREFERENCES_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return new Map();
    return new Map(Object.entries(saved).filter(([key, choice]) => key.length <= 200 && choice
      && typeof choice === "object" && !Array.isArray(choice)).slice(-80));
  } catch { return new Map(); }
})();

// v1 is immutable migration input: preserve its records (including unknown
// legacy intent) until an explicit user selection provides current probe
// evidence. An unsupported future v2 document must also remain untouched.
let fileAudioPreferences = (() => {
  try {
    const raw = localStorage.getItem(FILE_AUDIO_PREFERENCES_KEY);
    if (!raw) return { schema: FILE_AUDIO_PREFERENCES_SCHEMA, byFile: {} };
    const parsed = JSON.parse(raw);
    return parsed && parsed.schema === FILE_AUDIO_PREFERENCES_SCHEMA
      && parsed.byFile && typeof parsed.byFile === "object"
      && !Array.isArray(parsed.byFile) ? parsed : null;
  } catch { return null; }
})();

function rememberFileAudioTrack(track, index, count, source) {
  const choice = fileAudioChoice(source, track, index, count, state.currentMediaProbe?.audioTracks);
  if (!choice || !fileAudioPreferences) return;
  const next = { ...fileAudioPreferences,
    byFile: { ...fileAudioPreferences.byFile, [choice.fileOwner]: choice } };
  try {
    localStorage.setItem(FILE_AUDIO_PREFERENCES_KEY, JSON.stringify(next));
    fileAudioPreferences = next;
  } catch (error) { console.warn("Could not save file audio selection:", error); }
}

function sourceAudioPreferenceKey(source = state.currentSource) {
  const key = String(source?.seriesKey || (source?.catalogId
    ? `catalog:${source.catalogType || "series"}:${source.catalogId}` : source?.title || source?.libraryId || ""))
    .trim().toLowerCase();
  return key.slice(0, 200);
}

function audioTrackIdentity(track) {
  const title = String(track?.title || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  const raw = String(track?.language || "").trim().toLowerCase();
  const languages = { ja: "jpn", jp: "jpn", japanese: "jpn", en: "eng", english: "eng",
    es: "spa", spanish: "spa", fr: "fra", fre: "fra", french: "fra",
    de: "deu", ger: "deu", german: "deu", pt: "por", portuguese: "por",
    ko: "kor", korean: "kor", zh: "zho", chi: "zho", chinese: "zho",
    it: "ita", italian: "ita", ru: "rus", russian: "rus" };
  // FFprobe may return `und` while the stream title says JP/JPN or ENG. Without
  // this identity, a renamed track can fall back to its old *index* even when
  // that index now contains the other language in the next episode.
  const hasJapaneseLabel = /\b(?:japanese|jpn|jp|ja)\b/i.test(title);
  const hasEnglishLabel = /\b(?:english|eng)\b/i.test(title);
  const titledLanguage = hasJapaneseLabel && !hasEnglishLabel ? "jpn"
    : hasEnglishLabel && !hasJapaneseLabel ? "eng"
    : hasJapaneseLabel && hasEnglishLabel ? ""
    : Object.entries(languages).find(([name]) => name.length > 2 && new RegExp(`\\b${name}\\b`).test(title))?.[1] || "";
  const language = languages[raw] || (raw === "und" || raw === "unknown" ? "" : raw)
    || titledLanguage;
  return { language, title };
}

// Kept in the audio-preference section so the existing isolated preference
// harness can exercise legacy saved records without importing the full app.
const sourceAudioFileKey = (source) =>
  typeof mediaSourceOwnerKey === "function" ? mediaSourceOwnerKey(source) : "";

function sourceAudioCatalogKey(source = state.currentSource) {
  const id = String(source?.catalogId || "").trim().toLowerCase().slice(0, 100);
  if (!id) return "";
  const type = String(source?.catalogType || "series").trim().toLowerCase().slice(0, 32);
  return `catalog:${type}:${id}`;
}

// Human-readable series keys may change after catalog relinking or a title
// translation. Catalog choices therefore live under a stable identity within
// each bounded series record, but must be searched independently of its key.
// An explicit choice made before a catalog link is also an owned preference:
// only that unscoped intent can override an older catalog choice later.
const audioChoiceAt = (choice) => Number.isSafeInteger(choice?.selectedAt) && choice.selectedAt > 0
  ? choice.selectedAt : 0;
let lastAudioChoiceAt = 0;
for (const choice of seriesAudioPreferences.values()) {
  lastAudioChoiceAt = Math.max(lastAudioChoiceAt, audioChoiceAt(choice), audioChoiceAt(choice?.unscopedPreference));
  if (choice?.catalogPreferences && typeof choice.catalogPreferences === "object"
    && !Array.isArray(choice.catalogPreferences)) {
    for (const entry of Object.values(choice.catalogPreferences).slice(-12))
      lastAudioChoiceAt = Math.max(lastAudioChoiceAt, audioChoiceAt(entry));
  }
}

function catalogAudioPreference(catalogKey) {
  let chosen = seriesAudioPreferences.get(catalogKey) || null; // Legacy catalog-only key.
  for (const choice of seriesAudioPreferences.values()) {
    const entry = choice?.catalogPreferences?.[catalogKey];
    if (entry && typeof entry === "object" && !Array.isArray(entry)
      && (!chosen || audioChoiceAt(entry) >= audioChoiceAt(chosen))) chosen = entry;
  }
  return chosen;
}

export function rememberSeriesAudioTrack(track, index, source = state.currentSource) {
  const key = sourceAudioPreferenceKey(source);
  if (!Number.isInteger(index) || index < 0) return;
  const count = Array.isArray(state.currentMediaProbe?.audioTracks) ? state.currentMediaProbe.audioTracks.length : 0;
  // This exact file/stream (or explicitly same-file ordinal) takes priority
  // over any legacy title/series heuristic at next playback.
  rememberFileAudioTrack(track, index, count, source);
  if (!key) return;
  const identity = audioTrackIdentity(track);
  const explicitLanguage = String(track?.language || "").trim().toLowerCase();
  const provenLanguage = /^(?!und$|unknown$)[a-z]{2,3}$/.test(explicitLanguage);
  // A language guessed from an unverified title is NOT a durable series dub.
  // Preserve the raw probe title only as exact metadata; a title-only choice
  // will be applied exclusively to the same verified file.
  if (!provenLanguage) identity.language = "";
  if (!track?.title?.trim?.()) identity.title = "";
  if (!identity.language && !identity.title) return;
  lastAudioChoiceAt = Math.max(Date.now(), lastAudioChoiceAt + 1);
  // An unlabeled ordinal is meaningful only within the selected media file.
  // Labeled preferences can still follow a dub across episodes and reorders.
  const choice = { ...identity, index, count, fileOwner: sourceAudioFileKey(source),
    provenLanguage, selectedAt: lastAudioChoiceAt };
  const catalogKey = sourceAudioCatalogKey(source);
  const prior = seriesAudioPreferences.get(key);
  const catalogs = prior?.catalogPreferences && typeof prior.catalogPreferences === "object"
    && !Array.isArray(prior.catalogPreferences)
    ? new Map(Object.entries(prior.catalogPreferences).slice(-12)) : new Map();
  if (catalogKey) {
    catalogs.delete(catalogKey);
    catalogs.set(catalogKey, { ...choice });
    while (catalogs.size > 12) catalogs.delete(catalogs.keys().next().value);
  }
  // Retain a newer explicit unlinked choice even if this same title later
  // gets assigned a catalog ID, without mistaking a scoped choice for one.
  if (!catalogKey) choice.unscopedPreference = { ...choice };
  else if (prior?.unscopedPreference) choice.unscopedPreference = prior.unscopedPreference;
  if (catalogs.size) choice.catalogPreferences = Object.fromEntries(catalogs);
  seriesAudioPreferences.delete(key);
  seriesAudioPreferences.set(key, choice);
  while (seriesAudioPreferences.size > 80) seriesAudioPreferences.delete(seriesAudioPreferences.keys().next().value);
  try { localStorage.setItem(SERIES_AUDIO_PREFERENCES_KEY, JSON.stringify(Object.fromEntries(seriesAudioPreferences))); }
  catch (error) { console.warn("Could not save series audio preference:", error); }
}

export function preferredAudioTrackIndex(media, source = state.currentSource) {
  const tracks = Array.isArray(media?.audioTracks) ? media.audioTracks : [];
  if (!tracks.length) return 0;
  const owner = verifiedAudioFileOwner(source);
  const preciseChoice = owner && fileAudioPreferences?.byFile?.[owner];
  const preciseIndex = matchFileAudioChoice(tracks, preciseChoice, source);
  if (preciseChoice) {
    // An explicit v2 file/stream selection is current authority. If FFprobe
    // no longer advertises that stream, fall back to the safe default rather
    // than replaying an older v1 title/ordinal onto a different audio stream.
    return preciseIndex >= 0 ? preciseIndex : 0;
  }
  const key = sourceAudioPreferenceKey(source);
  let saved = key ? seriesAudioPreferences.get(key) : null;
  const catalogKey = sourceAudioCatalogKey(source);
  if (catalogKey) {
    const catalogChoice = catalogAudioPreference(catalogKey);
    const unscopedChoice = saved?.unscopedPreference;
    if (unscopedChoice && (!catalogChoice || audioChoiceAt(unscopedChoice) > audioChoiceAt(catalogChoice)))
      saved = unscopedChoice;
    else if (catalogChoice) saved = catalogChoice;
    else if (saved?.catalogPreferences) saved = null;
    // Legacy v1 choices without a catalog owner still load by series key.
    // Once scoped choices exist, another catalog cannot inherit them.
  }
  if (saved) {
    const sameFile = Boolean(saved.fileOwner && saved.fileOwner === sourceAudioFileKey(source));
    // v1 predates provenLanguage. A legacy *pair* of language and specific
    // track title can still be honored if a unique present probe stream has
    // BOTH matching fields and an explicit language. Never use its ordinal,
    // accept a title-only guess, or carry a modern explicitly unproven choice.
    if (!sameFile && saved.provenLanguage !== true) {
      if (saved.provenLanguage !== undefined || saved.fileOwner
        || typeof saved.title !== "string" || !saved.title.trim()
        || typeof saved.language !== "string" || !saved.language.trim()) return 0;
      const expectedLanguage = audioTrackIdentity({ language: saved.language }).language;
      const expectedTitle = saved.title.trim().toLowerCase().replace(/\s+/g, " ");
      const exactLegacy = tracks.map((track, index) => {
        const explicit = String(track?.language || "").trim().toLowerCase();
        const actual = audioTrackIdentity(track);
        return /^(?!und$|unknown$)[a-z]{2,3}$/.test(explicit)
          && expectedLanguage && actual.language === expectedLanguage
          && actual.title === expectedTitle ? index : -1;
      }).filter(index => index >= 0);
      return exactLegacy.length === 1 ? exactLegacy[0] : 0;
    }
    const identities = tracks.map(audioTrackIdentity);
    const exact = identities.findIndex((track) => track.title && track.title === saved.title
      && (!saved.language || track.language === saved.language));
    if (exact >= 0) return exact;
    if (saved.language) {
      // A dubbed dialogue track can disappear between episodes while an
      // English commentary/descriptive track occupies the former stream index.
      // Language-only fallback is valid when labels are absent, but never
      // silently change an ordinary dub into ancillary narration (or vice
      // versa). Explicit user selections can still choose either track.
      const ancillary = (title) => /\b(?:commentary|descriptive|description|narration|visual[- ]impair(?:ed|ment))\b/i.test(String(title || ""));
      const savedAncillary = saved.title ? ancillary(saved.title) : null;
      const matching = identities.map((track, index) => track.language === saved.language
        && (savedAncillary === null || !track.title || ancillary(track.title) === savedAncillary)
        ? index : -1).filter((index) => index >= 0);
      if (matching.includes(saved.index)) return saved.index;
      if (matching.length) return matching[0];
      // Never fall back to the same index in a different language.
      return 0;
    }
    if (saved.title && sameFile) {
      const byTitle = identities.findIndex((track) => track.title === saved.title);
      if (byTitle >= 0) return byTitle;
    }
    if (saved.fileOwner && saved.fileOwner === sourceAudioFileKey(source)
      && Number.isInteger(saved.index) && saved.index >= 0 && saved.index < tracks.length
      && saved.count === tracks.length) return saved.index;
    return 0;
  }
  // Legacy session fallback only for ungrouped media. Do not leak a dub choice
  // from one series into a different series with no preference of its own.
  if (key) return 0;
  if (!preferredAudioLanguage) return 0;
  const index = tracks.findIndex((track) => audioTrackIdentity(track).language === preferredAudioLanguage);
  return index >= 0 ? index : 0;
}

export function transcodeQuery(startSeconds, audioIndex = state.selectedAudioTrack || 0) {
  const params = new URLSearchParams({ start: Math.max(0, Number(startSeconds) || 0).toFixed(3), audio: String(audioIndex) });
  params.set("audioMode", normalizeAudioMode(audioOutputMode));
  const codec = String(state.currentMediaProbe?.video?.codec || "").toLowerCase();
  const bitDepth = Number(state.currentMediaProbe?.compatibility?.video?.bitDepth)
    || Number(state.currentMediaProbe?.video?.bitDepth) || (/p10|10le|10be/i.test(String(state.currentMediaProbe?.video?.pixelFormat || "")) ? 10 : 8);
  let forceH264 = Boolean(state.transcodeContext?.forceH264);
  if (state.transcodeContext?.copyVideo) {
    params.set("video", "copy");
  }
  if (codec === "hevc" && state.transcodeContext?.copyVideo) {
    const supported = browserCanPlay(bitDepth > 8 ? 'video/mp4; codecs="hvc1.2.4.L153.B0"' : 'video/mp4; codecs="hvc1.1.6.L120.B0"',
      (mime) => video.canPlayType(mime));
    if (supported) { params.set("video", "copy"); params.set("hevc", "1"); }
    else if (serverCanConvertVideo() && !state.currentMediaProbe?.compatibility?.video?.hdr
      && !state.currentMediaProbe?.compatibility?.video?.hdrKind
      && !state.currentMediaProbe?.video?.dolbyVision) {
      // A missing client HEVC opt-in makes server.js encode H264 even if this
      // request says video=copy. Keep the client seek clock in the SAME mode
      // as the real encoder; otherwise it waits for nonexistent GOP preroll
      // after accurate input seeking and can end in native MediaError4.
      forceH264 = true;
    }
  }
  if (codec === "av1" && state.transcodeContext?.copyVideo) {
    const supported = browserCanPlay(bitDepth > 8 ? 'video/mp4; codecs="av01.0.12M.10"' : 'video/mp4; codecs="av01.0.12M.08"',
      (mime) => video.canPlayType(mime));
    if (supported) { params.set("video", "copy"); params.set("av1", "1"); }
    else if (serverCanConvertVideo() && !state.currentMediaProbe?.compatibility?.video?.hdr
      && !state.currentMediaProbe?.compatibility?.video?.hdrKind
      && !state.currentMediaProbe?.video?.dolbyVision) {
      // Keep the seek clock aligned if the server must actually re-encode AV1.
      forceH264 = true;
    }
  }
  // A codec that was advertised as playable may still fail on this PC.
  // An error-triggered compatibility retry must not select that codec again.
  if (forceH264) {
    params.delete("hevc");
    params.delete("av1");
    params.set("video", "h264");
    // Query construction is side-effect-free: the caller commits a discovered
    // fallback only after the current decoder/source accepts this URL.
  }
  return params;
}

export function releaseNeedsAudioTranscode(value) {
  return /\b(?:DDP(?:5[. ]?1)?|E-?AC-?3|EAC3|AC-?3|TRUEHD|DTS(?:-HD)?|ATMOS)\b/i.test(String(value || ""));
}

export function syncSelectedTrackForSource() {
  const scoped = currentSourceTracks();
  const target = scoped.find((track) => String(track.language || "").toUpperCase() === state.targetLanguage);
  const base = scoped.find((track) => String(track.language || "").toUpperCase() === state.baseLanguage);
  if (target) state.selectedTrackId = target.id;
  else if (!scoped.some((track) => track.id === state.selectedTrackId)) state.selectedTrackId = base?.id || scoped[0]?.id || null;
}

export function applyLanguagePreferencesToTracks() {
  const scoped = currentSourceTracks();
  const chosenIds = [];
  preferredLanguagePair().forEach((language) => {
    const match = scoped.find((track) => String(track.language || "").toUpperCase() === language && !chosenIds.includes(track.id));
    if (match && chosenIds.length < 2) chosenIds.push(match.id);
  });
  if (!chosenIds.length) scoped.slice(0, 2).forEach((track) => chosenIds.push(track.id));
  scoped.forEach((track) => { track.visible = chosenIds.includes(track.id); });
  syncSelectedTrackForSource();
}

export function preferredSourceTracks() {
  const pair = preferredLanguagePair();
  const scoped = currentSourceTracks();
  const preferred = pair.map((language) => scoped.find((track) => String(track.language || "").toUpperCase() === language)).filter(Boolean);
  const preferredIds = new Set(preferred.map((track) => track.id));
  return [...preferred, ...scoped.filter((track) => !preferredIds.has(track.id))];
}

export function cleanMediaTitle(value) {
  return String(value || "")
    .replace(/\.(mp4|m4v|webm|mkv|avi|mov|ogv)$/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function activeTrack() {
  const scoped = currentSourceTracks();
  return scoped.find((track) => track.id === state.selectedTrackId) || scoped[0];
}

export function currentSourceTracks() {
  const source = state.currentSource;
  if (!mediaSourceOwnerKey(source)) return [];
  return state.tracks.filter((track) => mediaSourcesMatch(track.source, source)
    && (track.origin !== "embedded" || embeddedTrackMatchesSource(track, source)));
}

// Read an additive v2 cue reference only against the current verified file
// AND actual container stream, never by title, UI ordinal, or legacy cue ID.
// This does not rekey, evict or opportunistically link saved legacy cards.
export function resolveCurrentSubtitleCueReference(reference) {
  if (!reference || reference.schema !== "lvl.subtitle-cue-ref.v2") return null;
  let found = null;
  for (const track of currentSourceTracks()) {
    const stored = track?.verifiedStreamReference;
    if (track.origin !== "embedded" || !Number.isSafeInteger(track.embeddedStreamIndex)
      || !stored || stored.schema !== reference.schema
      || stored.mediaOwner !== reference.mediaOwner
      || stored.streamIndex !== reference.streamIndex
      || stored.streamIndex !== track.embeddedStreamIndex) continue;
    const cue = resolveVerifiedSubtitleCueReference(reference, state.currentSource,
      track.embeddedStreamIndex, track.cues);
    if (!cue) continue;
    // Two ambiguous matching live records must never silently choose a card.
    if (found) return null;
    found = { track, cue };
  }
  return found;
}

export function selectSubtitleTrackForCards(track, cueReference = null) {
  // Subtitle selection changes the analysis language, not the player identity.
  // Reject stale UI cards left behind by an asynchronous source transition.
  const scoped = currentSourceTracks();
  // Even within the same file, an old card cannot select a replacement track
  // which happens to reuse a legacy ID.
  if (!track || scoped.filter((item) => item.id === track.id).length !== 1
    || !scoped.includes(track)) return false;
  // A versioned saved cue additionally fences the exact file/stream/content.
  // Legacy callers with no verified reference retain their prior behavior;
  // unresolved records are never silently migrated or deleted.
  if (cueReference !== null && resolveCurrentSubtitleCueReference(cueReference)?.track !== track)
    return false;
  state.selectedTrackId = track.id;

  renderSubtitleWorkspace();
  return true;
}

export function activeSourceTag() {
  const track = activeTrack();
  const source = track?.sourceTag || state.currentSource?.sourceTag || "No source loaded";
  return track?.language ? `${source} - ${track.language}` : source;
}

// Stored source tags join their parts with " · " (cards and word lists match on them); on
// screen they read "Slime, S1 E1, Japanese".
export function sourceTagText(tag) {
  return String(tag || "").split(/\s+·\s+/).filter(Boolean).map((part) => {
    if (/^S\d{2}E\d{2,4}$/i.test(part)) return libraryChapterName({ code: part }) || part;
    if (/^[A-Z]{2,3}$/.test(part) && LANGUAGE_NAMES[part]) return languageName(part);
    if (part === "VIDEO") return "";
    return part;
  }).filter(Boolean).join(", ");
}
