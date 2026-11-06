// Shared source-file boundary for the new LVL 0.1.0 setup builder.
// This module selects program inputs only; it never copies files or builds a setup.
// The installer must enumerate files through this rule rather than recursively
// packaging the repository or relying on Git's index.

const applicationRoots = Object.freeze([
  "assets/", "backend/", "frontend/", "shared/",
]);
const applicationEntries = new Set([
  "app.js", "index.html", "server.js", "package.json", "CHANGELOG.md",
]);
// Feature development sources are kept outside the installed application.
const excludedRoots = ["frontend/learning/", "backend/learning/"];

export function isSetupSourceFile(relativePath) {
  if (typeof relativePath !== "string" || !relativePath) return false;
  const name = relativePath.replaceAll("\\", "/");
  if (name.startsWith("/") || name.includes(":") || name.includes("\0")) return false;
  const components = name.split("/");
  if (components.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  if (excludedRoots.some(prefix => name.startsWith(prefix))) return false;
  if (/(?:\.env|\.log|\.db|\.db-wal|\.db-shm|\.sqlite|\.sqlite3|\.sqlite3-wal|\.sqlite3-shm|\.pem|\.key|\.p12|\.pfx|\.bak|\.tmp)$/i.test(name)) return false;
  if (applicationEntries.has(name)) return true;
  return applicationRoots.some((prefix) => name.startsWith(prefix));
}

// Explicitly not allowed: docs/, tests/, devtools/, scripts/, old installer
// directories, local user data, Git metadata and generated build artifacts.
// Runtime dependencies/Node/FFmpeg are handled separately by the future setup.

// Previously installed sources can be removed by an update, but never added back
// through the current application allowlist. User data is outside this list.
const retiredSources = new Set([
  "backend/learning/browser-coach.js",
  "backend/learning/learning-store.js",
  "backend/learning/voice-coach.js",
  "frontend/learning/clips.js",
  "frontend/learning/index.js",
  "frontend/learning/learning-state.js",
  "frontend/learning/learning-views.js",
  "frontend/learning/review-quiz.js",
  "frontend/learning/scored-tests.js",
  "frontend/learning/study-decks.js",
  "frontend/learning/study-page.js",
  "frontend/learning/study-vocabulary.js",
  "frontend/learning/vocabulary-cards.js",
  "frontend/learning/voice-coach.js",
  "learning/anki/anki-render.js",
  "learning/anki/anki-store.js",
  "learning/anki/anki.js",
  "learning/anki/ankiweb.js",
  "learning/browser/core.js",
  "learning/browser/learn.js",
  "learning/browser/review-scheduler.js",
  "learning/browser/vocabulary-meanings.js",
  "learning/clips.js",
  "learning/coach-core.js",
  "learning/data/NOTICE.md",
  "learning/data/de.glosses.tsv",
  "learning/data/de.phrases.tsv",
  "learning/data/de.words.tsv",
  "learning/data/en.glosses.tsv",
  "learning/data/en.phrases.tsv",
  "learning/data/en.words.tsv",
  "learning/data/es.glosses.tsv",
  "learning/data/es.phrases.tsv",
  "learning/data/es.words.tsv",
  "learning/data/fr.glosses.tsv",
  "learning/data/fr.phrases.tsv",
  "learning/data/fr.words.tsv",
  "learning/data/it.glosses.tsv",
  "learning/data/it.phrases.tsv",
  "learning/data/it.words.tsv",
  "learning/data/ja.glosses.tsv",
  "learning/data/ja.phrases.tsv",
  "learning/data/ja.words.tsv",
  "learning/data/ko.glosses.tsv",
  "learning/data/ko.phrases.tsv",
  "learning/data/ko.words.tsv",
  "learning/data/manifest.json",
  "learning/data/nl.glosses.tsv",
  "learning/data/nl.phrases.tsv",
  "learning/data/nl.words.tsv",
  "learning/data/pl.glosses.tsv",
  "learning/data/pl.phrases.tsv",
  "learning/data/pl.words.tsv",
  "learning/data/pt.glosses.tsv",
  "learning/data/pt.phrases.tsv",
  "learning/data/pt.words.tsv",
  "learning/data/ru.glosses.tsv",
  "learning/data/ru.phrases.tsv",
  "learning/data/ru.words.tsv",
  "learning/data/tr.glosses.tsv",
  "learning/data/tr.phrases.tsv",
  "learning/data/tr.words.tsv",
  "learning/data/zh.glosses.tsv",
  "learning/data/zh.phrases.tsv",
  "learning/data/zh.words.tsv",
  "learning/preset-decks.js",
  "learning/presets.js",
  "learning/subtitle-processing.js"
]);

export function isRetiredSetupSourceFile(name) {
  return typeof name === "string" && retiredSources.has(name);
}
