// Finding subtitles: languages, web search, files and imports.
import { parseSubtitle } from "../../learning/browser/core.js";
import { escapeHtml } from "../ui/ui.js";
import { normalizeLearningLocale } from "../../shared/settings/language-settings.js";
import { empty, quiz, renderSubtitleWorkspace, state, uiLanguage } from "../../app.js";
import { persistPreferences } from "../app/saved-state.js";
import { $, $$, setToolStatus } from "../app/dom.js";
import { postJson } from "../app/http.js";
import { renderSettings } from "../settings/settings-page.js";
import {
  applyLanguagePreferencesToTracks, currentSourceTracks, episodeIdentity, languageName,
  normalizeCollectionTitle, normalizeTrackLanguage, preferredLanguagePair,
} from "./player-tracks.js";
import { ensureTrackRomanization, isRomanizableLanguage } from "./subtitle-display.js";
import {
  alignCurrentSubtitleSet, subtitleFingerprint, subtitleTimelineFit, syncTrackToBestReference,
} from "./subtitle-timing.js";
import { applySavedSubtitleSync, scheduleAudioSync } from "./audio-sync.js";
import {
  closeLiveCoachSession, ensureLearningPreset, learningPresetCache, saveCurrentEpisodeAnalysis,
  stopStudySounds, stopVoiceSpeech, touchLearningState, voiceChat, voiceRecognition,
} from "../learning/index.js";

function subtitleSearchLanguages() {
  return preferredLanguagePair().join(",");
}

// Subtitle discovery uses its own saved language choice, including when opened
// with an automatic search. Learning preferences cannot override this field.
export function subtitleFinderLanguages() {
  return localStorage.getItem("lvl-subtitle-finder-languages") || "ES,EN";
}
export function parseSubtitleFinderLanguages(input) {
  const codes = [...new Set(String(input || "").toUpperCase().split(",").map((value) => value.trim()).filter(Boolean))];
  return codes.length > 0 && codes.length <= 4 && codes.every((code) => /^[A-Z]{2}$/.test(code)) ? codes : null;
}
export function syncSubtitleFinderLanguageChips() {
  const selected = new Set(parseSubtitleFinderLanguages($("#subtitle-language")?.value) || []);
  $$("#subtitle-web-dialog [data-subtitle-lang-toggle]").forEach((button) => {
    const active = selected.has(button.dataset.subtitleLangToggle);
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-selected", active);
  });
}

export function saveSubtitlePreferences(apiKey, baseLanguage = state.baseLanguage, targetLanguage = state.targetLanguage, {
  wyzieKey = state.wyzieKey,
  subsourceKey = state.subsourceKey,
  baseLocale = state.baseLocale,
  targetLocale = state.targetLocale,
  interfaceLanguage = state.interfaceLanguage,
} = {}) {
  const previousTargetLanguage = state.targetLanguage;
  const previousBaseLanguage = state.baseLanguage;
  const previousLocales = `${state.targetLocale}|${state.baseLocale}`;
  state.subdlKey = String(apiKey || "").trim();
  state.wyzieKey = String(wyzieKey || "").trim();
  state.subsourceKey = String(subsourceKey || "").trim();
  state.baseLanguage = String(baseLanguage || "EN").trim().toUpperCase() || "EN";
  state.targetLanguage = String(targetLanguage || "ES").trim().toUpperCase() || "ES";
  if (state.targetLanguage === state.baseLanguage) state.targetLanguage = state.baseLanguage === "EN" ? "ES" : "EN";
  state.baseLocale = normalizeLearningLocale(state.baseLanguage, baseLocale);
  state.targetLocale = normalizeLearningLocale(state.targetLanguage, targetLocale);
  state.interfaceLanguage = ["en", "es"].includes(interfaceLanguage) ? interfaceLanguage : "auto";
  uiLanguage.setLanguage(state.interfaceLanguage, state.baseLanguage);
  localStorage.setItem("blackline-base-locale", state.baseLocale);
  localStorage.setItem("blackline-target-locale", state.targetLocale);
  localStorage.setItem("blackline-interface-language", state.interfaceLanguage);
  localStorage.setItem("blackline-subdl-key", state.subdlKey);
  localStorage.setItem("blackline-wyzie-key", state.wyzieKey);
  localStorage.setItem("blackline-subsource-key", state.subsourceKey);
  localStorage.setItem("blackline-base-language", state.baseLanguage);
  localStorage.setItem("blackline-target-language", state.targetLanguage);
  localStorage.setItem("blackline-subdl-languages", subtitleSearchLanguages());
  persistPreferences();
  if (previousTargetLanguage !== state.targetLanguage || previousBaseLanguage !== state.baseLanguage) {
    quiz.question = null;
    quiz.picked = null;
    quiz.recent = [];
    stopStudySounds();
  }
  if (previousTargetLanguage !== state.targetLanguage || previousBaseLanguage !== state.baseLanguage || previousLocales !== `${state.targetLocale}|${state.baseLocale}`) {
    if (voiceChat.providerConversationId || voiceChat.providerLive) void closeLiveCoachSession();
    try { voiceRecognition?.abort?.(); } catch {}
    stopVoiceSpeech({ render: false });
  }
  if (previousTargetLanguage !== state.targetLanguage) {
    state.studyPage = 0;
    state.learningPreset = learningPresetCache.get(state.targetLanguage) || { language: state.targetLanguage, words: [], phrases: [], status: "idle", error: "" };
    touchLearningState();
    if (state.wordColoring || state.studySource === "preset") void ensureLearningPreset(state.targetLanguage);
  }
  applyLanguagePreferencesToTracks();
  renderSettings();
}

