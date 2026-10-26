// ui.js: markup builders and small DOM behaviors for the LVL design system.
//
// Builders return HTML strings with every dynamic value escaped, so the same code renders the
// app and runs under Node tests. Behaviors (bind*, toast) only touch
// the DOM when they are called, never at import time.
import { t, UI_TRANSLATIONS } from "./ui-i18n.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ESCAPES[char]);
}

function attrs(map = {}) {
  return Object.entries(map)
    .filter(([key, value]) => /^[a-z][a-z0-9:_-]*$/i.test(key) && value !== undefined && value !== null && value !== false)
    .map(([key, value]) => (value === true || value === "" ? ` ${key}` : ` ${key}="${escapeHtml(value)}"`))
    .join("");
}

// UI factories opt in only exact catalogue strings. Unknown text stays unchanged. Callers can
// opt out with i18n:false, or use {label/title/text/tooltip/content: key, params:{...}} for templates.
function uiField(value, i18n = true, field = "label") {
  const option = i18n && typeof i18n === "object" ? i18n[field] ?? true : i18n;
  const key = typeof option === "string" ? option : String(value ?? "");
  const params = i18n && typeof i18n === "object" ? i18n.params || {} : {};
  if (option === false || !Object.hasOwn(UI_TRANSLATIONS.en, key)) return { text: value, annotation: {} };
  return {
    text: t(key, params),
    annotation: { "data-i18n": key, ...(Object.keys(params).length ? { "data-i18n-params": JSON.stringify(params) } : {}) },
  };
}

function uiAttributes(map = {}, i18n = true) {
  const result = { ...map };
  for (const [attribute, field] of [["title", "title"], ["aria-label", "label"], ["data-tooltip", "tooltip"], ["data-ui-tooltip", "tooltip"]]) {
    if (!map[attribute]) continue;
    const annotation = `data-i18n-${attribute.replace(/^data-/, "")}`;
    const translated = uiField(map[attribute], i18n, field);
    if (!translated.annotation["data-i18n"]) continue;
    result[attribute] = translated.text;
    result[annotation] = map[annotation] || translated.annotation["data-i18n"];
    if (translated.annotation["data-i18n-params"]) result["data-i18n-params"] = translated.annotation["data-i18n-params"];
  }
  return result;
}

/* ---------------------------------------------------------------- Icons */

const ICON_PATHS = Object.freeze({
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.1"/>',
  play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.9-6.2a.8.8 0 0 0 0-1.4L9.2 5.1a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  "chevron-left": '<path d="m14.5 6-6 6 6 6"/>',
  "chevron-right": '<path d="m9.5 6 6 6-6 6"/>',
  "chevron-down": '<path d="m6 9.5 6 6 6-6"/>',
  shuffle: '<path d="M4 17h2.7c1.6 0 3-.8 3.9-2.2l2.8-5.6c.9-1.4 2.3-2.2 3.9-2.2H20"/><path d="m17 4.5 3 2.5-3 2.5"/><path d="M4 7h2.7c1.3 0 2.5.5 3.3 1.5"/><path d="M14 15.5c.8 1 2 1.5 3.3 1.5H20"/><path d="m17 14.5 3 2.5-3 2.5"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  star: '<path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.3v.1"/>',
  refresh: '<path d="M19.5 11A7.5 7.5 0 1 0 17.3 17"/><path d="M19.5 4.5V11H13"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M8 5v14M16 5v14"/>',
  tv: '<rect x="3" y="6.5" width="18" height="12" rx="2"/><path d="m9 3 3 3.5L15 3"/>',
  sparkle: '<path d="M12 3.5 13.9 10l6.6 2-6.6 2L12 20.5 10.1 14 3.5 12l6.6-2z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.3 3.5 5.1 3.5 8.5s-1.2 6.2-3.5 8.5c-2.3-2.3-3.5-5.1-3.5-8.5s1.2-6.2 3.5-8.5z"/>',
  subtitles: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6.5 11h4.5M13.5 11h4M6.5 15h7"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20 15.5-4.5-4.5L7 19"/>',
  edit: '<path d="M15.2 5.3 18.7 8.8 9 18.5H5.5V15z"/><path d="m13.2 7.3 3.5 3.5"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>',
  more: '<circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  library: '<path d="M5 4.5v15M9.5 4.5v15"/><path d="m13.5 5.2 3.8-1 3.2 14.6-3.8 1z"/>',
  bookmark: '<path d="M7 4.5h10v15l-5-3.5-5 3.5z"/>',
});

export const ICON_NAMES = Object.freeze(Object.keys(ICON_PATHS));

