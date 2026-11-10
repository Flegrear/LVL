package io.github.flegrear.lvl

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.util.Base64
import android.util.Base64InputStream
import java.io.InputStream
import java.io.IOException

/** Saves files the page downloads (exports, backups) to the shared Downloads folder. */
object Downloads {
    private val UNSAFE = Regex("""[\\/:*?"<>|\u0000-\u001f]""")
    const val MAX_BYTES = 50 * 1024 * 1024
    const val MAX_BASE64_CHARS = ((MAX_BYTES.toLong() + 2) / 3 * 4).toInt()

    fun safeName(name: String): String =
        name.replace(UNSAFE, "_").trim().trimStart('.').take(120).ifBlank { "download" }

    /**
     * The document bridge is limited to 50 MiB. Validate the *encoded* length
     * and every character before opening a pending MediaStore row. Decode to
     * the output stream in chunks without allocating another full byte array.
     */
    fun saveBase64(context: Context, name: String, mimeType: String, encoded: String): Uri {
        val n = encoded.length
        require(n <= MAX_BASE64_CHARS && n % 4 == 0) { "The file is too large or its data is invalid" }
        var padding = 0
        if (n > 0 && encoded[n - 1] == '=') padding++
        if (n > 1 && encoded[n - 2] == '=') padding++
        val decodedSize = (n.toLong() / 4) * 3 - padding
        require(decodedSize <= MAX_BYTES) { "The file is too large to save" }
        for (i in 0 until n) {
            val ch = encoded[i]
            val data = ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '+' || ch == '/'
            require(if (i < n - padding) data else ch == '=') { "The file data is invalid" }
        }
        // No encoded-to-byte-array conversion. The Base64 decoder consumes a
        // read-only ASCII view of the existing Java String.
        val ascii = object : InputStream() {
            var cursor = 0
            override fun read(): Int = if (cursor >= n) -1 else encoded[cursor++].code
            override fun read(target: ByteArray, offset: Int, length: Int): Int {
                if (length == 0) return 0
                if (cursor >= n) return -1
                val count = minOf(length, n - cursor)
                for (index in 0 until count) target[offset + index] = encoded[cursor++].code.toByte()
                return count
            }
        }
        return Base64InputStream(ascii, Base64.DEFAULT).use { source ->
            saveStream(context, name, mimeType, source, MAX_BYTES.toLong(), decodedSize)
        }
    }

    /** Existing native callers keep the same safe MediaStore filename behavior. */
    fun save(context: Context, name: String, mimeType: String, bytes: ByteArray): Uri {
        require(bytes.size <= MAX_BYTES) { "The file is too large to save" }
        return bytes.inputStream().use { saveStream(context, name, mimeType, it, MAX_BYTES.toLong(), bytes.size.toLong()) }
    }

    private fun saveStream(context: Context, name: String, mimeType: String,
                           source: InputStream, maximumBytes: Long, expectedBytes: Long): Uri {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safeName(name))
            put(MediaStore.Downloads.MIME_TYPE, mimeType.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("Downloads isn't available")
        try {
            var written = 0L
            resolver.openOutputStream(uri)?.use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = source.read(buffer)
                    if (count < 0) break
                    if (count == 0) continue
                    written += count
                    if (written > maximumBytes) throw IOException("The file is too large to save")
                    output.write(buffer, 0, count)
                }
                output.flush()
            } ?: error("Couldn't open the new file")
            if (written != expectedBytes) throw IOException("The file data is incomplete")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            if (resolver.update(uri, values, null, null) != 1) error("Couldn't finish saving the file")
            return uri
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
    }
}