export async function handleSubtitleFiles(files) {
  const sourceAtSelection = state.currentSource;
  let duplicates = 0;
  for (const file of files) {
    const text = await file.text();
    // File.text() can finish after the player opens a different episode.
    // Never attach the old episode's captions to the new current source.
    if (state.currentSource !== sourceAtSelection) return;
    const label = file.name.replace(/\.(srt|vtt)$/i, "");
    const result = addSubtitleText(text, label);
    if (!result.added) duplicates += 1;
  }
  renderSubtitleWorkspace();
  if (duplicates) $("#media-status").textContent = `${duplicates} duplicate subtitle file${duplicates === 1 ? "" : "s"} skipped`;
}

export function addSubtitleText(text, label, language = "", options = {}) {
  const id = `track-${crypto.randomUUID()}`;
  const cues = parseSubtitle(text, id);
  // An embedded track can have no lines in the part read so far (an opening,
  // a quiet scene); options.allowEmpty adds it anyway and later parts fill it.
  if (!cues.length && !options.allowEmpty) throw new Error("No SRT/VTT cues were found in that subtitle file.");
  const inferredLanguage = label.match(/(?:^|[._ -])(en|es|fr|de|it|pt|ja|jp|ko|zh)(?:$|[._ -])/i)?.[1] || "";
  const languageGuess = normalizeTrackLanguage(language) || normalizeTrackLanguage(inferredLanguage) || `T${state.tracks.length + 1}`;
  const source = state.currentSource ? structuredClone(state.currentSource) : null;
  const sourceTag = source?.sourceTag || label;
  const fingerprint = subtitleFingerprint(cues);
  const duplicate = cues.length && currentSourceTracks().find((track) => {
    if (String(track.language || "").toUpperCase() !== languageGuess) return false;
    return (track.fingerprint || subtitleFingerprint(track.cues)) === fingerprint;
  });
  if (duplicate) return { id: duplicate.id, added: false, duplicate: true, track: duplicate };
  const isPreferred = preferredLanguagePair().includes(languageGuess);
  const timelineFit = options.exactMedia ? { ratio: null, severeMismatch: false } : subtitleTimelineFit(cues);
  state.tracks.push({
    id,
    label,
    language: languageGuess,
    visible: isPreferred,
    offsetMs: 0,
    syncMode: "constant",
    syncAnchors: [],
    cues,
    source,
    sourceTag,
    origin: String(options.origin || "external"),
    exactMedia: Boolean(options.exactMedia),
    provider: String(options.provider || ""),
    release: String(options.release || ""),
    matchScore: Number(options.matchScore) || 0,
    fingerprint,
    timelineRatio: timelineFit.ratio,
    timelineMismatch: timelineFit.severeMismatch,
    romanizationState: "idle",
  });
  const addedTrack = state.tracks.find((track) => track.id === id);
  if (cues.length && !timelineFit.severeMismatch && currentSourceTracks().some((track) => track.id !== id && track.cues?.length)) {
    syncTrackToBestReference(addedTrack, { initial: true });
  }
  applySavedSubtitleSync(addedTrack);
  scheduleAudioSync(600);
  if (languageGuess === state.targetLanguage || !state.selectedTrackId) state.selectedTrackId = id;
  // More than two independently enabled caption overlays are supported.
  if (isRomanizableLanguage(languageGuess) && state.subtitleStyle.romanization !== false) void ensureTrackRomanization(addedTrack);
  if (timelineFit.severeMismatch) {
    $("#media-status").textContent = `These subtitles may be for a different cut: they cover ${Math.round((timelineFit.ratio || 0) * 100)}% of the video`;
  }
  saveCurrentEpisodeAnalysis();
  return { id, added: true, duplicate: false, track: addedTrack };
}

