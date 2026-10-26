import test from "node:test";
import assert from "node:assert/strict";
import * as settings from "../shared/settings/language-settings.js";

test("language codes stay independent of regional speech locales", () => {
  assert.equal(settings.normalizeLanguageCode(" es-AR "), "ES");
  assert.equal(settings.normalizeLanguageCode("pt_pt"), "PT");
  assert.equal(settings.normalizeLanguageCode("unknown", "JA"), "JA");
  assert.equal(settings.normalizeLanguageCode(null), "EN");
});

test("learning accents cover the supported broad language variants", () => {
  assert.deepEqual(settings.learningLocaleOptions("ES").map((item) => item.value), ["es", "es-ES", "es-AR"]);
  assert.deepEqual(settings.learningLocaleOptions("EN").map((item) => item.value), ["en-US", "en-GB"]);
  assert.deepEqual(settings.learningLocaleOptions("PT").map((item) => item.value), ["pt-BR", "pt-PT"]);
  assert.deepEqual(settings.learningLocaleOptions("FR").map((item) => item.value), ["fr-FR", "fr-CA"]);
  assert.deepEqual(settings.learningLocaleOptions("JA").map((item) => item.value), ["ja-JP"]);
});

test("invalid or unrelated locale preferences fall back to that language", () => {
  assert.equal(settings.normalizeLearningLocale("ES", "ES_ar"), "es-AR");
  assert.equal(settings.normalizeLearningLocale("ES", "en-US"), "es");
  assert.equal(settings.normalizeLearningLocale("EN", "en-AU"), "en-US");
  assert.equal(settings.normalizeLearningLocale("PT", ""), "pt-BR");
  assert.equal(settings.normalizeLearningLocale("FR", "fr-ca"), "fr-CA");
});

test("speech uses the selected target accent without changing other languages", () => {
  assert.equal(settings.speechLocaleFor("ES", "ES", "es-AR"), "es-AR");
  assert.equal(settings.speechLocaleFor("EN", "ES", "es-AR"), "en-US");
  assert.equal(settings.speechLocaleFor("FR", "FR", "fr-CA"), "fr-CA");
});

test("automatic interface language follows an English or Spanish base language", () => {
  assert.equal(settings.resolveInterfaceLanguage("auto", "ES"), "es");
  assert.equal(settings.resolveInterfaceLanguage("auto", "EN"), "en");
  assert.equal(settings.resolveInterfaceLanguage("auto", "JA"), "en");
  assert.equal(settings.resolveInterfaceLanguage("en", "ES"), "en");
  assert.equal(settings.resolveInterfaceLanguage("es", "EN"), "es");
  assert.equal(settings.resolveInterfaceLanguage("invalid", "ES"), "es");
});

test("locale option callers cannot mutate subsequent settings", () => {
  const options = settings.learningLocaleOptions("ES");
  options[0].label = "changed";
  options.pop();
  assert.equal(settings.learningLocaleOptions("ES").length, 3);
  assert.notEqual(settings.learningLocaleOptions("ES")[0].label, "changed");
});
