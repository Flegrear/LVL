/**
 * Recommendation engine: from your ratings, finds titles you may enjoy more than
 * the general audience and says why. Pure functions; item scores come from recs-store.
 *
 * - Compare each personal rating primarily to that title's public average when
 *   available, then to the user's rating average. Missing public scores fall
 *   back to personal calibration. Unrated statuses remain weak signals.
 * - A candidate's match combines how strongly fans of the titles you rated recommend it
 *   (AniList votes, TMDB position), how much its genres, tags and studios overlap with your
 *   taste, and its community score (trusted more with more voters), on a logistic curve.
 * - Once enough earlier picks have your rating, the curve is refitted to your own results.
 */

const ANCHOR = 7;
const PRIOR_MEAN = 7.5;
const PRIOR_WEIGHT = 3;
const STATUS_SIGNAL = Object.freeze({ COMPLETED: 0.25, REPEATING: 0.6, CURRENT: 0.15, WATCHED: 0.2, PAUSED: -0.1, DROPPED: -0.8 });
const SOURCE_PRIORITY = Object.freeze({ app: 3, anilist: 2, letterboxd: 1 });
const PICK_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "MOVIE", "movie", "tv"]);
const CONTINUATION = new Set(["PREQUEL", "PARENT"]);
export const DEFAULT_CURVE = Object.freeze({ bias: -1.4, link: 2.4, content: 1.6, quality: 1, scale: 1, shift: 0, fitted: 0 });

const logistic = (value) => 1 / (1 + Math.exp(-value));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** 1.00 to 10.00 with two decimals; anything else is "no score". */
export function roundScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(clamp(number, 1, 10) * 100) / 100;
}

/** One rating per title: a score beats a status, then your own rating in the app, then AniList, then Letterboxd. */
export function mergeRatings(ratings = [], { preferAniListScores = false } = {}) {
  // When the user explicitly enables two-way anime scores, AniList becomes
  // the canonical score for an exactly mapped item even if an older local
  // app rating still exists. Local ratings remain untouched in SQLite.
  const rank = (rating) => (Number.isFinite(rating.score) ? 10 : 0)
    + (preferAniListScores && rating.source === "anilist" && Number.isFinite(rating.score) ? 4 : SOURCE_PRIORITY[rating.source] || 0)
    + (rating.source === "app" && Number.isInteger(rating.season) ? 0.5 : 0)
    + (Number(rating.updatedAt) || 0) / 1e15;
  const byItem = new Map();
  for (const rating of ratings) {
    if (!rating?.itemId) continue;
    const current = byItem.get(rating.itemId);
    if (!current || rank(rating) > rank(current)) byItem.set(rating.itemId, rating);
  }
  return [...byItem.values()];
}

/** Your average and spread, pulled toward 7.5 while you have only a few scores. */
export function ratingScale(scores = []) {
  const list = scores.filter((value) => Number.isFinite(value));
  const mean = (list.reduce((sum, value) => sum + value, 0) + PRIOR_MEAN * PRIOR_WEIGHT) / (list.length + PRIOR_WEIGHT);
  const variance = list.length > 1 ? list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (list.length - 1) : 1;
  return { mean, spread: Math.max(0.75, Math.sqrt(variance)), count: list.length };
}

/** How much a rating says you liked a title: positive pulls similar titles up, negative pushes them down. */
export function ratingSignal(rating, scale, item = null) {
  if (Number.isFinite(rating?.score)) {
    const relative = clamp((rating.score - scale.mean) / scale.spread, -2.5, 2.5);
    const personal = 0.75 * relative + 0.25 * ((rating.score - ANCHOR) / 1.5);
    // AniList/TMDB item.score is public average in 0..100, never the viewer's
    // score. Reject untrusted/missing values rather than treating zero as bad.
    const publicScore = Number(item?.score);
    if (item?.score !== null && item?.score !== undefined && Number.isFinite(publicScore)
      && publicScore > 0 && publicScore <= 100) {
      const publicDelta = clamp((rating.score - publicScore / 10) / 1.5, -2.5, 2.5);
      return clamp(0.75 * publicDelta + 0.25 * personal, -3, 3);
    }
    return clamp(0.6 * relative + 0.4 * ((rating.score - ANCHOR) / 1.5), -3, 3);
  }
  return STATUS_SIGNAL[rating?.status] ?? 0;
}

