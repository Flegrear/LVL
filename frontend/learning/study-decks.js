// Learning: Study decks, card faces, sessions, Anki files and AnkiWeb.
import {
  buildReviewQueue, formatReviewInterval, previewReviewIntervals, reviewQueuePriority,
  scheduleReview,
} from "../../learning/browser/core.js";
import { buttonMarkup, confirmDialog, emptyMarkup, escapeHtml, icon, toast } from "../ui/ui.js";
import { cardMeaning, deckSummaries, typeAnswerDiff } from "../../learning/browser/learn.js";
import { t } from "../ui/ui-i18n.js";
import { formatBytes, renderStats, state, studyView, video } from "../../app.js";
import { persistentAppStateReady, saveState } from "../app/saved-state.js";
import { $, $$ } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { viewActive } from "../app/navigation.js";
import { activeTrack } from "../player/player-tracks.js";
import { renderSubtitles } from "../player/subtitle-display.js";
import { allPrimaryCues, cuePlaybackBounds } from "../player/subtitle-timing.js";
import { audioSyncSource } from "../player/audio-sync.js";
import { releaseTorrentSession, resolveTorrentMagnet } from "../player/torrent-playback.js";
import { libraryEntryById } from "../library/library-data.js";
import { libraryChapterName } from "../library/library-page.js";
import { learningItemKey, touchLearningState } from "./learning-state.js";
import { cardLearningKey, discardCardByLearningKey } from "./vocabulary-cards.js";
import { renderStudyPage } from "./study-page.js";

export const linePreview = { active: false, pending: 0, token: 0, controller: null, startSeconds: 0, preventBackgroundPlayback: false };
const previewSourceLeases = new Map();

/* ---------------------------------------------------------------- Study: decks */

// Study holds the flashcards (Anki's schedule): decks from videos, Top words, AnkiWeb and
// imports. Anki decks render with their own templates and styling in a sandboxed frame; cards
// from videos show the line's saved frame and audio. Review is a quick quiz with instant
// answers; Tests are scored mixed tests.
const REVIEW_STATE_LABELS = { new: "New", learning: "Learning", relearning: "Relearning", review: "Review" };
const DECK_BADGES = { videos: "Your videos", preset: "Top words", ankiweb: "AnkiWeb", import: "Imported", legacy: "Imported", words: "Saved words" };
let storedDecks = [];
export let storedDecksState = "idle";

const studyRenderCache = new Map();

export async function loadStoredDecks({ force = false } = {}) {
  if (!persistentAppStateReady) return storedDecks;
  if (storedDecksState === "loading" || (storedDecksState === "ready" && !force)) return storedDecks;
  storedDecksState = "loading";
  try {
    const data = await fetchJson("/api/anki/decks");
    storedDecks = Array.isArray(data.decks) ? data.decks : [];
    for (const deck of [...storedDecks]) {
      if (deck.source !== "preset" || deck.extra?.version === 2) continue;
      const upgraded = await postJson("/api/anki/presets", { language: deck.language, languageName: languageName(deck.language), size: deck.extra?.size || 100 });
      mergeDeckCards(upgraded.deck, upgraded.cards || []);
      studyRenderCache.clear();
    }
    storedDecksState = "ready";
  } catch {
    storedDecksState = "error";
  }
  if (viewActive("study")) renderStudyPage();
  updateDueCount();
  return storedDecks;
}

export function studyDecks(now = Date.now()) {
  return deckSummaries(state.cards, storedDecks, { buildQueue: (cards) => buildReviewQueue(cards, { now }) });
}

export function updateDueCount(decks = null) {
  const rows = decks || studyDecks();
  const total = rows.reduce((sum, deck) => sum + deck.counts.new + deck.counts.learning + deck.counts.review, 0);
  const pill = $("#due-count");
  if (pill) pill.textContent = total > 999 ? "999+" : String(total);
  return total;
}

function deckRowMarkup(deck) {
  const { new: fresh, learning, review } = deck.counts;
  const label = `${deck.name}: ${fresh} new, ${learning} learning, ${review} due`;
  const badge = DECK_BADGES[deck.source] || deck.source;
  const meta = [deck.name.startsWith(badge) ? "" : t(badge), t("{count} cards", { count: deck.total.toLocaleString() }), deck.suspended ? `${deck.suspended} ${t("Suspended")}` : "", deck.media ? `${deck.media.toLocaleString()} media` : ""].filter(Boolean).join(", ");
  const open = studyView.menuKey === deck.key;
  const deletable = deck.storeId || deck.key === "legacy" || deck.key === "words";
  return `<article class="deck-row${open ? " is-menu-open" : ""}" data-deck-key="${escapeHtml(deck.key)}">
    <button class="deck-row__main" type="button" data-deck-open aria-label="${escapeHtml(`Study ${label}`)}"${deck.total ? "" : " disabled"}>
      <span class="deck-row__name">${escapeHtml(deck.storeId ? deck.name : t(deck.name))}</span>
      <span class="deck-row__meta">${escapeHtml(meta)}</span>
    </button>
    <span class="deck-row__counts" aria-hidden="true"><span class="is-new${fresh ? "" : " is-zero"}">${fresh}</span><span class="is-learning${learning ? "" : " is-zero"}">${learning}</span><span class="is-review${review ? "" : " is-zero"}">${review}</span></span>
    <button class="ui-btn ui-btn--primary ui-btn--sm deck-row__study" type="button" data-deck-open${fresh + learning + review ? "" : " disabled"} data-i18n="Study">Study</button>
    <button class="ui-icon-btn ui-icon-btn--sm deck-row__more" type="button" data-deck-menu aria-expanded="${open}" aria-label="${escapeHtml(`More for ${deck.name}`)}">${icon("more")}</button>
    ${open ? `<div class="deck-row__menu" role="group" aria-label="${escapeHtml(`${deck.name} actions`)}">
      <button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-deck-export="apkg"${deck.total ? "" : " disabled"} data-i18n="Export .apkg">Export .apkg</button>
      <button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-deck-export="txt"${deck.total ? "" : " disabled"} data-i18n="Export text">Export text</button>
      ${deletable ? '<button class="ui-btn ui-btn--ghost ui-btn--sm deck-row__delete" type="button" data-deck-delete data-i18n="Delete deck">Delete deck</button>' : ""}
    </div>` : ""}
  </article>`;
}

export function renderStudyDecks(decks) {
  const list = $("#study-deck-list");
  if (!list) return;
  if (!decks.length) {
    list.innerHTML = emptyMarkup({
      icon: "library",
      title: "No decks yet",
      text: "Add the most frequent words, pick a deck from AnkiWeb, or import an Anki file. Words you save while watching land here too.",
      action: `${buttonMarkup({ label: "Top words", variant: "primary", attrs: { "data-empty-action": "top" } })}${buttonMarkup({ label: "AnkiWeb decks", attrs: { "data-empty-action": "ankiweb" } })}`,
    });
    return;
  }
  list.innerHTML = `<div class="deck-list__head" aria-hidden="true"><span data-i18n="Deck">Deck</span><span class="deck-list__counts"><span data-i18n="New">New</span><span data-i18n="Learning">Learning</span><span data-i18n="Due">Due</span></span></div>${decks.map(deckRowMarkup).join("")}`;
}

