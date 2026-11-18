// Admission for browser-driven mutations on LVL's loopback HTTP API. A web
// page on another origin can POST a simple form to localhost, even though it
// cannot read the response. Only the app's origin/fetch metadata, or a request
// which browsers must preflight, can enter an unsafe route.
const NON_SIMPLE_TYPES = new Set([
  "application/json", "application/octet-stream",
]);

export function localMutationAllowed({ method = "GET", headers = {} } = {}, expectedOrigin) {
  if (method === "GET" || method === "HEAD") return true;
  const site = String(headers["sec-fetch-site"] || "").toLowerCase();
  const origin = typeof headers.origin === "string" ? headers.origin.toLowerCase() : "";
  if (site && site !== "same-origin" && site !== "none") return false;
  if (origin && origin !== expectedOrigin) return false;
  // A Fetch Metadata value of `none` is possible for user-initiated requests,
  // but it is not proof that a mutable request came from an LVL document.
  if (origin === expectedOrigin || site === "same-origin") return true;
  // This is the narrow native/headerless path: JSON and binary media types
  // require a CORS preflight in browsers. Simple form/text POSTs cannot pass.
  // DELETE/PUT are also non-safelisted methods and always require preflight.
  if (method === "DELETE" || method === "PUT" || method === "PATCH") return true;
  if (method !== "POST") return false;
  const contentType = String(headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  return NON_SIMPLE_TYPES.has(contentType) || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(contentType);
}
