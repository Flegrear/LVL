// Page shortcuts: element lookups and tool status messages.
// Document PiP temporarily moves the live player into a same-origin window.
// Continue resolving its controls there without recreating the video element.
export const $ = (selector) => document.querySelector(selector)
  || window.documentPictureInPicture?.window?.document?.querySelector(selector) || null;
export const $$ = (selector) => [
  ...document.querySelectorAll(selector),
  ...(window.documentPictureInPicture?.window?.document?.querySelectorAll(selector) || []),
];

export function setToolStatus(selector, message, error = false) {
  const node = $(selector);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("is-error", error);
}
