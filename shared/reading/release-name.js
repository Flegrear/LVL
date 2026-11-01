// Series, volume and chapter from comic release names, e.g.
//   "Jujutsu Kaisen v01 (2019) (Digital) (1r0n).cbz" → { series: "Jujutsu Kaisen", volume: "1" }
//   "[Group] Vagabond - c001 [v2].cbz"               → { series: "Vagabond", chapter: "1" }
//   "One Piece v01-15.zip"                            → { series: "One Piece", volume: "1", volumeEnd: "15" }
//   "Volume 05" (a folder of images)                  → { volume: "5" }
// A bare trailing number ("Berserk 041") is read as a volume, as packs usually are.
import { normalizeUnitNumber } from "./units.js";

const ARCHIVE = /\.(?:cbz|zip|cbr|rar|cb7|7z|pdf|epub)$/i;
const NUM = "(\\d{1,5}(?:\\.\\d{1,2})?)";
const VOLUME = new RegExp(`(?:^|[\\s_.\\-(\\[])(?:v|vol|volume|tome|t)\\.?\\s*${NUM}(?:\\s*[-~]\\s*(?:v|vol\\.?\\s*)?${NUM})?(?=$|[\\s_.\\-)\\]])`, "i");
const CHAPTER = new RegExp(`(?:^|[\\s_.\\-(\\[])(?:c|ch|chap|chapter|ep|episode|#)\\.?\\s*${NUM}(?:\\s*[-~]\\s*(?:c|ch\\.?\\s*)?${NUM})?(?=$|[\\s_.\\-)\\]])`, "i");
const BARE = new RegExp(`(?:^|[\\s_\\-])${NUM}(?:\\s*[-~]\\s*${NUM})?\\s*$`);

export function cleanReleaseName(name) {
  return String(name || "")
    .replace(ARCHIVE, "")
    .replace(/_/g, " ")
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/\((?:\d{4}|digital|f|c2c|[^)]*(?:scan|rip|group|edition)[^)]*)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseReleaseName(name) {
  const text = cleanReleaseName(name);
  const result = { series: "", volume: null, volumeEnd: null, chapter: null, chapterEnd: null };
  let cut = text.length;
  const volume = VOLUME.exec(text);
  if (volume) {
    result.volume = normalizeUnitNumber(volume[1]);
    result.volumeEnd = normalizeUnitNumber(volume[2]);
    cut = Math.min(cut, volume.index);
  }
  const chapter = CHAPTER.exec(text);
  if (chapter) {
    result.chapter = normalizeUnitNumber(chapter[1]);
    result.chapterEnd = normalizeUnitNumber(chapter[2]);
    cut = Math.min(cut, chapter.index);
  }
  if (!volume && !chapter) {
    const bare = BARE.exec(text.replace(/\(\d{4}\)\s*$/, "").trim());
    if (bare && !/^\d{4}$/.test(bare[1])) {
      result.volume = normalizeUnitNumber(bare[1]);
      result.volumeEnd = normalizeUnitNumber(bare[2]);
      cut = Math.min(cut, bare.index);
    }
  }
  result.series = text.slice(0, cut).replace(/[\s\-–—:,.]+$/, "").trim();
  return result;
}

// Lower-case, accents and punctuation removed: for comparing titles and keys.
export function normalizeSeriesName(value) {
  return String(value || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