export function icon(name, { className = "" } = {}) {
  const paths = ICON_PATHS[name];
  if (!paths) return "";
  return `<svg class="ui-icon${className ? ` ${escapeHtml(className)}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/* ---------------------------------------------------------------- Artwork */

// Monochrome placeholder art (initials) used when a title has no image or the image fails.
export function artworkFallback(title, { ratio = "poster", label = "" } = {}) {
  const bare = String(title || "").replace(/\s+\[[^\]]+\]\s*$/, "").trim() || "Untitled";
  const initials = bare.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => (Array.from(word)[0] || "").toUpperCase()).join("");
  const wide = ratio === "wide";
  const width = wide ? 320 : 200;
  const height = wide ? 180 : 300;
  const caption = String(label || "").toUpperCase().slice(0, 18);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#161616"/><stop offset="1" stop-color="#050505"/></linearGradient></defs>`
    + `<rect width="${width}" height="${height}" fill="url(#g)"/>`
    + `<text x="${width / 2}" y="${height / 2 + (wide ? 15 : 20)}" text-anchor="middle" fill="#d8d8d8" font-family="Inter,Segoe UI,Arial,sans-serif" font-weight="700" font-size="${wide ? 44 : 58}" letter-spacing="-2">${escapeHtml(initials)}</text>`
    + (caption ? `<text x="${width / 2}" y="${height - 22}" text-anchor="middle" fill="#8f8f8f" font-family="Consolas,monospace" font-size="10" letter-spacing="3">${escapeHtml(caption)}</text>` : "")
    + "</svg>";
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* ---------------------------------------------------------------- Primitives */

export function formatRatingValue(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 && number <= 10 ? number.toFixed(1) : "";
}

function metaParts(parts) {
  return (Array.isArray(parts) ? parts : [parts]).map((part) => String(part ?? "").trim()).filter(Boolean);
}

export function metaMarkup(parts = [], { rating = "" } = {}) {
  const items = metaParts(parts).map((part) => `<span>${escapeHtml(part)}</span>`);
  const score = formatRatingValue(rating);
  if (score) items.push(`<span class="ui-rating">${icon("star")}<span class="ui-visually-hidden">IMDb rating </span>${score}</span>`);
  return items.length ? `<span class="ui-meta">${items.join("")}</span>` : "";
}

function metaLabel(parts = [], rating = "") {
  const score = formatRatingValue(rating);
  return [...metaParts(parts), score ? `rated ${score}` : ""].filter(Boolean).join(", ");
}

export function buttonMarkup({ label = "", variant = "secondary", size = "", icon: iconName = "", iconAfter = "", block = false, className = "", type = "button", attrs: extra = {}, i18n = true } = {}) {
  const classes = ["ui-btn", `ui-btn--${variant}`, size ? `ui-btn--${size}` : "", block ? "ui-btn--block" : "", className].filter(Boolean).join(" ");
  const translated = uiField(label, i18n);
  return `<button class="${escapeHtml(classes)}" type="${escapeHtml(type)}"${attrs(uiAttributes(extra, i18n))}>${iconName ? icon(iconName) : ""}<span${attrs(translated.annotation)}>${escapeHtml(translated.text)}</span>${iconAfter ? icon(iconAfter) : ""}</button>`;
}

export function iconButtonMarkup({ icon: iconName = "", label = "", variant = "", size = "", tooltip = "", tooltipPos = "", tooltipAlign = "", pressed, className = "", attrs: extra = {}, i18n = true } = {}) {
  const classes = ["ui-icon-btn", variant ? `ui-icon-btn--${variant}` : "", size ? `ui-icon-btn--${size}` : "", className].filter(Boolean).join(" ");
  const state = {
    "aria-label": label || undefined,
    "aria-pressed": pressed === undefined ? undefined : String(Boolean(pressed)),
    "data-ui-tooltip": tooltip || undefined,
    "data-ui-tooltip-pos": tooltip && tooltipPos ? tooltipPos : undefined,
    "data-ui-tooltip-align": tooltip && tooltipAlign ? tooltipAlign : undefined,
  };
  return `<button class="${escapeHtml(classes)}" type="button"${attrs(uiAttributes({ ...state, ...extra }, i18n))}>${icon(iconName)}</button>`;
}

export function badgeMarkup(text, { variant = "", icon: iconName = "", i18n = false } = {}) {
  const translated = uiField(text, i18n);
  return `<span class="ui-badge${variant ? ` ui-badge--${escapeHtml(variant)}` : ""}"${attrs(translated.annotation)}>${iconName ? icon(iconName) : ""}${escapeHtml(translated.text)}</span>`;
}

export function tabsMarkup(items = [], { active = "", label = "", controls = "", idPrefix = "ui-tab" } = {}) {
  const current = items.some((item) => item.value === active) ? active : items[0]?.value;
  const tabs = items.map((item) => {
    const selected = item.value === current;
    return `<button class="ui-tab" type="button" role="tab"${attrs({
      id: `${idPrefix}-${item.value}`,
      "data-value": item.value,
      "aria-selected": String(selected),
      "aria-controls": controls || undefined,
      tabindex: selected ? "0" : "-1",
    })}>${escapeHtml(item.label)}${item.count !== undefined ? `<span class="ui-tab__count">${escapeHtml(item.count)}</span>` : ""}</button>`;
  }).join("");
  return `<div class="ui-tabs" role="tablist"${attrs({ "aria-label": label || undefined })}>${tabs}</div>`;
}

// `action` is trusted markup built by the caller (usually buttonMarkup()).
export function emptyMarkup({ icon: iconName = "", title = "", text = "", action = "", compact = false, i18n = true } = {}) {
  const heading = uiField(title, i18n, "title");
  const body = uiField(text, i18n, "text");
  return `<div class="ui-empty${compact ? " ui-empty--compact" : ""}">`
    + (iconName ? `<span class="ui-empty__icon">${icon(iconName)}</span>` : "")
    + (title ? `<p class="ui-empty__title"${attrs(heading.annotation)}>${escapeHtml(heading.text)}</p>` : "")
    + (text ? `<p class="ui-empty__text"${attrs(body.annotation)}>${escapeHtml(body.text)}</p>` : "")
    + (action ? `<div class="ui-empty__action">${action}</div>` : "")
    + "</div>";
}

