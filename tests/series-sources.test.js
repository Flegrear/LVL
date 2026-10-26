import test from "node:test";
import assert from "node:assert/strict";
import {
  absoluteEpisodeNumber,
  chapterCode,
  chapterFileIndex,
  chapterPlayOrder,
  chapterWatchStatus,
  classifyChapterSource,
  groupChapterSources,
  libraryFileScope,
  packChapterMap,
  parseReleaseName,
} from "../shared/media/series-sources.js";

test("chapter watched status merges multiple sources and chooses the newest partial resume", () => {
  const refs = [
    { episode: { progress: { durationMs: 100000, positionMs: 20000, updatedAt: 1, finished: false } } },
    { episode: { progress: { durationMs: 100000, positionMs: 60000, updatedAt: 3, finished: false } } },
  ];
  assert.deepEqual(chapterWatchStatus(refs), { watched: false, percent: 60, resume: refs[1].episode.progress, saved: true });
  refs.push({ episode: { progress: { durationMs: 100000, positionMs: 96000, finished: true } } });
  assert.equal(chapterWatchStatus(refs).watched, true);
  assert.equal(chapterWatchStatus(refs).percent, 100);
  assert.equal(chapterWatchStatus([]).saved, false);
});

const STATS = "\u{1F464} 27 \u{1F4BE} 5.64 GB \u2699\uFE0F Provider";
const source = (name, { file = "", peers = 10, fileIdx = 2, quality } = {}) => ({
  title: [name, file, STATS].filter(Boolean).join("\n"),
  filename: file,
  peers,
  fileIdx,
  quality,
});
const S1E3 = { season: 1, episode: 3, absoluteEpisode: 3 };

test("chapter codes and absolute numbers follow the catalog's seasons", () => {
  assert.equal(chapterCode(1, 5), "S01E05");
  assert.equal(chapterCode(12, 148), "S12E148");
  const seasons = [{ season: 0, count: 2 }, { season: 1, count: 58 }, { season: 2, count: 78 }];
  assert.equal(absoluteEpisodeNumber(seasons, 1, 5), 5);
  assert.equal(absoluteEpisodeNumber(seasons, 2, 1), 59, "season 2 continues after season 1");
  assert.equal(absoluteEpisodeNumber(seasons, 0, 1), null, "specials have no absolute number");
  assert.equal(absoluteEpisodeNumber(null, 1, 1), 1);
});

test("release names are read as one chapter, a range, a season, several seasons or the whole series", () => {
  assert.deepEqual(parseReleaseName("Show.Name.S01E03.1080p.WEB-DL.x264-GRP"), { single: { season: 1, episode: 3 }, range: null, scope: null });
  assert.deepEqual(parseReleaseName("Show.Name.S01E001.mkv").single, { season: 1, episode: 1 });
  assert.deepEqual(parseReleaseName("[Group] Show Name - 059 [1080p].mkv").single, { episode: 59 });
  assert.deepEqual(parseReleaseName("Show.Name.S01E03E04.1080p").range, [3, 4]);
  assert.equal(parseReleaseName("Show Name S01 2008 2160P Upscaled").scope, "season");
  assert.equal(parseReleaseName("Show Name S01-S05 Complete 720p").scope, "multi-season");
  assert.equal(parseReleaseName("Show Name Season 1 2 3 4 5 360p").scope, "multi-season");
  assert.equal(parseReleaseName("Show Name (Complete Series + Movies) [BD 1080p]").scope, "series");
  assert.equal(parseReleaseName("Show Name 2008 - 1ª Temporada Completa [4k]").scope, "season");
  assert.equal(parseReleaseName("Шоу / Show Name / Сезон: 1-5 / Серии: 1-62 из 62 [BDRip]").scope, "multi-season", "season words in other scripts");
  assert.deepEqual(parseReleaseName("[Group] Show Name (01-148) [1080p] (Batch)").range, [1, 148]);
});

