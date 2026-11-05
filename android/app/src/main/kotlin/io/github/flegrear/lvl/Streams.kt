package io.github.flegrear.lvl

import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * Reads at most [limit] bytes (fewer at the end of the stream). InputStream.readNBytes does
 * the same but only exists from Android 13, and LVL runs on Android 12.
 */
fun InputStream.readAtMost(limit: Int): ByteArray {
    val out = ByteArrayOutputStream(minOf(limit, 1 shl 16))
    val buffer = ByteArray(1 shl 16)
    while (out.size() < limit) {
        val read = read(buffer, 0, minOf(buffer.size, limit - out.size()))
        if (read < 0) break
        out.write(buffer, 0, read)
    }
    return out.toByteArray()
}
