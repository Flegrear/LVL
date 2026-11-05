package io.github.flegrear.lvl

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore

/** Saves files the page downloads (exports, backups) to the shared Downloads folder. */
object Downloads {
    private val UNSAFE = Regex("""[\\/:*?"<>|\u0000-\u001f]""")

    fun safeName(name: String): String =
        name.replace(UNSAFE, "_").trim().trimStart('.').take(120).ifBlank { "download" }

    /** Writes [bytes] as Downloads/[name]; MediaStore adds a number if the name is taken. */
    fun save(context: Context, name: String, mimeType: String, bytes: ByteArray): Uri {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safeName(name))
            put(MediaStore.Downloads.MIME_TYPE, mimeType.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("Downloads isn't available")
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("Couldn't open the new file")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return uri
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            throw error
        }
    }
}