test("each provider result is an episode file or a pack for the requested chapter", () => {
  const cases = [
    [source("Show.Name.S01E03.The.Title.2160p.WEB-DL.H265-GRP", { fileIdx: 0 }), "episode", true, "EPISODE FILE"],
    [source("Show.Name.S01E01-07.1080p.WEB-DL", { file: "Show.Name.S01E03.Title.1080p.mkv" }), "pack", false, "EPISODES 01–07"],
    [source("Show.Name.S01.1080p.BluRay.x265-GRP", { file: "Show.Name.S01E03.1080p.mkv" }), "pack", false, "SEASON PACK"],
    [source("Show Name S01-S05 Complete 720p BluRay", { file: "S01/Show.Name.S01E03.mkv" }), "pack", false, "MULTI-SEASON PACK"],
    [source("Show Name (Complete Series + Movies) [BD 1080p]", { file: "Show Name - S01E003.mkv" }), "pack", false, "COMPLETE SERIES PACK"],
    [source("[Group] Show Name - 01 ~ 148 [1080p]", { file: "[Group] Show Name - 003 [1080p].mkv" }), "pack", false, "EPISODES 01–148"],
    [source("Шоу / Show Name / Сезон: 1 / Серии 1-7 (7) [BDRip]", { file: "Show Name S01E03 BDRip.mkv" }), "pack", false, "EPISODES 01–07"],
    [source("Show Name Full 1080p", { file: "Show.Name.S01/Show.Name.S01E03.1080p.mkv" }), "pack", false, "PACK"],
    [source("[Group] Show Name - 003 [1080p].mkv", { fileIdx: null }), "episode", true, "EPISODE FILE"],
  ];
  for (const [stream, kind, exact, label] of cases) {
    const info = classifyChapterSource(stream, S1E3);
    const name = stream.title.split("\n")[0];
    assert.equal(info.kind, kind, `${name} kind`);
    assert.equal(info.exact, exact, `${name} exact`);
    assert.equal(info.label, label, `${name} label`);
    assert.equal(info.playable, true, `${name} playable`);
  }
  const absolute = classifyChapterSource(source("[Group] Show Name - 059 [1080p].mkv", { fileIdx: null }), { season: 2, episode: 1, absoluteEpisode: 59 });
  assert.deepEqual([absolute.kind, absolute.exact], ["episode", true], "anime releases count chapters across seasons");
  const renamed = classifyChapterSource(source("Show.Name.S01E01.1080p.WEB", { file: "Show.Name.S01E03.1080p.mkv" }), S1E3);
  assert.equal(renamed.kind, "pack", "named after another chapter but holding this one: a pack");
  assert.equal(classifyChapterSource(source("Show Name Ep_3_4_5 [site].rar", { fileIdx: null }), S1E3).playable, false, "archives can't be played");
});

test("grouping puts single-episode files first, packs second and doubtful matches last", () => {
  const exactFile = source("Show.Name.S01E03.720p.HDTV", { peers: 4, fileIdx: 0 });
  const wrongChapter = source("Show.Name.S01E04.1080p.WEB", { peers: 90, fileIdx: 0 });
  const bigPack = source("Show.Name.S01.1080p.BluRay", { file: "Show.Name.S01E03.mkv", peers: 900 });
  const smallPack = source("Show Name S01-S05 720p", { file: "Show.Name.S01E03.mkv", peers: 12 });
  const doubtful = source("(Unrelated) Some Book 第03", { peers: 60, fileIdx: null });
  const archive = source("Show Name Ep_3 [site].rar", { peers: 500, fileIdx: null });
  const groups = groupChapterSources([bigPack, doubtful, archive, wrongChapter, smallPack, exactFile, null, "x"], S1E3);
  assert.deepEqual(groups.episodeFiles.map((stream) => stream.peers), [4], "another explicit chapter is not presented as a valid single-episode source");
  assert.deepEqual(groups.packs.map((stream) => stream.peers), [900, 12]);
  assert.deepEqual(groups.others.map((stream) => stream.peers), [60]);
  assert.equal(groups.unplayable, 1);
  assert.equal(groups.nonmatching, 1);
  assert.equal(groups.episodeFiles[0].chapterSource.exact, true);
});

test("Play tries healthy single-episode files, then healthy packs, then the rest", () => {
  const groups = {
    episodeFiles: [{ id: "e-thin", peers: 2 }, { id: "e-good", peers: 30 }],
    packs: [{ id: "p-busy", peers: 900 }, { id: "p-thin", peers: 3 }],
    others: [{ id: "o", peers: 70 }],
  };
  assert.deepEqual(chapterPlayOrder(groups).map((stream) => stream.id), ["e-good", "p-busy", "e-thin", "p-thin"]);
  assert.deepEqual(chapterPlayOrder(groups, { limit: 9 }).map((stream) => stream.id), ["e-good", "p-busy", "e-thin", "p-thin", "o"]);
  assert.deepEqual(chapterPlayOrder({ episodeFiles: [], packs: [{ id: "only", peers: 1 }], others: [] }).map((stream) => stream.id), ["only"]);
  assert.deepEqual(chapterPlayOrder(null), []);
});

test("Library entries from a pack keep only the picked chapters", () => {
  assert.deepEqual(libraryFileScope(null, [3]), [3], "a new entry holds the picked file");
  assert.equal(libraryFileScope(null, null), null, "a new entry with nothing picked holds every video (manual magnets)");
  assert.equal(libraryFileScope(null, [-1, "x", 2.5]), null);
  assert.deepEqual(libraryFileScope({ chapterFileIndexes: [3] }, [5, 3]), [3, 5], "picking another chapter adds it");
  assert.deepEqual(libraryFileScope({ chapterFileIndexes: [3] }, null), [3], "replaying keeps the scope");
  assert.equal(libraryFileScope({ id: "legacy" }, [5]), null, "older entries that hold a whole torrent stay whole");
});

