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

// Keyboard → action. Arrow keys follow the reading direction.
export function keyAction(event, mode) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const forward = mode.direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  const back = mode.direction === "rtl" ? "ArrowRight" : "ArrowLeft";
  if (mode.layout !== "vertical") {
    if (event.key === forward || event.key === "PageDown" || (event.code === "Space" && !event.shiftKey)) return "next";
    if (event.key === back || event.key === "PageUp" || (event.code === "Space" && event.shiftKey)) return "prev";
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

// Click on the left or right third turns the page; the middle toggles the bars.
export function clickAction(x, width, mode) {
  if (!(width > 0)) return "bars";
  const third = x / width;
  if (third > 1 / 3 && third < 2 / 3) return "bars";
  const left = third <= 1 / 3;
  return (mode.direction === "rtl") === left ? "next" : "prev";
}

// Warm: scale down blue (and a little green); Dim: brightness. Values 0..100.
export function comfortFilter({ warm = 0, dim = 0 } = {}) {
  const w = Math.max(0, Math.min(100, Number(warm) || 0)) / 100;
  const d = Math.max(0, Math.min(100, Number(dim) || 0)) / 100;
  return {
    matrix: `1 0 0 0 0  0 ${(1 - 0.18 * w).toFixed(3)} 0 0 0  0 0 ${(1 - 0.62 * w).toFixed(3)} 0 0  0 0 0 1 0`,
    brightness: Number((1 - 0.6 * d).toFixed(3)),
    active: w > 0 || d > 0,
  };
}

// "Warm at night": on from 20:00 to 07:00 local time.
export const isNight = (date = new Date()) => date.getHours() >= 20 || date.getHours() < 7;

export function normalizeComfort(value = {}) {
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  return { warm: clamp(value.warm), dim: clamp(value.dim), theme: THEMES.includes(value.theme) ? value.theme : "black", night: value.night === true };
}
