import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const from = app.indexOf("async function sendVoiceTurn(");
const to = app.indexOf("\nfunction liveConversationPresets()", from);
assert.ok(from > 0 && to > from, "The real voice turn handler must be available");

function fixture() {
  let deliver;
  let reject;
  let spoken = [];
  let saved = 0;
  const initial = {
    chatId: "conversation-1", mode: "practice", messages: [], pending: false,
    providerLive: false, liveStarting: false,
  };
  const ctx = vm.createContext({
    learningEnabled: true,
    voiceChat: initial,
    coachProviderId: "mock-provider",
    browserCoachInstanceId: "instance-1",
    state: { targetLanguage: "JA", baseLanguage: "EN", targetLocale: "ja-JP", baseLocale: "en-US" },
    currentPronunciationPracticeItem: () => ({ value: "こんにちは" }),
    pronunciationPracticePayload: () => ({ targetText: "こんにちは" }),
    stopVoiceSpeech: () => {},
    persistVoiceChatSession: () => { saved += 1; },
    renderVoiceChatStage: () => {},
    speakVoiceCoach: (text) => { spoken.push(text); },
    postJson: () => new Promise((resolve, fail) => { deliver = resolve; reject = fail; }),
    Date,
  });
  vm.runInContext(app.slice(from, to), ctx);
  return {
    ctx, initial, send: vm.runInContext("sendVoiceTurn", ctx),
    complete: (reply = "ありがとう") => deliver({ output: { targetText: reply, baseText: "Thank you" } }),
    fail: (reason = "offline") => reject(new Error(reason)),
    get spoken() { return spoken; },
    get saved() { return saved; },
  };
}

test("one-shot coach reply still reaches the initiating practice thread normally", async () => {
  const f = fixture();
  const pending = f.send("こんにちは");
  assert.equal(f.initial.pending, true);
  f.complete();
  await pending;
  assert.deepEqual(f.initial.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(f.initial.messages[1].baseText, "Thank you");
  assert.deepEqual(f.spoken, ["ありがとう"]);
  assert.equal(f.initial.pending, false);
  assert.equal(f.saved, 2);
});

test("reply from an old session cannot enter a newly opened session", async () => {
  const f = fixture();
  const pending = f.send("こんにちは");
  const newChat = { ...f.initial, chatId: "conversation-2", messages: [], pending: false };
  f.ctx.voiceChat = newChat;
  f.complete();
  await pending;
  assert.equal(newChat.messages.length, 0);
  assert.equal(f.initial.messages.length, 1);
  assert.equal(f.initial.pending, false);
  assert.deepEqual(f.spoken, []);
});

test("clearing history or switching modes while the provider is pending discards its late result", async () => {
  for (const change of ["clear", "mode"]) {
    const f = fixture();
    const pending = f.send("こんにちは");
    if (change === "clear") f.initial.messages = [];
    else f.initial.mode = "live";
    f.complete();
    await pending;
    assert.equal(f.initial.messages.some((message) => message.role === "assistant"), false);
    assert.equal(f.initial.pending, false);
    assert.deepEqual(f.spoken, []);
  }
});

test("a provider error after session change cannot overwrite the new session error", async () => {
  const f = fixture();
  const pending = f.send("こんにちは");
  f.ctx.voiceChat = { ...f.initial, chatId: "conversation-2", messages: [], pending: false, error: "new session" };
  f.fail();
  await pending;
  assert.equal(f.ctx.voiceChat.error, "new session");
  assert.equal(f.initial.pending, false);
});

test("disabling Learning while the coach is pending suppresses its reply and voice output", async () => {
  const f = fixture();
  const pending = f.send("こんにちは");
  f.ctx.learningEnabled = false;
  f.complete();
  await pending;
  assert.equal(f.initial.messages.length, 1);
  assert.equal(f.initial.pending, false);
  assert.deepEqual(f.spoken, []);
  await f.send("one more request while disabled");
  assert.equal(f.initial.messages.length, 1);
});

function enrichmentFixture() {
  const start = app.indexOf("async function enrichProviderLiveTranscript()");
  const end = app.indexOf('\nwindow.addEventListener("message",', start);
  assert.ok(start > 0 && end > start);
  let deliver;
  let fail;
  let saves = 0;
  const original = {
    chatId: "live-one", providerLive: false, liveStarting: false,
    messages: [{ role: "assistant", providerLive: true, providerEntryId: "entry-1", targetText: "こんにちは", baseText: "" }],
  };
  const ctx = vm.createContext({
    learningEnabled: true,
    voiceChat: original,
    coachProviderId: "mock-provider",
    browserCoachInstanceId: "instance-1",
    state: { targetLanguage: "JA", baseLanguage: "EN" },
    postJson: () => new Promise((resolve, reject) => { deliver = resolve; fail = reject; }),
    persistVoiceChatSession: () => { saves += 1; },
    renderVoiceChatStage: () => {},
  });
  vm.runInContext(app.slice(start, end), ctx);
  return {
    ctx, original, run: vm.runInContext("enrichProviderLiveTranscript", ctx),
    finish: () => deliver({ items: [{ id: "entry-1", romanized: "konnichiwa", baseText: "Hello" }] }),
    fail: () => fail(new Error("unavailable")),
    get saves() { return saves; },
  };
}

test("live transcript enrichment updates its original session when still active", async () => {
  const f = enrichmentFixture();
  const pending = f.run();
  f.finish();
  await pending;
  assert.equal(f.original.messages[0].romanized, "konnichiwa");
  assert.equal(f.original.messages[0].baseText, "Hello");
  assert.equal(f.saves, 1);
});

test("late live transcript enrichment cannot mutate or surface errors in a new session", async () => {
  const f = enrichmentFixture();
  const pending = f.run();
  f.ctx.voiceChat = { chatId: "live-two", providerLive: false, liveStarting: false, messages: [], error: "" };
  f.finish();
  await pending;
  assert.equal(f.original.messages[0].baseText, "");
  assert.equal(f.saves, 0);
  assert.deepEqual(f.ctx.voiceChat.messages, []);

  const g = enrichmentFixture();
  const other = g.run();
  g.ctx.voiceChat = { chatId: "live-two", providerLive: false, liveStarting: false, messages: [], error: "" };
  g.fail();
  await other;
  assert.equal(g.ctx.voiceChat.error, "");
});