function renderWebSubtitleResults(results) {
  const container = $("#subtitle-web-results");
  if (!results.length) {
    container.innerHTML = empty("No subtitles found", "");
    return;
  }
  container.innerHTML = results.map((result, index) => {
    const details = subtitleResultPresentation(result, index);
    return `<div class="tool-result subtitle-result">
    <div class="tool-result-copy subtitle-result-copy">
      <strong>${escapeHtml(details.anime)}${details.season && details.episode ? ` S${details.season} E${details.episode}` : ""}</strong>
      <div class="subtitle-result-facts">
        <span><b>SOURCE</b>${escapeHtml(details.source)}</span>
        <span><b>SEASON</b>${escapeHtml(details.season || "—")}</span>
        <span><b>EPISODE</b>${escapeHtml(details.episode || "—")}</span>
        <span><b>LANGUAGE</b>${escapeHtml(details.language)}</span>
      </div>
    </div>
    <button class="button subtitle-web-import" data-result-index="${index}">ADD</button>
  </div>`; }).join("");
  container.querySelectorAll(".subtitle-web-import").forEach((button) => button.addEventListener("click", () => importWebSubtitle(Number(button.dataset.resultIndex), button)));
}

function subtitleResultPresentation(result, index = 0) {
  const raw = [result?.label, result?.release, result?.matchedRelease, result?.matchedQuery].filter(Boolean).join(" ");
  const episodeMatch = raw.match(/\bS(\d{1,2})E(\d{1,3})\b/i) || raw.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  const current = currentSubtitleSearchDefaults();
  const seasonNumber = Number(result?.season) || Number(episodeMatch?.[1]) || Number($("#subtitle-season")?.value) || Number(current.season) || 0;
  const episodeNumber = Number(result?.episode) || Number(episodeMatch?.[2]) || Number($("#subtitle-episode")?.value) || Number(current.episode) || 0;
  const anime = String(result?.title || $("#subtitle-query")?.value || current.query || state.currentSource?.title || `Subtitle ${index + 1}`).trim();
  const sourceTokens = [];
  const releaseTokenPattern = /\b(?:WEB[- .]?DL|WEBRIP|BDRIP|BLU[- .]?RAY|NF|NETFLIX|AMZN|AMAZON|CRUNCHYROLL|CR|HULU|DSNP|DISNEY\+?|HMAX|MAX|ATVP)\b/ig;
  for (const match of raw.matchAll(releaseTokenPattern)) {
    const value = String(match[0]).replace(/[ ._-]+/g, "").toUpperCase();
    if (value && !sourceTokens.includes(value)) sourceTokens.push(value);
  }
  const provider = String(result?.provider || "SUBTITLE").trim();
  const source = [provider, ...sourceTokens.slice(0, 3)].filter(Boolean).join(", ");
  return {
    anime,
    source,
    season: seasonNumber ? String(seasonNumber).padStart(2, "0") : "",
    episode: episodeNumber ? String(episodeNumber).padStart(2, "0") : "",
    language: String(result?.language || "—").toUpperCase(),
  };
}

function currentSubtitleSearchDefaults() {
  const source = state.currentSource || {};
  const episode = source.episode || episodeIdentity($("#media-title")?.textContent || "");
  const query = source.kind === "idle" ? "" : String(source.title || $("#media-title")?.textContent || "")
    .replace(/\s+\[[^\]]+\]\s*$/g, "")
    .replace(/\s+·\s+S\d{1,2}E\d{1,3}.*$/i, "")
    .trim();
  const codeMatch = episode?.code?.match(/^S(\d{2})E(\d{2,3})$/i);
  return {
    query,
    type: codeMatch ? "tv" : "movie",
    season: codeMatch ? Number(codeMatch[1]) : undefined,
    episode: codeMatch ? Number(codeMatch[2]) : undefined,
    aliases: Array.isArray(source.aliases) ? source.aliases : [],
    catalogId: source.catalogId || "",
  };
}

