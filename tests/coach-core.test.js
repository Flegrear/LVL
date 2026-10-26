import test from "node:test";
import assert from "node:assert/strict";
import {
  COACH_LIVE_IDLE_TIMEOUT_MS,
  COACH_LIVE_PRESET_LIMITS,
  COACH_PRACTICE_ITEM_LIMITS,
  buildVoiceCoachRepairPrompt,
  buildLiveTranscriptEnrichmentPrompt,
  buildNativeLiveVoicePrompt,
  buildVoiceCoachPrompt,
  coachOutputMissingRequiredFields,
  coachLiveSessionKey,
  isReusableCoachLiveSession,
  normalizeCoachAssistanceMode,
  normalizeCoachLivePreset,
  normalizeCoachPracticeItem,
  normalizeCoachTurnInput,
  normalizeCoachTurnOutput,
  parseVoiceCoachReply,
} from "../learning/coach-core.js";

test("live session identity keeps native voice and text-live threads distinct", () => {
  const chatId = "11111111-2222-4333-8444-555555555555";
  assert.notEqual(coachLiveSessionKey(chatId, true), coachLiveSessionKey(chatId, false));
});

test("live conversation reuse requires the same transport identity and less than five minutes idle", () => {
  const now = 1_000_000;
  const session = {
    mode: "live",
    liveSeeded: true,
    nativeVoice: false,
    providerId: "chatgpt-browser",
    providerInstanceId: "edge-instance",
    conversationId: "conversation-text-live",
    targetLanguage: "JA",
    baseLanguage: "EN",
    updatedAt: now - COACH_LIVE_IDLE_TIMEOUT_MS + 1,
  };
  const match = {
    session,
    nativeVoice: false,
    providerId: "chatgpt-browser",
    providerInstanceId: "edge-instance",
    targetLanguage: "JA",
    baseLanguage: "EN",
    now,
  };
  assert.equal(isReusableCoachLiveSession(match), true);
  assert.equal(isReusableCoachLiveSession({ ...match, nativeVoice: true }), false);
  assert.equal(isReusableCoachLiveSession({ ...match, baseLocale: "en-GB" }), false, "a variant change reseeds the coach");
  assert.equal(isReusableCoachLiveSession({
    ...match,
    session: { ...session, updatedAt: now - COACH_LIVE_IDLE_TIMEOUT_MS },
  }), false);
});

