package lvl.runner

/**
 * A cancellation acknowledgement is emitted only by complete(), after the
 * associated coroutine has terminated and all synchronous source leases closed.
 * A queued/blocked extension cannot manufacture an acknowledgement merely by
 * receiving Job.cancel(). Unknown or wrong-generation IDs never cancel work.
 */
internal class QuiescentCancellation<I : Any, V : Any>(
    private val deliver: (I, V?, Boolean) -> Unit,
    private val maxPending: Int = 64,
) {
    init { require(maxPending > 0) }

    internal class Slot<I : Any, V : Any>(val key: String, val ticket: I) {
        @Volatile var result: V? = null
        var canceled: Boolean = false
        var cancelAction: (() -> Unit)? = null
        var finished: Boolean = false
    }

    private val lock = Any()
    private val active = HashMap<String, Slot<I, V>>()

    fun admit(key: String, ticket: I): Slot<I, V>? = synchronized(lock) {
        if (key.isEmpty() || active.size >= maxPending || active.containsKey(key)) null
        else Slot<I, V>(key, ticket).also { active[key] = it }
    }

    fun bind(slot: Slot<I, V>, cancelAction: () -> Unit) {
        val cancelNow = synchronized(lock) {
            if (active[slot.key] !== slot || slot.finished) return
            slot.cancelAction = cancelAction
            slot.canceled
        }
        if (cancelNow) cancelAction()
    }

    fun cancel(key: String): Boolean {
        val action = synchronized(lock) {
            val slot = active[key] ?: return false
            if (slot.finished) return false
            slot.canceled = true
            slot.cancelAction
        }
        action?.invoke()
        return true
    }

    /** Must be invoked by a Job.invokeOnCompletion callback, never by cancel(). */
    fun complete(slot: Slot<I, V>) {
        val cancelled = synchronized(lock) {
            if (active[slot.key] !== slot || slot.finished) return
            slot.finished = true
            active.remove(slot.key)
            slot.canceled
        }
        deliver(slot.ticket, slot.result, cancelled)
    }

    fun outstanding(): Int = synchronized(lock) { active.size }
}
