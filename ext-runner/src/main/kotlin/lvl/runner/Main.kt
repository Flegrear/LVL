package lvl.runner

// LVL's extension runner. LVL starts it as a child process and
// talks to it over stdin/stdout, one JSON object per line; nothing listens on a port.
//   request:  {"id":1,"op":"search","source":"123","query":"Frieren","page":1}
//   answer:   {"id":1,"result":{…}}   or   {"id":1,"error":"…","status":404}
// The first line it writes is {"ready":true,"version":1}. Everything else an
// extension or a library prints goes to stderr, so stdout carries only answers.
// Ops: load, sources, search, popular, latest, details, chapters, pages, image, cookies.

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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
import java.util.concurrent.ConcurrentHashMap

const val PROTOCOL_VERSION = 1
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
    private val sources = ConcurrentHashMap<Long, CatalogueSource>()

    // Extensions on library 1.6 keep data in a manga's or chapter's memo between calls.
    private val mangaMemo = ConcurrentHashMap<String, JsonObject>()
    private val chapterMemo = ConcurrentHashMap<String, JsonObject>()

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
        write(buildJsonObject { put("ready", true); put("version", PROTOCOL_VERSION) })
    }

    fun serve(input: BufferedReader) {
        while (true) {
            val line = input.readLine() ?: break
            if (line.isBlank()) continue
            scope.launch { permits.withPermit { answer(line) } }
        }
    }

    private fun write(message: JsonObject) {
        val text = message.toString()
        synchronized(out) {
            out.println(text)
            out.flush()
        }
    }

    private suspend fun answer(line: String) {
        var id: JsonElement = JsonNull
        try {
            val request = json.parseToJsonElement(line).jsonObject
            id = request["id"] ?: JsonNull
            val result = handle(request)
            write(buildJsonObject { put("id", id); put("result", result) })
        } catch (error: Throwable) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: error::class.java.simpleName
            val check = message.contains(eu.kanade.tachiyomi.network.interceptor.BROWSER_CHECK_MARK)
            val status = if (check) 403 else (error as? RequestError)?.status ?: (error as? HttpException)?.code ?: 502
            // The extension's code doesn't link or verify here (a broken or unusual build).
            val code = error is LinkageError || error is ClassNotFoundException
            System.err.println("[runner] ${error::class.java.name}: $message")
            write(buildJsonObject {
                put("id", id)
                put("error", message.replace(eu.kanade.tachiyomi.network.interceptor.BROWSER_CHECK_MARK, "").trim().take(500))
                put("status", status)
                if (check) put("code", "blocked") else if (code) put("code", "extension-code")
            })
        }
    }

    private fun JsonObject.text(name: String): String? = this[name]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.need(name: String): String = text(name)?.takeIf { it.isNotEmpty() } ?: throw RequestError("Missing $name")

    private fun source(request: JsonObject): CatalogueSource {
        val id = request.need("source").toLongOrNull() ?: throw RequestError("Invalid source id")
        return sources[id] ?: throw RequestError("This source isn't loaded", 404)
    }

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
            else -> throw RequestError("Unknown op")
        }

    private fun page(request: JsonObject): Int = request["page"]?.jsonPrimitive?.intOrNull?.coerceIn(1, 500) ?: 1

    private fun load(request: JsonObject): JsonElement {
        val apk = File(request.need("apk"))
        val extension = Extensions.load(apk, File(dataDir, "jars"))
        extension.sources.forEach { sources[it.id] = it }
        return buildJsonObject {
            put("pkg", extension.pkg)
            put("version", extension.versionName)
            put("lib", extension.libVersion)
            put("nsfw", extension.nsfw)
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

    private fun mangasPage(
        result: MangasPage,
        request: JsonObject,
    ): JsonElement {
        val source = source(request)
        return buildJsonObject {
            put("hasNextPage", result.hasNextPage)
            put("mangas", buildJsonArray { result.mangas.forEach { add(manga(source, it)) } })
        }
    }

    private fun memoOf(manga: SManga): JsonObject? = runCatching { manga.memo }.getOrNull()?.takeIf { it.isNotEmpty() }

    private fun manga(
        source: CatalogueSource,
        manga: SManga,
    ): JsonObject {
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

    private fun chapter(
        source: CatalogueSource,
        chapter: SChapter,
    ): JsonObject {
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

    private fun chapterOf(
        source: CatalogueSource,
        request: JsonObject,
    ): SChapter {
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
    // LVL closed stdin: it's done with the runner.
    kotlin.system.exitProcess(0)
}
