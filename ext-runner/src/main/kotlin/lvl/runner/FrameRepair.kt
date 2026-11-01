package lvl.runner

// LVL's extension runner. dex2jar writes each method's stack map frames (the
// types the JVM verifier expects at every branch target) itself. Where two
// branches join with different classes in one local, it needs their common
// superclass, and when it can't find one it writes java/lang/Object. Since
// keiyoushi's 2026-10-31 rebuilds, a shared interceptor keeps one of two
// strategy objects (b or c, both extending d) in a local and then calls d's
// method on it; the frame says Object, and the JVM refuses the class ("Bad type
// on operand stack ... Object is not assignable to 'd'").
//
// After conversion this recomputes every method's frames with ASM, resolving
// common superclasses from the extension's own classes first and then from the
// classes the runner can load (Android stubs, OkHttp, Kotlin, the JDK). A class
// whose frames can't be recomputed keeps the frames dex2jar wrote.

import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassWriter
import java.net.URI
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path

object FrameRepair {
    private class Info(
        val superName: String?,
        val isInterface: Boolean,
    )

    // Class name (internal form) -> its superclass and kind, for the jar's own classes.
    private fun ownClasses(root: Path): Map<String, Info> {
        val out = HashMap<String, Info>()
        Files.walk(root).use { paths ->
            paths.filter { it.toString().endsWith(".class") }.forEach { file ->
                val reader = ClassReader(Files.readAllBytes(file))
                out[reader.className] = Info(reader.superName, reader.access and org.objectweb.asm.Opcodes.ACC_INTERFACE != 0)
            }
        }
        return out
    }

    private class Writer(
        private val own: Map<String, Info>,
        private val loader: ClassLoader,
        // No ClassReader here: given one, ASM copies each method's bytes (and dex2jar's
        // frames) unchanged instead of computing new frames.
    ) : ClassWriter(COMPUTE_FRAMES) {
        private fun info(name: String): Info? {
            own[name]?.let { return it }
            return try {
                val type = Class.forName(name.replace('/', '.'), false, loader)
                Info(type.superclass?.name?.replace('.', '/'), type.isInterface)
            } catch (_: Throwable) {
                null
            }
        }

        private fun chain(name: String): List<String> {
            val out = ArrayList<String>()
            var current: String? = name
            while (current != null && out.size < 64) {
                out.add(current)
                current = info(current)?.superName ?: if (current == "java/lang/Object") null else "java/lang/Object"
            }
            return out
        }

        override fun getCommonSuperClass(
            type1: String,
            type2: String,
        ): String {
            if (type1 == type2) return type1
            val a = info(type1)
            val b = info(type2)
            if (a?.isInterface == true || b?.isInterface == true) return "java/lang/Object"
            val ancestors = chain(type1).toHashSet()
            return chain(type2).firstOrNull { it in ancestors } ?: "java/lang/Object"
        }

        override fun getClassLoader(): ClassLoader = loader
    }

    // Rewrites the classes in `jar` in place. Returns how many classes were rewritten.
    fun recompute(jar: Path): Int {
        val env = mapOf("create" to "false")
        FileSystems.newFileSystem(URI.create("jar:" + jar.toUri()), env).use { fs ->
            val root = fs.getPath("/")
            val own = ownClasses(root)
            val loader = FrameRepair::class.java.classLoader
            var count = 0
            Files.walk(root).use { paths -> paths.filter { it.toString().endsWith(".class") }.toList() }.forEach { file ->
                val bytes = Files.readAllBytes(file)
                val reader = ClassReader(bytes)
                val rewritten =
                    try {
                        val writer = Writer(own, loader)
                        // SKIP_FRAMES: read the code without dex2jar's frames; COMPUTE_FRAMES writes new ones.
                        reader.accept(writer, ClassReader.SKIP_FRAMES)
                        writer.toByteArray()
                    } catch (error: Throwable) {
                        System.err.println("FrameRepair: kept dex2jar's frames for ${reader.className}: $error")
                        null
                    }
                if (rewritten != null) {
                    Files.write(file, rewritten)
                    count++
                }
            }
            return count
        }
    }
}
