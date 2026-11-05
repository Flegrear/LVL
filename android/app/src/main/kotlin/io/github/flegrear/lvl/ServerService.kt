package io.github.flegrear.lvl

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import io.github.flegrear.lvl.comics.ExtensionHost
import io.github.flegrear.lvl.updates.AppUpdater
import java.io.File
import java.security.SecureRandom
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Runs LVL's server (`node server.js`) while the app is in use. Node, ffmpeg and ffprobe are
 * executables packed as lib*_exec.so, which Android extracts to the native library folder:
 * the only place an app may run its own programs.
 */
class ServerService : Service(), AppUpdater.Server {
    companion object {
        const val PORT = 4273
        private const val CHANNEL = "server"
        private const val ACTION_STOP = "io.github.flegrear.lvl.STOP"
        private const val MAX_LINES = 300

        @Volatile var state: String = "Starting…"
            private set
        @Volatile var running: Boolean = false
            private set
        private val lines = ArrayDeque<String>()
        private val readinessLock = Object()
        private var readinessSerial = 0L

        private fun startup(event: String) {
            Log.i("LVL-Startup", "event=$event t_ms=${SystemClock.elapsedRealtime()}")
        }

        fun readinessRevision(): Long = synchronized(readinessLock) { readinessSerial }

        fun awaitReadinessAfter(revision: Long, timeoutMs: Long) {
            synchronized(readinessLock) {
                if (readinessSerial == revision) readinessLock.wait(timeoutMs)
            }
        }

        private fun signalReadiness() {
            synchronized(readinessLock) {
                readinessSerial += 1
                readinessLock.notifyAll()
            }
        }

        fun logTail(count: Int = 40): String = synchronized(lines) { lines.takeLast(count).joinToString("\n") }

        /**
         * The key LVL's server asks for on every request (android-preload.cjs): new for each
         * launch, known only to this app; the WebView gets it as an HttpOnly cookie.
         */
        val accessToken: String by lazy {
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        }

        fun start(context: Context) {
            context.startForegroundService(Intent(context, ServerService::class.java))
        }
    }

