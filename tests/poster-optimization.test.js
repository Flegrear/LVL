import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const source = server.slice(server.indexOf("function validatedOptimizedPosterSource("), server.indexOf("async function optimizedTvMazePoster("));

test("optimized poster fetch only accepts an exact TVMaze original image URL", () => {
  assert.ok(source.startsWith("function validatedOptimizedPosterSource("));
  const ctx = vm.createContext({
    URL,
    validateArtworkImageUrl(value) {
      try {
        const u = new URL(value);
        return u.protocol === "https:" && u.origin === "https://static.tvmaze.com" ? value : null;
      } catch { return null; }
    },
  });
  vm.runInContext(source, ctx);
  const check = vm.runInContext("validatedOptimizedPosterSource", ctx);
  const valid = "https://static.tvmaze.com/uploads/images/original_untouched/626/1566363.jpg";
  assert.equal(check(valid), valid);
  for (const url of [
    "https://evil.example/uploads/images/original_untouched/626/1566363.jpg",
    "http://static.tvmaze.com/uploads/images/original_untouched/626/1566363.jpg",
    "https://static.tvmaze.com/uploads/images/original_untouched/626/1566363.jpg?redirect=1",
    "https://static.tvmaze.com/private/other.jpg",
    "https://static.tvmaze.com/uploads/images/original_untouched/626/1566363.svg",
    "http://127.0.0.1:4187/api/app-state",
  ]) assert.equal(check(url), null);
});

test("poster conversion bounds source bytes, WebP output and memory cache", () => {
  assert.match(server, /const MAX_POSTER_SOURCE_BYTES = 4 \* 1024 \* 1024/);
  assert.match(server, /const MAX_POSTER_WEBP_BYTES = 360 \* 1024/);
  assert.match(server, /bytes > MAX_POSTER_SOURCE_BYTES/);
  assert.match(server, /size > MAX_POSTER_WEBP_BYTES/);
  assert.match(server, /optimizedPosterCache\.size > 24/);
  assert.match(server, /redirect: "error"/);
  assert.match(server, /url\.pathname === "\/api\/images\/poster"/);
  assert.match(app, /function libraryCardImage\([\s\S]*?boundedPosterUrl\(imdb\)/);
  assert.match(app, /const heroPosterSrcset = posterSrcset\(/);
  assert.match(app, /heroPosterSrcset \? ` srcset=/);
  assert.match(app, /entry\.artworkPinned = true/, "user-uploaded cover stays pinned");
});
