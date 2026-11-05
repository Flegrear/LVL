package io.github.flegrear.lvl.comics

import android.content.Context
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.util.Log
import eu.kanade.tachiyomi.network.HttpException
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.interceptor.BROWSER_CHECK_MARK
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread
import io.github.flegrear.lvl.readAtMost

/**
 * Runs Comics extensions for LVL's server on Android. It speaks the desktop extension
 * runner's protocol (ext-runner/src/main/kotlin/lvl/runner/Main.kt): one JSON object per line,
 * {"ready":true,"version":1} first, then answers {"id":…,"result":…} or {"id":…,"error":…}.
 * Instead of stdin/stdout of a Java process, it listens on a Unix socket in the app's
 * private folder, and serves only processes of this app (LVL's server runs as the app).
 * Ops: load, sources, search, popular, latest, details, chapters, pages, image, cookies.
 */
class ExtensionHost(private val context: Context) {
    companion object {
        const val PROTOCOL_VERSION = 1
        private const val MAX_IMAGE_BYTES = 40L * 1024 * 1024
        private const val TAG = "LVL-ExtHost"
    }

    class RequestError(message: String, val status: Int = 400) : Exception(message)

    val socketFile = File(context.filesDir, "run/ext-host.sock")
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val permits = Semaphore(8)
    private val sources = ConcurrentHashMap<Long, CatalogueSource>()
    // Extensions on library 1.6 keep data in a manga's or chapter's memo between calls.
    private val mangaMemo = ConcurrentHashMap<String, JsonObject>()
    private val chapterMemo = ConcurrentHashMap<String, JsonObject>()
    private var server: LocalServerSocket? = null
    private var bound: LocalSocket? = null

    @Synchronized
    fun start(): File {
        if (server != null) return socketFile
        socketFile.parentFile?.mkdirs()
        socketFile.delete()
        val socket = LocalSocket(LocalSocket.SOCKET_STREAM)
        socket.bind(LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
        val listening = LocalServerSocket(socket.fileDescriptor)
        bound = socket
        server = listening
        thread(name = "lvl-ext-host", isDaemon = true) {
            while (true) {
                val client = try { listening.accept() } catch (_: Exception) { break }
                // Only this app's own processes (LVL's server) may use the extensions.
                if (client.peerCredentials.uid != Process.myUid()) {
                    Log.w(TAG, "Refused a connection from uid ${client.peerCredentials.uid}")
                    runCatching { client.close() }
                    continue
                }
                thread(name = "lvl-ext-host-client", isDaemon = true) { serve(client) }
            }
        }
        Log.i(TAG, "Listening on ${socketFile.absolutePath}")
        return socketFile
    }

    @Synchronized
    fun stop() {
        runCatching { server?.close() }
        runCatching { bound?.close() }
        server = null
        bound = null
        socketFile.delete()
        scope.cancel()
    }

    private fun serve(client: LocalSocket) {
        val output = BufferedWriter(OutputStreamWriter(client.outputStream, Charsets.UTF_8))
        val write = { message: JsonObject ->
            synchronized(output) {
                output.write(message.toString())
                output.write("\n")
                output.flush()
            }
        }
        try {
            write(buildJsonObject { put("ready", true); put("version", PROTOCOL_VERSION) })
            val input = BufferedReader(InputStreamReader(client.inputStream, Charsets.UTF_8))
            while (true) {
                val line = input.readLine() ?: break
                if (line.isBlank()) continue
                scope.launch { permits.withPermit { answer(line, write) } }
            }
        } catch (error: Exception) {
            Log.w(TAG, "Connection ended: ${error.message}")
        } finally {
            runCatching { client.close() }
        }
    }

    private suspend fun answer(line: String, write: (JsonObject) -> Unit) {
        var id: JsonElement = JsonNull
        try {
            val request = json.parseToJsonElement(line).jsonObject
            id = request["id"] ?: JsonNull
            val result = handle(request)
            runCatching { write(buildJsonObject { put("id", id); put("result", result) }) }
        } catch (error: Throwable) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: error::class.java.simpleName
            val check = message.contains(BROWSER_CHECK_MARK)
            val status = if (check) 403 else (error as? RequestError)?.status ?: (error as? HttpException)?.code ?: 502
            // The extension's code doesn't link on this device (a broken or unusual build).
            val code = error is LinkageError || error is ClassNotFoundException
            Log.w(TAG, "${error::class.java.name}: $message")
            runCatching {
                write(buildJsonObject {
                    put("id", id)
                    put("error", message.replace(BROWSER_CHECK_MARK, "").trim().take(500))
                    put("status", status)
                    if (check) put("code", "blocked") else if (code) put("code", "extension-code")
                })
            }
        }
    }

    private fun JsonObject.text(name: String): String? = this[name]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.need(name: String): String = text(name)?.takeIf { it.isNotEmpty() } ?: throw RequestError("Missing $name")

