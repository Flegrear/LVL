// Read fetch Response bodies with a finite retained-byte budget. A source may
// omit or lie about Content-Length; the stream is the authoritative bound.
export async function discardResponseBody(response, abort) {
  abort?.();
  try { await response?.body?.cancel?.(); } catch {}
}

export async function readBoundedResponse(response, maxBytes, tooLarge, abort) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) {
    await discardResponseBody(response, abort);
    throw new Error(tooLarge);
  }
  if (!response.body) return Buffer.alloc(0);
  let reader;
  try {
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("The response body is unreadable");
      size += value.byteLength;
      if (size > maxBytes) throw new Error(tooLarge);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    abort?.();
    if (reader) {
      try { await reader.cancel(); } catch {}
    } else {
      try { await response.body.cancel(); } catch {}
    }
    throw error;
  } finally {
    try { reader?.releaseLock(); } catch {}
  }
}
