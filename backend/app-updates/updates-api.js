// The changelog shown in Settings › Updates, and asking the launcher to update.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { APP_VERSION, root, UPDATE_BRIDGE, updatePolicy } from "../../server.js";
import { json, methodNotAllowed, readJsonBody } from "../app/http-helpers.js";

// The installed app reads only its own bundled release history. Never accept a
// pathname, URL or remote source from an API caller; the GitHub source branch
// is not the published release history. The alpha packager stamps its payload
// copy of the Unreleased heading with the version being installed.
const MAX_LOCAL_CHANGELOG_BYTES = 128 * 1024;

function parseLocalChangelog(raw) {
  const sections = [];
  let section = null;
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (section) sections.push(section);
      const title = heading[1];
      const release = /^(\d+)\.(\d+)\.(\d+)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})$/.exec(title);
      const unreleased = /^unreleased\b/i.test(title);
      section = (release || unreleased) ? {
        title,
        version: release ? `${release[1]}.${release[2]}.${release[3]}` : null,
        date: release ? release[4] : null,
        unreleased: Boolean(unreleased),
        lines: [],
      } : null;
      continue;
    }
    if (section) {
      const bullet = /^\s*[-*]\s+(.+)\s*$/.exec(line);
      if (bullet) section.lines.push(bullet[1]);
    }
  }
  if (section) sections.push(section);
  sections.sort((a, b) => {
    if (a.unreleased !== b.unreleased) return a.unreleased ? -1 : 1;
    if (a.unreleased) return 0;
    const aVersion = a.version.split(".").map(Number);
    const bVersion = b.version.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (aVersion[i] !== bVersion[i]) return bVersion[i] - aVersion[i];
    }
    return 0;
  });
  const entries = sections.map((entry) => ({ ...entry, changes: entry.lines }));
  return { entries, latest: entries.find((entry) => !entry.unreleased) || null, raw };
}

function localChangelogEndpoint(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (url.search) {
    json(res, 400, { error: "Release history does not accept parameters" });
    return true;
  }
  try {
    const source = path.join(root, "CHANGELOG.md");
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.size > MAX_LOCAL_CHANGELOG_BYTES) {
      json(res, 404, { error: "Local release history unavailable" });
      return true;
    }
    const data = fs.readFileSync(source);
    if (data.length > MAX_LOCAL_CHANGELOG_BYTES) {
      json(res, 404, { error: "Local release history unavailable" });
      return true;
    }
    json(res, 200, parseLocalChangelog(data.toString("utf8")),
      { "X-Content-Type-Options": "nosniff" });
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Couldn't read bundled release history:", error.message);
    json(res, 404, { error: "Local release history unavailable" });
  }
  return true;
}

export function requestNativeUpdate(action, fields = {}) {
  return new Promise((resolve, reject) => {
    if (!UPDATE_BRIDGE) return reject(new Error("Installed updater unavailable"));
    const client = net.connect({ host: "127.0.0.1", port: UPDATE_BRIDGE.port });
    let done = false;
    let response = "";
    const finish = (error, value) => {
      if (done) return;
      done = true;
      client.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    client.setTimeout(4000, () => finish(new Error("Updater did not answer")));
    client.on("error", () => finish(new Error("Updater connection unavailable")));
    client.on("connect", () => client.write(JSON.stringify({
      secret: UPDATE_BRIDGE.secret, action, ...fields,
    }) + "\n"));
    client.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response) > 8192) return finish(new Error("Invalid updater response"));
      const end = response.indexOf("\n");
      if (end < 0) return;
      try {
        const status = JSON.parse(response.slice(0, end));
        if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Invalid updater response");
        if (!("installed" in status) && typeof status.error === "string") {
          return finish(Object.assign(new Error(status.error), { statusCode: 400 }));
        }
        finish(null, status);
      } catch (error) { finish(error); }
    });
    client.on("end", () => finish(new Error("Updater connection ended")));
  });
}

export async function appUpdatesEndpoint(req, res, url) {
  if (url.pathname === "/api/app-updates/changelog")
    return localChangelogEndpoint(req, res, url);
  if (!UPDATE_BRIDGE) {
    if (url.pathname === "/api/app-updates/status" && req.method === "GET") {
      json(res, 200, {
        installed: false, automatic: false, enabled: false, intervalDays: 1,
        lastCheckedAt: null, installedVersion: APP_VERSION || null,
        available: false, availableVersion: null, checking: false,
        downloading: false, error: null, notice: null, noticePending: false,
      });
      return true;
    }
    json(res, 409, { error: "Updates are only available in installed LVL." });
    return true;
  }

  const actions = new Map([
    ["/api/app-updates/status", ["GET", "status"]],
    ["/api/app-updates/settings", ["POST", "settings"]],
    ["/api/app-updates/check", ["POST", "check"]],
    ["/api/app-updates/install", ["POST", "install"]],
  ]);
  const route = actions.get(url.pathname);
  if (!route) return false;
  if (req.method !== route[0]) return methodNotAllowed(res, [route[0]]);
  if (req.method === "POST") {
    // For privileged actions require an explicit same-origin browser request.
    // Other websites cannot trigger native dialogs, checks or preferences.
    const expected = `http://${String(req.headers.host || "").toLowerCase()}`;
    if (req.headers.origin !== expected ||
        (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
      json(res, 403, { error: "Only this LVL window can manage updates" });
      return true;
    }
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      json(res, 415, { error: "Expected JSON update request" });
      return true;
    }
  }
  let fields = {};
  if (route[1] === "settings") {
    const body = await readJsonBody(req, 1024);
    if (!body || typeof body.automatic !== "boolean" ||
        ![1, 7, 30].includes(body.intervalDays) ||
        Object.keys(body).some((key) => key !== "automatic" && key !== "intervalDays")) {
      json(res, 400, { error: "Choose automatic updates and a 1, 7 or 30 day interval" });
      return true;
    }
    fields = { automatic: body.automatic, intervalDays: body.intervalDays };
  } else if (req.method === "POST") {
    const body = await readJsonBody(req, 1024);
    if (route[1] === "check") {
      if (!body || typeof body.apply !== "boolean" ||
          Object.keys(body).some((key) => key !== "apply")) {
        json(res, 400, { error: "Update check must specify apply: true or false" });
        return true;
      }
      fields = { apply: body.apply };
    } else if (!body || Object.keys(body).length !== 0) {
      json(res, 400, { error: "Update install request must be empty" });
      return true;
    }
  }
  try {
    json(res, 200, await updatePolicy.handle(route[1], fields));
  } catch (error) {
    json(res, error.statusCode || 503, { error: error.message || "Updater unavailable" });
  }
  return true;
}
