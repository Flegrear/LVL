import test from "node:test";
import assert from "node:assert/strict";
import { catalogTitleDetails, cleanNames, cleanTrailers, isoDay } from "../backend/catalog/catalog-details.js";

test("title details keep people, dates, status, awards and trailers from a Cinemeta meta", () => {
  const details = catalogTitleDetails({
    cast: ["Atsumi Tanezaki", " Kana  Ichinose ", "Atsumi Tanezaki", ""],
    director: [],
    writer: ["Tsukasa Abe", "Kanehito Yamada"],
    links: [
      { name: "8.9", category: "imdb", url: "https://imdb.com/title/tt22248376" },
      { name: "Keiichirō Saitō", category: "Directors", url: "stremio:///search?search=x" },
    ],
    country: "Japan",
    awards: "17 wins & 35 nominations total",
    status: "Continuing",
    released: "2023-09-29T00:00:00.000Z",
    trailerStreams: [{ title: "Official trailer", ytId: "01WEqntM1NI" }],
    trailers: [{ source: "01WEqntM1NI", type: "Trailer" }, { source: "Y3l9RTUiYy0", type: "Trailer" }, { source: "javascript:alert(1)", type: "Trailer" }],
  });
  assert.deepEqual(details.cast, ["Atsumi Tanezaki", "Kana Ichinose"]);
  assert.deepEqual(details.director, ["Keiichirō Saitō"], "directors come from the links when the list is empty");
  assert.deepEqual(details.writer, ["Tsukasa Abe", "Kanehito Yamada"]);
  assert.equal(details.country, "Japan");
  assert.equal(details.awards, "17 wins & 35 nominations total");
  assert.equal(details.status, "Continuing");
  assert.equal(details.released, "2023-09-29");
  assert.deepEqual(details.trailers, [{ id: "01WEqntM1NI", title: "Official trailer" }, { id: "Y3l9RTUiYy0", title: "Trailer" }]);
});

test("missing or malformed fields come back empty instead of invented", () => {
  assert.deepEqual(catalogTitleDetails({}), { cast: [], director: [], writer: [], country: "", awards: "", status: "", released: "", trailers: [] });
  assert.deepEqual(catalogTitleDetails(null).trailers, []);
  assert.equal(isoDay("September 2023"), "");
  assert.equal(isoDay("2023-13-01"), "");
  assert.equal(isoDay("2023-09-29"), "2023-09-29");
  assert.deepEqual(cleanNames("A, B, a"), ["A", "B"]);
  assert.equal(cleanNames(Array.from({ length: 30 }, (_, i) => `Name ${i}`)).length, 12);
  assert.deepEqual(cleanTrailers({ trailers: [{ source: "short" }, { source: "abcdefghijk", type: "Clip" }] }), [{ id: "abcdefghijk", title: "Clip" }]);
});
