// Additive v2 identities; never replace legacy track.id/cue.id or saved
// cards without explicit file+container-stream+cue proof. Unverified imports
// remain owned by their original session-local IDs until a safe migration.
import { mediaSourceOwnerKey } from "./subtitle-stream.js";

export const SUBTITLE_REFERENCE_SCHEMA = "lvl.subtitle-cue-ref.v2";

export function verifiedSubtitleStreamReference(source, streamIndex) {
  const mediaOwner = mediaSourceOwnerKey(source);
  const raw = streamIndex;
  if (!mediaOwner || !(mediaOwner.startsWith("torrent:")
    && /^torrent:[a-f0-9]{40}:[0-9]+$/.test(mediaOwner)
    || mediaOwner.startsWith("local:") && mediaOwner.length > 6)
    || typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return null;
  return Object.freeze({ schema: SUBTITLE_REFERENCE_SCHEMA, mediaOwner, streamIndex: raw });
}

export function verifiedSubtitleCueReference(streamRef, cue) {
  if (streamRef?.schema !== SUBTITLE_REFERENCE_SCHEMA || !streamRef.mediaOwner
    || !Number.isSafeInteger(streamRef.streamIndex) || streamRef.streamIndex < 0) return null;
  const startMs = Number(cue?.startMs), endMs = Number(cue?.endMs);
  const text = cue?.text;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
    || endMs <= startMs || typeof text !== "string" || !text.trim() || text.length > 8192)
    return null;
  return Object.freeze({
    schema: SUBTITLE_REFERENCE_SCHEMA,
    mediaOwner: streamRef.mediaOwner, streamIndex: streamRef.streamIndex,
    cue: Object.freeze({
      startMs, endMs, text,
      actor: String(cue?.actor ?? ""), layer: String(cue?.layer ?? ""),
      style: String(cue?.style ?? ""), kind: String(cue?.kind ?? ""),
    }),
  });
}

export function resolveVerifiedSubtitleCueReference(reference, source, streamIndex, cues) {
  const owner = verifiedSubtitleStreamReference(source, streamIndex);
  if (!owner || reference?.schema !== SUBTITLE_REFERENCE_SCHEMA
    || owner.mediaOwner !== reference.mediaOwner
    || owner.streamIndex !== reference.streamIndex
    || !Array.isArray(cues)) return null;
  const expected = reference.cue;
  if (!expected || typeof expected.text !== "string") return null;
  let matched = null;
  for (const cue of cues) {
    if (cue?.startMs !== expected.startMs || cue?.endMs !== expected.endMs
      || cue?.text !== expected.text
      || String(cue.actor ?? "") !== expected.actor
      || String(cue.layer ?? "") !== expected.layer
      || String(cue.style ?? "") !== expected.style
      || String(cue.kind ?? "") !== expected.kind) continue;
    // Ambiguous duplicate cue evidence is not authority to move a saved card.
    if (matched) return null;
    matched = cue;
  }
  return matched;
}