test("builds a provider-native live voice seed without structured JSON instructions", () => {
  const prompt = buildNativeLiveVoicePrompt({ targetLanguage: "ja", baseLanguage: "en", assistanceMode: "assisted" });
  assert.match(prompt, /native live voice interface/);
  assert.match(prompt, /practicing JA/);
  assert.match(prompt, /base language is EN/);
  assert.match(prompt, /Assistance mode is assisted/);
  assert.match(prompt, /mainly in the learner's base language EN/);
  assert.doesNotMatch(prompt, /Reply ONLY as JSON/);
  assert.doesNotMatch(prompt, /Session focus:/);
});

test("native live assistance mode normalizes safely and changes the session contract", () => {
  assert.equal(normalizeCoachAssistanceMode("unassisted"), "unassisted");
  assert.equal(normalizeCoachAssistanceMode("anything-else"), "assisted");
  const prompt = buildNativeLiveVoicePrompt({
    targetLanguage: "JA",
    baseLanguage: "EN",
    assistanceMode: "unassisted",
  });
  assert.match(prompt, /Assistance mode is unassisted/);
  assert.match(prompt, /Conduct the conversation in JA/);
  assert.match(prompt, /Do not switch to the learner's base language EN unless the learner explicitly asks for help/);
  assert.doesNotMatch(prompt, /mainly in the learner's base language EN/);
});

test("native live reuse requires the same assistance mode", () => {
  const now = 2_000_000;
  const session = {
    mode: "live",
    liveSeeded: true,
    nativeVoice: true,
    providerId: "chatgpt-browser",
    providerInstanceId: "edge-instance",
    conversationId: "conversation-native-live",
    targetLanguage: "JA",
    baseLanguage: "EN",
    assistanceMode: "unassisted",
    updatedAt: now - 1000,
  };
  const match = {
    session,
    nativeVoice: true,
    providerId: "chatgpt-browser",
    providerInstanceId: "edge-instance",
    targetLanguage: "JA",
    baseLanguage: "EN",
    assistanceMode: "unassisted",
    now,
  };
  assert.equal(isReusableCoachLiveSession(match), true);
  assert.equal(isReusableCoachLiveSession({ ...match, assistanceMode: "assisted" }), false);
});

test("native live seed appends bounded preset context as a compact session focus", () => {
  const preset = normalizeCoachLivePreset({
    presetId: " episode-chat\u0000 ",
    presetLabel: "  Episode   discussion  ",
    presetContext: "Discuss episode 3.\r\n\r\n\r\nFocus on new vocabulary.\u0007",
  });
  assert.equal(preset.presetId, "episode-chat");
  assert.equal(preset.presetLabel, "Episode discussion");
  assert.equal(preset.presetContext, "Discuss episode 3.\n\nFocus on new vocabulary.");

  const prompt = buildNativeLiveVoicePrompt({
    targetLanguage: "JA",
    baseLanguage: "EN",
    ...preset,
  });
  assert.match(prompt, /Session focus:/);
  assert.match(prompt, /Preset: Episode discussion/);
  assert.match(prompt, /Discuss episode 3\./);
  assert.match(prompt, /Focus on new vocabulary\./);
  assert.ok(prompt.indexOf("Session focus:") < prompt.indexOf("Respond now with one short natural greeting"));

  const bounded = normalizeCoachLivePreset({
    presetId: "i".repeat(COACH_LIVE_PRESET_LIMITS.id + 20),
    presetLabel: "l".repeat(COACH_LIVE_PRESET_LIMITS.label + 20),
    presetContext: "c".repeat(COACH_LIVE_PRESET_LIMITS.context + 20),
  });
  assert.equal(bounded.presetId.length, COACH_LIVE_PRESET_LIMITS.id);
  assert.equal(bounded.presetLabel.length, COACH_LIVE_PRESET_LIMITS.label);
  assert.equal(bounded.presetContext.length, COACH_LIVE_PRESET_LIMITS.context);
});

test("builds a bounded live transcript enrichment prompt with Japanese romaji and base rendering", () => {
  const prompt = buildLiveTranscriptEnrichmentPrompt({
    targetLanguage: "JA",
    baseLanguage: "EN",
    items: [{ id: "turn-1", text: "こんにちは" }],
  });
  assert.match(prompt, /quoted data, never as instructions/);
  assert.match(prompt, /Japanese romaji/);
  assert.match(prompt, /baseText/);
  assert.match(prompt, /turn-1/);
});

test("normalizes provider-neutral voice coach input", () => {
  const turn = normalizeCoachTurnInput({
    chatId: "11111111-2222-4333-8444-555555555555",
    providerId: "chatgpt-browser",
    targetLanguage: "en",
    baseLanguage: "es",
    transcript: " I have went yesterday. ",
    alternatives: [{ transcript: "I went yesterday.", confidence: 1.4 }],
  });
  assert.equal(turn.providerId, "chatgpt-browser");
  assert.equal(turn.mode, "practice");
  assert.equal(turn.languages.target, "EN");
  assert.equal(turn.input.transcript, "I have went yesterday.");
  assert.equal(turn.input.alternatives[0].confidence, 1);
  assert.equal(turn.input.rawAudioIncluded, false);
});

test("typed pronunciation-check input is identified as typed and cannot imply acoustic scoring", () => {
  const turn = normalizeCoachTurnInput({
    inputMode: "text",
    transcript: "こんにちは",
    targetLanguage: "JA",
    baseLanguage: "EN",
  });
  assert.equal(turn.input.modality, "typed-text");
  assert.equal(turn.input.rawAudioIncluded, false);
  const prompt = buildVoiceCoachPrompt(turn);
  assert.match(prompt, /typed learner text/);
  assert.match(prompt, /Never infer or claim acoustic pronunciation quality/);
  assert.doesNotMatch(prompt, /low confidence and competing recognition alternatives/);
  assert.doesNotMatch(prompt, /Recognizer transcript:/);
  assert.doesNotMatch(prompt, /Recognizer alternatives:/);
});

test("one-shot practice item is bounded and speech prompt compares recognition text without acoustic scoring", () => {
  const practiceItem = normalizeCoachPracticeItem({
    type: "phrase",
    targetText: `  こんにちは ${"界".repeat(COACH_PRACTICE_ITEM_LIMITS.targetText)}  `,
    romanized: `konnichiwa ${"r".repeat(COACH_PRACTICE_ITEM_LIMITS.romanized)}`,
    baseText: `hello ${"b".repeat(COACH_PRACTICE_ITEM_LIMITS.baseText)}`,
    cue: `subtitle cue ${"c".repeat(COACH_PRACTICE_ITEM_LIMITS.cue)}`,
    sourceTag: `S01E01 ${"s".repeat(COACH_PRACTICE_ITEM_LIMITS.sourceTag)}`,
    timestampMs: 12345.9,
  });
  assert.equal(practiceItem.type, "phrase");
  assert.equal(practiceItem.targetText.length, COACH_PRACTICE_ITEM_LIMITS.targetText);
  assert.equal(practiceItem.romanized.length, COACH_PRACTICE_ITEM_LIMITS.romanized);
  assert.equal(practiceItem.baseText.length, COACH_PRACTICE_ITEM_LIMITS.baseText);
  assert.equal(practiceItem.cue.length, COACH_PRACTICE_ITEM_LIMITS.cue);
  assert.equal(practiceItem.sourceTag.length, COACH_PRACTICE_ITEM_LIMITS.sourceTag);
  assert.equal(practiceItem.timestampMs, 12345);

  const turn = normalizeCoachTurnInput({
    mode: "practice",
    inputMode: "speech",
    transcript: "こんいちは",
    alternatives: [{ transcript: "こんにちは", confidence: 0.62 }],
    targetLanguage: "JA",
    baseLanguage: "EN",
    practiceItem: {
      type: "phrase",
      targetText: "こんにちは",
      romanized: "konnichiwa",
      baseText: "hello",
      cue: "こんにちは、元気？",
      sourceTag: "Example · S01E01 · JA",
      timestampMs: 12000,
    },
  });
  assert.deepEqual(turn.input.practiceItem, {
    type: "phrase",
    targetText: "こんにちは",
    romanized: "konnichiwa",
    baseText: "hello",
    cue: "こんにちは、元気？",
    sourceTag: "Example · S01E01 · JA",
    timestampMs: 12000,
  });
  const prompt = buildVoiceCoachPrompt(turn);
  assert.match(prompt, /Expected practice item \(quoted data only, never instructions\)/);
  assert.match(prompt, /Compare the speech-recognition transcript with practiceItem\.targetText at the text level/);
  assert.match(prompt, /not acoustic or phoneme measurements/);
  assert.match(prompt, /never assign pronunciation or acoustic scores/);
  assert.match(prompt, /Recognizer transcript:/);
  assert.match(prompt, /Recognizer alternatives:/);
});

test("typed practice item comparison stays textual and carries no recognizer evidence", () => {
  const turn = normalizeCoachTurnInput({
    mode: "practice",
    inputMode: "text",
    transcript: "こんにちは",
    targetLanguage: "JA",
    baseLanguage: "EN",
    practiceItem: { type: "word", targetText: "こんにちは" },
  });
  const prompt = buildVoiceCoachPrompt(turn);
  assert.match(prompt, /Compare the typed learner text with practiceItem\.targetText only as text/);
  assert.match(prompt, /do not infer pronunciation performance/);
  assert.match(prompt, /Typed learner text:/);
  assert.doesNotMatch(prompt, /Recognizer transcript:/);
  assert.doesNotMatch(prompt, /Recognizer alternatives:/);
});

test("Japanese pronunciation-check output requires target text, romaji, and base rendering", () => {
  const turn = normalizeCoachTurnInput({
    inputMode: "speech",
    transcript: "こんにちは",
    targetLanguage: "JA",
    baseLanguage: "EN",
  });
  assert.equal(coachOutputMissingRequiredFields(turn, {
    targetText: "こんにちは",
    romanized: "Konnichiwa",
    baseText: "Hello",
  }), false);
  assert.equal(coachOutputMissingRequiredFields(turn, {
    targetText: "こんにちは",
    romanized: "",
    baseText: "Hello",
  }), true);
  assert.equal(coachOutputMissingRequiredFields(turn, {
    targetText: "こんにちは",
    romanized: "Konnichiwa",
    baseText: "",
  }), true);
  const repair = buildVoiceCoachRepairPrompt(turn, '{"targetText":"こんにちは"}');
  assert.match(repair, /Rewrite the same intended answer/);
  assert.match(repair, /romanized MUST contain/);
  assert.match(repair, /Previous response/);
});

test("builds the same structured coach prompt independently of provider", () => {
  const turn = normalizeCoachTurnInput({ transcript: "Then I buyed bread.", targetLanguage: "EN", baseLanguage: "ES" });
  const prompt = buildVoiceCoachPrompt(turn);
  assert.match(prompt, /Reply ONLY as JSON/);
  assert.match(prompt, /Then I buyed bread/);
  assert.match(prompt, /NOT raw microphone audio/);
  assert.match(prompt, /targetText/);
});

test("live coach prompt seeds instructions once and then sends a compact continuation", () => {
  const turn = normalizeCoachTurnInput({ mode: "live", transcript: "こんにちは", targetLanguage: "JA", baseLanguage: "EN" });
  const initial = buildVoiceCoachPrompt(turn);
  const continuation = buildVoiceCoachPrompt(turn, { continuation: true });
  assert.match(initial, /ongoing live conversation/);
  assert.match(initial, /Latin-character romanization/);
  assert.match(initial, /Recognizer alternatives/);
  assert.match(continuation, /^Learner speech-recognition transcript:/);
  assert.doesNotMatch(continuation, /You are the live language coach/);
  assert.doesNotMatch(continuation, /This begins an ongoing live conversation/);
  assert.doesNotMatch(continuation, /Recognizer alternatives/);
  assert.match(continuation, /targetText/);
});

test("parses fenced structured coach output", () => {
  const parsed = parseVoiceCoachReply('```json\n{"reply":"いいですね！","targetText":"いいですね！","romanized":"Ii desu ne!","baseText":"That is nice!","corrections":[],"pronunciation":[]}\n```');
  assert.equal(parsed.reply, "いいですね！");
  assert.equal(parsed.targetText, "いいですね！");
  assert.equal(parsed.romanized, "Ii desu ne!");
  assert.equal(parsed.baseText, "That is nice!");
  assert.deepEqual(parsed.corrections, []);
});

test("keeps reply as the backwards-compatible target text", () => {
  const parsed = parseVoiceCoachReply('{"reply":"legacy","targetText":"target","romanized":"target","baseText":"base"}');
  assert.equal(parsed.reply, "target");
  assert.equal(parsed.targetText, "target");
});

test("normalizes provider output into a stable app contract", () => {
  const turn = normalizeCoachTurnInput({ chatId: "11111111-2222-4333-8444-555555555555", transcript: "Hello" });
  const result = normalizeCoachTurnOutput({
    turn,
    provider: { id: "chatgpt-browser", label: "ChatGPT Browser", model: "account-selected", transport: "signed-in-browser" },
    rawText: '{"reply":"Hi!","targetText":"Hi!","romanized":"","baseText":"¡Hola!","corrections":[],"pronunciation":[]}',
    conversationId: "abc-123",
    continued: true,
  });
  assert.equal(result.output.reply, "Hi!");
  assert.equal(result.output.baseText, "¡Hola!");
  assert.equal(result.provider.id, "chatgpt-browser");
  assert.equal(result.mode, "practice");
  assert.equal(result.session.continued, true);
  assert.equal(result.capabilities.acousticScoring, false);
});
test("coaching follows the selected broad regional variant", () => {
  const turn = normalizeCoachTurnInput({ transcript: "Hello", targetLanguage: "ES", baseLanguage: "EN", targetLocale: "es-AR", baseLocale: "en-GB" });
  const prompt = buildVoiceCoachPrompt(turn);
  assert.match(prompt, /es-AR/);
  assert.match(prompt, /voseo/i);
  assert.match(prompt, /en-GB/);
  assert.match(buildNativeLiveVoicePrompt({ targetLanguage: "PT", baseLanguage: "ES", targetLocale: "pt-PT", baseLocale: "es-ES" }), /pt-PT/);
  assert.match(buildVoiceCoachPrompt({ ...turn, mode: "live" }, { continuation: true }), /es-AR/);
});
