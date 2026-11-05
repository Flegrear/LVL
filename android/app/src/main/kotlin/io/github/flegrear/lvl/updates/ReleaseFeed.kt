package io.github.flegrear.lvl.updates

import io.github.flegrear.lvl.AppFiles
import io.github.flegrear.lvl.readAtMost
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** One verified Android release APK; patches are not published on this channel yet. */
data class Release(val version: String, val asset: String, val url: String, val size: Long, val sumsUrl: String, val patch: Boolean)

/**
 * Android has its own android-vX.Y.Z release entries in the same GitHub repository
 * as Windows vX.Y.Z. Never select Windows or native-build releases, nor assume the
 * first 20 interleaved entries contain Android's newest update. The initial
 * Android channel offers signed full APKs only; patching needs a separately proven
 * signed predecessor chain before being enabled.
 */
class ReleaseFeed(
    private val http: OkHttpClient,
    private val feedUrl: String = RELEASES_URL,
    private val assetPrefix: String = ASSET_PREFIX,
) {
    companion object {
        const val RELEASES_URL = "https://api.github.com/repos/Flegrear/LVL/releases?per_page=20"
        const val ASSET_PREFIX = "https://github.com/Flegrear/LVL/releases/download/"
        private const val MAX_FEED = 1024 * 1024
        private const val MAX_SUMS = 64 * 1024
        private const val PAGE_SIZE = 20
        private const val MAX_PAGES = 10
        private val TAG = Regex("^android-v(0|[1-9]\\d{0,3})\\.(0|[1-9]\\d{0,3})\\.(0|[1-9]\\d{0,3})$")
        private val SUM_LINE = Regex("^([0-9a-fA-F]{64})\\s+\\*?(.+?)\\s*$")

        // Reserved for a future reviewed patch channel; never selected for installation.
        fun patchName(version: String) = "LVL-android-update-v$version.zip"
        fun apkName(version: String, abi: String) = "LVL-$version-$abi.apk"

        /** The SHA-256 a SHA256SUMS file lists for one file name, or null. */
        fun sha256For(sums: String, name: String): String? {
            var checksum: String? = null
            for (line in sums.lineSequence()) {
                if (line.isBlank()) continue
                val match = SUM_LINE.matchEntire(line.trim()) ?: return null
                if (match.groupValues[2] != name) continue
                if (checksum != null) return null
                checksum = match.groupValues[1].lowercase()
            }
            return checksum
        }

        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(1 shl 16)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }

    /** The newest published Android APK newer than this installed Android runtime. */
    fun find(installed: String, abi: String): Release? {
        if (abi !in setOf("arm64", "x86_64")) return null
        val endpoint = feedUrl.toHttpUrl()
        var newest: Release? = null
        for (page in 1..MAX_PAGES) {
            val pageUrl = endpoint.newBuilder()
                .setQueryParameter("per_page", PAGE_SIZE.toString())
                .setQueryParameter("page", page.toString()).build().toString()
            val text = String(readBounded(pageUrl, MAX_FEED, json = true), Charsets.UTF_8)
            val releases = Json.parseToJsonElement(text) as? JsonArray ?: throw IOException("Invalid Android release feed")
            for (entry in releases) {
                val item = candidate(entry as? JsonObject, abi) ?: continue
                if (AppFiles.compareVersions(item.version, installed) > 0 &&
                    (newest == null || AppFiles.compareVersions(item.version, newest.version) > 0)) {
                    newest = item
                }
            }
            if (releases.size < PAGE_SIZE) return newest
        }
        // Never report "up to date" when GitHub's mixed release feed was truncated.
        throw IOException("Android release feed exceeds the bounded $MAX_PAGES-page search")
    }

    private fun candidate(release: JsonObject?, abi: String): Release? {
        if (release == null || release["draft"]?.jsonPrimitive?.booleanOrNull != false ||
            release["prerelease"]?.jsonPrimitive?.booleanOrNull != false) return null
        val match = TAG.find(release["tag_name"]?.jsonPrimitive?.contentOrNull.orEmpty()) ?: return null
        val version = match.groupValues.drop(1).joinToString(".") { it.toInt().toString() }
        val tag = "android-v$version"
        val allowed = setOf(apkName(version, "arm64"), apkName(version, "x86_64"),
            "LVL-Android-RELEASE-NOTICE.txt", "SHA256SUMS")
        val values = release["assets"] as? JsonArray ?: return null
        if (values.size != allowed.size) return null
        val assets = values.map { item ->
            val asset = item as? JsonObject ?: return null
            val name = asset["name"]?.jsonPrimitive?.contentOrNull ?: return null
            val url = asset["browser_download_url"]?.jsonPrimitive?.contentOrNull ?: return null
            val size = asset["size"]?.jsonPrimitive?.longOrNull ?: return null
            if (name !in allowed || url != "$assetPrefix$tag/$name" || size <= 0) return null
            Triple(name, url, size)
        }
        if (assets.map { it.first }.toSet() != allowed) return null
        val sums = assets.single { it.first == "SHA256SUMS" }.second
        val apk = assets.single { it.first == apkName(version, abi) }
        return Release(version, apk.first, apk.second, apk.third, sums, patch = false)
    }

    fun readSums(release: Release): String = String(readBounded(release.sumsUrl, MAX_SUMS), Charsets.UTF_8)

    /** Downloads to [out], calling [progress] with the bytes so far; stops past [limit]. */
    fun download(release: Release, out: File, limit: Long, progress: (Long) -> Unit) {
        http.newCall(request(release.url, json = false)).execute().use { response ->
            if (!response.isSuccessful) throw IOException("The download answered HTTP ${response.code}")
            if (response.body.contentLength() > limit) throw IOException("The download is too large")
            response.body.byteStream().use { input ->
                out.outputStream().use { output ->
                    val buffer = ByteArray(1 shl 16)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > limit) throw IOException("The download is too large")
                        output.write(buffer, 0, read)
                        progress(total)
                    }
                }
            }
        }
    }

    private fun request(url: String, json: Boolean) = Request.Builder().url(url)
        .header("User-Agent", "LVL-Android")
        .apply { if (json) header("Accept", "application/vnd.github+json") }
        .build()

    private fun readBounded(url: String, limit: Int, json: Boolean = false): ByteArray {
        http.newCall(request(url, json)).execute().use { response ->
            if (!response.isSuccessful) throw IOException("The release lookup answered HTTP ${response.code}")
            val bytes = response.body.byteStream().use { it.readAtMost(limit + 1) }
            if (bytes.size > limit) throw IOException("The release details are too large")
            return bytes
        }
    }
}
