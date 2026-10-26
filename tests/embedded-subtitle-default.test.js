import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultEmbeddedSubtitleTrack } from "../frontend/player/embedded-subtitle-default.js";

const textTrack = (streamIndex, language, extra = {}) => ({ streamIndex, language, textBased: true, ...extra });
const normalize = (language) => ({ eng: "EN", spa: "ES", jpn: "JA" })[language] || language;

test("Video-embedded subtitles are selected on fresh playback using preferred language then default flag", () => {
  const media = { subtitleTracks: [textTrack(5, "spa"), textTrack(3, "eng"), textTrack(8, "jpn")] };
  assert.equal(defaultEmbeddedSubtitleTrack({ media, languages: ["EN", "ES"], normalizeLanguage: normalize }).streamIndex, 3);
  assert.equal(defaultEmbeddedSubtitleTrack({ media, languages: ["FR"], normalizeLanguage: normalize }).streamIndex, 5);
  assert.equal(defaultEmbeddedSubtitleTrack({ media: { subtitleTracks: [textTrack(1, "jpn"), textTrack(2, "eng", { disposition: { default: 1 } })] } }).streamIndex, 2);
});

test("Automatic embedded subtitles do not override a user's captions-off or chosen saved track", () => {
  const media = { subtitleTracks: [textTrack(1, "eng")] };
  assert.equal(defaultEmbeddedSubtitleTrack({ media, captionsEnabled: false }), null);
  assert.equal(defaultEmbeddedSubtitleTrack({ media, attached: [{ cues: [{ text: "saved" }], visible: false }] }), null);
  assert.equal(defaultEmbeddedSubtitleTrack({ media: { subtitleTracks: [{ streamIndex: 2, textBased: false }] } }), null);
});

test("Player initializes embedded caption extraction on both early and delayed media probe", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /enableDefaultEmbeddedSubtitles\(probedMedia, startAtSeconds, \{ urgent: startAtSeconds >= 12 \}\)/);
  assert.match(app, /enableDefaultEmbeddedSubtitles\(media, startAtSeconds, \{ urgent: startAtSeconds >= 12 \}\)/);
  assert.match(app, /importEmbeddedSubtitleTrack\(candidate, null, \{ automatic: true, activate: true/);
  assert.match(app, /activate && state\.subtitlesVisible && controller\.visibilityRevision === subtitleVisibilityRevision && !currentSourceTracks\(\)\.some/);
  assert.match(app, /initialEmbeddedSubtitleSource === key/);
});