/** Genres, tags (by how central they are) and studios, each with a weight and a display name. */
export function itemFeatures(item) {
  const features = new Map();
  const add = (prefix, label, weight) => {
    const name = String(label || "").trim();
    if (!name || !(weight > 0)) return;
    const key = `${prefix}:${name.toLowerCase()}`;
    const previous = features.get(key);
    if (!previous || previous.weight < weight) features.set(key, { weight, label: name, prefix });
  };
  (item?.genres || []).forEach((genre) => add("g", genre, 1));
  (item?.tags || []).slice(0, 15).forEach((tag) => add("t", tag?.name, 0.8 * clamp(Number(tag?.weight ?? 60), 0, 100) / 100));
  (item?.studios || []).slice(0, 3).forEach((studio) => add("s", studio, 0.6));
  return features;
}

/** AniList fan votes (1,191 votes ≈ 0.98, 25 votes = 0.5) or TMDB's ranked list (first ≈ 0.85). */
export function linkStrength(link) {
  const votes = Number(link?.votes);
  if (Number.isFinite(votes) && votes > 0) return votes / (votes + 25);
  const rank = Number(link?.rank);
  if (link?.rank !== null && link?.rank !== undefined && Number.isFinite(rank) && rank >= 0) return 0.85 * 0.9 ** rank;
  return 0;
}

/** Community score as -1.5…1.5 around "good" (72/100), trusted fully from about 10,000 voters. */
export function itemQuality(item) {
  const score = Number(item?.score);
  if (!Number.isFinite(score) || score <= 0) return 0;
  let quality = clamp((score - 72) / 12, -1.5, 1.5);
  const liked = Number(item?.likedShare);
  if (Number.isFinite(liked) && liked > 0) quality = 0.5 * quality + 0.5 * clamp((liked - 0.6) / 0.2, -1.5, 1.5);
  const trust = Math.min(1, Math.log10(1 + Math.max(0, Number(item?.scoredBy) || 0)) / 4);
  return quality * trust;
}

function cosine(taste, features, tasteNorm) {
  let dot = 0;
  let norm = 0;
  for (const [key, { weight }] of features) {
    norm += weight * weight;
    dot += (taste.get(key) || 0) * weight;
  }
  return norm && tasteNorm ? dot / (Math.sqrt(norm) * tasteNorm) : 0;
}

function pickReasons(pick, taste, items, observedMean) {
  const studiosOf = (itemId) => items.get(itemId)?.studios || [];
  const fans = pick.entry.from.filter((from) => from.weight > 0).sort((a, b) => b.weight * b.strength - a.weight * a.strength).slice(0, 2);
  const caution = pick.entry.from.filter((from) => from.weight < -0.3).sort((a, b) => a.weight - b.weight).slice(0, 1);
  const shared = [...itemFeatures(pick.item)]
    .filter(([key, feature]) => feature.prefix !== "s" && (taste.get(key) || 0) > 0)
    .sort(([keyA, a], [keyB, b]) => taste.get(keyB) * b.weight - taste.get(keyA) * a.weight)
    .slice(0, 3)
    .map(([, feature]) => feature.label);
  const studio = (pick.item.studios || []).find((name) => fans.some((from) => studiosOf(from.itemId).includes(name)));
  const reasons = [];
  if (fans.length) reasons.push({ kind: "fans", from: fans.map(({ itemId, title, score, status, votes, rank }) => ({
    itemId, title, score, status, votes, rank,
    publicScore: Number(items.get(itemId)?.score) > 0 && Number(items.get(itemId)?.score) <= 100 ? Number(items.get(itemId).score) : null,
    personalAverage: observedMean === null ? null : Math.round(observedMean * 100) / 100,
  })) });
  if (shared.length) reasons.push({ kind: "shared", names: shared });
  if (studio) reasons.push({ kind: "studio", name: studio, title: fans.find((from) => studiosOf(from.itemId).includes(studio))?.title || "" });
  if (Number.isFinite(pick.item.score) && pick.item.score > 0) reasons.push({ kind: "community", score: pick.item.score, scoredBy: Number(pick.item.scoredBy) || 0, source: pick.item.source || "" });
  if (caution.length) reasons.push({ kind: "caution", from: caution.map(({ itemId, title, score }) => ({ itemId, title, score })) });
  if (pick.planned) reasons.push({ kind: "planned" });
  return reasons;
}

