// Small anchored menus: open, close and keyboard.
// Popup menus (title actions, More): open at the pointer (right-click) or under their button,
// move with arrow keys, close with Escape, Tab or a click outside, and give focus back.
export let openMenuState = null;

export function openPopupMenu(menu, { anchor = null, x = null, y = null, focusFirst = true } = {}) {
  if (!menu) return;
  closePopupMenu({ restoreFocus: false });
  // A modal dialog makes everything outside it inert: open the menu inside the top open dialog.
  const host = [...document.querySelectorAll("dialog[open]")].pop() || document.body;
  if (menu.parentElement !== host) host.append(menu);
  menu.hidden = false;
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";
  const margin = 8;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const atPointer = Number.isFinite(x) && Number.isFinite(y);
  let left = atPointer ? x + 4 : margin;
  let top = atPointer ? y + 4 : margin;
  if (atPointer) {
    // Put right-click menus beside the clicked point, not below a tall
    // chapter card; flip to stay within the viewport near the screen edge.
    if (top + height > window.innerHeight - margin) top = y - height - 4;
    if (left + width > window.innerWidth - margin) left = x - width - 4;
  } else if (anchor) {
    const rect = anchor.getBoundingClientRect();
    left = rect.right - width;
    top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) top = rect.top - height - 6;
  }
  const wantLeft = Math.round(Math.max(margin, Math.min(left, window.innerWidth - width - margin)));
  const wantTop = Math.round(Math.max(margin, Math.min(top, window.innerHeight - height - margin)));
  menu.style.left = `${wantLeft}px`;
  menu.style.top = `${wantTop}px`;
  // Inside a transformed ancestor, "fixed" is relative to that box: correct for it.
  const actual = menu.getBoundingClientRect();
  if (Math.abs(actual.left - wantLeft) > 0.5 || Math.abs(actual.top - wantTop) > 0.5) {
    menu.style.left = `${Math.round(2 * wantLeft - actual.left)}px`;
    menu.style.top = `${Math.round(2 * wantTop - actual.top)}px`;
  }
  menu.style.visibility = "";
  anchor?.setAttribute("aria-expanded", "true");
  openMenuState = { menu, anchor };
  if (focusFirst) menu.querySelector('[role="menuitem"]:not([disabled]):not([hidden])')?.focus({ preventScroll: true });
}

export function closePopupMenu({ restoreFocus = true } = {}) {
  const current = openMenuState;
  if (!current) return;
  openMenuState = null;
  current.menu.hidden = true;
  current.anchor?.setAttribute("aria-expanded", "false");
  if (restoreFocus && current.anchor?.isConnected) current.anchor.focus({ preventScroll: true });
}

export function wirePopupMenu(menu) {
  menu?.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]:not([disabled]):not([hidden])')];
    const index = items.indexOf(document.activeElement);
    const go = (next) => {
      if (!items.length) return;
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePopupMenu(); }
    else if (event.key === "Tab") closePopupMenu({ restoreFocus: false });
  });
}
