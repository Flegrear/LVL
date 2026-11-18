package io.github.flegrear.lvl

/**
 * One process-wide reservation for Android's Node startup, app-file recovery,
 * rollback, and terminal status publication. The same gate is shared by all
 * ServerService instances within the app process.
 *
 * This class has no Android dependencies so its actual concurrency semantics
 * can be exercised in a JVM fixture without launching a native Node child.
 */
internal class NodeStartupOwnership {
    private val lock = Object()
    private var worker: Thread? = null
    private var child: Process? = null

    /** Called on the background startup worker before touching app files. */
    fun acquire(
        isStopped: () -> Boolean,
        nowMs: () -> Long,
        timeoutMs: Long = 45_000L,
    ) {
        require(timeoutMs >= 0L)
        synchronized(lock) {
            val deadline = nowMs() + timeoutMs
            while (worker != null || child != null) {
                check(!isStopped()) { "The service stopped during Node handoff" }
                val remaining = deadline - nowMs()
                check(remaining > 0L) { "Previous LVL Node startup or rollback has not finished" }
                lock.wait(minOf(remaining, 500L))
            }
            check(!isStopped()) { "The service stopped during Node handoff" }
            worker = Thread.currentThread()
        }
    }

    /** Immediately publish an actually spawned child before exposing it to the UI. */
    fun register(process: Process) {
        synchronized(lock) {
            check(worker === Thread.currentThread() && child == null) {
                "Previous LVL Node generation still owns the server port"
            }
            child = process
        }
    }

    /** A foreign worker and any living child are forbidden to restore app.old. */
    fun canRollBack(): Boolean = synchronized(lock) {
        worker === Thread.currentThread() && child?.isAlive != true
    }

    /**
     * Called after this worker made its rollback/terminal decision and published
     * its last Service state. Never free ownership while the exact child lives.
     */
    fun release(process: Process?) {
        synchronized(lock) {
            if (worker !== Thread.currentThread()) return
            if (child === process && process?.isAlive != true) child = null
            if (child == null) {
                worker = null
                lock.notifyAll()
            }
        }
    }
}
