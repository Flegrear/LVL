// Comic torrent downloads. A separate WebTorrent client
// (the video player's client and its rules stay untouched) downloads only the
// readable comic files of a torrent into a separate, owned attempt folder under
// <comics folder>/Downloads/. Display names never own the storage identity.
// Files are kept; sharing stops when the download completes.
// While it downloads, LVL uploads like any
// other peer, without a cap: peers favour those who upload to them, and a
// peer that only takes is treated as a leech.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validMagnet } from "./torrent-search.js";

export const DOWNLOAD_LIMITS = Object.freeze({ files: 5000, bytes: 20 * 1024 ** 3, active: 3 });
// WebTorrent's own options: uploadLimit -1 means no cap.
export const CLIENT_OPTIONS = Object.freeze({ uploadLimit: -1, maxConns: 30 });
const READABLE = /\.(?:cbz|zip|jpe?g|png|webp|avif|gif)$/i;

export function safeTorrentPath(name) {
  const parts = String(name || "").split(/[\\/]/);
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== ".." && !/[<>:"|?*\x00-\x1f]/.test(part) && part.length <= 200);
}
export const safeFolderName = (name) => String(name || "download").replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "download";

// Which files of a torrent to fetch, or an error explaining why none.
export function planTorrentFiles(files) {
  if (files.length > DOWNLOAD_LIMITS.files) return { error: `This torrent has ${files.length} files (limit ${DOWNLOAD_LIMITS.files})` };
  if (files.some((file) => !safeTorrentPath(file.path))) return { error: "This torrent has unsafe file names" };
  const wanted = files.filter((file) => READABLE.test(file.name));
  if (!wanted.length) return { error: "This torrent has no CBZ, ZIP or image files LVL can read yet" };
  const bytes = wanted.reduce((sum, file) => sum + file.length, 0);
  if (bytes > DOWNLOAD_LIMITS.bytes) return { error: "This torrent is larger than 20 GB" };
  return { wanted, bytes };
}

export function createComicDownloads({ folder, onComplete = () => {}, createClient, now = Date.now, log = console } = {}) {
  let client = null;
  let clientInit = null;
  let lifecycle = 0;
  const jobs = new Map();
  const getClient = () => {
    if (client) return Promise.resolve(client);
    if (clientInit) return clientInit.promise;
    const owner = { lifecycle, promise: null };
    owner.promise = (async () => {
      const WebTorrent = createClient ? null : (await import("webtorrent")).default;
      if (owner.lifecycle !== lifecycle) return null;
      // Stop may retire this initialization while the import or factory waits.
      // Its eventual client must never be adopted by a newer lifecycle.
      const candidate = createClient ? await createClient(CLIENT_OPTIONS) : new WebTorrent({ ...CLIENT_OPTIONS });
      candidate.on?.("error", (error) => log.warn?.("Comic download client:", error?.message));
      if (owner.lifecycle !== lifecycle) {
        if (candidate !== client) candidate.destroy?.();
        return null;
      }
      client = candidate;
      return candidate;
    })().finally(() => {
      if (clientInit === owner) clientInit = null;
    });
    clientInit = owner;
    return owner.promise;
  };
  const view = (job) => ({
    id: job.id, name: job.name, workId: job.workId, state: job.state, error: job.error, bytes: job.bytes,
    progress: job.torrent && job.state === "downloading" ? Math.round((job.torrent.progress || 0) * 1000) / 10 : job.state === "done" ? 100 : 0,
    speed: job.torrent?.downloadSpeed || 0, peers: job.torrent?.numPeers || 0, startedAt: job.startedAt, folder: job.dir,
  });
  function finish(job, state, error = null) {
    clearTimeout(job.metadataTimeout);
    job.state = state;
    job.error = error;
    const torrent = job.torrent;
    job.torrent = null;
    torrent?.destroy?.({ destroyStore: state !== "done" });
  }
  function cleanCancelledAttempt(job) {
    if (!job.ownedDirectory || job.cleanupStarted) return;
    job.cleanupStarted = true;
    const target = path.resolve(job.dir);
    // The path must be the exact single directory created exclusively for
    // this attempt, never an arbitrary name or a completed download folder.
    if (path.dirname(target) !== job.downloadsRoot) return;
    fs.lstat(target, (error, stat) => {
      if (error || !stat.isDirectory() || stat.isSymbolicLink()
        || stat.dev !== job.directoryDev || stat.ino !== job.directoryIno) return;
      fs.rm(target, { recursive: true, force: true }, (removeError) => {
        if (removeError) log.warn?.("Could not remove cancelled comic download:", removeError.message);
      });
    });
  }

  return {
    list: () => [...jobs.values()].map(view).sort((a, b) => b.startedAt - a.startedAt),
    async start({ magnet, name, workId }) {
      if (!validMagnet(magnet)) throw new Error("Not a magnet link");
      if ([...jobs.values()].filter((job) => job.state === "downloading" || job.state === "metadata").length >= DOWNLOAD_LIMITS.active) throw new Error("Three downloads are already running");
      const id = crypto.createHash("sha1").update(magnet).digest("hex").slice(0, 12);
      const existing = jobs.get(id);
      if (existing && ["metadata", "downloading", "done"].includes(existing.state)) return view(existing);
      const downloadsRoot = path.resolve(folder, "Downloads");
      fs.mkdirSync(downloadsRoot, { recursive: true });
      const parent = fs.realpathSync(downloadsRoot);
      let dir = null;
      // mkdir without recursive:true exclusively claims a new directory on
      // disk (across processes). Never reuse a prior attempt of the same ID.
      for (let n = 0; n < 8; n++) {
        const candidate = path.resolve(parent, `${safeFolderName(name)} [${id}]-${crypto.randomBytes(8).toString("hex")}`);
        if (path.dirname(candidate) !== parent) throw new Error("Unsafe comic download directory");
        try { fs.mkdirSync(candidate); dir = candidate; break; }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      if (!dir) throw new Error("Could not reserve a comic download directory");
      const directory = fs.lstatSync(dir);
      const job = { id, name: String(name || "").slice(0, 200), workId: workId || null,
        dir, downloadsRoot: parent, ownedDirectory: true, directoryDev: directory.dev, directoryIno: directory.ino,
        cleanupStarted: false, metadataTimeout: null, state: "metadata", error: null,
        bytes: 0, startedAt: now(), torrent: null };
      jobs.set(id, job);
      const startedLifecycle = lifecycle;
      let torrentClient;
      try { torrentClient = await getClient(); }
      catch (error) {
        if (startedLifecycle !== lifecycle || jobs.get(id) !== job || job.state !== "metadata") return view(job);
        jobs.delete(id);
        cleanCancelledAttempt(job);
        throw error;
      }
      if (startedLifecycle !== lifecycle || jobs.get(id) !== job || job.state !== "metadata"
        || !torrentClient || torrentClient !== client) return view(job);
      let torrent;
      try { torrent = torrentClient.add(magnet, { path: dir, deselect: true, destroyStoreOnDestroy: false }); }
      catch (error) {
        if (jobs.get(id) === job) { jobs.delete(id); cleanCancelledAttempt(job); }
        throw error;
      }
      job.torrent = torrent;
      const timeout = setTimeout(() => {
        if (jobs.get(id) === job && job.state === "metadata") finish(job, "failed", "No peers sent the torrent's details within 2 minutes");
      }, 120_000);
      job.metadataTimeout = timeout;
      timeout.unref?.();
      torrent.once("metadata", () => {
        if (jobs.get(id) !== job || job.state !== "metadata") return;
        clearTimeout(timeout);
        const plan = planTorrentFiles(torrent.files);
        if (plan.error) return finish(job, "failed", plan.error);
        for (const file of torrent.files) file.deselect?.();
        for (const file of plan.wanted) file.select?.();
        job.bytes = plan.bytes;
        job.state = "downloading";
        return undefined;
      });
      torrent.once("done", () => {
        if (jobs.get(id) !== job || job.state !== "downloading") return;
        finish(job, "done");
        Promise.resolve(onComplete(view(job))).catch((error) => log.warn?.("Comic download follow-up failed:", error?.message));
      });
      torrent.once("error", (error) => {
        if (jobs.get(id) === job && (job.state === "metadata" || job.state === "downloading"))
          finish(job, "failed", String(error?.message || error).slice(0, 200));
      });
      return view(job);
    },
    cancel(id) {
      const job = jobs.get(String(id));
      if (!job) return false;
      if (job.state === "metadata" || job.state === "downloading") {
        finish(job, "cancelled");
        cleanCancelledAttempt(job);
      } else if (job.state === "failed") cleanCancelledAttempt(job);
      jobs.delete(job.id);
      return true;
    },
    stop() {
      lifecycle += 1;
      // Retire pending initialization as well as already-added torrents. A new
      // start can initialize its own client without waiting for the old one.
      clientInit = null;
      for (const job of jobs.values()) {
        if (job.state === "metadata" || job.state === "downloading") {
          finish(job, "cancelled");
          cleanCancelledAttempt(job);
        }
      }
      const retiredClient = client;
      client = null;
      retiredClient?.destroy?.();
    },
  };
}
