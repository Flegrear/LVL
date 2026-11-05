package io.github.flegrear.lvl

import android.content.Context
import android.util.Log
import android.os.SystemClock
import java.io.BufferedInputStream
import java.io.File
import java.util.zip.ZipInputStream

/**
 * LVL's server files ship as one zip in the APK's assets. Node can't read inside the APK,
 * so they are unpacked to filesDir/app once, and again whenever the staged zip changes
 * (the manifest next to it carries the zip's SHA-256 and LVL's version).
 *
 * In-app updates (updates/AppUpdater.kt) build the new version in filesDir/app.next and swap
 * it in while the server is stopped: app becomes app.old until the new version has started,
 * and comes back if it doesn't.
 */
object AppFiles {
    private const val TAG = "LVL-AppFiles"
    private const val MARKER = ".lvl-app-sha256"
    const val READY_MARKER = ".lvl-update-ready"

    fun dir(context: Context) = File(context.filesDir, "app")
    private fun next(context: Context) = File(context.filesDir, "app.next")
    private fun old(context: Context) = File(context.filesDir, "app.old")
    private fun failed(context: Context) = File(context.filesDir, "app.failed")

    private fun startup(event: String) {
        Log.i("LVL-Startup", "event=$event t_ms=${SystemClock.elapsedRealtime()}")
    }

    fun ensure(context: Context, onProgress: (String) -> Unit = {}): File {
        val target = dir(context)
        val staged = stagedManifest(context)
        val marker = File(target, MARKER)
        if (marker.isFile && marker.readText().trim() == staged.sha256) {
            startup("app_cache_hit")
            return target
        }

        // An in-app update installed a newer version than this APK carries: keep it. Patches
        // only reach Android when the app around LVL's files didn't change, so any APK between
        // the one it was patched on and that version has the same app around it.
        val installed = installedVersion(context)
        // The Android 0.1.0 release intentionally starts a new version train below the
        // older synthetic 0.2.x APKs. They lack this generation marker; replace their
        // *app code* once, leaving filesDir/lvl-data and all user settings untouched.
        val sameRuntimeGeneration = File(target, ".lvl-android-runtime-generation").takeIf { it.isFile }
            ?.readText()?.trim() == staged.runtimeGeneration
        if (installed != null && sameRuntimeGeneration && compareVersions(installed, staged.version) > 0 &&
            File(target, "server.js").isFile) {
            Log.i(TAG, "Keeping LVL $installed (this APK carries ${staged.version})")
            marker.writeText(staged.sha256)
            startup("app_newer_version_kept")
            return target
        }

        onProgress("Preparing LVL…")
        startup("app_zip_unpack_start")
        val incoming = File(context.filesDir, "app.incoming")
        incoming.deleteRecursively()
        incoming.mkdirs()
        val root = incoming.canonicalPath + File.separator
        var count = 0
        ZipInputStream(BufferedInputStream(context.assets.open("lvl-app.zip"), 1 shl 16)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val out = File(incoming, entry.name)
                // Never write outside the target folder, whatever the zip says.
                check(out.canonicalPath.startsWith(root)) { "Unsafe path in lvl-app.zip: ${entry.name}" }
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { zip.copyTo(it, 1 shl 16) }
                    count += 1
                    if (count % 500 == 0) onProgress("Preparing LVL… $count files")
                }
            }
        }
        File(incoming, MARKER).writeText(staged.sha256)
        target.deleteRecursively()
        check(incoming.renameTo(target)) { "Couldn't move the unpacked files into place" }
        startup("app_zip_unpack_done")
        return target
    }

    /** LVL's version in the app folder (it changes with in-app updates), or null. */
    fun installedVersion(context: Context): String? = runCatching {
        Regex("\"version\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"").find(File(dir(context), "package.json").readText())?.groupValues?.get(1)
    }.getOrNull()

    /**
     * After the app process ended in the middle of a swap: put a complete folder back in place.
     * Run once when the app starts, before the server; app.old is left for [confirmUpdate].
     */
    fun recoverInterrupted(context: Context) {
        val target = dir(context)
        if (!target.exists()) {
            val ready = File(next(context), READY_MARKER).isFile
            when {
                ready && next(context).renameTo(target) -> Log.i(TAG, "Finished an interrupted update")
                old(context).isDirectory && old(context).renameTo(target) -> Log.i(TAG, "Restored the previous version after an interrupted update")
            }
        }
        next(context).takeIf { it.exists() }?.deleteRecursively()
        failed(context).takeIf { it.exists() }?.deleteRecursively()
    }

    /** Swaps a prepared update in (the server must be stopped). False if nothing was swapped. */
    fun swapInUpdate(context: Context): Boolean {
        val target = dir(context)
        val prepared = next(context)
        if (!File(prepared, READY_MARKER).isFile) return false
        old(context).deleteRecursively()
        if (!target.renameTo(old(context))) return false
        if (!prepared.renameTo(target)) {
            old(context).renameTo(target)
            return false
        }
        File(target, READY_MARKER).delete()
        return true
    }

    /** True while a swapped-in update hasn't started yet (the previous version is kept). */
    fun updatePending(context: Context) = old(context).isDirectory

    /** The new version started: the previous one isn't needed any more. */
    fun confirmUpdate(context: Context) {
        val previous = old(context)
        if (previous.exists()) {
            previous.deleteRecursively()
            Log.i(TAG, "LVL ${installedVersion(context)} started; removed the previous version")
        }
    }

    /** The new version didn't start: put the previous one back. Returns the version restored. */
    fun rollBackUpdate(context: Context): String? {
        val previous = old(context)
        if (!previous.isDirectory) return null
        val target = dir(context)
        failed(context).deleteRecursively()
        if (target.exists() && !target.renameTo(failed(context))) target.deleteRecursively()
        if (!previous.renameTo(target)) return null
        failed(context).deleteRecursively()
        return installedVersion(context)
    }

    data class Staged(val version: String, val sha256: String, val runtimeGeneration: String?)

    fun stagedManifest(context: Context): Staged {
        val manifest = context.assets.open("lvl-app.json").bufferedReader().use { it.readText() }
        val sha = Regex("\"sha256\"\\s*:\\s*\"([0-9a-f]{64})\"").find(manifest)?.groupValues?.get(1)
            ?: error("lvl-app.json has no sha256")
        val version = Regex("\"version\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"").find(manifest)?.groupValues?.get(1)
            ?: error("lvl-app.json has no version")
        val generation = Regex("\"runtimeGeneration\"\\s*:\\s*\"([^\"]+)\"").find(manifest)?.groupValues?.get(1)
        return Staged(version, sha, generation)
    }

    /** Compares x.y.z versions part by part as numbers (0.1.13 is newer than 0.1.2). */
    fun compareVersions(left: String, right: String): Int {
        val a = left.split(".").map { it.toIntOrNull() ?: 0 }
        val b = right.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(a.size, b.size)) {
            val diff = (a.getOrElse(i) { 0 }).compareTo(b.getOrElse(i) { 0 })
            if (diff != 0) return diff
        }
        return 0
    }
}
