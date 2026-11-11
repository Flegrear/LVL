package io.github.flegrear.lvl.updates

/**
 * PackageInstaller may retire a committed session before the new package is
 * visible to PackageManager. That missing-session interval has no trustworthy
 * success/failure meaning; the journal remains pending for a bounded period.
 * Only a verified installed package or an explicit result is authoritative.
 */
object InstallSessionReconciliation {
    private const val MISSING_SESSION_GRACE_MS = 120_000L
    private const val MISSING_CONFIRMATION_GRACE_MS = 15 * 60_000L

    fun shouldAwaitPackagePublication(phase: String, createdAtMillis: Long, nowMs: Long): Boolean {
        if (phase !in setOf("created", "committing", "awaiting-confirmation", "reported-success"))
            return false
        if (createdAtMillis <= 0L || nowMs < createdAtMillis) return false
        val grace = if (phase == "awaiting-confirmation") MISSING_CONFIRMATION_GRACE_MS
            else MISSING_SESSION_GRACE_MS
        return nowMs - createdAtMillis <= grace
    }
}
