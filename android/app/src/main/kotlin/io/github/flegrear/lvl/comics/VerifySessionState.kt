package io.github.flegrear.lvl.comics

import java.lang.ref.WeakReference

/** Owns accepted launches, delivered Activities and their exact URL/generation. */
internal class VerifySessionState(
    private val clockMs: () -> Long,
    private val pendingTimeoutMs: Long = 15_000L,
) {
    companion object {
        // A JSON number must round-trip through JavaScript without rounding.
        const val MAX_SAFE_REVISION = 9_007_199_254_740_991L
    }
    data class Snapshot(
        val open: Boolean,
        val url: String?,
        val pending: Boolean,
        val generation: Long?,
        val passed: Boolean,
        val finishedAt: Long,
        val revision: Long,
    )
    private class Session(
        val generation: Long,
        val url: String,
        val pendingSince: Long,
        var owner: WeakReference<Any>? = null,
        var previous: Session? = null,
    )
    private var nextGeneration = 0L
    // Monotonic ownership epoch: an intervening begin/close cannot turn a
    // stale browser/RPC response into an apparently idle current response.
    private var revision = 0L
    private var current: Session? = null
    private var wasPassed = false
    private var lastFinishedAt = 0L

    private fun advanceRevision() {
        // Exhaustion is fail-closed; wrapping to an earlier epoch would make
        // a stale browser response authoritative again.
        check(revision < MAX_SAFE_REVISION) { "Verification revision exhausted" }
        revision += 1L
    }

    private fun rollbackPending(session: Session) {
        advanceRevision()
        current = session.previous?.takeIf { it.owner?.get() != null }
    }

    private fun expirePending(now: Long) {
        val session = current ?: return
        if (session.owner?.get() == null && now - session.pendingSince >= pendingTimeoutMs) rollbackPending(session)
    }

    @Synchronized
    fun expire(generation: Long) {
        if (current?.generation == generation) expirePending(clockMs())
    }

    /** Null means the same URL is already active or has an unexpired launch. */
    @Synchronized
    fun begin(url: String): Long? {
        expirePending(clockMs())
        if (current?.url == url) return null
        val previous = current?.let { pending ->
            pending.takeIf { it.owner?.get() != null }
                ?: pending.previous?.takeIf { it.owner?.get() != null }
        }
        check(nextGeneration < MAX_SAFE_REVISION) { "Verification generation exhausted" }
        advanceRevision()
        val generation = ++nextGeneration
        current = Session(generation, url, clockMs(), previous = previous)
        wasPassed = false
        lastFinishedAt = 0L
        return generation
    }

    @Synchronized
    fun launchFailed(generation: Long) {
        current?.takeIf { it.generation == generation && it.owner?.get() == null }?.let(::rollbackPending)
    }

    /** Accept only the requested URL and generation; allow restoration after process death. */
    @Synchronized
    fun attach(generation: Long, url: String, owner: Any, recreation: Boolean): Boolean {
        if (generation <= 0L || generation > MAX_SAFE_REVISION) return false
        expirePending(clockMs())
        if (current == null && (nextGeneration == 0L || recreation)) {
            advanceRevision()
            nextGeneration = maxOf(nextGeneration, generation)
            current = Session(generation, url, clockMs())
            wasPassed = false
            lastFinishedAt = 0L
        }
        val session = current ?: return false
        if (session.generation != generation || session.url != url) return false
        session.owner = WeakReference(owner)
        session.previous = null
        return true
    }

    @Synchronized
    fun isCurrent(generation: Long, owner: Any): Boolean =
        current?.let { it.generation == generation && it.owner?.get() === owner } == true

    @Synchronized
    fun complete(generation: Long, owner: Any): Boolean {
        if (!isCurrent(generation, owner)) return false
        advanceRevision()
        wasPassed = true
        return true
    }

    @Synchronized
    fun destroyed(generation: Long, owner: Any, finishedAt: Long) {
        val session = current ?: return
        if (session.generation == generation && session.owner?.get() === owner) {
            advanceRevision()
            current = null
            lastFinishedAt = finishedAt
        } else if (session.previous?.generation == generation && session.previous?.owner?.get() === owner) {
            advanceRevision()
            session.previous = null
        }
    }

    @Synchronized
    fun isIdleRevision(expected: Long): Boolean {
        expirePending(clockMs())
        return expected >= 0L && expected <= MAX_SAFE_REVISION && current == null && revision == expected
    }

    /** One native cookie-RPC producer admission. A competing begin/complete/
     * destroy cannot advance the epoch between this check and the synchronous
     * write. Never call this around network fetches or a UI handoff. */
    @Synchronized
    fun <T> withIdleRevision(expected: Long, write: () -> T): T? {
        if (!isIdleRevision(expected)) return null
        return write()
    }

    @Synchronized
    fun snapshot(): Snapshot {
        expirePending(clockMs())
        val session = current
        return Snapshot(
            open = session != null,
            url = session?.url,
            pending = session != null && session.owner?.get() == null,
            generation = session?.generation,
            passed = wasPassed,
            finishedAt = lastFinishedAt,
            revision = revision,
        )
    }
}
