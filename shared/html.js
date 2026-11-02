// Escaping text for HTML. The page and the server share these.
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };

// For element content and for attribute values in single or double quotes.
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ESCAPES[char]);
}

// The same, leaving apostrophes as they are: card and deck HTML has always been written this
// way, so cards made now still match the saved ones.
export function escapeHtmlText(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ESCAPES[char]);
}
