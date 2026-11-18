// Cross-process ownership gate for the private Comics v3 image cache.
// No process may infer abandonment from PID, age, or a missing marker: a crash
// leaves an unavailable gate until an explicitly authorized recovery.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CODE = "image-cache-owner-unavailable";
const unavailable = (message) => Object.assign(new Error(message), { code: CODE, status: 503 });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino
  && a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink();

export function createImageCacheOwnership({ dir, attempts = 24, delayMs = 25 } = {}) {
  if (!dir) throw new Error("Image cache directory required");
  const gate = path.join(dir, ".lvl-image-cache-v3.owner");
  const marker = path.join(gate, "owner");
  const epochPath = path.join(dir, ".lvl-image-cache-v3.epoch");
  const tries = Math.max(1, Math.min(64, Math.trunc(Number(attempts) || 1)));
  const delay = Math.max(1, Math.min(250, Math.trunc(Number(delayMs) || 1)));

  async function acquire() {
    try {
      await fs.mkdir(dir, { recursive: true });
      const root = await fs.lstat(dir);
      if (!root.isDirectory() || root.isSymbolicLink())
        throw Error("Image cache root is not a plain directory");
    }
    catch { throw unavailable("Image cache root unavailable"); }
    for (let i = 0; i < tries; i++) {
      try { await fs.mkdir(gate); }
      catch (error) {
        if (error?.code !== "EEXIST") throw unavailable("Image cache owner gate unavailable");
        if (i + 1 < tries) await wait(delay);
        continue;
      }
      const token = crypto.randomBytes(16).toString("hex");
      try {
        const stat = await fs.lstat(gate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Owner gate changed");
        await fs.writeFile(marker, token, { flag: "wx" });
        return { stat, token };
      } catch {
        // Do not recursively remove a gate whose creation or marker is uncertain.
        throw unavailable("Image cache owner marker incomplete");
      }
    }
    throw unavailable("Image cache owner busy or stale");
  }

  async function assertOwner(lease) {
    try {
      const stat = await fs.lstat(gate);
      if (!same(stat, lease?.stat) || await fs.readFile(marker, "utf8") !== lease.token)
        throw Error("Owner changed");
    } catch { throw unavailable("Image cache ownership changed"); }
  }

  async function release(lease) {
    await assertOwner(lease);
    try {
      // The directory is removed only when our exact marker is its sole child.
      // A busy Windows/remote-file lease remains protected if removal fails.
      await fs.unlink(marker);
      await fs.rmdir(gate);
    } catch { throw unavailable("Image cache owner release failed closed"); }
  }

  async function withOwner(action) {
    const lease = await acquire();
    try {
      await assertOwner(lease);
      return await action(lease);
    } finally {
      await release(lease);
    }
  }

  async function epoch() {
    try {
      const stat = await fs.lstat(epochPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32)
        throw unavailable("Invalid image cache epoch");
      const value = await fs.readFile(epochPath, "utf8");
      if (!/^[0-9a-f]{32}$/.test(value))
        throw unavailable("Invalid image cache epoch contents");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return "genesis";
      if (error?.code === CODE) throw error;
      throw unavailable("Image cache epoch unavailable");
    }
  }

  async function bumpEpoch(lease) {
    await assertOwner(lease);
    const next = crypto.randomBytes(16).toString("hex");
    const temp = epochPath + "." + lease.token + ".tmp";
    let witnessed = null;
    try {
      await fs.writeFile(temp, next, { flag: "wx" });
      witnessed = await fs.lstat(temp);
      await assertOwner(lease);
      await fs.rename(temp, epochPath);
      return next;
    } finally {
      if (witnessed) try {
        await assertOwner(lease);
        const current = await fs.lstat(temp);
        if (current.isFile() && !current.isSymbolicLink()
          && current.dev === witnessed.dev && current.ino === witnessed.ino)
          await fs.unlink(temp);
      } catch { /* never remove a different owner's temp */ }
    }
  }

  return { withOwner, assertOwner, epoch, bumpEpoch,
    isUnavailable: (error) => error?.code === CODE };
}
