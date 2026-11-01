// Comic torrent downloads. A separate WebTorrent client
// (the video player's client and its rules stay untouched) downloads only the
// readable comic files of a torrent into <comics folder>/Downloads/<name>.
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
  const jobs = new Map();
  const getClient = async () => {
    if (!client) {
      const WebTorrent = createClient ? null : (await import("webtorrent")).default;
      client = createClient ? createClient(CLIENT_OPTIONS) : new WebTorrent({ ...CLIENT_OPTIONS });
      client.on?.("error", (error) => log.warn?.("Comic download client:", error?.message));
    }
    return client;
  };
  const view = (job) => ({
    id: job.id, name: job.name, workId: job.workId, state: job.state, error: job.error, bytes: job.bytes,
    progress: job.torrent && job.state === "downloading" ? Math.round((job.torrent.progress || 0) * 1000) / 10 : job.state === "done" ? 100 : 0,
    speed: job.torrent?.downloadSpeed || 0, peers: job.torrent?.numPeers || 0, startedAt: job.startedAt, folder: job.dir,
  });
  function finish(job, state, error = null) {
    job.state = state;
    job.error = error;
    const torrent = job.torrent;
    job.torrent = null;
    torrent?.destroy?.({ destroyStore: state !== "done" });
  }

  return {
    list: () => [...jobs.values()].map(view).sort((a, b) => b.startedAt - a.startedAt),
    async start({ magnet, name, workId }) {
      if (!validMagnet(magnet)) throw new Error("Not a magnet link");
      if ([...jobs.values()].filter((job) => job.state === "downloading" || job.state === "metadata").length >= DOWNLOAD_LIMITS.active) throw new Error("Three downloads are already running");
      const id = crypto.createHash("sha1").update(magnet).digest("hex").slice(0, 12);
      const existing = jobs.get(id);
      if (existing && ["metadata", "downloading", "done"].includes(existing.state)) return view(existing);
      const dir = path.join(folder, "Downloads", safeFolderName(name));
      const createdDir = !fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true });
      const job = { id, name: String(name || "").slice(0, 200), workId: workId || null, dir, createdDir, state: "metadata", error: null, bytes: 0, startedAt: now(), torrent: null };
      jobs.set(id, job);
      const torrentClient = await getClient();
      const torrent = torrentClient.add(magnet, { path: dir, deselect: true, destroyStoreOnDestroy: false });
      job.torrent = torrent;
      const timeout = setTimeout(() => { if (job.state === "metadata") finish(job, "failed", "No peers sent the torrent's details within 2 minutes"); }, 120_000);
      timeout.unref?.();
      torrent.once("metadata", () => {
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
        if (job.state !== "downloading") return;
        finish(job, "done");
        Promise.resolve(onComplete(view(job))).catch((error) => log.warn?.("Comic download follow-up failed:", error?.message));
      });
      torrent.once("error", (error) => finish(job, "failed", String(error?.message || error).slice(0, 200)));
      return view(job);
    },
    cancel(id) {
      const job = jobs.get(String(id));
      if (!job) return false;
      if (job.state === "metadata" || job.state === "downloading") {
        finish(job, "cancelled");
        // Only the folder this download created; an existing folder with the same name is left alone.
        if (job.createdDir) fs.rm(job.dir, { recursive: true, force: true }, () => {});
      }
      jobs.delete(job.id);
      return true;
    },
    stop() {
      for (const job of jobs.values()) if (job.torrent) finish(job, "cancelled");
      client?.destroy?.();
      client = null;
    },
  };
}
