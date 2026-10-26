// review-scheduler.js: spaced repetition that behaves like Anki's SM-2 scheduler (v3, default deck
// options), so cards imported from Anki keep their schedule and exported cards continue in Anki.
//
// Card fields: state ("new" | "learning" | "review" | "relearning"), learningStep, intervalDays,
// ease (2.5 = 250%), dueAt (ms), reviewCount, lapses, lastRating, lastReviewedAt, firstReviewedAt,
// lapseIntervalDays (interval to return to after relearning), suspended.

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

export const ANKI_DEFAULTS = Object.freeze({
  learningStepsMinutes: Object.freeze([1, 10]),
  relearningStepsMinutes: Object.freeze([10]),
  graduatingIntervalDays: 1,
  easyIntervalDays: 4,
  startingEase: 2.5,
  minimumEase: 1.3,
  easyBonus: 1.3,
  hardInterval: 1.2,
  intervalModifier: 1,
  maximumIntervalDays: 36_500,
  lapseNewInterval: 0,
  minimumLapseIntervalDays: 1,
  newCardsPerDay: 20,
  reviewsPerDay: 200,
  learnAheadMinutes: 20,
  dayStartsAtHour: 4,
});

const RATINGS = ["again", "hard", "good", "easy"];

/* ---------------------------------------------------------------- days */

// Anki's day starts at 4 AM local time: a card due "tomorrow" is available from tomorrow 4 AM.
export function dayStartMs(now = Date.now(), hour = ANKI_DEFAULTS.dayStartsAtHour) {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0).getTime();
  return now >= start ? start : addDays(start, -1);
}

function addDays(dayStart, days) {
  const date = new Date(dayStart);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), 0, 0, 0).getTime();
}

function daysBetween(fromDayStart, toDayStart) {
  return Math.round((toDayStart - fromDayStart) / DAY_MS);
}

/* ---------------------------------------------------------------- card state */

export function schedulerState(card) {
  if (["new", "learning", "review", "relearning"].includes(card?.state)) return card.state;
  const intervalDays = Math.max(0, Number(card?.intervalDays || 0));
  if (intervalDays >= 1) return "review";
  if (Number(card?.reviewCount || 0) > 0 || intervalDays > 0) return "learning";
  return "new";
}

export function cardEase(card, options = ANKI_DEFAULTS) {
  const ease = Number(card?.ease);
  return Number.isFinite(ease) && ease >= 1 ? Math.max(options.minimumEase, ease) : options.startingEase;
}

function learningStep(card, steps) {
  const step = Number(card?.learningStep);
  if (Number.isInteger(step) && step >= 0) return Math.min(step, Math.max(0, steps.length - 1));
  const minutes = Math.max(0, Number(card?.intervalDays || 0)) * 1440;
  const nearest = steps.findIndex((value) => Math.abs(value - minutes) < 0.25);
  return nearest >= 0 ? nearest : 0;
}

/* ---------------------------------------------------------------- fuzz */

