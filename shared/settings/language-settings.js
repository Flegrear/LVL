// Pure preference helpers; persistence and settings controls are owned by app.js.
export const LANGUAGE_DEFAULT_LOCALES = Object.freeze({
  EN: "en-US", ES: "es", FR: "fr-FR", DE: "de-DE", IT: "it-IT", PT: "pt-BR",
  JA: "ja-JP", KO: "ko-KR", ZH: "zh-CN", RU: "ru-RU", NL: "nl-NL", PL: "pl-PL", TR: "tr-TR",
});

export const LEARNING_LOCALE_VARIANTS = Object.freeze({
  ES: Object.freeze(["es", "es-ES", "es-AR"]),
  EN: Object.freeze(["en-US", "en-GB"]),
  PT: Object.freeze(["pt-BR", "pt-PT"]),
  FR: Object.freeze(["fr-FR", "fr-CA"]),
});

const LOCALE_LABELS = Object.freeze({
  es: "Spanish - Neutral", "es-ES": "Spanish - Spain", "es-AR": "Spanish - Argentina",
  "en-US": "English - United States", "en-GB": "English - United Kingdom",
  "pt-BR": "Portuguese - Brazil", "pt-PT": "Portuguese - Portugal",
  "fr-FR": "French - France", "fr-CA": "French - Canada",
  "de-DE": "German", "it-IT": "Italian", "ja-JP": "Japanese", "ko-KR": "Korean",
  "zh-CN": "Chinese", "ru-RU": "Russian", "nl-NL": "Dutch", "pl-PL": "Polish", "tr-TR": "Turkish",
});

export function normalizeLanguageCode(value, fallback = "EN") {
  const code = String(value || "").trim().split(/[-_]/)[0].toUpperCase();
  if (Object.hasOwn(LANGUAGE_DEFAULT_LOCALES, code)) return code;
  const defaultCode = String(fallback || "EN").trim().split(/[-_]/)[0].toUpperCase();
  return Object.hasOwn(LANGUAGE_DEFAULT_LOCALES, defaultCode) ? defaultCode : "EN";
}

export function learningLocaleOptions(language) {
  const code = normalizeLanguageCode(language);
  return (LEARNING_LOCALE_VARIANTS[code] || [LANGUAGE_DEFAULT_LOCALES[code]]).map((value) => ({
    value, label: LOCALE_LABELS[value], key: LOCALE_LABELS[value],
  }));
}

export function normalizeLearningLocale(language, locale) {
  const code = normalizeLanguageCode(language);
  const requested = String(locale || "").trim().replaceAll("_", "-").toLowerCase();
  return learningLocaleOptions(code).find((item) => item.value.toLowerCase() === requested)?.value
    || LANGUAGE_DEFAULT_LOCALES[code];
}

export function speechLocaleFor(language, targetLanguage, targetLocale) {
  const code = normalizeLanguageCode(language);
  return normalizeLearningLocale(code, code === normalizeLanguageCode(targetLanguage) ? targetLocale : "");
}

export function resolveInterfaceLanguage(preference = "auto", baseLanguage = "EN") {
  const choice = String(preference || "auto").trim().toLowerCase();
  if (choice === "en" || choice === "es") return choice;
  return normalizeLanguageCode(baseLanguage) === "ES" ? "es" : "en";
}
