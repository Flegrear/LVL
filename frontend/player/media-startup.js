// Torrent metadata can need distant pieces or slow peer discovery. Give the
// foreground player a bounded chance to obtain it, then use conservative
// playback until the same request resolves for the post-start refinement.
export async function waitForStartupMediaProbe(request, {
  timeoutMs = 2000, schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(request),
      new Promise((resolve) => { timer = schedule(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) cancel(timer);
  }
}
