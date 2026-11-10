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

    class RequestError(message: String, val status: Int = 400, val code: String? = null) : Exception(message)

    val socketFile = File(context.filesDir, "run/ext-host.sock")
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val permits = Semaphore(8)
    private val sources = SourceOwnership<CatalogueSource>()
    private val sourceLock = Any()
    private val sourceOwners = HashMap<Long, Any>()
    private var stopped = false
    private data class SourceSession(val source: CatalogueSource, val owner: Any)
    // Extensions on library 1.6 keep data in a manga's or chapter's memo between calls.
    // Bound both the number of records and their estimated retained JSON payload.
    private val mangaMemo = BoundedOwnerMemo<JsonObject>(weightOf = ::memoWeight)
    private val chapterMemo = BoundedOwnerMemo<JsonObject>(weightOf = ::memoWeight)
    private fun memoWeight(url: String, memo: JsonObject): Long =
        512L + 4L * (url.length.toLong() + memo.toString().length.toLong())
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
        synchronized(sourceLock) {
            stopped = true
            sourceOwners.clear()
            mangaMemo.clear()
            chapterMemo.clear()
        }
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
                    else (error as? RequestError)?.code?.let { put("code", it) }
                })
            }
        }
    }

    private fun JsonObject.text(name: String): String? = this[name]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.need(name: String): String = text(name)?.takeIf { it.isNotEmpty() } ?: throw RequestError("Missing $name")

    private fun source(request: JsonObject): SourceSession {
        val id = request.need("source").toLongOrNull() ?: throw RequestError("Invalid source id")
        return synchronized(sourceLock) {
            if (stopped) throw RequestError("The extension host has stopped", 503)
            val current = sources[id] ?: throw RequestError("This source isn't loaded", 404)
            SourceSession(current, sourceOwners[id] ?: throw RequestError("This source isn't loaded", 404))
        }
    }

    private fun page(request: JsonObject): Int = request["page"]?.jsonPrimitive?.intOrNull?.coerceIn(1, 500) ?: 1

    private suspend fun handle(request: JsonObject): JsonElement =
        when (request.need("op")) {
            "load" -> load(request)
            "sources" -> buildJsonArray { sources.values.forEach { add(describe(it)) } }
            "search" -> {
                val session = source(request)
                mangasPage(session.source.getSearchManga(page(request), request.text("query") ?: "", FilterList()), session)
            }
            "popular" -> {
                val session = source(request)
                mangasPage(session.source.getPopularManga(page(request)), session)
            }
            "latest" -> {
                val session = source(request)
                mangasPage(session.source.getLatestUpdates(page(request)), session)
            }
            "details" -> {
                val session = source(request)
                manga(session, session.source.getMangaUpdate(mangaOf(session, request), emptyList(), fetchDetails = true, fetchChapters = false).manga)
            }
            "chapters" -> {
                val session = source(request)
                val chapters = session.source.getMangaUpdate(mangaOf(session, request), emptyList(), fetchDetails = false, fetchChapters = true).chapters
                buildJsonArray { chapters.forEach { add(chapter(session, it)) } }
            }
            "pages" -> {
                val session = source(request)
                val pages = session.source.getPageList(chapterOf(session, request))
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
            "openVisible" -> {
                val url = request.need("url")
                val requested = VerifyActivity.start(context, url)
                val state = VerifyActivity.state
                buildJsonObject {
                    put("open", requested && state.open && state.url == url)
                    put("pending", state.pending)
                    state.url?.let { put("url", it) }
                    state.generation?.let { put("generation", it) }
                }
            }
            "verifyState" -> {
                val state = VerifyActivity.state
                buildJsonObject {
                    put("open", state.open)
                    put("passed", state.passed)
                    put("pending", state.pending)
                    state.url?.let { put("url", it) }
                    state.generation?.let { put("generation", it) }
                    if (state.finishedAt > 0) put("at", state.finishedAt)
                }
            }
            else -> throw RequestError("Unknown op")
        }

    private fun load(request: JsonObject): JsonElement {
        val expected = request.text("fingerprint")
        val extension = ExtensionLoader.load(context, File(request.need("apk")), expected)
        Log.i(TAG, "Loaded ${extension.pkg} ${extension.versionName}: ${extension.sources.size} sources, signer ${extension.signer.take(12)}" +
            if (expected.isNullOrBlank()) " (no repository key to check)" else " (matches the repository key)")
        synchronized(sourceLock) {
            if (stopped) throw RequestError("The extension host has stopped", 503)
            try { sources.replace(extension.pkg, extension.sources) { it.id } } catch (error: IllegalArgumentException) { throw RequestError(error.message ?: "Source collision", 409) }
            // A reload creates fresh tokens even when an extension reuses its numeric ID
            // (or even a source object). Late callbacks hold their retired token.
            sourceOwners.keys.retainAll(sources.values.map { it.id }.toSet())
            extension.sources.forEach { sourceOwners[it.id] = Any() }
            mangaMemo.retainOwners { id, owner -> sourceOwners[id] === owner }
            chapterMemo.retainOwners { id, owner -> sourceOwners[id] === owner }
        }
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

    private fun mangasPage(result: MangasPage, session: SourceSession): JsonElement {
        return buildJsonObject {
            put("hasNextPage", result.hasNextPage)
            put("mangas", buildJsonArray { result.mangas.forEach { add(manga(session, it)) } })
        }
    }

    private fun memoOf(manga: SManga): JsonObject? = runCatching { manga.memo }.getOrNull()?.takeIf { it.isNotEmpty() }

    private fun memoPut(cache: BoundedOwnerMemo<JsonObject>, session: SourceSession, url: String, value: JsonObject) {
        synchronized(sourceLock) {
            if (!stopped && sourceOwners[session.source.id] === session.owner) {
                cache.put(session.source.id, session.owner, url, value)
            }
        }
    }

    private fun memoGet(cache: BoundedOwnerMemo<JsonObject>, session: SourceSession, url: String): JsonObject? =
        synchronized(sourceLock) {
            if (stopped || sourceOwners[session.source.id] !== session.owner) null
            else cache.get(session.source.id, session.owner, url)
        }

    private fun manga(session: SourceSession, manga: SManga): JsonObject {
        memoOf(manga)?.let { memoPut(mangaMemo, session, manga.url, it) }
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

    private fun chapter(session: SourceSession, chapter: SChapter): JsonObject {
        runCatching { chapter.memo }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { memoPut(chapterMemo, session, chapter.url, it) }
        return buildJsonObject {
            put("url", chapter.url)
            put("name", chapter.name)
            put("number", chapter.chapter_number.toString())
            put("date", chapter.date_upload)
            put("scanlator", chapter.scanlator)
        }
    }

    private fun mangaOf(session: SourceSession, request: JsonObject): SManga {
        val url = request.need("url")
        return SManga.create().apply {
            this.url = url
            title = request.text("title") ?: ""
            memoGet(mangaMemo, session, url)?.let { runCatching { memo = it } }
        }
    }

    private fun chapterOf(session: SourceSession, request: JsonObject): SChapter {
        val url = request.need("url")
        return SChapter.create().apply {
            this.url = url
            name = request.text("name") ?: ""
            memoGet(chapterMemo, session, url)?.let { runCatching { memo = it } }
        }
    }

    // A page's image through the source's own client (some sources unscramble images there).
    private suspend fun image(request: JsonObject): JsonElement {
        val source = source(request).source as? HttpSource ?: throw RequestError("This source has no images to fetch")
        val page = Page(request["index"]?.jsonPrimitive?.intOrNull ?: 0, request.text("url") ?: "", request.text("imageUrl")?.takeIf { it.isNotEmpty() })
        if (page.imageUrl == null) page.imageUrl = source.getImageUrl(page)
        source.getImage(page).use { response ->
            val body = response.body
            if (body.contentLength() > MAX_IMAGE_BYTES) throw RequestError("The image is too large", 502)
            // Content-Length is optional and may be false. Stop reading before accepting
            // an unbounded response body (including chunked and transparently decoded ones).
            val bytes = body.byteStream().use { it.readAtMost((MAX_IMAGE_BYTES + 1).toInt()) }
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
        if (VerifyActivity.open) throw RequestError("Finish the site verification before trying again", 409, "check-open")
        val method = (request.text("method") ?: "GET").uppercase()
        val maxBytes = (request["maxBytes"]?.jsonPrimitive?.longOrNull ?: (8L * 1024 * 1024)).coerceIn(1, MAX_IMAGE_BYTES)
        val builder = Request.Builder().url(url)
        var contentType: String? = null
        (request["headers"] as? JsonObject)?.forEach { (name, value) ->
            val text = (value as? JsonPrimitive)?.contentOrNull ?: return@forEach
            when {
                // OkHttp decompresses only what it asked for itself.
                name.equals("Accept-Encoding", ignoreCase = true) || name.equals("Content-Length", ignoreCase = true) || name.equals("User-Agent", ignoreCase = true) -> {}
                name.equals("Content-Type", ignoreCase = true) -> contentType = text
                else -> builder.header(name, text)
            }
        }
        // Clearance cookies are tied to the browser's user agent. Ignore a Node caller's
        // default agent so both this request and the Verify WebView use the same one.
        builder.header("User-Agent", Injekt.get<NetworkHelper>().defaultUserAgentProvider())
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
        if (VerifyActivity.open) throw RequestError("Finish the site verification before trying again", 409, "check-open")
        // The extension client and the Verify WebView already use the same CookieManager.
        // Fetching this URL here would initiate another Cloudflare check before the cookies
        // could be handed back to the extension, even when the user just passed it.
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
        // A cookie read from the shared WebView jar is already installed with its original
        // domain/path. Re-applying an inferred host-only copy could replace its scope.
        val missing = list.filter { text ->
            val cookie = okhttp3.Cookie.parse(url, text)
            cookie != null && network.cookieJar.value(url, cookie.name) != cookie.value
        }
        val added = network.cookieJar.add(url, missing)
        request.text("userAgent")?.let { network.setUserAgent(it) }
        return buildJsonObject { put("added", added) }
    }
}

/** Small synchronized LRU for source-owned extension payloads; never retain unbounded JSON. */
internal class BoundedOwnerMemo<V : Any>(
    private val maxEntries: Int = 512,
    private val maxWeight: Long = 4L * 1024 * 1024,
    private val ttlMs: Long = 20L * 60 * 1000,
    private val clockMs: () -> Long = { System.nanoTime() / 1_000_000L },
    private val weightOf: (String, V) -> Long,
) {
    private data class Key(val id: Long, val url: String)
    private class Entry<V>(val owner: Any, val value: V, val weight: Long, var lastUsedAt: Long)
    private val values = LinkedHashMap<Key, Entry<V>>(16, 0.75f, true)
    private var retainedWeight = 0L

    private fun expire(now: Long) {
        val iterator = values.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next().value
            if (now - entry.lastUsedAt >= ttlMs) {
                retainedWeight -= entry.weight
                iterator.remove()
            }
        }
    }

    @Synchronized
    fun get(id: Long, owner: Any, url: String): V? {
        expire(clockMs())
        val entry = values[Key(id, url)] ?: return null
        if (entry.owner !== owner) return null
        entry.lastUsedAt = clockMs()
        return entry.value
    }

    @Synchronized
    fun put(id: Long, owner: Any, url: String, value: V) {
        val now = clockMs()
        expire(now)
        val key = Key(id, url)
        values.remove(key)?.let { retainedWeight -= it.weight }
        val weight = weightOf(url, value)
        if (maxEntries <= 0 || weight <= 0L || weight > maxWeight) return
        while (values.size >= maxEntries || retainedWeight > maxWeight - weight) {
            val eldest = values.entries.iterator()
            if (!eldest.hasNext()) break
            val entry = eldest.next().value
            retainedWeight -= entry.weight
            eldest.remove()
        }
        values[key] = Entry(owner, value, weight, now)
        retainedWeight += weight
    }

    @Synchronized
    fun retainOwners(isCurrent: (Long, Any) -> Boolean) {
        val iterator = values.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (!isCurrent(entry.key.id, entry.value.owner)) {
                retainedWeight -= entry.value.weight
                iterator.remove()
            }
        }
    }

    @Synchronized
    fun clear() {
        values.clear()
        retainedWeight = 0L
    }

    @Synchronized
    fun count(): Int {
        expire(clockMs())
        return values.size
    }

    @Synchronized
    fun weight(): Long {
        expire(clockMs())
        return retainedWeight
    }
}
