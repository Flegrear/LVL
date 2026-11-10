// HTTP tracker teardown can abort a response body after its headers arrived.
// The pinned client's async request then rejects outside its fetch catch even
// though announce() does not consume that promise. Handle only that tracker's
// own cancellation; live-request and unexpected failures remain visible.
const clientUrl = import.meta.resolve("bittorrent-tracker/client");
const { default: HTTPTracker } = await import(new URL("./lib/client/http-tracker.js", clientUrl));
const guarded = Symbol.for("LVL.httpTrackerCancellationGuard");
const original = HTTPTracker.prototype._request;
if (!original[guarded]) {
  const request = function (...args) {
    return original.apply(this, args).catch((error) => {
      if (this.destroyed === true && error?.name === "AbortError") return;
      throw error;
    });
  };
  Object.defineProperty(request, guarded, { value: true });
  HTTPTracker.prototype._request = request;
}
