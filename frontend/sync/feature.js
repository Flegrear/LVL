// Settings › Sync: connect a private GitHub repository and see the sync status. The server
// does the work (backend/sync); this tab shows the current step and polls while it is open.
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const ago = (ms) => {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return new Date(ms).toLocaleString();
};

async function call(path, body) {
  const response = await fetch(`/api/sync/${path}`, body === undefined
    ? { headers: { Accept: "application/json" } }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Sync answered HTTP ${response.status}`);
  return data;
}

const button = (label, attrs = "", variant = "secondary") => `<button type="button" class="ui-btn ui-btn--${variant} ui-btn--sm" ${attrs}><span>${esc(label)}</span></button>`;

function view(status, repos) {
  const intro = `<p class="settings-sync-intro">Keep your Library, watch positions, LVL ratings and comics the same on your devices, through a private GitHub repository. LVL encrypts everything with your passphrase before it leaves this device.</p>`;
  const error = status.lastError ? `<p class="settings-sync-error" role="alert">${esc(status.lastError)}</p>` : "";
  if (status.step === "start") {
    const tokenHelp = `<details class="settings-sync-token"${status.appReady ? "" : " open"}><summary>Use a personal access token instead</summary>
      <ol><li>Create a private repository (${status.newRepoUrl ? `<a href="${esc(status.newRepoUrl)}" target="_blank" rel="noopener">open GitHub's page, already filled in</a>` : "on GitHub"}).</li>
      <li>Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>: Repository access › Only select repositories › that repository; Permissions › Contents › Read and write.</li>
      <li>Paste it here.</li></ol>
      <div class="settings-sync-row"><input type="password" id="sync-token" autocomplete="off" spellcheck="false" placeholder="github_pat_…" aria-label="GitHub token" />${button("Connect", 'data-sync="token"')}</div></details>`;
    return `${intro}<fieldset class="settings-sync-renew"><legend>Sign-in</legend>
      <label><input type="radio" name="sync-renew" value="1" checked /> Renew it automatically (it lasts 8 hours at a time, then renews; safer)</label>
      <label><input type="radio" name="sync-renew" value="0" /> Stay signed in until I disconnect</label></fieldset>
      <div class="settings-sync-row">${button("Sign in with GitHub", `data-sync="start"${status.appReady ? "" : " disabled"}`, "primary")}</div>
      ${status.appReady ? "" : `<p class="settings-sync-note">LVL's GitHub App isn't registered in this build yet, so sign-in with GitHub is off. The token works the same.</p>`}
      ${tokenHelp}${error}`;
  }
  if (status.step === "device") {
    return `<p>Enter this code on GitHub to let LVL sync:</p>
      <p class="settings-sync-code" aria-live="polite">${esc(status.device.userCode)}</p>
      <div class="settings-sync-row">${button("Copy code", 'data-sync="copy"')}<a class="ui-btn ui-btn--primary ui-btn--sm" href="${esc(status.device.verificationUri)}" target="_blank" rel="noopener"><span>Open github.com/login/device</span></a>${button("Cancel", 'data-sync="cancel"')}</div>
      <p class="settings-sync-note">Waiting for GitHub… The code works for ${Math.max(0, Math.round((status.device.expiresAt - Date.now()) / 60000))} more minutes.</p>${error}`;
  }
  if (status.step === "repo") {
    const list = repos === null ? `<p class="settings-sync-note">Looking for repositories…</p>`
      : repos.length ? `<ul class="settings-sync-repos">${repos.map((repo) => `<li>${button(`${repo.owner}/${repo.name}${repo.private ? "" : " (public!)"}`, `data-sync="repo" data-owner="${esc(repo.owner)}" data-name="${esc(repo.name)}"`)}</li>`).join("")}</ul>`
      : `<p class="settings-sync-note">LVL can't see a repository yet.</p>`;
    const steps = status.mode === "token" ? "" : `<ol><li><a href="${esc(status.newRepoUrl)}" target="_blank" rel="noopener">Create a private repository</a> (the page is filled in; press Create repository).</li>
      <li>${status.installUrl ? `<a href="${esc(status.installUrl)}" target="_blank" rel="noopener">Give LVL access to it</a>: choose Only select repositories, pick it, press Install.` : "Give LVL's GitHub App access to it."}</li>
      <li>Come back and press Refresh.</li></ol>`;
    return `<p>Signed in as <strong>${esc(status.login)}</strong>. Choose the repository LVL syncs to.</p>${list}${steps}
      <div class="settings-sync-row">${button("Refresh", 'data-sync="repos"')}${button("Disconnect", 'data-sync="disconnect"')}</div>${error}`;
  }
  if (status.step === "passphrase") {
    return status.joining
      ? `<p><strong>${esc(status.repo)}</strong> already has LVL sync. Enter the passphrase you chose on your other device.</p>
        <div class="settings-sync-row"><input type="password" id="sync-pass" autocomplete="off" aria-label="Passphrase" />${button("Join", 'data-sync="pass"', "primary")}</div>${error}`
      : `<p>Choose a passphrase for <strong>${esc(status.repo)}</strong>. You type it once on each device. If it's lost, the synced copy can't be read; every device still keeps its own data.</p>
        <div class="settings-sync-row"><input type="password" id="sync-pass" autocomplete="new-password" aria-label="Passphrase" placeholder="At least 8 characters" />
        <input type="password" id="sync-pass2" autocomplete="new-password" aria-label="The same passphrase again" placeholder="Again" />${button("Start syncing", 'data-sync="pass"', "primary")}</div>${error}`;
  }
  const reload = status.reloadNeeded ? `<p class="settings-sync-reload" role="status">Changes from your other devices reached your Library. ${button("Reload LVL", 'data-sync="reload"', "primary")}</p>` : "";
  return `<p>Syncing with <strong>${esc(status.repo)}</strong>${status.login ? ` as ${esc(status.login)}` : ""}. ${status.renew ? "The sign-in renews itself." : "The sign-in lasts until you disconnect."}</p>
    <p class="settings-sync-state" aria-live="polite">${status.syncing ? "Syncing…" : `Last synced ${esc(ago(status.lastSyncAt))}.`} Sent ${status.sent}, received ${status.received}.</p>
    ${reload}<div class="settings-sync-row">${button("Sync now", 'data-sync="now"', "primary")}${button("Disconnect", 'data-sync="disconnect"')}</div>${error}`;
}

