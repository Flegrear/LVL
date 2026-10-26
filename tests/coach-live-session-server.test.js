import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAppDatabase } from "../backend/persistence/app-db.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Legacy Coach routes remain tested while the optional helper is omitted
// from the media-only Alpha source and installer.
const BROWSER_COACH_EXTENSION_VERSION = "0.1.30";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(port, child) {
  const url = `http://127.0.0.1:${port}/api/coach/providers`;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("test server did not become ready");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("native live-session touch refreshes only a matching non-expired session and persists cleanup", { timeout: 15_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-touch-"));
  const dbPath = path.join(dataRoot, "language-video-learner.sqlite3");
  const activeChatId = "11111111-2222-4333-8444-555555555555";
  const expiredChatId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const before = Date.now();
  const db = createAppDatabase(dbPath);
  db.writeSection("coachSessions", [
    {
      chatId: activeChatId,
      mode: "live",
      providerId: "chatgpt-browser",
      providerInstanceId: "edge-instance",
      conversationId: "native-active",
      targetLanguage: "JA",
      baseLanguage: "EN",
      liveSeeded: true,
      nativeVoice: true,
      updatedAt: before - 10_000,
    },
    {
      chatId: activeChatId,
      mode: "live",
      providerId: "chatgpt-browser",
      providerInstanceId: "edge-instance",
      conversationId: "text-live-active",
      targetLanguage: "JA",
      baseLanguage: "EN",
      liveSeeded: true,
      nativeVoice: false,
      updatedAt: before - 20_000,
    },
    {
      chatId: expiredChatId,
      mode: "live",
      providerId: "chatgpt-browser",
      providerInstanceId: "edge-instance",
      conversationId: "native-expired",
      targetLanguage: "JA",
      baseLanguage: "EN",
      liveSeeded: true,
      nativeVoice: true,
      updatedAt: before - IDLE_TIMEOUT_MS - 1,
    },
  ]);
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForServer(port, child);
    const touchedResponse = await fetch(`http://127.0.0.1:${port}/api/coach/live-session/touch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: activeChatId,
        providerId: "chatgpt-browser",
        providerInstanceId: "edge-instance",
        nativeVoice: true,
      }),
    });
    assert.equal(touchedResponse.status, 200);
    assert.deepEqual(await touchedResponse.json(), { ok: true, touched: true, idleTimeoutMs: IDLE_TIMEOUT_MS });

    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/app-state/coachSessions`);
    const state = await stateResponse.json();
    const nativeSession = state.value.find((session) => session.chatId === activeChatId && session.nativeVoice === true);
    const textSession = state.value.find((session) => session.chatId === activeChatId && session.nativeVoice === false);
    assert.ok(nativeSession.updatedAt >= before);
    assert.equal(textSession.updatedAt, before - 20_000);
    assert.equal(state.value.some((session) => session.chatId === expiredChatId), false);

    const expiredResponse = await fetch(`http://127.0.0.1:${port}/api/coach/live-session/touch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: expiredChatId,
        providerId: "chatgpt-browser",
        providerInstanceId: "edge-instance",
        nativeVoice: true,
      }),
    });
    assert.deepEqual(await expiredResponse.json(), { ok: true, touched: false, idleTimeoutMs: IDLE_TIMEOUT_MS });

    const wrongTransport = await fetch(`http://127.0.0.1:${port}/api/coach/live-session/touch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId, nativeVoice: false }),
    });
    assert.equal(wrongTransport.status, 400);
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("native live-session reuse ignores a new launch preset and keeps the original seeded preset", { timeout: 15_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-preset-reuse-"));
  const dbPath = path.join(dataRoot, "language-video-learner.sqlite3");
  const chatId = "99999999-2222-4333-8444-555555555555";
  const db = createAppDatabase(dbPath);
  db.writeSection("coachSessions", [{
    chatId,
    mode: "live",
    providerId: "chatgpt-browser",
    providerInstanceId: "edge-instance",
    conversationId: "existing-native-conversation",
    targetLanguage: "JA",
    baseLanguage: "EN",
    liveSeeded: true,
    nativeVoice: true,
    presetId: "episode-chat",
    presetLabel: "Episode chat",
    presetContext: "Discuss episode 3.",
    updatedAt: Date.now(),
  }]);
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForServer(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/api/coach/live-session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId,
        providerId: "chatgpt-browser",
        providerInstanceId: "edge-instance",
        targetLanguage: "JA",
        baseLanguage: "EN",
        presetId: "word-review",
        presetLabel: "Review words",
        presetContext: "Review the top 100 words.",
        assistanceMode: "assisted",
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.session.reused, true);
    assert.equal(payload.session.conversationId, "existing-native-conversation");
    assert.equal(payload.session.assistanceMode, "assisted");

    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/app-state/coachSessions`);
    const state = await stateResponse.json();
    const session = state.value.find((item) => item.chatId === chatId && item.nativeVoice === true);
    assert.equal(session.presetId, "episode-chat");
    assert.equal(session.presetLabel, "Episode chat");
    assert.equal(session.presetContext, "Discuss episode 3.");
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("browser coach persists native live transcript directly to SQLite with provider-entry dedupe", { timeout: 15_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-transcript-"));
  const dbPath = path.join(dataRoot, "language-video-learner.sqlite3");
  const chatId = "77777777-2222-4333-8444-555555555555";
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const db = createAppDatabase(dbPath);
  db.writeSection("coachSessions", [{
    chatId,
    mode: "live",
    providerId: "chatgpt-browser",
    providerInstanceId: "",
    conversationId,
    targetLanguage: "JA",
    baseLanguage: "EN",
    liveSeeded: true,
    nativeVoice: true,
    presetId: "top-100",
    presetLabel: "Review top 100 words",
    updatedAt: Date.now(),
  }]);
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForServer(port, child);
    const pairResponse = await fetch(`http://127.0.0.1:${port}/api/browser-coach/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: "language-video-learner-browser-extension",
        version: BROWSER_COACH_EXTENSION_VERSION,
        instanceId: "edge-test-instance",
      }),
    });
    assert.equal(pairResponse.status, 200);
    const pair = await pairResponse.json();
    assert.ok(pair.token);

    const postBatch = async (entries) => fetch(`http://127.0.0.1:${port}/api/browser-coach/live-transcript`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pair.token}`,
      },
      body: JSON.stringify({
        version: BROWSER_COACH_EXTENSION_VERSION,
        instanceId: "edge-test-instance",
        chatId,
        conversationId,
        entries,
      }),
    });

    const first = await postBatch([
      { id: "user-turn-1", role: "user", text: "こんにちは" },
      { id: "assistant-turn-1", role: "assistant", text: "元気ですか" },
    ]);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).persisted, 2);

    const replay = await postBatch([
      { id: "user-turn-1", role: "user", text: "こんにちは" },
      { id: "assistant-turn-1", role: "assistant", text: "元気ですか" },
    ]);
    assert.equal(replay.status, 200);

    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/app-state/coachTranscripts`);
    const state = await stateResponse.json();
    const transcript = state.value.find((item) => item.id === chatId);
    assert.ok(transcript);
    assert.equal(transcript.messages.length, 2);
    assert.equal(transcript.messages[0].providerEntryId, "user-turn-1");
    assert.equal(transcript.messages[1].providerEntryId, "assistant-turn-1");
    assert.equal(transcript.conversationId, conversationId);
    assert.equal(transcript.presetId, "top-100");

    const sessionsResponse = await fetch(`http://127.0.0.1:${port}/api/app-state/coachSessions`);
    const sessions = await sessionsResponse.json();
    const persistedSession = sessions.value.find((item) => item.chatId === chatId && item.nativeVoice === true);
    assert.equal(persistedSession.providerInstanceId, "edge-test-instance");
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("browser coach live-control accounting is durable and idempotent", { timeout: 15_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-usage-"));
  const dbPath = path.join(dataRoot, "language-video-learner.sqlite3");
  const chatId = "88888888-2222-4333-8444-555555555555";
  const conversationId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const db = createAppDatabase(dbPath);
  db.writeSection("coachSessions", [{
    chatId,
    mode: "live",
    providerId: "chatgpt-browser",
    providerInstanceId: "",
    conversationId,
    targetLanguage: "JA",
    baseLanguage: "EN",
    liveSeeded: true,
    nativeVoice: true,
    updatedAt: Date.now(),
  }]);
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForServer(port, child);
    const pairResponse = await fetch(`http://127.0.0.1:${port}/api/browser-coach/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: "language-video-learner-browser-extension",
        version: BROWSER_COACH_EXTENSION_VERSION,
        instanceId: "edge-usage-instance",
      }),
    });
    assert.equal(pairResponse.status, 200);
    const pair = await pairResponse.json();
    const postControl = (action) => fetch(`http://127.0.0.1:${port}/api/browser-coach/live-control`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pair.token}`,
      },
      body: JSON.stringify({
        version: BROWSER_COACH_EXTENSION_VERSION,
        instanceId: "edge-usage-instance",
        action,
        chatId,
        conversationId,
      }),
    });

    const firstStart = await postControl("start");
    assert.equal(firstStart.status, 200);
    const firstPayload = await firstStart.json();
    const startedAt = firstPayload.usage.active.startedAt;
    assert.ok(startedAt > 0);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const secondStart = await postControl("start");
    assert.equal(secondStart.status, 200);
    const secondPayload = await secondStart.json();
    assert.equal(secondPayload.usage.active.startedAt, startedAt);

    const touch = await postControl("touch");
    assert.equal(touch.status, 200);
    const touchedPayload = await touch.json();
    assert.equal(touchedPayload.usage.active.startedAt, startedAt);
    assert.ok(touchedPayload.usage.active.updatedAt >= startedAt);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const stop = await postControl("stop");
    assert.equal(stop.status, 200);
    const stopPayload = await stop.json();
    assert.equal(stopPayload.usage.active, null);
    assert.ok(stopPayload.usage.usedMs > 0);

    const duplicateStop = await postControl("stop");
    assert.equal(duplicateStop.status, 200);
    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/app-state/coachUsage`);
    const state = await stateResponse.json();
    assert.equal(state.value.active, null);
    assert.equal(state.value.segments.length, 1);
    assert.equal(state.value.segments[0].startAt, startedAt);
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("stale browser-coach extension version is visible but rejected before work dispatch", { timeout: 15_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-version-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForServer(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/api/browser-coach/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: "language-video-learner-browser-extension",
        version: "0.0.1",
        instanceId: "edge-stale-instance",
      }),
    });
    assert.equal(response.status, 426);
    const payload = await response.json();
    assert.equal(payload.error, "extension_version_mismatch");
    assert.equal(payload.expectedExtensionVersion, BROWSER_COACH_EXTENSION_VERSION);
    assert.equal(payload.extensionVersion, "0.0.1");

    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/browser-coach/status?instanceId=edge-stale-instance`);
    const status = await statusResponse.json();
    assert.equal(status.available, true);
    assert.equal(status.extensionVersion, "0.0.1");
    assert.equal(status.expectedExtensionVersion, BROWSER_COACH_EXTENSION_VERSION);
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("replace app-state writes reject a stale section revision instead of overwriting newer state", { timeout: 15_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-app-state-cas-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForServer(port, child);
    const bootstrap = await (await fetch(`http://127.0.0.1:${port}/api/app-state`)).json();
    const baseRevision = Number(bootstrap.revisions.cards || 0);
    const writeCards = (cards, expectedUpdatedAt) => fetch(`http://127.0.0.1:${port}/api/app-state/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: cards, expectedUpdatedAt }),
    });

    const first = await writeCards([{ id: "card-a", reviewCount: 4 }], baseRevision);
    assert.equal(first.status, 200);
    const firstPayload = await first.json();
    assert.ok(firstPayload.updatedAt > baseRevision);

    const stale = await writeCards([{ id: "card-a", reviewCount: 1 }], baseRevision);
    assert.equal(stale.status, 409);
    const conflict = await stale.json();
    assert.equal(conflict.error, "app_state_conflict");
    assert.equal(conflict.currentUpdatedAt, firstPayload.updatedAt);

    const state = await (await fetch(`http://127.0.0.1:${port}/api/app-state/cards`)).json();
    assert.equal(state.updatedAt, firstPayload.updatedAt);
    assert.equal(state.value[0].reviewCount, 4);

    const missingRevision = await fetch(`http://127.0.0.1:${port}/api/app-state/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: [{ id: "legacy-client", reviewCount: 0 }] }),
    });
    assert.equal(missingRevision.status, 428);
    const missingRevisionPayload = await missingRevision.json();
    assert.equal(missingRevisionPayload.error, "app_state_revision_required");

    const afterMissing = await (await fetch(`http://127.0.0.1:${port}/api/app-state/cards`)).json();
    assert.equal(afterMissing.updatedAt, firstPayload.updatedAt);
    assert.equal(afterMissing.value[0].reviewCount, 4);
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
