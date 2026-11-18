package lvl.runner

import java.util.LinkedHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The runner's ephemeral extension memo and source lease registry.
 *
 * A request acquires exactly one committed generation before invoking extension code.
 * Replacements retire old memos immediately; a slow old request may finish, but cannot
 * write into a retired generation. Its loader closes after the last request releases it.
 * All state transitions and memo operations use the same monitor.
 */
internal class GenerationMemo<S : Any, V : Any>(
    private val weightOf: (V) -> Long,
    private val clockMs: () -> Long = { System.nanoTime() / 1_000_000L },
    maxEntries: Int = 512,
    maxBytes: Long = 2L * 1024 * 1024,
    ttlMs: Long = 30L * 60 * 1000,
) {
    private class Generation(
        val pkg: String,
        val revision: String,
        val retire: () -> Unit,
        var references: Int = 0,
        var obsolete: Boolean = false,
        var released: Boolean = false,
    )

    private data class Source<S>(val value: S, val generation: Generation)
    private val active = HashMap<String, Generation>()
    private val byId = HashMap<Long, Source<S>>()
    private val manga = BoundedMemo<V>(maxEntries, maxBytes, ttlMs, clockMs, weightOf)
    private val chapter = BoundedMemo<V>(maxEntries, maxBytes, ttlMs, clockMs, weightOf)

    class Lease<S : Any, V : Any> internal constructor(
        val source: S,
        private val reader: (Boolean, String) -> V?,
        private val writer: (Boolean, String, V) -> Unit,
        private val release: () -> Unit,
    ) : AutoCloseable {
        private val closed = AtomicBoolean()

        fun manga(url: String): V? = if (closed.get()) null else reader(true, url)
        fun chapter(url: String): V? = if (closed.get()) null else reader(false, url)
        fun saveManga(url: String, memo: V) { if (!closed.get()) writer(true, url, memo) }
        fun saveChapter(url: String, memo: V) { if (!closed.get()) writer(false, url, memo) }
        override fun close() { if (closed.compareAndSet(false, true)) release() }
    }

    /** Called after SourceOwnership.replace validates and commits all numeric IDs. */
    @Synchronized
    fun commit(pkg: String, revision: String, candidates: Map<Long, S>, retire: () -> Unit): Boolean {
        require(pkg.isNotBlank() && revision.isNotBlank())
        val old = active[pkg]
        if (old?.revision == revision) return false
        val new = Generation(pkg, revision, retire)
        for ((id, binding) in byId.toMap()) if (binding.generation.pkg == pkg) byId.remove(id)
        for ((id, source) in candidates) byId[id] = Source(source, new)
        active[pkg] = new
        if (old != null) {
            old.obsolete = true
            manga.removeGeneration(old)
            chapter.removeGeneration(old)
            maybeRelease(old)
        }
        return true
    }

    @Synchronized
    fun acquire(id: Long): Lease<S, V>? {
        val binding = byId[id] ?: return null
        val generation = binding.generation
        if (generation.obsolete) return null
        generation.references++
        return Lease(
            binding.value,
            { isManga, url ->
                synchronized(this) {
                    if (generation.obsolete) null
                    else (if (isManga) manga else chapter).get(generation, id, url)
                }
            },
            { isManga, url, memo ->
                synchronized(this) {
                    if (!generation.obsolete) (if (isManga) manga else chapter).put(generation, id, url, memo)
                }
            },
            {
                synchronized(this) {
                    generation.references--
                    maybeRelease(generation)
                }
            },
        )
    }

    @Synchronized
    fun sourceValues(): List<S> = byId.values.map { it.value }

    /** Statistics are bounded and exposed for deterministic resource regression tests. */
    @Synchronized
    fun counts(): Pair<Int, Int> = manga.size() to chapter.size()

    @Synchronized
    fun weights(): Pair<Long, Long> = manga.bytes() to chapter.bytes()

    @Synchronized
    fun activePackages(): Int = active.size

    /** EOF: retire committed loaders after their last acquired request closes. */
    @Synchronized
    fun shutdown() {
        for (generation in active.values) {
            generation.obsolete = true
            manga.removeGeneration(generation)
            chapter.removeGeneration(generation)
            maybeRelease(generation)
        }
        active.clear()
        byId.clear()
    }

    // A retired generation is released only after every old in-flight call closes.
    private fun maybeRelease(generation: Generation) {
        if (!generation.obsolete || generation.references != 0 || generation.released) return
        generation.released = true
        runCatching { generation.retire() }
            .onFailure { System.err.println("[runner] retired extension loader could not close: ${it::class.java.simpleName}") }
    }

    private class BoundedMemo<V : Any>(
        private val maxEntries: Int,
        private val maxBytes: Long,
        private val ttlMs: Long,
        private val clock: () -> Long,
        private val valueWeight: (V) -> Long,
    ) {
        init {
            require(maxEntries > 0 && maxBytes > 0 && ttlMs > 0)
        }

        private data class Key(val generation: Any, val source: Long, val url: String)
        private data class Value<V>(val value: V, val weight: Long, val insertedAt: Long)
        private val entries = LinkedHashMap<Key, Value<V>>(16, 0.75f, true)
        private var byteCount = 0L

        fun size(): Int = entries.size
        fun bytes(): Long = byteCount

        fun get(generation: Any, id: Long, url: String): V? {
            prune()
            return entries[Key(generation, id, url)]?.value
        }

        fun put(generation: Any, id: Long, url: String, value: V) {
            prune()
            val key = Key(generation, id, url) // The provider URL is opaque: no normalization.
            val previous = entries.remove(key)
            if (previous != null) byteCount -= previous.weight
            val urlBytes = url.toByteArray(Charsets.UTF_8).size.toLong()
            val weight = valueWeight(value).coerceAtLeast(0L).coerceAtMost(maxBytes + 1L) + urlBytes
            if (weight > maxBytes) return
            entries[key] = Value(value, weight, clock())
            byteCount += weight
            while (entries.size > maxEntries || byteCount > maxBytes) {
                val oldest = entries.entries.iterator()
                val item = oldest.next()
                byteCount -= item.value.weight
                oldest.remove()
            }
        }

        fun removeGeneration(generation: Any) {
            val iterator = entries.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.key.generation === generation) {
                    byteCount -= entry.value.weight
                    iterator.remove()
                }
            }
        }

        private fun prune() {
            val now = clock()
            val iterator = entries.entries.iterator()
            while (iterator.hasNext()) {
                val item = iterator.next()
                if (now - item.value.insertedAt >= ttlMs) {
                    byteCount -= item.value.weight
                    iterator.remove()
                }
            }
        }
    }
}