/** "Because you rated Frieren 9.70 and watched Mushi-shi" */
export function reasonSummary(reasons = []) {
  const fans = reasons.find((reason) => reason.kind === "fans")?.from || [];
  const rated = fans.filter((from) => Number.isFinite(from.score)).map((from) => `${from.title} ${from.score.toFixed(2)}`);
  const watched = fans.filter((from) => !Number.isFinite(from.score)).map((from) => from.title);
  const parts = [rated.length ? `rated ${rated.join(" and ")}` : "", watched.length ? `watched ${watched.join(" and ")}` : ""].filter(Boolean);
  if (parts.length) return `Because you ${parts.join(" and ")}`;
  const shared = reasons.find((reason) => reason.kind === "shared")?.names || [];
  return shared.length ? `${shared.join(", ")}, like your favorites` : "";
}

/**
 * ratings: [{ itemId, title, score, status, source, updatedAt }]; items: Map itemId → details;
 * links: Map itemId → [{ to, votes, rank }]; hidden: item ids you marked "not interested".
 */
export function recommend({ ratings = [], items = new Map(), links = new Map(), hidden = new Set(), curve = DEFAULT_CURVE, limit = 24, minMatch = 0.45 } = {}) {
  const merged = mergeRatings(ratings);
  const scale = ratingScale(merged.map((rating) => rating.score));
  const scored = merged.map((rating) => rating.score).filter(Number.isFinite);
  const observedMean = scored.length ? scored.reduce((sum, score) => sum + score, 0) / scored.length : null;
  const isPlanned = (rating) => rating.status === "PLANNING" && !Number.isFinite(rating.score);
  const known = new Set(merged.filter((rating) => !isPlanned(rating)).map((rating) => rating.itemId));
  const planned = new Set(merged.filter(isPlanned).map((rating) => rating.itemId));
  const signals = merged.map((rating) => ({ ...rating, weight: ratingSignal(rating, scale, items.get(rating.itemId)) })).filter((signal) => Math.abs(signal.weight) >= 0.05);

  const taste = new Map();
  for (const signal of signals) {
    const item = items.get(signal.itemId);
    if (!item) continue;
    for (const [key, feature] of itemFeatures(item)) taste.set(key, (taste.get(key) || 0) + signal.weight * feature.weight);
  }
  const tasteNorm = Math.sqrt([...taste.values()].reduce((sum, value) => sum + value * value, 0));

  const pool = new Map();
  for (const signal of signals) {
    for (const link of links.get(signal.itemId) || []) {
      if (known.has(link.to) || hidden.has(link.to)) continue;
      const strength = linkStrength(link);
      if (!strength) continue;
      const entry = pool.get(link.to) || { pos: 0, neg: 0, from: [] };
      if (signal.weight > 0) entry.pos += signal.weight * strength;
      else entry.neg -= signal.weight * strength;
      entry.from.push({
        itemId: signal.itemId,
        title: signal.title || items.get(signal.itemId)?.title || "",
        score: Number.isFinite(signal.score) ? signal.score : null,
        status: signal.status || "",
        weight: signal.weight,
        strength,
        votes: link.votes ?? null,
        rank: link.rank ?? null,
      });
      pool.set(link.to, entry);
    }
  }

  const best = new Map();
  for (const [itemId, entry] of pool) {
    const item = items.get(itemId);
    if (!item || item.adult || entry.pos <= 0) continue;
    if (item.format && !PICK_FORMATS.has(item.format)) continue;
    // A later part of a show you already know is a "next season", not a discovery.
    if ((item.relations || []).some((relation) => CONTINUATION.has(relation.type) && known.has(relation.id))) continue;
    const link = Math.tanh(entry.pos - 0.8 * entry.neg);
    const content = cosine(taste, itemFeatures(item), tasteNorm);
    const quality = itemQuality(item);
    // Public popularity is useful corroboration, not a substitute for evidence
    // that this user will like the title. In particular, a very highly rated
    // candidate reached through one extremely weak fan link must not enter the
    // personalized picks solely on the strength of community reception.
    const communityContribution = curve.quality * quality;
    const boundedCommunityContribution = communityContribution > 0
      ? Math.min(communityContribution, 0.35) : communityContribution;
    const raw = curve.bias + curve.link * link + curve.content * content + boundedCommunityContribution;
    const match = logistic((curve.scale ?? 1) * raw + (curve.shift ?? 0));
    const pick = { itemId, item, match, raw, features: { link, content, quality, communityContribution: boundedCommunityContribution }, entry, planned: planned.has(itemId) };
    const show = item.franchiseId || itemId;
    if (!best.has(show) || best.get(show).match < match) best.set(show, pick);
  }

  const picks = [...best.values()]
    .filter((pick) => pick.match >= minMatch)
    .sort((a, b) => b.match - a.match || b.entry.pos - a.entry.pos)
    .slice(0, limit)
    .map((pick, index) => {
      const reasons = pickReasons(pick, taste, items, observedMean);
      return { rank: index + 1, itemId: pick.itemId, match: pick.match, raw: pick.raw, features: pick.features, reasons, summary: reasonSummary(reasons) };
    });
  return { scale, signals: signals.length, candidates: pool.size, picks };
}

