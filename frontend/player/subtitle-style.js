// Subtitle appearance.
import { state } from "../../app.js";
import { persistPreferences } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { updatePlayerPreferenceButtons } from "./player-core.js";
import { ensureCurrentRomanization, renderSubtitles } from "./subtitle-display.js";
import { renderEmbeddedSubtitleControls } from "./embedded-subtitles.js";

export const subtitleStyleDefaults = {
  font: "sans",
  weight: 700,
  size: 100,
  shadow: 40,
  background: 0,
  color: "#ffffff",
  position: 16,
  secondary: 82,
  romanization: true,
};

const subtitleFontGroups = [
  { label: "Sans-serif", fonts: [
    ["sans", "Inter", 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'],
    ["segoe", "Segoe UI", '"Segoe UI", Arial, sans-serif'],
    ["arial", "Arial", 'Arial, "Helvetica Neue", sans-serif'],
    ["verdana", "Verdana", 'Verdana, Geneva, sans-serif'],
    ["trebuchet", "Trebuchet MS", '"Trebuchet MS", Arial, sans-serif'],
    ["tahoma", "Tahoma", 'Tahoma, Geneva, sans-serif'],
    ["noto-sans", "Noto Sans", '"Noto Sans", "Noto Sans CJK JP", "Yu Gothic", sans-serif'],
  ] },
  { label: "Serif", fonts: [
    ["serif", "Georgia", 'Georgia, "Times New Roman", serif'],
    ["times", "Times New Roman", '"Times New Roman", Times, serif'],
    ["palatino", "Palatino", '"Palatino Linotype", Palatino, serif'],
    ["noto-serif", "Noto Serif", '"Noto Serif", "Noto Serif CJK JP", Georgia, serif'],
  ] },
  { label: "Monospace", fonts: [
    ["mono", "Consolas", 'Consolas, "SFMono-Regular", "Liberation Mono", monospace'],
    ["courier", "Courier New", '"Courier New", Courier, monospace'],
    ["lucida", "Lucida Console", '"Lucida Console", Monaco, monospace'],
  ] },
  { label: "Display", fonts: [
    ["impact", "Impact", 'Impact, "Arial Narrow", sans-serif'],
    ["franklin", "Franklin Gothic", '"Franklin Gothic Medium", "Arial Narrow", Arial, sans-serif'],
  ] },
];
function subtitleFontFamily(value) {
  return subtitleFontGroups.flatMap((group) => group.fonts).find(([id]) => id === value)?.[2]
    || subtitleFontGroups[0].fonts[0][2];
}

function subtitleShadowAmount(value) {
  // Earlier releases saved a named preset. Keep those settings when upgrading.
  if (value === "none") return 0;
  if (value === "soft") return 40;
  if (value === "strong") return 85;
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function subtitleShadowValue(value) {
  const amount = subtitleShadowAmount(value);
  if (!amount) return "none";
  const strength = amount / 100;
  return `0 ${Math.round(1 + strength * 2)}px ${Math.round(2 + strength * 7)}px rgba(0,0,0,${(strength * .95).toFixed(2)}), 0 1px ${Math.round(1 + strength * 2)}px rgba(0,0,0,${strength.toFixed(2)})`;
}

function populateSubtitleFontOptions() {
  const select = $("#subtitle-style-font");
  if (!select || select.options.length) return;
  subtitleFontGroups.forEach((group) => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    group.fonts.forEach(([id, label]) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      optgroup.append(option);
    });
    select.append(optgroup);
  });
}

