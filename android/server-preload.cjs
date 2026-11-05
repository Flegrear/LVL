// LVL for Android: loaded before server.js (`node --require ./android-preload.cjs server.js`).
// 1. Fatal errors are copied to stderr (Node for Android sends them to logcat).
// 2. os.networkInterfaces() returns no interfaces instead of throwing (below).
// 3. An access key keeps other apps on the phone out of LVL's server (at the end).
// 4. A filter the app's FFmpeg lacks is replaced in FFmpeg commands (at the very end).
// 5. Peer connections share one checked key-exchange group (after part 4).
//
// Android limits the network-interface queries behind os.networkInterfaces() for apps, and
// Node then throws "uv_interface_addresses returned Unknown system error 13" (seen in Termux,
// termux/termux-packages#10868). WebTorrent's router discovery (UPnP) calls it while LVL's
// server loads, so a throw there would stop the server. LVL itself doesn't need the list:
// without it, WebTorrent only skips UPnP port mapping. This wrapper turns the error into
// "no interfaces" and says so once in the server log.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const { syncBuiltinESMExports } = require("node:module");

// Node built for Android prints fatal errors to logcat (tag "nodejs"), not to stderr, so the
// app's server log showed "exit 1" and nothing else when server.js failed to load. This
// listener only watches (Node still reports the error and exits as usual) and writes the
// error to stderr first, where ServerService records it.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  try {
    fs.writeSync(2, `LVL server error (${origin}): ${error?.stack || error}\n`);
  } catch {}
});

const original = os.networkInterfaces;
let reported = false;
os.networkInterfaces = function networkInterfaces(...args) {
  try {
    return original.apply(this, args);
  } catch (error) {
    if (!reported) {
      reported = true;
      console.warn(`Android: network interfaces unavailable (${error.message}); UPnP port mapping is off`);
    }
    return {};
  }
};
// Named ESM imports of node:os (import { networkInterfaces } from "node:os") see the wrapper too.
syncBuiltinESMExports();

// Access key. On Android every app can open 127.0.0.1, so any installed app could read the
// Library or start downloads through LVL's server. The app makes a random key for each
// launch (LVL_ACCESS_TOKEN) and gives it to its own WebView as an HttpOnly cookie; requests
// without it are refused. FFmpeg and ffprobe read torrent streams back from the server, so
// the key is added to the server's own addresses in their arguments.
const token = process.env.LVL_ACCESS_TOKEN || "";
if (token) {
  const crypto = require("node:crypto");
  const http = require("node:http");
  const childProcess = require("node:child_process");
  const NAME = "lvl_access";
  const expected = Buffer.from(token);
  const same = (value) => {
    const given = Buffer.from(String(value || ""));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };
  const allowed = (req) => {
    const cookies = String(req.headers?.cookie || "").split(";").map((part) => part.trim());
    if (cookies.some((part) => part.startsWith(`${NAME}=`) && same(part.slice(NAME.length + 1)))) return true;
    try { return same(new URL(req.url || "/", "http://127.0.0.1").searchParams.get(NAME)); } catch { return false; }
  };
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emitWithAccessKey(event, req, res) {
    if (event === "request" && !allowed(req)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Only the LVL app can use this server");
      return true;
    }
    if (event === "upgrade" && !allowed(req)) {
      res?.destroy?.();
      return true;
    }
    return emit.apply(this, arguments);
  };

  const port = String(process.env.PORT || "");
  const own = new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${port}/`);
  const helpers = new Set([process.env.FFMPEG_BIN, process.env.FFPROBE_BIN].filter(Boolean));
  const withKey = (arg) => {
    if (typeof arg !== "string" || !own.test(arg) || arg.includes(`${NAME}=`)) return arg;
    const hash = arg.indexOf("#");
    const [head, tail] = hash >= 0 ? [arg.slice(0, hash), arg.slice(hash)] : [arg, ""];
    return `${head}${head.includes("?") ? "&" : "?"}${NAME}=${encodeURIComponent(token)}${tail}`;
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = function spawnWithAccessKey(command, args, ...rest) {
    if (helpers.has(command) && Array.isArray(args)) args = args.map(withKey);
    return spawn.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
}

// 4. FFmpeg filters the app's build lacks. The app's FFmpeg has only what LVL asks for
// (android/native/build-ffmpeg.sh), and FFmpeg refuses a whole command when one filter is
// missing. Builds before 2026-11-01 lack lowpass, which the speech band of every remux uses
// (server.js: highpass=f=120,lowpass=f=4000 on a second output), so every remux failed.
// There the band's top is cut by resampling to 8 kHz and back instead, which removes the
// same sounds above 4 kHz. Checked once against the bundled FFmpeg; a build that has
// lowpass gets the command unchanged.
const ffmpegBin = process.env.FFMPEG_BIN || "";
if (ffmpegBin) {
  const childProcess = require("node:child_process");
  let filters = null;
  const hasFilter = (name) => {
    if (filters === null) {
      try {
        const listing = childProcess.execFileSync(ffmpegBin, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
        filters = new Set(listing.split("\n").map((line) => line.trim().split(/\s+/)[1]).filter(Boolean));
      } catch {
        filters = new Set();
      }
      if (!filters.has("lowpass")) console.warn("Android: this FFmpeg has no lowpass filter; the speech band uses resampling instead");
    }
    return filters.has(name);
  };
  const LOWPASS = "lowpass=f=4000";
  const withFilters = (arg) => (typeof arg === "string" && arg.includes(LOWPASS) && !hasFilter("lowpass")
    ? arg.split(LOWPASS).join("aresample=8000,aresample=16000") : arg);
  const spawn = childProcess.spawn;
  childProcess.spawn = function spawnWithFilters(command, args, ...rest) {
    if (command === ffmpegBin && Array.isArray(args)) args = args.map(withFilters);
    return spawn.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
}


// 5. Torrent peers encrypt their connections (BitTorrent's Message Stream Encryption), and the
// library creates a new Diffie-Hellman object for every connection. Creating one checks its
// 768-bit group each time: 16 ms on a desktop and 76-107 ms on the Android emulator, blocking
// the server while it ran. With several new peer connections a second that was a third of the
// server's time. The group never changes, so one object is created (and checked) once; each
// connection still gets its own random private key, its public key and its shared secret,
// computed with that object (0.1 ms). The results are the same as with a new object per
// connection, and invalid peer keys are still refused.
{
  const crypto = require("node:crypto");
  const MSE_PRIME = "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a36210000000000090563";
  const create = crypto.createDiffieHellman;
  let group = null;
  crypto.createDiffieHellman = function createDiffieHellman(prime, ...rest) {
    if (prime !== MSE_PRIME || rest.length !== 2 || rest[0] !== "hex" || rest[1] !== 2) return create.call(this, prime, ...rest);
    group ||= create.call(crypto, MSE_PRIME, "hex", 2);
    let privateKey = null;
    let publicKey = null;
    return {
      generateKeys() {
        if (!publicKey) {
          privateKey = crypto.randomBytes(32);
          group.setPrivateKey(privateKey);
          publicKey = Buffer.from(group.generateKeys());
        }
        return publicKey;
      },
      computeSecret(otherPublicKey) {
        if (!privateKey) this.generateKeys();
        group.setPrivateKey(privateKey);
        return group.computeSecret(otherPublicKey);
      },
    };
  };
  syncBuiltinESMExports();
}
