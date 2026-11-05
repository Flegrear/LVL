package io.github.flegrear.lvl.comics

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Bundle
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceFactory
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

class LoadedExtension(
    val pkg: String,
    val versionName: String,
    val libVersion: Double,
    val nsfw: Boolean,
    val signer: String,
    val sources: List<CatalogueSource>,
)

/**
 * Loads Mihon/Tachiyomi extension APKs into the app, as Mihon does with private
 * extensions: the APK runs as built (no conversion). Each file is copied once into the
 * app's private storage and made read-only, which Android 14+ requires for loaded code, and
 * loaded only after its manifest and signature are checked.
 */
object ExtensionLoader {
    private const val FEATURE = "tachiyomi.extension"
    private const val META_CLASS = "tachiyomi.extension.class"
    private const val META_NSFW = "tachiyomi.extension.nsfw"
    // The same range as the desktop extension runner.
    const val LIB_VERSION_MIN = 1.3
    const val LIB_VERSION_MAX = 1.6

    private val loaded = ConcurrentHashMap<String, LoadedExtension>()

    /** [expectedSigner]: the repository's signing-key fingerprint (SHA-256, hex), when known. */
    fun load(context: Context, apk: File, expectedSigner: String?): LoadedExtension {
        require(apk.isFile) { "The extension file is missing" }
        val digest = sha256(apk.readBytes())
        loaded[digest]?.let { cached ->
            checkSigner(cached.signer, expectedSigner)
            return cached
        }

        val dir = File(context.filesDir, "ext-host/apks").apply { mkdirs() }
        val copy = File(dir, "$digest.apk")
        if (!copy.isFile) {
            val partial = File(dir, "$digest.part")
            apk.copyTo(partial, overwrite = true)
            check(partial.renameTo(copy)) { "Couldn't store the extension file" }
        }
        copy.setReadOnly()

        val flags = PackageManager.GET_META_DATA or PackageManager.GET_CONFIGURATIONS or PackageManager.GET_SIGNING_CERTIFICATES
        val info = context.packageManager.getPackageArchiveInfo(copy.absolutePath, PackageManager.PackageInfoFlags.of(flags.toLong()))
            ?: throw IllegalArgumentException("This file isn't an Android package")
        val app = info.applicationInfo ?: throw IllegalArgumentException("This file has no application")
        app.sourceDir = copy.absolutePath
        app.publicSourceDir = copy.absolutePath
        require(info.reqFeatures.orEmpty().any { it.name == FEATURE }) { "This file is not a Mihon/Tachiyomi extension" }
        val versionName = info.versionName.orEmpty()
        val libVersion = versionName.substringBeforeLast('.').toDoubleOrNull() ?: 0.0
        require(libVersion in LIB_VERSION_MIN..LIB_VERSION_MAX) {
            "This extension uses library $libVersion; LVL supports $LIB_VERSION_MIN to $LIB_VERSION_MAX"
        }
        val signers = signersOf(info)
        require(signers.isNotEmpty()) { "The extension isn't signed" }
        val signer = expectedSigner?.lowercase()?.takeIf { it in signers } ?: signers.first()
        checkSigner(signer, expectedSigner)

        val meta = app.metaData ?: Bundle.EMPTY
        val nsfw = meta.getInt(META_NSFW, 0) == 1
        val classes = meta.getString(META_CLASS).orEmpty().split(';').map { it.trim() }.filter { it.isNotEmpty() }
            .map { if (it.startsWith('.')) info.packageName + it else it }
        require(classes.isNotEmpty()) { "The extension names no source class" }

        val classLoader = ChildFirstPathClassLoader(copy.absolutePath, null, context.classLoader)
        val sources = classes.flatMap { name ->
            when (val instance = Class.forName(name, false, classLoader).getDeclaredConstructor().newInstance()) {
                is Source -> listOf(instance)
                is SourceFactory -> instance.createSources()
                else -> throw IllegalArgumentException("$name is not a source")
            }
        }.filterIsInstance<CatalogueSource>()
        require(sources.isNotEmpty()) { "The extension has no source LVL can use" }

        val extension = LoadedExtension(info.packageName, versionName, libVersion, nsfw, signer, sources)
        loaded[digest] = extension
        return extension
    }

    private fun checkSigner(actual: String, expected: String?) {
        if (expected.isNullOrBlank()) return
        require(actual.equals(expected, ignoreCase = true)) {
            "The extension isn't signed by its repository's key"
        }
    }

    // SHA-256 of each signing certificate, current and past (key rotation), as hex.
    private fun signersOf(info: PackageInfo): List<String> {
        val signing = info.signingInfo ?: return emptyList()
        val certificates = if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
        return certificates.orEmpty().map { sha256(it.toByteArray()) }.distinct()
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
