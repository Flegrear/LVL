import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("async function startProviderLiveVoice()");
const end = app.indexOf("\nfunction armProviderLiveIdleTimeout()", start);
assert.ok(start > 0 && end > start, "Real native Live startup must be present");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ requirePreset = false } = {}) {
  const pendingStart = deferred();
  const pendingPreset = deferred();
  const posts = [];
  const requests = [];
  const original = {
    chatId: "old-chat", mode: "live", messages: [], providerLive: false,
    liveStarting: false, providerConversationId: "", error: "",
  };
  const ctx = vm.createContext({
    learningEnabled: true,
    voiceChat: original,
    selectedCoachProvider: () => ({ id: "chatgpt-browser", label: "ChatGPT" }),
    coachProviderShortLabel: (label) => label,
    voiceRecognition: null,
    stopVoiceSpeech: () => {},
    renderVoiceChatStage: () => {},
    state: {
      targetLanguage: "JA", baseLanguage: "EN", targetLocale: "ja-JP", baseLocale: "en-US",
      learningPreset: { language: "JA", status: requirePreset ? "loading" : "ready" },
    },
    browserCoachInstanceId: "edge-original",
    voiceLiveAssistance: "assisted",
    selectedLiveConversationPreset: () => ({
      id: requirePreset ? "top-100" : "recent",
      label: "Recent", context: "Practice Japanese",
    }),
    ensureLearningPreset: () => pendingPreset.promise,
    postJson: (url, body) => {
      requests.push({ url, body });
      return url.endsWith("/start") ? pendingStart.promise : Promise.resolve({ ok: true });
    },
    window: {
      location: { origin: "http://127.0.0.1:4173" },
      postMessage: (data) => { posts.push(data); },
    },
  });
  vm.runInContext(app.slice(start, end), ctx);
  const stopStart = app.indexOf("function stopProviderLiveVoice()", end);
  const stopEnd = app.indexOf("\nasync function closeLiveCoachSession(", stopStart);
  assert.ok(stopStart > end && stopEnd > stopStart);
  vm.runInContext(app.slice(stopStart, stopEnd), ctx);
  return {
    ctx, original, posts, requests,
    begin: vm.runInContext("startProviderLiveVoice", ctx),
    stop: vm.runInContext("stopProviderLiveVoice", ctx),
    complete: () => pendingStart.resolve({ session: { conversationId: "provider-one" } }),
    fail: () => pendingStart.reject(new Error("service offline")),
    presetReady: () => pendingPreset.resolve(),
  };
}

test("native Live starts its original conversation when still active", async () => {
  const f = fixture();
  const pending = f.begin();
  assert.equal(f.original.liveStarting, true);
  f.complete();
  await pending;
  assert.equal(f.original.providerConversationId, "provider-one");
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].type, "browser-coach:live-start");
  assert.equal(f.posts[0].chatId, "old-chat");
});

test("Learning OFF while start is pending discards and closes the late provider session", async () => {
  const f = fixture();
  const pending = f.begin();
  f.ctx.learningEnabled = false;
  f.original.liveStartRequest = null; // closeLiveCoachSession invalidates it synchronously
  f.complete();
  await pending;
  assert.equal(f.posts.length, 0, "Do not start native Edge Voice after disabling Learning");
  assert.equal(f.original.providerConversationId, "");
  assert.deepEqual(f.requests.map((request) => request.url), [
    "/api/coach/live-session/start", "/api/coach/live-session/close",
  ]);
  assert.equal(f.requests[1].body.chatId, "old-chat");
  assert.equal(f.requests[1].body.providerInstanceId, "edge-original");
});

test("native Live responses and errors cannot overwrite a new session", async () => {
  const f = fixture();
  const pending = f.begin();
  const nextChat = { ...f.original, chatId: "new-chat", liveStarting: false, error: "new state" };
  f.ctx.voiceChat = nextChat;
  f.complete();
  await pending;
  assert.equal(nextChat.error, "new state");
  assert.equal(nextChat.providerConversationId, "");
  assert.equal(f.posts.length, 0);
  assert.equal(f.requests[1].body.chatId, "old-chat");

  const g = fixture();
  const old = g.begin();
  g.ctx.voiceChat = { ...g.original, chatId: "another", error: "unchanged" };
  g.fail();
  await old;
  assert.equal(g.ctx.voiceChat.error, "unchanged");
});

test("Learning OFF before Top 100 vocabulary resolves prevents even the server start request", async () => {
  const f = fixture({ requirePreset: true });
  const pending = f.begin();
  f.ctx.learningEnabled = false;
  f.original.liveStartRequest = null;
  f.presetReady();
  await pending;
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.posts, []);
});

test("explicit Stop while the HTTP start is pending invalidates the start", async () => {
  const f = fixture();
  const pending = f.begin();
  f.stop();
  assert.equal(f.original.liveStarting, false);
  f.complete();
  await pending;
  assert.equal(f.posts.length, 0);
  assert.equal(f.requests.at(-1).url, "/api/coach/live-session/close");
});

test("late browser-control callbacks cannot reactivate a closed, replaced or disabled Live session", () => {
  const begin = app.indexOf('window.addEventListener("message",', end);
  const finish = app.indexOf("\nfunction connectBrowserCoach()", begin);
  assert.ok(begin > end && finish > begin);
  let handler;
  let usageStarts = 0;
  let merged = 0;
  const window = {
    location: { origin: "http://127.0.0.1:4173" },
    addEventListener: (_, fn) => { handler = fn; },
  };
  const chat = {
    chatId: "current-chat", mode: "live", providerLive: false,
    liveStarting: true, providerConversationId: "provider-current", error: "",
  };
  const ctx = vm.createContext({
    window, learningEnabled: true, voiceChat: chat,
    startVoiceUsageClock: () => { usageStarts += 1; },
    stopVoiceUsageClock: () => {},
    armProviderLiveIdleTimeout: () => {},
    renderVoiceChatStage: () => {},
    mergeProviderLiveTranscript: () => { merged += 1; },
    queueMicrotask: () => {},
  });
  vm.runInContext(app.slice(begin, finish), ctx);
  const dispatch = (data) => handler({ source: window, origin: window.location.origin,
    data: { source: "language-video-learner-browser-coach", ...data } });
  dispatch({ type: "browser-coach:live-control-result", action: "start", ok: true,
    chatId: "old-chat", conversationId: "provider-current" });
  assert.equal(usageStarts, 0);
  assert.equal(chat.providerLive, false);
  ctx.learningEnabled = false;
  dispatch({ type: "browser-coach:live-control-result", action: "start", ok: true,
    chatId: "current-chat", conversationId: "provider-current" });
  dispatch({ type: "browser-coach:live-transcript", chatId: "current-chat",
    conversationId: "provider-current", entries: [{ id: "late" }] });
  assert.equal(usageStarts, 0);
  assert.equal(merged, 0);
  ctx.learningEnabled = true;
  chat.liveStarting = false; // End Session invalidated the in-flight start
  dispatch({ type: "browser-coach:live-control-result", action: "start", ok: true,
    chatId: "current-chat", conversationId: "provider-current" });
  assert.equal(usageStarts, 0);
  chat.liveStarting = true;
  dispatch({ type: "browser-coach:live-control-result", action: "start", ok: true,
    chatId: "current-chat", conversationId: "provider-current" });
  assert.equal(usageStarts, 1, "The current legitimate start remains functional");
});
