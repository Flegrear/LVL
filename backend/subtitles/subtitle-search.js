// Searching and downloading subtitles (SubDL, OpenSubtitles, Wyzie, SubSource).
import path from "node:path";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";
import { assToWebVtt as parseAssToWebVtt } from "../../shared/subtitles/ass-events.js";
import { CINEMETA_ORIGIN, MAX_SUBTITLE_TEXT_BYTES, remoteSubtitleDownloads } from "../../server.js";
import { boundedInteger, json, readBoundedResponse, readJsonBody } from "../app/http-helpers.js";
import { createPinnedFetch } from "../network/pinned-fetch.js";
import {
  fetchRemoteSubtitleDownload, getSubdlApiKey, optionalProviderKey, pruneRemoteSubtitleDownloads,
  registerRemoteSubtitleDownload,
} from "./remote-subtitles.js";
import { validateImdbId } from "../catalog/catalog-api.js";
import { wyzieItemIdentity } from "./wyzie-identity.js";

const MAX_SUBTITLE_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MAX_SUBTITLE_FILES = 20;
const MAX_SUBTITLE_ZIP_ENTRIES = 256;

const SUBDL_API_ORIGIN = "https://api.subdl.com";
const SUBDL_DOWNLOAD_ORIGIN = "https://dl.subdl.com";
const OPENSUBTITLES_STREMIO_ORIGIN = "https://opensubtitles-v3.strem.io";
const SUBSOURCE_API_ORIGIN = "https://api.subsource.net/api/v1";
// The pinned wyzie-lib 2.5.2 source offers baseUrl/key configuration but no
// transport or AbortSignal injection. Reproduce its documented /search query
// contract over our bounded, pinned provider transport instead of global fetch.
const WYZIE_ORIGIN = "https://sub.wyzie.io";

// Every provider request must pin the *actual socket* lookup, not just resolve
// DNS before a later global fetch. This transport intentionally does NOT
// follow redirects: an API key or Authorization header may never be replayed
// to a Location chosen by the remote server. Known download hosts are still
// independently checked by their existing validators below.
const pinnedProviderTransport = createPinnedFetch();
// server.js statically imports the subtitle routes, while this module reads
// its exported Cinemeta origin. Constructing the allowlist during ESM module
// evaluation would access that binding before server.js initializes it.
// Resolve it only when a request is checked, after server initialization.
// This retains the exact same origins and the pinned, no-redirect transport.
let providerOrigins = null;
function approvedProviderOrigins() {
  if (!providerOrigins) providerOrigins = new Set([
    CINEMETA_ORIGIN, SUBDL_API_ORIGIN, SUBDL_DOWNLOAD_ORIGIN,
    OPENSUBTITLES_STREMIO_ORIGIN, SUBSOURCE_API_ORIGIN, WYZIE_ORIGIN,
  ].map((origin) => new URL(origin).origin));
  return providerOrigins;
}
const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;

export function subtitleProviderRequestTarget(input) {
  let url;
  try { url = new URL(input); } catch {
    throw Object.assign(new Error("Invalid subtitle provider URL"), { statusCode: 502 });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !(approvedProviderOrigins().has(url.origin) || /^subs\d+\.strem\.io$/i.test(url.hostname)))
    throw Object.assign(new Error("Unapproved subtitle provider origin"), { statusCode: 502 });
  return url;
}

async function fetchSubtitleProvider(input, options = {}) {
  const url = subtitleProviderRequestTarget(input);
  // createPinnedFetch owns DNS/IP verification at Node's request lookup.
  // It exposes the 30x response; there is no automatic follow or credential
  // forwarding, including for the SubDL query-key compatibility path.
  return pinnedProviderTransport(url, { ...options, redirect: "manual" });
}

async function boundedProviderJson(response) {
  const bytes = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
  try { return JSON.parse(bytes.toString("utf8")); } catch { return null; }
}

const providerSignal = (signal, timeoutMs) => signal
  ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
  : AbortSignal.timeout(timeoutMs);

async function fetchSubtitleProviderJson(url, timeoutMs = 8_000, signal = null) {
  const response = await fetchSubtitleProvider(url, {
    headers: { Accept: "application/json" }, signal: providerSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("Subtitle metadata provider is unavailable"), { statusCode: 502 });
  }
  const payload = await boundedProviderJson(response);
  if (!payload) throw Object.assign(new Error("Subtitle metadata response is invalid"), { statusCode: 502 });
  return payload;
}