function subtitleFallbackQueries(primaryQuery) {
  const source = state.currentSource || {};
  const release = String(source.fileName || "")
    .replace(/\.[^.]+$/, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\bS\d{1,2}E\d{1,3}\b.*$/i, "")
    .replace(/\s+-\s+\d{1,3}(?:v\d+)?\b.*$/i, "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...new Set([
    ...(Array.isArray(source.aliases) ? source.aliases : []),
    release,
  ].map((value) => String(value || "").trim()).filter((value) => value && value.toLowerCase() !== String(primaryQuery || "").toLowerCase()))].slice(0, 5);
}

function populateSubtitleSearchFromCurrentSource() {
  const defaults = currentSubtitleSearchDefaults();
  $("#subtitle-language").value = subtitleFinderLanguages();
  syncSubtitleFinderLanguageChips();
  $("#subtitle-query").value = defaults.query;
  $("#subtitle-type").value = defaults.type;
  $("#subtitle-season").value = defaults.season || "";
  $("#subtitle-episode").value = defaults.episode || "";
  return defaults;
}

// Search results belong to the episode that requested them, even when a
// slower provider response arrives after a source change or another search.
let webSubtitleSearchRevision = 0;
let webSubtitleResultsSource = null;
function subtitleReleaseScore(result, sourceName) {
  const normalizedSource = normalizeCollectionTitle(sourceName || "").toLowerCase();
  const sourceTokens = new Set(normalizedSource
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2));
  const candidate = `${result.release || ""} ${result.matchedRelease || ""} ${result.label || ""}`.toLowerCase();
  const candidateTokens = candidate.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  let score = candidateTokens.filter((token) => sourceTokens.has(token)).length;
  const compactSource = normalizedSource.replace(/[^a-z0-9]+/g, "");
  const compactCandidate = candidate.replace(/[^a-z0-9]+/g, "");
  if (compactSource.length >= 12 && (compactCandidate.includes(compactSource) || compactSource.includes(compactCandidate))) score += 14;
  if (result.matchedRelease || /filename|release/i.test(String(result.matchMode || ""))) score += 8;
  if (/bdrip/i.test(sourceName || "") && /bdrip/i.test(candidate)) score += 4;
  if (/bluray|blu-ray/i.test(sourceName || "") && /bluray|blu-ray/i.test(candidate)) score += 4;
  if (/web[- .]?dl|webrip/i.test(sourceName || "") && /web[- .]?dl|webrip/i.test(candidate)) score += 4;
  if (/1080p/i.test(sourceName || "") && /1080p/i.test(candidate)) score += 2;
  if (/720p/i.test(sourceName || "") && /720p/i.test(candidate)) score += 2;
  if (/\b(?:nf|netflix)\b/i.test(sourceName || "") && /\b(?:nf|netflix)\b/i.test(candidate)) score += 3;
  if (/\b(?:amzn|amazon)\b/i.test(sourceName || "") && /\b(?:amzn|amazon)\b/i.test(candidate)) score += 3;
  if (result.hearingImpaired) score -= 0.5;
  score += Math.min(2, Math.log10(Math.max(1, Number(result.downloads) || 1)) / 2);
  return score;
}

function bestSubtitleIndexesByLanguage(results, languageList) {
  const requested = languageList.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean).slice(0, 4);
  const sourceName = state.currentSource?.fileName || state.currentSource?.title || "";
  return requested.map((languageCode) => {
    const candidates = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => String(result.language || "").toUpperCase() === languageCode)
      .sort((a, b) => subtitleReleaseScore(b.result, sourceName) - subtitleReleaseScore(a.result, sourceName));
    return candidates[0]?.index;
  }).filter((index) => Number.isInteger(index));
}

