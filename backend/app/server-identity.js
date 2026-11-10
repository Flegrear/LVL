import { createHmac } from "node:crypto";

// The Android shell passes a new app-private key to each spawned Node process.
// A health 200 alone never authenticates a listener on the fixed loopback port.
export function isValidAndroidChallenge(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function createAndroidChildProof(secret, challenge) {
  if (!isValidAndroidChallenge(challenge) || typeof secret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const key = Buffer.from(secret, "base64url");
  if (key.length !== 32) return null;
  return createHmac("sha256", key)
    .update(`LVL-Android-Child:v1:${challenge}`)
    .digest("base64url");
}

export function attachAndroidHealthProof(req, res, secret) {
  const proof = createAndroidChildProof(secret, req.headers["x-lvl-android-challenge"]);
  res.setHeader("Cache-Control", "no-store");
  if (proof) res.setHeader("X-LVL-Android-Proof", proof);
}
