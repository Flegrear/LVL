package lvl.runner

// LVL's extension runner. LVL starts it as a child process and
// talks to it over stdin/stdout, one JSON object per line; nothing listens on a port.
//   request:  {"id":1,"op":"search","source":"123","query":"Frieren","page":1}
//   answer:   {"id":1,"result":{…}}   or   {"id":1,"error":"…","status":404}
// The first line advertises version 2 with cancelQuiesced=true. Older v1
// request/response frames without generation still work unchanged. For a v2
// frame, id+generation fence targeted cancellation; a positive cancelAck is
// emitted only after the request coroutine completes. It does NOT attest
// that independent extension-managed background threads have stopped.
// Everything else an extension or a library prints goes to stderr, so stdout
// carries only protocol answers. Ops: load, sources, search, popular, latest,
// details, chapters, pages, image, cookies; cancel is a control frame.

import android.app.Application
import eu.kanade.tachiyomi.App
import eu.kanade.tachiyomi.createAppModule
import eu.kanade.tachiyomi.network.HttpException
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.koin.core.context.startKoin
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import xyz.nulldev.androidcompat.AndroidCompat
import xyz.nulldev.androidcompat.androidCompatModule
import xyz.nulldev.androidcompat.config.ApplicationInfoConfigModule
import xyz.nulldev.androidcompat.config.FilesConfigModule
import xyz.nulldev.androidcompat.config.SystemConfigModule
import xyz.nulldev.ts.config.GlobalConfigManager
import xyz.nulldev.ts.config.configManagerModule
import java.io.BufferedReader
import java.io.File
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.PrintStream
import java.security.Security
import java.util.Base64

const val PROTOCOL_VERSION = 2
private const val MAX_IMAGE_BYTES = 40L * 1024 * 1024

class RequestError(
    message: String,
    val status: Int = 400,
) : Exception(message)