function providerUrlKey(provider, value) {
  // The URL is a provider-issued source locator, never a local remote:<token>
  // or mutable display label. Keep stable query selectors (e.g. file/id) so
  // two downloads at the same path cannot be conflated. Exclude signed
  // short-lived credentials, which are not item identities.
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:key|api[_-]?key|token|access[_-]?token|auth|authorization|signature|sig|expires?|expiry|timestamp|ts|policy)$/i.test(key))
      url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return `${provider}:url:${createHash("sha256").update(url.href).digest("hex")}`;
}

export async function searchPinnedWyzieSubtitles(params, { fetchImpl = fetchSubtitleProvider, signal = AbortSignal.timeout(10_000) } = {}) {
  if (!validateImdbId(params?.imdb_id)) throw Object.assign(new Error("A verified IMDb identifier is required"), { statusCode: 400 });
  const query = new URLSearchParams({ id: params.imdb_id, key: String(params.key || "") });
  if (Array.isArray(params.language) && params.language.length) query.set("language", params.language.join(","));
  if (params.season !== undefined && params.episode !== undefined) {
    query.set("season", String(params.season));
    query.set("episode", String(params.episode));
  }
  if (params.filename) query.set("filename", String(params.filename));
  const response = await fetchImpl(`${WYZIE_ORIGIN}/search?${query}`, {
    headers: { Accept: "application/json" }, signal, redirect: "manual",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`Wyzie subtitle search failed with HTTP ${response.status}`), { statusCode: 502 });
  }
  const result = await boundedProviderJson(response);
  if (!Array.isArray(result)) throw Object.assign(new Error("Wyzie returned invalid subtitle search data"), { statusCode: 502 });
  return result.slice(0, 100);
}

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
      const language = normalizeSubtitleLanguage(file?.language || subtitle.language || fallbackLanguage);
      const extension = path.extname(label).slice(1).toLowerCase();
      const upstreamId = String(file?.file_n_id ?? subtitle.n_id ?? subtitle.id ?? "").trim();
      const locator = providerUrlKey("subdl", resultUrl);
      results.push({
        id: upstreamId || locator,
        canonicalKey: `subdl:${upstreamId || "unidentified"}:${locator}`,
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
    english: "EN", spanish: "ES", french: "FR", german: "DE", italian: "IT",
    portuguese: "PT", japanese: "JA", korean: "KO", chinese: "ZH", russian: "RU",
    dutch: "NL", polish: "PL", turkish: "TR",
  };
  return map[raw] || raw.slice(0, 2).toUpperCase();
}