// Card audio: Anki [sound:…] files and saved clips play through one element, one after another.
export const studyAudio = new Audio();
let studySoundQueue = [];
const safeStudyAudio = (url) => /^\/api\/(?:anki\/media\/[a-z0-9-]+\/|clips\/[a-f0-9]{24}\/audio$)/.test(String(url || ""));

export function playStudySounds(urls) {
  studySoundQueue = (urls || []).filter(safeStudyAudio);
  playNextStudySound();
}

export function playNextStudySound() {
  const next = studySoundQueue.shift();
  if (!next) return;
  studyAudio.src = next;
  studyAudio.play().catch(() => {});
}

export function stopStudySounds() {
  studySoundQueue = [];
  studyAudio.pause();
}

/* The popup owns its media. Streamed lines are extracted before playback, so neither its
 * controls nor replay can escape the selected interval or change the main episode player. */
export function closeLinePreview() {
  if (linePreview.active) linePreview.preventBackgroundPlayback = true;
  linePreview.active = false;
  linePreview.token += 1;
  linePreview.controller?.abort();
  linePreview.controller = null;
  linePreview.pending = 0;
  video.pause();
  if (state.pendingSeek) state.pendingSeek.wasPlaying = false;
  stopStudySounds();
  $$("#line-preview-media > video, #line-preview-media > audio").forEach((media) => { media.pause(); media.removeAttribute("src"); media.load(); });
  $("#line-preview-replay").disabled = true;
  $("#line-preview-media").replaceChildren();
}

export async function replayLinePreview() {
  const media = $("#line-preview-media").querySelector("video, audio");
  if (!linePreview.active || !media || media.readyState < 1) return;
  media.currentTime = linePreview.startSeconds;
  await media.play().catch(() => {});
}

async function acquirePreviewSource(libraryId) {
  let lease = previewSourceLeases.get(libraryId);
  while (lease?.closing) { await lease.closing; lease = previewSourceLeases.get(libraryId); }
  if (!lease) {
    lease = { libraryId, users: 0, sessionId: null, owned: false, closing: null };
    previewSourceLeases.set(libraryId, lease);
  }
  lease.users += 1;
  return lease;
}

async function releasePreviewSource(lease) {
  if (!lease || --lease.users > 0) return;
  lease.closing = lease.owned ? releaseTorrentSession(lease.sessionId) : Promise.resolve();
  try { await lease.closing; } finally {
    if (previewSourceLeases.get(lease.libraryId) === lease) previewSourceLeases.delete(lease.libraryId);
  }
}

function showLinePreviewMedia(clip, item, token, { localSource = "", startMs = 0, endMs = 0 } = {}) {
  const root = $("#line-preview-media");
  const status = $("#line-preview-status");
  const replay = $("#line-preview-replay");
  const media = document.createElement(clip?.videoUrl || localSource ? "video" : "audio");
  const isCurrent = () => linePreview.active && token === linePreview.token;
  media.controls = !localSource;
  media.preload = "auto";
  if (media.tagName === "VIDEO") {
    media.playsInline = true;
    if (clip?.imageUrl) media.poster = clip.imageUrl;
  } else if (clip?.imageUrl) {
    const image = document.createElement("img");
    image.src = clip.imageUrl;
    image.alt = "";
    root.append(image);
  }
  linePreview.startSeconds = localSource ? startMs / 1000 : 0;
  if (localSource) {
    // Local files stay in the browser. Hide the episode timeline and bound a separate player.
    media.addEventListener("timeupdate", () => {
      if (media.currentTime >= endMs / 1000 && !media.paused) { media.pause(); media.currentTime = endMs / 1000; }
    });
    media.addEventListener("play", () => {
      if (media.currentTime < startMs / 1000 || media.currentTime >= endMs / 1000) media.currentTime = startMs / 1000;
    });
    media.addEventListener("click", () => { if (media.paused) void media.play().catch(() => {}); else media.pause(); });
  }
  media.addEventListener("loadedmetadata", () => {
    if (!isCurrent()) return;
    replay.disabled = false;
    void replayLinePreview();
  }, { once: true });
  media.addEventListener("error", () => {
    if (isCurrent()) { status.textContent = t("Video unavailable"); replay.disabled = true; }
  }, { once: true });
  media.src = localSource || clip.videoUrl || clip.audioUrl;
  root.append(media);
  $("#line-preview-target").textContent = clip?.text || item.context || item.front || item.value || "";
  $("#line-preview-base").textContent = clip?.baseText || item.baseContext || "";
  status.textContent = "";
}

