// A single per-document keyboard consumer. The shared UI overlay registry is
// the canonical cross-owner order when its typed contract is installed; this
// per-document fallback keeps older deployments bootable without modifying
// Catalog's read-only overlay-host implementation.
import * as sharedOverlayHost from "../ui/overlay-host.js";

export function createOverlayEscapeCoordinator({
  candidates, document: doc, window: win, registry = sharedOverlayHost,
}) {
  if (typeof candidates !== "function" || !doc || !win)
    throw new TypeError("Overlay Escape coordinator requires a document and candidates");
  let disposed = false;
  let order = [];
  const registered = new Map();
  const visible = () => (candidates() || []).filter((item) =>
    item?.node && item.active && typeof item.dismiss === "function");
  const refresh = () => {
    if (disposed) return [];
    const live = visible();
    const nodes = new Set(live.map(item => item.node));
    order = order.filter(node => nodes.has(node));
    for (const item of live) if (!order.includes(item.node)) order.push(item.node);
    for (const [node, owner] of registered) {
      if (!nodes.has(node) || node.ownerDocument !== doc) {
        owner.dispose?.();
        registered.delete(node);
      }
    }
    if (typeof registry?.registerOverlayOwner === "function") {
      for (const item of live) {
        if (item.register === false || item.node.ownerDocument !== doc) continue;
        const existing = registered.get(item.node);
        if (existing) { existing.item = item; continue; }
        // The mutable holder makes a re-rendered dismiss callback current
        // without registering the same visible DOM node again.
        const owner = { item, dispose: null };
        owner.dispose = registry.registerOverlayOwner(item.node, {
          kind: item.native ? "native-dialog" : "transient",
          // A registry may have captured an older callback before disposal.
          // It must never dismiss a newly opened layer after this coordinator
          // relinquishes ownership of its document.
          dismiss: () => { if (!disposed) owner.item.dismiss(); },
        });
        registered.set(item.node, owner);
      }
    }
    return live;
  };
  const top = () => {
    const live = refresh();
    const last = order.at(-1);
    return live.find(item => item.node === last) || null;
  };
  const handleKey = (event) => {
    if (disposed || event?.key !== "Escape" || event.defaultPrevented) return false;
    refresh();
    // Native modal top-layer ownership wins even if focus was temporarily
    // moved outside the dialog and a background menu has a newer DOM stamp.
    const sharedTop = typeof registry?.getTopOverlayOwner === "function"
      ? registry.getTopOverlayOwner(doc) : null;
    const selected = top();
    const sharedNode = sharedTop?.element || sharedTop?.node;
    const modals = [...(doc.querySelectorAll?.("dialog[open]") || [])]
      .filter(node => node.matches?.(":modal"));
    // The shared registry knows real showModal order only for owners that
    // registered. A mixed registered/unregistered native-modal group is NOT
    // ordered evidence: a later unregistered modal may be above the most
    // recently registered one. Never substitute DOM sibling order here.
    const registeredModalNodes = typeof registry?.listOverlayOwners === "function"
      ? registry.listOverlayOwners(doc).map(owner => owner?.element || owner?.node)
      : [];
    const ambiguousModals = modals.length > 1
      && (modals.some(node => !registeredModalNodes.includes(node)) || !sharedTop);
    if (ambiguousModals) {
      // Leave the browser's native Escape/cancel default intact, but do not
      // dismiss a guessed transient, child menu or background dialog.
      event.stopImmediatePropagation?.();
      return true;
    }
    const nativeModal = modals.find(node => node === sharedNode || node.contains?.(sharedNode))
      || (modals.length === 1 ? modals[0] : null);
    const sharedInsideModal = Boolean(nativeModal && sharedTop
      && sharedTop.kind !== "native-dialog" && sharedTop.kind !== "dialog"
      && sharedTop.kind !== "modal" && sharedNode !== nativeModal
      && !sharedNode?.matches?.(":modal")
      && sharedNode && nativeModal.contains?.(sharedNode));
    const fallbackInsideModal = Boolean(nativeModal && selected
      && !selected.native && nativeModal.contains?.(selected.node));
    if (nativeModal && !sharedInsideModal) {
      if (fallbackInsideModal) {
        // A transient menu hosted INSIDE the real modal is newer than its
        // dialog. Do not let an unrelated shared background owner win.
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        selected.dismiss();
        refresh();
        return true;
      }
      event.stopImmediatePropagation?.();
      return true; // Never prevent the browser's real Escape/cancel default.
    }
    if (typeof registry?.getTopOverlayOwner === "function"
      && typeof registry?.dismissTopOverlay === "function") {
      const owner = sharedTop;
      if (owner) {
        if (owner.native || owner.kind === "native-dialog" || owner.kind === "dialog"
          || owner.kind === "modal" || sharedNode?.matches?.(":modal")) {
          event.stopImmediatePropagation?.();
          return true;
        }
        if (registry.dismissTopOverlay(doc, { reason: "escape" }) !== true) return false;
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        refresh();
        return true;
      }
    }
    const item = top();
    if (!item) return false;
    // Native <dialog> owns Escape/cancel itself. Stop lower-level JS Escape
    // handlers without cancelling the browser's native top-layer action.
    if (item.native) {
      event.stopImmediatePropagation?.();
      return true;
    }
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    item.dismiss();
    refresh();
    return true;
  };
  const onPointer = () => { if (!disposed) win.queueMicrotask?.(refresh); };
  const observer = typeof win.MutationObserver === "function"
    ? new win.MutationObserver(refresh) : null;
  if (observer && doc.body) {
    observer.observe(doc.body, { subtree: true, attributes: true,
      attributeFilter: ["hidden", "open", "class"] });
  }
  win.addEventListener("keydown", handleKey, true);
  doc.addEventListener("click", onPointer, true);
  refresh();
  return {
    top,
    refresh,
    handleKey,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      win.removeEventListener("keydown", handleKey, true);
      doc.removeEventListener("click", onPointer, true);
      for (const owner of registered.values()) owner.dispose?.();
      registered.clear();
      order = [];
    },
  };
}
