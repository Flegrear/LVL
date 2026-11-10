// Use Node's actual HTTP(S) socket lookup for each request. A standalone
// preflight DNS resolution cannot protect a later globally resolved fetch.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { Readable, PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { checkUrl, safeLookup, isPublicAddress } from '../comics/remote-fetch.js';

// HTTP servers use both zlib-wrapped and raw RFC1951 bodies for "deflate".
// Select the decoder from the first two bytes, preserving streaming and
// backpressure without buffering an untrusted response into memory.
function decodeHttpDeflate(encoded) {
  const output = new PassThrough();
  let inflater = null;
  let prefix = Buffer.alloc(0);
  encoded.on('data', (chunk) => {
    if (!inflater) {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length < 2) return;
      const cmf = prefix[0], flg = prefix[1];
      const wrapped = (cmf & 15) === 8 && (cmf >> 4) <= 7 && (((cmf << 8) | flg) % 31) === 0;
      inflater = wrapped ? zlib.createInflate() : zlib.createInflateRaw();
      inflater.once('error', (error) => output.destroy(error));
      inflater.pipe(output);
      chunk = prefix;
      prefix = null;
    }
    if (!inflater.write(chunk)) {
      encoded.pause();
      inflater.once('drain', () => encoded.resume());
    }
  });
  encoded.once('end', () => {
    if (inflater) inflater.end();
    else output.destroy(new Error('Incomplete deflate response'));
  });
  encoded.once('error', (error) => { inflater?.destroy(); output.destroy(error); });
  output.once('close', () => { encoded.destroy(); inflater?.destroy(); });
  return output;
}

export function createPinnedFetch({
  resolve = dns.lookup, transport = { http, https }, isAllowedAddress = isPublicAddress,
} = {}) {
  const lookup = safeLookup(resolve, isAllowedAddress);
  return async function pinnedFetch(input, { headers = {}, signal, method = 'GET' } = {}) {
    const url = checkUrl(input);
    if (signal?.aborted) throw signal.reason || new Error('Request canceled');
    // The URL owns the TCP/TLS hostname; caller/provider metadata cannot
    // override it with an arbitrary HTTP Host or proxy hop.
    const requestHeaders = Object.fromEntries(Object.entries(headers)
      .filter(([name]) => !/^(?:host|connection|proxy-authorization|transfer-encoding)$/i.test(name)));
    return new Promise((resolveResponse, reject) => {
      let settled = false;
      const lib = url.protocol === 'https:' ? transport.https : transport.http;
      const req = lib.request(url, {
        method, headers: requestHeaders, lookup, signal,
        // Node's TLS hostname verification and SNI remain the defaults.
      }, (incoming) => {
        const status = incoming.statusCode ?? 502;
        const hasBody = !([204, 205, 304].includes(status) || method === 'HEAD');
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers || {})) {
          if (value === undefined) continue;
          if (key.toLowerCase() === 'set-cookie') {
            for (const cookie of [].concat(value)) responseHeaders.append(key, String(cookie));
          } else responseHeaders.set(key, [].concat(value).join(', '));
        }
        // A native stream is used as response.body, preserving streaming
        // consumers and allowing body.cancel() to destroy the live socket.
        const encoded = incoming instanceof Readable ? incoming : new PassThrough();
        if (!(incoming instanceof Readable)) {
          incoming.on('data', (chunk) => encoded.write(chunk));
          incoming.once('end', () => encoded.end());
          incoming.once('error', (error) => encoded.destroy(error));
        }
        // global fetch previously transparently decompressed these formats.
        // Keep that contract while allowing the consumer's bounded stream
        // reader to enforce its cap on the *decompressed* byte count.
        const encoding = hasBody ? String(incoming.headers?.['content-encoding'] || '').trim().toLowerCase() : '';
        const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
          : encoding === 'br' ? zlib.createBrotliDecompress()
          : encoding === 'deflate' ? 'auto-deflate' : null;
        const readable = decoder === 'auto-deflate' ? decodeHttpDeflate(encoded)
          : decoder ? encoded.pipe(decoder) : encoded;
        if (decoder && decoder !== 'auto-deflate')
          encoded.once('error', (error) => decoder.destroy(error));
        if (decoder) {
          responseHeaders.delete('content-encoding');
          responseHeaders.delete('content-length');
        }
        readable.once('close', () => { if (!req.destroyed) req.destroy(); });
        settled = true;
        try {
          if (!hasBody) {
            encoded.resume();
            resolveResponse(new Response(null, { status, headers: responseHeaders }));
          } else resolveResponse(new Response(Readable.toWeb(readable), { status, headers: responseHeaders }));
        }
        catch (error) { req.destroy(error); reject(error); }
      });
      req.on('error', (error) => { if (!settled) reject(error); });
      req.end();
    });
  };
}
