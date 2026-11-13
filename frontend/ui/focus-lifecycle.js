// Focus continuity across an owned DOM replacement. The caller decides when to
// replace markup and calls captureFocus immediately before doing so.
// No global handlers, timers or focus changes occur at import/capture time.

const FOCUSABLE_SELECTOR = [
  "button", 'input:not([type="hidden"])', "select", "textarea",
  "a[href]", "area[href]", "summary", "[tabindex]", "[contenteditable]",
].join(", ");
const DATA_KEY = /^data-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function isUsableFocusTarget(node) {
  if (!node || node.nodeType !== 1 || !node.isConnected || typeof node.focus !== "function")
    return false;
  if (!node.matches?.(FOCUSABLE_SELECTOR) || node.matches?.(":disabled") || node.disabled
    || node.getAttribute?.("aria-disabled") === "true")
    return false;
  if (node.closest?.('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
  const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
  if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"))
    return false;
  return true;
}

function focusIfUsable(node) {
  if (!isUsableFocusTarget(node)) return false;
  try {
    node.focus({ preventScroll: true });
    return node.ownerDocument?.activeElement === node;
  } catch {
    return false;
  }
}

export function restoreConnectedFocus(trigger, { fallback = null } = {}) {
  return focusIfUsable(trigger) || (fallback !== trigger && focusIfUsable(fallback));
}

function captureTextSelection(node) {
  if (!node?.matches?.("input, textarea")) return null;
  try {
    const start = node.selectionStart, end = node.selectionEnd;
    if (Number.isInteger(start) && Number.isInteger(end))
      return { tag: node.tagName, type: node.type || "", start, end,
        direction: node.selectionDirection || "none" };
  } catch { /* Native numeric, checkbox and other unsupported input types. */ }
  return null;
}

export function captureFocus(root, { keyAttribute = "data-focus-key" } = {}) {
  if (!DATA_KEY.test(keyAttribute)) throw new TypeError("Focus key must be a lowercase data-* attribute");
  if (root?.nodeType !== 1 || !root.ownerDocument || typeof root.contains !== "function"
    || typeof root.querySelectorAll !== "function") throw new TypeError("Focus root must be an element");

  const doc = root.ownerDocument;
  const originallyFocused = root.contains(doc.activeElement) ? doc.activeElement : null;
  const key = originallyFocused?.getAttribute?.(keyAttribute) ?? null;
  const selection = captureTextSelection(originallyFocused);
  let consumed = false;

  return {
    restore({ fallback = null } = {}) {
      if (consumed || !originallyFocused || !root.isConnected) return false;
      const current = doc.activeElement;
      // A user can switch to another connected control within this section,
      // another section, or a dialog during an asynchronous save. Do not steal it.
      if (current && current !== originallyFocused && current !== doc.body
        && current !== doc.documentElement && current.isConnected) return false;

      let target = null;
      if (root.contains(originallyFocused) && isUsableFocusTarget(originallyFocused)) {
        target = originallyFocused;
      } else if (key !== null) {
        // The attribute name has been validated above. Match VALUES by
        // iteration, never insert untrusted values into CSS selectors.
        const matches = [...root.querySelectorAll(`[${keyAttribute}]`)]
          .filter((node) => node.getAttribute(keyAttribute) === key);
        if (matches.length === 1) target = matches[0];
      }

      const didRestore = restoreConnectedFocus(target, { fallback });
      if (!didRestore) return false;
      consumed = true;
      const focused = doc.activeElement;
      if (selection && target && focused === target && focused?.tagName === selection.tag
        && (focused.type || "") === selection.type
        && typeof focused.setSelectionRange === "function") {
        try { focused.setSelectionRange(selection.start, selection.end, selection.direction); } catch {}
      }
      return true;
    },
  };
}