    private fun source(request: JsonObject): CatalogueSource {
        val id = request.need("source").toLongOrNull() ?: throw RequestError("Invalid source id")
        return sources[id] ?: throw RequestError("This source isn't loaded", 404)
    }

    private fun page(request: JsonObject): Int = request["page"]?.jsonPrimitive?.intOrNull?.coerceIn(1, 500) ?: 1

    private suspend fun handle(request: JsonObject): JsonElement =
        when (request.need("op")) {
            "load" -> load(request)
            "sources" -> buildJsonArray { sources.values.forEach { add(describe(it)) } }
            "search" -> mangasPage(source(request).getSearchManga(page(request), request.text("query") ?: "", FilterList()), request)
            "popular" -> mangasPage(source(request).getPopularManga(page(request)), request)
            "latest" -> mangasPage(source(request).getLatestUpdates(page(request)), request)
            "details" -> {
                val source = source(request)
                manga(source, source.getMangaUpdate(mangaOf(request), emptyList(), fetchDetails = true, fetchChapters = false).manga)
            }
            "chapters" -> {
                val source = source(request)
                val chapters = source.getMangaUpdate(mangaOf(request), emptyList(), fetchDetails = false, fetchChapters = true).chapters
                buildJsonArray { chapters.forEach { add(chapter(source, it)) } }
            }
            "pages" -> {
                val source = source(request)
                val pages = source.getPageList(chapterOf(source, request))
                buildJsonArray {
                    pages.forEach { page ->
                        add(buildJsonObject { put("index", page.index); put("url", page.url); put("imageUrl", page.imageUrl) })
                    }
                }
            }
            "image" -> image(request)
            "cookies" -> cookies(request)
            // The app as Comics' browser (backend/comics/app-browser.js).
            "browserRequest" -> browserRequest(request)
            "siteCookies" -> siteCookies(request)
            "openVisible" -> buildJsonObject { put("open", VerifyActivity.start(context, request.need("url"))) }
            "verifyState" -> buildJsonObject {
                put("open", VerifyActivity.open)
                put("passed", VerifyActivity.passed)
                if (VerifyActivity.finishedAt > 0) put("at", VerifyActivity.finishedAt)
            }
            else -> throw RequestError("Unknown op")
        }

    private fun load(request: JsonObject): JsonElement {
        val expected = request.text("fingerprint")
        val extension = ExtensionLoader.load(context, File(request.need("apk")), expected)
        Log.i(TAG, "Loaded ${extension.pkg} ${extension.versionName}: ${extension.sources.size} sources, signer ${extension.signer.take(12)}" +
            if (expected.isNullOrBlank()) " (no repository key to check)" else " (matches the repository key)")
        extension.sources.forEach { sources[it.id] = it }
        return buildJsonObject {
            put("pkg", extension.pkg)
            put("version", extension.versionName)
            put("lib", extension.libVersion)
            put("nsfw", extension.nsfw)
            put("signer", extension.signer)
            put("sources", buildJsonArray { extension.sources.forEach { add(describe(it)) } })
        }
    }

    private fun describe(source: CatalogueSource): JsonObject =
        buildJsonObject {
            put("id", source.id.toString())
            put("name", source.name)
            put("lang", source.lang)
            put("supportsLatest", source.supportsLatest)
            if (source is HttpSource) put("baseUrl", source.baseUrl)
        }

    private fun mangasPage(result: MangasPage, request: JsonObject): JsonElement {
        val source = source(request)
        return buildJsonObject {
            put("hasNextPage", result.hasNextPage)
            put("mangas", buildJsonArray { result.mangas.forEach { add(manga(source, it)) } })
        }
    }

    private fun memoOf(manga: SManga): JsonObject? = runCatching { manga.memo }.getOrNull()?.takeIf { it.isNotEmpty() }

    private fun manga(source: CatalogueSource, manga: SManga): JsonObject {
        memoOf(manga)?.let { mangaMemo["${source.id}\n${manga.url}"] = it }
        return buildJsonObject {
            put("url", manga.url)
            put("title", runCatching { manga.title }.getOrDefault(""))
            put("thumbnail", manga.thumbnail_url)
            put("author", manga.author)
            put("artist", manga.artist)
            put("description", manga.description)
            put("genre", manga.genre)
            put("status", manga.status)
        }
    }

    private fun chapter(source: CatalogueSource, chapter: SChapter): JsonObject {
        runCatching { chapter.memo }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { chapterMemo["${source.id}\n${chapter.url}"] = it }
        return buildJsonObject {
            put("url", chapter.url)
            put("name", chapter.name)
            put("number", chapter.chapter_number.toString())
            put("date", chapter.date_upload)
            put("scanlator", chapter.scanlator)
        }
    }

    private fun mangaOf(request: JsonObject): SManga {
        val source = source(request)
        val url = request.need("url")
        return SManga.create().apply {
            this.url = url
            title = request.text("title") ?: ""
            mangaMemo["${source.id}\n$url"]?.let { runCatching { memo = it } }
        }
    }

