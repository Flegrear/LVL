// Settings › Comics: local folders now, comic sources below them.
import { buttonMarkup, escapeHtml, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { captureFocus } from "../ui/focus-lifecycle.js";
import { comicsApi } from "./comics-api.js";
import { comicsEnabled, refreshComicsPlaces, setComicsEnabled } from "./comics-enabled.js";

const when = (at) => (at ? new Date(at).toLocaleString() : t("Not scanned yet"));

// Recreate the one draft owned by this card without storing form values in a
// separate settings model. Capture at the actual synchronous DOM replacement.
function replaceFocusedMarkup(root, markup) {
  if (!root.isConnected) return false;
  const active = root.ownerDocument.activeElement;
  const owned = root.contains(active);
  const key = owned ? active.getAttribute("data-focus-key") : null;
  const sourceCard = owned ? active.closest(".settings-card") : null;
  const sourceSection = [...(sourceCard?.classList || [])].find((name) => name.startsWith("comics-settings__"));
  const draft = root.querySelector('[data-focus-key="comics-folder-path"]')?.value;
  const ticket = captureFocus(root);
  root.innerHTML = markup;
  const newPath = root.querySelector('[data-focus-key="comics-folder-path"]');
  if (newPath && draft !== undefined) newPath.value = draft;

  const matches = key === null ? [] : [...root.querySelectorAll("[data-focus-key]")]
    .filter((node) => node.getAttribute("data-focus-key") === key);
  const usable = matches.length === 1 && !matches[0].disabled && !matches[0].hidden
    && matches[0].getClientRects().length > 0;
  let fallback = null;
  if (owned && !usable) {
    fallback = sourceSection ? root.querySelector(`.${sourceSection} .settings-card__head h2`) : null;
    fallback ||= root.closest(".settings-card")?.querySelector(".settings-card__head h2");
    fallback ||= root.querySelector(".settings-card__head h2");
    if (fallback) fallback.tabIndex = -1;
  }
  ticket.restore({ fallback });
  return true;
}

const settingsRequests = new WeakMap();

// The on/off switch, first in the tab. Off leaves only this card.
export function comicsSwitchMarkup(on) {
  return `<section class="settings-card comics-card comics-settings__switch"><div class="settings-card__head"><h2>${escapeHtml(t("Comics section"))}</h2></div>`
    + `<label class="ui-switch settings-switch-row"><input type="checkbox" data-comics-enabled data-focus-key="comics-enable"${on ? " checked" : ""} />`
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
  const pick = `<label class="ui-btn ui-btn--${job.state === "none" ? "primary" : "secondary"} ui-btn--sm" for="comics-mihon-file" data-focus-key="comics-import-choose" role="button" tabindex="0">${escapeHtml(t(job.state === "none" ? "Choose backup" : "Choose another backup"))}</label>`
    + `<input id="comics-mihon-file" type="file" accept="${BACKUP_TYPES}" hidden data-mihon-file />`;
  const cancel = buttonMarkup({ label: "Cancel", variant: "ghost", size: "sm", attrs: { "data-mihon-cancel": "", "data-focus-key": "comics-import-cancel" } });
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
    + buttonMarkup({ label: "Add repository", variant: "ghost", size: "sm", attrs: { "data-mihon-repo": repo.url, "data-focus-key": `comics-import-repo:${repo.url}` } }) + "</li>").join("");
  return `<ul class="comics-import__facts">${facts.map((fact) => line(escapeHtml(fact))).join("")}</ul>`
    + (repos ? `<p class="settings-hint">${escapeHtml(t("Repositories in the backup that LVL doesn't have:"))}</p><ul class="comics-import__repos">${repos}</ul>` : "")
    + `<div class="settings-actions">${buttonMarkup({ label: "Import", variant: "primary", size: "sm", attrs: { "data-mihon-apply": "", "data-focus-key": "comics-import-apply" } })}${cancel}</div>`;
}
async function mountImport(card, ctx) {
  if (!card) return;
  const body = card.querySelector(".comics-import__body");
  let job = { state: "none" };
  let timer = 0;
  let serial = 0;
  let shown = "";
  const paint = () => {
    const markup = importBodyMarkup(job);
    if (card.isConnected && markup !== shown) {
      shown = markup;
      replaceFocusedMarkup(body, markup);
    }
  };
  const poll = () => {
    clearTimeout(timer);
    if (!card.isConnected || !["matching", "importing"].includes(job.state)) return;
    const request = serial;
    timer = setTimeout(async () => {
      const next = await comicsApi.mihonImportState().catch(() => job);
      if (!card.isConnected || request !== serial) return;
      job = next;
      paint();
      poll();
    }, 1500);
  };
  card.addEventListener("keydown", (event) => {
    if (!event.target.matches('[data-focus-key="comics-import-choose"]') || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    card.querySelector("[data-mihon-file]")?.click();
  });
  card.addEventListener("change", async (event) => {
    const file = event.target.closest("[data-mihon-file]")?.files?.[0];
    if (!file) return;
    const request = ++serial;
    job = { state: "uploading" };
    paint();
    let next;
    try { next = await comicsApi.mihonImport(file); } catch (error) { next = { state: "error", error: error.message }; }
    if (!card.isConnected || request !== serial) return;
    job = next;
    paint();
    poll();
  });
  card.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || button.dataset.mihonPending || button.dataset.mihonAdded) return;
    const request = ++serial;
    button.dataset.mihonPending = "1";
    button.setAttribute("aria-disabled", "true");
    try {
      if (button.matches("[data-mihon-apply]")) {
        job = { ...job, state: "importing" };
        paint();
        const next = await comicsApi.mihonImportApply().catch((error) => ({ state: "error", error: error.message }));
        if (!card.isConnected || request !== serial) return;
        job = next;
        paint();
        if (job.state === "done") { toast(t("Comics imported")); refreshComicsPlaces(ctx); ctx.refreshLibrary?.(); }
      } else if (button.matches("[data-mihon-cancel]")) {
        const next = await comicsApi.mihonImportCancel().catch(() => ({ state: "none" }));
        if (!card.isConnected || request !== serial) return;
        job = next;
        paint();
      } else if (button.dataset.mihonRepo) {
        await comicsApi.addSource({ kind: "mihon-repo", url: button.dataset.mihonRepo });
        if (!card.isConnected || request !== serial) return;
        button.textContent = t("Added");
        button.dataset.mihonAdded = "1";
        toast(t("Repository added. Choose the backup again to add its sources."));
      }
    } catch (error) {
      if (card.isConnected && request === serial) toast(error.message);
    } finally {
      if (button.isConnected) {
        delete button.dataset.mihonPending;
        if (!button.dataset.mihonAdded) button.removeAttribute("aria-disabled");
      }
      if (card.isConnected && request === serial) poll();
    }
  });
  // Show the chooser immediately so an older status GET cannot block input.
  paint();
  const initial = serial;
  const next = await comicsApi.mihonImportState().catch(() => job);
  if (!card.isConnected || initial !== serial) return;
  job = next;
  paint();
  poll();
}

