// Pure reader logic: no DOM, so it can be tested in Node.
export const LAYOUTS = Object.freeze(["single", "double", "vertical"]);
export const DIRECTIONS = Object.freeze(["rtl", "ltr"]);
export const THEMES = Object.freeze(["black", "dark", "sepia", "white"]);
export const FITS = Object.freeze(["height", "width", "original"]);

// Manhwa and manhua are usually long vertical strips; manga reads right to left,
// two pages at a time when the window is wide enough for a spread.
export function defaultMode(comic = {}, { wide = false } = {}) {
  if (["KR", "CN", "TW"].includes(comic.country)) return { layout: "vertical", direction: "ltr", offset: false, fit: "width" };
  return { layout: wide ? "double" : "single", direction: "rtl", offset: false, fit: "height" };
}

export function normalizeMode(mode = {}, fallback = defaultMode()) {
  return {
    layout: LAYOUTS.includes(mode.layout) ? mode.layout : fallback.layout,
    direction: DIRECTIONS.includes(mode.direction) ? mode.direction : fallback.direction,
    offset: typeof mode.offset === "boolean" ? mode.offset : fallback.offset,
    fit: FITS.includes(mode.fit) ? mode.fit : FITS.includes(fallback.fit) ? fallback.fit : "height",
  };
}

// The chapters before and after `chapter` in the index ([{ chapter }]), or null.
export function chapterNeighbours(chapters = [], chapter = null) {
  const at = chapters.findIndex((item) => String(item.chapter) === String(chapter));
  if (at < 0) return { prev: null, next: null };
  return { prev: chapters[at - 1]?.chapter ?? null, next: chapters[at + 1]?.chapter ?? null };
}

// A chapter label alone is not a unit identity: Volumes 1 and 2 can both have
// "Chapter 1". Keep the supplied index order (also in flat/no-volume mode),
// with no deduplication. `volume: undefined` means the reader did not know the
// current volume; `volume: null` means an explicitly unvolumed chapter.
const chapterLabel = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const label = String(value).trim();
  const numeric = Number(label);
  return Number.isFinite(numeric) ? `n:${numeric}` : `s:${label}`;
};
const volumeLabel = (value) => chapterLabel(value) ?? "unvolumed";
export function readerChapterIdentity(chapter, volume = null) {
  return { chapter: chapter == null ? null : String(chapter), volume: volume == null || String(volume).trim() === "" ? null : String(volume) };
}
export function readerChapterPosition(chapters = [], { chapter = null, volume = undefined } = {}) {
  const items = Array.isArray(chapters) ? chapters : [];
  const label = chapterLabel(chapter);
  if (label === null) return { index: -1, ambiguous: false };
  const byNumber = items.map((item, i) => ({ item, i }))
    .filter(({ item }) => chapterLabel(item?.chapter) === label);
  // An absent current volume is safe only when this chapter number is unique.
  // An explicitly known unvolumed unit is not the same as an unknown volume.
  const matches = volume === undefined ? byNumber
    : byNumber.filter(({ item }) => volumeLabel(item?.volume) === volumeLabel(volume));
  return { index: matches.length === 1 ? matches[0].i : -1, ambiguous: matches.length > 1 };
}
export function readerChapterNeighbours(chapters = [], current = {}) {
  const { index, ambiguous } = readerChapterPosition(chapters, current);
  const items = Array.isArray(chapters) ? chapters : [];
  const at = (i) => {
    const item = items[i];
    if (!item || chapterLabel(item.chapter) === null) return null;
    const { index: unique } = readerChapterPosition(items, { chapter: item.chapter, volume: item.volume ?? null });
    return unique === i ? readerChapterIdentity(item.chapter, item.volume) : null;
  };
  return { index, ambiguous, prev: index > 0 ? at(index - 1) : null,
    next: index >= 0 && index + 1 < items.length ? at(index + 1) : null };
}

