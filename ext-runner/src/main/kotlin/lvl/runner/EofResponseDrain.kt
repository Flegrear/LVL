package lvl.runner

/**
 * Exactly one response attempt for every accepted stdin request.
 *
 * EOF closes admission, lets outstanding operations finish for a bounded window,
 * and writes a cancellation for every request still pending. A late extension
 * callback cannot emit a second response after that cancellation. The writer
 * runs under the same monitor as settlement, so a finished request's reply
 * cannot be reordered after EOF has declared it canceled.
 */
internal class EofResponseDrain<I : Any, O : Any>(
    private val writer: (O) -> Unit,
    private val maximumPending: Int = 64,
) {
    init { require(maximumPending > 0) }

    class Ticket<I : Any> internal constructor(val id: I) {
        @Volatile var cancel: (() -> Unit)? = null
    }

    private val monitor = Object()
    private val pending = LinkedHashSet<Ticket<I>>()
    private var accepting = true

    fun admit(id: I): Ticket<I>? = synchronized(monitor) {
        if (!accepting || pending.size >= maximumPending) null
        else Ticket(id).also { pending.add(it) }
    }

    /** True only for the first completed or canceled response of this ticket. */
    fun answer(ticket: Ticket<I>, response: O): Boolean = synchronized(monitor) {
        if (!pending.remove(ticket)) return@synchronized false
        try {
            writer(response)
        } finally {
            monitor.notifyAll()
        }
        true
    }

    /**
     * Called by the sole stdin reader after readLine returns EOF. Returns the
     * tickets whose operations must now be canceled. Every returned ticket has
     * already received its deterministic cancellation response.
     */
    fun finish(timeoutMs: Long, canceled: (Ticket<I>) -> O): List<Ticket<I>> {
        require(timeoutMs >= 0L)
        return synchronized(monitor) {
            accepting = false
            val deadline = System.nanoTime() + timeoutMs * 1_000_000L
            while (pending.isNotEmpty()) {
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0L) break
                monitor.wait(remaining / 1_000_000L, (remaining % 1_000_000L).toInt())
            }
            val unfinished = pending.toList()
            for (ticket in unfinished) {
                pending.remove(ticket)
                try {
                    writer(canceled(ticket))
                } finally {
                    monitor.notifyAll()
                }
            }
            unfinished
        }
    }
}
