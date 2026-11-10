package lvl.runner

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Adapted for LVL's extension runner from Suwayomi's
// PackageTools.kt and Extension.kt: an extension APK becomes a jar once (dex2jar,
// Android class fixes, the APK's assets), then its sources are loaded from it.
// No database: the jar is kept per package and version in the runner's data folder.

import com.googlecode.d2j.dex.Dex2jar
import com.googlecode.d2j.reader.MultiDexFileReader
import com.googlecode.dex2jar.tools.BaksmaliBaseDexExceptionHandler
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceFactory
import net.dongliu.apk.parser.ApkFile
import org.w3c.dom.Element
import suwayomi.tachidesk.manga.impl.util.BytecodeEditor
import suwayomi.tachidesk.manga.impl.util.ChildFirstURLClassLoader
import java.io.File
import java.net.URLClassLoader
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import javax.xml.parsers.DocumentBuilderFactory

class LoadedExtension(
    val pkg: String,
    val versionName: String,
    val libVersion: Double,
    val nsfw: Boolean,
    val sources: List<CatalogueSource>,
    // The converted jar: a re-published APK with the same version makes another one.
    val jar: String = "",
)

object Extensions {
    private const val EXTENSION_FEATURE = "tachiyomi.extension"
    private const val METADATA_SOURCE_CLASS = "tachiyomi.extension.class"
    private const val METADATA_NSFW = "tachiyomi.extension.nsfw"
    private const val METADATA_CONTENT_WARNING = "tachiyomix.contentWarning"
    // Raise when the APK -> jar conversion changes, so cached jars are made again (3: FrameRepair).
    private const val CONVERSION_REVISION = 4
    const val LIB_VERSION_MIN = 1.3
    const val LIB_VERSION_MAX = 1.6

    private val loaders = ConcurrentHashMap<String, URLClassLoader>()
    private val loaded = ConcurrentHashMap<String, LoadedExtension>()

    private class Manifest(
        val pkg: String,
        val versionName: String,
        val features: Set<String>,
        val meta: Map<String, String>,
    )

    // The package, version, features and <meta-data> of the APK's manifest.
    private fun readManifest(apk: File): Manifest =
        ApkFile(apk).use { parsed ->
            val info = parsed.apkMeta
            val doc =
                DocumentBuilderFactory
                    .newInstance()
                    .newDocumentBuilder()
                    .parse(parsed.manifestXml.byteInputStream())
            val meta = mutableMapOf<String, String>()
            val nodes = doc.getElementsByTagName("meta-data")
            for (index in 0 until nodes.length) {
                val node = nodes.item(index) as? Element ?: continue
                val name = node.getAttribute("android:name")
                if (name.isNotEmpty()) meta[name] = node.getAttribute("android:value")
            }
            Manifest(info.packageName, info.versionName, info.usesFeatures.mapNotNull { it.name }.toSet(), meta)
        }

    // dex2jar, as Suwayomi's PackageTools.dex2jar, then the Android class fixes.
    private fun dex2jar(
        apk: File,
        jar: Path,
    ) {
        // R8's inlined constructors are repaired before conversion (InlinedConstructors.kt).
        val reader = InlinedConstructorReader(MultiDexFileReader.open(apk.readBytes()))
        val handler = BaksmaliBaseDexExceptionHandler()
        Dex2jar
            .from(reader)
            .withExceptionHandler(handler)
            .reUseReg(false)
            .topoLogicalSort()
            .skipDebug(true)
            .optimizeSynchronized(false)
            .printIR(false)
            .noCode(false)
            .skipExceptions(false)
            .dontSanitizeNames(true)
            .computeFrames(true)
            .to(jar)
        if (handler.hasException()) throw IllegalStateException("dex2jar couldn't convert this extension")
        BytecodeEditor.fixAndroidClasses(jar)
        // dex2jar's frames can say Object where the verifier needs a common superclass (FrameRepair.kt).
        try {
            FrameRepair.recompute(jar)
        } catch (error: Throwable) {
            System.err.println("FrameRepair: skipped: $error")
        }
    }