async function performWebSubtitleSearch({ auto = false, forceBroad = false } = {}) {
  const sourceAtSearch = state.currentSource;
  const searchRevision = ++webSubtitleSearchRevision;
  const apiKey = state.subdlKey;
  const query = $("#subtitle-query").value.trim();
  const selected = parseSubtitleFinderLanguages($("#subtitle-language").value);
  if (!selected) {
    setToolStatus("#subtitle-web-status", "Select 1–4 languages using two-letter codes (for example ES,EN).", true);
    $("#subtitle-language").focus();
    return;
  }
  const language = selected.join(",");
  if (!auto) {
    localStorage.setItem("lvl-subtitle-finder-languages", language);
    $("#subtitle-language").value = language;
    syncSubtitleFinderLanguageChips();
  }
  const type = $("#subtitle-type").value;
  const season = Number($("#subtitle-season").value) || undefined;
  const episode = Number($("#subtitle-episode").value) || undefined;
  const catalogId = state.currentSource?.catalogId || "";
  setToolStatus("#subtitle-web-status", "Searching for subtitles…");
  $("#subtitle-web-results").innerHTML = "";
  try {
    const aliases = subtitleFallbackQueries(query);
    const data = await postJson("/api/subtitles/search", {
      apiKey,
      wyzieKey: state.wyzieKey,
      subsourceKey: state.subsourceKey,
      query,
      aliases,
      releaseQuery: state.currentSource?.fileName || "",
      language,
      type,
      season,
      episode,
      catalogId,
      animeFallback: type === "tv" && Boolean(aliases.length),
      forceBroad,
    });
    if (state.currentSource !== sourceAtSearch || searchRevision !== webSubtitleSearchRevision) return;
    const sourceName = state.currentSource?.fileName || state.currentSource?.title || "";
    state.webSubtitleResults = (data.results || []).slice().sort((a, b) => subtitleReleaseScore(b, sourceName) - subtitleReleaseScore(a, sourceName));
    webSubtitleResultsSource = sourceAtSearch;
    const count = state.webSubtitleResults.length;
    setToolStatus("#subtitle-web-status", count ? "" : "No subtitles found");
    renderWebSubtitleResults(state.webSubtitleResults);
    if (auto && !state.webSubtitleResults.length) setToolStatus("#subtitle-web-status", `No ${languageName(language)} subtitles found for this video`, true);
    if (auto && state.webSubtitleResults.length) {
      const indexes = bestSubtitleIndexesByLanguage(state.webSubtitleResults, language);
      const added = [];
      for (const index of indexes) {
        const result = state.webSubtitleResults[index];
        if (currentSourceTracks().some((track) => track.language === String(result.language || "").toUpperCase())) continue;
        const imported = await importWebSubtitle(index, null, { quiet: true });
        if (imported) added.push(String(result.language || "").toUpperCase());
      }
      if (added.length && currentSourceTracks().filter((track) => track.cues?.length).length > 1) await alignCurrentSubtitleSet();
      if (added.length) setToolStatus("#subtitle-web-status", `Added ${added.map(languageName).join(" and ")} subtitles`);
    }
  } catch (error) {
    if (state.currentSource === sourceAtSearch && searchRevision === webSubtitleSearchRevision)
      setToolStatus("#subtitle-web-status", error.message, true);
  }
}

export async function searchWebSubtitles(event) {
  event.preventDefault();
  await performWebSubtitleSearch();
}

export async function openSubtitleSearch({ auto = false } = {}) {
  const defaults = populateSubtitleSearchFromCurrentSource();
  $("#subtitle-web-dialog").showModal();
  if (!auto) {
    setToolStatus("#subtitle-web-status", "");
    return;
  }
  if (!state.subdlKey && !defaults.query) return;
  await performWebSubtitleSearch({ auto: true });
}

async function importWebSubtitle(index, button = null, { quiet = false } = {}) {
  const sourceAtSelection = state.currentSource;
  if (webSubtitleResultsSource !== sourceAtSelection) return false;
  const result = state.webSubtitleResults[index];
  if (!result) return false;
  const apiKey = state.subdlKey;
  const previous = button?.textContent || "Add";
  if (button) {
    button.disabled = true;
    button.textContent = "Loading…";
  }
  try {
    const data = await postJson("/api/subtitles/download", { apiKey, url: result.url, label: result.label });
    if (state.currentSource !== sourceAtSelection || webSubtitleResultsSource !== sourceAtSelection
      || state.webSubtitleResults[index] !== result) {
      if (button) { button.disabled = false; button.textContent = previous; }
      return false;
    }
    const label = (data.filename || result.label || "Web subtitle").replace(/\.(srt|vtt)$/i, "");
    const added = addSubtitleText(data.text, label, data.language || result.language, {
      origin: "web",
      provider: result.provider || data.provider || "Web",
      release: result.release || result.matchedRelease || result.label || "",
      matchScore: subtitleReleaseScore(result, state.currentSource?.fileName || state.currentSource?.title || ""),
    });
    renderSubtitleWorkspace();
    if (!added.added) {
      if (button) button.textContent = "Already added";
      if (!quiet) setToolStatus("#subtitle-web-status", "Subtitle already added");
      return false;
    }
    if (button) button.textContent = "Added";
    if (!quiet) setToolStatus("#subtitle-web-status", "Subtitle added");
    return true;
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = previous;
    }
    if (!quiet && state.currentSource === sourceAtSelection) setToolStatus("#subtitle-web-status", error.message, true);
    return false;
  }
}
