// Tracking: volume ratings with an overall average (or
// override), AniList manga sync with the signed-in account (import, status,
// chapters/volumes read, overall score), and a New chapters row on Home.
// Scores sync only when the user enabled AniList score sync; progress only
// when AniList progress sync is on (the same choices as video).
import { buttonMarkup, escapeHtml, shelfMarkup, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicCardMarkup, loadLibrary } from "./comics-render.js";
import { sourceLanguages } from "./comics-sources.js";

const ANILIST = "https://graphql.anilist.co";
const SAVE = `mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $progressVolumes: Int, $scoreRaw: Int) {
  SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, progressVolumes: $progressVolumes, scoreRaw: $scoreRaw) { id status progress progressVolumes } }`;
const LIST = `query ($userId: Int) { MediaListCollection(userId: $userId, type: MANGA) { lists { entries { status progress progressVolumes
  media { id idMal title { romaji english native userPreferred } synonyms coverImage { large extraLarge color } format status chapters volumes averageScore popularity genres countryOfOrigin startDate { year } isAdult siteUrl } } } } }`;

async function anilist(ctx, query, variables) {
  const account = ctx.anilistAccount?.();
  if (!account?.token) return null;
  const response = await fetch(ANILIST, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.errors?.length) throw new Error(payload?.errors?.[0]?.message || `AniList answered HTTP ${response.status}`);
  return payload.data;
}
const anilistIdOf = (workId) => Number(/^anilist-(\d+)$/.exec(String(workId))?.[1]) || null;

export async function pushStatus(workId, status, ctx) {
  const mediaId = anilistIdOf(workId);
  if (!mediaId || !status || !ctx.anilistSync?.().progress) return;
  await anilist(ctx, SAVE, { mediaId, status }).catch((error) => toast(t("AniList: {error}", { error: error.message })));
}

// After reading: chapters and volumes read, and Completed once the last chapter is done.
export async function pushProgress(workId, ctx, { chaptersTotal = null } = {}) {
  const mediaId = anilistIdOf(workId);
  if (!mediaId || !ctx.anilistSync?.().progress || !ctx.anilistAccount?.()) return;
  const read = await fetch(`/api/comics/work/${workId}/read`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null);
  if (!read?.units) return;
  const done = Number.isInteger(chaptersTotal) && chaptersTotal > 0 && read.chapters >= chaptersTotal;
  await anilist(ctx, SAVE, { mediaId, progress: read.chapters || undefined, progressVolumes: read.volumes || undefined, status: done ? "COMPLETED" : "CURRENT" })
    .catch((error) => toast(t("AniList: {error}", { error: error.message })));
}

export async function pushScore(workId, overall, ctx) {
  const mediaId = anilistIdOf(workId);
  if (!mediaId || !ctx.anilistSync?.().scores) return;
  await anilist(ctx, SAVE, { mediaId, scoreRaw: overall === null ? 0 : Math.round(overall * 10) }).catch((error) => toast(t("AniList: {error}", { error: error.message })));
}

// Settings › Comics: import the AniList manga list.
export async function anilistSettingsSection(holder, ctx) {
  const account = ctx.anilistAccount?.();
  const sync = ctx.anilistSync?.() || {};
  const section = document.createElement("section");
  section.className = "settings-card comics-card";
  section.innerHTML = `<div class="settings-card__head"><h2>AniList</h2>${account ? `<span class="ui-badge ui-badge--outline">${escapeHtml(t("Connected"))}</span>` : ""}</div>`
    + `<p class="settings-hint">${escapeHtml(account
    ? t("Connected as {name}. Progress sync: {progress}. Score sync: {scores}.", { name: account.username, progress: sync.progress ? t("on") : t("off"), scores: sync.scores ? t("on") : t("off") })
    : t("Connect AniList in Settings › Recommendations to import and sync your manga list."))}</p>`
    + (account ? `<div class="settings-actions">${buttonMarkup({ label: "Import my manga list", size: "sm", attrs: { "data-anilist-import": "" } })}</div>` : "");
  holder.append(section);
  section.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-anilist-import]");
    if (!button) return;
    button.disabled = true;
    try {
      const data = await anilist(ctx, LIST, { userId: account.userId });
      const response = await fetch("/api/comics/library/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lists: data?.MediaListCollection?.lists || [] }), signal: AbortSignal.timeout(60_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await loadLibrary({ force: true });
      ctx.refreshLibrary?.();
      toast(t("{count} manga imported from AniList", { count: result.imported }));
    } catch (error) { toast(error.message); } finally { button.disabled = false; }
  });
}

// Home "Comics" tab: newest chapters for titles you're reading.
export async function newChaptersShelf(ctx) {
  const langs = sourceLanguages(ctx.preferences?.() || {}, {});
  const response = await fetch(`/api/comics/updates?${new URLSearchParams({ langs: langs.join(",") })}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) return "";
  const { items = [] } = await response.json();
  const cards = items.map((item) => comicCardMarkup(item.entry.work, ctx, { badge: t("Chapter {number}", { number: item.chapter.chapter }) })).filter(Boolean);
  return cards.length ? shelfMarkup({ id: "comics-new", title: t("New chapters"), cards }) : "";
}
