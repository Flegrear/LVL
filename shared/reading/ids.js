// Id formats for comics, shared by the server and the browser.
// A comic: "anilist-<AniList id>" or "local-<12 hex>" (local files, or a comic read
// from sources only). A chapter read from an extension source: "ex-<20 hex>". A
// source: its extension's signed 64-bit id.
export const WORK_ID = /^(?:anilist-[1-9]\d{0,9}|local-[0-9a-f]{12})$/;
export const EXT_CHAPTER_ID = /^ex-[0-9a-f]{20}$/;
export const SOURCE_ID = /^-?\d{1,20}$/;