class Runner(
    private val dataDir: File,
    private val out: PrintStream,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val permits = Semaphore(8)
    private val replies = EofResponseDrain<JsonElement, JsonObject>({ write(it) })
    private val sources = SourceOwnership<CatalogueSource>()
    private val sourceLock = Any()
    private val loadLock = Any()
    @Volatile private var closing = false
    // Extensions on library 1.6 pass opaque JSON memos across operations.
    // Their lifetime is one committed APK digest + converter revision.
    private val generations = GenerationMemo<CatalogueSource, JsonObject>(
        weightOf = { it.toString().toByteArray(Charsets.UTF_8).size.toLong() },
    )

    private val cancellation = QuiescentCancellation<EofResponseDrain.Ticket<JsonElement>, JsonObject>(
        deliver = { ticket, response, canceled ->
            val epoch = epochs[ticket]
            if (canceled) {
                replies.answer(ticket, buildJsonObject {
                    put("id", ticket.id)
                    put("generation", epoch ?: "")
                    put("cancelAck", true)
                    put("quiesced", true)
                })
            } else {
                replies.answer(ticket, response ?: buildJsonObject {
                    put("id", ticket.id)
                    if (!epoch.isNullOrEmpty()) put("generation", epoch)
                    put("error", "The extension task ended without a result")
                    put("status", 502)
                })
            }
            epochs.remove(ticket)
        },
    )
    private val epochs = java.util.concurrent.ConcurrentHashMap<EofResponseDrain.Ticket<JsonElement>, String>()

    fun start() {
        System.setProperty("suwayomi.tachidesk.config.server.rootDir", File(dataDir, "android").absolutePath)
        Security.addProvider(BouncyCastleProvider())
        val app: Application = App()
        startKoin { modules(createAppModule(app), androidCompatModule(), configManagerModule()) }
        GlobalConfigManager.registerModules(
            FilesConfigModule.register(GlobalConfigManager.config),
            ApplicationInfoConfigModule.register(GlobalConfigManager.config),
            SystemConfigModule.register(GlobalConfigManager.config),
        )
        AndroidCompat().startApp(app)
        System.setProperty("http.agent", Injekt.get<NetworkHelper>().defaultUserAgentProvider())
        write(buildJsonObject { put("ready", true); put("version", PROTOCOL_VERSION); put("cancelQuiesced", true) })
    }

    fun serve(input: BufferedReader) {
        try {
            while (true) {
                val line = input.readLine() ?: break
                if (line.isBlank()) continue
                val request = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull()
                val id = request?.get("id") ?: JsonNull
                val op = runCatching { request?.get("op")?.jsonPrimitive?.contentOrNull }.getOrNull()
                val epoch = runCatching { request?.get("generation")?.jsonPrimitive?.contentOrNull }.getOrNull()
                val numeric = runCatching { id.jsonPrimitive.longOrNull }.getOrNull()
                // Cancellation controls are not normal tickets: they cannot
                // consume the 64-request backlog or cancel another generation.
                if (op == "cancel") {
                    val original = runCatching { request?.get("cancelOf")?.jsonPrimitive?.longOrNull }.getOrNull()
                    val valid = epoch != null && Regex("[A-Fa-f0-9-]{36}").matches(epoch) &&
                        original != null && original > 0L
                    val accepted = valid && cancellation.cancel(epoch + ":" + original)
                    if (!accepted) write(buildJsonObject {
                        put("id", JsonPrimitive(original ?: -1L))
                        put("generation", epoch ?: "")
                        put("cancelAck", true)
                        put("quiesced", false)
                    })
                    continue
                }
                // The v2 consumer fences EVERY response, including overload
                // and duplicate errors, against the exact request generation.
                // A legacy v1 call without a valid generation keeps its
                // original unversioned result/error shape.
                val owner = if (epoch != null && Regex("[A-Fa-f0-9-]{36}").matches(epoch)) epoch else ""
                val ticket = replies.admit(id)
                if (ticket == null) {
                    write(buildJsonObject {
                        put("id", id)
                        if (owner.isNotEmpty()) put("generation", owner)
                        put("error", "Too many outstanding extension requests")
                        put("status", 429)
                    })
                    continue
                }
                // Legacy calls without an epoch retain v1 result semantics, but
                // do not claim they are cancel-capable.
                val identity = owner + ":" + (numeric ?: id.toString())
                val slot = cancellation.admit(identity, ticket)
                if (slot == null) {
                    replies.answer(ticket, buildJsonObject {
                        put("id", id)
                        if (owner.isNotEmpty()) put("generation", owner)
                        put("error", "Duplicate or overloaded extension request identity")
                        put("status", 409)
                    })
                    continue
                }
                epochs[ticket] = owner
                // LAZY registration allows cancel/EOF to own queued tasks before
                // the eight-permit dispatcher runs any extension call.
                val job = scope.launch(start = CoroutineStart.LAZY) {
                    val response = try {
                        permits.withPermit { answer(id, request ?: JsonObject(emptyMap()), owner) }
                    } catch (error: Throwable) {
                        buildJsonObject {
                            put("id", id)
                            if (owner.isNotEmpty()) put("generation", owner)
                            put("error", "Extension request interrupted")
                            put("status", 503)
                        }
                    }
                    slot.result = response
                }
                job.invokeOnCompletion { cancellation.complete(slot) }
                cancellation.bind(slot) { job.cancel() }
                ticket.cancel = { job.cancel() }
                job.start()
            }
        } finally {
            closing = true
            // EOF remains a bounded terminal process retirement protocol.
            val unfinished = replies.finish(15_000L) { ticket ->
                val epoch = epochs.remove(ticket)
                buildJsonObject {
                    put("id", ticket.id)
                    if (!epoch.isNullOrEmpty()) put("generation", epoch)
                    put("error", "Extension runner input closed before completion")
                    put("status", 503)
                    put("code", "runner-closed")
                }
            }
            unfinished.forEach { it.cancel?.invoke() }
            scope.cancel()
            if (unfinished.isEmpty()) synchronized(sourceLock) { generations.shutdown() }
            out.flush()
        }
    }

    private fun write(message: JsonObject) {
        val text = message.toString()
        synchronized(out) {
            out.println(text)
            out.flush()
        }
    }

    private suspend fun answer(id: JsonElement, request: JsonObject, epoch: String): JsonObject {
        return try {
            val result = handle(request)
            buildJsonObject {
                put("id", id)
                if (epoch.isNotEmpty()) put("generation", epoch)
                put("result", result)
            }
        } catch (error: Throwable) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: error::class.java.simpleName
            val browser = message.contains(eu.kanade.tachiyomi.network.interceptor.BROWSER_CHECK_MARK)
            val status = if (browser || error is ApkTrustException) 403 else (error as? RequestError)?.status ?: (error as? HttpException)?.code ?: 502
            val code = error is LinkageError || error is ClassNotFoundException
            System.err.println("[runner] " + error::class.java.name + ": " + message)
            buildJsonObject {
                put("id", id)
                if (epoch.isNotEmpty()) put("generation", epoch)
                put("error", message.replace(eu.kanade.tachiyomi.network.interceptor.BROWSER_CHECK_MARK, "").trim().take(500))
                put("status", status)
                if (browser) put("code", "blocked") else if (error is ApkTrustException) put("code", "extension-trust") else if (code) put("code", "extension-code")
            }
        }
    }

    private fun JsonObject.text(name: String): String? = this[name]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.need(name: String): String = text(name)?.takeIf { it.isNotEmpty() } ?: throw RequestError("Missing $name")

    private fun source(request: JsonObject): GenerationMemo.Lease<CatalogueSource, JsonObject> {
        val id = request.need("source").toLongOrNull() ?: throw RequestError("Invalid source id")
        return synchronized(sourceLock) { generations.acquire(id) } ?: throw RequestError("This source isn't loaded", 404)
    }

    private suspend fun handle(request: JsonObject): JsonElement {
        val op = request.need("op")
        if (op == "load") return load(request)
        if (op == "sources") return synchronized(sourceLock) {
            buildJsonArray { sources.values.forEach { add(describe(it)) } }
        }
        if (op == "cookies") return cookies(request)
        if (op !in setOf("search", "popular", "latest", "details", "chapters", "pages", "image")) throw RequestError("Unknown op")
        val session = source(request)
        try {
            val source = session.source
            return when (op) {
            "search" -> mangasPage(source.getSearchManga(page(request), request.text("query") ?: "", FilterList()), session)
            "popular" -> mangasPage(source.getPopularManga(page(request)), session)
            "latest" -> mangasPage(source.getLatestUpdates(page(request)), session)
            "details" -> {
                manga(session, source.getMangaUpdate(mangaOf(session, request), emptyList(), fetchDetails = true, fetchChapters = false).manga)
            }
            "chapters" -> {
                val chapters = source.getMangaUpdate(mangaOf(session, request), emptyList(), fetchDetails = false, fetchChapters = true).chapters
                buildJsonArray { chapters.forEach { add(chapter(session, it)) } }
            }
            "pages" -> {
                val pages = source.getPageList(chapterOf(session, request))
                buildJsonArray {
                    pages.forEach { page ->
                        add(buildJsonObject { put("index", page.index); put("url", page.url); put("imageUrl", page.imageUrl) })
                    }
                }
            }
            "image" -> image(source, request)
            else -> throw RequestError("Unknown op")
            }
        } finally {
            session.close()
        }
    }

    private fun page(request: JsonObject): Int = request["page"]?.jsonPrimitive?.intOrNull?.coerceIn(1, 500) ?: 1

    private fun load(request: JsonObject): JsonElement {
        val (extension, descriptions) = synchronized(loadLock) {
            if (closing) throw RequestError("The runner is shutting down", 503)
            val apk = File(request.need("apk"))
            val pkg = request.need("packageName")
            val old = Extensions.active(pkg)
            val extension = Extensions.load(apk, File(dataDir, "jars"), pkg, request.need("fingerprint"))
            try {
                // Extension-supplied getters may throw. Evaluate every description
                // before the first visible source/memo ownership change.
                val descriptions = buildJsonArray { extension.sources.forEach { add(describe(it)) } }
                synchronized(sourceLock) {
                    if (closing) throw RequestError("The runner is shutting down", 503)
                    // Requests acquire under the same lock: handlers and memos commit together.
                    val validated = sources.replace(extension.pkg, extension.sources) { it.id }
                    generations.commit(extension.pkg, extension.jar, validated) { extension.retire() }
                    Extensions.committed(extension)
                }
                extension to descriptions
            } catch (error: Throwable) {
                if (extension !== old) extension.retire()
                if (error is IllegalArgumentException) throw RequestError(error.message ?: "Source collision", 409)
                throw error
            }
        }
        // The response now touches only validated immutable values.
        return buildJsonObject {
            put("pkg", extension.pkg)
            put("version", extension.versionName)
            put("lib", extension.libVersion)
            put("nsfw", extension.nsfw)
            put("sources", descriptions)
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

    private fun mangasPage(
        result: MangasPage,
        session: GenerationMemo.Lease<CatalogueSource, JsonObject>,
    ): JsonElement {
        return buildJsonObject {
            put("hasNextPage", result.hasNextPage)
            put("mangas", buildJsonArray { result.mangas.forEach { add(manga(session, it)) } })
        }
    }

    private fun memoOf(manga: SManga): JsonObject? = runCatching { manga.memo }.getOrNull()?.takeIf { it.isNotEmpty() }

    private fun manga(
        session: GenerationMemo.Lease<CatalogueSource, JsonObject>,
        manga: SManga,
    ): JsonObject {
        memoOf(manga)?.let { session.saveManga(manga.url, it) }
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

    private fun chapter(
        session: GenerationMemo.Lease<CatalogueSource, JsonObject>,
        chapter: SChapter,
    ): JsonObject {
        runCatching { chapter.memo }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { session.saveChapter(chapter.url, it) }
        return buildJsonObject {
            put("url", chapter.url)
            put("name", chapter.name)
            put("number", chapter.chapter_number.toString())
            put("date", chapter.date_upload)
            put("scanlator", chapter.scanlator)
        }
    }

    private fun mangaOf(session: GenerationMemo.Lease<CatalogueSource, JsonObject>, request: JsonObject): SManga {
        val url = request.need("url")
        return SManga.create().apply {
            this.url = url
            title = request.text("title") ?: ""
            session.manga(url)?.let { runCatching { memo = it } }
        }
    }

    private fun chapterOf(
        session: GenerationMemo.Lease<CatalogueSource, JsonObject>,
        request: JsonObject,
    ): SChapter {
        val url = request.need("url")
        return SChapter.create().apply {
            this.url = url
            name = request.text("name") ?: ""
            session.chapter(url)?.let { runCatching { memo = it } }
        }
    }

    // A page's image through the source's own client (some sources unscramble images there).
    private suspend fun image(activeSource: CatalogueSource, request: JsonObject): JsonElement {
        val source = activeSource as? HttpSource ?: throw RequestError("This source has no images to fetch")
        val page = Page(request["index"]?.jsonPrimitive?.intOrNull ?: 0, request.text("url") ?: "", request.text("imageUrl")?.takeIf { it.isNotEmpty() })
        if (page.imageUrl == null) page.imageUrl = source.getImageUrl(page)
        source.getImage(page).use { response ->
            val body = response.body
            val length = body.contentLength()
            if (length > MAX_IMAGE_BYTES) throw RequestError("The image is too large", 502)
            val bytes = body.bytes()
            if (bytes.size > MAX_IMAGE_BYTES) throw RequestError("The image is too large", 502)
            return buildJsonObject {
                put("type", body.contentType()?.toString() ?: "application/octet-stream")
                put("imageUrl", page.imageUrl)
                put("data", Base64.getEncoder().encodeToString(bytes))
            }
        }
    }

    // Cookies from LVL's browser check (Cloudflare and the like), and its user agent.
    private fun cookies(request: JsonObject): JsonElement {
        val url = request.need("url").toHttpUrl()
        val network = Injekt.get<NetworkHelper>()
        val list =
            (request["cookies"] as? kotlinx.serialization.json.JsonArray).orEmpty()
                .mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                .mapNotNull { Cookie.parse(url, it) }
        network.cookieStore.addAll(url, list)
        request.text("userAgent")?.let { network.setUserAgent(it) }
        return buildJsonObject { put("added", list.size) }
    }
}

fun main(args: Array<String>) {
    val dataAt = args.indexOf("--data")
    val dataDir = File(if (dataAt >= 0 && dataAt + 1 < args.size) args[dataAt + 1] else "lvl-ext-runner-data").absoluteFile
    dataDir.mkdirs()
    // The protocol owns stdout; anything else printed goes to stderr.
    val out = PrintStream(FileOutputStream(FileDescriptor.out), true, Charsets.UTF_8)
    System.setOut(System.err)
    val runner = Runner(dataDir, out)
    runner.start()
    runner.serve(BufferedReader(InputStreamReader(System.`in`, Charsets.UTF_8)))
    // All accepted requests have finished or received an EOF cancellation.
    // Remaining uncooperative extension code runs only in this worker process.
    kotlin.system.exitProcess(0)
}
