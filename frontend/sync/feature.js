// Settings › Library › Sync: keep the Library the same on every device. The card shows the
// three places a synced copy can live; picking one shows its steps. The server does the work
// (backend/sync); this card shows the current step and refreshes while it is on screen.
import { buttonMarkup, confirmDialog, escapeHtml as esc, icon, toast } from "../ui/ui.js";

const CHOICE_KEY = "lvl-sync-option-v1";
const OPTIONS = [
  { id: "github", label: "GitHub", ready: true },
  { id: "google", label: "Google Drive", ready: false, text: "Sign in with Google, and LVL keeps the copy in a hidden folder only LVL can see." },
  { id: "folder", label: "A folder", ready: false, text: "Pick a folder that Syncthing, Google Drive or OneDrive already syncs, and LVL keeps the copy there." },
];
// GitHub fills in the token's name and permission; the repository is chosen on the page.
const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?name=LVL%20sync&description=LVL%20sync%2C%20only%20the%20lvl-sync%20repository&contents=write";

const ago = (ms) => {
  if (!ms) return "Not yet";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return new Date(ms).toLocaleString(document.documentElement.lang || undefined, { dateStyle: "medium", timeStyle: "short" });
};
const action = (label, name, variant = "secondary", extra = {}) => buttonMarkup({ label, variant, size: "sm", attrs: { "data-sync": name, ...extra } });
const external = (href, label, variant = "secondary") => `<a class="ui-btn ui-btn--${variant} ui-btn--sm sync-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer"><span>${esc(label)}</span>${icon("arrow-right")}</a>`;
const line = (text, { error = false, busy = false } = {}) => (text
  ? `<p class="ui-status${error ? " ui-status--error" : ""}"${error ? ' role="alert"' : ""}>${busy ? '<span class="sync-spinner" aria-hidden="true"></span>' : ""}<span>${esc(text)}</span></p>` : "");
const errorLine = (status) => line(status.lastError, { error: true });
const field = (label, input) => `<label class="settings-field"><span>${esc(label)}</span>${input}</label>`;
const repoLink = (status) => (status.repo ? `<a class="sync-repo" href="https://github.com/${esc(status.repo)}" target="_blank" rel="noopener noreferrer">${esc(status.repo)}</a>` : "lvl-sync");

// Numbered steps: each with what to do and, when there's one, the button that does it.
const steps = (list) => `<ol class="sync-steps">${list.map((item, n) => `<li class="sync-step${item.done ? " is-done" : ""}">`
  + `<span class="sync-step__mark" aria-hidden="true">${item.done ? icon("check") : n + 1}</span>`
  + `<span class="sync-step__text"><strong>${esc(item.title)}</strong>${item.text ? `<small>${esc(item.text)}</small>` : ""}</span>`
  + (item.action || "") + "</li>").join("")}</ol>`;
const createRepoStep = (status) => ({ title: "Create the repository lvl-sync", text: "Private, in your GitHub account. The page opens filled in.", action: external(status.newRepoUrl, "Create") });

function tokenSetup(status) {
  return steps([
    createRepoStep(status),
    { title: "Create a token for it", text: "Under Repository access choose Only select repositories › lvl-sync. Contents: Read and write.", action: external(NEW_TOKEN_URL, "Create") },
    { title: "Paste the token", text: "It stays on this device and is only sent to GitHub." },
  ]) + `<form class="sync-form" data-sync-form="token" autocomplete="off">`
    + field("Token", '<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…" required />')
    + buttonMarkup({ label: "Connect", variant: "primary", type: "submit" }) + "</form>";
}

// Signed in: who and where, with Disconnect.
const account = (status) => `<div class="sync-account"><span class="sync-account__text"><strong>${esc(status.login || "GitHub")}</strong>`
  + `<small>${status.mode === "token" ? "Connected with a token" : status.renew ? "Signed in · renews itself" : "Signed in until you disconnect"}</small></span>`
  + `${action("Disconnect", "disconnect", "ghost")}</div>`;