/* ---------------------------------------------------------------- Cards */

const POSTER_SIZES = "(max-width: 680px) 34vw, 190px";
const WIDE_SIZES = "(max-width: 680px) 66vw, 365px";
const CARD_VARIANTS = new Set(["poster", "wide"]);
const SHELF_VARIANTS = new Set(["poster", "wide"]);

export function cardLibraryActionMarkup(title, inLibrary) {
  return inLibrary
    ? iconButtonMarkup({ icon: "check", label: `${title} is in your Library`, variant: "solid", size: "sm", attrs: { "data-ui-action": "library" } })
    : iconButtonMarkup({ icon: "plus", label: `Add ${title} to your Library`, variant: "glass", size: "sm", attrs: { "data-ui-action": "add" } });
}

/**
 * item: { id?, key?, title, image?, imageSrcset?, backdrop?, backdropSrcset?, logo?, meta?: string[],
 *         rating?, description?, badge?, progress? (0..1) }
 * options.variant: "poster" (2:3) or "wide" (16:9 with logo + synopsis).
 * options.rank: 1-based position in a ranked row (Top 10). Adds a small tag on the artwork; the
 *   position is real content, so it also leads the accessible name ("Number 3: Title, …").
 * options.primaryAction: value of data-ui-action on the main hit area ("details" or "library").
 * options.bodyAction: optional independent action for the title/metadata below the poster;
 *   the poster retains primaryAction. Both are sibling buttons, never nested.
 * options.actionsMarkup: trusted markup for the top-right action slot instead of the Library button.
 */
export function cardMarkup(item = {}, { variant = "poster", inLibrary = false, actions = true, primaryAction = "details", bodyAction = "", eager = false, rank = 0, actionsMarkup = "" } = {}) {
  const kind = CARD_VARIANTS.has(variant) ? variant : "poster";
  const wide = kind === "wide";
  const title = String(item.title || "Untitled");
  const ratio = wide ? "wide" : "poster";
  const image = String((wide ? item.backdrop : item.image) || "");
  const srcset = image ? String((wide ? item.backdropSrcset : item.imageSrcset) || "") : "";
  const src = image || artworkFallback(title, { ratio, label: item.fallbackLabel || "" });
  const details = metaLabel(item.meta, item.rating);
  const position = Math.trunc(Number(rank)) || 0;
  const ranked = position >= 1;
  const label = `${ranked ? `Number ${position}: ` : ""}${title}${details ? `, ${details}` : ""}`;

  const imageFallback = String((wide ? item.backdropFallback : item.imageFallback) || "");
  const imageHtml = `<img class="ui-card__img"${attrs({
    src,
    srcset: srcset || undefined,
    sizes: srcset ? (wide ? WIDE_SIZES : POSTER_SIZES) : undefined,
    alt: "",
    loading: eager ? "eager" : "lazy",
    decoding: "async",
    "data-fallback": image ? ratio : undefined,
    "data-fallback-title": image ? title : undefined,
    "data-fallback-src": image && imageFallback && imageFallback !== image ? imageFallback : undefined,
  })} />`;
  const logoHtml = wide && item.logo ? `<img class="ui-card__logo"${attrs({ src: item.logo, alt: "", loading: "lazy", decoding: "async", "data-ui-logo": "", "data-fallback-src": item.logoFallback && item.logoFallback !== item.logo ? item.logoFallback : undefined })} />` : "";
  const captionHtml = wide ? `<span class="ui-card__caption" aria-hidden="true">${escapeHtml(title)}</span>` : "";
  const rankHtml = ranked ? `<span class="ui-card__rank" aria-hidden="true">${position}</span>` : "";
  const badgeHtml = item.badge ? `<span class="ui-card__badge">${badgeMarkup(item.badge)}</span>` : "";
  const progress = Number(item.progress);
  const progressHtml = Number.isFinite(progress) && progress > 0
    ? `<span class="ui-card__progress" aria-hidden="true"><span style="width:${Math.round(Math.min(1, progress) * 100)}%"></span></span>`
    : "";
  const meta = metaMarkup(item.meta, { rating: item.rating });
  const bodyContents = `<span class="ui-card__title">${escapeHtml(title)}</span>`
    + (meta ? `<span class="ui-card__meta">${meta}</span>` : "")
    + (wide && item.description ? `<span class="ui-card__text">${escapeHtml(item.description)}</span>` : "");
  const bodyHtml = bodyAction
    ? `<button class="ui-card__hit ui-card__body" type="button"${attrs({ "data-ui-action": bodyAction, "aria-label": `View ${title} details` })}>${bodyContents}</button>`
    : `<span class="ui-card__body">${bodyContents}</span>`;
  const classes = ["ui-card", `ui-card--${kind}`, inLibrary ? "is-in-library" : ""].filter(Boolean).join(" ");

  return `<article class="${classes}"${attrs({ "data-title-id": item.id || undefined, "data-series-key": item.key || undefined })}>`
    + `<button class="ui-card__hit" type="button"${attrs({ "data-ui-action": primaryAction, "aria-label": bodyAction && primaryAction === "resume" ? `Resume ${label}` : label })}>`
    + `<span class="ui-card__media">${imageHtml}${logoHtml}${captionHtml}<span class="ui-card__shade" aria-hidden="true"></span>${rankHtml}${badgeHtml}${progressHtml}</span>`
    + (bodyAction ? "" : bodyHtml)
    + "</button>"
    + (bodyAction ? bodyHtml : "")
    + (actions ? `<div class="ui-card__actions" data-ui-slot="library">${actionsMarkup || cardLibraryActionMarkup(title, inLibrary)}</div>` : "")
    + "</article>";
}

