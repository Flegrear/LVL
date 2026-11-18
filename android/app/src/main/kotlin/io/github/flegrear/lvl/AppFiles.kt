package io.github.flegrear.lvl

import android.content.Context
import android.util.Log
import android.os.SystemClock
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

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
    private fun apkBackup(context: Context) = File(context.filesDir, "app.apk-previous")

    private fun startup(event: String) {
        Log.i("LVL-Startup", "event=$event t_ms=${SystemClock.elapsedRealtime()}")
    }

    fun ensure(context: Context, onProgress: (String) -> Unit = {}): File {
        val target = dir(context)
        val staged = stagedManifest(context)
        val marker = File(target, MARKER)
        if (marker.isFile && marker.readText().trim() == staged.sha256) {
            val version = AppFilesTransaction.version(target)
            if (AppFilesTransaction.runnable(target, staged.runtimeGeneration) &&
                version != null &&
                (version == staged.version && AppFilesTransaction.criticalVerified(target) ||
                    compareVersions(version, staged.version) > 0)) {
                AppFilesTransaction.finishApk(target, apkBackup(context), staged.runtimeGeneration, version)
                startup("app_cache_hit")
                return target
            }
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
            AppFilesTransaction.runnable(target, staged.runtimeGeneration, installed)) {
            Log.i(TAG, "Keeping LVL $installed (this APK carries ${staged.version})")
            marker.writeText(staged.sha256)
            AppFilesTransaction.finishApk(target, apkBackup(context), staged.runtimeGeneration, installed)
            startup("app_newer_version_kept")
            return target
        }

        // An unconfirmed patch owns app.old. Do not replace its live target while
        // ServerService may still need the old copy to roll the patch back.
        check(!old(context).exists()) { "Pending LVL update must be resolved before APK extraction" }
        onProgress("Preparing LVL…")
        startup("app_zip_unpack_start")
        val incoming = File(context.filesDir, "app.incoming")
        val reusable = incoming.isDirectory &&
            File(incoming, MARKER).takeIf { it.isFile }?.readText()?.trim() == staged.sha256 &&
            AppFilesTransaction.runnable(incoming, staged.runtimeGeneration, staged.version) &&
            AppFilesTransaction.criticalVerified(incoming)
        if (!reusable) {
            if (incoming.exists()) {
                // app.incoming is exclusively an APK extraction scratch directory.
                // An interrupted first installation has no older server; it must
                // still be able to retry from the verified packaged ZIP.
                check(incoming.isDirectory && !Files.isSymbolicLink(incoming.toPath())) {
                    "Unexpected incoming extraction path"
                }
                check(AppFilesTransaction.retireOwnedDirectory(incoming)) { "Couldn't remove incomplete extraction" }
            }
            val digest = MessageDigest.getInstance("SHA-256")
            var compressedBytes = 0L
            context.assets.open("lvl-app.zip").buffered().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val size = input.read(buffer)
                    if (size < 0) break
                    compressedBytes += size
                    check(compressedBytes <= 256L * 1024 * 1024) { "Staged ZIP exceeds compressed size limit" }
                    digest.update(buffer, 0, size)
                }
            }
            val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
            check(compressedBytes > 0 && actualSha == staged.sha256) { "Staged ZIP doesn't match its manifest" }
            AppFilesTransaction.extract({ context.assets.open("lvl-app.zip") }, incoming) { count ->
                onProgress("Preparing LVL… $count files")
            }
            check(AppFilesTransaction.runnable(incoming, staged.runtimeGeneration, staged.version)) {
                "Staged LVL has no complete matching server/runtime"
            }
            AppFilesTransaction.sealCritical(incoming)
            File(incoming, MARKER).writeText(staged.sha256)
        }
        if (target.exists()) {
            check(AppFilesTransaction.promote(incoming, target, apkBackup(context))) {
                "Couldn't replace the app; previous runnable copy retained for recovery"
            }
        } else {
            check(incoming.renameTo(target)) { "Couldn't move the unpacked files into place" }
        }
        check(AppFilesTransaction.runnable(target, staged.runtimeGeneration, staged.version)) {
            "Staged LVL failed verification after rename"
        }
        AppFilesTransaction.finishApk(target, apkBackup(context), staged.runtimeGeneration, staged.version)
        startup("app_zip_unpack_done")
        return target
    }

    /** LVL's version in the app folder (it changes with in-app updates), or null. */
    fun installedVersion(context: Context): String? = AppFilesTransaction.version(dir(context))

    /**
     * After the app process ended in the middle of a swap: put a complete folder back in place.
     * Run once when the app starts, before the server; app.old is left for [confirmUpdate].
     */
    fun recoverInterrupted(context: Context) {
        val target = dir(context)
        AppFilesTransaction.recoverApk(target, apkBackup(context))
        if (!AppFilesTransaction.runnable(target) && AppFilesTransaction.runnable(old(context))) {
            if (target.exists()) {
                val quarantined = File(context.filesDir, "app.update-incomplete")
                check(!quarantined.exists() && target.renameTo(quarantined)) {
                    "Couldn't isolate incomplete update before restoring previous version"
                }
            }
            check(old(context).renameTo(target)) { "Couldn't restore previous version after interrupted update" }
            Log.i(TAG, "Restored the previous version after an interrupted update")
        }
        // app.next may be an intact verified patch that the installer can retry;
        // app.failed may hold the only copy of a failed launch. Neither is ours
        // to discard during ordinary startup.
    }

    /** Swaps a prepared update in (the server must be stopped). False if nothing was swapped. */
    fun swapInUpdate(context: Context): Boolean {
        return AppFilesTransaction.swapUpdate(dir(context), next(context), old(context))
    }

    /** True while a swapped-in update hasn't started yet (the previous version is kept). */
    fun updatePending(context: Context) = old(context).isDirectory

    /** The new version started: the previous one isn't needed any more. */
    fun confirmUpdate(context: Context) {
        val previous = old(context)
        if (previous.exists() && AppFilesTransaction.runnable(dir(context)) &&
            AppFilesTransaction.runnable(previous) &&
            compareVersions(installedVersion(context) ?: "0.0.0",
                AppFilesTransaction.version(previous) ?: "0.0.0") > 0) {
            check(AppFilesTransaction.retireOwnedDirectory(previous)) {
                "Couldn't retire confirmed update rollback"
            }
            Log.i(TAG, "LVL ${installedVersion(context)} started; removed the previous version")
        }
    }

    /** The new version didn't start: put the previous one back. Returns the version restored. */
    fun rollBackUpdate(context: Context): String? {
        val previous = old(context)
        if (!AppFilesTransaction.runnable(previous)) return null
        val target = dir(context)
        // Previous failed launches are retained. Each failed update owns a fresh
        // quarantine name; one older app.failed must never block recovery.
        val displaced = if (failed(context).exists()) {
            File(context.filesDir, "app.failed-" + UUID.randomUUID().toString())
        } else failed(context)
        if (target.exists() && (displaced.exists() || !target.renameTo(displaced))) return null
        if (!previous.renameTo(target)) {
            if (!target.exists() && displaced.exists()) displaced.renameTo(target)
            return null
        }
        return installedVersion(context)
    }

    data class Staged(val version: String, val sha256: String, val runtimeGeneration: String?)

    fun stagedManifest(context: Context): Staged {
        val manifest = context.assets.open("lvl-app.json").bufferedReader().use { reader ->
            val result = StringBuilder()
            val block = CharArray(2048)
            while (true) {
                val length = reader.read(block)
                if (length < 0) break
                check(result.length + length <= 8192) { "Staged manifest exceeds size limit" }
                result.append(block, 0, length)
            }
            result.toString()
        }
        check(manifest.length in 2..8192) { "Invalid staged manifest length" }
        val json = JSONObject(manifest)
        val allowed = setOf("version", "versionCode", "runtimeGeneration", "sha256",
            "stagedAt", "testVersionOverride")
        val actualKeys = json.keys().asSequence().toSet()
        check(actualKeys.all { it in allowed } && actualKeys.containsAll(
            setOf("version", "runtimeGeneration", "sha256"))) { "Unexpected staged manifest fields" }
        check(json.opt("sha256") is String && json.opt("version") is String &&
            json.opt("runtimeGeneration") is String) { "Incomplete staged manifest" }
        val sha = json.getString("sha256")
        val version = json.getString("version")
        val generation = json.getString("runtimeGeneration")
        check(Regex("^[0-9a-f]{64}$").matches(sha) &&
            Regex("^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)$").matches(version) &&
            generation.length in 1..128 && Regex("^[a-zA-Z0-9._-]+$").matches(generation)) {
            "Invalid staged manifest identity"
        }
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