export const MAX_NEXT_CHAPTER_PRELOAD = 3;
// A cascade handover may keep only the immediately adjacent chapter's two
// edge images; the existing active reader remains the sole progress owner.
export const MAX_CASCADE_BRIDGE_PAGES = 2;
export function cascadeBridgePageWindow(total, edge = "tail", start = 0) {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(start) || start < 0 || start >= total)
    return [];
  const first = edge === "head" ? start : Math.max(0, total - MAX_CASCADE_BRIDGE_PAGES);
  const last = edge === "head" ? Math.min(total, first + MAX_CASCADE_BRIDGE_PAGES) : total;
  return Array.from({ length: last - first }, (_, n) => first + n);
}
export function cascadeBridgeSameOwner(from, to) {
  if (!from || !to || !from.fileId || !to.fileId || from.fileId === to.fileId
      || !from.workId || from.workId !== to.workId) return false;
  const source = (owner) => owner.fileId.startsWith("ex-") ? owner.sourceId : "local";
  return Boolean(source(from) && source(from) === source(to));
}
export function normalizeNextChapterPreload(value, fallback = 2) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0
    ? Math.min(MAX_NEXT_CHAPTER_PRELOAD, count) : fallback;
}

export function nextChapterPreloadTargets(chapters = [], current = {}, count = 2) {
  const { index } = readerChapterPosition(chapters, current);
  if (index < 0) return [];
  const targets = [];
  for (let i = index + 1; i < chapters.length && targets.length < normalizeNextChapterPreload(count); i += 1) {
    const item = chapters[i];
    if (readerChapterPosition(chapters, { chapter: item?.chapter, volume: item?.volume ?? null }).index !== i) break;
    targets.push(readerChapterIdentity(item.chapter, item.volume));
  }
  return targets;
}

// A continued gesture at the bottom of a long strip advances the chapter.
// Native touch scrolling does not fire wheel events, and scroll events alone
// may be caused by layout/restore. Require additional downward reading intent.
export function createReaderChapterAdvanceGate({ now = Date.now, wheelHoldMs = 450, touchDistance = 48 } = {}) {
  let wheelSince = null;
  let touchTravel = 0;
  return {
    wheel(atBottom, deltaY) {
      if (!atBottom || deltaY <= 0) { wheelSince = null; return false; }
      if (wheelSince === null) wheelSince = now();
      return now() - wheelSince >= wheelHoldMs;
    },
    touchStart() { touchTravel = 0; },
    touchMove(atBottom, dy) {
      if (!atBottom || dy >= 0) { touchTravel = 0; return false; }
      touchTravel += -dy;
      return touchTravel >= touchDistance;
    },
    reset() { wheelSince = null; touchTravel = 0; },
  };
}

// MangaFox adds a credit strip to the bottom of each page file: on a white band,
// 2–6 centered lines of 13 px text, 6 px apart, 6 px from the bottom and 10 px
// below the page (measured on its files: 3 lines add 67 px, 4 lines 86 px, at
// any page width). gray: luminance (0–255) of the bottom `rows` rows, row by row.
// Returns how many rows to cut from the bottom, or 0 when that layout isn't there.
export const CREDIT_STRIP_ROWS = 200;
export function creditStripRows(gray, width, rows) {
  if (!width || rows < 40) return 0;
  // Bands from the bottom: runs of fully white rows ("blank") and runs of rows
  // with dark pixels ("ink"), with the ink band's horizontal extent.
  const runs = [];
  for (let y = rows - 1; y >= 0; y -= 1) {
    let dark = 0;
    let light = true;
    let left = -1;
    let right = -1;
    for (let x = 0, at = y * width; x < width; x += 1, at += 1) {
      const value = gray[at];
      if (value < 160) { dark += 1; if (left < 0) left = x; right = x; }
      if (value < 215) light = false;
    }
    const kind = light ? "blank" : "ink";
    const run = runs.at(-1);
    if (run?.kind === kind) {
      run.length += 1;
      if (kind === "ink") { run.dense ||= dark >= width * 0.6; if (left >= 0) { run.left = run.left < 0 ? left : Math.min(run.left, left); run.right = Math.max(run.right, right); } }
    } else runs.push({ kind, length: 1, dense: !light && dark >= width * 0.6, left, right });
  }
  const blank = (run, low, high) => run && run.kind === "blank" && run.length >= low && run.length <= high;
  // A line of the strip: 11–15 px tall, centered on the page, never mostly dark.
  const line = (run) => run && run.kind === "ink" && run.length >= 11 && run.length <= 15 && !run.dense && run.left >= 0
    && Math.abs((run.left + run.right) / 2 - width / 2) < width * 0.08;
  // Text over the art never gives fully white rows around it, so nothing is cut there.
  if (!blank(runs[0], 4, 8)) return 0;
  let cut = runs[0].length;
  let lines = 0;
  let at = 1;
  while (line(runs[at])) {
    cut += runs[at].length;
    lines += 1;
    const gap = runs[at + 1];
    // Between lines: 4–8 blank rows followed by another line; above the last line: 8+ blank rows.
    if (blank(gap, 4, 8) && line(runs[at + 2])) { cut += gap.length; at += 2; continue; }
    if (gap?.kind === "blank" && gap.length >= 8 && lines >= 2 && lines <= 5) return cut + Math.min(gap.length, 10);
    return 0;
  }
  return 0;
}