/* ---------------------------------------------------------------- Shelf (row) */

export function shelfMarkup({ id = "shelf", title = "", subtitle = "", variant = "poster", cards = [], empty = "" } = {}) {
  const safeId = String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "shelf";
  const kind = SHELF_VARIANTS.has(variant) ? variant : "poster";
  const titleId = `${safeId}-title`;
  const nav = cards.length
    ? `<div class="ui-shelf__nav">${iconButtonMarkup({ icon: "chevron-left", label: `Scroll ${title} back`, size: "sm", attrs: { "data-ui-shelf-prev": "", disabled: true } })}`
      + `${iconButtonMarkup({ icon: "chevron-right", label: `Scroll ${title} forward`, size: "sm", attrs: { "data-ui-shelf-next": "" } })}</div>`
    : "";
  const body = cards.length
    ? `<ul class="ui-shelf__track" role="list">${cards.map((card) => `<li class="ui-shelf__item">${card}</li>`).join("")}</ul>`
    : (empty || emptyMarkup({ title: "Nothing to show yet", compact: true }));
  return `<section class="ui-shelf ui-shelf--${kind}"${attrs({ id: safeId, "aria-labelledby": titleId })} data-ui-shelf>`
    + `<header class="ui-shelf__head"><h2 class="ui-shelf__title" id="${escapeHtml(titleId)}">${escapeHtml(title)}</h2>`
    + (subtitle ? `<span class="ui-shelf__sub">${escapeHtml(subtitle)}</span>` : "")
    + `${nav}</header>${body}</section>`;
}

export function skeletonShelfMarkup({ variant = "poster", count = 8 } = {}) {
  const kind = variant === "wide" ? "wide" : "poster";
  const items = Array.from({ length: Math.max(1, count) }, () => `<li class="ui-shelf__item"><span class="ui-skeleton ui-skeleton--${kind}"></span>`
    + `<span class="ui-skeleton ui-skeleton--text" style="width:72%;margin-top:12px"></span>`
    + `<span class="ui-skeleton ui-skeleton--text" style="width:44%;margin-top:8px"></span></li>`).join("");
  return `<section class="ui-shelf ui-shelf--${kind} ui-shelf--loading" aria-hidden="true"><header class="ui-shelf__head">`
    + `<span class="ui-skeleton ui-skeleton--title" style="width:200px"></span></header><ul class="ui-shelf__track" role="presentation">${items}</ul></section>`;
}

/* ---------------------------------------------------------------- Hero (billboard carousel) */

/**
 * slide: { id?, title, backdrop?, backdropSrcset?, logo?, meta?: string[],
 *          rating?, description?, actions?: string[] (trusted markup from buttonMarkup()) }
 */
export function heroMarkup(slides = [], { label = "Featured titles" } = {}) {
  if (!slides.length) return "";
  const total = slides.length;
  const slidesHtml = slides.map((slide, index) => heroSlideMarkup(slide, index, total)).join("");
  // The toggle stays hidden until bindHero() knows the carousel can auto-advance.
  const controls = total > 1
    ? `<div class="ui-hero__controls">`
      + iconButtonMarkup({ icon: "pause", label: "Pause featured titles", variant: "glass", size: "sm", attrs: { "data-ui-hero-toggle": "", hidden: true } })
      + `<div class="ui-hero__pips ui-pips" role="group" aria-label="${escapeHtml(`Choose one of ${total} ${label.toLowerCase()}`)}">${slides.map((slide, index) => `<button class="ui-pip" type="button"${attrs({
        "data-ui-hero-go": String(index),
        "aria-label": `Show ${slide.title || `slide ${index + 1}`}`,
        "aria-current": index === 0 ? "true" : "false",
      })}></button>`).join("")}</div></div>`
    : "";
  return `<div class="ui-hero__viewport">${slidesHtml}</div>${controls}`;
}

