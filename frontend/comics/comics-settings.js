// Settings › Comics: local folders now, comic sources below them.
import { buttonMarkup, escapeHtml, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { comicsEnabled, refreshComicsPlaces, setComicsEnabled } from "./comics-enabled.js";

const when = (at) => (at ? new Date(at).toLocaleString() : t("Not scanned yet"));

// The on/off switch, first in the tab. Off leaves only this card.
export function comicsSwitchMarkup(on) {
  return `<section class="settings-card comics-card comics-settings__switch"><div class="settings-card__head"><h2>${escapeHtml(t("Comics section"))}</h2></div>`
    + `<label class="ui-switch settings-switch-row"><input type="checkbox" data-comics-enabled${on ? " checked" : ""} />`
    + `<span class="ui-switch__track" aria-hidden="true"></span><span class="settings-learning-copy"><strong>${escapeHtml(t("Enable Comics"))}</strong></span></label></section>`;
}

// Import from Mihon or Tachiyomi: choose the backup, see what joins, then import (backend/comics/mihon-import.js).
const number = (value) => Number(value || 0).toLocaleString(document.documentElement.lang || undefined);
const BACKUP_TYPES = ".tachibk,.gz,.proto,application/gzip,application/x-gzip,application/octet-stream";
function importCardMarkup() {
  return `<section class="settings-card comics-card comics-settings__import" data-mihon-import><div class="settings-card__head"><h2>${escapeHtml(t("Import from Mihon or Tachiyomi"))}</h2></div>`
    + `<p class="settings-hint">${escapeHtml(t("A Mihon backup (.tachibk) or Tachiyomi backup (.proto.gz). Your library, its sources and the chapters you read join Library › Comics. Mihon and AniList aren't changed."))}</p>`
    + `<div class="comics-import__body" aria-live="polite"></div></section>`;
}
function importBodyMarkup(job) {
  const pick = `<label class="ui-btn ui-btn--${job.state === "none" ? "primary" : "secondary"} ui-btn--sm" for="comics-mihon-file">${escapeHtml(t(job.state === "none" ? "Choose backup" : "Choose another backup"))}</label>`
    + `<input id="comics-mihon-file" type="file" accept="${BACKUP_TYPES}" hidden data-mihon-file />`;
  const cancel = buttonMarkup({ label: "Cancel", variant: "ghost", size: "sm", attrs: { "data-mihon-cancel": "" } });
  const line = (text) => `<li>${text}</li>`;
  if (job.state === "uploading") return `<p class="settings-hint">${escapeHtml(t("Reading the backup…"))}</p>`;
  if (job.state === "importing") return `<p class="settings-hint">${escapeHtml(t("Importing…"))}</p>`;
  if (job.state === "matching") {
    const percent = Math.round((100 * (job.progress?.done || 0)) / Math.max(1, job.progress?.total || 1));
    return `<p class="settings-hint">${escapeHtml(t("Finding your comics on AniList… {percent}%", { percent }))}</p><div class="settings-actions">${cancel}</div>`;
  }
  if (job.state === "error") return `<p class="settings-status is-error" role="alert">${escapeHtml(job.error || t("The import didn't work"))}</p><div class="settings-actions">${pick}</div>`;
  if (job.state === "done") {
    const r = job.result || {};
    return `<ul class="comics-import__facts">${line(escapeHtml(t("Imported {count} comics: {added} new in your Library, {sources} read from their source.", { count: number(r.comics), added: number(r.newInLibrary), sources: number(r.fromSources) })))}`
      + line(escapeHtml(t("{read} chapters marked read, {open} in progress. {favorites} favorite sources added.", { read: number(r.read), open: number(r.inProgress), favorites: number(r.favorites) })))
      + (r.adultSkipped ? line(escapeHtml(t("{count} adult titles were left out.", { count: number(r.adultSkipped) }))) : "") + `</ul><div class="settings-actions">${pick}</div>`;
  }
  if (job.state !== "ready") return `<div class="settings-actions">${pick}</div>`;
  const p = job.preview || {};
  const facts = [
    t("{count} comics in the backup's library ({file}).", { count: number(p.entries), file: job.file || t("backup") }),
    t("{count} found on AniList, {inLibrary} of them already in your Library.", { count: number(p.onAniList), inLibrary: number(p.inLibrary) }),
    p.fromSources ? t("{count} aren't on AniList. They join as comics read from their source: {titles}.", { count: number(p.fromSources), titles: (p.notMatched || []).join(", ") + (p.fromSources > (p.notMatched || []).length ? "…" : "") }) : "",
    p.adult ? t("{count} adult titles are left out. Turn on Show adult content below to import them.", { count: number(p.adult) }) : "",
    t("{read} chapters read, {open} in progress.", { read: number(p.read), open: number(p.inProgress) }),
    p.sources?.length ? t("Sources: {names}.", { names: p.sources.join(", ") }) + (p.newFavorites?.length ? ` ${t("New favorite sources: {names}.", { names: p.newFavorites.join(", ") })}` : "") : "",
    p.missingSources?.length ? t("Not in your repositories: {names}. Add their repository, then import again to read them here.", { names: p.missingSources.join(", ") }) : "",
  ].filter(Boolean);
  const repos = (p.repositories || []).map((repo) => `<li><span class="comics-row__mono">${escapeHtml(repo.url)}</span>`
    + buttonMarkup({ label: "Add repository", variant: "ghost", size: "sm", attrs: { "data-mihon-repo": repo.url } }) + "</li>").join("");
  return `<ul class="comics-import__facts">${facts.map((fact) => line(escapeHtml(fact))).join("")}</ul>`
    + (repos ? `<p class="settings-hint">${escapeHtml(t("Repositories in the backup that LVL doesn't have:"))}</p><ul class="comics-import__repos">${repos}</ul>` : "")
    + `<div class="settings-actions">${buttonMarkup({ label: "Import", variant: "primary", size: "sm", attrs: { "data-mihon-apply": "" } })}${cancel}</div>`;
}
async function mountImport(card, ctx) {
  if (!card) return;
  const body = card.querySelector(".comics-import__body");
  let job = { state: "none" };
  let timer = 0;
  const paint = () => { if (card.isConnected) body.innerHTML = importBodyMarkup(job); };
  const poll = () => {
    clearTimeout(timer);
    if (!card.isConnected || !["matching", "importing"].includes(job.state)) return;
    timer = setTimeout(async () => { job = await comicsApi.mihonImportState().catch(() => job); paint(); poll(); }, 1500);
  };
  card.addEventListener("change", async (event) => {
    const file = event.target.closest("[data-mihon-file]")?.files?.[0];
    if (!file) return;
    job = { state: "uploading" };
    paint();
    try { job = await comicsApi.mihonImport(file); } catch (error) { job = { state: "error", error: error.message }; }
    paint();
    poll();
  });
  card.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    button.disabled = true;
    if (button.matches("[data-mihon-apply]")) {
      job = { ...job, state: "importing" };
      paint();
      job = await comicsApi.mihonImportApply().catch((error) => ({ state: "error", error: error.message }));
      paint();
      if (job.state === "done") { toast(t("Comics imported")); refreshComicsPlaces(ctx); ctx.refreshLibrary?.(); }
    } else if (button.matches("[data-mihon-cancel]")) {
      job = await comicsApi.mihonImportCancel().catch(() => ({ state: "none" }));
      paint();
    } else if (button.dataset.mihonRepo) {
      try {
        await comicsApi.addSource({ kind: "mihon-repo", url: button.dataset.mihonRepo });
        button.textContent = t("Added");
        toast(t("Repository added. Choose the backup again to add its sources."));
      } catch (error) { toast(error.message); button.disabled = false; }
    }
  });
  job = await comicsApi.mihonImportState().catch(() => job);
  paint();
  poll();
}