// Pages shown together in two-page mode. The first page (the cover) stands
// alone; "offset" shifts the pairing by one for spreads that don't line up; a
// wide page (a printed double-page spread) stands alone too.
export function spreadsFor(pages, { offset = false, wide = null } = {}) {
  const alone = (n) => n === 0 || (offset && n === 1) || Boolean(wide?.has(n));
  const groups = [];
  for (let n = 0; n < pages;) {
    if (alone(n) || n + 1 >= pages || alone(n + 1)) { groups.push([n]); n += 1; } else { groups.push([n, n + 1]); n += 2; }
  }
  return groups;
}

export function spreadOf(page, pages, { offset = false, wide = null } = {}) {
  if (pages <= 1 || page <= 0) return [0];
  const at = Math.min(page, pages - 1);
  return spreadsFor(pages, { offset, wide }).find((group) => group.includes(at)) || [at];
}

export function step(page, delta, pages, mode) {
  const last = Math.max(0, pages - 1);
  if (mode.layout !== "double") return Math.max(0, Math.min(last, page + delta));
  const spread = spreadOf(page, pages, mode);
  const target = delta > 0 ? spread[spread.length - 1] + 1 : spread[0] - 1;
  if (target < 0) return 0;
  if (target > last) return last;
  return spreadOf(target, pages, mode)[0];
}

export const atEnd = (page, pages, mode) => (mode.layout === "double"
  ? spreadOf(page, pages, mode).includes(pages - 1) : page >= pages - 1);

// Keyboard → action. The arrow pointing where the story goes moves forward (Right when
// reading left to right, Left when right to left), in every layout. In the long strip,
// Up, Down, Space and Page keys keep scrolling the page.
export function keyAction(event, mode) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const forward = mode.direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  const back = mode.direction === "rtl" ? "ArrowRight" : "ArrowLeft";
  if (event.key === forward) return "next";
  if (event.key === back) return "prev";
  if (mode.layout !== "vertical") {
    if (event.key === "PageDown" || (event.code === "Space" && !event.shiftKey)) return "next";
    if (event.key === "PageUp" || (event.code === "Space" && event.shiftKey)) return "prev";
  }
  const key = String(event.key || "").toLowerCase();
  if (event.key === "Home") return "first";
  if (event.key === "End") return "last";
  if (event.key === "Escape") return "close";
  if (key === "f") return "fullscreen";
  if (key === "n") return "nextFile";
  if (key === "b") return "prevFile";
  return null;
}

// The page a chapter opens on. A page in the address wins, page 0 included (a link, a reload).
// Without one (opened from a list) it resumes the saved page, or starts over once finished.
export function startPage(requested, progress, pages) {
  const last = Math.max(0, (Number(pages) || 0) - 1);
  const wanted = requested === null || requested === undefined || requested === ""
    ? (progress && !progress.finished ? Number(progress.page) || 0 : 0)
    : Number(requested) || 0;
  return Math.max(0, Math.min(last, wanted));
}

// Long strip: Next/Previous scroll by most of a screen (one webtoon image can be several
// screens tall). Returns the distance to scroll, 0 at the top, or "end" at the bottom.
export const STRIP_STEP = 0.85;
export function stripStep({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}, direction = 1, share = STRIP_STEP) {
  const room = direction > 0 ? scrollHeight - clientHeight - scrollTop : scrollTop;
  if (room <= 2) return direction > 0 ? "end" : 0;
  return Math.sign(direction) * Math.min(room, Math.round(clientHeight * share));
}