function mount(panel) {
  panel.innerHTML = `<section class="settings-card settings-sync"><div class="settings-card__head"><h2>Sync</h2></div><div class="settings-sync-body"><p class="settings-sync-note">Loading…</p></div></section>`;
  const body = panel.querySelector(".settings-sync-body");
  let status = null;
  let repos = null;
  let shownKey = "";
  let timer = 0;
  const render = () => {
    const key = JSON.stringify([status, repos, Math.floor(Date.now() / 30000)]);
    if (key === shownKey || body.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    shownKey = key;
    body.innerHTML = view(status, repos);
  };
  const refresh = async () => {
    try { status = await call("status"); } catch (error) { status = { ...(status || { step: "start" }), lastError: error.message }; }
    if (status.step === "repo" && repos === null) repos = await call("github/repos").then((data) => data.repos).catch(() => []);
    if (status.step !== "repo") repos = null;
    render();
  };
  const loop = () => {
    window.clearTimeout(timer);
    if (!panel.isConnected) return;
    void refresh().finally(() => { timer = window.setTimeout(loop, status?.step === "device" || status?.syncing ? 2000 : 5000); });
  };
  body.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-sync]");
    if (!target || target.disabled) return;
    const action = target.dataset.sync;
    target.disabled = true;
    try {
      if (action === "start") status = await call("github/start", { renew: body.querySelector('input[name="sync-renew"]:checked')?.value !== "0" });
      else if (action === "cancel") status = await call("github/cancel", {});
      else if (action === "copy") await navigator.clipboard?.writeText(status.device.userCode);
      else if (action === "token") status = await call("github/token", { token: body.querySelector("#sync-token")?.value.trim() });
      else if (action === "repos") { repos = null; render(); repos = (await call("github/repos")).repos; }
      else if (action === "repo") status = await call("github/repo", { owner: target.dataset.owner, name: target.dataset.name });
      else if (action === "pass") {
        const pass = body.querySelector("#sync-pass")?.value || "";
        const again = body.querySelector("#sync-pass2");
        if (again && again.value !== pass) throw new Error("The two passphrases are different");
        status = await call("passphrase", { passphrase: pass });
      } else if (action === "now") status = (await call("now", {})).status;
      else if (action === "disconnect") { if (window.confirm("Disconnect sync on this device? Your data here stays; the repository keeps the synced copy.")) status = await call("disconnect", {}); }
      else if (action === "reload") { await call("reload-shown", {}); window.location.reload(); return; }
    } catch (error) {
      status = { ...(status || { step: "start" }), lastError: error.message };
    } finally {
      target.disabled = false;
      shownKey = "";
      render();
    }
  });
  loop();
}

export const syncFeature = {
  id: "sync",
  settingsTabs: [{ id: "sync", label: "Sync", render(panel) { mount(panel); } }],
  styles: ["/frontend/sync/sync.css"],
};
