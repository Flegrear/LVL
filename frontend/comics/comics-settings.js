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
    + `<span class="ui-switch__track" aria-hidden="true"></span><span class="settings-learning-copy"><strong>${escapeHtml(t("Use Comics"))}</strong>`
    + `<small>${escapeHtml(t(on ? "Turning it off hides Comics everywhere except here and stops its extension runner, folder scans and downloads. Your comics and reading progress are kept."
      : "Comics is off. Your comics, reading progress and settings are kept for when you turn it back on."))}</small></span></label></section>`;
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
  panel.innerHTML = `${comicsSwitchMarkup(true)}${foldersMarkup(folders)}<div class="comics-settings__extra"></div>`;
  const extra = panel.querySelector(".comics-settings__extra");
  for (const section of extraSections) await Promise.resolve(section(extra)).catch((error) => { extra.insertAdjacentHTML("beforeend", `<p class="is-error">${escapeHtml(error.message)}</p>`); });
}
