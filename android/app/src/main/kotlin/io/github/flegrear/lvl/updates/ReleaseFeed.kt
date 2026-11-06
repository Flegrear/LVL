package io.github.flegrear.lvl.updates

import io.github.flegrear.lvl.AppFiles
import io.github.flegrear.lvl.readAtMost
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
data class Release(val version: String, val asset: String, val url: String, val size: Long, val sumsUrl: String, val patch: Boolean,
    val payloadSha256: String? = null, val sumsSha256: String? = null, val sumsSize: Long? = null, val versionCode: Long? = null)

/**
 * Reads legacy Android entries and combined manifests with independent platform
 * versions. Walks the mixed release feed with a bounded search and offers signed
 * full APKs only.
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
        private val COMBINED_TAG = Regex("^release-\\d{4}-\\d{2}-\\d{2}\\.[1-9]\\d*$")
        private val VERSION = Regex("^(0|[1-9]\\d{0,3})\\.(0|[1-9]\\d{0,3})\\.(0|[1-9]\\d{0,3})$")
        private const val MAX_ASSET = 2L * 1024 * 1024 * 1024

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
        val releaseTag = release["tag_name"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (COMBINED_TAG.matches(releaseTag)) return combined(release, releaseTag, abi)
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

    private data class Asset(val name: String, val url: String, val size: Long, val sha256: String)

    private fun invalid(): Nothing = throw IOException("Invalid combined LVL release manifest")
    private fun JsonObject.string(key: String): String = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: invalid()
    private fun JsonObject.integer(key: String): Long = (this[key] as? JsonPrimitive)?.takeIf { !it.isString && Regex("^[0-9]+$").matches(it.content) }?.longOrNull ?: invalid()
    private fun JsonObject.obj(key: String): JsonObject = this[key] as? JsonObject ?: invalid()

    private fun combined(release: JsonObject, tag: String, abi: String): Release? {
        val attached = release["assets"] as? JsonArray ?: invalid()
        val assets = attached.map { it as? JsonObject ?: invalid() }
        val names = assets.map { it.string("name") }
        if (names.toSet().size != names.size) invalid()
        val manifest = assets.singleOrNull { it.string("name") == "LVL-release.json" } ?: invalid()
        val manifestUrl = "$assetPrefix$tag/LVL-release.json"
        if (manifest.string("browser_download_url") != manifestUrl || manifest.integer("size") !in 1..MAX_SUMS.toLong()) invalid()
        val bytes = readBounded(manifestUrl, MAX_SUMS)
        if (bytes.size.toLong() != manifest.integer("size")) invalid()
        fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        fun apiDigest(item: JsonObject, expected: String) {
            val value = item["digest"]
            if (value != null && value.toString() != "null" && (value as? JsonPrimitive)?.contentOrNull != "sha256:$expected") invalid()
        }
        apiDigest(manifest, digest(bytes))
        val document = Json.parseToJsonElement(String(bytes, Charsets.UTF_8)) as? JsonObject ?: invalid()
        if (document.integer("schemaVersion") != 1L || document.string("tag") != tag) invalid()
        val platforms = document.obj("platforms")
        val current = linkedMapOf<String, Asset>()
        fun record(value: JsonObject, expected: String, legacy: String, sources: MutableSet<String>): Asset {
            val name = value.string("name")
            val url = value.string("url")
            val size = value.integer("size")
            val sha = value.string("sha256")
            if (name != expected || size !in 1..MAX_ASSET || !Regex("^[a-f0-9]{64}$").matches(sha)) invalid()
            if (!url.startsWith(assetPrefix)) invalid()
            val suffix = url.removePrefix(assetPrefix)
            val source = suffix.substringBefore('/')
            if (suffix != "$source/$name" || !(COMBINED_TAG.matches(source) || source == legacy)) invalid()
            sources.add(source)
            val result = Asset(name, url, size, sha)
            if (source == tag && current.put(name, result) != null) invalid()
            return result
        }
        var androidRelease: Release? = null
        platforms["android"]?.let {
            val android = it as? JsonObject ?: invalid()
            val version = android.string("version")
            if (!VERSION.matches(version)) invalid()
            val code = android.integer("versionCode")
            if (code !in 205..Int.MAX_VALUE.toLong()) invalid()
            val sources = mutableSetOf<String>()
            val apks = android.obj("apks")
            if (apks.keys != setOf("arm64", "x86_64")) invalid()
            val records = listOf("arm64", "x86_64").associateWith { arch -> record(apks.obj(arch), apkName(version, arch), "android-v$version", sources) }
            val sums = record(android.obj("checksums"), "SHA256SUMS", "android-v$version", sources)
            val notice = record(android.obj("notice"), "LVL-Android-RELEASE-NOTICE.txt", "android-v$version", sources)
            if (sources.size != 1 || sums.size > MAX_SUMS || notice.size > MAX_SUMS || records.values.any { apk -> apk.size > 400L * 1024 * 1024 }) invalid()
            val apk = records.getValue(abi)
            androidRelease = Release(version, apk.name, apk.url, apk.size, sums.url, false, apk.sha256, sums.sha256, sums.size, code)
        }
        platforms["windows"]?.let {
            val windows = it as? JsonObject ?: invalid()
            val version = windows.string("version")
            if (!Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$").matches(version) || version.split('.').any { part -> part.toIntOrNull() == null }) invalid()
            val name = when(windows.string("kind")) { "patch" -> "LVL-update-v$version.zip"; "installer" -> "LVL-Setup.exe"; else -> invalid() }
            val sources = mutableSetOf<String>()
            record(windows.obj("asset"), name, "v$version", sources)
            val sums = windows.obj("checksums")
            val sumsName = sums.string("name")
            if (sumsName !in setOf("$name.sha256", "SHA256SUMS")) invalid()
            if (record(sums, sumsName, "v$version", sources).size > MAX_SUMS || sources.size != 1) invalid()
        }
        if (names.toSet() != current.keys + "LVL-release.json") invalid()
        for ((name, record) in current) {
            val item = assets.single { it.string("name") == name }
            if (item.string("browser_download_url") != record.url || item.integer("size") != record.size) invalid()
            apiDigest(item, record.sha256)
        }
        return androidRelease
    }

    fun readSums(release: Release): String {
        val bytes = readBounded(release.sumsUrl, MAX_SUMS)
        if (release.sumsSize != null && bytes.size.toLong() != release.sumsSize) throw IOException("The release checksum size changed")
        if (release.sumsSha256 != null && MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } != release.sumsSha256)
            throw IOException("The release checksum digest changed")
        val text = String(bytes, Charsets.UTF_8)
        if (release.payloadSha256 != null && sha256For(text, release.asset) != release.payloadSha256) throw IOException("The release checksum differs from its manifest")
        return text
    }

    /** Downloads to [out], calling [progress] with the bytes so far; stops past [limit]. */
    fun download(release: Release, out: File, limit: Long, progress: (Long) -> Unit) {
        val downloadLimit = if (release.payloadSha256 != null) minOf(limit, release.size) else limit
        http.newCall(request(release.url, json = false)).execute().use { response ->
            if (!response.isSuccessful) throw IOException("The download answered HTTP ${response.code}")
            if (response.body.contentLength() > downloadLimit) throw IOException("The download is too large")
            response.body.byteStream().use { input ->
                out.outputStream().use { output ->
                    val buffer = ByteArray(1 shl 16)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > downloadLimit) throw IOException("The download is too large")
                        output.write(buffer, 0, read)
                        progress(total)
                    }
                }
            }
        }
        if (release.payloadSha256 != null && (out.length() != release.size || sha256(out) != release.payloadSha256))
            throw IOException("The download didn't match the release manifest")
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