function foldersMarkup({ folders = [] }) {
  const rows = folders.map((folder) => `<li class="comics-row"><span class="comics-row__text"><strong class="comics-row__mono">${escapeHtml(folder.path)}</strong>`
    + `<small>${escapeHtml([folder.isDefault ? t("Default folder") : "", t("{count} files", { count: folder.files || 0 }), when(folder.scannedAt)].filter(Boolean).join(" · "))}`
    + `${folder.error ? ` · <span class="is-error">${escapeHtml(folder.error)}</span>` : ""}</small></span>`
    + (folder.isDefault ? "" : buttonMarkup({ label: "Remove", variant: "ghost", size: "sm", attrs: { "data-comics-folder-remove": folder.path } }))
    + "</li>").join("");
  return `<section class="settings-card comics-card comics-settings__folders"><div class="settings-card__head"><h2>${escapeHtml(t("Folders"))}</h2>`
    + buttonMarkup({ label: "Rescan", variant: "ghost", size: "sm", attrs: { "data-comics-rescan": "" } }) + "</div>"
    + `<p class="settings-hint">${escapeHtml(t("CBZ files and image folders here are matched to their series and added to your Library."))}</p>`
    + `<ul class="comics-rows">${rows}</ul>`
    + `<form class="comics-add" data-comics-folder-add><label class="settings-field"><span>${escapeHtml(t("Folder path"))}</span>`
    + `<input name="path" autocomplete="off" spellcheck="false" maxlength="400" placeholder="C:\\Users\\…\\Comics" /></label>`
    + buttonMarkup({ label: "Add folder", size: "sm", type: "submit" }) + "</form>"
    + `<p class="tool-status settings-status comics-settings__status" role="status" aria-live="polite"></p></section>`;
}