// LVL's Android app (its bridge is window.LvlAndroid) can't read a folder of yours on the phone,
// so there the files are picked and copied into the default folder instead of typing a path.
const PICK_FILES = () => Boolean(globalThis.LvlAndroid);

function foldersMarkup({ folders = [] }) {
  const rows = folders.map((folder) => `<li class="comics-row"><span class="comics-row__text"><strong class="comics-row__mono">${escapeHtml(folder.path)}</strong>`
    + `<small>${escapeHtml([folder.isDefault ? t("Default folder") : "", t("{count} files", { count: folder.files || 0 }), when(folder.scannedAt)].filter(Boolean).join(" · "))}`
    + `${folder.error ? ` · <span class="is-error">${escapeHtml(folder.error)}</span>` : ""}</small></span>`
    + (folder.isDefault ? "" : buttonMarkup({ label: "Remove", variant: "ghost", size: "sm", attrs: { "data-comics-folder-remove": folder.path, "data-focus-key": `comics-folder-remove:${folder.path}` } }))
    + "</li>").join("");
  const add = PICK_FILES()
    ? `<div class="comics-add">${buttonMarkup({ label: "Add files", size: "sm", attrs: { "data-comics-files-pick": "", "data-focus-key": "comics-add-files" } })}`
      + `<input type="file" accept=".cbz,.zip,application/zip,application/vnd.comicbook+zip" multiple hidden data-comics-files /></div>`
    : `<form class="comics-add" data-comics-folder-add><label class="settings-field"><span>${escapeHtml(t("Folder path"))}</span>`
      + `<input name="path" data-focus-key="comics-folder-path" autocomplete="off" spellcheck="false" maxlength="400" placeholder="C:\\Users\\…\\Comics" /></label>`
      + buttonMarkup({ label: "Add folder", size: "sm", type: "submit", attrs: { "data-focus-key": "comics-add-folder" } }) + "</form>";
  return `<section class="settings-card comics-card comics-settings__folders"><div class="settings-card__head"><h2>${escapeHtml(t("Folders"))}</h2>`
    + buttonMarkup({ label: "Rescan", variant: "ghost", size: "sm", attrs: { "data-comics-rescan": "", "data-focus-key": "comics-rescan" } }) + "</div>"
    + `<p class="settings-hint">${escapeHtml(t(PICK_FILES() ? "CBZ and ZIP files you add are copied here, matched to their series and added to your Library." : "CBZ files and image folders here are matched to their series and added to your Library."))}</p>`
    + `<ul class="comics-rows">${rows}</ul>`
    + add
    + `<p class="tool-status settings-status comics-settings__status" role="status" aria-live="polite"></p></section>`;
}