function heroSlideMarkup(slide, index, total) {
  const active = index === 0;
  const title = String(slide.title || "Untitled");
  const image = String(slide.backdrop || "");
  const src = image || artworkFallback(title, { ratio: "wide" });
  return `<article class="ui-hero__slide${active ? " is-active" : ""}"${attrs({
    "data-title-id": slide.id || undefined,
    role: "group",
    "aria-roledescription": "slide",
    "aria-label": `${index + 1} of ${total}: ${title}`,
    "aria-hidden": active ? undefined : "true",
    inert: active ? undefined : true,
  })}>`
    + `<div class="ui-hero__media" aria-hidden="true"><img class="ui-hero__backdrop"${attrs({
      src,
      srcset: image && slide.backdropSrcset ? slide.backdropSrcset : undefined,
      sizes: image && slide.backdropSrcset ? "100vw" : undefined,
      alt: "",
      decoding: "async",
      fetchpriority: active ? "high" : undefined,
      "data-fallback": image ? "wide" : undefined,
      "data-fallback-title": image ? title : undefined,
      "data-fallback-src": image && slide.backdropFallback && slide.backdropFallback !== image ? slide.backdropFallback : undefined,
    })} /></div>`
    + `<div class="ui-hero__shade" aria-hidden="true"></div>`
    + `<div class="ui-hero__content">`
    + `<h2 class="ui-hero__title">${slide.logo ? `<img class="ui-hero__logo"${attrs({ src: slide.logo, alt: "", decoding: "async", "data-ui-logo": "", "data-fallback-src": slide.logoFallback && slide.logoFallback !== slide.logo ? slide.logoFallback : undefined })} />` : ""}<span class="ui-hero__title-text">${escapeHtml(title)}</span></h2>`
    + metaMarkup(slide.meta, { rating: slide.rating })
    + (slide.description ? `<p class="ui-hero__synopsis">${escapeHtml(slide.description)}</p>` : "")
    + `<div class="ui-hero__actions">${(slide.actions || []).join("")}</div>`
    + "</div></article>";
}

export function heroLibraryButtonMarkup(inLibrary, savedLabel = "In Library") {
  return inLibrary
    ? buttonMarkup({ label: savedLabel || "In Library", variant: "primary", size: "lg", icon: "check", attrs: { "data-ui-action": "library", "data-ui-slot": "hero-library" } })
    : buttonMarkup({ label: "Add to Library", variant: "primary", size: "lg", icon: "plus", attrs: { "data-ui-action": "add", "data-ui-slot": "hero-library" } });
}

export function heroDetailsButtonMarkup() {
  return buttonMarkup({ label: "Details", variant: "glass", size: "lg", icon: "info", attrs: { "data-ui-action": "details" } });
}

export function skeletonHeroMarkup() {
  return `<div class="ui-hero__skeleton ui-skeleton" aria-hidden="true"></div>`
    + `<div class="ui-hero__content" aria-hidden="true">`
    + `<span class="ui-skeleton ui-skeleton--text" style="width:130px"></span>`
    + `<span class="ui-skeleton ui-skeleton--title" style="width:min(420px,70vw);height:56px"></span>`
    + `<div class="ui-hero__skeleton-lines"><span class="ui-skeleton ui-skeleton--text"></span><span class="ui-skeleton ui-skeleton--text" style="width:88%"></span><span class="ui-skeleton ui-skeleton--text" style="width:62%"></span></div>`
    + `<div class="ui-hero__actions"><span class="ui-skeleton ui-skeleton--button"></span><span class="ui-skeleton ui-skeleton--button"></span></div>`
    + "</div>";
}

/* ---------------------------------------------------------------- Behaviors */

export function prefersReducedMotion() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

// Tabs follow the WAI-ARIA tabs pattern: roving tabindex, arrows/Home/End, automatic activation.
export function setActiveTab(tablist, value) {
  tablist?.querySelectorAll('[role="tab"]').forEach((tab) => {
    const active = tab.dataset.value === value;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
}

export function bindTabs(tablist, { onChange } = {}) {
  if (!tablist || tablist.dataset.uiBound === "1") return;
  tablist.dataset.uiBound = "1";
  const tabs = () => [...tablist.querySelectorAll('[role="tab"]')].filter((tab) => !tab.hidden && !tab.disabled);
  const select = (tab, { focus = false } = {}) => {
    if (focus) tab.focus();
    if (tab.getAttribute("aria-selected") === "true") return;
    setActiveTab(tablist, tab.dataset.value);
    onChange?.(tab.dataset.value, tab);
  };
  tablist.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tablist.contains(tab)) select(tab);
  });
  tablist.addEventListener("keydown", (event) => {
    const list = tabs();
    const current = list.indexOf(event.target.closest('[role="tab"]'));
    if (current < 0) return;
    const next = {
      ArrowRight: list[(current + 1) % list.length],
      ArrowLeft: list[(current - 1 + list.length) % list.length],
      Home: list[0],
      End: list[list.length - 1],
    }[event.key];
    if (!next) return;
    event.preventDefault();
    select(next, { focus: true });
  });
}

// Single-select groups (segmented controls) and multi-select chips, driven by aria-pressed.
export function bindPressables(root = document) {
  root?.querySelectorAll?.("[data-ui-toggle-group]").forEach((group) => {
    if (group.dataset.uiBound === "1") return;
    group.dataset.uiBound = "1";
    const single = group.dataset.uiToggleGroup === "single";
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[aria-pressed]");
      if (!button || !group.contains(button)) return;
      if (single) group.querySelectorAll("button[aria-pressed]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      else button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
      group.dispatchEvent(new CustomEvent("ui-change", { bubbles: true, detail: { value: button.dataset.value || "" } }));
    });
  });
}

export function bindRanges(root = document) {
  root?.querySelectorAll?.("input.ui-range").forEach((input) => {
    const update = () => {
      const min = Number(input.min) || 0;
      const max = Number(input.max) || 100;
      const percent = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
      input.style.setProperty("--ui-range-fill", `${Math.max(0, Math.min(100, percent))}%`);
    };
    update();
    if (input.dataset.uiBound === "1") return;
    input.dataset.uiBound = "1";
    input.addEventListener("input", update);
  });
}

