import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as ankiweb from "../learning/anki/ankiweb.js";

const deckBytes = () => {
  const title = Buffer.from("Japanese vocabulary");
  const row = Buffer.concat([Buffer.from([8, 1, 18, title.length]), title]);
  return Buffer.concat([Buffer.from([10, row.length]), row]);
};

async function upstream(t, handle) {
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("AnkiWeb retries a short rate limit and coalesces simultaneous searches", async (t) => {
  let requests = 0;
  const origin = await upstream(t, (req, res) => {
    requests += 1;
    if (requests === 1) { res.writeHead(429, { "Retry-After": "0" }); res.end(); }
    else res.end(deckBytes());
  });
  const client = ankiweb.createAnkiwebClient({ origin });
  const [first, second] = await Promise.all([client.searchSharedDecks("Japanese"), client.searchSharedDecks("japanese")]);
  assert.equal(first[0].title, "Japanese vocabulary");
  assert.deepEqual(first, second);
  assert.equal(requests, 2);
  await client.searchSharedDecks("Japanese");
  assert.equal(requests, 2);
});

test("AnkiWeb returns a previous search during a long rate limit", async (t) => {
  let now = 0;
  let limited = false;
  const origin = await upstream(t, (req, res) => {
    if (limited) { res.writeHead(429, { "Retry-After": "120" }); res.end(); }
    else res.end(deckBytes());
  });
  const client = ankiweb.createAnkiwebClient({ origin, now: () => now });
  await client.searchSharedDecks("Japanese");
  now += 24 * 60 * 60 * 1000;
  limited = true;
  const rows = await client.searchSharedDecks("Japanese");
  assert.equal(rows[0].id, 1);
  assert.equal(rows.stale, true);
});

test("AnkiWeb preserves 429 and offers an import fallback without a long blocking wait", async (t) => {
  const origin = await upstream(t, (req, res) => { res.writeHead(429, { "Retry-After": "120" }); res.end(); });
  const client = ankiweb.createAnkiwebClient({ origin });
  await assert.rejects(client.searchSharedDecks("new"), (error) => {
    assert.equal(error.statusCode, 429);
    assert.match(error.message, /120/);
    assert.match(error.message, /\.apkg/);
    return true;
  });
});
