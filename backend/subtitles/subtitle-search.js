// Searching and downloading subtitles (SubDL, OpenSubtitles, Wyzie, SubSource).
import path from "node:path";
import AdmZip from "adm-zip";
import { searchSubtitles as searchWyzieSubtitles } from "wyzie-lib";
import { assToWebVtt as parseAssToWebVtt } from "../../shared/subtitles/ass-events.js";
import { CINEMETA_ORIGIN, MAX_SUBTITLE_TEXT_BYTES, remoteSubtitleDownloads } from "../../server.js";
import { boundedInteger, fetchUpstreamJson, json, readBoundedResponse, readJsonBody } from "../app/http-helpers.js";
import {
  fetchRemoteSubtitleDownload, getSubdlApiKey, optionalProviderKey, pruneRemoteSubtitleDownloads,
  registerRemoteSubtitleDownload,
} from "./remote-subtitles.js";
import { normalizeCatalogMeta, validateImdbId } from "../catalog/catalog-api.js";

const MAX_SUBTITLE_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MAX_SUBTITLE_FILES = 20;

const SUBDL_API_ORIGIN = "https://api.subdl.com";
const SUBDL_DOWNLOAD_ORIGIN = "https://dl.subdl.com";
const OPENSUBTITLES_STREMIO_ORIGIN = "https://opensubtitles-v3.strem.io";
const SUBSOURCE_API_ORIGIN = "https://api.subsource.net/api/v1";

function buildSubdlSearchParams(body, { queryOverride = "", loose = false } = {}) {
  const query = String(queryOverride || (typeof body.query === "string" ? body.query : "")).trim();
  const language = typeof body.language === "string" ? body.language.trim().toUpperCase() : "";

  if (!query || query.length > 240) {
    const error = new Error("A subtitle title or release query is required");
    error.statusCode = 400;
    throw error;
  }
  if (!language || language.length > 32 || !/^[A-Z,-]+$/.test(language)) {
    const error = new Error("A valid SubDL language code is required");
    error.statusCode = 400;
    throw error;
  }

  const params = new URLSearchParams({
    film_name: query,
    languages: language,
    unpack: "1",
    releases: "1",
    subs_per_page: "30",
  });
  if (!loose) {
    if (body.type === "movie" || body.type === "tv") params.set("type", body.type);
    const season = boundedInteger(body.season, 1, 999);
    const episode = boundedInteger(body.episode, 1, 9999);
    if (season) params.set("season_number", String(season));
    if (episode) params.set("episode_number", String(episode));
  }
  return params;
}

function normalizeSubdlResults(payload, fallbackLanguage) {
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const results = [];

  for (let subtitleIndex = 0; subtitleIndex < subtitles.length && results.length < 60; subtitleIndex += 1) {
    const subtitle = subtitles[subtitleIndex] || {};
    const unpackFiles = Array.isArray(subtitle.unpack_files) && subtitle.unpack_files.length ? subtitle.unpack_files : [null];
    for (let fileIndex = 0; fileIndex < unpackFiles.length && results.length < 60; fileIndex += 1) {
      const file = unpackFiles[fileIndex];
      const resultUrl = file?.url || subtitle.url;
      if (typeof resultUrl !== "string" || !validateSubdlDownloadUrl(resultUrl)) continue;
      const label = file?.name || subtitle.name || subtitle.release_name || `Subtitle ${results.length + 1}`;
      const release = file?.release_name || subtitle.release_name || subtitle.name || "";
      const language = String(file?.language || subtitle.language || fallbackLanguage || "").toUpperCase();
      const extension = path.extname(label).slice(1).toLowerCase();
      results.push({
        id: String(file?.file_n_id || subtitle.n_id || subtitle.id || `${subtitleIndex}-${fileIndex}`),
        provider: "SubDL",
        label,
        language,
        release,
        url: resultUrl,
        format: file?.format || subtitle.format || extension || (resultUrl.toLowerCase().endsWith(".zip") ? "zip" : "srt"),
      });
    }
  }
  return results;
}

export function normalizeSubtitleLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  const map = {
    eng: "EN", spa: "ES", fre: "FR", fra: "FR", ger: "DE", deu: "DE",
    ita: "IT", por: "PT", jpn: "JA", ja: "JA", kor: "KO", ko: "KO",
    chi: "ZH", zho: "ZH", rus: "RU", dut: "NL", nld: "NL", pol: "PL", tur: "TR",
  };
  return map[raw] || raw.slice(0, 2).toUpperCase();
}

