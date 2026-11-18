// The backend returns one exact archive member only after a bounded 409
// selection. Never infer ZIP membership from filenames/release scoring.
export const MAX_ZIP_SUBTITLE_MEMBERS = 20;
export const MAX_ZIP_MEMBER_REFRESHES = 2;
export const MAX_ZIP_MEMBER_PICK_MS = 180_000;
const MEMBER_ID = /^[a-f0-9]{64}$/i;

export function exactSubtitleZipMembers(error) {
  if (Number(error?.status ?? error?.httpStatus) !== 409) return null;
  const raw = error?.data?.members;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_ZIP_SUBTITLE_MEMBERS)
    throw new Error("Subtitle ZIP returned an invalid member list");
  const seen = new Set();
  const members = raw.map((entry) => {
    if (!entry || typeof entry.memberId !== "string" || !MEMBER_ID.test(entry.memberId)
      || typeof entry.filename !== "string" || !entry.filename.trim()
      || entry.filename.length > 255)
      throw new Error("Subtitle ZIP returned an invalid member identity");
    const memberId = entry.memberId.toLowerCase();
    if (seen.has(memberId)) throw new Error("Subtitle ZIP returned duplicate member identities");
    seen.add(memberId);
    return Object.freeze({ memberId, filename: entry.filename });
  });
  return Object.freeze(members);
}

export function isMissingExactSubtitleZipMember(error) {
  return Number(error?.status ?? error?.httpStatus) === 422
    && error?.data?.error === "Exact ZIP member was not found in this archive";
}

/**
 * Render a finite, accessible choice INSIDE the existing subtitle finder
 * dialog. Never open a second native modal or a new window. Caller owns source
 * and search cancellation; cancel() resolves the exact outstanding promise.
 */
export function showExactSubtitleZipChoices({
  members, dialog, isCurrent, changedArchive = false, returnFocus = null,
  timeoutMs = MAX_ZIP_MEMBER_PICK_MS,
} = {}) {
  if (!Array.isArray(members) || members.length < 1
    || members.length > MAX_ZIP_SUBTITLE_MEMBERS
    || typeof isCurrent !== "function" || !Number.isFinite(timeoutMs)
    || timeoutMs < 100 || timeoutMs > MAX_ZIP_MEMBER_PICK_MS)
    throw new TypeError("Invalid bounded ZIP member picker");
  if (!dialog?.open || !dialog.ownerDocument?.createElement)
    return { promise: Promise.resolve(null), cancel() {} };

  const doc = dialog.ownerDocument;
  const panel = doc.createElement("section");
  panel.className = "subtitle-zip-choice";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Choose a subtitle file from ZIP");
  const heading = doc.createElement("h3");
  heading.textContent = changedArchive
    ? "Archive changed — choose a subtitle file again"
    : "Choose a subtitle file from this ZIP";
  panel.append(heading);
  const description = doc.createElement("p");
  description.textContent = "Select the exact file to import. The archive may contain different languages or episodes.";
  panel.append(description);
  const buttons = doc.createElement("div");
  buttons.className = "subtitle-zip-choice-list";
  // Keep a 20-file archive navigable within the existing modal even when
  // Catalog's shared stylesheet has no dedicated ZIP-picker declarations.
  buttons.style.display = "grid";
  buttons.style.gap = "8px";
  buttons.style.maxHeight = "min(44vh, 420px)";
  buttons.style.overflowY = "auto";
  panel.append(buttons);
  const controls = doc.createElement("div");
  controls.className = "settings-actions";
  panel.append(controls);

  const listeners = new AbortController();
  let settled = false, timeout = null, resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  const finish = (memberId = null) => {
    if (settled) return;
    settled = true;
    listeners.abort();
    if (timeout !== null) clearTimeout(timeout);
    panel.remove();
    if (returnFocus?.isConnected && dialog.open)
      returnFocus.focus?.({ preventScroll: true });
    resolvePromise(memberId);
  };
  for (const entry of members) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "button subtitle-zip-member";
    button.style.textAlign = "left";
    button.style.width = "100%";
    // Always use textContent; provider-controlled filenames must not become
    // markup, selectors, HTML attributes or a guessed file identity.
    button.textContent = entry.filename;
    button.addEventListener("click", () => {
      finish(isCurrent() ? entry.memberId : null);
    }, { signal: listeners.signal });
    buttons.append(button);
  }
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.className = "ui-btn ui-btn--ghost";
  cancel.textContent = "Cancel subtitle import";
  cancel.addEventListener("click", () => finish(), { signal: listeners.signal });
  controls.append(cancel);
  dialog.addEventListener("cancel", () => finish(), { signal: listeners.signal });
  dialog.addEventListener("close", () => finish(), { signal: listeners.signal });
  (dialog.querySelector?.(".detail-body") || dialog).append(panel);
  timeout = setTimeout(() => finish(), timeoutMs);
  buttons.firstElementChild?.focus?.({ preventScroll: true });
  return { promise, cancel: () => finish() };
}