async function searchOpenSubtitlesStremio(body, signal = null) {
  // A title or a unique normalized Cinemeta hit is only a suggestion, never
  // authority to select a different program's IMDb ID. The caller must supply
  // the source-associated ID; without one, leave this provider unresolved.
  const catalogId = validateImdbId(body.catalogId);
  if (!catalogId) return [];
  const season = boundedInteger(body.season, 1, 999);
  const episode = boundedInteger(body.episode, 1, 9999);
  const isSeries = body.type === "tv";
  if (isSeries && (!season || !episode)) return [];
  const videoId = isSeries ? `${catalogId}:${season}:${episode}` : catalogId;
  const addonType = isSeries ? "series" : "movie";
  const upstream = await fetchSubtitleProvider(`${OPENSUBTITLES_STREMIO_ORIGIN}/subtitles/${addonType}/${videoId}.json`, {
    headers: { Accept: "application/json" },
    signal: providerSignal(signal, 10_000),
  });
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    return [];
  }
  const payload = await boundedProviderJson(upstream);
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const requestedLanguages = new Set(String(body.language || "").split(",").map(normalizeSubtitleLanguage).filter(Boolean));
  return subtitles.slice(0, 100).flatMap((subtitle, index) => {
    const url = typeof subtitle?.url === "string" ? subtitle.url : "";
    if (!validateOpenSubtitlesDownloadUrl(url)) return [];
    const language = normalizeSubtitleLanguage(subtitle.lang);
    if (requestedLanguages.size && !requestedLanguages.has(language)) return [];
    const label = String(subtitle.subtitleFileName || subtitle.movieReleaseName || `OpenSubtitles ${index + 1}`).slice(0, 500);
    return [{
      id: String(subtitle.id || providerUrlKey("opensubtitles", url)),
      canonicalKey: `opensubtitles:${subtitle.id || providerUrlKey("opensubtitles", url)}:${providerUrlKey("opensubtitles", url)}`,
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
    const canonicalKey = wyzieItemIdentity(item);
    if (!canonicalKey) continue;
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
      id: canonicalKey,
      canonicalKey,
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

async function searchWyzie(body, signal = null) {
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
      const fingerprint = item.canonicalKey;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      combined.push(item);
    }
  };
  const releaseQuery = String(body.releaseQuery || "").trim();
  if (releaseQuery) {
    try { append(await searchPinnedWyzieSubtitles({ ...base, filename: releaseQuery }, { signal: providerSignal(signal, 10_000) })); } catch {}
  }
  if (signal?.aborted) return combined;
  if (combined.length < 12 || body.forceBroad) {
    try { append(await searchPinnedWyzieSubtitles(base, { signal: providerSignal(signal, 10_000) })); }
    catch (error) {
      // A release-filtered search may already have returned valid matches.
      // Failure of the optional broader fallback cannot erase those tokens.
      if (!combined.length) throw error;
    }
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
  const exact = new RegExp(`\\b(?:S0?${season}E0?${episode}|${season}x0?${episode})(?!\\d)`, "i");
  if (exact.test(release)) return true;
  const pack = new RegExp(`(?:S(?:EASON)?[ ._-]*0?${season}|SEASON[ ._-]*${paddedSeason}).*(?:COMPLETE|PACK)|(?:COMPLETE|PACK).*S(?:EASON)?[ ._-]*0?${season}`, "i");
  // Escape backslash expressions inside template literals. The old code
  // interpreted \\b as a backspace and \\d as the letter d.
  return pack.test(release) && !new RegExp(`\\bE(?!0?${episode}(?!\\d))\\d{1,4}\\b`, "i").test(release);
}

async function searchSubSource(body, signal = null) {
  const key = optionalProviderKey(body, "subsourceKey", "SUBSOURCE_API_KEY");
  if (!key) return [];
  const query = String(body.query || "").trim();
  const imdbId = validateImdbId(body.catalogId);
  // A free-text title search may show suggestions in a dedicated discovery UI;
  // it cannot authenticate SubSource movieId for fetching an episode track.
  if (!imdbId) return [];
  const season = boundedInteger(body.season, 1, 999);
  const episode = boundedInteger(body.episode, 1, 9999);
  const headers = { Accept: "application/json", "X-API-Key": key };
  const fetchMovieItems = async (params) => {
    const response = await fetchSubtitleProvider(`${SUBSOURCE_API_ORIGIN}/movies/search?${params}`, {
      headers,
      signal: providerSignal(signal, 10_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return [];
    }
    const payload = await boundedProviderJson(response);
    return Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.results) ? payload.results
        : Array.isArray(payload?.found) ? payload.found : [];
  };
  const searchParams = new URLSearchParams({ searchType: "imdb", imdb: imdbId });
  if (body.type === "tv" && season) searchParams.set("season", String(season));
  const movieItems = await fetchMovieItems(searchParams);
  if (!movieItems.length) return [];
  // Only an exact provider-returned IMDb identity can authorize the movieId.
  // A single result with absent/mismatched identity is still unresolved, even
  // though the request itself used searchType=imdb.
  const verified = movieItems.filter((item) =>
    validateImdbId(item?.imdbId || item?.imdb_id || item?.imdb) === imdbId);
  const movie = verified.length === 1 ? verified[0] : null;
  if (!movie) return [];
  const movieId = Number(movie?.movieId ?? movie?.id);
  if (!Number.isInteger(movieId) || movieId <= 0) return [];

  const requestedLanguages = String(body.language || "").split(",").map((value) => normalizeSubtitleLanguage(value)).filter(Boolean);
  const results = [];
  for (const languageCode of requestedLanguages) {
    const languageName = subtitleLanguageName(languageCode);
    if (!languageName) continue;
    const params = new URLSearchParams({ movieId: String(movieId), language: languageName, sort: "rating", limit: "100" });
    const response = await fetchSubtitleProvider(`${SUBSOURCE_API_ORIGIN}/subtitles?${params}`, { headers, signal: providerSignal(signal, 10_000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      continue;
    }
    const payload = await boundedProviderJson(response);
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
        canonicalKey: `subsource:${subtitleId}`,
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
  const lifetime = new AbortController();
  const disconnect = () => { if (!res.writableEnded) lifetime.abort(); };
  res.once("close", disconnect);
  req.once("aborted", disconnect);
  try {
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
    lifetime.signal.throwIfAborted();
    const params = buildSubdlSearchParams(body, { queryOverride: query, loose });
    params.set("api_key", apiKey);
    const upstream = await fetchSubtitleProvider(`${SUBDL_API_ORIGIN}/api/v1/subtitles?${params}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      signal: providerSignal(lifetime.signal, 10_000),
    });
    const payload = await boundedProviderJson(upstream);
    if (!upstream.ok) throw Object.assign(
      new Error(`SubDL search failed with HTTP ${upstream.status}`),
      { statusCode: upstream.status >= 300 && upstream.status < 400 ? 502 : upstream.status });
    if (!payload || payload.status === false) throw Object.assign(new Error("SubDL returned an invalid search response"), { statusCode: 502 });
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
    return false;
  };
  const append = (items, query, mode) => {
    for (const item of items) {
      if (!episodeMatchesRequest(item)) continue;
      const key = `${item.language}|${item.canonicalKey || (item.provider && item.id ? `${item.provider}:${item.id}` : "")}`;
      if (!key.split("|")[1]) continue;
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

  const providerFailures = new Map();
  const recordFailure = (provider, error) => {
    // Do not echo provider error text: it can contain credential-bearing URLs
    // (especially a provider-required api_key query). Source-health diagnosis
    // remains explicit without disclosing secrets or depending on call order.
    const previous = providerFailures.get(provider) || { provider, failures: 0, status: 502 };
    previous.failures += 1;
    const code = Number(error?.statusCode);
    previous.status = Number.isSafeInteger(code) && [400,401,403,404,408,429,500,502,503,504].includes(code)
      ? code : 502;
    providerFailures.set(provider, previous);
  };
  if (apiKey) {
    for (let index = 0; index < rawCandidates.length && merged.length < 60; index += 1) {
      if (lifetime.signal.aborted) return;
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
        recordFailure("SubDL", error);
        if (lifetime.signal.aborted) return;
      }
    }
  }

  if (lifetime.signal.aborted) return;
  try {
    append(await searchOpenSubtitlesStremio(body, lifetime.signal), body.catalogId || body.query, "stremio");
  } catch (error) {
    recordFailure("OpenSubtitles", error);
  }

  if (lifetime.signal.aborted) return;
  try {
    append(await searchWyzie(body, lifetime.signal), body.catalogId || body.query, "wyzie");
  } catch (error) {
    recordFailure("Wyzie", error);
  }

  if (lifetime.signal.aborted) return;
  try {
    append(await searchSubSource(body, lifetime.signal), body.catalogId || body.query, "subsource");
  } catch (error) {
    recordFailure("SubSource", error);
  }

  if (lifetime.signal.aborted || res.destroyed) return;
  const failures = [...providerFailures.values()];
  if (!merged.length && failures.length) {
    json(res, 502, { error: "Subtitle providers were unavailable or returned no valid results",
      providerFailures: failures });
    return;
  }
  const providers = [
    apiKey ? "SubDL" : null,
    "OpenSubtitles",
    optionalProviderKey(body, "wyzieKey", "WYZIE_API_KEY") ? "Wyzie" : null,
    optionalProviderKey(body, "subsourceKey", "SUBSOURCE_API_KEY") ? "SubSource" : null,
  ].filter(Boolean);
  json(res, 200, { results: merged, queriesTried: rawCandidates, providers,
    partialSuccess: merged.length > 0 && failures.length > 0,
    providerFailures: failures });
  } finally {
    res.off("close", disconnect);
    req.off("aborted", disconnect);
  }
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
  if (url.protocol !== "https:" || url.port || !/^subs\d+\.strem\.io$/i.test(url.hostname)) return null;
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

function boundedSubtitleZipRecords(zip, archiveBytes) {
  const entries = zip.getEntries();
  if (entries.length > MAX_SUBTITLE_ZIP_ENTRIES)
    throw Object.assign(new Error("Subtitle ZIP has too many entries"), { statusCode: 422 });
  // A central-directory size can be a lie. Preflight the actual compressed
  // member through zlib's hard output cap before using adm-zip's CRC-checked
  // decoder, so forged tiny declared sizes cannot allocate ZIP bombs.
  const archiveId = createHash("sha256").update(archiveBytes).digest("hex");
  const files = [];
  let totalDecompressedBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.isDirectory || files.length >= MAX_SUBTITLE_FILES) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (![".srt", ".vtt", ".ass", ".ssa"].includes(ext)
      || !Number.isSafeInteger(entry.header.size) || entry.header.size < 0
      || entry.header.size > MAX_SUBTITLE_TEXT_BYTES) continue;
    if ((entry.header.flags & 1) !== 0 || ![0, 8].includes(entry.header.method)) continue;
    let data;
    try {
      const compressed = entry.getCompressedData();
      if (!Buffer.isBuffer(compressed) || compressed.length > MAX_SUBTITLE_DOWNLOAD_BYTES) continue;
      const bounded = entry.header.method === 0 ? compressed
        : inflateRawSync(compressed, { maxOutputLength: Math.min(
          MAX_SUBTITLE_TEXT_BYTES, MAX_SUBTITLE_DOWNLOAD_BYTES - totalDecompressedBytes) + 1 });
      if (bounded.length > MAX_SUBTITLE_TEXT_BYTES
        || bounded.length > MAX_SUBTITLE_DOWNLOAD_BYTES - totalDecompressedBytes) continue;
      data = entry.getData(); // Also checks adm-zip CRC32 and declared size.
      if (!Buffer.isBuffer(data) || !data.equals(bounded)) continue;
    } catch { continue; }
    totalDecompressedBytes += data.length;
    const record = subtitleRecord(entry.entryName, data);
    if (record) files.push({ ...record,
      // Archive bytes plus exact raw ZIP member and ordinal (including same-name
      // duplicates), never a display filename or fuzzy release score.
      memberId: createHash("sha256").update(archiveId).update("\0")
        .update(String(index)).update("\0").update(entry.entryName).digest("hex") });
  }
  return files;
}

function sendSelectedSubtitleZipMember(res, files, body, metadata = {}) {
  const requested = body.memberId;
  if (requested !== undefined && (typeof requested !== "string" || !/^[a-f0-9]{64}$/i.test(requested))) {
    json(res, 400, { error: "Invalid ZIP member identity" });
    return;
  }
  const selected = requested
    ? files.find(file => file.memberId === requested.toLowerCase())
    : files.length === 1 ? files[0] : null;
  if (!selected) {
    json(res, requested ? 422 : 409, {
      error: requested ? "Exact ZIP member was not found in this archive"
        : "ZIP contains multiple subtitles; select an exact archive member",
      ...(!requested ? { members: files.map(({ memberId, filename }) => ({ memberId, filename })) } : {}),
    });
    return;
  }
  json(res, 200, { ...selected, ...metadata });
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
    // A token that the user actually selected outranks abandoned results from
    // previous searches without extending its absolute expiry.
    remoteSubtitleDownloads.delete(remoteMatch[1]);
    remoteSubtitleDownloads.set(remoteMatch[1], remote);
    const { response: upstream, finalUrl } = await fetchRemoteSubtitleDownload(remote);
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
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
    let files;
    try { files = boundedSubtitleZipRecords(zip, data); } catch {
      json(res, 422, { error: `${remote.provider} returned an unsafe or invalid ZIP` });
      return;
    }
    if (!files.length) {
      json(res, 422, { error: `${remote.provider} ZIP contained no supported subtitle files` });
      return;
    }
    sendSelectedSubtitleZipMember(res, files, body, { language: remote.language, provider: remote.provider });
    return;
  }
  const openSubtitlesUrl = validateOpenSubtitlesDownloadUrl(body.url);
  const url = openSubtitlesUrl || validateSubdlDownloadUrl(body.url);
  if (!url) {
    json(res, 400, { error: "A valid supported subtitle download URL is required" });
    return;
  }

  if (openSubtitlesUrl) {
    let upstream;
    try {
      upstream = await fetchSubtitleProvider(openSubtitlesUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      json(res, 502, { error: "OpenSubtitles download failed or redirected outside its accepted host" });
      return;
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      json(res, 502, { error: `OpenSubtitles download failed with HTTP ${upstream.status}` });
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

  let upstream;
  try {
    upstream = await fetchSubtitleProvider(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    json(res, 502, { error: "SubDL download failed or redirected outside its accepted host" });
    return;
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    json(res, 502, { error: `SubDL download failed with HTTP ${upstream.status}` });
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

  let files;
  try { files = boundedSubtitleZipRecords(zip, data); } catch {
    json(res, 422, { error: "Downloaded ZIP has unsafe or invalid entries" });
    return;
  }

  if (!files.length) {
    json(res, 422, { error: "ZIP contained no bounded SRT, VTT, ASS, or SSA files" });
    return;
  }
  sendSelectedSubtitleZipMember(res, files, body);
}