const stat = (label, value, note = "") => `<div class="ui-stat"><span class="ui-stat__label">${esc(label)}</span><span class="ui-stat__value">${esc(value)}</span>`
  + (note ? `<span class="ui-stat__note">${esc(note)}</span>` : "") + "</div>";

function githubPanel(status, ui) {
  if (status.step === "start") {
    if (!status.appReady || ui.showToken) {
      return tokenSetup(status) + (status.appReady ? action("Sign in with GitHub instead", "hide-token", "ghost") : "") + errorLine(status);
    }
    return `<div class="sync-signin">${action("Sign in with GitHub", "start", "primary")}`
      + `<label class="ui-switch settings-switch-row" for="sync-renew"><input id="sync-renew" type="checkbox" checked /><span class="ui-switch__track" aria-hidden="true"></span>`
      + `<span class="settings-learning-copy"><strong>Renew the sign-in by itself</strong><small>Each sign-in lasts 8 hours and renews while LVL runs. Off: it lasts until you disconnect.</small></span></label></div>`
      + action("Use a token instead", "show-token", "ghost") + errorLine(status);
  }
  if (status.step === "device") {
    const minutes = Math.max(0, Math.round((status.device.expiresAt - Date.now()) / 60000));
    return `<p class="settings-hint">Enter this code on GitHub to let LVL use lvl-sync.</p>`
      + `<div class="sync-code"><span>${esc(status.device.userCode)}</span>${action("Copy", "copy", "ghost")}</div>`
      + `<div class="settings-actions">${external(status.device.verificationUri, "Open GitHub", "primary")}${action("Cancel", "cancel", "ghost")}</div>`
      + line(`Waiting for GitHub. The code works for ${minutes} more min.`, { busy: true }) + errorLine(status);
  }
  if (status.step === "repo") {
    if (!status.repoMissing) return account(status) + line("Looking for lvl-sync…", { busy: true }) + errorLine(status);
    return account(status) + `<p class="settings-hint">LVL can't see a repository named lvl-sync in this account yet.</p>`
      + steps([createRepoStep(status), ...(status.mode === "token" ? [] : [{ title: "Give LVL access to it",
        text: "Only select repositories › lvl-sync › Install.", action: status.installUrl ? external(status.installUrl, "Open") : "" }])])
      + `<div class="settings-actions">${action("Check again", "find", "primary")}</div>` + errorLine(status);
  }
  if (status.step === "options") {
    return account(status) + `<p class="settings-hint">LVL keeps your tracking list in ${repoLink(status)} as plain files you can read on GitHub.</p>`
      + `<form class="sync-start" data-sync-form="begin" autocomplete="off">`
      + `<label class="ui-switch settings-switch-row" for="sync-encrypt"><input id="sync-encrypt" name="encrypt" type="checkbox"${ui.encrypt ? " checked" : ""} />`
      + `<span class="ui-switch__track" aria-hidden="true"></span><span class="settings-learning-copy"><strong>Encrypt with a passphrase</strong>`
      + `<small>Optional. GitHub then only stores unreadable files.</small></span></label>`
      + `<div class="sync-pass"${ui.encrypt ? "" : " hidden"}><div class="sync-pass__fields">`
      + field("Passphrase", '<input name="pass" type="password" autocomplete="new-password" placeholder="At least 8 characters" />')
      + field("The same again", '<input name="again" type="password" autocomplete="new-password" />') + "</div>"
      + `<p class="settings-hint">You type it once on each device. If it's lost, the synced copy can't be read, but every device keeps its own data.</p></div>`
      + `<div class="settings-actions">${buttonMarkup({ label: "Start syncing", variant: "primary", type: "submit" })}</div></form>` + errorLine(status);
  }
  if (status.step === "passphrase") {
    return account(status) + `<p class="settings-hint">${repoLink(status)} is encrypted. Enter the passphrase you chose on your other device.</p>`
      + `<form class="sync-form" data-sync-form="pass" autocomplete="off">${field("Passphrase", '<input name="pass" type="password" autocomplete="off" required />')}`
      + buttonMarkup({ label: "Join", variant: "primary", type: "submit" }) + "</form>" + errorLine(status);
  }
  const problems = [status.skippedFiles ? `${status.skippedFiles} unreadable file${status.skippedFiles === 1 ? "" : "s"} skipped` : "",
    status.refused ? `${status.refused} invalid change${status.refused === 1 ? "" : "s"} ignored` : ""].filter(Boolean).join(" · ");
  return account(status)
    + `<div class="ui-stat-group sync-stats">${stat("Last synced", status.syncing ? "Syncing…" : ago(status.lastSyncAt))}${stat("Sent", String(status.sent))}${stat("Received", String(status.received))}</div>`
    + `<p class="settings-hint">${repoLink(status)} · ${status.encrypted ? "Encrypted with your passphrase" : "Plain files"} · Checked every 30 s while LVL is open</p>`
    + (problems ? line(problems) : "")
    + (status.reloadNeeded ? `<div class="sync-banner"><span>Changes from your other devices reached your Library.</span>${action("Reload LVL", "reload", "primary")}</div>` : "")
    + `<div class="settings-actions">${action("Sync now", "now", "primary")}</div>` + errorLine(status);
}

