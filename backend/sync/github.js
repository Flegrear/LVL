// GitHub for sync: sign-in with GitHub's device flow (the user approves a short code at
// github.com/login/device; no secret is needed), the repositories LVL may use, and one
// repository (kept private) as sync storage (shared/sync/log.js):
//   list  -> one request (the branch's file tree), read -> the file's blob, write -> a commit.
// Renewal (the user's choice at setup): asking for "offline_access" gives a token that lasts
// 8 hours and renews itself with a refresh token (unused for 6 months, it ends); without it
// the token lasts until the user disconnects or revokes it.
const API = "https://api.github.com";
const LOGIN = "https://github.com/login";
const TIMEOUT_MS = 20_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's tree with no files

// status: GitHub's HTTP status. github: true tells LVL's own routes it was GitHub that answered.
export function githubError(message, status, code = "") {
  return Object.assign(new Error(message), { status, code, github: true });
}

export function createGitHub({ fetchImpl = fetch, api = API, login = LOGIN, userAgent = "LVL" } = {}) {
  async function form(url, body) {
    const response = await fetchImpl(url, {
      method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": userAgent },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw githubError(data.error_description || `GitHub answered HTTP ${response.status}`, response.status, data.error || "");
    return data;
  }

  async function call(token, method, path, { body, etag } = {}) {
    const response = await fetchImpl(`${api}${path}`, {
      method, signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": userAgent,
        Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(etag ? { "If-None-Match": etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 304) return { notModified: true, etag };
    const data = await response.json().catch(() => ({}));
    if (response.ok) return { data, etag: response.headers.get("etag") || "", link: response.headers.get("link") || "" };
    const remaining = response.headers.get("x-ratelimit-remaining");
    if ((response.status === 403 || response.status === 429) && (remaining === "0" || response.headers.get("retry-after")))
      throw githubError("GitHub's request limit is reached; LVL tries again later", response.status, "rate-limited");
    if (response.status === 401) throw githubError("The GitHub sign-in ended", 401, "signed-out");
    throw githubError(data.message || `GitHub answered HTTP ${response.status}`, response.status, response.status === 404 ? "not-found" : "");
  }

  const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

  async function allPages(token, path, field = null) {
    const entries = [];
    for (let page = 1; page <= 100; page += 1) {
      const { data, link } = await call(token, "GET", `${path}${page > 1 ? `&page=${page}` : ""}`);
      const items = field ? data?.[field] : data;
      if (!Array.isArray(items)) throw githubError("GitHub returned an unreadable repository list", 502, "invalid-list");
      entries.push(...items);
      if (!/rel="next"/.test(link)) return entries;
    }
    throw githubError("GitHub's repository list is too long to search", 502, "too-many-pages");
  }

  return {
    // Step 1 of the device flow: a code for the user to enter at github.com/login/device.
    startDevice: ({ clientId, renew }) => form(`${login}/device/code`, { client_id: clientId, ...(renew ? { scope: "offline_access" } : {}) }),
    // Step 2, every `interval` seconds: { access_token, refresh_token?, expires_in? } or { error }.
    pollDevice: ({ clientId, deviceCode }) => form(`${login}/oauth/access_token`,
      { client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    refresh: ({ clientId, refreshToken }) => form(`${login}/oauth/access_token`,
      { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
    user: async (token) => (await call(token, "GET", "/user")).data,
    // The repositories this sign-in may use: through LVL's GitHub App installations, or, for
    // a personal access token, the ones the token can see.
    async repositories(token, { app = true } = {}) {
      if (!app) {
        return (await allPages(token, "/user/repos?per_page=100&sort=updated")).map(repoOf);
      }
      const installations = await allPages(token, "/user/installations?per_page=100", "installations");
      const repos = [];
      for (const installation of installations) {
        const page = await allPages(token, `/user/installations/${installation.id}/repositories?per_page=100`, "repositories");
        repos.push(...page.map(repoOf));
      }
      return repos;
    },
    // A repository as sync storage. token(): the current token (it may renew between calls).
    storage({ token, owner, repo }) {
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      let branch = "";
      const branchName = async () => branch || (branch = (await call(token(), "GET", base)).data.default_branch || "main");
      // After every file is deleted the branch points at git's empty tree, which the trees API answers with 404.
      const emptyBranch = async () => {
        try { return (await call(token(), "GET", `${base}/branches/${encodeURIComponent(await branchName())}`)).data?.commit?.commit?.tree?.sha === EMPTY_TREE; } catch { return false; }
      };
      let headTag = "";
      let headSeen = null;
      return {
        // The branch's newest commit, as the storage's version: one small request, and when it
        // didn't change since the last call GitHub answers 304, which costs no request quota.
        async head() {
          let answer;
          try { answer = await call(token(), "GET", `${base}/git/ref/heads/${encodeURIComponent(await branchName())}`, { etag: headTag }); } catch (error) {
            // A new, empty repository has no branch yet.
            if (error.status === 409 || error.status === 404) return { version: "" };
            throw error;
          }
          if (answer.notModified && headSeen !== null) return { version: headSeen };
          headTag = answer.etag || "";
          headSeen = String(answer.data?.object?.sha || "");
          return { version: headSeen };
        },
        async list() {
          let tree;
          try { tree = (await call(token(), "GET", `${base}/git/trees/${encodeURIComponent(await branchName())}?recursive=1`)).data; } catch (error) {
            // A new, empty repository has no tree yet.
            if (error.status === 409 || (error.status === 404 && /empty|branch/i.test(error.message))) return [];
            if (error.status === 404 && (await emptyBranch())) return [];
            if (error.status === 404) throw githubError(`LVL can't see ${owner}/${repo} on GitHub any more (removed, renamed, or no longer shared with LVL)`, 404, "not-found");
            throw error;
          }
          if (tree.truncated) throw githubError("The sync repository has too many files to list", 500, "too-large");
          return (tree.tree || []).filter((item) => item.type === "blob").map((item) => ({ path: item.path, version: item.sha }));
        },
        async read(path, version) {
          const { data } = await call(token(), "GET", `${base}/git/blobs/${encodeURIComponent(version)}`);
          return Buffer.from(String(data.content || ""), data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
        },
        async write(path, text, { version } = {}) {
          try {
            const { data } = await call(token(), "PUT", `${base}/contents/${encodePath(path)}`, {
              body: { message: `LVL sync: ${path}`, content: Buffer.from(text, "utf8").toString("base64"), ...(version ? { sha: version } : {}) },
            });
            return data.content?.sha || "";
          } catch (error) {
            if (error.status === 409 || error.status === 422) throw githubError(`${path} changed on GitHub`, error.status, "conflict");
            throw error;
          }
        },
      };
    },
  };
}

const repoOf = (repo) => ({ owner: repo.owner?.login || "", name: repo.name || "", private: Boolean(repo.private), fullName: repo.full_name || "" });
