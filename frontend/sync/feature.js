// Settings › Library › Sync: keep the Library the same on every device. The card shows the
// three ways to sync; picking one shows its steps. The server does the work (backend/sync);
// this card shows the current step and checks again while it is on screen.
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const CHOICE_KEY = "lvl-sync-option-v1";
const OPTIONS = [
  { id: "github", label: "GitHub", ready: true },
  { id: "google", label: "Google Drive", ready: false },
  { id: "folder", label: "A folder", ready: false },
];
const ago = (ms) => {
  if (!ms) return "not yet";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : new Date(ms).toLocaleString();
};
const link = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
const button = (label, attrs = "", variant = "secondary") => `<button type="button" class="ui-btn ui-btn--${variant} ui-btn--sm" ${attrs}>${esc(label)}</button>`;

async function call(path, body) {
  const response = await fetch(`/api/sync/${path}`, body === undefined ? { headers: { Accept: "application/json" } }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Sync answered HTTP ${response.status}`);
  return data;
}

function githubSteps(status) {
  const error = status.lastError ? `<p class="settings-sync-error" role="alert">${esc(status.lastError)}</p>` : "";
  if (status.step === "start") {
    return `<p class="settings-sync-note">LVL keeps your tracking list in a repository named <strong>lvl-sync</strong> in your GitHub account, kept private. Other repositories are never used.</p>
      <div class="settings-sync-choices" role="radiogroup" aria-label="Sign-in">
        <label><input type="radio" name="sync-renew" value="1" checked /> Renew the sign-in by itself (it lasts 8 hours at a time; safer)</label>
        <label><input type="radio" name="sync-renew" value="0" /> Stay signed in until I disconnect</label>
      </div>
      <div class="settings-actions">${button("Sign in with GitHub", `data-sync="start"${status.appReady ? "" : " disabled"}`, "primary")}</div>
      ${status.appReady ? "" : `<p class="settings-sync-note">Sign-in with GitHub isn't available in this build yet. Use a token:</p>`}
      <details class="settings-sync-token"${status.appReady ? "" : " open"}><summary>Use a personal access token</summary>
        <ol class="settings-sync-steps"><li>${link(status.newRepoUrl, "Create the repository lvl-sync")} (private; the page is filled in).</li>
        <li>${link("https://github.com/settings/personal-access-tokens/new", "Create a fine-grained token")}: Only select repositories › lvl-sync; Permissions › Contents › Read and write.</li>
        <li>Paste it here.</li></ol>
        <div class="settings-actions"><input type="password" id="sync-token" class="settings-sync-input" autocomplete="off" spellcheck="false" placeholder="github_pat_…" aria-label="GitHub token" />${button("Connect", 'data-sync="token"')}</div>
      </details>${error}`;
  }
  if (status.step === "device") {
    return `<p class="settings-sync-note">Enter this code on GitHub:</p><p class="settings-sync-code" aria-live="polite">${esc(status.device.userCode)}</p>
      <div class="settings-actions">${button("Copy code", 'data-sync="copy"')}<a class="ui-btn ui-btn--primary ui-btn--sm" href="${esc(status.device.verificationUri)}" target="_blank" rel="noopener">Open GitHub</a>${button("Cancel", 'data-sync="cancel"', "ghost")}</div>
      <p class="settings-sync-note">Waiting for GitHub… The code works for ${Math.max(0, Math.round((status.device.expiresAt - Date.now()) / 60000))} more minutes.</p>${error}`;
  }
  if (status.step === "repo") {
    const steps = status.repoMissing
      ? `<ol class="settings-sync-steps"><li>${link(status.newRepoUrl, "Create the repository lvl-sync")} (private; the page is filled in, press Create repository).</li>
         ${status.mode === "token" ? "" : `<li>${status.installUrl ? link(status.installUrl, "Give LVL access to it") : "Give LVL's GitHub App access to it"}: Only select repositories › lvl-sync › Install.</li>`}</ol>`
      : `<p class="settings-sync-note">Looking for lvl-sync…</p>`;
    return `<p class="settings-sync-note">Signed in as <strong>${esc(status.login)}</strong>.${status.repoMissing ? " LVL can't see a repository named lvl-sync yet." : ""}</p>${steps}
      <div class="settings-actions">${button("Check again", 'data-sync="find"')}${button("Disconnect", 'data-sync="disconnect"', "ghost")}</div>${error}`;
  }
  if (status.step === "options") {
    return `<p class="settings-sync-note">Ready. LVL keeps your tracking list in <strong>${esc(status.repo)}</strong> as plain files you can read on GitHub.</p>
      <label class="ui-switch settings-switch-row" for="sync-encrypt">
        <input id="sync-encrypt" type="checkbox" />
        <span class="ui-switch__track" aria-hidden="true"></span>
        <span class="settings-learning-copy"><strong>Encrypt with a passphrase</strong><small>Optional. GitHub then only stores unreadable files.</small></span>
      </label>
      <div class="settings-sync-encrypt" hidden><p class="settings-sync-note">You type the passphrase once on each device. If it's lost, the synced copy can't be read, but every device keeps its own data.</p>
        <div class="settings-actions"><input type="password" id="sync-pass" class="settings-sync-input" autocomplete="new-password" aria-label="Passphrase" placeholder="At least 8 characters" />
        <input type="password" id="sync-pass2" class="settings-sync-input" autocomplete="new-password" aria-label="The same passphrase again" placeholder="Again" /></div></div>
      <div class="settings-actions">${button("Start syncing", 'data-sync="begin"', "primary")}${button("Disconnect", 'data-sync="disconnect"', "ghost")}</div>${error}`;
  }
  if (status.step === "passphrase") {
    return `<p class="settings-sync-note"><strong>${esc(status.repo)}</strong> is encrypted. Enter the passphrase you chose on your other device.</p>
      <div class="settings-actions"><input type="password" id="sync-pass" class="settings-sync-input" autocomplete="off" aria-label="Passphrase" />${button("Join", 'data-sync="pass"', "primary")}</div>${error}`;
  }
  const reload = status.reloadNeeded ? `<p class="settings-sync-note" role="status">Changes from your other devices reached your Library. ${button("Reload LVL", 'data-sync="reload"', "primary")}</p>` : "";
  const problems = status.skippedFiles || status.refused ? ` ${status.skippedFiles ? `${status.skippedFiles} unreadable file${status.skippedFiles === 1 ? "" : "s"} skipped.` : ""}${status.refused ? ` ${status.refused} invalid change${status.refused === 1 ? "" : "s"} ignored.` : ""}` : "";
  return `<p class="settings-sync-note">Syncing with <strong>${esc(status.repo)}</strong>${status.login ? ` as ${esc(status.login)}` : ""}${status.encrypted ? ", encrypted with your passphrase" : ""}. ${status.renew ? "The sign-in renews itself." : "The sign-in lasts until you disconnect."}</p>
    <p class="settings-sync-note" aria-live="polite">${status.syncing ? "Syncing…" : `Last synced ${esc(ago(status.lastSyncAt))}.`} Sent ${status.sent}, received ${status.received}.${problems}</p>
    ${reload}<div class="settings-actions">${button("Sync now", 'data-sync="now"', "primary")}${button("Disconnect", 'data-sync="disconnect"', "ghost")}</div>${error}`;
}

function view(status, choice) {
  const connected = status.step !== "start";
  const picked = connected ? "github" : choice;
  const chips = `<div class="ui-chip-row settings-sync-options" role="group" aria-label="Sync options">${OPTIONS.map((option) =>
    `<button type="button" class="ui-chip" data-sync-option="${option.id}" aria-pressed="${picked === option.id}"${connected && option.id !== "github" ? " disabled" : ""}>${esc(option.label)}${option.ready ? "" : '<span class="ui-chip__count">Soon</span>'}</button>`).join("")}</div>`;
  const body = !picked ? `<p class="settings-sync-note">Keep your Library, watch positions, LVL ratings and comics the same on every device. Choose where LVL keeps the synced copy.</p>`
    : picked === "github" ? githubSteps(status)
    : `<p class="settings-sync-note">${picked === "google" ? "Google Drive: sign in with Google, and LVL keeps the copy in a hidden folder only LVL can see." : "A folder: pick a folder that Syncthing, Google Drive or OneDrive already syncs, and LVL keeps the copy there."} Coming in a later version.</p>`;
  return chips + body;
}

function mount(card) {
  card.dataset.syncMounted = "1";
  const head = card.querySelector(".settings-card__head");
  head?.insertAdjacentHTML("beforeend", '<span class="ui-badge ui-badge--outline settings-sync-badge">Off</span>');
  card.insertAdjacentHTML("beforeend", '<div class="settings-sync-body"></div>');
  const body = card.querySelector(".settings-sync-body");
  const badge = card.querySelector(".settings-sync-badge");
  let status = { step: "start" };
  let choice = localStorage.getItem(CHOICE_KEY) || "";
  let shown = "";
  let timer = 0;
  let finding = false;
  const render = (force = false) => {
    if (!force && body.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    const markup = view(status, choice);
    if (markup === shown) return;
    shown = markup;
    body.innerHTML = markup;
    if (badge) badge.textContent = status.step === "ready" ? "On" : status.step === "start" ? "Off" : "Setting up";
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
    void refresh().finally(() => { timer = window.setTimeout(loop, status.step === "device" || status.syncing ? 2000 : 5000); });
  };
  body.addEventListener("change", (event) => {
    if (event.target.id !== "sync-encrypt") return;
    const fields = body.querySelector(".settings-sync-encrypt");
    if (fields) fields.hidden = !event.target.checked;
  });
  body.addEventListener("click", async (event) => {
    const option = event.target.closest("[data-sync-option]");
    if (option && !option.disabled) {
      choice = option.dataset.syncOption;
      localStorage.setItem(CHOICE_KEY, choice);
      render(true);
      return;
    }
    const target = event.target.closest("[data-sync]");
    if (!target || target.disabled) return;
    const action = target.dataset.sync;
    target.disabled = true;
    try {
      if (action === "start") status = await call("github/start", { renew: body.querySelector('input[name="sync-renew"]:checked')?.value !== "0" });
      else if (action === "cancel") status = await call("github/cancel", {});
      else if (action === "copy") await navigator.clipboard?.writeText(status.device?.userCode || "");
      else if (action === "token") status = await call("github/token", { token: body.querySelector("#sync-token")?.value.trim() });
      else if (action === "find") status = await call("github/find", {});
      else if (action === "begin") {
        const encrypt = Boolean(body.querySelector("#sync-encrypt")?.checked);
        const pass = body.querySelector("#sync-pass")?.value || "";
        if (encrypt && pass !== (body.querySelector("#sync-pass2")?.value || "")) throw new Error("The two passphrases are different");
        status = await call("start", { encrypt, passphrase: encrypt ? pass : "" });
      }
      else if (action === "pass") {
        const pass = body.querySelector("#sync-pass")?.value || "";
        const again = body.querySelector("#sync-pass2");
        if (again && again.value !== pass) throw new Error("The two passphrases are different");
        status = await call("passphrase", { passphrase: pass });
      } else if (action === "now") status = (await call("now", {})).status;
      else if (action === "disconnect") {
        if (window.confirm("Disconnect sync on this device? Your data here stays, and so does the copy in lvl-sync.")) status = await call("disconnect", {});
      } else if (action === "reload") { await call("reload-shown", {}); window.location.reload(); return; }
    } catch (error) {
      status = { ...status, lastError: error.message };
    } finally {
      target.disabled = false;
      render(true);
    }
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
