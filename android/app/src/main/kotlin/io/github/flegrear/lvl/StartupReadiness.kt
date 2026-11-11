package io.github.flegrear.lvl

/**
 * Monotonic, consecutive authenticated probes for one live child generation.
 * Any invalid probe or process death discards accumulated stability.
 */
class StartupReadiness(
    private val stableWindowMs: Long = 3_000L,
    private val minimumProbes: Int = 3,
) {
    private var firstValidAt: Long = -1L
    private var lastSampleAt: Long = -1L
    private var consecutive = 0
    private var confirmed = false

    fun observe(nowMs: Long, authenticated: Boolean, currentChildAlive: Boolean): Boolean {
        if (confirmed) return currentChildAlive && authenticated
        if (!authenticated || !currentChildAlive || nowMs < lastSampleAt) {
            firstValidAt = -1L
            consecutive = 0
            lastSampleAt = nowMs
            return false
        }
        if (firstValidAt < 0) firstValidAt = nowMs
        lastSampleAt = nowMs
        consecutive++
        confirmed = consecutive >= minimumProbes && nowMs - firstValidAt >= stableWindowMs
        return confirmed
    }
}

/**
 * A short proof lease for the UI's privileged operations. A live Process alone
 * is insufficient: the endpoint must have recently proven the current child's
 * secret. Both the child object and the UI's startup generation must match.
 *
 * A separate background thread renews the lease; readers never perform
 * network I/O on Android's main or WebView callback threads.
 */
class FreshChildProof(private val maximumAgeMs: Long = 2_000L) {
    private data class Witness(val child: Any, val generation: Int, val verifiedAt: Long)
    @Volatile private var witness: Witness? = null

    fun record(child: Any, generation: Int, verifiedAt: Long, authenticated: Boolean) {
        witness = if (authenticated) Witness(child, generation, verifiedAt) else null
    }

    fun permits(child: Any?, generation: Int, nowMs: Long, currentAlive: Boolean): Boolean {
        val state = witness ?: return false
        return currentAlive && child != null && state.child === child &&
            state.generation == generation && nowMs >= state.verifiedAt &&
            nowMs - state.verifiedAt <= maximumAgeMs
    }

    fun revoke() { witness = null }
}

/**
 * Page recovery decisions, independent of the short bearer/bridge proof lease.
 * Every failed probe immediately revokes native authority. A live child's
 * unanswered HTTP request is given a small recovery window before covering
 * the current page. An actual wrong proof never receives that grace.
 */
class ActiveConnectionHealth(
    private val coverDelayMs: Long = 4_500L,
    private val terminalDelayMs: Long = 30_000L,
) {
    enum class Decision { RESTORED, WAITING, SUSPEND, TERMINAL }
    private var firstFailureAt = -1L
    private var previousSampleAt = -1L

    /** Duration of this consecutive unauthenticated episode; no proof extension. */
    fun unauthenticatedForMs(nowMs: Long): Long =
        if (firstFailureAt < 0L || nowMs < firstFailureAt) 0L else nowMs - firstFailureAt

    fun observe(nowMs: Long, sample: ServerIdentity.ProbeStatus, currentChildAlive: Boolean): Decision {
        if (!currentChildAlive) return Decision.TERMINAL
        if (sample == ServerIdentity.ProbeStatus.VERIFIED) {
            firstFailureAt = -1L
            previousSampleAt = nowMs
            return Decision.RESTORED
        }
        if (nowMs < previousSampleAt) firstFailureAt = -1L
        previousSampleAt = nowMs
        if (firstFailureAt < 0L) firstFailureAt = nowMs
        val elapsed = nowMs - firstFailureAt
        // A live process can stop answering forever. Give the user a reachable
        // Retry after the bounded recovery window without describing it as dead.
        if (elapsed >= terminalDelayMs) return Decision.TERMINAL
        if (sample == ServerIdentity.ProbeStatus.REJECTED || elapsed >= coverDelayMs)
            return Decision.SUSPEND
        return Decision.WAITING
    }
}