/**
 * Refits the match curve to your results: each outcome is an earlier pick (its raw score at the
 * time) and whether you then rated it above your average. A prior keeps it close to the default
 * until there's enough evidence; fewer than 6 outcomes leave the curve as it is.
 */
export function fitCurve(outcomes = [], base = DEFAULT_CURVE) {
  const data = outcomes.filter((outcome) => Number.isFinite(outcome?.raw) && typeof outcome?.liked === "boolean");
  if (data.length < 6) return { ...base, scale: 1, shift: 0, fitted: data.length };
  let a = 1;
  let b = 0;
  const strength = 4;
  for (let step = 0; step < 30; step += 1) {
    let gradA = strength * (a - 1);
    let gradB = strength * b;
    let hAA = strength;
    let hAB = 0;
    let hBB = strength;
    for (const { raw, liked } of data) {
      const p = logistic(a * raw + b);
      const weight = p * (1 - p);
      gradA += (p - (liked ? 1 : 0)) * raw;
      gradB += p - (liked ? 1 : 0);
      hAA += weight * raw * raw;
      hAB += weight * raw;
      hBB += weight;
    }
    const det = hAA * hBB - hAB * hAB;
    if (!(det > 1e-9)) break;
    const stepA = (hBB * gradA - hAB * gradB) / det;
    const stepB = (hAA * gradB - hAB * gradA) / det;
    a -= stepA;
    b -= stepB;
    if (Math.abs(stepA) + Math.abs(stepB) < 1e-7) break;
  }
  return { ...base, scale: clamp(a, 0.2, 3), shift: clamp(b, -3, 3), fitted: data.length };
}
