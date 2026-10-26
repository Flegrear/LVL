import test from "node:test";
import assert from "node:assert/strict";
import {
  animeCatalogRootName, animeCatalogRootSearchNames, animeCatalogSearchNames,
  verifiedAnimeCatalogMatch,
} from "../frontend/catalog/anime-catalog-match.js";

test("sequel suffixes reduce only explicit season markers, preserving actual series names", () => {
  assert.equal(animeCatalogRootName("The Apothecary Diaries Season 3"), "The Apothecary Diaries");
  assert.equal(animeCatalogRootName("Kusuriya no Hitorigoto 3rd Season"), "Kusuriya no Hitorigoto");
  assert.equal(animeCatalogRootName("Black Clover Season 2"), "Black Clover");
  assert.equal(animeCatalogRootName("Blue Box"), "Blue Box");
  assert.equal(animeCatalogRootName("86"), "86");
  assert.equal(animeCatalogRootName("The Quintessential Quintuplets 2"), "The Quintessential Quintuplets 2");
  assert.deepEqual(animeCatalogRootSearchNames({ title: "Black Clover Season 2" }), ["Black Clover"]);
  assert.deepEqual(animeCatalogSearchNames({ title: "Blue Box", titleAlt: "Blue Box" }), ["Blue Box"]);
});

test("Apothecary Diaries season 3 maps to 2023 show, not the similarly named future 2028 title", () => {
  const media = { title: "The Apothecary Diaries Season 3", titleAlt: "Kusuriya no Hitorigoto 3rd Season", year: 2026, format: "TV" };
  const rows = [
    { id: "tt26743760", name: "The Apothecary Diaries", type: "series", releaseInfo: "2023-" },
    { id: "tt39555283", name: "The Apothecary Diaries", type: "series", releaseInfo: "2028-" },
    { id: "tt33630570", name: "The Princess Diaries 3", type: "movie", releaseInfo: "2026" },
  ];
  assert.equal(verifiedAnimeCatalogMatch(media, rows)?.id, "tt26743760");
});

test("Black Clover season 2 maps to the root original series with a verified year", () => {
  const media = { title: "Black Clover Season 2", year: 2026, format: "TV" };
  assert.equal(verifiedAnimeCatalogMatch(media, [
    { id: "tt7441658", name: "Black Clover", type: "series", releaseInfo: "2017" },
    { id: "tt22868844", name: "Black Clover: Sword of the Wizard King", type: "movie", releaseInfo: "2023" },
  ])?.id, "tt7441658");
});

test("Blue Box remains an exact match; unrelated movies are never substituted", () => {
  const media = { title: "Blue Box", year: 2024, format: "TV" };
  const rows = [
    { id: "tt32639706", name: "Blue Box", type: "series", releaseInfo: "2024" },
    { id: "tt37897225", name: "Blue Box", type: "movie", releaseInfo: "2026" },
  ];
  assert.equal(verifiedAnimeCatalogMatch(media, rows)?.id, "tt32639706");
});

test("a reboot with the same title is left unresolved instead of guessing", () => {
  const media = { title: "Example Season 2", year: 2026, format: "TV" };
  const candidates = [
    { id: "tt100000", name: "Example", type: "series", releaseInfo: "2001" },
    { id: "tt200000", name: "Example", type: "series", releaseInfo: "2024" },
  ];
  assert.equal(verifiedAnimeCatalogMatch(media, candidates), null);
  assert.equal(verifiedAnimeCatalogMatch(media, [
    { id: "tt999999", name: "Unrelated title", type: "series", releaseInfo: "2020" },
  ]), null);
  assert.equal(verifiedAnimeCatalogMatch({ ...media, year: null }, candidates), null);
});

test("exact sequel series titles are accepted even without a separate IMDb year", () => {
  const media = { title: "Something Season 2", year: 2025, format: "TV" };
  assert.equal(verifiedAnimeCatalogMatch(media, [
    { id: "tt55555", name: "Something Season 2", type: "series" },
  ])?.id, "tt55555");
});