async function searchOpenSubtitlesStremio(body) {
  let catalogId = validateImdbId(body.catalogId);
  if (!catalogId && body.query) {
    const catalogType = body.type === "tv" ? "series" : "movie";
    const queries = [body.query, ...(Array.isArray(body.aliases) ? body.aliases : [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 3);
    const normalizeName = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const query of queries) {
      try {
        const endpoint = `${CINEMETA_ORIGIN}/catalog/${catalogType}/top/search=${encodeURIComponent(query)}.json`;
        const payload = await fetchUpstreamJson(endpoint, 8_000);
        const metas = (Array.isArray(payload.metas) ? payload.metas : [])
          .map((meta) => normalizeCatalogMeta(meta, catalogType))
          .filter(Boolean);
        const exact = metas.find((meta) => normalizeName(meta.name) === normalizeName(query));
        catalogId = (exact || metas[0])?.id || null;
        if (catalogId) break;
      } catch {}
    }
  }
  if (!catalogId) return [];
  const season = boundedInteger(body.season, 1, 999);
  const episode = boundedInteger(body.episode, 1, 9999);
  const isSeries = body.type === "tv";
  if (isSeries && (!season || !episode)) return [];
  const videoId = isSeries ? `${catalogId}:${season}:${episode}` : catalogId;
  const addonType = isSeries ? "series" : "movie";
  const upstream = await fetch(`${OPENSUBTITLES_STREMIO_ORIGIN}/subtitles/${addonType}/${videoId}.json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!upstream.ok) return [];
  const payload = await upstream.json().catch(() => null);
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const requestedLanguages = new Set(String(body.language || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
  return subtitles.slice(0, 100).flatMap((subtitle, index) => {
    const url = typeof subtitle?.url === "string" ? subtitle.url : "";
    if (!validateOpenSubtitlesDownloadUrl(url)) return [];
    const language = normalizeSubtitleLanguage(subtitle.lang);
    if (requestedLanguages.size && !requestedLanguages.has(language)) return [];
    const label = String(subtitle.subtitleFileName || subtitle.movieReleaseName || `OpenSubtitles ${index + 1}`).slice(0, 500);
    return [{
      id: String(subtitle.id || `os-${index}`),
      provider: "OpenSubtitles",
      label,
      language,
      release: String(subtitle.movieReleaseName || "").slice(0, 500),
      url,
      format: path.extname(label).slice(1).toLowerCase() || "srt",
      matchedQuery: videoId,
      matchMode: "stremio",
    }];
  });
}

function subtitleLanguageName(code) {
  const map = {
    EN: "english", ES: "spanish", FR: "french", DE: "german", IT: "italian", PT: "portuguese",
    JA: "japanese", KO: "korean", ZH: "chinese", RU: "russian", NL: "dutch", PL: "polish", TR: "turkish",
  };
  return map[normalizeSubtitleLanguage(code)] || "";
}

function normalizeWyzieResults(items) {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (results.length >= 100) break;
    const language = normalizeSubtitleLanguage(item?.language || item?.display || "");
    const sourceName = Array.isArray(item?.source) ? item.source.join(" + ") : String(item?.source || "");
    const label = String(item?.fileName || item?.release || item?.media || `Wyzie subtitle ${results.length + 1}`).slice(0, 500);
    const url = registerRemoteSubtitleDownload({
      url: item?.url,
      label,
      language,
      provider: sourceName ? `Wyzie/${sourceName}` : "Wyzie",
    });
    if (!url || !language) continue;
    results.push({
      id: String(item?.id || `wyzie-${results.length}`),
      provider: sourceName ? `Wyzie - ${sourceName}` : "Wyzie",
      via: "Wyzie",
      label,
      language,
      release: String(item?.release || item?.matchedRelease || "").slice(0, 500),
      url,
      format: String(item?.format || path.extname(label).slice(1) || "srt").toLowerCase(),
      origin: String(item?.origin || "").slice(0, 80),
      matchedRelease: String(item?.matchedRelease || "").slice(0, 500),
      downloads: Number(item?.downloadCount) || 0,
      hearingImpaired: Boolean(item?.isHearingImpaired),
      matchMode: item?.matchedFilter ? `wyzie-${String(item.matchedFilter)}` : "wyzie",
    });
  }
  return results;
}

async function searchWyzie(body) {
  const key = optionalProviderKey(body, "wyzieKey", "WYZIE_API_KEY");
  const imdbId = validateImdbId(body.catalogId);
  if (!key || !imdbId) return [];
  const languages = String(body.language || "").split(",").map((value) => normalizeSubtitleLanguage(value).toLowerCase()).filter(Boolean);
  const season = boundedInteger(body.season, 1, 999);
  const episode = boundedInteger(body.episode, 1, 9999);
  const base = {
    imdb_id: imdbId,
    language: languages,
    key,
    ...(body.type === "tv" && season && episode ? { season, episode } : {}),
  };
  const combined = [];
  const seen = new Set();
  const append = (items) => {
    for (const item of normalizeWyzieResults(items)) {
      const fingerprint = `${item.language}|${item.label}|${item.release}|${item.provider}`.toLowerCase();
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      combined.push(item);
    }
  };
  const releaseQuery = String(body.releaseQuery || "").trim();
  if (releaseQuery) {
    try { append(await searchWyzieSubtitles({ ...base, filename: releaseQuery })); } catch {}
  }
  if (combined.length < 12 || body.forceBroad) {
    append(await searchWyzieSubtitles(base));
  }
  return combined.slice(0, 100);
}

function subSourceEpisodeMatches(item, season, episode) {
  if (!season || !episode) return true;
  const release = [
    ...(Array.isArray(item?.releaseInfo) ? item.releaseInfo : []),
    item?.commentary,
  ].filter(Boolean).join(" ");
  const paddedSeason = String(season).padStart(2, "0");
  const paddedEpisode = String(episode).padStart(2, "0");
  const exact = new RegExp(`(?:S0?${season}E0?${episode}|${season}x0?${episode})`, "i");
  if (exact.test(release)) return true;
  const pack = new RegExp(`(?:S(?:EASON)?[ ._-]*0?${season}|SEASON[ ._-]*${paddedSeason}).*(?:COMPLETE|PACK)|(?:COMPLETE|PACK).*S(?:EASON)?[ ._-]*0?${season}`, "i");
  return pack.test(release) && !new RegExp(`E(?!${paddedEpisode}\b)\d{2,3}`, "i").test(release);
}

async function searchSubSource(body) {
  const key = optionalProviderKey(body, "subsourceKey", "SUBSOURCE_API_KEY");
  if (!key) return [];
  const query = String(body.query || "").trim();
  const imdbId = validateImdbId(body.catalogId);
  if (!query && !imdbId) return [];
  const season = boundedInteger(body.season, 1, 999);
  const episode = boundedInteger(body.episode, 1, 9999);
  const headers = { Accept: "application/json", "X-API-Key": key };
  const fetchMovieItems = async (params) => {
    const response = await fetch(`${SUBSOURCE_API_ORIGIN}/movies/search?${params}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.results) ? payload.results
        : Array.isArray(payload?.found) ? payload.found : [];
  };
  const searchParams = new URLSearchParams(imdbId
    ? { searchType: "imdb", imdb: imdbId }
    : { searchType: "text", q: query });
  if (body.type === "tv" && season) searchParams.set("season", String(season));
  let movieItems = await fetchMovieItems(searchParams);
  if (!movieItems.length && query && imdbId) {
    const fallback = new URLSearchParams({ searchType: "text", q: query });
    if (body.type === "tv" && season) fallback.set("season", String(season));
    movieItems = await fetchMovieItems(fallback);
  }
  if (!movieItems.length) return [];
  const normalizeName = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = normalizeName(query);
  const movie = movieItems.find((item) => normalizeName(item?.title || item?.name) === wanted) || movieItems[0];
  const movieId = Number(movie?.movieId ?? movie?.id);
  if (!Number.isInteger(movieId) || movieId <= 0) return [];

  const requestedLanguages = String(body.language || "").split(",").map((value) => normalizeSubtitleLanguage(value)).filter(Boolean);
  const results = [];
  for (const languageCode of requestedLanguages) {
    const languageName = subtitleLanguageName(languageCode);
    if (!languageName) continue;
    const params = new URLSearchParams({ movieId: String(movieId), language: languageName, sort: "rating", limit: "100" });
    const response = await fetch(`${SUBSOURCE_API_ORIGIN}/subtitles?${params}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) continue;
    const payload = await response.json().catch(() => null);
    const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.results) ? payload.results : [];
    for (const item of items) {
      if (results.length >= 100) break;
      if (body.type === "tv" && !subSourceEpisodeMatches(item, season, episode)) continue;
      const subtitleId = Number(item?.subtitleId ?? item?.id);
      if (!Number.isInteger(subtitleId) || subtitleId <= 0) continue;
      const release = Array.isArray(item?.releaseInfo) ? item.releaseInfo.filter(Boolean).join(" / ") : String(item?.releaseInfo || "");
      const label = String(release || item?.commentary || `SubSource ${subtitleId}`).slice(0, 500);
      const url = registerRemoteSubtitleDownload({
        url: `${SUBSOURCE_API_ORIGIN}/subtitles/${subtitleId}/download`,
        headers: { "X-API-Key": key },
        label: `${label}.zip`,
        language: languageCode,
        provider: "SubSource",
      });
      if (!url) continue;
      results.push({
        id: String(subtitleId),
        provider: "SubSource",
        label,
        language: languageCode,
        release,
        url,
        format: "zip",
        downloads: Number(item?.downloads) || 0,
        hearingImpaired: Boolean(item?.hearingImpaired),
        matchMode: "subsource",
      });
    }
  }
  return results;
}

export async function searchSubtitles(req, res) {
  const body = await readJsonBody(req);
  let apiKey = null;
  try {
    apiKey = getSubdlApiKey(req, body);
  } catch (error) {
    if (error.statusCode !== 401) throw error;
  }
  const rawCandidates = [body.query, ...(Array.isArray(body.aliases) ? body.aliases : []), body.releaseQuery]
    .map((value) => String(value || "").trim())
    .filter((value, index, array) => value && value.length <= 240 && array.indexOf(value) === index)
    .slice(0, 6);
  if (!rawCandidates.length) {
    json(res, 400, { error: "A subtitle title or release query is required" });
    return;
  }

  const run = async (query, loose) => {
    const params = buildSubdlSearchParams(body, { queryOverride: query, loose });
    params.set("api_key", apiKey);
    const upstream = await fetch(`${SUBDL_API_ORIGIN}/api/v1/subtitles?${params}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await upstream.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!upstream.ok) throw Object.assign(new Error(payload?.error || `SubDL search failed with HTTP ${upstream.status}`), { statusCode: upstream.status });
    if (!payload || payload.status === false) throw Object.assign(new Error(payload?.error || "SubDL returned an invalid search response"), { statusCode: 502 });
    return normalizeSubdlResults(payload, body.language);
  };

  const merged = [];
  const seen = new Set();
  const requestedSeason = boundedInteger(body.season, 1, 999);
  const requestedEpisode = boundedInteger(body.episode, 1, 9999);
  const episodeMatchesRequest = (item) => {
    if (body.type !== "tv" || !requestedSeason || !requestedEpisode) return true;
    const text = [item?.label, item?.release, item?.matchedRelease].filter(Boolean).join(" ");
    const matches = [
      ...text.matchAll(/\bS(\d{1,2})E(\d{1,3})\b/ig),
      ...text.matchAll(/\b(\d{1,2})x(\d{1,3})\b/ig),
    ];
    if (matches.length) return matches.some((match) => Number(match[1]) === requestedSeason && Number(match[2]) === requestedEpisode);
    const naturalEpisode = text.match(/\b(?:episode|ep)[ ._-]*(\d{1,3})\b/i);
    if (naturalEpisode) return Number(naturalEpisode[1]) === requestedEpisode;
    return true;
  };
  const append = (items, query, mode) => {
    for (const item of items) {
      if (!episodeMatchesRequest(item)) continue;
      const key = `${item.language}|${item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...item,
        matchedQuery: query,
        matchMode: mode,
        title: String(body.query || "").slice(0, 240),
        season: requestedSeason || null,
        episode: requestedEpisode || null,
      });
      if (merged.length >= 120) break;
    }
  };

  let firstError = null;
  if (apiKey) {
    for (let index = 0; index < rawCandidates.length && merged.length < 60; index += 1) {
      const query = rawCandidates[index];
      try {
        const strict = await run(query, false);
        append(strict, query, "episode");
        if (merged.length >= 20 && !body.forceBroad) break;
        if (!strict.length || body.animeFallback || body.forceBroad) {
          const loose = await run(query, true);
          append(loose, query, "title");
        }
      } catch (error) {
        firstError ||= error;
      }
    }
  }

  try {
    append(await searchOpenSubtitlesStremio(body), body.catalogId || body.query, "stremio");
  } catch (error) {
    firstError ||= error;
  }

  try {
    append(await searchWyzie(body), body.catalogId || body.query, "wyzie");
  } catch (error) {
    firstError ||= error;
  }

  try {
    append(await searchSubSource(body), body.catalogId || body.query, "subsource");
  } catch (error) {
    firstError ||= error;
  }

  if (!merged.length && firstError) {
    json(res, firstError.statusCode || 502, { error: firstError.message });
    return;
  }
  const providers = [
    apiKey ? "SubDL" : null,
    "OpenSubtitles",
    optionalProviderKey(body, "wyzieKey", "WYZIE_API_KEY") ? "Wyzie" : null,
    optionalProviderKey(body, "subsourceKey", "SUBSOURCE_API_KEY") ? "SubSource" : null,
  ].filter(Boolean);
  json(res, 200, { results: merged, queriesTried: rawCandidates, providers });
}

function validateSubdlDownloadUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try {
    url = value.startsWith("/") ? new URL(value, SUBDL_DOWNLOAD_ORIGIN) : new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== SUBDL_DOWNLOAD_ORIGIN || !url.pathname.startsWith("/subtitle/")) return null;
  url.username = "";
  url.password = "";
  return url;
}

function validateOpenSubtitlesDownloadUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || !/^subs\d+\.strem\.io$/i.test(url.hostname)) return null;
  url.username = "";
  url.password = "";
  return url;
}

function assToWebVtt(text) {
  // Respect ASS event formatting and drawing mode; the old token stripper
  // exposed vector coordinates as subtitles and duplicated styled overlays.
  // Preserve visible signs in the default output (classification remains
  // available to future optional sign-vs-dialogue controls).
  return parseAssToWebVtt(text);
}

function subtitleRecord(name, data) {
  const ext = path.extname(name).toLowerCase();
  if (![".srt", ".vtt", ".ass", ".ssa"].includes(ext)) return null;
  if (data.length > MAX_SUBTITLE_TEXT_BYTES) return null;
  if (ext === ".ass" || ext === ".ssa") {
    const converted = assToWebVtt(data.toString("utf8"));
    if (!converted) return null;
    return {
      filename: `${path.basename(name, ext)}.vtt`,
      format: "vtt",
      text: converted,
      convertedFrom: ext.slice(1),
    };
  }
  return {
    filename: path.basename(name),
    format: ext.slice(1),
    text: data.toString("utf8"),
  };
}

function subtitlePreferenceScore(record, label) {
  const preferred = path.basename(String(label || "")).replace(/\.(srt|vtt)$/i, "").toLowerCase();
  if (!preferred) return 0;
  const candidate = record.filename.replace(/\.(srt|vtt)$/i, "").toLowerCase();
  if (candidate === preferred) return 100;
  if (candidate.includes(preferred) || preferred.includes(candidate)) return 50;
  const preferredWords = new Set(preferred.split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  return candidate.split(/[^a-z0-9]+/).filter((word) => preferredWords.has(word)).length;
}

export async function downloadSubtitle(req, res) {
  const body = await readJsonBody(req);
  const remoteMatch = typeof body.url === "string" ? /^remote:([a-f0-9]{36})$/i.exec(body.url) : null;
  if (remoteMatch) {
    pruneRemoteSubtitleDownloads();
    const remote = remoteSubtitleDownloads.get(remoteMatch[1]);
    if (!remote || remote.expiresAt <= Date.now()) {
      json(res, 404, { error: "Subtitle download token expired; search again" });
      return;
    }
    const { response: upstream, finalUrl } = await fetchRemoteSubtitleDownload(remote);
    if (!upstream.ok) {
      json(res, 502, { error: `${remote.provider} download failed with HTTP ${upstream.status}` });
      return;
    }
    const data = await readBoundedResponse(upstream, MAX_SUBTITLE_DOWNLOAD_BYTES);
    const contentType = upstream.headers.get("content-type") || "";
    const pathname = finalUrl.pathname.toLowerCase();
    const isZip = pathname.endsWith(".zip") || contentType.includes("zip") || /\.zip$/i.test(remote.label);
    if (!isZip) {
      let name = String(remote.label || body.label || path.basename(pathname) || "subtitle.srt").slice(0, 255);
      if (!/\.(srt|vtt|ass|ssa)$/i.test(name)) {
        const head = data.toString("utf8", 0, 64).trimStart();
        const extension = head.startsWith("WEBVTT") ? "vtt" : /\[Script Info\]|^Dialogue\s*:/im.test(head) ? "ass" : "srt";
        name = `${name || "subtitle"}.${extension}`;
      }
      const record = subtitleRecord(name, data);
      if (!record) {
        json(res, 415, { error: `${remote.provider} returned an unsupported subtitle file` });
        return;
      }
      json(res, 200, { ...record, language: remote.language, provider: remote.provider });
      return;
    }
    let zip;
    try { zip = new AdmZip(data); } catch {
      json(res, 422, { error: `${remote.provider} returned an invalid ZIP` });
      return;
    }
    const files = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || files.length >= MAX_SUBTITLE_FILES) continue;
      const ext = path.extname(entry.entryName).toLowerCase();
      if (![".srt", ".vtt", ".ass", ".ssa"].includes(ext) || entry.header.size > MAX_SUBTITLE_TEXT_BYTES) continue;
      const record = subtitleRecord(entry.entryName, entry.getData());
      if (record) files.push(record);
    }
    if (!files.length) {
      json(res, 422, { error: `${remote.provider} ZIP contained no supported subtitle files` });
      return;
    }
    files.sort((a, b) => subtitlePreferenceScore(b, body.label || remote.label) - subtitlePreferenceScore(a, body.label || remote.label));
    json(res, 200, { ...files[0], language: remote.language, provider: remote.provider });
    return;
  }
  const openSubtitlesUrl = validateOpenSubtitlesDownloadUrl(body.url);
  const url = openSubtitlesUrl || validateSubdlDownloadUrl(body.url);
  if (!url) {
    json(res, 400, { error: "A valid supported subtitle download URL is required" });
    return;
  }

  if (openSubtitlesUrl) {
    const upstream = await fetch(openSubtitlesUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) {
      json(res, upstream.status, { error: `OpenSubtitles download failed with HTTP ${upstream.status}` });
      return;
    }
    const data = await readBoundedResponse(upstream, MAX_SUBTITLE_DOWNLOAD_BYTES);
    const suppliedName = typeof body.label === "string" ? body.label.slice(0, 255) : "OpenSubtitles.srt";
    const name = /\.(srt|vtt|ass|ssa)$/i.test(suppliedName) ? suppliedName : `${suppliedName || "OpenSubtitles"}.srt`;
    const record = subtitleRecord(name, data);
    if (!record) {
      json(res, 415, { error: "OpenSubtitles returned an unsupported subtitle file" });
      return;
    }
    json(res, 200, record);
    return;
  }

  const apiKey = getSubdlApiKey(req, body);

  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!upstream.ok) {
    json(res, upstream.status, { error: `SubDL download failed with HTTP ${upstream.status}` });
    return;
  }

  const data = await readBoundedResponse(upstream, MAX_SUBTITLE_DOWNLOAD_BYTES);
  const contentType = upstream.headers.get("content-type") || "";
  const pathname = url.pathname.toLowerCase();
  const isZip = pathname.endsWith(".zip") || contentType.includes("zip");

  if (!isZip) {
    const suppliedName = typeof body.label === "string" ? body.label : typeof body.fileName === "string" ? body.fileName : typeof body.name === "string" ? body.name : "";
    let name = suppliedName.slice(0, 255) || path.basename(url.pathname) || "subtitle.srt";
    if (!/\.(srt|vtt|ass|ssa)$/i.test(name)) {
      const extension = data.toString("utf8", 0, 32).trimStart().startsWith("WEBVTT") ? "vtt" : "srt";
      name = `${name || "subtitle"}.${extension}`;
    }
    const record = subtitleRecord(name, data);
    if (!record) {
      json(res, 415, { error: "Downloaded subtitle must be SRT, VTT, ASS, or SSA" });
      return;
    }
    json(res, 200, record);
    return;
  }

  let zip;
  try {
    zip = new AdmZip(data);
  } catch {
    json(res, 422, { error: "Downloaded ZIP is invalid" });
    return;
  }

  const files = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (files.length >= MAX_SUBTITLE_FILES) break;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (![".srt", ".vtt", ".ass", ".ssa"].includes(ext)) continue;
    if (entry.header.size > MAX_SUBTITLE_TEXT_BYTES) continue;
    const record = subtitleRecord(entry.entryName, entry.getData());
    if (record) files.push(record);
  }

  if (!files.length) {
    json(res, 422, { error: "ZIP contained no bounded SRT, VTT, ASS, or SSA files" });
    return;
  }
  files.sort((a, b) => subtitlePreferenceScore(b, body.label) - subtitlePreferenceScore(a, body.label));
  json(res, 200, files[0]);
}
