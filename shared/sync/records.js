// What LVL syncs between devices, as small records ("changes"):
//   { type: "video.progress", id: "<infohash>/3", at: "<clock stamp>", schema: 1, value: {...} }
// value null removes the item. For each type and id, the change with the newest stamp wins.
// A change is refused (counted, never applied) when its shape, id or stamp is wrong, when its
// stamp is more than a day ahead of this device's clock (it would win over every later change),
// or when a field the type requires is missing or of the wrong kind. Other wrong fields are dropped.
//
// Changing the format later (this file is the only place to edit):
// - Adding a field: list it in the type's fields. Older LVL versions don't know it, keep it
//   untouched when they write the item again (unlisted fields are carried over), and ignore it.
//   Never add a field to an existing type's required list; that needs a new schema.
// - Renaming a field or changing its meaning: raise the type's schema and add an upgrade step
//   from the old schema. Older changes are upgraded when read. An older LVL that reads a newer
//   schema keeps the change and passes it on, but doesn't apply it ("update LVL to sync it").
// - A new type: add it here. Older LVL versions keep and pass on types they don't know.
// - The file layout and encryption have their own version (SYNC_FORMAT_VERSION, in lvl-sync.json).
import { DEVICE_ID, MAX_AHEAD_MS, compareStamps, parseStamp } from "./clock.js";

export const SYNC_FORMAT = "lvl-sync";
export const SYNC_FORMAT_VERSION = 1;
const TYPE_NAME = /^[a-z][a-z0-9-]{1,30}(?:\.[a-z][a-z0-9-]{1,30}){0,2}$/;
const MAX_ID = 600;
const MAX_VALUE_BYTES = 64 * 1024;

// Composite ids: each part is URI-encoded and parts are joined with "/".
export const joinId = (...parts) => parts.map((part) => encodeURIComponent(String(part))).join("/");
export const splitId = (id) => String(id).split("/").map((part) => decodeURIComponent(part));