// The reader's real stage scroll listener uses this intent gate. A scroll event
// alone is not a gesture: restore, resize and native Back can all scroll an
// element after the browser has finished laying it out. Only recent, explicit
// navigation can collapse the chrome, and revealing it revokes pending intent.
export function createReaderScrollIntentController(stage, { onScroll, enterImmersive, now = Date.now,
  intentMs = 1200, wheelQuietMs = 240 } = {}) {
  let armedUntil = -1;
  let lastWheelAt = -Infinity;
  let ignoreWheelMomentum = false;
  let touchRevoked = false;
  let disconnected = false;
  const arm = () => { armedUntil = now() + intentMs; };
  const onStageScroll = () => {
    if (disconnected) return;
    // Consume this intent once; subsequent momentum/resize events cannot
    // re-enter after a center reveal or native Back acknowledgement.
    if (armedUntil >= now()) {
      armedUntil = -1;
      enterImmersive?.();
    }
    onScroll?.();
  };
  stage.addEventListener("scroll", onStageScroll, { passive: true });
  return {
    wheel() {
      const at = now();
      const continuation = at - lastWheelAt <= wheelQuietMs;
      lastWheelAt = at;
      // Wheel deltas already in flight at reveal must not instantly undo it.
      if (ignoreWheelMomentum && continuation) return false;
      ignoreWheelMomentum = false;
      arm();
      return true;
    },
    touchStart() { touchRevoked = false; },
    touchDrag() { if (touchRevoked) return false; arm(); return true; },
    keyboard() { arm(); },
    scrollbar() { arm(); },
    reveal() {
      armedUntil = -1;
      touchRevoked = true; // requires a fresh touchstart after reveal
      ignoreWheelMomentum = now() - lastWheelAt <= wheelQuietMs;
    },
    disconnect() {
      disconnected = true;
      armedUntil = -1;
      stage.removeEventListener("scroll", onStageScroll);
    },
  };
}

// The middle 60% toggles the HUD; only the outer 20% on either side turns
// pages (or scrolls the strip). These ratios work in portrait and landscape.
export function clickAction(x, width, mode) {
  if (!(width > 0)) return "bars";
  const fraction = x / width;
  if (fraction >= 0.2 && fraction <= 0.8) return "bars";
  const left = fraction < 0.2;
  return (mode.direction === "rtl") === left ? "next" : "prev";
}

