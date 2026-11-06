// Retain settings belonging to unavailable features without activating them.
// Unknown saved fields survive a core-only preference edit or backup round trip.
const fields = {
  studySource: "study-source", studyChapterId: "study-chapter-id", studyType: "study-type",
  studyWordTier: "study-word-tier", studyPhraseTier: "study-phrase-tier", studyFilter: "study-filter",
  reviewMode: "review-mode", coachProviderId: "coach-provider", voiceMode: "voice-mode",
  voiceLivePresetId: "live-preset", voiceLiveAssistance: "live-assistance",
};
let retained = {};
for (const [field, key] of Object.entries(fields)) {
  const value = localStorage.getItem("blackline-" + key);
  if (value !== null) retained[field] = value;
}
for (const [field, key] of Object.entries({ discardedAutoCardKeys: "discarded-auto-cards", voiceUsageSegments: "voice-usage" })) {
  try {
    const value = JSON.parse(localStorage.getItem("blackline-" + key) || "null");
    if (Array.isArray(value)) retained[field] = value;
  } catch {}
}
const coloring = localStorage.getItem("blackline-word-coloring");
if (coloring !== null) retained.wordColoring = coloring !== "0";
const voiceAudio = {};
for (const [field, key] of Object.entries({ speakReplies: "speak-replies", autoContinue: "auto-continue", voiceURI: "tts-uri", rate: "tts-rate", inputLanguage: "input-language" })) {
  const value = localStorage.getItem("blackline-voice-" + key);
  if (value !== null) voiceAudio[field] = ["speakReplies", "autoContinue"].includes(field)
    ? value !== "0" : field === "rate" ? Number(value) : value;
}
if (Object.keys(voiceAudio).length) retained.voiceAudio = voiceAudio;

export function preserveLegacyPreferences(preferences) {
  if (preferences && typeof preferences === "object" && !Array.isArray(preferences))
    retained = { ...retained, ...preferences };
}

export function legacyPreferencesSnapshot() {
  return { ...retained };
}

export function discardedCardKeys() {
  return Array.isArray(retained.discardedAutoCardKeys) ? retained.discardedAutoCardKeys : [];
}

export function mergeDiscardedCardKeys(incoming) {
  retained.discardedAutoCardKeys = [...new Set([...discardedCardKeys(), ...incoming.map(String)])].slice(-20_000);
  localStorage.setItem("blackline-discarded-auto-cards", JSON.stringify(retained.discardedAutoCardKeys));
}