export async function openLinePreview(item) {
  if (linePreview.pending && linePreview.active) { toast(t("Loading line…")); return; }
  const dialog = $("#line-preview-dialog");
  if (dialog.open) dialog.close();
  closeLinePreview();
  linePreview.active = true;
  linePreview.preventBackgroundPlayback = true;
  const token = ++linePreview.token;
  const controller = new AbortController();
  linePreview.controller = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
  const isCurrent = () => linePreview.active && token === linePreview.token;
  linePreview.pending = 1;
  let sourceLease = null;
  const status = $("#line-preview-status");
  $("#line-preview-target").textContent = item.context || item.front || item.value || "";
  $("#line-preview-base").textContent = item.baseContext || "";
  status.textContent = t("Loading line…");
  dialog.showModal();
  try {
    let clip = null;
    if (item.clipId) {
      try { clip = await fetchJson(`/api/clips/${encodeURIComponent(item.clipId)}`, { signal }); } catch (error) { if (signal.aborted) throw error; /* Try the source if the saved clip was evicted. */ }
    }
    if (!linePreview.active || token !== linePreview.token) return;
    if (clip?.videoUrl) {
      showLinePreviewMedia(clip, item, token);
      return;
    }
    const libraryId = item.sourceLibraryId || clip?.libraryId || state.currentSource?.libraryId;
    const fileIndex = item.sourceFileIndex ?? clip?.fileIndex ?? state.currentSource?.fileIndex;
    const sameChapter = String(libraryId) === String(state.currentSource?.libraryId) && String(fileIndex) === String(state.currentSource?.fileIndex);
    const entry = libraryEntryById(libraryId);
    const savedItems = entry?.episodes?.find(episode => Number(episode.fileIndex) === Number(fileIndex))?.analysis;
    const occurrence = [...(savedItems?.words || []), ...(savedItems?.phrases || [])].map(raw => raw.occurrence)
      .filter(cue => cue?.text === item.context && Number(cue.endMs) > Number(cue.startMs))
      .sort((a, b) => Math.abs(a.startMs - Number(item.timestampMs || 0)) - Math.abs(b.startMs - Number(item.timestampMs || 0)))[0];
    const matchingCard = state.cards.find(card => card.context === item.context && String(card.sourceLibraryId) === String(libraryId)
      && String(card.sourceFileIndex) === String(fileIndex) && Number(card.endMs) > Number(card.timestampMs));
    const cue = sameChapter ? allPrimaryCues().filter(source => source.text === item.context)
      .map(source => cuePlaybackBounds(source, activeTrack()))
      .sort((a, b) => Math.abs(a.startMs - Number(item.timestampMs || 0)) - Math.abs(b.startMs - Number(item.timestampMs || 0)))[0] : null;
    let startMs = Math.max(0, Number(clip?.startMs ?? cue?.startMs ?? item.timestampMs ?? occurrence?.startMs ?? matchingCard?.timestampMs) || 0);
    let endMs = Number(clip?.endMs ?? cue?.endMs ?? item.endMs ?? occurrence?.endMs ?? matchingCard?.endMs) || null;
    if (!clip && (!endMs || endMs <= startMs) && /^[a-f0-9]{40}$/i.test(String(libraryId))) {
      const saved = await fetchJson(`/api/clips?library=${encodeURIComponent(libraryId)}&file=${encodeURIComponent(fileIndex)}`, { signal });
      const cached = saved.clips?.filter(candidate => candidate.text === item.context)
        .sort((a, b) => Math.abs(a.startMs - startMs) - Math.abs(b.startMs - startMs))[0];
      if (cached) { clip = await fetchJson(`/api/clips/${cached.id}`, { signal }); startMs = clip.startMs; endMs = clip.endMs; }
    }
    if (!isCurrent()) return;
    if (clip?.videoUrl) { showLinePreviewMedia(clip, item, token); return; }
    if (!clip?.audioUrl && (!endMs || endMs <= startMs)) throw new Error(t("Open this chapter once to save this line’s timing."));
    let source = sameChapter ? audioSyncSource() : null;
    if (!source && !clip?.audioUrl && entry?.magnet && fileIndex !== null && fileIndex !== undefined && Number.isInteger(Number(fileIndex))) {
      status.textContent = t("Preparing video clip…");
      sourceLease = await acquirePreviewSource(String(libraryId));
      signal.throwIfAborted();
      const session = await resolveTorrentMagnet(entry.magnet, null, { preferredFileIndex: Number(fileIndex), timeoutMs: 60_000, signal, releaseOnFailure: false,
        onSession: session => { sourceLease.sessionId = session.id; sourceLease.owned ||= session.reused === false; },
      });
      if (!isCurrent()) return;
      source = { sessionId: session.id, fileIndex: Number(fileIndex), audio: 0 };
    }
    if (source && endMs !== null && /^[a-f0-9]{40}$/i.test(String(libraryId))) {
      status.textContent = t("Preparing video clip…");
      try {
        clip = await postJson("/api/clips", {
          ...source, audio: clip?.audio ?? source.audio, libraryId, startMs, endMs, kind: "card",
          lang: item.targetLanguage || state.targetLanguage, baseLang: item.baseLanguage || state.baseLanguage,
          text: item.context || item.front || item.value || "", baseText: item.baseContext || "",
          series: entry?.displayTitle || entry?.title || "", chapter: entry?.episodes?.find(episode => Number(episode.fileIndex) === Number(fileIndex))?.code || "",
        }); // Let an in-flight cut settle before releasing its source when the popup closes.
        if (!isCurrent()) return;
        const card = state.cards.find(card => card.id === item.id);
        if (card) { card.clipId = clip.id; card.clipImage = Boolean(clip.imageUrl); saveState(); }
      } catch (error) {
        if (signal.aborted || !clip?.audioUrl) throw error;
        // Saved audio remains useful if the source cannot currently supply video.
      }
    }
    if (!isCurrent()) return;
    if (clip?.videoUrl || clip?.audioUrl) { showLinePreviewMedia(clip, item, token); return; }
    if (state.currentSource?.kind === "local" && video.src && endMs !== null && !item.sourceLibraryId) {
      showLinePreviewMedia(null, item, token, { localSource: video.src, startMs, endMs });
      return;
    }
    throw new Error(t("This line has no saved clip or video source."));
  } catch (error) {
    if (linePreview.active && token === linePreview.token) status.textContent = error.message || t("Video unavailable");
  } finally {
    if (token === linePreview.token) linePreview.pending = 0;
    await releasePreviewSource(sourceLease);
  }
}

/* ---------------------------------------------------------------- Study: card faces */

// Anki decks are shown in a sandboxed frame: the deck's templates and CSS, with Anki's night-mode
// classes, a CSP that only allows the deck's media, and a small bridge for size, sounds and keys.
const ANKI_FRAME_CSS = `html,body{margin:0}
body{padding:28px 22px 32px;overflow-wrap:break-word;font-family:Inter,"Segoe UI","Hiragino Sans","Noto Sans CJK JP",sans-serif;font-size:20px;line-height:1.5;text-align:center;background-color:#fff;color:#111}
body.nightMode{background-color:#0b0b0b;color:#f2f2f2}
img{max-width:100%;height:auto}
hr#answer{border:0;border-top:1px solid #ddd;margin:22px auto}
body.nightMode hr#answer{border-top-color:#2a2a2a}
body.nightMode a{color:#bcd4ff}
.replay-button{display:inline-block;vertical-align:middle;margin:0 4px;text-decoration:none}
.replay-button svg{width:36px;height:36px}
.replay-button svg circle{fill:#f2f2f2;stroke:#777;stroke-width:2}
.replay-button svg path{fill:#111}
.cloze{font-weight:700;color:#0a4fd1}
body.nightMode .cloze{color:#9cc3ff}
.lvl-typeans,#typeans{box-sizing:border-box;width:min(440px,100%);margin-top:14px;padding:9px 12px;border:1px solid #bbb;border-radius:9px;background:#fff;color:#111;font:inherit;font-size:20px;text-align:center}
body.nightMode .lvl-typeans,body.nightMode #typeans{border-color:#3a3a3a;background:#111;color:#fff}
code#typeans{display:inline-block;padding:6px 10px;border-radius:8px;background:#f1f1f1;font-family:inherit;letter-spacing:.02em}
body.nightMode code#typeans{background:#141414}
.typeGood{color:#127a3a}
.typeBad{color:#b3261e;text-decoration:line-through}
.typeMissed{text-decoration:underline}
body.nightMode .typeGood{color:#b9f5cf}
body.nightMode .typeBad{color:#ffb4b4}
ruby rt{font-size:.55em;opacity:.85}`;

// Anki shows a card the way its deck styles it; decks with their own night-mode styles get the dark
// card, the rest the light card they were made for (dark text on white).
function ankiNightMode(rendered) {
  return /night[_-]?mode/i.test(`${rendered?.css || ""}${rendered?.question || ""}`);
}