// Prevent a native click generated after a drag, scroll or pinch from acting as
// a page tap. Pointer-up also measures movement: a short gesture may have no
// pointermove sample before the browser dispatches pointerup and click.
export function createReaderTapGuard({ now = Date.now, travel = 12, quietMs = 350 } = {}) {
  let pointer = null;
  let blockedUntil = -Infinity;
  const suppress = () => { pointer = null; blockedUntil = now() + quietMs; };
  const traveled = (event) => pointer && event.pointerId === pointer.id
    && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > travel;
  return {
    pointerDown(event) {
      if (event.isPrimary === false) { suppress(); return; }
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    pointerMove(event) { if (traveled(event)) suppress(); },
    pointerUp(event) {
      if (traveled(event)) suppress();
      else if (pointer?.id === event.pointerId) pointer = null;
    },
    pointerCancel: suppress,
    multiTouch: suppress,
    scroll: suppress,
    suppress,
    blocked: () => now() < blockedUntil,
  };
}

// Mouse wheel on pages (user, 2026-11-01): reading left to right, wheel up moves forward;
// right to left, wheel down does. A sideways swipe on a touchpad moves the way it points
// (right goes forward when reading left to right). overflow: the page is taller than the
// window; it scrolled to its edge first, and turns the natural way (down at the bottom
// goes forward), so reading down a tall page never jumps back.
export function wheelAction({ deltaX = 0, deltaY = 0 } = {}, mode, { overflow = false } = {}) {
  const ltr = mode.direction !== "rtl";
  if (Math.abs(deltaX) > Math.abs(deltaY)) return (deltaX > 0) === ltr ? "next" : "prev";
  if (!deltaY) return null;
  if (overflow) return deltaY > 0 ? "next" : "prev";
  return (deltaY < 0) === ltr ? "next" : "prev";
}

// Reader brightness increases to the right: 100 is unchanged, 0 is 40%
// brightness. Old Dim 0..100 decreased brightness in the opposite direction.
// Existing stored values migrate to the exact same effective luminance.
export function normalizeComfort(value = {}) {
  const clamp = (n, fallback) => Number.isFinite(Number(n))
    ? Math.max(0, Math.min(100, Math.round(Number(n)))) : fallback;
  const brightness = value?.brightness !== undefined && value?.brightness !== null
    ? clamp(value.brightness, 100) : 100 - clamp(value?.dim, 0);
  // A negative temperature cools the page, positive warms it. Older saved
  // warmth values used 0..100 and retain their meaning when first loaded.
  const savedTemperature = value?.temperature ?? value?.warm ?? 0;
  const temperature = Number.isFinite(Number(savedTemperature))
    ? Math.max(-100, Math.min(100, Math.round(Number(savedTemperature)))) : 0;
  return { brightness, theme: THEMES.includes(value?.theme) ? value.theme : "black", temperature };
}

export function colorTemperatureFilter(value = 0) {
  const amount = Number.isFinite(Number(value)) ? Math.min(1, Math.abs(Number(value)) / 100) : 0;
  if (!amount) return "";
  const tint = Number((amount * 0.34).toFixed(3));
  const saturation = Number((1 + amount * 0.18).toFixed(3));
  return `sepia(${tint}) saturate(${saturation}) hue-rotate(${Number(value) < 0 ? 165 : -18}deg)`;
}

export function comfortFilter(value = {}) {
  const { brightness } = normalizeComfort(value);
  const factor = Number((0.4 + brightness * 0.006).toFixed(3));
  return { brightness: factor, active: factor < 1 };
}

// Serialized local source navigation: the target's metadata must be verified
// before the current reader is replaced. A newer click, source change or
// closing the old reader invalidates every outstanding async preflight.
export function createReaderUnitTransition({
  currentUnit, getWorkId, loadUnit, navigate, onError = () => {},
  onBusy = () => {}, isCurrentReader = () => true,
} = {}) {
  if (typeof currentUnit !== "function" || typeof getWorkId !== "function"
    || typeof loadUnit !== "function" || typeof navigate !== "function")
    throw new TypeError("Reader transition requires exact unit identity, work and navigation callbacks");
  let sequence = 0, pending = null, closed = false;
  const validId = id => typeof id === "string" && /^f[0-9a-f]{16}$/.test(id);
  const fail = (error, when) => {
    if (when !== sequence || closed || !isCurrentReader()) return false;
    pending = null; onBusy(false);
    onError(error?.message || "Could not open the selected chapter. Your current page is unchanged.");
    return false;
  };
  return {
    get busy() { return pending !== null; },
    get target() { return pending; },
    async open(targetId, options = {}) {
      if (closed || !isCurrentReader()) return false;
      const from = currentUnit(), work = getWorkId();
      if (!validId(targetId) || targetId === from || typeof work !== "string" || !work)
        return fail(new Error("This adjacent chapter is unavailable."), ++sequence);
      if (pending === targetId) return false;
      const generation = ++sequence;
      pending = targetId;
      onBusy(true);
      try {
        const info = await loadUnit(targetId);
        if (generation !== sequence || closed || !isCurrentReader()
            || currentUnit() !== from || getWorkId() !== work) return false;
        if (!info || info.workId !== work || info.file?.id !== targetId
            || !(Number.isSafeInteger(Number(info.pages)) && Number(info.pages) > 0))
          return fail(new Error("This chapter is not ready or no longer belongs to this series."), generation);
        const moved = await navigate(targetId, info, {
          ...options,
          isCurrent: () => generation === sequence && !closed && isCurrentReader()
            && currentUnit() === from && getWorkId() === work,
        });
        if (generation !== sequence || closed || !isCurrentReader()) return false;
        if (moved === false) return fail(new Error("The selected chapter could not be opened."), generation);
        pending = null;
        onBusy(false);
        return true;
      } catch (error) { return fail(error, generation); }
    },
    cancel() { sequence++; pending = null; if (!closed) onBusy(false); },
    close() { closed = true; sequence++; pending = null; },
  };
}
