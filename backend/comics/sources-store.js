// Comic sources. Presets ship on and can be turned off or
// removed (a removed preset stays removed). Users add Torznab indexers and
// Mihon extension repositories. Secrets (API keys) are never sent back.
// Reading sources are the extensions of the repositories (ext-sources.js).

export const KEIYOUSHI_REPO = "https://raw.githubusercontent.com/keiyoushi/extensions/repo";
export const PRESETS = Object.freeze([
  { id: "keiyoushi", kind: "mihon-repo", name: "Keiyoushi extensions", config: { url: KEIYOUSHI_REPO } },
  { id: "piratebay-comics", kind: "piratebay", name: "The Pirate Bay (Comics)", config: { category: 602 } },
]);
// Presets from earlier versions that are no longer sources.
const RETIRED = ["mangadex", "suwayomi"];

export function safeHttpUrl(value, { allowHttp = true } = {}) {
  try {
    const url = new URL(String(value || "").trim());
    if (!(url.protocol === "https:" || (allowHttp && url.protocol === "http:")) || url.username || url.password) return "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function createSourcesStore({ db, now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS comic_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    preset INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}', added_at INTEGER NOT NULL)`);
  const insert = db.prepare("INSERT OR IGNORE INTO comic_sources (id, kind, name, enabled, preset, config_json, added_at) VALUES (?, ?, ?, 1, ?, ?, ?)");
  for (const preset of PRESETS) insert.run(preset.id, preset.kind, preset.name, 1, JSON.stringify(preset.config), now());
  db.prepare(`DELETE FROM comic_sources WHERE preset = 1 AND id IN (${RETIRED.map(() => "?").join(", ")})`).run(...RETIRED);
  const all = db.prepare("SELECT * FROM comic_sources WHERE removed = 0 ORDER BY preset DESC, added_at");
  const one = db.prepare("SELECT * FROM comic_sources WHERE id = ? AND removed = 0");
  const update = db.prepare("UPDATE comic_sources SET enabled = ?, name = ?, config_json = ? WHERE id = ?");
  const remove = db.prepare("UPDATE comic_sources SET removed = 1, enabled = 0 WHERE id = ?");
  const parse = (text) => { try { return JSON.parse(text) || {}; } catch { return {}; } };
  const row = (r) => (r ? { id: r.id, kind: r.kind, name: r.name, enabled: Boolean(r.enabled), preset: Boolean(r.preset), config: parse(r.config_json), addedAt: r.added_at } : null);
  // What the browser sees: no secrets.
  const publicView = (source) => source && ({ ...source, config: { ...source.config, apiKey: source.config.apiKey ? "set" : "" } });

  function cleanConfig(kind, input = {}, previous = {}) {
    if (kind === "torznab") {
      const url = safeHttpUrl(input.url ?? previous.url);
      if (!url) throw new Error("Enter the Torznab URL from Prowlarr or Jackett");
      const apiKey = input.apiKey === undefined || input.apiKey === "set" ? previous.apiKey || "" : String(input.apiKey).trim().slice(0, 200);
      return { url, apiKey, category: 7030 };
    }
    if (kind === "mihon-repo") {
      const url = safeHttpUrl(input.url ?? previous.url, { allowHttp: false });
      if (!url) throw new Error("Enter the repository's https:// address");
      return { url };
    }
    return { ...previous };
  }

  return {
    list: () => all.all().map(row),
    publicList: () => all.all().map(row).map(publicView),
    get: (id) => row(one.get(String(id))),
    publicView,
    enabled: (kind) => all.all().map(row).filter((source) => source.enabled && (!kind || source.kind === kind)),
    add({ kind, name, ...config }) {
      if (!["torznab", "mihon-repo"].includes(kind)) throw new Error("Only Torznab indexers and extension repositories can be added");
      const clean = cleanConfig(kind, config);
      const id = `${kind}-${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const label = String(name || "").trim().slice(0, 80) || (kind === "torznab" ? "Torznab" : new URL(clean.url).host);
      db.prepare("INSERT INTO comic_sources (id, kind, name, enabled, preset, config_json, added_at) VALUES (?, ?, ?, 1, 0, ?, ?)").run(id, kind, label, JSON.stringify(clean), now());
      return row(one.get(id));
    },
    update(id, patch = {}) {
      const current = row(one.get(String(id)));
      if (!current) return null;
      const config = patch.config ? cleanConfig(current.kind, patch.config, current.config) : current.config;
      const enabled = patch.enabled === undefined ? current.enabled : Boolean(patch.enabled);
      const name = patch.name ? String(patch.name).trim().slice(0, 80) : current.name;
      update.run(enabled ? 1 : 0, name, JSON.stringify(config), current.id);
      return row(one.get(current.id));
    },
    remove: (id) => remove.run(String(id)).changes > 0,
  };
}
