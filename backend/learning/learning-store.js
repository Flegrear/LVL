// Learning: decks (Anki import and export, AnkiWeb), clips, presets and learning subtitles.
import { default as crypto } from "node:crypto";
import { default as ffmpegPath } from "ffmpeg-static";
import { learningPresetBundle, learningPresetCatalog, learningPresetSlice } from "../../learning/presets.js";
import { alignCueArtifacts, processCueArtifact } from "../../learning/subtitle-processing.js";
import {
  buildAnkiPackage, buildAnkiText, htmlToText, readAnkiCollection, readAnkiText,
} from "../../learning/anki/anki.js";
import { downloadSharedDeck, searchSharedDecks, sharedDeckInfo } from "../../learning/anki/ankiweb.js";
import { loadGlosses, PRESET_WORD_SIZES, presetDeck } from "../../learning/preset-decks.js";
import { ankiStore, appDatabase, clipStore, MAX_TORRENT_FILES, storage } from "../../server.js";
import {
  boundedInteger, cacheableJson, json, methodNotAllowed, readBinaryBody, readJsonBody,
  sendStoredFile,
} from "../app/http-helpers.js";
import { getTorrentSession } from "../torrents/torrent-sessions.js";
import { romanizeSubtitleLine } from "../subtitles/romanize.js";

const MAX_LEARNING_ARTIFACT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LEARNING_ALIGNMENT_BODY_BYTES = 4 * 1024 * 1024;

// Anki decks in and out. Import only parses the file and returns the cards; the app stores them.
const MAX_ANKI_UPLOAD_BYTES = 400 * 1024 * 1024;

// Decks are stored: note types, notes and media, so cards render like Anki shows them.
function topDeckName(cards, fallback) {
  const counts = new Map();
  for (const card of cards) {
    const top = String(card.deck || "").split("::")[0].trim();
    if (top && top !== "Default") counts.set(top, (counts.get(top) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
}

function textImportCollection(result, name) {
  const escape = (value) => String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]).replace(/\n/g, "<br>");
  const notetype = { id: "basic-text", name: "Basic", kind: "normal", fields: ["Front", "Back"], templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}" }], css: ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }" };
  const notes = result.cards.map((card, index) => ({ id: `t${index + 1}`, guid: card.guid, mid: notetype.id, tags: card.tags || [], fields: [escape(card.front), escape(card.back)] }));
  const cards = result.cards.map((card, index) => ({ ...card, cardId: `t${index + 1}`, noteId: `t${index + 1}`, ord: 0, deck: card.deck || name }));
  return { notetypes: [notetype], notes, cards, media: [] };
}

function storeAnkiPackage(buffer, meta = {}) {
  const collection = readAnkiCollection(buffer);
  if (!collection.cards.length) throw Object.assign(new Error("No cards were found in that deck"), { statusCode: 422 });
  const name = meta.name || topDeckName(collection.cards, "Imported deck");
  const id = meta.id || `import-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 12)}`;
  const stored = ankiStore.saveDeck({ ...meta, id, name, source: meta.source || "import" }, collection);
  return { ...stored, total: collection.total, truncated: collection.truncated, media: collection.media.length };
}

export async function importAnkiDeck(req, res) {
  const body = await readBinaryBody(req, MAX_ANKI_UPLOAD_BYTES);
  if (!body.length) {
    json(res, 400, { error: "No file was received" });
    return;
  }
  const isZip = body[0] === 0x50 && body[1] === 0x4b;
  if (isZip) {
    json(res, 200, storeAnkiPackage(body));
    return;
  }
  const result = readAnkiText(body.toString("utf8"));
  if (!result.cards.length) {
    json(res, 422, { error: "No cards were found in that file" });
    return;
  }
  const name = topDeckName(result.cards, "Imported notes");
  const stored = ankiStore.saveDeck({ id: `import-text-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 12)}`, name, source: "import" }, textImportCollection(result, name));
  json(res, 200, { ...stored, total: result.total, truncated: result.truncated, media: 0 });
}