    private fun chapterOf(source: CatalogueSource, request: JsonObject): SChapter {
        val url = request.need("url")
        return SChapter.create().apply {
            this.url = url
            name = request.text("name") ?: ""
            chapterMemo["${source.id}\n$url"]?.let { runCatching { memo = it } }
        }
    }

    // A page's image through the source's own client (some sources unscramble images there).
    private suspend fun image(request: JsonObject): JsonElement {
        val source = source(request) as? HttpSource ?: throw RequestError("This source has no images to fetch")
        val page = Page(request["index"]?.jsonPrimitive?.intOrNull ?: 0, request.text("url") ?: "", request.text("imageUrl")?.takeIf { it.isNotEmpty() })
        if (page.imageUrl == null) page.imageUrl = source.getImageUrl(page)
        source.getImage(page).use { response ->
            val body = response.body
            if (body.contentLength() > MAX_IMAGE_BYTES) throw RequestError("The image is too large", 502)
            val bytes = body.bytes()
            if (bytes.size > MAX_IMAGE_BYTES) throw RequestError("The image is too large", 502)
            return buildJsonObject {
                put("type", body.contentType()?.toString() ?: "application/octet-stream")
                put("imageUrl", page.imageUrl)
                put("data", Base64.getEncoder().encodeToString(bytes))
            }
        }
    }

    // A page for LVL's own engines, through the app's client: the WebView's cookies and user
    // agent, Cloudflare checks passed in a hidden WebView, public addresses only.
    private val pageClient by lazy { Injekt.get<NetworkHelper>().client.newBuilder().dns(PublicOnlyDns).build() }

    private fun browserRequest(request: JsonObject): JsonElement {
        val url = request.need("url").toHttpUrl()
        if (url.scheme != "https" && url.scheme != "http") throw RequestError("Only web addresses can be fetched")
        val method = (request.text("method") ?: "GET").uppercase()
        val maxBytes = (request["maxBytes"]?.jsonPrimitive?.longOrNull ?: (8L * 1024 * 1024)).coerceIn(1, MAX_IMAGE_BYTES)
        val builder = Request.Builder().url(url)
        var contentType: String? = null
        (request["headers"] as? JsonObject)?.forEach { (name, value) ->
            val text = (value as? JsonPrimitive)?.contentOrNull ?: return@forEach
            when {
                // OkHttp decompresses only what it asked for itself.
                name.equals("Accept-Encoding", ignoreCase = true) || name.equals("Content-Length", ignoreCase = true) -> {}
                name.equals("Content-Type", ignoreCase = true) -> contentType = text
                else -> builder.header(name, text)
            }
        }
        request.text("referer")?.takeIf { it.isNotBlank() }?.let { builder.header("Referer", it) }
        val body = request.text("body")?.let { Base64.getDecoder().decode(it) }
        if (method == "GET" || method == "HEAD") builder.method(method, null)
        else builder.method(method, (body ?: ByteArray(0)).toRequestBody(contentType?.toMediaTypeOrNull()))
        pageClient.newCall(builder.build()).execute().use { response ->
            val bytes = response.body.byteStream().use { it.readAtMost((maxBytes + 1).toInt()) }
            if (bytes.size > maxBytes) throw RequestError("The page is too large", 502)
            return buildJsonObject {
                put("status", response.code)
                put("url", response.request.url.toString())
                put("headers", buildJsonObject {
                    response.headers.names().forEach { name ->
                        val values = response.headers.values(name)
                        if (name.equals("Set-Cookie", ignoreCase = true)) put(name.lowercase(), buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
                        else put(name.lowercase(), values.joinToString(", "))
                    }
                })
                put("data", Base64.getEncoder().encodeToString(bytes))
            }
        }
    }

    // The site's cookies once it can be read (a check passed now or on the Verify screen),
    // as Set-Cookie strings, with the user agent they belong to.
    private fun siteCookies(request: JsonObject): JsonElement {
        val url = request.need("url").toHttpUrl()
        pageClient.newCall(Request.Builder().url(url).build()).execute().close()
        val network = Injekt.get<NetworkHelper>()
        val header = android.webkit.CookieManager.getInstance().getCookie(url.toString()).orEmpty()
        return buildJsonObject {
            put("cookies", buildJsonArray {
                header.split(';').map { it.trim() }.filter { it.contains('=') }.forEach { add(JsonPrimitive("$it; Domain=${url.host}; Path=/")) }
            })
            put("userAgent", network.defaultUserAgentProvider())
        }
    }

    // Cookies from a check LVL passed elsewhere, and that browser's user agent.
    private fun cookies(request: JsonObject): JsonElement {
        val url = request.need("url").toHttpUrl()
        val network = Injekt.get<NetworkHelper>()
        val list = (request["cookies"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        val added = network.cookieJar.add(url, list)
        request.text("userAgent")?.let { network.setUserAgent(it) }
        return buildJsonObject { put("added", added) }
    }
}