const ANKI_FRAME_BRIDGE = `(()=>{const post=(d)=>parent.postMessage(Object.assign({lvlCard:1},d),"*");
const size=()=>post({type:"size",height:Math.ceil(Math.max(document.documentElement.scrollHeight,document.body.scrollHeight))});
try{new ResizeObserver(size).observe(document.body)}catch(e){}addEventListener("load",size);setTimeout(size,60);setTimeout(size,500);
document.addEventListener("click",(e)=>{const t=e.target&&e.target.closest?e.target:null;if(!t)return;const s=t.closest("[data-lvl-sound]");if(s){e.preventDefault();post({type:"sound",url:s.getAttribute("data-lvl-sound")});return}
const h=t.closest("[data-lvl-hint]");if(h){e.preventDefault();const b=document.getElementById(h.getAttribute("data-lvl-hint"));h.style.display="none";if(b)b.style.display="block";size()}});
const i=document.getElementById("typeans");if(i&&i.tagName==="INPUT"){setTimeout(()=>i.focus(),40);i.addEventListener("input",()=>post({type:"typed",value:i.value}));i.addEventListener("keydown",(e)=>{if(e.key==="Enter"){e.preventDefault();post({type:"typed",value:i.value,submit:true})}})}
document.addEventListener("keydown",(e)=>{if(e.target&&e.target.id==="typeans")return;if(e.ctrlKey||e.metaKey||e.altKey)return;if(["Space","Enter","Escape","KeyR","KeyU"].includes(e.code)||["1","2","3","4"].includes(e.key)){e.preventDefault();post({type:"key",key:e.key,code:e.code})}})})();`;

function typeAnswerHtml(expected, typed) {
  if (!String(typed || "").trim()) return `<code id="typeans">${escapeHtml(expected)}</code>`;
  return `<code id="typeans">${typeAnswerDiff(expected, typed).map((part) => `<span class="type${part.type === "good" ? "Good" : part.type === "bad" ? "Bad" : "Missed"}">${escapeHtml(part.text)}</span>`).join("")}</code>`;
}

function ankiFrameDocument(rendered, { side = "question", ord = 0, typed = "" } = {}) {
  const media = `${location.origin}/api/anki/media/`;
  const csp = `default-src 'none'; img-src ${media} data: blob:; media-src ${media} data: blob:; font-src ${media} data:; style-src 'unsafe-inline' ${media}; script-src 'unsafe-inline' ${media}; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'`;
  let html = side === "answer" ? rendered.answer : rendered.question;
  if (side === "answer") {
    html = html.replace(/<div class="lvl-typeans-result" data-expected="([^"]*)"><\/div>/g, (match, expected) => typeAnswerHtml(expected.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), typed));
  }
  const css = String(rendered.css || "").replace(/<\/style/gi, "<\\/style");
  const night = ankiNightMode(rendered);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${night ? "dark" : "light"}"><style>${ANKI_FRAME_CSS}</style><style>${css}</style></head><body class="card card${Number(ord) + 1}${night ? " nightMode night_mode" : ""}"><div id="qa">${html}</div><script>${ANKI_FRAME_BRIDGE}</script></body></html>`;
}

function reviewCardSource(card) {
  if (card.anki?.deck) return card.anki.deck;
  if (card.origin === "anki") return "Anki";
  const tag = String(card.sourceTag || "").replace(/\s·\s[A-Z]{2,3}$/, "");
  return tag || (card.rank ? `Top ${card.targetLanguage || ""} #${card.rank}` : "");
}

// The line the card came from, with the card's word or phrase marked.
export function reviewSentenceMarkup(card) {
  const sentence = String(card.context || "").trim();
  if (!sentence) return "";
  const front = String(card.front || "").trim();
  const index = front ? sentence.toLocaleLowerCase().indexOf(front.toLocaleLowerCase()) : -1;
  const html = index >= 0
    ? `${escapeHtml(sentence.slice(0, index))}<mark>${escapeHtml(sentence.slice(index, index + front.length))}</mark>${escapeHtml(sentence.slice(index + front.length))}`
    : escapeHtml(sentence);
  return `<p class="native-card__sentence" lang="${escapeHtml(String(card.targetLanguage || "").toLowerCase())}">${html}</p>`;
}

function cardClipUrls(card) {
  return card?.clipId && /^[a-f0-9]{24}$/.test(card.clipId)
    ? { audio: `/api/clips/${card.clipId}/audio`, image: card.clipImage === false ? "" : `/api/clips/${card.clipId}/image` }
    : null;
}

// Cards made from videos (and text-only imports): the saved frame, the word, its line, and on
// the back the reading, meaning and translation.
function nativeCardMarkup(card, revealed) {
  const clip = cardClipUrls(card);
  const lang = escapeHtml(String(card.targetLanguage || "").toLowerCase());
  const reading = card.romanized && card.romanized !== card.front ? card.romanized : "";
  const translation = String(card.baseContext || "").trim();
  const back = cardMeaning(card);
  const seconds = Math.max(0, Math.round(Number(card.timestampMs || 0) / 1000));
  const where = [
    ...String(reviewCardSource(card) || "").split(/\s+·\s+/).map((part) => libraryChapterName({ code: part }) || part),
    card.context && card.timestampMs ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "",
  ].filter(Boolean).join(", ");
  return `<div class="native-card${clip?.image ? " has-still" : ""}">
    ${clip?.image ? `<img class="native-card__still" src="${escapeHtml(clip.image)}" alt="" loading="lazy">` : ""}
    <div class="native-card__word" lang="${lang}">${escapeHtml(card.front).replace(/\n/g, "<br>")}</div>
    ${reviewSentenceMarkup(card)}
    ${reading ? `<p class="native-card__reading" data-card-content>${escapeHtml(reading)}</p>` : ""}
    ${revealed ? `<div class="native-card__answer">
      ${back && back !== translation ? `<p class="native-card__meaning">${escapeHtml(back).replace(/\n/g, "<br>")}</p>` : ""}
      ${translation ? `<p class="native-card__translation">${escapeHtml(translation)}</p>` : ""}
      ${!back && !translation ? '<p class="native-card__translation is-muted">No translation for this card</p>' : ""}
      ${where ? `<p class="native-card__where">${escapeHtml(where)}</p>` : ""}
    </div>` : ""}
  </div>`;
}

/* ---------------------------------------------------------------- Study: session */

export function currentStudyCard() {
  return studyView.cardId ? state.cards.find((card) => card.id === studyView.cardId) || null : null;
}

function currentStudyDeck(now = Date.now()) {
  return studyView.deckKey ? studyDecks(now).find((deck) => deck.key === studyView.deckKey) || null : null;
}

