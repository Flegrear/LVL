// Existing saved media remains user data while its owning feature is unavailable.
// Read usage without creating tables, opening media files or running housekeeping.
export function readLegacyMediaUsage(db) {
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const clips = {};
  if (exists("clips")) {
    for (const row of db.prepare("SELECT kind, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM clips GROUP BY kind").all())
      clips[row.kind] = { count: Number(row.count), bytes: Number(row.bytes) };
  }
  const decks = exists("anki_decks")
    ? db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(media_bytes), 0) AS mediaBytes FROM anki_decks").get()
    : { count: 0, mediaBytes: 0 };
  return { clips, decks: { count: Number(decks.count), mediaBytes: Number(decks.mediaBytes) } };
}
