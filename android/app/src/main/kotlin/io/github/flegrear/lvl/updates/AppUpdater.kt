package io.github.flegrear.lvl.updates

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.github.flegrear.lvl.AppFiles
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * LVL's updates in the Android app, answering LVL's server like the Windows launcher does
 * (status, settings, check, install; see backend/app-updates/update-policy.js). The server
 * decides when to check and when to install; this class finds, downloads and installs:
 * - a patch: android/update-apply.mjs builds the new version in app.next, then the server
 *   restarts on it (ServerService rolls back if it doesn't start);
 * - a new APK: Android's installer, which asks the user to confirm, so it never installs
 *   automatically (autoInstall: false).
 */
class AppUpdater(private val context: Context, private val server: Server) {
    interface Server {
        /** Runs Node in the app folder with these arguments: exit code and output. */
        fun runNode(args: List<String>, timeoutMs: Long): Pair<Int, String>
        /** Stops LVL's server, runs [change] while it is stopped, and starts it again. */
        fun restart(change: () -> Unit)
    }

    companion object {
        private const val TAG = "LVL-Updates"
        private const val MAX_PATCH = 256L * 1024 * 1024
        private const val MAX_APK = 400L * 1024 * 1024
        private const val AUTO_RETRY_MS = 6 * 60 * 60_000L
        private const val CONFIRM_WAIT_MS = 15 * 60_000L
    }

    private val lock = Any()
    private val work = Executors.newSingleThreadExecutor { Thread(it, "lvl-updates").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private val settingsFile = File(context.filesDir, "update-settings.json")
    private val http = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
    private val feed: ReleaseFeed = debugFeed() ?: ReleaseFeed(http)
    val bridge = UpdateBridge(::handle)

    private var automatic = false
    private var lastCheckedAt: String? = null
    private var failedVersion: String? = null
    private var failedAt = 0L
    private var available: Release? = null
    private var checking = false
    private var downloading = false
    private var installing: String? = null
    private var pendingApkSessionId: Int? = null
    private var pendingApkVersion: String? = null
    /** Keep a terminal APK error visible through background availability checks. */
    private var terminalApkFailureVersion: String? = null
    private var error: String? = null
    private var noticePending = false
    private var bytes = 0L

    init {
        load()
        ApkInstall.onResult = ::onApkResult
    }

    fun installedVersion(): String = AppFiles.installedVersion(context) ?: AppFiles.stagedManifest(context).version

    // Debug builds can read a local release feed (android/tools/update-feed.mjs), named in
    // filesDir/debug-update-feed.txt; release builds always use GitHub.
    private fun debugFeed(): ReleaseFeed? {
        if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return null
        val base = runCatching { File(context.filesDir, "debug-update-feed.txt").readText().trim() }.getOrNull() ?: return null
        if (!Regex("^http://127\\.0\\.0\\.1:\\d{2,5}/$").matches(base)) return null
        Log.w(TAG, "Using the local release feed at $base")
        return ReleaseFeed(http, "${base}releases", "${base}download/")
    }

    private fun abi(): String = when (val name = File(context.applicationInfo.nativeLibraryDir).name) {
        "arm64", "arm64-v8a" -> "arm64"
        else -> name
    }

    fun handle(command: JsonObject): JsonElement = when (command["action"]?.jsonPrimitive?.contentOrNull) {
        "status" -> status()
        "settings" -> {
            val wanted = command["automatic"]?.jsonPrimitive?.booleanOrNull
            val days = command["intervalDays"]?.jsonPrimitive?.intOrNull
            if (wanted == null || days !in setOf(1, 7, 30)) failure("Invalid update preferences")
            else {
                val turnedOn = synchronized(lock) { (!automatic && wanted).also { automatic = wanted; save() } }
                if (turnedOn) startCheck(false)
                status()
            }
        }
        "check" -> { startCheck(command["apply"]?.jsonPrimitive?.booleanOrNull == true); status() }
        "install" -> if (startInstall(auto = command["auto"]?.jsonPrimitive?.booleanOrNull == true,
                source = if (command["auto"]?.jsonPrimitive?.booleanOrNull == true) "bridge-auto" else "bridge-install")) status()
            else failure("No verified LVL update is ready, or an update is already in progress")
        else -> failure("Unknown updater action")
    }

    private fun failure(message: String) = buildJsonObject { put("error", message) }

    fun status(): JsonObject = synchronized(lock) {
        val next = available
        buildJsonObject {
            put("installed", true)
            put("enabled", true)
            put("automatic", automatic)
            put("intervalDays", 1)
            put("lastCheckedAt", lastCheckedAt)
            put("installedVersion", installedVersion())
            put("available", next != null)
            put("availableVersion", next?.version)
            put("checking", checking)
            put("downloading", downloading)
            put("error", error)
            put("notice", next?.let { buildJsonObject { put("message", "LVL ${it.version} is available") } } ?: JsonNull)
            put("noticePending", noticePending)
            if (next != null) {
                put("availableSize", buildJsonObject { put("bytes", next.size); put("kind", if (next.patch) "patch" else "installer") })
                put("autoInstall", next.patch)
            }
            if (downloading && next != null) {
                put("download", buildJsonObject {
                    put("bytes", bytes)
                    if (next.size > 0) put("total", next.size) else put("total", JsonNull)
                    put("kind", if (next.patch) "patch" else "installer")
                })
            }
        }
    }

    private fun startCheck(apply: Boolean) {
        synchronized(lock) {
            if (checking || downloading) return
            checking = true
            if (terminalApkFailureVersion == null) error = null
        }
        work.execute {
            val found = runCatching { feed.find(installedVersion(), abi()) }
            synchronized(lock) {
                checking = false
                lastCheckedAt = Instant.now().toString()
                found.onSuccess { release ->
                    if (release != null && release.version != available?.version) noticePending = true
                    if (terminalApkFailureVersion != null && release?.version != terminalApkFailureVersion) {
                        terminalApkFailureVersion = null
                        error = null
                    }
                    available = release
                }.onFailure {
                    if (terminalApkFailureVersion == null) error = it.message ?: "The update check failed"
                    else Log.w(TAG, "Update check failed while prior APK error is retained", it)
                }
                save()
            }
            found.getOrNull()?.let { Log.i(TAG, "LVL ${it.version} is available (${if (it.patch) "patch" else "app"} ${it.asset})") }
            if (apply && found.getOrNull() != null) startInstall(auto = false, source = "check-apply")
        }
    }

    private fun startInstall(auto: Boolean, source: String): Boolean {
        val release = synchronized(lock) {
            val release = available ?: return false
            if (checking || downloading || installing != null || pendingApkSessionId != null) return false
            // A new app version asks the user to confirm, so it waits for Install.
            if (auto && !release.patch) return false
            if (auto && release.version == failedVersion && System.currentTimeMillis() - failedAt < AUTO_RETRY_MS) return false
            downloading = true
            error = null
            terminalApkFailureVersion = null
            bytes = 0
            noticePending = false
            release
        }
        Log.i(TAG, "Accepted LVL ${release.version} update request, source=$source, kind=${if (release.patch) "patch" else "apk"}")
        work.execute { downloadAndInstall(release) }
        return true
    }

    private fun downloadAndInstall(release: Release) {
        // Inside TMPDIR, so LVL's server can also see the download (update-policy.js).
        val folder = File(context.filesDir, "tmp/LVL-update-" + UUID.randomUUID().toString().replace("-", ""))
        try {
            folder.mkdirs()
            val expected = ReleaseFeed.sha256For(feed.readSums(release), release.asset)
                ?: throw IOException("The release has no checksum for ${release.asset}")
            val file = File(folder, release.asset)
            feed.download(release, file, if (release.patch) MAX_PATCH else MAX_APK) { done -> synchronized(lock) { bytes = done } }
            if (ReleaseFeed.sha256(file) != expected) throw IOException("The download didn't match the release checksum")
            if (release.patch) installPatch(release, file, expected) else installApk(release, file)
        } catch (failure: Exception) {
            Log.w(TAG, "Update to ${release.version} failed", failure)
            synchronized(lock) {
                error = failure.message ?: "The update failed"
                if (!release.patch) terminalApkFailureVersion = release.version
                downloading = false
                installing = null
                pendingApkSessionId = null
                pendingApkVersion = null
            }
        } finally {
            // Only this invocation's uniquely named updater download is ours.
            // Never clear other app caches, media, or historical QA profiles.
            if (folder.exists() && !folder.deleteRecursively())
                Log.w(TAG, "Could not fully remove LVL ${release.version}'s temporary update download")
        }
    }

    private fun installPatch(release: Release, zip: File, sha256: String) {
        val app = AppFiles.dir(context)
        val (code, output) = server.runNode(listOf(
            "android/update-apply.mjs", "--app", app.path, "--next", File(context.filesDir, "app.next").path,
            "--zip", zip.path, "--zip-sha256", sha256, "--from", installedVersion(), "--to", release.version,
        ), timeoutMs = 180_000)
        val result = output.lineSequence().mapNotNull { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() }.lastOrNull()
        if (code != 0 || result?.get("ok")?.jsonPrimitive?.booleanOrNull != true) {
            throw IOException(result?.get("error")?.jsonPrimitive?.contentOrNull ?: "The update couldn't be prepared (exit $code)")
        }
        Log.i(TAG, "Prepared LVL ${release.version}: $result")
        // The window sees the download end, then the server goes away while it restarts.
        synchronized(lock) {
            downloading = false
            installing = release.version
        }
        Thread.sleep(1500)
        server.restart { if (!AppFiles.swapInUpdate(context)) throw IOException("The new version couldn't be put in place") }
    }

    private fun installApk(release: Release, apk: File) {
        val manager = context.packageManager
        val info = manager.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)
            ?: throw IOException("The download isn't an Android app")
        if (info.packageName != context.packageName) throw IOException("The download is another app (${info.packageName})")
        val installedCode = manager.getPackageInfo(context.packageName, 0).longVersionCode
        if (info.longVersionCode <= installedCode) throw IOException("The download isn't newer than this app")
        val ours = manager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
        val theirs = info.signingInfo
        val signers = { signing: android.content.pm.SigningInfo? ->
            ((signing?.apkContentsSigners ?: emptyArray()) + (signing?.signingCertificateHistory ?: emptyArray())).map { it.toCharsString() }.toSet()
        }
        if (signers(ours).intersect(signers(theirs)).isEmpty()) throw IOException("The download isn't signed with LVL's key")
        synchronized(lock) { bytes = release.size }
        val measuredFree = ApkInstall.availableBytes(context)
        Log.i(TAG, "APK install preflight for LVL ${release.version}: apkBytes=${apk.length()}, dataAvailableBytes=$measuredFree; Android installation overhead is unknown")
        if (measuredFree != null && measuredFree < apk.length()) {
            throw IOException("There isn't enough space to stage this APK (APK ${apk.length()} bytes, /data available $measuredFree bytes); Android may require more")
        }
        ApkInstall.install(context, apk) { id ->
            synchronized(lock) {
                pendingApkSessionId = id
                pendingApkVersion = release.version
            }
        }
        Log.i(TAG, "Handed LVL ${release.version} to Android's installer, session=${synchronized(lock) { pendingApkSessionId }}")
        // The result comes from Android (onApkResult); stop waiting if it never does.
        val expectedSession = synchronized(lock) { pendingApkSessionId }
        main.postDelayed({
            synchronized(lock) {
                if (downloading && expectedSession != null && pendingApkSessionId == expectedSession) {
                    downloading = false
                    error = "The update wasn't confirmed"
                    terminalApkFailureVersion = release.version
                    pendingApkSessionId = null
                    pendingApkVersion = null
                }
            }
        }, CONFIRM_WAIT_MS)
    }

    private fun onApkResult(sessionId: Int, installed: Boolean, message: String?) {
        synchronized(lock) {
            if (sessionId < 0 || sessionId != pendingApkSessionId) {
                Log.w(TAG, "Ignored unrelated/stale APK install result for session $sessionId")
                return
            }
            val version = pendingApkVersion
            Log.i(TAG, "LVL ${version ?: "APK"} install session $sessionId completed: ${if (installed) "success" else "failure"}")
            pendingApkSessionId = null
            pendingApkVersion = null
            downloading = false
            error = if (installed) null else message ?: "Android couldn't install the update"
            terminalApkFailureVersion = if (installed) null else version
        }
    }

    /** ServerService: the server is listening. After an update, its version is now installed. */
    fun onServerStarted() {
        synchronized(lock) {
            val version = installing ?: return
            if (installedVersion() == version) {
                Log.i(TAG, "LVL $version is installed")
                available = null
                error = null
            }
            installing = null
        }
    }

    /** ServerService: the updated version didn't start, so the previous one is back. */
    fun onRolledBack(restored: String?) {
        synchronized(lock) {
            val version = installing ?: available?.version ?: "The update"
            error = "LVL $version didn't start, so LVL went back to ${restored ?: "the previous version"}."
            failedVersion = version
            failedAt = System.currentTimeMillis()
            installing = null
            save()
        }
    }

    private fun load() {
        val saved = runCatching { Json.parseToJsonElement(settingsFile.readText()) as JsonObject }.getOrNull() ?: return
        automatic = saved["automatic"]?.jsonPrimitive?.booleanOrNull ?: false
        lastCheckedAt = saved["lastCheckedAt"]?.jsonPrimitive?.contentOrNull
        failedVersion = saved["failedVersion"]?.jsonPrimitive?.contentOrNull
        failedAt = saved["failedAt"]?.jsonPrimitive?.longOrNull ?: 0L
    }

    private fun save() {
        runCatching {
            val temp = File(settingsFile.path + ".tmp")
            temp.writeText(buildJsonObject {
                put("automatic", automatic)
                put("lastCheckedAt", lastCheckedAt)
                put("failedVersion", failedVersion)
                put("failedAt", failedAt)
            }.toString())
            check(temp.renameTo(settingsFile)) { "rename failed" }
        }.onFailure { Log.w(TAG, "Couldn't save the update settings", it) }
    }

    fun stop() {
        bridge.stop()
        work.shutdownNow()
    }
}