test("the chapter's file is found in a resolved torrent when the provider gave no index", () => {
  const files = [
    { index: 0, name: "Show.Name.S01E02.mkv", video: true },
    { index: 1, name: "Show.Name.S01E03.mkv", video: true },
    { index: 2, name: "Show.Name.S01E03.nfo", video: false },
    { index: 3, name: "Extras/[Group] Show Name - 059 [1080p].mkv", video: true },
  ];
  assert.equal(chapterFileIndex(files, S1E3), 1);
  assert.equal(chapterFileIndex(files, { season: 2, episode: 1, absoluteEpisode: 59 }), 3);
  assert.equal(chapterFileIndex([{ index: 4, name: "movie.mkv", video: true }, { index: 5, name: "info.txt", video: false }], S1E3), 4, "a single video is the chapter");
  assert.equal(chapterFileIndex([...files, { index: 6, name: "Show.Name.S01E03.REPACK.mkv", video: true }], S1E3), null, "two candidates: can't tell");
  assert.equal(chapterFileIndex([], S1E3), null);
});


test("packChapterMap places every chapter of a multi-season pack and skips extras and other shows", () => {
  const root = "[EMBER] Slime (2019-2021) (Season 1+2+OVA+Specials) & The Slime Diaries";
  const files = [];
  let index = 0;
  for (let episode = 1; episode <= 24; episode += 1) files.push({ index: index++, video: true, path: `${root}/Season 1/[EMBER] Tensei Shitara Slime Datta Ken - ${String(episode).padStart(2, "0")}.mkv` });
  for (let episode = 1; episode <= 24; episode += 1) files.push({ index: index++, video: true, path: `${root}/Season 2/[EMBER] Tensei Shitara Slime Datta Ken 2nd Season - ${String(episode).padStart(2, "0")}.mkv` });
  files.push({ index: index++, video: true, path: `${root}/OVA/[EMBER] Tensei Shitara Slime Datta Ken OVA - 01.mkv` });
  for (let episode = 1; episode <= 12; episode += 1) files.push({ index: index++, video: true, path: `${root}/The Slime Diaries/[EMBER] Tensura Nikki - ${String(episode).padStart(2, "0")}.mkv` });
  files.push({ index: index++, video: false, path: `${root}/Season 1/readme.txt` });
  const map = packChapterMap(files, [{ season: 1, count: 24 }, { season: 2, count: 24 }]);
  assert.equal(map.size, 48);
  assert.deepEqual(map.get(0), { season: 1, episode: 1 });
  assert.deepEqual(map.get(23), { season: 1, episode: 24 });
  assert.deepEqual(map.get(24), { season: 2, episode: 1 });
  assert.deepEqual(map.get(47), { season: 2, episode: 24 });
  assert.equal(map.has(48), false, "OVA folder is an extra");
  for (let diaries = 49; diaries < 61; diaries += 1) assert.equal(map.has(diaries), false, "another show loses its collisions");
});

test("packChapterMap reads SxxEyy names and absolute numbering across seasons", () => {
  const sxe = packChapterMap([
    { index: 0, video: true, path: "Show.S01.1080p/Show.S01E01.1080p.mkv" },
    { index: 1, video: true, path: "Show.S01.1080p/Show.S01E02.1080p.mkv" },
    { index: 2, video: true, path: "Show.S01.1080p/Show.S01E99.1080p.mkv" },
  ], [{ season: 1, count: 10 }]);
  assert.deepEqual([...sxe.keys()], [0, 1], "an episode the catalog doesn't list is left out");
  const absolute = packChapterMap([
    { index: 4, video: true, path: "Anime Batch/[Group] Anime - 12.mkv" },
    { index: 5, video: true, path: "Anime Batch/[Group] Anime - 13.mkv" },
    { index: 6, video: true, path: "Anime Batch/[Group] Anime - 26.mkv" },
    { index: 7, video: true, path: "Anime Batch/Extras/[Group] Anime NCOP.mkv" },
  ], [{ season: 1, count: 12 }, { season: 2, count: 14 }]);
  assert.deepEqual(absolute.get(4), { season: 1, episode: 12 });
  assert.deepEqual(absolute.get(5), { season: 2, episode: 1 });
  assert.deepEqual(absolute.get(6), { season: 2, episode: 14 });
  assert.equal(absolute.has(7), false);
  assert.equal(packChapterMap([{ index: 0, video: true, name: "Single.Episode.S02E03.mkv" }], [{ season: 2, count: 8 }]).get(0).episode, 3);
});
