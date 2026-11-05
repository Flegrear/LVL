package io.github.flegrear.lvl.comics

import dalvik.system.PathClassLoader
import java.net.URL
import java.util.Enumeration

/**
 * Loads an extension's own classes before the app's, so an extension that bundles a newer
 * copy of a helper uses its own; Android's classes still come from the system first. The
 * app is the parent, so the source API, OkHttp, Jsoup and the rest come from LVL.
 */
class ChildFirstPathClassLoader(
    dexPath: String,
    librarySearchPath: String?,
    parent: ClassLoader,
) : PathClassLoader(dexPath, librarySearchPath, parent) {
    private val system: ClassLoader? = getSystemClassLoader()

    override fun loadClass(name: String, resolve: Boolean): Class<*> {
        synchronized(this) {
            var loaded = findLoadedClass(name)
            if (loaded == null && system != null) {
                loaded = try { system.loadClass(name) } catch (_: ClassNotFoundException) { null }
            }
            if (loaded == null) {
                loaded = try { findClass(name) } catch (_: ClassNotFoundException) { super.loadClass(name, false) }
            }
            if (resolve) resolveClass(loaded)
            return loaded!!
        }
    }

    override fun getResource(name: String): URL? =
        system?.getResource(name) ?: findResource(name) ?: super.getResource(name)

    override fun getResources(name: String): Enumeration<URL> {
        val all = buildList {
            system?.getResources(name)?.toList()?.let(::addAll)
            addAll(findResources(name).toList())
            parent?.getResources(name)?.toList()?.let(::addAll)
        }
        return java.util.Collections.enumeration(all.distinct())
    }
}
