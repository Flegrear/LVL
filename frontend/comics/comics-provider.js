import { buttonMarkup, escapeHtml, refreshImages, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";

export function createProviderSession(fetchPage) {
  let revision = 0;
  const state = { sourceId: "", mode: "popular", query: "", page: 0, hasNextPage: false, loading: false, loaded: false, error: "", status: "", items: [] };
  const snapshot = () => ({ ...state, items: [...state.items] });
  async function fetchNext(append, selection) {
    const token = ++revision;
    if (!append) Object.assign(state, { sourceId: selection.sourceId, mode: selection.mode, query: selection.query || "", page: 0, hasNextPage: false, items: [], loaded: false });
    const page = append ? state.page + 1 : 1;
    state.loading = true;
    state.error = "";
    try {
      const result = await fetchPage({ sourceId: state.sourceId, mode: state.mode, query: state.query, page });
      if (token !== revision) return snapshot();
      state.status = result.status || "ok";
      state.loaded = true;
      state.page = page;
      const known = new Set(state.items.map((item) => item.path));
      state.items = append ? [...state.items, ...(result.items || []).filter((item) => !known.has(item.path))] : result.items || [];
      state.hasNextPage = state.status === "ok" && Boolean(result.hasNextPage) && page < 20;
      if (state.status !== "ok") state.error = result.error || (state.status === "unsupported" ? "This source doesn't support this view." : "This source couldn't load.");
    } catch (error) {
      if (token === revision) state.error = String(error?.message || "Source request failed");
    } finally {
      if (token === revision) state.loading = false;
    }
    return snapshot();
  }
  return {
    snapshot,
    reset(selection) {
      ++revision;
      Object.assign(state, { sourceId: selection.sourceId || "", mode: selection.mode || "popular", query: selection.query || "",
        page: 0, hasNextPage: false, loading: false, loaded: false, error: "", status: "", items: [] });
      return snapshot();
    },
    load: (selection) => fetchNext(false, selection),
    more: () => state.hasNextPage && !state.loading ? fetchNext(true) : Promise.resolve(snapshot()),
  };
}

const card = (item, opened) => `<article class="comic-provider-card"><div class="comic-provider-card__art">${item.cover ? `<img alt="" loading="lazy" decoding="async" src="${escapeHtml(item.cover)}" />` : ""}</div>
  <div class="comic-provider-card__copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(opened ? t("In Library") : t("Source title"))}</small>
  ${buttonMarkup({ label: opened ? "Open" : "Add to Library", size: "sm", variant: opened ? "secondary" : "primary", attrs: {
    "data-provider-add": item.path,
  } })}</div></article>`;

export const providerBrowserMarkup = () => `<section class="comic-provider" data-comic-provider aria-label="${escapeHtml(t("Browse a source"))}">
  <div class="comic-provider__header"><h2>${escapeHtml(t("Browse a source"))}</h2><span>${escapeHtml(t("Choose a provider to see its titles."))}</span></div>
  <div class="comic-provider__tools"><label>${escapeHtml(t("Source"))}<select data-provider-source><option value="">${escapeHtml(t("Choose source"))}</option></select></label>
  <div class="comic-provider__modes" role="group" aria-label="${escapeHtml(t("Browse mode"))}">
  ${["popular", "latest", "search"].map((mode) => `<button type="button" class="ui-btn ui-btn--sm ui-btn--ghost" data-provider-mode="${mode}" aria-pressed="${mode === "popular"}">${escapeHtml(t(({ popular: "Popular", latest: "Latest", search: "Search" })[mode]))}</button>`).join("")}</div>
  <form data-provider-query role="search" hidden><input type="search" maxlength="80" aria-label="${escapeHtml(t("Search this source"))}" placeholder="${escapeHtml(t("Search this source"))}" /><button type="submit" class="ui-btn ui-btn--primary ui-btn--sm">${escapeHtml(t("Search"))}</button></form></div>
  <p class="comic-provider__status" role="status" aria-live="polite"></p><div class="comic-provider__grid"></div>
  <div class="comic-provider__footer"><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-provider-more hidden>${escapeHtml(t("Load more"))}</button></div>
  </section>`;

export function mountProviderBrowser(section, ctx) {
  if (!section) return;
  const sourceField = section.querySelector("[data-provider-source]");
  const queryForm = section.querySelector("[data-provider-query]");
  const status = section.querySelector(".comic-provider__status");
  const grid = section.querySelector(".comic-provider__grid");
  const more = section.querySelector("[data-provider-more]");
  const session = createProviderSession((params) => comicsApi.providerBrowse(params));
  let sources = new Map();
  let favoritesLoaded = false;
  let generation = 0;
  const opened = new Map();
  const currentSource = () => sources.get(sourceField.value);
  const paint = () => {
    if (!section.isConnected) return;
    const state = session.snapshot();
    for (const mode of section.querySelectorAll("[data-provider-mode]")) mode.setAttribute("aria-pressed", String(mode.dataset.providerMode === state.mode));
    queryForm.hidden = state.mode !== "search";
    const source = currentSource();
    status.textContent = state.error || (state.loading ? t("Loading…") : !sources.size && favoritesLoaded ? t("Add favorite sources in Settings › Comics.") :
      !source ? t("Choose a source to browse.") : state.loaded ? t("{count} titles", { count: state.items.length }) : t("Choose Popular, Latest or Search."));
    status.classList.toggle("is-error", Boolean(state.error));
    grid.innerHTML = state.items.map((item) => card(item, opened.get(`${state.sourceId}\n${item.path}`) || item.workId)).join("");
    more.hidden = !state.hasNextPage || Boolean(state.error);
    more.disabled = state.loading;
    refreshImages(grid);
  };
  const load = async (append = false) => {
    if (!currentSource()) return paint();
    const mode = section.querySelector("[data-provider-mode][aria-pressed=true]")?.dataset.providerMode || "popular";
    const query = queryForm.querySelector("input").value.trim();
    if (mode === "search" && !query) {
      session.reset({ sourceId: sourceField.value, mode, query });
      paint();
      status.textContent = t("Enter a title to search this source.");
      return;
    }
    const request = ++generation;
    const promise = append ? session.more() : session.load({ sourceId: sourceField.value, mode, query });
    paint();
    await promise;
    if (request === generation) paint();
  };
  comicsApi.favorites().then(({ favorites = [] }) => {
    if (!section.isConnected) return;
    sources = new Map(favorites.map((item) => [String(item.id), item]));
    favoritesLoaded = true;
    sourceField.insertAdjacentHTML("beforeend", favorites.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml([item.name, item.lang, item.host].filter(Boolean).join(" · "))}</option>`).join(""));
    paint();
  }).catch((error) => { if (section.isConnected) status.textContent = error.message; });
  sourceField.addEventListener("change", () => {
    ++generation;
    if (!sourceField.value) { session.reset({ sourceId: "", mode: session.snapshot().mode }); return paint(); }
    void load();
  });
  section.addEventListener("click", async (event) => {
    const mode = event.target.closest("[data-provider-mode]");
    if (mode) {
      for (const button of section.querySelectorAll("[data-provider-mode]")) button.setAttribute("aria-pressed", String(button === mode));
      ++generation;
      session.reset({ sourceId: sourceField.value, mode: mode.dataset.providerMode });
      paint();
      if (mode.dataset.providerMode !== "search") void load();
      else queryForm.querySelector("input").focus();
      return;
    }
    if (event.target.closest("[data-provider-more]")) return void load(true);
    const button = event.target.closest("[data-provider-add]");
    if (!button || !currentSource()) return;
    const item = session.snapshot().items.find((entry) => entry.path === button.dataset.providerAdd);
    if (!item) return;
    const sourceId = sourceField.value;
    const request = generation;
    button.disabled = true;
    try {
      const reply = await comicsApi.providerAdd({ sourceId, path: item.path, title: item.title, cover: item.cover });
      opened.set(`${sourceId}\n${item.path}`, reply.workId);
      if (request !== generation || sourceId !== sourceField.value) return;
      paint();
      if (!section.isConnected) return;
      await ctx?.openFeatureTitle?.({ feature: "comics", item: reply.workId });
    } catch (error) { toast(error.message); button.disabled = false; }
  });
  queryForm.addEventListener("submit", (event) => { event.preventDefault(); void load(); });
  paint();
  return session;
}