function serveAnkiMedia(req, res, deckId, encodedName) {
  let name;
  try { name = decodeURIComponent(encodedName); } catch { name = ""; }
  const found = name ? ankiStore.mediaFile(deckId, name) : null;
  if (!found) {
    json(res, 404, { error: "Media file not found" });
    return;
  }
  const font = /^font\//.test(found.type);
  sendStoredFile(req, res, found, {
    extraHeaders: {
      // Fonts are fetched with CORS from the sandboxed card frame; other media needs no CORS.
      ...(font ? { "Access-Control-Allow-Origin": "*" } : {}),
      ...(/svg/.test(found.type) ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}),
    },
  });
}

const ankiwebJobs = new Map();

function startAnkiwebDownload(sharedId) {
  const existing = [...ankiwebJobs.values()].find((job) => job.sharedId === sharedId && (job.status === "downloading" || job.status === "importing"));
  if (existing) return existing;
  const job = { id: crypto.randomUUID(), sharedId, status: "downloading", received: 0, total: 0, startedAt: Date.now() };
  ankiwebJobs.set(job.id, job);
  for (const [id, item] of ankiwebJobs) if (Date.now() - item.startedAt > 30 * 60 * 1000 && item.status !== "downloading" && item.status !== "importing") ankiwebJobs.delete(id);
  (async () => {
    try {
      const { info, bytes } = await downloadSharedDeck(sharedId, {
        maxBytes: MAX_ANKI_UPLOAD_BYTES,
        onProgress: (received, total) => { job.received = received; job.total = total; },
      });
      job.status = "importing";
      job.title = info.title;
      const result = storeAnkiPackage(bytes, {
        id: `ankiweb-${sharedId}`,
        name: info.title || undefined,
        source: "ankiweb",
        sharedId: String(sharedId),
        description: htmlToText(info.description).slice(0, 2000),
      });
      Object.assign(job, { status: "done", result });
    } catch (error) {
      Object.assign(job, { status: "error", error: error.message || "Download failed" });
    }
  })();
  return job;
}

function ankiwebJobPayload(job, { includeResult = false } = {}) {
  return {
    id: job.id,
    sharedId: job.sharedId,
    status: job.status,
    received: job.received,
    total: job.total,
    title: job.title || "",
    error: job.error || null,
    ...(includeResult && job.result ? { deck: job.result.deck, cards: job.result.cards, media: job.result.media } : {}),
  };
}