/**
 * Retry the identical original provider URL/token, label and API key with the
 * exact user-chosen memberId. A changed archive returning 422 must be fetched
 * again WITHOUT a memberId to retrieve its new bounded list. It may not
 * silently select a similar filename or a now-single alternate subtitle.
 *
 * Null means the exact owner was retired or the user cancelled. Every caller
 * must independently fence its playback source/load/search owner before using
 * the returned subtitle text.
 */
export async function downloadExactSubtitleZipMember({
  originalRequest, postDownload, chooseMember, isCurrent,
  maxRefreshes = MAX_ZIP_MEMBER_REFRESHES,
}) {
  if (!originalRequest || typeof originalRequest.url !== "string"
    || typeof postDownload !== "function" || typeof chooseMember !== "function"
    || typeof isCurrent !== "function" || !Number.isSafeInteger(maxRefreshes)
    || maxRefreshes < 0 || maxRefreshes > MAX_ZIP_MEMBER_REFRESHES)
    throw new TypeError("Exact ZIP selection requires a fixed request and current owner");
  const request = Object.freeze({
    apiKey: originalRequest.apiKey, url: originalRequest.url,
    label: originalRequest.label,
  });
  if (!isCurrent()) return null;
  let listing;
  try {
    const downloaded = await postDownload(request);
    return isCurrent() ? downloaded : null;
  } catch (error) {
    if (!isCurrent()) return null;
    listing = exactSubtitleZipMembers(error);
    if (!listing) throw error;
  }
  for (let refreshes = 0; refreshes <= maxRefreshes && isCurrent(); refreshes += 1) {
    const requestedId = await chooseMember(listing, { changedArchive: refreshes > 0 });
    if (!isCurrent() || requestedId === null) return null;
    if (typeof requestedId !== "string"
      || !listing.some((entry) => entry.memberId === requestedId.toLowerCase()))
      throw new Error("Selected ZIP member is not in the current archive list");
    try {
      const downloaded = await postDownload(Object.freeze({
        ...request, memberId: requestedId.toLowerCase(),
      }));
      if (!isCurrent()) return null;
      if (!downloaded || typeof downloaded.memberId !== "string"
        || downloaded.memberId.toLowerCase() !== requestedId.toLowerCase()
        || typeof downloaded.text !== "string" || typeof downloaded.filename !== "string")
        throw new Error("Subtitle ZIP response did not confirm the selected exact member");
      return isCurrent() ? downloaded : null;
    } catch (error) {
      if (!isCurrent()) return null;
      if (!isMissingExactSubtitleZipMember(error)) throw error;
      if (refreshes === maxRefreshes)
        throw new Error("Subtitle ZIP changed repeatedly; search again to select a current member");
      try {
        // This response may succeed if the replacement archive has one member.
        // Do not attach that unrequested replacement after an earlier 422.
        await postDownload(request);
        if (!isCurrent()) return null;
        throw new Error("Subtitle ZIP changed; reopen the result to select its new file");
      } catch (refreshError) {
        if (!isCurrent()) return null;
        const refreshed = exactSubtitleZipMembers(refreshError);
        if (!refreshed) throw refreshError;
        listing = refreshed;
      }
    }
  }
  return null;
}