export function updateShelf(shelf) {
  const track = shelf?.querySelector(".ui-shelf__track");
  if (!track) return;
  const max = track.scrollWidth - track.clientWidth;
  const overflow = max > 2;
  shelf.classList.toggle("is-static", !overflow);
  const prev = shelf.querySelector("[data-ui-shelf-prev]");
  const next = shelf.querySelector("[data-ui-shelf-next]");
  if (prev) prev.disabled = !overflow || track.scrollLeft <= 2;
  if (next) next.disabled = !overflow || track.scrollLeft >= max - 2;
}

function shelfPage(track) {
  const item = track.querySelector(".ui-shelf__item");
  const style = getComputedStyle(track);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const step = item ? item.getBoundingClientRect().width + gap : 200;
  const visible = Math.max(1, Math.floor((track.clientWidth - padding + gap) / step));
  return visible * step;
}

const observedShelfRoots = new WeakSet();

function observeShelfRoot(root) {
  const target = root?.nodeType === 9 ? root.documentElement : root;
  if (typeof ResizeObserver === "undefined" || !target || target.nodeType !== 1 || observedShelfRoots.has(target)) return;
  observedShelfRoots.add(target);
  let frame = 0;
  new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      target.querySelectorAll("[data-ui-shelf]").forEach(updateShelf);
    });
  }).observe(target);
}

export function bindShelves(root = document) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll("[data-ui-shelf]").forEach((shelf) => {
    const track = shelf.querySelector(".ui-shelf__track");
    if (!track || shelf.dataset.uiBound === "1") {
      updateShelf(shelf);
      return;
    }
    shelf.dataset.uiBound = "1";
    shelf.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ui-shelf-prev], [data-ui-shelf-next]");
      if (!button || !shelf.contains(button)) return;
      const direction = button.hasAttribute("data-ui-shelf-prev") ? -1 : 1;
      track.scrollBy({ left: direction * shelfPage(track), behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
    let frame = 0;
    track.addEventListener("scroll", () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateShelf(shelf);
      });
    }, { passive: true });
    updateShelf(shelf);
  });
  observeShelfRoot(root);
}

// Auto-advancing billboard. Pauses while hovered/focused, off screen or in a hidden tab, and
// never auto-advances with reduced motion. Call destroy() before replacing the hero markup.
export function bindHero(hero, { interval = 8000 } = {}) {
  const noop = { go() {}, destroy() {} };
  if (!hero || typeof window === "undefined") return noop;
  const slides = [...hero.querySelectorAll(".ui-hero__slide")];
  const pips = [...hero.querySelectorAll("[data-ui-hero-go]")];
  if (!slides.length) return noop;
  const controller = new AbortController();
  const { signal } = controller;
  const reduced = prefersReducedMotion();
  const holds = new Set();
  let index = Math.max(0, slides.findIndex((slide) => slide.classList.contains("is-active")));
  let timer = 0;
  let startedAt = 0;
  let remaining = interval;
  hero.style.setProperty("--ui-hero-interval", `${interval}ms`);

  const canRun = () => slides.length > 1 && !reduced && holds.size === 0;
  const stopTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
  };
  const sync = () => {
    const running = canRun();
    hero.classList.toggle("is-paused", !running);
    if (!running) {
      stopTimer();
      return;
    }
    if (timer) return;
    startedAt = performance.now();
    timer = setTimeout(() => {
      timer = 0;
      go(index + 1);
    }, remaining);
  };
  const go = (next) => {
    stopTimer();
    index = ((next % slides.length) + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === index;
      slide.classList.toggle("is-active", active);
      slide.toggleAttribute("inert", !active);
      if (active) slide.removeAttribute("aria-hidden");
      else slide.setAttribute("aria-hidden", "true");
    });
    pips.forEach((pip, pipIndex) => {
      pip.setAttribute("aria-current", pipIndex === index ? "true" : "false");
      pip.classList.remove("is-running");
    });
    remaining = interval;
    const pip = pips[index];
    if (pip && slides.length > 1 && !reduced) {
      void pip.offsetWidth;
      pip.classList.add("is-running");
    }
    sync();
  };
  const hold = (reason, active) => {
    if (active) holds.add(reason);
    else holds.delete(reason);
    sync();
  };

  // WCAG 2.2.2: anything that moves on its own needs a visible way to stop it.
  const toggle = hero.querySelector("[data-ui-hero-toggle]");
  const syncToggle = () => {
    if (!toggle) return;
    const paused = holds.has("user");
    toggle.innerHTML = icon(paused ? "play" : "pause");
    toggle.setAttribute("aria-label", paused ? "Play featured titles" : "Pause featured titles");
    toggle.setAttribute("data-ui-tooltip", paused ? "Play" : "Pause");
  };
  if (toggle) {
    toggle.hidden = slides.length < 2 || reduced;
    syncToggle();
    toggle.addEventListener("click", () => {
      hold("user", !holds.has("user"));
      syncToggle();
    }, { signal });
  }

  hero.addEventListener("click", (event) => {
    const pip = event.target.closest("[data-ui-hero-go]");
    if (pip && hero.contains(pip)) go(Number(pip.dataset.uiHeroGo) || 0);
  }, { signal });
  // Hovering or focusing a slide's text or actions pauses it so they don't vanish mid-read.
  // The controls are excluded: they are how people pause, resume and switch slides.
  hero.querySelectorAll(".ui-hero__content").forEach((zone) => {
    zone.addEventListener("pointerenter", () => hold("hover", true), { signal });
    zone.addEventListener("pointerleave", () => hold("hover", false), { signal });
  });
  const focusInSlide = (node) => Boolean(node?.closest?.(".ui-hero__slide")) && hero.contains(node);
  hero.addEventListener("focusin", (event) => hold("focus", focusInSlide(event.target)), { signal });
  hero.addEventListener("focusout", (event) => {
    if (!focusInSlide(event.relatedTarget)) hold("focus", false);
  }, { signal });
  document.addEventListener("visibilitychange", () => hold("hidden", document.hidden), { signal });
  let observer = null;
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(([entry]) => hold("offscreen", !entry.isIntersecting), { threshold: 0.2 });
    observer.observe(hero);
  }
  if (document.hidden) holds.add("hidden");
  go(index);

  return {
    go: (next) => go(next),
    destroy() {
      controller.abort();
      observer?.disconnect();
      stopTimer();
    },
  };
}