function seededFraction(card, rating) {
  const input = `${card?.id || card?.front || ""}|${rating}|${Number(card?.reviewCount || 0)}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

// Same ranges as Anki: no fuzz under 2.5 days, then ±15%, ±10% and ±5% bands.
function fuzzedInterval(interval, minimum, maximum, card, rating) {
  if (interval < 2.5) return Math.min(maximum, Math.max(minimum, Math.round(interval)));
  let delta = 1;
  for (const [start, end, factor] of [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]]) delta += factor * Math.max(0, Math.min(interval, end) - start);
  const lower = Math.min(maximum, Math.max(minimum, Math.round(interval - delta)));
  const upper = Math.min(maximum, Math.max(minimum, Math.round(interval + delta)));
  return lower + Math.floor(seededFraction(card, rating) * (1 + upper - lower));
}

function passingInterval(options, interval, minimum, card, rating) {
  const scaled = interval * options.intervalModifier;
  return fuzzedInterval(scaled, Math.max(1, minimum), options.maximumIntervalDays, card, rating);
}

/* ---------------------------------------------------------------- scheduling */

function scheduled(card, now, rating, changes) {
  const firstReviewedAt = Number(card.firstReviewedAt) || now;
  return {
    ...card,
    ...changes,
    reviewCount: Number(card.reviewCount || 0) + 1,
    lastRating: rating,
    lastReviewedAt: now,
    firstReviewedAt,
    schedulerVersion: 2,
  };
}

function learningAnswer(card, rating, now, options, relearning) {
  const steps = relearning ? options.relearningStepsMinutes : options.learningStepsMinutes;
  const step = learningStep(card, steps);
  const ease = cardEase(card, options);
  const toReview = (intervalDays) => scheduled(card, now, rating, {
    state: "review",
    learningStep: 0,
    intervalDays,
    ease,
    dueAt: addDays(dayStartMs(now, options.dayStartsAtHour), intervalDays),
  });
  const stay = (nextStep, minutes) => scheduled(card, now, rating, {
    state: relearning ? "relearning" : "learning",
    learningStep: nextStep,
    intervalDays: relearning ? Number(card.intervalDays || 0) : minutes / 1440,
    ease,
    dueAt: now + Math.round(minutes * MINUTE_MS),
  });
  const lapseInterval = Math.max(options.minimumLapseIntervalDays, Number(card.lapseIntervalDays) || options.minimumLapseIntervalDays);
  if (rating === "easy") return toReview(relearning ? lapseInterval + 1 : options.easyIntervalDays);
  if (rating === "again" || !steps.length) {
    if (!steps.length) return toReview(relearning ? lapseInterval : options.graduatingIntervalDays);
    return stay(0, steps[0]);
  }
  if (rating === "hard") {
    const minutes = step === 0
      ? (steps.length > 1 ? (steps[0] + steps[1]) / 2 : Math.min(steps[0] * 1.5, steps[0] + 1440))
      : steps[step];
    return stay(step, minutes);
  }
  if (step + 1 < steps.length) return stay(step + 1, steps[step + 1]);
  return toReview(relearning ? lapseInterval : options.graduatingIntervalDays);
}

function reviewAnswer(card, rating, now, options) {
  const today = dayStartMs(now, options.dayStartsAtHour);
  const interval = Math.max(1, Math.round(Number(card.intervalDays) || 1));
  const lastReviewDay = Number(card.lastReviewedAt)
    ? dayStartMs(Number(card.lastReviewedAt), options.dayStartsAtHour)
    : addDays(dayStartMs(Number(card.dueAt) || now, options.dayStartsAtHour), -interval);
  const elapsed = Math.max(0, daysBetween(lastReviewDay, today));
  const daysLate = Math.max(0, elapsed - interval);
  const ease = cardEase(card, options);
  if (rating === "again") {
    const lapseIntervalDays = Math.max(options.minimumLapseIntervalDays, Math.round(interval * options.lapseNewInterval));
    const nextEase = Math.max(options.minimumEase, Math.round((ease - 0.2) * 1000) / 1000);
    const lapsed = { ...card, ease: nextEase, lapseIntervalDays, lapses: Number(card.lapses || 0) + 1, intervalDays: lapseIntervalDays };
    if (!options.relearningStepsMinutes.length) {
      return scheduled(lapsed, now, rating, { state: "review", learningStep: 0, dueAt: addDays(today, lapseIntervalDays) });
    }
    return scheduled(lapsed, now, rating, {
      state: "relearning",
      learningStep: 0,
      dueAt: now + Math.round(options.relearningStepsMinutes[0] * MINUTE_MS),
    });
  }
  // Anki: hard = interval x 1.2, good = (interval + half the delay) x ease, easy = (interval +
  // delay) x ease x easy bonus; each at least one day longer than the previous button.
  const hard = passingInterval(options, interval * options.hardInterval, interval + 1, card, "hard");
  const good = passingInterval(options, (interval + daysLate / 2) * ease, hard + 1, card, "good");
  const easy = passingInterval(options, (interval + daysLate) * ease * options.easyBonus, good + 1, card, "easy");
  const nextInterval = { hard, good, easy }[rating];
  const nextEase = rating === "hard" ? Math.max(options.minimumEase, ease - 0.15) : rating === "easy" ? ease + 0.15 : ease;
  return scheduled(card, now, rating, {
    state: "review",
    learningStep: 0,
    intervalDays: nextInterval,
    ease: Math.round(nextEase * 1000) / 1000,
    dueAt: addDays(today, nextInterval),
  });
}

export function scheduleReview(card, rating, now = Date.now(), options = ANKI_DEFAULTS) {
  const answer = RATINGS.includes(rating) ? rating : "good";
  const state = schedulerState(card);
  if (state === "review") return reviewAnswer(card, answer, now, options);
  if (state === "relearning") return learningAnswer(card, answer, now, options, true);
  return learningAnswer({ ...card, learningStep: state === "new" ? 0 : card.learningStep }, answer, now, options, false);
}

export function formatReviewInterval(delayMs) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (ms < 60 * MINUTE_MS) return `${Math.max(1, Math.round(ms / MINUTE_MS))}m`;
  if (ms < DAY_MS) return `${Math.max(1, Math.round(ms / (60 * MINUTE_MS)))}h`;
  return formatDays(ms / DAY_MS);
}

function formatDays(days) {
  if (days < 30) return `${Math.max(1, Math.round(days))}d`;
  if (days < 365) return `${Math.round((days / 30) * 10) / 10}mo`.replace(".0mo", "mo");
  return `${Math.round((days / 365) * 10) / 10}y`.replace(".0y", "y");
}

// What each button would do, labelled like Anki: minutes for steps, days/months for reviews.
export function previewReviewIntervals(card, now = Date.now(), options = ANKI_DEFAULTS) {
  return Object.fromEntries(RATINGS.map((rating) => {
    const next = scheduleReview(card, rating, now, options);
    return [rating, {
      dueAt: next.dueAt,
      intervalDays: next.intervalDays,
      state: next.state,
      learningStep: next.learningStep,
      label: next.state === "review" ? formatDays(next.intervalDays) : formatReviewInterval(next.dueAt - now),
    }];
  }));
}

/* ---------------------------------------------------------------- queue */

export function reviewQueuePriority(card, now = Date.now()) {
  const state = schedulerState(card);
  const dueAt = Number(card?.dueAt || 0);
  const due = dueAt <= now;
  const stateRank = state === "learning" || state === "relearning" ? 0 : state === "review" ? 1 : 2;
  return { due, state, stateRank, dueAt, overdueMs: due ? Math.max(0, now - dueAt) : 0 };
}

export function sortReviewQueue(cards, now = Date.now()) {
  return [...cards].sort((a, b) => {
    const left = reviewQueuePriority(a, now);
    const right = reviewQueuePriority(b, now);
    if (left.due !== right.due) return left.due ? -1 : 1;
    if (left.stateRank !== right.stateRank) return left.stateRank - right.stateRank;
    if (left.dueAt !== right.dueAt) return left.dueAt - right.dueAt;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

/**
 * Today's queue, with Anki's daily limits: learning cards that are due (or due within the
 * learn-ahead window when nothing else is left), due reviews up to the review limit, then new
 * cards up to what's left of today's new-card limit, in the order they were added.
 * Returns { queue, counts: { new, learning, review }, nextDueAt }.
 */
export function buildReviewQueue(cards, { now = Date.now(), options = ANKI_DEFAULTS } = {}) {
  const today = dayStartMs(now, options.dayStartsAtHour);
  const active = (cards || []).filter((card) => card && !card.suspended && !(Number(card.buriedUntil) > now));
  const learning = [];
  const reviews = [];
  const fresh = [];
  let introducedToday = 0;
  for (const card of active) {
    if (Number(card.firstReviewedAt) >= today) introducedToday += 1;
    const state = schedulerState(card);
    if (state === "new") fresh.push(card);
    else if (state === "review") { if (Number(card.dueAt || 0) < addDays(today, 1)) reviews.push(card); }
    else learning.push(card);
  }
  const dueLearning = learning.filter((card) => Number(card.dueAt || 0) <= now).sort((a, b) => a.dueAt - b.dueAt);
  const dueReviews = reviews.sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0)).slice(0, options.reviewsPerDay);
  const position = (card) => (Number.isFinite(Number(card.newPosition)) ? Number(card.newPosition) : Number.MAX_SAFE_INTEGER);
  const newCards = fresh.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0) || position(a) - position(b) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, options.newCardsPerDay - introducedToday));
  let queue = [...dueLearning, ...dueReviews, ...newCards];
  if (!queue.length) {
    const ahead = learning.filter((card) => Number(card.dueAt || 0) <= now + options.learnAheadMinutes * MINUTE_MS).sort((a, b) => a.dueAt - b.dueAt);
    queue = ahead;
  }
  const upcoming = [...learning, ...reviews, ...active.filter((card) => schedulerState(card) === "review")]
    .map((card) => Number(card.dueAt || 0)).filter((value) => value > now);
  return {
    queue,
    counts: { new: newCards.length, learning: learning.filter((card) => Number(card.dueAt || 0) < addDays(today, 1)).length, review: dueReviews.length },
    nextDueAt: upcoming.length ? Math.min(...upcoming) : null,
  };
}
