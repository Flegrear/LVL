// Commit subjects describe plain edits. Encrypted records expose no title or activity.
export function syncCommitMessage(path, text) {
  const fallback = `LVL sync: ${path}`;
  let data;
  try { data = JSON.parse(text); } catch { return fallback; }
  if (!Array.isArray(data?.changes)) return fallback;
  if (path.startsWith("snapshots/")) return `LVL sync: Save device snapshot\n\nFile: ${path}`;
  const titles = new Set();
  const episodes = new Set();
  const counts = new Map();
  const labels = {
    "video.progress": ["playback position", "playback positions"],
    "video.title": ["library title", "library titles"],
    "video.imported-watched": ["imported watched episode", "imported watched episodes"],
    "comic.library": ["comic in library", "comics in library"],
    "comic.read": ["comic reading position", "comic reading positions"],
    "rating.lvl": ["rating", "ratings"], "rating.imported": ["imported rating", "imported ratings"],
  };
  for (const change of data.changes) {
    const value = change?.value;
    const title = value?.context?.title || value?.title || value?.displayTitle;
    if (typeof title === "string") {
      const cleaned = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
      if (cleaned) titles.add(cleaned);
    }
    const episode = value?.context?.episode;
    if (typeof episode === "string" && /^S\d{2,3}E\d{2,4}$/.test(episode))
      episodes.add(episode);
    const label = value === null ? ["removed record", "removed records"]
      : change?.type === "video.watched"
        ? (value?.watched ? ["episode marked watched", "episodes marked watched"]
          : ["episode marked unwatched", "episodes marked unwatched"])
        : (Object.hasOwn(labels, change?.type) ? labels[change.type] : ["record changed", "records changed"]);
    const key = label.join("\n");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const summary = [...counts].map(([key, count]) => `${count} ${key.split("\n")[count === 1 ? 0 : 1]}`).join(", ");
  if (!summary) return fallback;
  const fullTitle = [...titles][0];
  const title = fullTitle && (Array.from(fullTitle).length > 80 ? Array.from(fullTitle).slice(0, 79).join("") + "…" : fullTitle);
  // Up to three verified chapter labels fit on a useful GitHub history line.
  // A large multi-series or encrypted batch uses the existing privacy-safe
  // generic summary rather than exposing or guessing chapter identities.
  const chapterLabel = titles.size === 1 && episodes.size > 0 && episodes.size <= 3
    ? ` (${[...episodes].sort().join(", ")})` : "";
  const subject = `LVL sync: ${title ? `${title}${titles.size > 1 ? ` (+${titles.size - 1} titles)` : ""}${chapterLabel} — ` : ""}${summary}`;
  const characters = Array.from(subject);
  return `${characters.length > 160 ? characters.slice(0, 159).join("") + "…" : subject}\n\nFile: ${path}`;
}
