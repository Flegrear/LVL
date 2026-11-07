// Sync as a server feature (backend/features/feature-host.js): the /api/sync routes, the
// Settings › Sync module, and the sync service started and stopped with the server.
import { createGitHub } from "./github.js";
import { createLocalData } from "./local-data.js";
import { createSyncService } from "./sync-service.js";

// LVL's GitHub App: its client ID is public (the device flow needs no secret). Until the app
// is registered, LVL_GITHUB_CLIENT_ID and LVL_GITHUB_APP_SLUG set it for a test run.
export const GITHUB_APP = Object.freeze({
  clientId: process.env.LVL_GITHUB_CLIENT_ID || "",
  slug: process.env.LVL_GITHUB_APP_SLUG || "",
});

export const syncServerFeature = {
  id: "sync",
  assets: [
    ["/frontend/sync/feature.js", { file: "frontend/sync/feature.js", cacheControl: "no-cache" }],
    ["/frontend/sync/sync.css", { file: "frontend/sync/sync.css", cacheControl: "no-cache" }],
  ],
  apiPrefixes: ["/api/sync"],
  create(ctx) {
    if (!ctx.appState || !ctx.recs) throw new Error("Sync needs the app state and ratings stores");
    const service = createSyncService({
      db: ctx.db, getMeta: ctx.getMeta, setMeta: ctx.setMeta, github: createGitHub(), app: GITHUB_APP,
      local: createLocalData({ appState: ctx.appState, db: ctx.db, recs: ctx.recs }),
    });
    // LVL's own refusals keep their status (400, 503); anything GitHub answered is a 502.
    const fail = (res, error) => ctx.json(res, !error.github && Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status : 502, { error: String(error.message || error).slice(0, 300) });
    return {
      start: () => service.start(),
      stop: () => service.stop(),
      async handle(req, res, url) {
        const route = url.pathname.slice("/api/sync/".length);
        if (route === "status") {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]);
          ctx.json(res, 200, { ...service.status(), libraryRevision: ctx.appState.sectionUpdatedAt("library") });
          return true;
        }
        if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]);
        const input = await ctx.readJsonBody(req, 4096);
        const actions = {
          "github/start": () => service.startDevice({ renew: input.renew !== false }),
          "github/cancel": () => { service.cancelDevice(); return service.status(); },
          "github/token": () => service.useToken({ token: input.token }),
          "github/find": () => service.findRepo(),
          passphrase: () => service.setPassphrase({ passphrase: input.passphrase }),
          start: () => service.startSync({ encrypt: input.encrypt === true, passphrase: input.passphrase || "" }),
          now: async () => ({ ...(await service.syncNow()), status: service.status() }),
          "reload-shown": () => { service.acknowledgeReload(); return service.status(); },
          disconnect: () => service.disconnect(),
        };
        if (!actions[route]) return false;
        try { ctx.json(res, 200, await actions[route]()); } catch (error) { fail(res, error); }
        return true;
      },
    };
  },
};
