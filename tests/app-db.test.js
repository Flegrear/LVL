import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAppDatabase } from "../backend/persistence/app-db.js";

test("app database persists state across reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const first = createAppDatabase(dbPath);
  first.writeSection("cards", [{ id: "card-1", front: "hello", reviewCount: 2 }]);
  first.writeSection("library", [{ id: "show-1", title: "Show", updatedAt: 10 }]);
  first.close();

  const second = createAppDatabase(dbPath);
  assert.deepEqual(second.readSection("cards"), [{ id: "card-1", front: "hello", reviewCount: 2 }]);
  assert.deepEqual(second.readSection("library"), [{ id: "show-1", title: "Show", updatedAt: 10 }]);
  assert.equal(second.isCoreInitialized(), true);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy browser snapshots merge distinct cards and library entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const db = createAppDatabase(dbPath);
  db.mergeLegacyState({
    cards: [{ id: "a", reviewCount: 1 }],
    known: ["EN|word|hello"],
    library: [{ id: "one", title: "One", updatedAt: 1 }],
    learningExposure: {},
    testResults: [],
    preferences: { targetLanguage: "EN" },
  });
  db.mergeLegacyState({
    cards: [{ id: "b", reviewCount: 0 }],
    known: ["EN|word|world"],
    library: [{ id: "two", title: "Two", updatedAt: 2 }],
    learningExposure: {},
    testResults: [],
    preferences: { targetLanguage: "ES" },
  });
  const state = db.readAll();
  assert.deepEqual(new Set(state.cards.map((card) => card.id)), new Set(["a", "b"]));
  assert.deepEqual(new Set(state.library.map((entry) => entry.id)), new Set(["one", "two"]));
  assert.deepEqual(new Set(state.known), new Set(["EN|word|hello", "EN|word|world"]));
  assert.equal(state.preferences.targetLanguage, "EN");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy preference migration backfills new nested keys without overwriting persisted choices", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const db = createAppDatabase(dbPath);
  db.writeSection("preferences", {
    targetLanguage: "JA",
    voiceAudio: {
      rate: 1.08,
      speakReplies: false,
    },
  });
  db.mergeLegacyState({
    preferences: {
      targetLanguage: "ES",
      baseLanguage: "EN",
      voiceAudio: {
        rate: 0.92,
        speakReplies: true,
        autoContinue: true,
        inputLanguage: "ja-JP",
      },
      subtitleStyle: {
        fontSize: 42,
      },
    },
  });
  const preferences = db.readSection("preferences");
  assert.equal(preferences.targetLanguage, "JA");
  assert.equal(preferences.baseLanguage, "EN");
  assert.equal(preferences.voiceAudio.rate, 1.08);
  assert.equal(preferences.voiceAudio.speakReplies, false);
  assert.equal(preferences.voiceAudio.autoContinue, true);
  assert.equal(preferences.voiceAudio.inputLanguage, "ja-JP");
  assert.equal(preferences.subtitleStyle.fontSize, 42);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("preference mergeSection backfills an already-migrated partial preference row", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const db = createAppDatabase(dbPath);
  db.writeSection("preferences", {
    targetLanguage: "JA",
    voiceAudio: { rate: 1.15 },
  });
  db.mergeSection("preferences", {
    targetLanguage: "ES",
    baseLanguage: "EN",
    voiceAudio: {
      rate: 0.96,
      speakReplies: true,
      autoContinue: true,
      inputLanguage: "auto",
    },
  });
  const preferences = db.readSection("preferences");
  assert.equal(preferences.targetLanguage, "JA");
  assert.equal(preferences.baseLanguage, "EN");
  assert.equal(preferences.voiceAudio.rate, 1.15);
  assert.equal(preferences.voiceAudio.speakReplies, true);
  assert.equal(preferences.voiceAudio.autoContinue, true);
  assert.equal(preferences.voiceAudio.inputLanguage, "auto");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("coach sessions persist with bounded and sanitized provider conversation state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const first = createAppDatabase(dbPath);
  const sessions = Array.from({ length: 30 }, (_, index) => ({
    chatId: `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`,
    mode: index % 2 ? "practice" : "live",
    providerId: "chatgpt-browser",
    providerInstanceId: "edge-instance",
    conversationId: `conversation-${index}`,
    targetLanguage: "ja",
    baseLanguage: "en",
    liveSeeded: true,
    nativeVoice: index % 2 === 0,
    updatedAt: index + 1,
  }));
  sessions.push({ chatId: "invalid", conversationId: "drop-me", updatedAt: 999 });
  first.writeSection("coachSessions", sessions);
  first.close();

  const second = createAppDatabase(dbPath);
  const stored = second.readSection("coachSessions");
  assert.equal(stored.length, 24);
  assert.equal(stored[0].conversationId, "conversation-29");
  assert.equal(stored[0].mode, "live");
  assert.equal(stored[0].targetLanguage, "JA");
  assert.equal(stored[0].nativeVoice, false);
  assert.equal(stored.some((session) => session.chatId === "invalid"), false);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("native voice and text-live provider sessions persist independently for the same chat", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const chatId = "11111111-2222-4333-8444-555555555555";
  const first = createAppDatabase(dbPath);
  first.writeSection("coachSessions", [
    {
      chatId,
      mode: "live",
      providerId: "chatgpt-browser",
      providerInstanceId: "edge-instance",
      conversationId: "text-live-conversation",
      targetLanguage: "JA",
      baseLanguage: "EN",
      liveSeeded: true,
      nativeVoice: false,
      updatedAt: 10,
    },
    {
      chatId,
      mode: "live",
      providerId: "chatgpt-browser",
      providerInstanceId: "edge-instance",
      conversationId: "native-voice-conversation",
      targetLanguage: "JA",
      baseLanguage: "EN",
      liveSeeded: true,
      nativeVoice: true,
      assistanceMode: "unassisted",
      presetId: "episode-chat",
      presetLabel: "Episode discussion",
      presetContext: "Discuss episode 3 and its vocabulary.",
      updatedAt: 20,
    },
  ]);
  first.close();

  const second = createAppDatabase(dbPath);
  const stored = second.readSection("coachSessions");
  assert.equal(stored.length, 2);
  const textSession = stored.find((session) => session.nativeVoice === false);
  assert.equal(textSession?.conversationId, "text-live-conversation");
  assert.equal(textSession?.assistanceMode, "assisted");
  const nativeSession = stored.find((session) => session.nativeVoice === true);
  assert.equal(nativeSession?.conversationId, "native-voice-conversation");
  assert.equal(nativeSession?.assistanceMode, "unassisted");
  assert.equal(nativeSession?.presetId, "episode-chat");
  assert.equal(nativeSession?.presetLabel, "Episode discussion");
  assert.equal(nativeSession?.presetContext, "Discuss episode 3 and its vocabulary.");
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("coach session assistance mode normalizes safely across database reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const first = createAppDatabase(dbPath);
  first.writeSection("coachSessions", [
    {
      chatId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      providerId: "chatgpt-browser",
      conversationId: "conversation-unassisted",
      targetLanguage: "JA",
      baseLanguage: "EN",
      liveSeeded: true,
      nativeVoice: true,
      assistanceMode: "unassisted",
      updatedAt: 30,
    },
    {
      chatId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      providerId: "chatgpt-browser",
      conversationId: "conversation-invalid-mode",
      targetLanguage: "JA",
      baseLanguage: "EN",
      liveSeeded: true,
      nativeVoice: true,
      assistanceMode: "unsupported",
      updatedAt: 20,
    },
    {
      chatId: "cccccccc-dddd-4eee-8fff-000000000000",
      providerId: "chatgpt-browser",
      conversationId: "conversation-legacy",
      targetLanguage: "JA",
      baseLanguage: "EN",
      liveSeeded: true,
      nativeVoice: true,
      updatedAt: 10,
    },
  ]);
  first.close();

  const second = createAppDatabase(dbPath);
  const stored = second.readSection("coachSessions");
  assert.equal(stored.find((session) => session.conversationId === "conversation-unassisted")?.assistanceMode, "unassisted");
  assert.equal(stored.find((session) => session.conversationId === "conversation-invalid-mode")?.assistanceMode, "assisted");
  assert.equal(stored.find((session) => session.conversationId === "conversation-legacy")?.assistanceMode, "assisted");
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("coach transcripts persist separately from provider session metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const db = createAppDatabase(dbPath);
  const id = "11111111-2222-4333-8444-555555555555";
  db.writeSection("coachTranscripts", [{
    id,
    mode: "live",
    providerId: "chatgpt-browser",
    targetLanguage: "ja",
    baseLanguage: "en",
    messages: [
      { role: "user", mode: "live", text: "Hello", createdAt: 1 },
      {
        role: "assistant",
        mode: "practice",
        text: "こんにちは",
        targetText: "こんにちは",
        romanized: "Konnichiwa",
        baseText: "Hello",
        corrections: [{ heard: "こんいちは", better: "こんにちは", note: "Use the standard greeting." }],
        pronunciation: [{ word: "こんにちは", tip: "Keep each mora even." }],
        provider: { id: "chatgpt-browser", label: "ChatGPT Browser", model: "account-selected", transport: "signed-in-browser" },
        acousticScoring: false,
        createdAt: 2,
      },
    ],
    updatedAt: 3,
  }]);
  db.writeSection("coachSessions", [{
    chatId: id,
    mode: "live",
    providerId: "chatgpt-browser",
    conversationId: "conversation-live",
    targetLanguage: "JA",
    baseLanguage: "EN",
    liveSeeded: true,
    nativeVoice: true,
    updatedAt: 3,
  }]);
  const transcript = db.readSection("coachTranscripts")[0];
  const session = db.readSection("coachSessions")[0];
  assert.equal(transcript.messages[1].romanized, "Konnichiwa");
  assert.equal(transcript.messages[1].baseText, "Hello");
  assert.equal(transcript.messages[1].mode, "practice");
  assert.equal(transcript.messages[1].corrections[0].better, "こんにちは");
  assert.equal(transcript.messages[1].pronunciation[0].word, "こんにちは");
  assert.equal(transcript.messages[1].provider.id, "chatgpt-browser");
  assert.equal(transcript.messages[1].acousticScoring, false);
  assert.equal(session.conversationId, "conversation-live");
  assert.equal(session.nativeVoice, true);
  assert.equal("messages" in session, false);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("coach transcript merges deduplicate provider entries and preserve enriched fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const db = createAppDatabase(dbPath);
  const id = "22222222-3333-4444-8555-666666666666";
  db.writeSection("coachTranscripts", [{
    id,
    mode: "live",
    providerId: "chatgpt-browser",
    providerInstanceId: "edge-instance",
    conversationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    targetLanguage: "JA",
    baseLanguage: "EN",
    presetId: "top-100",
    presetLabel: "Review top 100 words",
    messages: [
      { role: "user", mode: "live", text: "こんにちは", providerEntryId: "user-1", createdAt: 10 },
      { role: "assistant", mode: "live", text: "元気ですか", targetText: "元気ですか", providerEntryId: "assistant-1", createdAt: 20 },
    ],
    updatedAt: 30,
  }]);
  db.mergeLegacyState({
    coachTranscripts: [{
      id,
      mode: "live",
      providerId: "chatgpt-browser",
      providerInstanceId: "edge-instance",
      conversationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      targetLanguage: "JA",
      baseLanguage: "EN",
      presetId: "top-100",
      presetLabel: "Review top 100 words",
      messages: [
        { role: "user", mode: "live", text: "こんにちは", providerEntryId: "user-1", createdAt: 12 },
        { role: "assistant", mode: "live", text: "元気ですか", targetText: "元気ですか", romanized: "Genki desu ka", baseText: "How are you?", providerEntryId: "assistant-1", createdAt: 22 },
      ],
      updatedAt: 40,
    }],
  });

  const transcript = db.readSection("coachTranscripts").find((item) => item.id === id);
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[0].providerEntryId, "user-1");
  assert.equal(transcript.messages[1].romanized, "Genki desu ka");
  assert.equal(transcript.messages[1].baseText, "How are you?");
  assert.equal(transcript.conversationId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(transcript.presetId, "top-100");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mergeSection keeps direct provider transcript turns when a stale app snapshot is saved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const db = createAppDatabase(dbPath);
  const id = "44444444-5555-4666-8777-888888888888";
  db.writeSection("coachTranscripts", [{
    id,
    mode: "live",
    providerId: "chatgpt-browser",
    targetLanguage: "JA",
    baseLanguage: "EN",
    messages: [
      { role: "user", mode: "live", text: "first", providerEntryId: "provider-user-1", createdAt: 10 },
      { role: "assistant", mode: "live", text: "reply", providerEntryId: "provider-ai-1", createdAt: 20 },
    ],
    updatedAt: 30,
  }]);
  db.mergeSection("coachTranscripts", [{
    id,
    mode: "live",
    providerId: "chatgpt-browser",
    targetLanguage: "JA",
    baseLanguage: "EN",
    messages: [
      { role: "user", mode: "live", text: "first", providerEntryId: "provider-user-1", createdAt: 10 },
    ],
    updatedAt: 40,
  }]);
  const transcript = db.readSection("coachTranscripts").find((item) => item.id === id);
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[1].providerEntryId, "provider-ai-1");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("coach usage normalizes overlapping segments and preserves one active native voice session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const db = createAppDatabase(dbPath);
  const chatId = "33333333-4444-4555-8666-777777777777";
  db.writeSection("coachUsage", {
    segments: [
      { startAt: 100, endAt: 200 },
      { startAt: 150, endAt: 250 },
      { startAt: 400, endAt: 450 },
      { startAt: 500, endAt: 499 },
    ],
    active: {
      chatId,
      conversationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      providerId: "chatgpt-browser",
      providerInstanceId: "edge-instance",
      startedAt: 500,
      updatedAt: 550,
    },
  });
  const usage = db.readSection("coachUsage");
  assert.deepEqual(usage.segments, [
    { startAt: 100, endAt: 250 },
    { startAt: 400, endAt: 450 },
  ]);
  assert.equal(usage.active.chatId, chatId);
  assert.equal(usage.active.startedAt, 500);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy voice usage segments migrate into durable coach usage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const db = createAppDatabase(dbPath);
  db.mergeLegacyState({
    cards: [],
    known: [],
    library: [],
    learningExposure: {},
    testResults: [],
    coachTranscripts: [],
    preferences: {
      targetLanguage: "JA",
      voiceUsageSegments: [
        { startAt: 1_000, endAt: 2_000 },
        { startAt: 1_500, endAt: 3_000 },
      ],
    },
  });
  assert.deepEqual(db.readSection("coachUsage"), {
    segments: [{ startAt: 1_000, endAt: 3_000 }],
    active: null,
  });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("opening an initialized pre-usage database seeds durable coach usage from preferences", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-db-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const first = createAppDatabase(dbPath);
  first.writeSection("preferences", {
    targetLanguage: "JA",
    voiceUsageSegments: [{ startAt: 10_000, endAt: 12_500 }],
  });
  // Simulate the pre-v3 shape by deleting only coachUsage after the preference snapshot.
  first.close();

  const raw = new DatabaseSync(dbPath);
  raw.prepare("DELETE FROM app_state WHERE section = ?").run("coachUsage");
  raw.close();

  const reopened = createAppDatabase(dbPath);
  assert.deepEqual(reopened.readSection("coachUsage"), {
    segments: [{ startAt: 10_000, endAt: 12_500 }],
    active: null,
  });
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomic section CAS rejects a stale writer from another SQLite connection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-cas-"));
  const dbPath = path.join(dir, "app.sqlite3");
  const first = createAppDatabase(dbPath);
  const second = createAppDatabase(dbPath);
  try {
    const initial = first.sectionUpdatedAt("library");
    assert.equal(initial, second.sectionUpdatedAt("library"));
    const accepted = first.compareAndSwapSection("library", [{ id: "newer", title: "Saved" }], initial);
    assert.equal(accepted.ok, true);
    assert.ok(accepted.updatedAt > initial);
    const stale = second.compareAndSwapSection("library", [{ id: "old", title: "Stale" }], initial);
    assert.deepEqual(stale, { ok: false, currentUpdatedAt: accepted.updatedAt });
    assert.deepEqual(second.readSection("library"), [{ id: "newer", title: "Saved" }]);
    assert.deepEqual(first.readSection("library"), [{ id: "newer", title: "Saved" }]);
    const current = second.compareAndSwapSection("library", [{ id: "final", title: "Current" }], accepted.updatedAt);
    assert.equal(current.ok, true);
    assert.ok(current.updatedAt > accepted.updatedAt);
    assert.deepEqual(first.readSection("library"), [{ id: "final", title: "Current" }]);
  } finally {
    second.close();
    first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
