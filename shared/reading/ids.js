// Id formats for comics, shared by the server and the browser.
// A comic: "anilist-<AniList id>" or "local-<12 hex>" (local files, or a comic read
// from sources only). A chapter read from an extension source: "ex-<20 hex>". A
// source: its extension's signed 64-bit id.
export const WORK_ID = /^(?:anilist-[1-9]\d{0,9}|local-[0-9a-f]{12})$/;
export const EXT_CHAPTER_ID = /^ex-[0-9a-f]{20}$/;
export const SOURCE_ID = /^-?\d{1,20}$/;

// The existing sync schema limits the encoded record ID to 600 characters.
// A provider's path is opaque: never case-fold, normalize or truncate it.
export const COMIC_SYNC_ID_MAX = 600;
export const SOURCE_TITLE_KEY = /^(?:video:tt\d{5,12}#\d{1,4}|mihon:-?\d{1,20}:\/.{1,500})$/;
// Public LVL face730 can *apply* a comic.library only when the Mihon path
// section has at most 280 characters. Its sync registry still preserves
// longer records; do not invent a shortened provider URL to make them apply.
export const LEGACY_SOURCE_TITLE_KEY = /^(?:video:tt\d{5,12}#\d{1,4}|mihon:-?\d{1,20}:\/.{1,280})$/;
export const isLegacyComicSourceTitleKey = (key) => typeof key === "string"
  && LEGACY_SOURCE_TITLE_KEY.test(key);
export const isComicSourcePath = (value) => typeof value === "string" && value.length <= 500
  && /^\/(?!\/)[^\s\\]*$/.test(value) && !/(^|\/)\.\.(\/|$)/.test(value)
  && !value.includes("\uFFFD");
const encodedLength = (parts) => {
  try { return parts.map((part) => encodeURIComponent(part)).join("/").length; }
  catch { return Infinity; }
};
export const isSyncableComicLink = (workId, sourceId, mangaPath) =>
  WORK_ID.test(workId) && SOURCE_ID.test(sourceId) && isComicSourcePath(mangaPath)
  && encodedLength([workId, "ext", sourceId, mangaPath]) <= COMIC_SYNC_ID_MAX;
export const isSyncableComicRead = (workId, sourceId, chapterPath) =>
  WORK_ID.test(workId) && SOURCE_ID.test(sourceId) && isComicSourcePath(chapterPath)
  && encodedLength([workId, sourceId, chapterPath]) <= COMIC_SYNC_ID_MAX;
export function isSyncableSourceTitleKey(value) {
  if (typeof value !== "string" || !SOURCE_TITLE_KEY.test(value)) return false;
  if (value.startsWith("video:")) return true;
  const match = /^mihon:(-?\d{1,20}):(\/.*)$/.exec(value);
  // The longest work ID has 18 characters, including the local- prefix.
  return Boolean(match && isSyncableComicLink("local-000000000000", match[1], match[2]));
}
