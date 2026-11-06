// Subtitle track normalization and alignment, shared by player clients.
import { alignCueArtifacts, processCueArtifact } from "./cue-alignment.js";
import { json, readJsonBody } from "../app/http-helpers.js";

export async function processSubtitleTrack(req, res) {
  const body = await readJsonBody(req, 2 * 1024 * 1024);
  json(res, 200, { artifact: processCueArtifact(body.artifact || body.track || body) });
}

export async function alignSubtitleTracks(req, res) {
  const body = await readJsonBody(req, 4 * 1024 * 1024);
  const tracks = Array.isArray(body.tracks) ? body.tracks : body.artifacts;
  json(res, 200, alignCueArtifacts(tracks, { referenceTrackId: body.referenceTrackId }));
}