export async function handleLearningStoreApi(req, res, url) {
  const { pathname } = url;
  if (pathname === "/api/anki/decks") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, { decks: ankiStore.listDecks() });
    return true;
  }
  let match = /^\/api\/anki\/decks\/([a-z0-9-]{1,64})(?:\/(render))?$/.exec(pathname);
  if (match) {
    const [, deckId, action] = match;
    if (action === "render") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const rendered = ankiStore.render(deckId, url.searchParams.get("note") || "", url.searchParams.get("ord") || 0, { deckName: url.searchParams.get("deck") || "" });
      if (!rendered) json(res, 404, { error: "Card not found in the stored deck" });
      else json(res, 200, rendered);
      return true;
    }
    if (req.method === "GET") {
      const deck = ankiStore.getDeck(deckId);
      if (!deck) json(res, 404, { error: "Deck not found" });
      else json(res, 200, { deck });
      return true;
    }
    if (req.method === "DELETE") {
      ankiStore.deleteDeck(deckId);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    return methodNotAllowed(res, ["GET", "DELETE"]);
  }
  match = /^\/api\/anki\/media\/([a-z0-9-]{1,64})\/([^/]{1,400})$/.exec(pathname);
  if (match) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
    serveAnkiMedia(req, res, match[1], match[2]);
    return true;
  }
  if (pathname === "/api/anki/presets") {
    if (req.method === "GET") {
      const language = String(url.searchParams.get("language") || "").toUpperCase();
      const glosses = await loadGlosses(language);
      json(res, 200, {
        language,
        available: Boolean(glosses?.length),
        sizes: PRESET_WORD_SIZES.map((size) => ({ size, cards: (glosses || []).filter((row) => row.rank <= size).length })),
      });
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    const body = await readJsonBody(req);
    const language = String(body.language || "").toUpperCase();
    const { meta, collection } = await presetDeck({ language, languageName: String(body.languageName || "").slice(0, 40), size: Number(body.size), romanize: romanizeSubtitleLine });
    json(res, 200, ankiStore.saveDeck(meta, collection, { replace: false }));
    return true;
  }
  if (pathname === "/api/ankiweb/search") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const query = String(url.searchParams.get("q") || "").trim();
    if (!query) {
      json(res, 400, { error: "A search is required" });
      return true;
    }
    const decks = await searchSharedDecks(query);
    json(res, 200, { query, stale: Boolean(decks.stale), decks: decks.slice(0, Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 40))) });
    return true;
  }
  match = /^\/api\/ankiweb\/decks\/(\d{1,12})(?:\/(download))?$/.exec(pathname);
  if (match) {
    const sharedId = Number(match[1]);
    if (match[2] === "download") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      json(res, 202, ankiwebJobPayload(startAnkiwebDownload(sharedId)));
      return true;
    }
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const { downloadKey, ...info } = await sharedDeckInfo(sharedId);
    void downloadKey;
    json(res, 200, { ...info, description: htmlToText(info.description).slice(0, 3000), stored: Boolean(ankiStore.getDeck(`ankiweb-${sharedId}`)) });
    return true;
  }
  match = /^\/api\/ankiweb\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
  if (match) {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const job = ankiwebJobs.get(match[1]);
    if (!job) json(res, 404, { error: "Download not found" });
    else json(res, 200, ankiwebJobPayload(job, { includeResult: url.searchParams.get("result") === "1" }));
    return true;
  }
  if (pathname === "/api/clips") {
    if (req.method === "GET") {
      json(res, 200, {
        clips: clipStore.list({
          kind: ["card", "dictation"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "",
          lang: String(url.searchParams.get("lang") || "").slice(0, 8),
          libraryId: /^[a-f0-9]{40}$/i.test(url.searchParams.get("library") || "") ? url.searchParams.get("library") : "",
          fileIndex: url.searchParams.get("file"),
          limit: Number(url.searchParams.get("limit")) || 400,
        }),
        stats: clipStore.stats(),
      });
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    if (!ffmpegPath) {
      json(res, 503, { error: "Bundled FFmpeg binary is unavailable" });
      return true;
    }
    const body = await readJsonBody(req);
    const session = getTorrentSession(String(body.sessionId || ""));
    const fileIndex = boundedInteger(body.fileIndex, 0, MAX_TORRENT_FILES);
    if (!session || fileIndex === undefined || !/^[a-f0-9]{40}$/i.test(String(body.libraryId || "")) || !session.torrent?.files?.[fileIndex]) {
      json(res, 400, { error: "A playing torrent session, its file and a library id are required" });
      return true;
    }
    const created = await clipStore.create({ ...body, fileIndex });
    const totals = clipStore.stats();
    if ((totals.card?.bytes || 0) + (totals.dictation?.bytes || 0) > storage.limits().clipBytes) collectClipGarbage();
    json(res, 200, created);
    return true;
  }
  match = /^\/api\/clips\/([a-f0-9]{24})(?:\/(audio|image|video))?$/.exec(pathname);
  if (match) {
    const [, id, kind] = match;
    if (kind) {
      if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
      if (kind !== "image") await clipStore.prepare(id);
      const found = clipStore.file(id, kind);
      if (!found) json(res, 404, { error: "Clip not found" });
      else sendStoredFile(req, res, found, { cacheControl: "private, max-age=31536000, immutable" });
      return true;
    }
    if (req.method === "DELETE") {
      clipStore.remove(id);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "DELETE"]);
    const clip = await clipStore.prepare(id);
    if (!clip) json(res, 404, { error: "Clip not found" });
    else json(res, 200, clip);
    return true;
  }
  return false;
}