// Field kinds: "string" (up to 2000 characters), "text" (up to 20000), "number", "boolean",
// "list" (up to 1000 items), "object". [kind, { min, max }] narrows numbers.
const CHECKS = {
  string: (value) => typeof value === "string" && value.length <= 2000,
  text: (value) => typeof value === "string" && value.length <= 20000,
  number: (value, { min = -Infinity, max = Infinity } = {}) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max,
  boolean: (value) => typeof value === "boolean",
  list: (value) => Array.isArray(value) && value.length <= 1000,
  object: (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
};
const fraction = ["number", { min: 0, max: 1 }];
const count = ["number", { min: 0, max: 1e9 }];
const time = ["number", { min: 0, max: 1e15 }];
const anyId = /^[^\u0000-\u001f\u007f]{1,600}$/;
const anilistWork = /^anilist-\d{1,10}$/;

// schema: the current version of each type's value. upgrades[n]: value at schema n -> n + 1.
export const RECORD_TYPES = Object.freeze({
  // A video title in the Library (series or movie) and where it plays from. id: the Library
  // entry id (the torrent's infohash).
  "video.title": { schema: 1, id: /^[0-9a-f]{40}$/, fields: {
    title: "string", displayTitle: "string", seriesKey: "string", magnet: "text", coverUrl: "string",
    catalogId: "string", catalogType: "string", aliases: "list", sourceMeta: "object", addedAt: time, episodes: "list" } },
  // Where you are in one file of a title. id: "<infohash>/<file index>".
  "video.progress": { schema: 1, id: /^[0-9a-f]{40}\/\d{1,6}$/, required: ["positionMs", "durationMs", "finished"], fields: {
    positionMs: count, durationMs: count, finished: "boolean" } },
  // Episodes marked watched or unwatched by hand. id: "<series key>/<code, like S01E02>".
  "video.watched": { schema: 1, id: anyId, required: ["watched"], fields: { watched: "boolean" } },
  // Your tracking status of a series (CURRENT, PLANNING, COMPLETED…). id: the series key.
  "video.status": { schema: 1, id: anyId, fields: { status: "string", automatic: "boolean" } },
  // A comic in Library › Comics. id: "anilist-<id>".
  "comic.library": { schema: 1, id: anilistWork, required: ["status"], fields: { status: "string", title: "string", work: "object" } },
  // A source linked to a comic. id: joinId(work, kind, source id, the source's manga path).
  "comic.source": { schema: 1, id: anyId, fields: { name: "string", title: "string", lang: "string", pkg: "string" } },
  // Reading progress in a chapter from a source. id: joinId(source id, chapter path).
  "comic.read": { schema: 1, id: anyId, fields: { page: count, pages: count, finished: "boolean", workId: "string" } },
  // A comic volume rating (LVL Manga). id: joinId(work, volume).
  "comic.rating": { schema: 1, id: anyId, fields: { score: ["number", { min: 0, max: 10 }] } },
  // An LVL rating of a title or season. id: the ratings key.
  "rating.lvl": { schema: 1, id: anyId, fields: {
    score: ["number", { min: 0, max: 10 }], title: "string", kind: "string", year: "number",
    catalogId: "string", seriesKey: "string", season: "number", status: "string" } },
  // Settings that make sense on every device (subtitle style, languages…). id: the setting.
  "settings.shared": { schema: 1, id: /^[a-z][a-z0-9.-]{1,60}$/, fields: { value: "object" } },
  // Books. Their ids must not depend on one device: a work is its catalog key (like the
  // Books lane's work_key), and a file is identified by a fingerprint of its contents
  // (the same EPUB on two devices), never by a local file number.
  "book.library": { schema: 1, id: anyId, fields: {
    status: "string", edition: "object", note: "text", progressPages: count, progressPercent: ["number", { min: 0, max: 100 }],
    source: "string", title: "string" } },
  // Position in one book file. id: joinId(work key, file fingerprint). location is the
  // format's own position (EPUB CFI, PDF page); fraction lets another file of the same work
  // open at about the same place.
  "book.progress": { schema: 1, id: anyId, fields: {
    location: "string", fraction, page: count, pages: count, label: "string", finished: "boolean", format: "string" } },
  // One read of a book, with dates (rereads keep their history). id: a random id per read.
  "book.read": { schema: 1, id: anyId, fields: {
    workKey: "string", startedAt: "string", finishedAt: "string", status: "string",
    progressPages: count, progressPercent: ["number", { min: 0, max: 100 }] } },
  "book.rating": { schema: 1, id: anyId, fields: { score: ["number", { min: 0, max: 10 }] } },
  // A shelf (id: a random id) and a book on it (id: joinId(shelf, work key)).
  "book.shelf": { schema: 1, id: anyId, fields: { name: "string" } },
  "book.shelf-item": { schema: 1, id: anyId, fields: { addedAt: time } },
  // A bookmark. id: joinId(work key, file fingerprint, location).
  "book.bookmark": { schema: 1, id: anyId, fields: { label: "string", fraction } },
});

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const byteSize = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

export function createRegistry(types = RECORD_TYPES, { now = Date.now } = {}) {
  for (const [name, type] of Object.entries(types)) {
    if (!TYPE_NAME.test(name) || !Number.isInteger(type.schema) || type.schema < 1) throw new Error(`Invalid sync type ${name}`);
    for (let from = 1; from < type.schema; from += 1)
      if (typeof type.upgrades?.[from] !== "function") throw new Error(`${name}: no upgrade from schema ${from}`);
  }

  // Listed fields are checked (a wrong one is dropped); unlisted fields are kept as they are.
  function clean(type, value) {
    const out = {};
    for (const [key, field] of Object.entries(value)) {
      const rule = type.fields[key];
      if (!rule) { out[key] = field; continue; }
      const [kind, limits] = Array.isArray(rule) ? rule : [rule];
      if (field !== undefined && field !== null && CHECKS[kind](field, limits)) out[key] = field;
    }
    return out;
  }

  // A change read from a sync file: status "ok" (apply it), "newer" (a newer LVL wrote it:
  // keep and pass on, don't apply), "unknown" (a type this LVL doesn't have: same) or "invalid".
  function read(raw) {
    if (!isPlainObject(raw) || typeof raw.type !== "string" || !TYPE_NAME.test(raw.type)) return { status: "invalid", reason: "not a change" };
    if (typeof raw.id !== "string" || !raw.id || raw.id.length > MAX_ID || /[\u0000-\u001f\u007f]/.test(raw.id)) return { status: "invalid", reason: "bad id" };
    const stamp = parseStamp(raw.at);
    if (!stamp || !DEVICE_ID.test(stamp.device)) return { status: "invalid", reason: "bad stamp" };
    if (stamp.ms > now() + MAX_AHEAD_MS) return { status: "invalid", reason: "stamp in the future" };
    if (!Number.isInteger(raw.schema) || raw.schema < 1) return { status: "invalid", reason: "bad schema" };
    if (raw.value !== null && !isPlainObject(raw.value)) return { status: "invalid", reason: "bad value" };
    if (raw.value !== null && byteSize(raw.value) > MAX_VALUE_BYTES) return { status: "invalid", reason: "value too large" };
    const change = { type: raw.type, id: raw.id, at: raw.at, schema: raw.schema, value: raw.value };
    const type = types[raw.type];
    if (!type) return { status: "unknown", change };
    if (!type.id.test(raw.id)) return { status: "invalid", reason: `bad ${raw.type} id` };
    if (raw.schema > type.schema) return { status: "newer", change };
    let value = raw.value;
    for (let from = raw.schema; value !== null && from < type.schema; from += 1) value = type.upgrades[from](value);
    const cleaned = value === null ? null : clean(type, value);
    const missing = cleaned && (type.required || []).find((field) => !(field in cleaned));
    if (missing) return { status: "invalid", reason: `bad or missing ${missing}` };
    return { status: "ok", change: { ...change, schema: type.schema, value: cleaned } };
  }

  // A change made on this device. previous: the current change for the same item, if any;
  // fields it has that this LVL doesn't list (from a newer LVL) are kept in the new value.
  function make({ type: name, id, value, at, previous = null }) {
    const type = types[name];
    if (!type) throw new Error(`Unknown sync type ${name}`);
    if (typeof id !== "string" || !type.id.test(id) || id.length > MAX_ID) throw new Error(`Invalid ${name} id: ${String(id).slice(0, 80)}`);
    if (!parseStamp(at)) throw new Error("A change needs a clock stamp");
    if (value !== null && !isPlainObject(value)) throw new Error(`A ${name} value must be an object or null`);
    let next = value === null ? null : clean(type, value);
    if (next && isPlainObject(previous?.value)) {
      for (const [key, field] of Object.entries(previous.value)) if (!(key in type.fields) && !(key in next)) next[key] = field;
    }
    if (next && byteSize(next) > MAX_VALUE_BYTES) throw new Error(`The ${name} value is too large to sync`);
    return { type: name, id, at, schema: type.schema, value: next };
  }

  // Merges changes into state (a Map of "type id" -> change). Returns the "ok" changes that
  // became current, which the app applies. Others are kept so they are passed on.
  function merge(state, raws) {
    const applied = [];
    for (const raw of raws) {
      const result = read(raw);
      if (result.status === "invalid") continue;
      const key = `${result.change.type} ${result.change.id}`;
      const current = state.get(key);
      if (current && compareStamps(result.change.at, current.at) <= 0) continue;
      state.set(key, result.change);
      if (result.status === "ok") applied.push(result.change);
    }
    return applied;
  }

  return { types, read, make, merge, clean: (name, value) => clean(types[name], value) };
}

export const records = createRegistry();