// Images: a failed responsive variant first retries the exact URL the catalog listed
// (data-fallback-src); only then does artwork become the monochrome placeholder and a logo
// give way to the text title.
function applyImageFallback(img) {
  const retry = img.dataset.fallbackSrc;
  if (retry) {
    delete img.dataset.fallbackSrc;
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.src = retry;
    return;
  }
  if (img.hasAttribute("data-ui-logo")) {
    img.closest(".has-logo")?.classList.remove("has-logo");
    img.remove();
    return;
  }
  const ratio = img.dataset.fallback;
  if (!ratio) return;
  delete img.dataset.fallback;
  img.removeAttribute("srcset");
  img.removeAttribute("sizes");
  img.src = artworkFallback(img.dataset.fallbackTitle || "", { ratio });
}

function markLogoLoaded(img) {
  img.closest(".ui-hero__title, .ui-card__media")?.classList.add("has-logo");
}

let imageListenersInstalled = false;

export function installImageFallbacks(doc = globalThis.document) {
  if (imageListenersInstalled || !doc?.addEventListener) return;
  imageListenersInstalled = true;
  doc.addEventListener("error", (event) => {
    if (event.target?.tagName === "IMG") applyImageFallback(event.target);
  }, true);
  doc.addEventListener("load", (event) => {
    if (event.target?.tagName === "IMG" && event.target.hasAttribute("data-ui-logo")) markLogoLoaded(event.target);
  }, true);
}

// Catch images that finished (or failed) before installImageFallbacks() saw them.
export function refreshImages(root = globalThis.document) {
  root?.querySelectorAll?.("img[data-fallback], img[data-fallback-src], img[data-ui-logo]").forEach((img) => {
    if (!img.complete) return;
    if (img.naturalWidth === 0) applyImageFallback(img);
    else if (img.hasAttribute("data-ui-logo")) markLogoLoaded(img);
  });
}

let toastRegion = null;

/* ---------------------------------------------------------------- Help tips */

/**
 * A "?" button whose explanation shows on hover, keyboard focus or tap. `content` is trusted
 * markup built by the caller (escape dynamic values). The text also stays in the page, hidden,
 * as the button's description for screen readers.
 */
export function helpTipMarkup({ id = "", label = "More information", content = "", className = "", i18n = true } = {}) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]+/g, "-") || "ui-tip";
  const body = uiField(content, i18n, "content");
  const translatedContent = body.annotation["data-i18n"] ? escapeHtml(body.text) : content;
  return `<button class="ui-help${className ? ` ${escapeHtml(className)}` : ""}" type="button"${attrs(uiAttributes({ "data-ui-tip": safeId, "aria-label": label, "aria-describedby": safeId }, i18n))}>?</button>`
    + `<span class="ui-tip-content" id="${escapeHtml(safeId)}" hidden${attrs(body.annotation)}>${translatedContent}</span>`;
}

// Any element with data-ui-tip="<id of a hidden .ui-tip-content>" opens the floating tip. One
// panel is shared; it lives in the top-most open dialog (or the body) so containers that clip
// their overflow can't cut it, and it stays open while the pointer is over it (WCAG 1.4.13).
let tipPanel = null;
let tipTrigger = null;
let tipPinned = false;
let tipHideTimer = 0;
let tipShowTimer = 0;

function tipHost() {
  return [...document.querySelectorAll("dialog[open]")].pop() || document.body;
}

function placeTip(trigger) {
  const rect = trigger.getBoundingClientRect();
  const panel = tipPanel;
  panel.style.left = "0px";
  panel.style.top = "0px";
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const margin = 12;
  const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - margin));
  const below = rect.bottom + 10;
  const fitsBelow = below + height <= window.innerHeight - margin;
  const top = fitsBelow || rect.top - height - 10 < margin ? below : rect.top - height - 10;
  panel.dataset.side = fitsBelow || rect.top - height - 10 < margin ? "below" : "above";
  const wantLeft = Math.round(left);
  const wantTop = Math.round(Math.max(margin, top));
  panel.style.left = `${wantLeft}px`;
  panel.style.top = `${wantTop}px`;
  // Inside a transformed or contained ancestor, "fixed" is relative to that box: correct for it.
  const actual = panel.getBoundingClientRect();
  const dx = actual.left - wantLeft;
  const dy = actual.top - wantTop;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
    panel.style.left = `${Math.round(wantLeft - dx)}px`;
    panel.style.top = `${Math.round(wantTop - dy)}px`;
  }
}

