package lvl.runner

/** One numeric source ID belongs to one extension package until that package updates it. */
class SourceOwnership<S : Any> {
    private data class Entry<S>(val pkg: String, val source: S)

    private val byId = LinkedHashMap<Long, Entry<S>>()

    /** Validate the entire candidate before replacing any handler. Concurrent loads serialize here. */
    @Synchronized
    fun replace(pkg: String, candidates: List<S>, idOf: (S) -> Long): Map<Long, S> {
        require(pkg.isNotBlank()) { "Extension package is missing" }
        val proposed = LinkedHashMap<Long, S>()
        for (source in candidates) {
            val id = idOf(source)
            require(!proposed.containsKey(id)) { "Duplicate source ID $id in $pkg" }
            val existing = byId[id]
            require(existing == null || existing.pkg == pkg) { "Source ID $id is already owned by ${existing?.pkg}" }
            proposed[id] = source
        }
        val retired = byId.filter { (_, entry) -> entry.pkg == pkg }.keys - proposed.keys
        for (id in retired) byId.remove(id)
        for ((id, source) in proposed) byId[id] = Entry(pkg, source)
        // Callers publish generations using the validated IDs; do not invoke
        // extension-controlled id getters again after this commit.
        return proposed.toMap()
    }

    @Synchronized
    operator fun get(id: Long): S? = byId[id]?.source

    val values: List<S>
        @Synchronized get() = byId.values.map { it.source }
}