async function ankiRenderFor(card) {
  const key = `${card.anki.deckId}|${card.anki.noteId}|${Number(card.anki.ord) || 0}`;
  if (studyRenderCache.has(key)) return studyRenderCache.get(key);
  const params = new URLSearchParams({ note: String(card.anki.noteId), ord: String(Number(card.anki.ord) || 0), deck: String(card.anki.deck || "") });
  const rendered = await fetchJson(`/api/anki/decks/${encodeURIComponent(card.anki.deckId)}/render?${params}`);
  studyRenderCache.set(key, rendered);
  while (studyRenderCache.size > 200) studyRenderCache.delete(studyRenderCache.keys().next().value);
  return rendered;
}

export function openStudyDeck(key) {
  stopStudySounds();
  Object.assign(studyView, { deckKey: key, cardId: null, revealed: false, rendered: null, typed: "", undo: null, reviewed: 0, menuKey: null });
  renderStudyPage();
  $("#study-session")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

export function closeStudySession() {
  stopStudySounds();
  Object.assign(studyView, { deckKey: null, cardId: null, revealed: false, rendered: null, typed: "", undo: null });
  renderStudyPage();
}

export function renderStudySession() {
  const now = Date.now();
  const deck = currentStudyDeck(now);
  const stage = $("#study-stage");
  if (!deck || !stage) {
    closeStudySession();
    return;
  }
  const { queue, counts, nextDueAt } = buildReviewQueue(deck.cards, { now });
  $("#study-session-title").textContent = deck.name;
  $("#review-count-new").textContent = counts.new;
  $("#review-count-learning").textContent = counts.learning;
  $("#review-count-review").textContent = counts.review;
  if (!queue.length) {
    studyView.cardId = null;
    stopStudySounds();
    stage.innerHTML = `<div class="study-done">${emptyMarkup({
      icon: "check",
      title: studyView.reviewed ? `${studyView.reviewed} card${studyView.reviewed === 1 ? "" : "s"} done` : "Nothing due",
      text: nextDueAt ? `Next card in ${formatReviewInterval(nextDueAt - now)}.` : "This deck is done for today.",
      action: `${buttonMarkup({ label: "Back to decks", variant: "primary", attrs: { "data-study-back": "" } })}${studyView.undo ? buttonMarkup({ label: "Undo last", variant: "ghost", attrs: { "data-study-undo": "" } }) : ""}`,
    })}</div>`;
    return;
  }
  const card = queue[0];
  if (studyView.cardId !== card.id) Object.assign(studyView, { cardId: card.id, revealed: false, rendered: null, typed: "" });
  const reviewState = reviewQueuePriority(card, now).state;
  const anki = Boolean(card.anki?.deckId);
  stage.innerHTML = `<article class="study-card" data-card-id="${escapeHtml(card.id)}">
    <header class="study-card__head">
      <span class="study-state" data-review-state="${reviewState}">${REVIEW_STATE_LABELS[reviewState] || reviewState}</span>
      <span class="study-card__source" title="${escapeHtml(reviewCardSource(card))}">${escapeHtml(reviewCardSource(card))}</span>
      <span class="study-card__tools">
        ${cardClipUrls(card) || (card.context && card.sourceLibraryId) ? '<button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-study-replay>Play line</button>' : ""}
        ${studyView.undo ? '<button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-study-undo>Undo</button>' : ""}
        <button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-study-suspend>${anki ? "Suspend" : "Remove"}</button>
      </span>
    </header>
    <div id="study-card-face" class="study-card__face">${anki ? '<div class="study-card__loading ui-skeleton ui-skeleton--wide" aria-hidden="true"></div>' : nativeCardMarkup(card, studyView.revealed)}</div>
    <footer id="study-card-foot" class="study-card__foot"></footer>
  </article>`;
  renderStudyFoot(card, now);
  if (anki) void mountAnkiCard(card);
  else stage.querySelectorAll(".native-card__still").forEach((image) => image.addEventListener("error", () => image.remove(), { once: true }));
}

async function mountAnkiCard(card) {
  const face = $("#study-card-face");
  try {
    const rendered = studyView.rendered || await ankiRenderFor(card);
    if (studyView.cardId !== card.id || !face?.isConnected) return;
    studyView.rendered = rendered;
    const frameNode = document.createElement("iframe");
    frameNode.id = "study-card-frame";
    frameNode.className = "study-card__frame";
    frameNode.title = "Card";
    frameNode.setAttribute("sandbox", "allow-scripts");
    frameNode.setAttribute("referrerpolicy", "no-referrer");
    frameNode.srcdoc = ankiFrameDocument(rendered, { side: studyView.revealed ? "answer" : "question", ord: card.anki.ord, typed: studyView.typed });
    face.classList.toggle("is-light", !ankiNightMode(rendered));
    face.replaceChildren(frameNode);
    playStudySounds(studyView.revealed ? rendered.answerSounds : rendered.questionSounds);
  } catch (error) {
    if (studyView.cardId !== card.id || !face?.isConnected) return;
    face.innerHTML = nativeCardMarkup(card, studyView.revealed);
    face.insertAdjacentHTML("beforeend", `<p class="learn-footnote">${escapeHtml(error.message || "This card's deck isn't stored any more; showing its text.")}</p>`);
  }
}

function renderStudyFoot(card, now = Date.now()) {
  const foot = $("#study-card-foot");
  if (!foot) return;
  if (!studyView.revealed) {
    foot.innerHTML = `<button id="show-answer" class="ui-btn ui-btn--primary ui-btn--lg study-show" type="button" data-i18n="Show answer">Show answer <kbd class="ui-kbd">Space</kbd></button>`;
    return;
  }
  const ratings = [["again", "Again"], ["hard", "Hard"], ["good", "Good"], ["easy", "Easy"]];
  const preview = previewReviewIntervals(card, now);
  foot.innerHTML = `<div id="review-actions" class="study-ratings" role="group" aria-label="${escapeHtml(t("How well did you remember?"))}">${ratings.map(([rating, label], index) => `<button class="study-rating" data-rating="${rating}" type="button" aria-label="${escapeHtml(t(label))}, ${escapeHtml(preview[rating].label)} (${index + 1})"><small>${escapeHtml(preview[rating].label)}</small><strong data-i18n="${label}">${label}</strong><kbd class="ui-kbd">${index + 1}</kbd></button>`).join("")}</div>`;
}

export function revealStudyAnswer() {
  const card = currentStudyCard();
  if (!card || studyView.revealed) return;
  studyView.revealed = true;
  if (card.anki?.deckId) {
    const frameNode = $("#study-card-frame");
    if (frameNode && studyView.rendered) {
      frameNode.srcdoc = ankiFrameDocument(studyView.rendered, { side: "answer", ord: card.anki.ord, typed: studyView.typed });
      playStudySounds(studyView.rendered.answerSounds);
    } else void mountAnkiCard(card);
  } else {
    const face = $("#study-card-face");
    if (face) face.innerHTML = nativeCardMarkup(card, true);
    face?.querySelectorAll(".native-card__still").forEach((image) => image.addEventListener("error", () => image.remove(), { once: true }));
    const clip = cardClipUrls(card);
    if (clip) playStudySounds([clip.audio]);
  }
  renderStudyFoot(card);
}

export function rateStudyCard(rating) {
  const card = currentStudyCard();
  if (!card || !studyView.revealed) return;
  studyView.undo = { before: { ...card }, deckKey: studyView.deckKey };
  state.cards = state.cards.map((item) => (item.id === card.id ? scheduleReview(item, rating) : item));
  studyView.reviewed += 1;
  studyView.cardId = null;
  touchLearningState();
  saveState();
  stopStudySounds();
  renderStudySession();
  updateDueCount();
  renderStats();
  renderSubtitles();
}

export function undoStudyRating() {
  const undo = studyView.undo;
  if (!undo) return;
  state.cards = state.cards.map((item) => (item.id === undo.before.id ? undo.before : item));
  studyView.undo = null;
  studyView.reviewed = Math.max(0, studyView.reviewed - 1);
  studyView.cardId = null;
  touchLearningState();
  saveState();
  renderStudySession();
  updateDueCount();
}

export function suspendStudyCard() {
  const card = currentStudyCard();
  if (!card) return;
  if (card.anki?.deckId) {
    studyView.undo = { before: { ...card }, deckKey: studyView.deckKey };
    state.cards = state.cards.map((item) => (item.id === card.id ? { ...item, suspended: true } : item));
    touchLearningState();
    saveState();
    toast("Card suspended");
  } else {
    discardCardByLearningKey(cardLearningKey(card), { rememberAutoDiscard: true });
  }
  studyView.cardId = null;
  renderStudySession();
  updateDueCount();
}

export function replayStudyCard() {
  const card = currentStudyCard();
  if (!card) return;
  if (card.anki?.deckId && studyView.rendered) {
    playStudySounds(studyView.revealed ? [...studyView.rendered.questionSounds, ...studyView.rendered.answerSounds] : studyView.rendered.questionSounds);
    return;
  }
  if (card.clipId || card.context) void openLinePreview(card);
}

/* ---------------------------------------------------------------- Study: adding and removing decks */

function ankiCardType(front) {
  const text = String(front || "").trim();
  return /\s/.test(text) || [...text].length > 12 ? "phrase" : "word";
}

/**
 * Adds a stored deck's cards to the card list. Cards already there (same note and card) keep
 * their schedule unless the incoming one has more reviews (a newer export from Anki). A
 * never-reviewed card the app made for the same word is taken over by the deck's card (its line
 * and translation are kept); with skipTwins (Top words) a word that's already a card is
 * not added twice.
 */
function mergeDeckCards(deck, rawCards) {
  const language = String(deck?.language || state.targetLanguage).toUpperCase();
  const byAnkiId = new Map();
  const byLearningKey = new Map();
  state.cards.forEach((card, index) => {
    if (card.anki?.guid) byAnkiId.set(`${card.anki.deckId || ""}|${card.anki.guid}|${Number(card.anki.ord) || 0}`, index);
    byLearningKey.set(cardLearningKey(card), index);
  });
  const replaced = new Set();
  const now = Date.now();
  const tally = { added: 0, updated: 0, merged: 0, skipped: 0 };
  (rawCards || []).forEach((raw, index) => {
    // The card list keeps short text only (search, quiz, tests); the card itself is drawn from the
    // stored deck. This keeps large decks small in the saved state.
    const front = String(raw.front || "").slice(0, 600);
    if (!front) return;
    const ord = Number(raw.ord) || 0;
    const type = ankiCardType(front);
    const vocabulary = !/\n/.test(front) && [...front].length <= 40;
    const itemKey = vocabulary ? learningItemKey(language, type, front) : `anki|${raw.guid}|${ord}`;
    const schedule = {
      state: raw.state || "new", learningStep: Number(raw.learningStep) || 0, intervalDays: Number(raw.intervalDays) || 0, dueAt: Number(raw.dueAt) || now,
      reviewCount: Number(raw.reviewCount) || 0, lapses: Number(raw.lapses) || 0, suspended: Boolean(raw.suspended),
      ...(raw.ease ? { ease: raw.ease } : {}), ...(raw.lastReviewedAt ? { lastReviewedAt: raw.lastReviewedAt } : {}),
      ...(raw.firstReviewedAt ? { firstReviewedAt: raw.firstReviewedAt } : {}), ...(raw.lapseIntervalDays ? { lapseIntervalDays: raw.lapseIntervalDays } : {}),
    };
    const content = {
      front,
      back: String(raw.back || "").slice(0, 600),
      romanized: String(raw.reading || "").slice(0, 200),
      ...(deck.extra?.meaningLanguage ? { baseLanguage: deck.extra.meaningLanguage } : {}),
      ...(raw.sentence ? { context: String(raw.sentence).slice(0, 600) } : {}),
      ...(raw.translation ? { baseContext: String(raw.translation).slice(0, 600) } : {}),
      rank: Number(raw.rank) || null,
      newPosition: Number.isFinite(Number(raw.newPosition)) ? Number(raw.newPosition) : index,
      anki: { deckId: deck.id, guid: raw.guid, noteId: raw.noteId, cardId: raw.cardId, ord, deck: String(raw.deck || deck.name).slice(0, 200), notetype: String(raw.notetype || "").slice(0, 120), tags: (raw.tags || []).slice(0, 12).map((tag) => String(tag).slice(0, 60)) },
    };
    const existing = byAnkiId.get(`${deck.id}|${raw.guid}|${ord}`);
    if (existing !== undefined) {
      const current = state.cards[existing];
      state.cards[existing] = { ...current, ...content, ...(schedule.reviewCount > (Number(current.reviewCount) || 0) ? schedule : {}) };
      tally.updated += 1;
      return;
    }
    const twinIndex = vocabulary ? byLearningKey.get(itemKey) : undefined;
    const twin = twinIndex !== undefined && !replaced.has(twinIndex) ? state.cards[twinIndex] : null;
    // Presets keep every note, including words already present in video cards.
    if (deck.source !== "preset" && twin && twin.anki?.deckId === deck.id) { tally.skipped += 1; return; }
    const keep = deck.source !== "preset" && twin && !Number(twin.reviewCount) && !twin.anki?.deckId
      ? { context: content.context || twin.context || "", baseContext: content.baseContext || twin.baseContext || "", romanized: content.romanized || twin.romanized || "", timestampMs: twin.timestampMs || 0, endMs: twin.endMs || null, sourceLibraryId: twin.sourceLibraryId ?? null, sourceFileIndex: twin.sourceFileIndex ?? null, trackLabel: twin.trackLabel || "", clipId: twin.clipId || undefined }
      : null;
    if (keep) { replaced.add(twinIndex); tally.merged += 1; }
    state.cards.push({
      id: crypto.randomUUID(), itemKey, type, timestampMs: 0, trackLabel: "", sourceLibraryId: null, sourceFileIndex: null,
      ...content, ...(keep || {}),
      sourceTag: deck.name, baseLanguage: deck.extra?.meaningLanguage || state.baseLanguage, targetLanguage: language, origin: "anki", autoGenerated: false,
      deckId: `store:${deck.id}`, createdAt: now, ...schedule,
    });
    byAnkiId.set(`${deck.id}|${raw.guid}|${ord}`, state.cards.length - 1);
    tally.added += 1;
  });
  if (replaced.size) state.cards = state.cards.filter((_, index) => !replaced.has(index));
  touchLearningState();
  saveState();
  const known = storedDecks.findIndex((item) => item.id === deck.id);
  if (known >= 0) storedDecks[known] = deck; else storedDecks.unshift(deck);
  return tally;
}

function deckTallyText(deck, tally) {
  return [`${tally.added.toLocaleString()} new card${tally.added === 1 ? "" : "s"} in ${deck.name}`, tally.updated ? `${tally.updated.toLocaleString()} updated` : "", tally.merged ? `${tally.merged.toLocaleString()} merged` : "", tally.skipped ? `${tally.skipped.toLocaleString()} already in your cards` : ""].filter(Boolean).join(", ");
}

export async function importAnkiFile(file) {
  if (!file) return;
  const button = $("#review-import-anki");
  const label = button?.textContent || "";
  if (button) { button.disabled = true; button.textContent = "Importing…"; }
  try {
    const response = await fetch("/api/anki/import", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file, signal: AbortSignal.timeout(600_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Import failed (${response.status})`);
    const tally = mergeDeckCards(data.deck, data.cards || []);
    toast(deckTallyText(data.deck, tally));
    renderStudyPage();
    updateDueCount();
    renderStats();
  } catch (error) {
    toast(error.message || "Couldn't import that file", { tone: "error" });
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
    const input = $("#review-import-file");
    if (input) input.value = "";
  }
}

export async function exportCardsToAnki(format = "apkg", { cards = null, deckName = "", button = null } = {}) {
  const list = cards || state.cards.filter((card) => !card.targetLanguage || card.targetLanguage === state.targetLanguage);
  if (!list.length) return;
  const control = button || (format === "txt" ? $("#review-export-text") : $("#review-export-anki"));
  const label = control?.textContent || "";
  if (control) { control.disabled = true; control.textContent = "Exporting…"; }
  try {
    const response = await fetch("/api/anki/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format, deckName: deckName || `LVL::${state.targetLanguage}`, cards: list }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Export failed (${response.status})`);
    }
    const blob = await response.blob();
    const name = (response.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || `lvl.${format}`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    toast(error.message || "Export failed", { tone: "error" });
  } finally {
    if (control?.isConnected) { control.disabled = false; control.textContent = label; }
  }
}

export async function deleteStudyDeck(deck) {
  if (!deck) return;
  if (!(await confirmDialog({ title: `Delete "${deck.name}"?`, confirmLabel: "Delete",
    text: `Its ${deck.total.toLocaleString()} card${deck.total === 1 ? "" : "s"} and their progress are lost.` }))) return;
  try {
    if (deck.storeId) {
      const response = await fetch(`/api/anki/decks/${encodeURIComponent(deck.storeId)}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
      if (!response.ok && response.status !== 404) throw new Error(`Couldn't delete the deck (${response.status})`);
      storedDecks = storedDecks.filter((item) => item.id !== deck.storeId);
    }
    const ids = new Set(deck.cards.map((card) => card.id));
    state.cards = state.cards.filter((card) => !ids.has(card.id));
    touchLearningState();
    saveState();
    studyView.menuKey = null;
    toast(`${deck.name} deleted`);
    renderStudyPage();
    updateDueCount();
    renderStats();
  } catch (error) {
    toast(error.message || "Couldn't delete the deck", { tone: "error" });
  }
}

/* ---------------------------------------------------------------- Study: Top words and AnkiWeb */

export const LANGUAGE_NAMES = { EN: "English", ES: "Spanish", FR: "French", DE: "German", IT: "Italian", PT: "Portuguese", JA: "Japanese", KO: "Korean", ZH: "Chinese", RU: "Russian", NL: "Dutch", PL: "Polish", TR: "Turkish" };
export const languageName = (code) => LANGUAGE_NAMES[String(code || "").toUpperCase()] || String(code || "");

export async function openTopWordsDialog() {
  const dialog = $("#top-words-dialog");
  const options = $("#top-words-options");
  const language = state.targetLanguage;
  $("#top-words-language").textContent = `${languageName(language)} words, ranked by how often they're said in films and series`;
  options.innerHTML = '<div class="ui-skeleton ui-skeleton--wide" aria-hidden="true"></div>';
  $("#top-words-status").textContent = "";
  if (!dialog.open) dialog.showModal();
  try {
    const info = await fetchJson(`/api/anki/presets?language=${encodeURIComponent(language)}`);
    const deck = storedDecks.find((item) => item.id === `preset-words-${language.toLowerCase()}`);
    const localCards = deck ? state.cards.filter((card) => card.anki?.deckId === deck.id).length : 0;
    const added = localCards ? Number(deck?.extra?.size) || 0 : 0;
    if (!info.available) {
      options.innerHTML = emptyMarkup({ compact: true, title: `No meanings bundled for ${languageName(language)}`, text: "Pick another target language, or get a deck from AnkiWeb." });
      return;
    }
    options.innerHTML = info.sizes.map(({ size, cards }) => {
      const done = added >= size;
      return `<button class="top-words-option${done ? " is-added" : ""}" type="button" data-top-size="${size}" aria-label="${escapeHtml(`Top ${size.toLocaleString()}: ${cards.toLocaleString()} cards${done ? ", added" : ""}`)}">
        <strong>Top ${size.toLocaleString()}</strong>
        <span>${cards.toLocaleString()} cards</span>
        <em>${done ? "Added" : added && size > added ? `Adds ${(cards - (info.sizes.find((item) => item.size === added)?.cards || 0)).toLocaleString()}` : "Add"}</em>
      </button>`;
    }).join("");
  } catch (error) {
    options.innerHTML = "";
    $("#top-words-status").textContent = error.message || "Couldn't load the word lists";
  }
}

export async function addTopWords(size, button) {
  const language = state.targetLanguage;
  const status = $("#top-words-status");
  if (button) button.disabled = true;
  status.textContent = `Adding the Top ${Number(size).toLocaleString()}…`;
  try {
    const response = await fetch("/api/anki/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, languageName: languageName(language), size: Number(size) }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Couldn't add the deck (${response.status})`);
    const tally = mergeDeckCards(data.deck, data.cards || []);
    status.textContent = deckTallyText(data.deck, tally);
    await openTopWordsDialog();
    status.textContent = deckTallyText(data.deck, tally);
    renderStudyPage();
    updateDueCount();
  } catch (error) {
    status.textContent = error.message || "Couldn't add the deck";
    if (button) button.disabled = false;
  }
}

const ankiweb = { query: "", results: [], stale: false, details: new Map(), open: null, jobs: new Map() };

export function openAnkiwebDialog() {
  const dialog = $("#ankiweb-dialog");
  const input = $("#ankiweb-query");
  const query = ankiweb.query || languageName(state.targetLanguage).toLowerCase();
  input.value = query;
  if (!dialog.open) dialog.showModal();
  if (!ankiweb.results.length || ankiweb.query !== query) void searchAnkiweb(query);
  else renderAnkiwebResults();
}

export async function searchAnkiweb(query) {
  const text = String(query || "").trim();
  if (!text) return;
  ankiweb.query = text;
  const results = $("#ankiweb-results");
  results.innerHTML = '<div class="ui-skeleton ui-skeleton--wide" aria-hidden="true"></div><div class="ui-skeleton ui-skeleton--wide" aria-hidden="true"></div>';
  try {
    const data = await fetchJson(`/api/ankiweb/search?${new URLSearchParams({ q: text, limit: "40" })}`);
    ankiweb.results = data.decks || [];
    ankiweb.stale = Boolean(data.stale);
    renderAnkiwebResults();
  } catch (error) {
    results.innerHTML = emptyMarkup({ compact: true, icon: "alert", title: "AnkiWeb didn't answer", text: error.message || "Try again in a moment." });
  }
}

function ankiwebRowMarkup(deck) {
  const details = ankiweb.details.get(deck.id);
  const job = ankiweb.jobs.get(deck.id);
  const stored = storedDecks.some((item) => item.id === `ankiweb-${deck.id}`);
  const open = ankiweb.open === deck.id;
  const media = [deck.audio ? `${deck.audio.toLocaleString()} audio` : "", deck.images ? `${deck.images.toLocaleString()} images` : ""].filter(Boolean).join(", ");
  const progress = job && (job.status === "downloading" || job.status === "importing")
    ? `<div class="ui-progress" role="progressbar" aria-label="Download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${job.total ? Math.round((job.received / job.total) * 100) : 0}"><span style="width:${job.total ? Math.round((job.received / job.total) * 100) : 8}%"></span></div><small>${job.status === "importing" ? "Saving cards and media…" : `Downloading ${formatBytes(job.received)}${job.total ? ` of ${formatBytes(job.total)}` : ""}`}</small>`
    : "";
  const action = stored || job?.status === "done"
    ? '<button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" data-ankiweb-study>Study</button>'
    : job && job.status !== "error"
      ? '<button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" disabled>Adding…</button>'
      : '<button class="ui-btn ui-btn--primary ui-btn--sm" type="button" data-ankiweb-add>Add deck</button>';
  return `<article class="ankiweb-row${open ? " is-open" : ""}" data-shared-id="${deck.id}">
    <button class="ankiweb-row__main" type="button" data-ankiweb-toggle aria-expanded="${open}">
      <strong>${escapeHtml(deck.title)}</strong>
      <span>${[`👍 ${deck.thumbsUp.toLocaleString()}`, `${deck.notes.toLocaleString()} notes`, media].filter(Boolean).join(", ")}</span>
    </button>
    <div class="ankiweb-row__action">${action}</div>
    ${open ? `<div class="ankiweb-row__details">${details === "loading" || !details ? '<div class="ui-skeleton ui-skeleton--text" aria-hidden="true"></div>'
      : details.error ? `<p class="learn-status">${escapeHtml(details.error)}</p>`
        : `<p class="ankiweb-row__facts">${escapeHtml([details.size ? formatBytes(details.size) : "", details.lastUpdated ? `Updated ${new Date(details.lastUpdated).toLocaleDateString()}` : "", details.tags].filter(Boolean).join(", "))}</p><p class="ankiweb-row__description">${escapeHtml(details.description || "No description.").slice(0, 1200)}</p><a class="ui-link" href="https://ankiweb.net/shared/info/${deck.id}" target="_blank" rel="noopener noreferrer">Open on AnkiWeb</a>`}</div>` : ""}
    ${progress ? `<div class="ankiweb-row__progress">${progress}</div>` : ""}
    ${job?.status === "error" ? `<p class="learn-status ankiweb-row__error">${escapeHtml(job.error || "Download failed")}</p>` : ""}
  </article>`;
}

function renderAnkiwebResults() {
  const results = $("#ankiweb-results");
  if (!results) return;
  results.innerHTML = ankiweb.results.length
    ? `${ankiweb.stale ? `<p class="learn-status">${escapeHtml(t("Cached results: AnkiWeb is temporarily unavailable."))}</p>` : ""}<p class="learn-footnote">${ankiweb.results.length} decks for "${escapeHtml(ankiweb.query)}", best rated first</p>${ankiweb.results.map(ankiwebRowMarkup).join("")}`
    : emptyMarkup({ compact: true, title: "No shared decks found", text: "Try another word, like the language's name." });
}

export async function toggleAnkiwebDetails(sharedId) {
  ankiweb.open = ankiweb.open === sharedId ? null : sharedId;
  renderAnkiwebResults();
  if (ankiweb.open !== sharedId || ankiweb.details.has(sharedId)) return;
  ankiweb.details.set(sharedId, "loading");
  try {
    ankiweb.details.set(sharedId, await fetchJson(`/api/ankiweb/decks/${sharedId}`));
  } catch (error) {
    ankiweb.details.set(sharedId, { error: error.message || "Couldn't read this deck" });
  }
  renderAnkiwebResults();
}

export async function addAnkiwebDeck(sharedId) {
  try {
    const started = await postJson(`/api/ankiweb/decks/${sharedId}/download`, {});
    ankiweb.jobs.set(sharedId, started);
    renderAnkiwebResults();
    let job = started;
    for (let tick = 0; tick < 1800 && (job.status === "downloading" || job.status === "importing"); tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      job = await fetchJson(`/api/ankiweb/jobs/${started.id}`);
      ankiweb.jobs.set(sharedId, job);
      if ($("#ankiweb-dialog")?.open) renderAnkiwebResults();
    }
    if (job.status !== "done") throw new Error(job.error || "The download didn't finish");
    const result = await fetchJson(`/api/ankiweb/jobs/${started.id}?result=1`);
    const tally = mergeDeckCards(result.deck, result.cards || []);
    ankiweb.jobs.set(sharedId, { ...job, status: "done" });
    toast(deckTallyText(result.deck, tally));
    renderAnkiwebResults();
    renderStudyPage();
    updateDueCount();
  } catch (error) {
    ankiweb.jobs.set(sharedId, { status: "error", error: error.message || "Download failed" });
    renderAnkiwebResults();
  }
}
