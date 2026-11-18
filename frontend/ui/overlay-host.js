// A typed, document-local ordering authority for modal/dialog, popup, and
// tooltip owners. Document Picture-in-Picture has an independent stack. Call
// registerOverlayOwner AFTER showModal/opening, and invoke its disposer on
// closure. Player may use this API without sharing its native back handler.
// No DOM prototype or global key-handler monkey patching is necessary.
const ownersByDocument = new WeakMap();
const noop = () => {};

function live(entry) {
  const element = entry.element;
  // A portal can adopt an element into Document PiP. Its former document must
  // immediately stop considering that owner for local Back/Escape routing.
  if (!element || element.ownerDocument !== entry.ownerDocument
    || element.isConnected === false || element.hidden === true) return false;
  if ((element.tagName === "DIALOG" || element.matches?.("dialog"))
    && element.open === false && !element.matches?.(":modal")) return false;
  return true;
}

function liveOwners(doc) {
  const owners = ownersByDocument.get(doc) || [];
  // A disconnected/closed owner is never eligible for Back/Escape even if its
  // caller forgot the disposer; re-registration still refreshes ordering.
  for (const owner of [...owners]) if (!live(owner)) owner.dispose();
  return ownersByDocument.get(doc) || [];
}

// Register/reopen promotes the same element to the end of its document's LIFO.
// The returned disposer is safe to call twice and cannot unregister a newer
// registration of the same element. 'close' also tears down dialog ownership.
export function registerOverlayOwner(element, { dismiss = null, kind = "overlay" } = {}) {
  const doc = element?.ownerDocument;
  if (!doc) throw new TypeError("An overlay owner needs an owning Document");
  if (dismiss !== null && typeof dismiss !== "function")
    throw new TypeError("Overlay dismiss must be a synchronous function");
  const owners = liveOwners(doc);
  for (const prior of [...owners]) if (prior.element === element) prior.dispose();
  const controller = new AbortController();
  const owner = { element, ownerDocument: doc, kind: String(kind || "overlay"), dismiss, dispose: noop };
  let disposed = false;
  owner.dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    const index = owners.indexOf(owner);
    if (index !== -1) owners.splice(index, 1);
    if (!owners.length) ownersByDocument.delete(doc);
  };
  owners.push(owner);
  ownersByDocument.set(doc, owners);
  if (element.matches?.("dialog") || element.tagName === "DIALOG")
    element.addEventListener?.("close", owner.dispose, { signal: controller.signal });
  return owner.dispose;
}

export function listOverlayOwners(ownerDocument = globalThis.document) {
  if (!ownerDocument) return [];
  return liveOwners(ownerDocument).map(({ element, kind, dismiss }) =>
    ({ element, kind, dismiss }));
}

// A modal belongs to the browser top layer and must outrank any background
// menu. Opening order is the explicit registration order, never DOM sibling
// order. Focus can identify an unregistered top-layer modal when one is open;
// an ambiguous group of unregistered, unfocused modals is intentionally
// unresolved rather than guessing and dismissing a background dialog.
function topModal(doc, owners) {
  const modals = [...(doc?.querySelectorAll?.("dialog[open]") || [])]
    .filter((element) => element.matches?.(":modal"));
  if (!modals.length) return { modal: null, ambiguous: false };
  const registered = owners.filter(({ element }) => modals.includes(element));
  const focused = doc.activeElement?.closest?.("dialog[open]");
  const focusedModal = modals.includes(focused) ? focused : null;
  const latest = registered.at(-1)?.element || null;
  const unknown = modals.filter((element) =>
    !registered.some(({ element: known }) => known === element));
  // A known registration only orders *known* opens. It cannot establish
  // whether a different native :modal was opened before or after it. In a
  // mixed stack, an actively focused unknown dialog is the only available
  // positive native owner witness. If focus is outside (or points to a known
  // dialog), do not dispatch Escape/Back or portal into a possibly inert
  // background modal. DOM sibling order is never opening-order evidence.
  if (unknown.length) {
    if (focusedModal && unknown.includes(focusedModal))
      return { modal: focusedModal, ambiguous: false };
    if (modals.length === 1)
      return { modal: unknown[0], ambiguous: false };
    return { modal: null, ambiguous: true };
  }
  // All native modals have registered opening order. Temporary focus outside
  // the top layer (or inside an older modal) does not change that order.
  if (latest) return { modal: latest, ambiguous: false };
  return { modal: null, ambiguous: true };
}

// Player's coordinator can distinguish "no native modal" from "native order
// unresolved" without DOM-last fallback. This is additive; the existing owner
// APIs and their return shapes remain unchanged.
export function getNativeModalDecision(ownerDocument = globalThis.document) {
  if (!ownerDocument) return { hasNativeModal: false, ambiguous: false, element: null, registered: false };
  const owners = liveOwners(ownerDocument);
  const { modal, ambiguous } = topModal(ownerDocument, owners);
  return {
    hasNativeModal: Boolean(ownerDocument.querySelectorAll?.("dialog[open]")?.length
      && [...ownerDocument.querySelectorAll("dialog[open]")].some((element) => element.matches?.(":modal"))),
    ambiguous,
    element: modal,
    registered: Boolean(modal && owners.some(({ element }) => element === modal)),
  };
}

export function getTopOverlayOwner(ownerDocument = globalThis.document) {
  if (!ownerDocument) return null;
  const owners = liveOwners(ownerDocument);
  const { modal, ambiguous } = topModal(ownerDocument, owners);
  if (ambiguous) return null;
  if (modal) {
    // Only the modal and descendants hosted inside it are eligible; a popup
    // behind another modal must never consume an Escape or Android Back.
    const inside = owners.filter(({ element }) =>
      element === modal || modal.contains?.(element));
    return inside.at(-1) || { element: modal, kind: "modal", dismiss: null, registered: false };
  }
  return owners.at(-1) || null;
}

export function dismissTopOverlay(ownerDocument = globalThis.document, { reason = "escape" } = {}) {
  const owner = getTopOverlayOwner(ownerDocument);
  if (!owner || typeof owner.dismiss !== "function") return false;
  try {
    const accepted = owner.dismiss({ reason, kind: owner.kind, element: owner.element });
    // The Back/Escape contract is synchronous: async promises cannot establish
    // whether an event was consumed or safely release ownership.
    if (accepted === false || (accepted && typeof accepted.then === "function")) return false;
    owner.dispose?.();
    return true;
  } catch {
    return false;
  }
}

export function floatingOverlayHost(reference = null, fallbackDocument = globalThis.document) {
  const doc = reference?.ownerDocument || fallbackDocument;
  if (!doc) return null;
  const { modal, ambiguous } = topModal(doc, liveOwners(doc));
  if (ambiguous) return null;
  if (modal) return modal;
  const focused = doc.activeElement?.closest?.("dialog[open]");
  return focused || doc.body || null;
}