// Card clips stay while a card points at them; everything stays within the saved-lines budget.
export function collectClipGarbage() {
  try {
    const cards = appDatabase.readSection("cards") || [];
    const referenced = cards.map((card) => card?.clipId).filter(Boolean);
    const result = storage.enforceClips(referenced);
    if (result.demoted || result.removed) console.log(`Clips: ${result.demoted} released from cards, ${result.removed} removed (budget)`);
  } catch (error) {
    console.warn("Clip housekeeping failed:", error.message);
  }
}

export async function exportAnkiDeck(req, res) {
  const body = await readJsonBody(req, 96 * 1024 * 1024);
  const cards = Array.isArray(body?.cards) ? body.cards : [];
  if (!cards.length) {
    json(res, 400, { error: "No cards to export" });
    return;
  }
  const deckName = String(body.deckName || "LVL").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "LVL";
  const stamp = new Date().toISOString().slice(0, 10);
  const text = body.format === "txt";
  const payload = text ? Buffer.from(buildAnkiText(cards, { deckName }), "utf8") : buildAnkiPackage(cards, { deckName });
  res.writeHead(200, {
    "Content-Type": text ? "text/plain; charset=utf-8" : "application/zip",
    "Content-Disposition": `attachment; filename="lvl-${stamp}.${text ? "txt" : "apkg"}"`,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

export async function learningPresets(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  const language = String(url.searchParams.get("language") || "").trim();
  if (!language) {
    const catalog = await learningPresetCatalog();
    cacheableJson(req, res, catalog, `learning-presets:${catalog.datasetVersion}:catalog`);
    return true;
  }
  const bundle = await learningPresetBundle(language, {
    wordSize: url.searchParams.get("words") || url.searchParams.get("wordSize"),
    phraseSize: url.searchParams.get("phrases") || url.searchParams.get("phraseSize"),
    includeCounts: url.searchParams.get("includeCounts") === "1",
  });
  if (!bundle) {
    json(res, 404, { error: "Unsupported learning preset language" });
    return true;
  }
  if (bundle.error === "unsupported-size") {
    json(res, 400, {
      error: "Unsupported preset size",
      wordSizes: bundle.manifest.wordSizes,
      phraseSizes: bundle.manifest.phraseSizes,
    });
    return true;
  }
  cacheableJson(req, res, bundle, `learning-presets:${bundle.datasetVersion}:${bundle.language}:${bundle.wordSize}:${bundle.phraseSize}:${url.searchParams.get("includeCounts") === "1"}`);
  return true;
}

export async function learningPresetByPath(req, res, url, language, type, size) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  const preset = await learningPresetSlice(language, type, size, { includeCounts: url.searchParams.get("includeCounts") === "1" });
  if (!preset) {
    json(res, 404, { error: "Unsupported learning preset language or type" });
    return true;
  }
  if (preset.error === "unsupported-size") {
    json(res, 400, {
      error: "Unsupported preset size",
      wordSizes: preset.manifest.wordSizes,
      phraseSizes: preset.manifest.phraseSizes,
    });
    return true;
  }
  cacheableJson(req, res, preset, `learning-presets:${preset.datasetVersion}:${preset.language}:${preset.type}:${preset.size}:${url.searchParams.get("includeCounts") === "1"}`);
  return true;
}

export async function processLearningSubtitle(req, res) {
  const body = await readJsonBody(req, MAX_LEARNING_ARTIFACT_BODY_BYTES);
  const input = body.artifact || body.track || body;
  const artifact = processCueArtifact(input);
  json(res, 200, { artifact });
}

export async function alignLearningSubtitles(req, res) {
  const body = await readJsonBody(req, MAX_LEARNING_ALIGNMENT_BODY_BYTES);
  const tracks = Array.isArray(body.tracks) ? body.tracks : body.artifacts;
  const result = alignCueArtifacts(tracks, { referenceTrackId: body.referenceTrackId });
  json(res, 200, result);
}