    // The converted classes plus the APK's assets/ (extensions read their translations there).
    private fun withAssets(
        classes: Path,
        apk: File,
        target: Path,
    ) {
        ZipOutputStream(Files.newOutputStream(target)).use { out ->
            val seen = HashSet<String>()
            ZipFile(classes.toFile()).use { zip ->
                for (entry in zip.entries()) {
                    if (entry.isDirectory || entry.name.startsWith("META-INF/") || !seen.add(entry.name)) continue
                    out.putNextEntry(ZipEntry(entry.name))
                    zip.getInputStream(entry).use { it.copyTo(out) }
                    out.closeEntry()
                }
            }
            ZipFile(apk).use { zip ->
                for (entry in zip.entries()) {
                    if (entry.isDirectory || !entry.name.startsWith("assets/") || !seen.add(entry.name)) continue
                    out.putNextEntry(ZipEntry(entry.name))
                    zip.getInputStream(entry).use { it.copyTo(out) }
                    out.closeEntry()
                }
            }
        }
    }

    private fun jarFor(
        apk: File,
        manifest: Manifest,
        jarDir: File,
    ): Path {
        jarDir.mkdirs()
        val safe = Regex("[^A-Za-z0-9._-]")
        // A repository can re-publish an extension under the same version, and the
        // conversion itself improves (CONVERSION_REVISION): both make a new jar.
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(apk.readBytes())
        val stamp = digest.joinToString("") { "%02x".format(it.toInt() and 0xff) } + "-r$CONVERSION_REVISION"
        val jar = File(jarDir, "${manifest.pkg.replace(safe, "_")}-v${manifest.versionName.replace(safe, "_")}-$stamp.jar").toPath()
        if (Files.exists(jar)) return jar
        val classes = Files.createTempFile(jarDir.toPath(), "classes-", ".jar")
        val joined = Files.createTempFile(jarDir.toPath(), "joined-", ".jar")
        try {
            Files.deleteIfExists(classes)
            dex2jar(apk, classes)
            withAssets(classes, apk, joined)
            Files.move(joined, jar, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } finally {
            Files.deleteIfExists(classes)
            Files.deleteIfExists(joined)
        }
        // Older versions of this package; a jar Windows still holds open stays until the next start.
        jarDir.listFiles { file -> file.name.startsWith("${manifest.pkg.replace(safe, "_")}-v") && file.toPath() != jar }?.forEach { it.delete() }
        return jar
    }

    fun load(
        apk: File,
        jarDir: File,
        expectedPackage: String,
        expectedFingerprint: String,
    ): LoadedExtension {
        val admitted = ApkTrust.admit(apk, expectedPackage, expectedFingerprint, jarDir)
        try {
            val manifest = readManifest(admitted.apk)
            if (manifest.pkg != expectedPackage) throw ApkTrustException("The extension manifest package differs from its approved repository identity")
            require(EXTENSION_FEATURE in manifest.features) { "This file is not a Mihon/Tachiyomi extension" }
            val libVersion = manifest.versionName.substringBeforeLast('.').toDoubleOrNull() ?: 0.0
            require(libVersion in LIB_VERSION_MIN..LIB_VERSION_MAX) {
                "Extension library $libVersion isn't supported (only $LIB_VERSION_MIN to $LIB_VERSION_MAX)"
            }
            val classNames =
                (manifest.meta[METADATA_SOURCE_CLASS] ?: throw IllegalStateException("The extension names no source class"))
                    .split(';')
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .map { if (it.startsWith(".")) manifest.pkg + it else it }
            val jar = jarFor(admitted.apk, manifest, jarDir)
            val jarPath = jar.toAbsolutePath().toString()
            loaded[manifest.pkg]?.takeIf { it.jar == jarPath }?.let { return it }
            val loader = loaders.getOrPut(jarPath) { ChildFirstURLClassLoader(arrayOf(jar.toUri().toURL())) }
            val sources =
                classNames.flatMap { className ->
                    when (val instance = Class.forName(className, false, loader).getDeclaredConstructor().newInstance()) {
                        is Source -> listOf(instance)
                        is SourceFactory -> instance.createSources()
                        else -> throw IllegalStateException("Unknown source class $className")
                    }
                }.filterIsInstance<CatalogueSource>()
            val warning = manifest.meta[METADATA_CONTENT_WARNING]?.toIntOrNull() ?: manifest.meta[METADATA_NSFW]?.toIntOrNull() ?: 0
            val extension = LoadedExtension(manifest.pkg, manifest.versionName, libVersion, warning != 0, sources, jarPath)
            loaded[manifest.pkg] = extension
            return extension
        } finally {
            admitted.apk.delete()
        }
    }
}