function view(status, ui) {
  const connected = status.step !== "start";
  const picked = connected ? "github" : ui.choice;
  const chips = `<div class="ui-chip-row settings-sync-options" role="group" aria-label="Where LVL keeps the synced copy">${OPTIONS.map((option) =>
    `<button type="button" class="ui-chip" data-sync-option="${option.id}" aria-pressed="${picked === option.id}"${connected && option.id !== "github" ? " disabled" : ""}>`
    + `${esc(option.label)}${option.ready ? "" : '<span class="ui-chip__count">Soon</span>'}</button>`).join("")}</div>`;
  if (!picked) return `<p class="settings-hint">Your Library, where you are in each video and chapter, your ratings and your comics, the same on every device. Choose where LVL keeps the synced copy.</p>${chips}`;
  const option = OPTIONS.find((item) => item.id === picked);
  const panel = option.ready ? githubPanel(status, ui)
    : `<div class="sync-soon"><span class="ui-badge ui-badge--outline">Soon</span><p class="settings-hint">${esc(option.text)}</p></div>`;
  return `${chips}<div class="sync-panel">${panel}</div>`;
}


async function call(path, body) {
  const response = await fetch(`/api/sync/${path}`, body === undefined ? { headers: { Accept: "application/json" } }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Sync answered HTTP ${response.status}`);
  return data;
}

function mount(card) {
  card.dataset.syncMounted = "1";
  card.querySelector(".settings-card__head")?.insertAdjacentHTML("beforeend", '<span class="ui-badge ui-badge--outline settings-sync-badge" hidden></span>');
  card.insertAdjacentHTML("beforeend", '<div class="settings-sync-body"></div>');
  const body = card.querySelector(".settings-sync-body");
  const badge = card.querySelector(".settings-sync-badge");
  let status = { step: "start" };
  const ui = { choice: localStorage.getItem(CHOICE_KEY) || "", showToken: false, encrypt: false };
  let shown = "";
  let timer = 0;
  let finding = false;
  const render = (force = false) => {
    // Never redraw under the user's typing (a focused switch or button doesn't count).
    const typing = body.contains(document.activeElement) && document.activeElement.matches('input[type="password"], input[type="text"], input:not([type])');
    if (!force && typing) return;
    const markup = view(status, ui);
    if (markup === shown) return;
    shown = markup;
    body.innerHTML = markup;
    if (badge) {
      badge.textContent = status.step === "ready" ? "On" : status.step === "start" ? "" : "Setting up";
      badge.hidden = !badge.textContent;
    }
  };
  const refresh = async () => {
    try { status = await call("status"); } catch (error) { status = { ...status, lastError: error.message }; }
    // LVL looks for lvl-sync by itself after sign-in, and again while it isn't there.
    if (status.step === "repo" && !finding) {
      finding = true;
      try { status = await call("github/find", {}); } catch (error) { status = { ...status, lastError: error.message }; }
      finding = false;
    }
    render();
  };
  const loop = () => {
    window.clearTimeout(timer);
    if (!card.isConnected) return;
    // Only while the card is on screen: a hidden Settings tab or a background window asks nothing.
    if (document.hidden || !card.offsetParent) { timer = window.setTimeout(loop, 5000); return; }
    void refresh().finally(() => { timer = window.setTimeout(loop, status.step === "device" || status.syncing ? 2000 : 5000); });
  };
  const run = async (control, task) => {
    if (control) control.disabled = true;
    try { await task(); } catch (error) { status = { ...status, lastError: error.message }; } finally {
      if (control?.isConnected) control.disabled = false;
      render(true);
    }
  };
  body.addEventListener("change", (event) => {
    if (event.target.name !== "encrypt") return;
    ui.encrypt = event.target.checked;
    const fields = body.querySelector(".sync-pass");
    if (fields) fields.hidden = !ui.encrypt;
  });
  body.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-sync-form]");
    if (!form) return;
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const kind = form.dataset.syncForm;
    void run(submit, async () => {
      if (kind === "token") status = await call("github/token", { token: form.token.value.trim() });
      else if (kind === "pass") status = await call("passphrase", { passphrase: form.pass.value });
      else if (kind === "begin") {
        const encrypt = form.encrypt.checked;
        if (encrypt && form.pass.value !== form.again.value) throw new Error("The two passphrases are different");
        status = await call("start", { encrypt, passphrase: encrypt ? form.pass.value : "" });
      }
    });
  });
  body.addEventListener("click", (event) => {
    const option = event.target.closest("[data-sync-option]");
    if (option && !option.disabled) {
      ui.choice = option.dataset.syncOption;
      localStorage.setItem(CHOICE_KEY, ui.choice);
      render(true);
      return;
    }
    const target = event.target.closest("[data-sync]");
    if (!target || target.disabled) return;
    const name = target.dataset.sync;
    if (name === "show-token" || name === "hide-token") { ui.showToken = name === "show-token"; render(true); return; }
    void run(target, async () => {
      if (name === "start") status = await call("github/start", { renew: body.querySelector("#sync-renew")?.checked !== false });
      else if (name === "cancel") status = await call("github/cancel", {});
      else if (name === "copy") { await navigator.clipboard?.writeText(status.device?.userCode || ""); toast("Code copied"); }
      else if (name === "find") status = await call("github/find", {});
      else if (name === "now") status = (await call("now", {})).status;
      else if (name === "reload") { await call("reload-shown", {}); window.location.reload(); }
      else if (name === "disconnect") {
        const sure = await confirmDialog({ title: "Disconnect sync on this device?", confirmLabel: "Disconnect",
          text: "Your data on this device stays, and so does the copy in lvl-sync. You can connect again at any time." });
        if (sure) { status = await call("disconnect", {}); ui.showToken = false; ui.encrypt = false; }
      }
    });
  });
  loop();
  return loop;
}

export const syncFeature = {
  id: "sync",
  styles: ["/frontend/sync/sync.css"],
  hooks: {
    // Settings › Library was shown: the Sync card at its top.
    "settings:library"({ panel }) {
      const card = panel?.querySelector("#settings-sync");
      if (!card) return;
      if (card.dataset.syncMounted !== "1") card.syncLoop = mount(card);
      else card.syncLoop?.();
    },
  },
};