    private var process: Process? = null
    @Volatile private var starting = false
    private val lifecycle = Any()
    private var serverThread: Thread? = null
    private var recovered = false
    private var replacing = false
    private val extensionHost by lazy { ExtensionHost(this) }
    val updater by lazy { AppUpdater(this, this) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startup("service_create")
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "LVL server", NotificationManager.IMPORTANCE_LOW))
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startup("service_start_command")
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        launchServer()
        return START_STICKY
    }

    override fun onDestroy() {
        process?.destroy()
        runCatching { extensionHost.stop() }
        runCatching { updater.stop() }
        running = false
        state = "Stopped"
        signalReadiness()
        super.onDestroy()
    }

    private fun launchServer() {
        synchronized(lifecycle) {
            if (replacing || process?.isAlive == true || starting) return
            starting = true
            state = "Starting the server…"
            serverThread = thread(name = "lvl-server") { runServer() }
        }
    }

    // LVL's server stops when its input ends (it runs as with the Windows launcher), and is
    // asked harder only if it doesn't.
    private fun stopServer(): Boolean {
        val (current, worker) = synchronized(lifecycle) { process to serverThread }
        if (current != null) {
            runCatching { current.outputStream.close() }
            if (!current.waitFor(15, TimeUnit.SECONDS)) {
                current.destroy()
                if (!current.waitFor(5, TimeUnit.SECONDS)) current.destroyForcibly().waitFor(5, TimeUnit.SECONDS)
            }
        }
        if (worker != Thread.currentThread()) worker?.join(10_000)
        // An update must never swap app files while either Node or its startup/exit
        // worker can still be using them. The worker itself may call this in recovery.
        return synchronized(lifecycle) {
            process?.isAlive != true &&
                (worker == Thread.currentThread() || (serverThread?.isAlive != true && !starting))
        }
    }

    private fun restoreFailedUpdate(): Boolean {
        if (!AppFiles.updatePending(this)) return false
        val failureState = state
        state = "Restoring the previous version…"
        val restored = runCatching { AppFiles.rollBackUpdate(this) }
            .onFailure { Log.e("LVL-Server", "Couldn't restore the previous version", it) }
            .getOrNull()
        if (restored == null) {
            state = failureState
            return false
        }
        Log.w("LVL-Server", "Updated server didn't start; restored $restored")
        runCatching { updater.onRolledBack(restored) }
            .onFailure { Log.e("LVL-Server", "Couldn't notify the updater about rollback", it) }
        // The activity is waiting for a usable server; don't report a terminal failure
        // while the restored version is about to launch.
        return true
    }

    // AppUpdater.Server
    override fun restart(change: () -> Unit) {
        synchronized(lifecycle) {
            check(!replacing) { "An update is already restarting the server" }
            replacing = true
            state = "Updating LVL…"
        }
        try {
            check(stopServer()) { "The server hasn't stopped; the update wasn't installed" }
            change()
        } finally {
            synchronized(lifecycle) { replacing = false }
            launchServer() // Won't start another Node while the previous child is alive.
        }
    }

    override fun runNode(args: List<String>, timeoutMs: Long): Pair<Int, String> {
        val node = File(applicationInfo.nativeLibraryDir, "libnode_exec.so")
        val child = ProcessBuilder(listOf(node.path) + args).directory(AppFiles.dir(this)).redirectErrorStream(true)
            .apply { environment().apply { put("HOME", filesDir.path); put("TMPDIR", File(filesDir, "tmp").apply { mkdirs() }.path) } }
            .start()
        child.outputStream.close()
        val output = StringBuilder()
        val reader = thread(name = "lvl-update-node") {
            child.inputStream.bufferedReader().forEachLine { line -> synchronized(output) { if (output.length < 64_000) output.appendLine(line) } }
        }
        if (!child.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
            child.destroyForcibly()
            return -1 to "The update step took too long"
        }
        reader.join(2000)
        return child.exitValue() to synchronized(output) { output.toString() }
    }

    private fun runServer() {
        var relaunch = false
        var listening = false
        var ownedProcess: Process? = null
        var terminalState: String? = null
        startup("server_run_begin")
        try {
            // Once per app start: finish or undo a swap the app was closed in the middle of.
            if (!recovered) {
                AppFiles.recoverInterrupted(this)
                recovered = true
            }
            startup("app_recovery_done")
            val appDir = AppFiles.ensure(this) { state = it }
            startup("app_files_ready")
            state = "Starting the server…"
            val nativeDir = File(applicationInfo.nativeLibraryDir)
            val node = File(nativeDir, "libnode_exec.so")
            check(node.isFile) { "This build has no Node for ${android.os.Build.SUPPORTED_ABIS.firstOrNull()}" }
            val dataDir = File(filesDir, "lvl-data").apply { mkdirs() }
            // Not the cache folder: Android may clear it while a video plays.
            val tmpDir = File(filesDir, "tmp").apply { mkdirs() }
            val logFile = File(filesDir, "logs/server.log").apply { parentFile?.mkdirs() }

            // Debug builds only: extra Node flags from files/debug-node-args.txt (one per line, such
            // as --prof), for profiling the server on a test phone. Release builds never read it.
            val debuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
            val debugArgs = if (debuggable) {
                runCatching { File(filesDir, "debug-node-args.txt").readLines().map { it.trim() }.filter { it.startsWith("--") } }.getOrDefault(emptyList())
            } else emptyList()
            val builder = ProcessBuilder(listOf(node.path) + debugArgs + listOf("--require", "./android-preload.cjs", "server.js"))
                .directory(appDir).redirectErrorStream(true)
            // Comics extensions run in this app; the server reaches them through this socket.
            val hostSocket = runCatching { extensionHost.start() }
                .onFailure { Log.e("LVL-Server", "The Comics extension host didn't start", it) }
                .getOrNull()
            // Updates: the server talks to this app as it talks to the Windows launcher.
            val updateBridge = runCatching { updater.bridge.start() }
                .onFailure { Log.e("LVL-Server", "The update bridge didn't start", it) }
                .getOrNull()
            builder.environment().apply {
                hostSocket?.let { put("LVL_EXT_HOST_SOCKET", it.absolutePath) }
                updateBridge?.let {
                    put("LANGUAGE_VIDEO_LEARNER_LAUNCHER", "1")
                    put("LANGUAGE_VIDEO_LEARNER_UPDATE_BRIDGE", it)
                }
                put("LVL_ACCESS_TOKEN", accessToken)
                put("PORT", PORT.toString())
                put("LANGUAGE_VIDEO_LEARNER_DATA_ROOT", dataDir.path)
                put("TMPDIR", tmpDir.path)
                put("HOME", filesDir.path)
                put("TZ", TimeZone.getDefault().id)
                File(nativeDir, "libffmpeg_exec.so").takeIf { it.isFile }?.let { put("FFMPEG_BIN", it.path) }
                File(nativeDir, "libffprobe_exec.so").takeIf { it.isFile }?.let { put("FFPROBE_BIN", it.path) }
            }
            val started = builder.start()
            ownedProcess = started
            synchronized(lifecycle) {
                process = started
                running = true
            }
            startup("node_spawned")
            state = "Server running"
            logFile.bufferedWriter().use { log ->
                started.inputStream.bufferedReader().forEachLine { line ->
                    synchronized(lines) {
                        lines.addLast(line)
                        while (lines.size > MAX_LINES) lines.removeFirst()
                    }
                    log.appendLine(line)
                    log.flush()
                    Log.i("LVL-Server", line)
                    if (!listening && line.startsWith("LVL running at")) {
                        listening = true
                        startup("server_listening")
                        signalReadiness()
                        // A swapped-in update started: the previous version isn't needed any more.
                        AppFiles.confirmUpdate(this)
                        updater.onServerStarted()
                    }
                }
            }
            val code = started.waitFor()
            // An update that doesn't start goes back to the version before it.
            if (!listening) relaunch = restoreFailedUpdate()
            if (!relaunch) terminalState = "The server stopped (exit $code)"
        } catch (error: Throwable) {
            Log.e("LVL-Server", "start failed", error)
            val child = ownedProcess
            if (child?.isAlive == true) {
                state = "Stopping the failed server…"
                runCatching { stopServer() }
                    .onFailure { Log.e("LVL-Server", "Couldn't stop the failed server", it) }
                if (child.isAlive) {
                    // Keep the exact child handle and worker ownership until it dies.
                    // This is the existing dedicated Node worker, never the UI thread.
                    state = "Waiting for the failed server to exit…"
                    Log.e("LVL-Server", "The failed server is still alive; keeping its update files")
                    while (child.isAlive) {
                        try { child.waitFor() } catch (_: InterruptedException) {
                            // A signal cannot make it safe to swap a live child's files.
                        }
                    }
                }
            }
            // ProcessBuilder failures and malformed staged assets also need rollback,
            // but only after the failed child has actually exited.
            if (!listening) relaunch = restoreFailedUpdate()
            if (!relaunch) terminalState = "The server couldn't start: ${error.message}"
        } finally {
            synchronized(lifecycle) {
                if (serverThread === Thread.currentThread()) {
                    // An older worker may never erase a newer worker's process handle.
                    if (process === ownedProcess && ownedProcess?.isAlive != true) process = null
                    running = process?.isAlive == true
                    starting = process?.isAlive == true
                    // Publish a terminal failure only once rollback is ruled out.
                    // During an intentional update stop, restart() owns the state.
                    if (!relaunch && !replacing && terminalState != null) state = terminalState
                }
            }
            signalReadiness()
        }
        if (relaunch) launchServer()
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, ServerService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_lvl)
            .setContentTitle("LVL is running")
            .setContentText("Your library and player are ready")
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .setOngoing(true)
            .build()
    }
}
