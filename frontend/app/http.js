// JSON requests to LVL's own server.
async function readJsonResponse(response) {
  // Failed endpoints may return plain text (including upstream 503s). Keep the
  // useful response detail instead of losing it to JSON parsing failure.
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { detail: text.slice(0, 512) }; }
  if (!response.ok) {
    const detail = typeof data === "object" && data !== null
      ? String(data.detail || data.message || data.error || `Request failed (${response.status})`)
      : String(data || `Request failed (${response.status})`);
    const message = typeof data === "object" && data !== null
      ? String(data.message || (data.error && !/^[a-z0-9_]+$/.test(String(data.error)) ? data.error : detail))
      : detail;
    const error = new Error(message || `Request failed (${response.status})`);
    error.status = response.status;
    error.httpStatus = response.status;
    error.code = String((typeof data === "object" && data !== null && (data.code || data.error)) || `HTTP_${response.status}`);
    error.detail = detail;
    error.data = data;
    throw error;
  }
  return data;
}

export async function postJson(url, payload, { signal } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  return readJsonResponse(response);
}

export async function fetchJson(url, { signal } = {}) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
  return readJsonResponse(response);
}