// extraSections: [async (panel) => void], used by the sources step.
export async function renderComicsSettings(panel, ctx, { extraSections = [] } = {}) {
  if (!panel) return;
  if (!panel.dataset.comicsBound) {
    panel.dataset.comicsBound = "1";
    panel.addEventListener("change", async (event) => {
      const box = event.target.closest("[data-comics-enabled]");
      if (!box) return;
      box.disabled = true;
      try {
        const saved = await comicsApi.saveSettings({ enabled: box.checked });
        setComicsEnabled(saved.enabled !== false);
        refreshComicsPlaces(ctx);
        await renderComicsSettings(panel, ctx, { extraSections });
        toast(t(saved.enabled !== false ? "Comics is on" : "Comics is off"));
      } catch (error) {
        box.checked = !box.checked;
        box.disabled = false;
        toast(error.message);
      }
    });
    panel.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-comics-folder-add]");
      if (!form) return;
      event.preventDefault();
      try {
        await comicsApi.addFolder(form.path.value.trim());
        form.path.value = "";
        await renderComicsSettings(panel, ctx, { extraSections });
        toast(t("Folder added. Scanning it now."));
      } catch (error) { toast(error.message); }
    });
    panel.addEventListener("click", async (event) => {
      const remove = event.target.closest("[data-comics-folder-remove]");
      if (remove) {
        await comicsApi.removeFolder(remove.dataset.comicsFolderRemove).catch((error) => toast(error.message));
        return renderComicsSettings(panel, ctx, { extraSections });
      }
      if (event.target.closest("[data-comics-rescan]")) {
        event.preventDefault();
        const status = panel.querySelector(".comics-settings__status");
        if (status) status.textContent = t("Scanning…");
        try {
          const result = await comicsApi.rescan();
          await renderComicsSettings(panel, ctx, { extraSections });
          const done = panel.querySelector(".comics-settings__status");
          if (done) done.textContent = t("{count} series matched or added", { count: result.matched?.length || 0 });
          ctx.refreshLibrary?.();
        } catch (error) { toast(error.message); }
      }
      return undefined;
    });
  }
  const settings = await comicsApi.settings().catch(() => null);
  if (settings) setComicsEnabled(settings.enabled !== false);
  if (!comicsEnabled()) { panel.innerHTML = comicsSwitchMarkup(false); return; }
  let folders;
  try { folders = await comicsApi.folders(); } catch (error) { panel.innerHTML = `${comicsSwitchMarkup(true)}<p class="is-error">${escapeHtml(error.message)}</p>`; return; }
  panel.innerHTML = `${comicsSwitchMarkup(true)}${importCardMarkup()}${foldersMarkup(folders)}<div class="comics-settings__extra"></div>`;
  void mountImport(panel.querySelector("[data-mihon-import]"), ctx);
  const extra = panel.querySelector(".comics-settings__extra");
  for (const section of extraSections) await Promise.resolve(section(extra)).catch((error) => { extra.insertAdjacentHTML("beforeend", `<p class="is-error">${escapeHtml(error.message)}</p>`); });
}
