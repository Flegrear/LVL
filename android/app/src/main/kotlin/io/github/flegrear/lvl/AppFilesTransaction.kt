package io.github.flegrear.lvl

import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.nio.file.Files
import java.nio.file.FileVisitResult
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.Locale
import java.util.zip.ZipInputStream
import org.json.JSONObject

/**
 * Disk-only part of APK extraction and update swaps. No Android process state or user-data
 * directory is owned here. A failed rename always leaves the previous runnable directory
 * either at app or at its dedicated backup path.
 */
internal object AppFilesTransaction {
    private const val CRITICAL_SEAL = ".lvl-app-critical-sha256"
    private const val MAX_ENTRIES = 50_000
    private const val MAX_MEMBER_BYTES = 256L * 1024 * 1024
    private const val MAX_TOTAL_BYTES = 768L * 1024 * 1024
    private val versionPattern = Regex("^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)$")
    private val readyFrom = Regex("\"from\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"")
    private val readyTo = Regex("\"to\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"")

    private fun ordinaryFile(file: File): Boolean =
        file.isFile && !Files.isSymbolicLink(file.toPath())

    fun version(root: File): String? = runCatching {
        val packageFile = File(root, "package.json")
        if (!ordinaryFile(packageFile) || packageFile.length() !in 1L..65536L) return@runCatching null
        val decoded = JSONObject(packageFile.readText()).opt("version") as? String
        decoded?.takeIf { versionPattern.matches(it) }
    }.getOrNull()

    fun runnable(root: File, expectedGeneration: String? = null, expectedVersion: String? = null): Boolean {
        if (!root.isDirectory || Files.isSymbolicLink(root.toPath())) return false
        if (version(root) == null || (expectedVersion != null && version(root) != expectedVersion)) return false
        for (name in listOf("server.js", "android-preload.cjs")) {
            val entry = File(root, name)
            if (!ordinaryFile(entry) || entry.length() <= 0) return false
        }
        if (expectedGeneration != null) {
            val generation = File(root, ".lvl-android-runtime-generation")
            if (!ordinaryFile(generation) || generation.length() !in 1L..128L ||
                runCatching { generation.readText().trim() }.getOrNull() != expectedGeneration) return false
        }
        return true
    }

    /**
     * The staged ZIP carries one whole-archive SHA, not per-file hashes. Seal the
     * actual critical files on verified extraction, then reject later silent edits
     * even if the whole-archive marker was left behind.
     */
    private fun criticalDigest(root: File): String? = runCatching {
        val digest = MessageDigest.getInstance("SHA-256")
        for (name in listOf("server.js", "package.json", "android-preload.cjs", ".lvl-android-runtime-generation")) {
            val file = File(root, name)
            if (!ordinaryFile(file) || file.length() !in 1L..(32L * 1024 * 1024)) return@runCatching null
            digest.update(name.toByteArray(Charsets.UTF_8))
            digest.update(0.toByte())
            file.inputStream().buffered().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    }.getOrNull()

    fun sealCritical(root: File) {
        val fingerprint = criticalDigest(root) ?: error("Missing critical staged application files")
        File(root, CRITICAL_SEAL).writeText(fingerprint)
    }

    fun criticalVerified(root: File): Boolean {
        val seal = File(root, CRITICAL_SEAL)
        return ordinaryFile(seal) && seal.length() == 64L &&
            runCatching { seal.readText() }.getOrNull() == criticalDigest(root)
    }

    private fun archiveName(name: String, directory: Boolean): String {
        val normalized = if (directory) name.removeSuffix("/") else name
        require(normalized.isNotEmpty() && normalized.length <= 512 && !normalized.startsWith("/") &&
            !normalized.contains('\\') && !normalized.contains(':') &&
            normalized.none { it.code < 32 || it.code == 127 }) { "Unsafe ZIP member" }
        val parts = normalized.split("/")
        require(parts.size <= 32 && parts.all { it.isNotEmpty() && it != "." && it != ".." }) {
            "Unsafe ZIP member path"
        }
        return normalized
    }

    /** Copies each member with bounded memory and expansion, rejecting ambiguous names. */
    fun extract(openZip: () -> InputStream, incoming: File, progress: (Int) -> Unit = {}) {
        require(!incoming.exists()) { "Incoming extraction directory already exists" }
        check(incoming.mkdir()) { "Couldn't create incoming extraction directory" }
        val root = incoming.canonicalPath + File.separator
        val seen = HashSet<String>()
        var total = 0L
        var count = 0
        ZipInputStream(openZip().buffered(1 shl 16)).use { zip ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val entry = zip.nextEntry ?: break
                count++
                check(count <= MAX_ENTRIES) { "Too many files in staged ZIP" }
                val path = archiveName(entry.name, entry.isDirectory)
                check(seen.add(path.lowercase(Locale.ROOT))) { "Duplicate staged ZIP member" }
                val destination = File(incoming, path)
                check(destination.canonicalPath.startsWith(root)) { "ZIP member escaped extraction root" }
                if (entry.isDirectory) {
                    check(destination.mkdirs() || destination.isDirectory) { "Couldn't create staged directory" }
                } else {
                    check(destination.parentFile?.mkdirs() == true || destination.parentFile?.isDirectory == true) {
                        "Couldn't create staged parent directory"
                    }
                    var member = 0L
                    destination.outputStream().use { output ->
                        while (true) {
                            val bytes = zip.read(buffer)
                            if (bytes < 0) break
                            member += bytes
                            total += bytes
                            check(member <= MAX_MEMBER_BYTES && total <= MAX_TOTAL_BYTES) {
                                "Staged ZIP exceeds extraction limits"
                            }
                            output.write(buffer, 0, bytes)
                        }
                    }
                    if (count % 500 == 0) progress(count)
                }
                zip.closeEntry()
            }
        }
        check(count > 0) { "Staged ZIP has no entries" }
    }

    /** Delete only code under an exact owned directory; never traverse a linked folder. */
    fun retireOwnedDirectory(folder: File): Boolean {
        if (!folder.exists()) return true
        if (!folder.isDirectory || Files.isSymbolicLink(folder.toPath())) return false
        return runCatching {
            Files.walkFileTree(folder.toPath(), object : SimpleFileVisitor<Path>() {
                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.delete(file) // Files.walkFileTree doesn't follow links by default.
                    return FileVisitResult.CONTINUE
                }
                override fun postVisitDirectory(dir: Path, error: java.io.IOException?): FileVisitResult {
                    if (error != null) throw error
                    Files.delete(dir)
                    return FileVisitResult.CONTINUE
                }
            })
            !folder.exists()
        }.getOrDefault(false)
    }

    /** The backup used here is separate from app.old, which belongs to in-app updates. */
    fun promote(
        incoming: File, target: File, backup: File,
        rename: (File, File) -> Boolean = { from, to -> from.renameTo(to) }
    ): Boolean {
        if (!runnable(incoming)) return false
        if (backup.exists()) {
            // Never replace a backup while it might be the only runnable copy.
            if (!runnable(target) || !retireOwnedDirectory(backup)) return false
        }
        if (target.exists() && !rename(target, backup)) return false
        if (!rename(incoming, target)) {
            if (!target.exists() && backup.isDirectory) rename(backup, target)
            return false
        }
        return true
    }

    /** Recover after a power loss between the two APK extraction renames. */
    fun recoverApk(target: File, backup: File, rename: (File, File) -> Boolean = { a, b -> a.renameTo(b) }) {
        if (!backup.exists()) return
        if (runnable(target)) return // Keep backup until the new copy has passed ensure().
        check(runnable(backup)) { "APK recovery backup isn't a complete runnable app" }
        if (target.exists()) {
            val quarantined = File(target.parentFile, "app.apk-incomplete")
            check(!quarantined.exists() && rename(target, quarantined)) {
                "Couldn't isolate an incomplete app while retaining the runnable backup"
            }
        }
        check(rename(backup, target)) { "Couldn't restore the previous APK app files" }
    }

    fun finishApk(target: File, backup: File, generation: String?, version: String?) {
        if (backup.exists() && runnable(target, generation, version)) {
            check(retireOwnedDirectory(backup)) { "Couldn't retire verified APK extraction backup" }
        }
    }

    /** Requires a complete prepared patch and preserves any existing rollback owner. */
    fun updateReady(prepared: File, current: File): Boolean {
        val marker = File(prepared, AppFiles.READY_MARKER)
        if (!ordinaryFile(marker) || marker.length() !in 1L..8192L ||
            !runnable(prepared) || !runnable(current)) return false
        val body = runCatching { marker.readText() }.getOrNull() ?: return false
        val from = readyFrom.find(body)?.groupValues?.get(1) ?: return false
        val to = readyTo.find(body)?.groupValues?.get(1) ?: return false
        if (version(current) != from || version(prepared) != to ||
            AppFiles.compareVersions(to, from) <= 0) return false
        val currentGeneration = File(current, ".lvl-android-runtime-generation")
        val preparedGeneration = File(prepared, ".lvl-android-runtime-generation")
        if (!ordinaryFile(currentGeneration) || !ordinaryFile(preparedGeneration) ||
            currentGeneration.length() !in 1L..128L || preparedGeneration.length() !in 1L..128L ||
            runCatching { currentGeneration.readBytes().contentEquals(preparedGeneration.readBytes()) }.getOrDefault(false).not()) return false
        return true
    }

    fun swapUpdate(
        current: File, prepared: File, rollback: File,
        rename: (File, File) -> Boolean = { from, to -> from.renameTo(to) }
    ): Boolean {
        if (rollback.exists() || !updateReady(prepared, current)) return false
        if (!rename(current, rollback)) return false
        if (!rename(prepared, current)) {
            if (!current.exists()) rename(rollback, current)
            return false
        }
        File(current, AppFiles.READY_MARKER).delete()
        return true
    }
}