export function renderSubtitleStyleControls() {
  const style = state.subtitleStyle;
  populateSubtitleFontOptions();
  const values = {
    "#subtitle-style-font": style.font || subtitleStyleDefaults.font,
    "#subtitle-style-weight": String(style.weight || subtitleStyleDefaults.weight),
    "#subtitle-style-size": String(style.size),
    "#subtitle-style-shadow": String(subtitleShadowAmount(style.shadow)),
    "#subtitle-style-background": String(style.background),
    "#subtitle-style-position": String(Math.max(5, Math.min(70, Number(style.position) || subtitleStyleDefaults.position))),
    "#subtitle-style-color": style.color || subtitleStyleDefaults.color,
  };
  Object.entries(values).forEach(([selector, value]) => {
    const input = $(selector);
    if (input && document.activeElement !== input) {
      input.value = value;
      if (selector === "#subtitle-style-font" && !input.value) input.value = subtitleStyleDefaults.font;
    }
  });
  const romanization = $("#subtitle-style-romanization");
  if (romanization && document.activeElement !== romanization) romanization.checked = style.romanization !== false;
  if ($("#subtitle-style-size-value")) $("#subtitle-style-size-value").textContent = `${style.size}%`;
  if ($("#subtitle-style-shadow-value")) $("#subtitle-style-shadow-value").textContent = `${subtitleShadowAmount(style.shadow)}%`;
  if ($("#subtitle-style-background-value")) $("#subtitle-style-background-value").textContent = `${style.background}%`;
  if ($("#subtitle-style-position-value")) $("#subtitle-style-position-value").textContent = `${Math.max(5, Math.min(70, Number(style.position) || subtitleStyleDefaults.position))}% from bottom`;
  renderEmbeddedSubtitleControls();
}

export function applySubtitleStyle({ save = false } = {}) {
  const style = state.subtitleStyle;
  const root = document.documentElement;
  const primaryPx = Math.round(25 * (Number(style.size) / 100));
  const secondaryPx = Math.max(12, Math.round(primaryPx * (Number(style.secondary) / 100)));
  root.style.setProperty("--subtitle-font", subtitleFontFamily(style.font));
  root.style.setProperty("--subtitle-weight", String(style.weight));
  root.style.setProperty("--subtitle-primary-size", `${primaryPx}px`);
  root.style.setProperty("--subtitle-secondary-size", `${secondaryPx}px`);
  root.style.setProperty("--subtitle-shadow", subtitleShadowValue(style.shadow));
  root.style.setProperty("--subtitle-bg", `rgba(0,0,0,${Math.max(0, Math.min(85, Number(style.background))) / 100})`);
  root.style.setProperty("--subtitle-color", /^#[0-9a-f]{6}$/i.test(String(style.color || "")) ? style.color : subtitleStyleDefaults.color);
  root.style.setProperty("--subtitle-bottom", `${Math.max(5, Math.min(70, Number(style.position) || subtitleStyleDefaults.position))}%`);
  if (save) {
    localStorage.setItem("blackline-subtitle-style", JSON.stringify(style));
    persistPreferences();
  }
  renderSubtitleStyleControls();
}

export function readSubtitleStyleControls() {
  const font = $("#subtitle-style-font")?.value || subtitleStyleDefaults.font;
  state.subtitleStyle = {
    ...state.subtitleStyle,
    font,
    weight: Number($("#subtitle-style-weight")?.value) || subtitleStyleDefaults.weight,
    size: Number($("#subtitle-style-size")?.value) || subtitleStyleDefaults.size,
    shadow: subtitleShadowAmount($("#subtitle-style-shadow")?.value),
    background: Number($("#subtitle-style-background")?.value) || 0,
    position: Math.max(5, Math.min(70, Number($("#subtitle-style-position")?.value) || subtitleStyleDefaults.position)),
    color: $("#subtitle-style-color")?.value || subtitleStyleDefaults.color,
    romanization: $("#subtitle-style-romanization")?.checked !== false,
  };
  applySubtitleStyle({ save: true });
  updatePlayerPreferenceButtons();
  if (state.subtitleStyle.romanization) ensureCurrentRomanization();
  renderSubtitles();
}

export function openSubtitleStyleDialog() {
  renderSubtitleStyleControls();
  $("#subtitle-style-dialog")?.showModal();
}