function showTip(trigger) {
  const content = document.getElementById(trigger.dataset.uiTip || "");
  if (!content) return;
  window.clearTimeout(tipHideTimer);
  if (!tipPanel) {
    tipPanel = document.createElement("div");
    tipPanel.className = "ui-tip";
    tipPanel.setAttribute("role", "tooltip");
    tipPanel.id = "ui-tip-panel";
    tipPanel.addEventListener("pointerenter", () => window.clearTimeout(tipHideTimer));
    tipPanel.addEventListener("pointerleave", () => { if (!tipPinned) scheduleTipHide(); });
  }
  const host = tipHost();
  if (tipPanel.parentElement !== host) host.append(tipPanel);
  tipPanel.innerHTML = content.innerHTML;
  tipPanel.hidden = false;
  tipTrigger?.removeAttribute("aria-expanded");
  tipTrigger = trigger;
  if (trigger.classList.contains("ui-help")) trigger.setAttribute("aria-expanded", "true");
  placeTip(trigger);
}

function hideTip() {
  window.clearTimeout(tipShowTimer);
  window.clearTimeout(tipHideTimer);
  tipPinned = false;
  if (tipPanel) tipPanel.hidden = true;
  tipTrigger?.removeAttribute("aria-expanded");
  tipTrigger = null;
}

function scheduleTipHide(delay = 140) {
  window.clearTimeout(tipHideTimer);
  tipHideTimer = window.setTimeout(hideTip, delay);
}

let tipsInstalled = false;

export function installTips(doc = globalThis.document) {
  if (tipsInstalled || !doc?.addEventListener) return;
  tipsInstalled = true;
  const triggerOf = (target) => target?.closest?.("[data-ui-tip]") || null;
  doc.addEventListener("pointerover", (event) => {
    const trigger = triggerOf(event.target);
    if (!trigger || event.pointerType === "touch") return;
    window.clearTimeout(tipHideTimer);
    if (trigger === tipTrigger) return;
    window.clearTimeout(tipShowTimer);
    tipShowTimer = window.setTimeout(() => showTip(trigger), 120);
  });
  doc.addEventListener("pointerout", (event) => {
    const trigger = triggerOf(event.target);
    if (!trigger || trigger.contains(event.relatedTarget) || tipPanel?.contains(event.relatedTarget)) return;
    window.clearTimeout(tipShowTimer);
    if (trigger === tipTrigger && !tipPinned && doc.activeElement !== trigger) scheduleTipHide();
  });
  doc.addEventListener("focusin", (event) => {
    const trigger = triggerOf(event.target);
    if (trigger && event.target === trigger) showTip(trigger);
  });
  doc.addEventListener("focusout", (event) => {
    const trigger = triggerOf(event.target);
    if (trigger && trigger === tipTrigger && !tipPinned) scheduleTipHide();
  });
  doc.addEventListener("click", (event) => {
    const trigger = triggerOf(event.target);
    if (trigger) {
      if (trigger.tagName === "BUTTON" && trigger.classList.contains("ui-help")) event.preventDefault();
      if (trigger === tipTrigger && tipPinned) { hideTip(); return; }
      showTip(trigger);
      tipPinned = true;
      return;
    }
    if (tipPinned && !tipPanel?.contains(event.target)) hideTip();
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tipTrigger) {
      // Close the tip first; a second Escape reaches the dialog.
      event.stopPropagation();
      event.preventDefault();
      hideTip();
    }
  }, true);
  window.addEventListener("scroll", () => { if (tipTrigger && !tipPinned) hideTip(); else if (tipTrigger) placeTip(tipTrigger); }, { passive: true, capture: true });
  window.addEventListener("resize", () => { if (tipTrigger) placeTip(tipTrigger); });
}

export function toast(message, { tone = "default", timeout = 3600 } = {}) {
  if (typeof document === "undefined") return { dismiss() {} };
  if (!toastRegion) {
    toastRegion = document.createElement("div");
    toastRegion.className = "ui-toast-region";
    toastRegion.setAttribute("role", "status");
    toastRegion.setAttribute("aria-live", "polite");
  }
  // A modal dialog makes the rest of the page inert, so show the toast inside the top-most one.
  const host = [...document.querySelectorAll("dialog[open]")].pop() || document.body;
  if (toastRegion.parentElement !== host) host.append(toastRegion);
  const node = document.createElement("div");
  node.className = `ui-toast${tone === "error" ? " ui-toast--error" : ""}`;
  node.innerHTML = `${icon(tone === "error" ? "alert" : "check")}<span class="ui-toast__text"></span>`;
  node.querySelector(".ui-toast__text").textContent = String(message ?? "");
  toastRegion.append(node);
  while (toastRegion.children.length > 3) toastRegion.firstElementChild.remove();
  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 220);
  };
  const timer = setTimeout(dismiss, timeout);
  return {
    dismiss() {
      clearTimeout(timer);
      dismiss();
    },
  };
}
