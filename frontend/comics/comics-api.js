// Comics section: calls to the local /api/comics routes.
const TIMEOUT_MS = 30_000;

async function call(url, { method = "GET", body, timeoutMs = TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload?.error || `Request failed (${response.status})`), { status: response.status });
  return payload;
}

export const comicsApi = Object.freeze({
  home: () => call("/api/comics/home"),
  search: ({ q = "", genre = "", page = 1 } = {}) => call(`/api/comics/search?${new URLSearchParams({ q, genre, page: String(page) })}`),
  browse: (filters = {}) => call(`/api/comics/browse?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== "" && value !== undefined && value !== null).map(([key, value]) => [key, String(value)]))}`),
  work: (id) => call(`/api/comics/work/${encodeURIComponent(id)}`),
  units: (id) => call(`/api/comics/work/${encodeURIComponent(id)}/units`),
  files: (id) => call(`/api/comics/work/${encodeURIComponent(id)}/files`),
  rematch: (id, anilistId) => call(`/api/comics/work/${encodeURIComponent(id)}/match`, { method: "PUT", body: { anilistId } }),
  library: () => call("/api/comics/library"),
  setStatus: (id, status) => call(`/api/comics/library/${encodeURIComponent(id)}`, { method: "PUT", body: { status } }),
  remove: (id) => call(`/api/comics/library/${encodeURIComponent(id)}`, { method: "DELETE" }),
  folders: () => call("/api/comics/folders"),
  addFolder: (folderPath) => call("/api/comics/folders", { method: "POST", body: { path: folderPath } }),
  removeFolder: (folderPath) => call("/api/comics/folders", { method: "DELETE", body: { path: folderPath } }),
  rescan: () => call("/api/comics/folders/rescan", { method: "POST", body: {} }),
  // Settings › Comics › Import from Mihon or Tachiyomi: the file goes as it is.
  async mihonImport(file) {
    const response = await fetch("/api/comics/import/mihon", {
      method: "POST", body: file, signal: AbortSignal.timeout(120_000),
      headers: { Accept: "application/json", "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(String(file?.name || "").slice(0, 120)) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.error || `Request failed (${response.status})`), { status: response.status });
    return payload;
  },
  mihonImportState: () => call("/api/comics/import/mihon"),
  mihonImportApply: () => call("/api/comics/import/mihon/apply", { method: "POST", body: {}, timeoutMs: 180_000 }),
  mihonImportCancel: () => call("/api/comics/import/mihon", { method: "DELETE" }),
  readerFile: (fileId, { workId = "", name = "", describe = false } = {}) => (String(fileId).startsWith("f")
    ? call(`/api/reader/files/${encodeURIComponent(fileId)}`)
    : call(`/api/reader/remote/${encodeURIComponent(fileId)}?${new URLSearchParams({ work: workId, name, ...(describe ? { describe: "1" } : {}) })}`, { timeoutMs: 120_000 })),
  saveProgress: (progress, workId = "") => (String(progress.fileId).startsWith("f")
    ? call("/api/reader/progress", { method: "PUT", body: progress })
    : call("/api/reader/remote-progress", { method: "PUT", body: { id: progress.fileId, workId, page: progress.page, pages: progress.pages, chapter: progress.chapter ?? null, volume: progress.volume ?? null } })),
  sources: () => call("/api/comics/sources"),
  addSource: (source) => call("/api/comics/sources", { method: "POST", body: source }),
  updateSource: (id, patch) => call(`/api/comics/sources/${encodeURIComponent(id)}`, { method: "PUT", body: patch }),
  removeSource: (id) => call(`/api/comics/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  workSources: (id, langs) => call(`/api/comics/work/${encodeURIComponent(id)}/sources?${new URLSearchParams({ langs: langs.join(",") })}`),
  downloads: () => call("/api/comics/downloads"),
  download: (item) => call("/api/comics/downloads", { method: "POST", body: item }),
  cancelDownload: (id) => call(`/api/comics/downloads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  cache: () => call("/api/comics/cache"),
  settings: () => call("/api/comics/settings"),
  saveSettings: (settings) => call("/api/comics/settings", { method: "PUT", body: settings }),
  clearCache: () => call("/api/comics/cache", { method: "DELETE" }),
  linked: (id) => call(`/api/comics/work/${encodeURIComponent(id)}/linked`),
  // Comics on a series or movie page. draft: "1" makes a new draft, "0" never makes one.
  videoComics: (video, { draft = "" } = {}) => call(`/api/comics/video/${encodeURIComponent(video.id)}?${new URLSearchParams({ type: video.type, title: video.title, ...(draft ? { draft } : {}) })}`),
  hideVideoComic: (video, body) => call(`/api/comics/video/${encodeURIComponent(video.id)}/hide?${new URLSearchParams({ type: video.type, title: video.title })}`, { method: "POST", body }),
  link: (id, source) => call(`/api/comics/work/${encodeURIComponent(id)}/linked`, { method: "POST", body: source }),
  unlink: (id, key) => call(`/api/comics/work/${encodeURIComponent(id)}/linked?${new URLSearchParams({ key })}`, { method: "DELETE" }),
  availability: (id, langs) => call(`/api/comics/work/${encodeURIComponent(id)}/availability?${new URLSearchParams({ langs: langs.join(",") })}`, { timeoutMs: 120_000 }),
  candidates: (id, chapter, volume, langs) => call(`/api/comics/work/${encodeURIComponent(id)}/chapter?${new URLSearchParams({ chapter, volume: volume || "", langs: langs.join(",") })}`, { timeoutMs: 120_000 }),
  read: (id) => call(`/api/comics/work/${encodeURIComponent(id)}/read`),
  extensionIndex: (params = {}) => call(`/api/comics/extensions/index?${new URLSearchParams(params)}`),
  favorites: () => call("/api/comics/ext/favorites"),
  setFavorite: (sourceId, favorite) => call("/api/comics/ext/favorites", { method: "POST", body: { sourceId, favorite } }),
  verifyState: () => call("/api/comics/ext/check", { timeoutMs: 8000 }),
  saveSiteSettings: (sourceId, settings) => call("/api/comics/ext/settings", { method: "POST", body: { sourceId, settings } }),
  extSearch: (id, sourceId) => call(`/api/comics/work/${encodeURIComponent(id)}/ext-search?${new URLSearchParams({ source: sourceId })}`, { timeoutMs: 120_000 }),
  openSourceCheck: (sourceId) => call("/api/comics/ext/check", { method: "POST", body: { sourceId } }),
  extPreview: (id, sourceId, path) => call(`/api/comics/work/${encodeURIComponent(id)}/ext-preview?${new URLSearchParams({ source: sourceId, path })}`, { timeoutMs: 120_000 }),
});

export const pageUrl = (fileId, page) => (String(fileId).startsWith("f")
  ? `/api/reader/files/${encodeURIComponent(fileId)}/pages/${Number(page) || 0}`
  : `/api/reader/remote/${encodeURIComponent(fileId)}/pages/${Number(page) || 0}`);