// Copies the picked files one at a time, reporting progress in the card's status line.
async function addPickedFiles(input, panel, rerender) {
  const files = [...(input.files || [])];
  input.value = "";
  if (!files.length) return;
  const status = panel.querySelector(".comics-settings__status");
  const say = (text) => { if (status) status.textContent = text; };
  let added = 0;
  const failed = [];
  for (const [index, file] of files.entries()) {
    say(t("Adding {name} ({index} of {count})…", { name: file.name, index: index + 1, count: files.length }));
    try { await comicsApi.addFile(file); added += 1; }
    catch (error) { failed.push(`${file.name}: ${error.message}`); }
  }
  await rerender();
  if (added) toast(t(added === 1 ? "1 file added. Scanning it now." : "{count} files added. Scanning them now.", { count: added }));
  if (failed.length) toast(failed.slice(0, 3).join("\n"), { tone: "error" });
}

// extraSections: [async (panel) => void], used by the sources step.
export async function renderComicsSettings(panel, ctx, { extraSections = [] } = {}) {
  if (!panel) return;
  const state = settingsRequests.get(panel) || { revision: 0 };
  settingsRequests.set(panel, state);
  const revision = ++state.revision;
  // Feature settings own a dedicated tab panel; a response from a previous
  // visit must not paint the panel after the user has switched tabs.
  const isCurrent = () => panel.isConnected && !panel.hidden && state.revision === revision;
  if (!panel.dataset.comicsBound) {
    panel.dataset.comicsBound = "1";
    panel.addEventListener("change", async (event) => {
      const picker = event.target.closest("[data-comics-files]");
      if (picker) {
        await addPickedFiles(picker, panel, () => renderComicsSettings(panel, ctx, { extraSections }));
        if (panel.isConnected) ctx.refreshLibrary?.();
        return;
      }
      const box = event.target.closest("[data-comics-enabled]");
      if (!box) return;
      // Disabling a focused checkbox immediately blurs it before an awaited
      // save. Keep it focusable and suppress duplicate user changes instead.
      if (box.dataset.comicsPending) {
        box.checked = box.dataset.comicsPending === "true";
        return;
      }
      const enabled = box.checked;
      box.dataset.comicsPending = String(enabled);
      box.setAttribute("aria-busy", "true");
      try {
        const saved = await comicsApi.saveSettings({ enabled });
        setComicsEnabled(saved.enabled !== false);
        refreshComicsPlaces(ctx);
        if (panel.isConnected) await renderComicsSettings(panel, ctx, { extraSections });
        toast(t(saved.enabled !== false ? "Comics is on" : "Comics is off"));
      } catch (error) {
        if (box.isConnected) box.checked = !enabled;
        toast(error.message);
      } finally {
        if (box.isConnected) {
          delete box.dataset.comicsPending;
          box.removeAttribute("aria-busy");
        }
      }
    });
    panel.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-comics-folder-add]");
      if (!form) return;
      event.preventDefault();
      const submitted = form.path.value.trim();
      try {
        await comicsApi.addFolder(submitted);
        if (!panel.isConnected) return;
        // A second, unsent path entered during this request belongs to the user.
        if (form.isConnected && form.path.value.trim() === submitted) form.path.value = "";
        await renderComicsSettings(panel, ctx, { extraSections });
        toast(t("Folder added. Scanning it now."));
      } catch (error) { if (panel.isConnected) toast(error.message); }
    });
    panel.addEventListener("click", async (event) => {
      if (event.target.closest("[data-comics-files-pick]")) {
        event.preventDefault();
        panel.querySelector("[data-comics-files]")?.click();
        return undefined;
      }
      const remove = event.target.closest("[data-comics-folder-remove]");
      if (remove) {
        try {
          await comicsApi.removeFolder(remove.dataset.comicsFolderRemove);
          if (panel.isConnected) return renderComicsSettings(panel, ctx, { extraSections });
        } catch (error) { if (panel.isConnected) toast(error.message); }
        return undefined;
      }
      if (event.target.closest("[data-comics-rescan]")) {
        event.preventDefault();
        const status = panel.querySelector(".comics-settings__status");
        if (status) status.textContent = t("Scanning…");
        try {
          const result = await comicsApi.rescan();
          if (!panel.isConnected) return undefined;
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
  if (!isCurrent()) return false;
  if (settings) setComicsEnabled(settings.enabled !== false);
  if (!comicsEnabled()) return replaceFocusedMarkup(panel, comicsSwitchMarkup(false));
  let folders;
  try { folders = await comicsApi.folders(); }
  catch (error) {
    if (isCurrent()) replaceFocusedMarkup(panel, `${comicsSwitchMarkup(true)}<p class="is-error">${escapeHtml(error.message)}</p>`);
    return false;
  }
  if (!isCurrent()) return false;
  // Extra source settings may contain drafts owned by their own controller.
  const extraBefore = panel.querySelector(".comics-settings__extra");
  const focus = panel.ownerDocument.activeElement;
  if (extraBefore?.contains(focus) && focus.matches('input, textarea, [contenteditable="true"]')) return false;
  replaceFocusedMarkup(panel, `${comicsSwitchMarkup(true)}${importCardMarkup()}${foldersMarkup(folders)}<div class="comics-settings__extra"></div>`);
  void mountImport(panel.querySelector("[data-mihon-import]"), ctx);
  const extra = panel.querySelector(".comics-settings__extra");
  for (const section of extraSections) {
    if (!isCurrent()) return false;
    try { await section(extra); }
    catch (error) {
      if (isCurrent()) extra.insertAdjacentHTML("beforeend", `<p class="is-error">${escapeHtml(error.message)}</p>`);
    }
  }
  return true;
}
