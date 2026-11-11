package io.github.flegrear.lvl.updates

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.util.Log
import io.github.flegrear.lvl.MainActivity
import io.github.flegrear.lvl.R
import java.io.File
import java.io.IOException
import java.util.UUID
import org.json.JSONObject

/**
 * Installs a new LVL APK with Android's package installer. Android asks the user to confirm
 * the first time (and to allow installs from LVL); once LVL installed itself, later updates
 * may go through without asking (UPDATE_PACKAGES_WITHOUT_USER_ACTION). Android stops LVL
 * while it installs; a notification then offers to open the new version.
 */
object ApkInstall {
    private const val TAG = "LVL-Updates"
    const val ACTION_RESULT = "io.github.flegrear.lvl.UPDATE_INSTALL_RESULT"
    const val EXTRA_LVL_SESSION_ID = "io.github.flegrear.lvl.UPDATE_SESSION_ID"
    const val EXTRA_LVL_ATTEMPT_ID = "io.github.flegrear.lvl.UPDATE_ATTEMPT_ID"
    private const val CHANNEL = "updates"
    private const val JOURNAL = "lvl-apk-install-journal"
    private const val JOURNAL_KEY = "attempt"
    private val journalLock = Any()

    data class Attempt(
        val id: String, val sessionId: Int, val version: String,
        val versionCode: Long, val phase: String, val message: String?,
        val createdAtMillis: Long,
        val signerHashes: Set<String>,
    ) {
        val pending: Boolean get() = phase in setOf("created", "committing", "awaiting-confirmation", "reported-success")
        val awaitingConfirmation: Boolean get() = phase == "awaiting-confirmation"
        val failed: Boolean get() = phase in setOf("failed", "cancelled", "unknown")
    }

    /** One private, synchronous, atomic SharedPreferences commit per transition. */
    private fun readLocked(context: Context): Attempt? {
        val raw = context.getSharedPreferences(JOURNAL, Context.MODE_PRIVATE).getString(JOURNAL_KEY, null)
            ?: return null
        return runCatching {
            val json = JSONObject(raw)
            val stored = json.optString("signerHashes", "")
            val signers = if (json.has("signerHashes")) {
                require(stored.isNotBlank())
                stored.split(",").toSet().also { hashes ->
                    require(hashes.all { it.matches(Regex("[a-f0-9]{64}")) })
                }
            } else emptySet()
            Attempt(json.getString("id"), json.getInt("sessionId"), json.getString("version"),
                json.getLong("versionCode"), json.getString("phase"), json.optString("message").ifEmpty { null },
                json.optLong("createdAtMillis", 0L), signers)
        }.getOrNull()?.takeIf { it.id.length in 32..80 && it.sessionId >= 0 && it.version.isNotBlank() }
    }

    private fun writeLocked(context: Context, attempt: Attempt) {
        val json = JSONObject().apply {
            put("id", attempt.id)
            put("sessionId", attempt.sessionId)
            put("version", attempt.version)
            put("versionCode", attempt.versionCode)
            put("phase", attempt.phase)
            put("message", attempt.message ?: "")
            put("createdAtMillis", attempt.createdAtMillis)
            // Older journals had no pin. Preserve their readback format across
            // a transition so an interrupted 0.2.1 install remains recoverable.
            if (attempt.signerHashes.isNotEmpty())
                put("signerHashes", attempt.signerHashes.sorted().joinToString(","))
        }.toString()
        if (!context.getSharedPreferences(JOURNAL, Context.MODE_PRIVATE).edit()
                .putString(JOURNAL_KEY, json).commit()) {
            throw IOException("Couldn't save Android's install attempt")
        }
    }

    fun recorded(context: Context): Attempt? = synchronized(journalLock) { readLocked(context) }

    private fun installedSignerHashes(context: Context): Set<String> = runCatching {
        val info = context.packageManager.getPackageInfo(
            context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        val signing = info.signingInfo
        val certificates = (signing?.apkContentsSigners ?: emptyArray()) +
            (signing?.signingCertificateHistory ?: emptyArray())
        InstallVersionAttestation.signerDigests(certificates.map { it.toByteArray() })
    }.getOrDefault(emptySet())

    private fun callbackData(context: Context, attempt: Attempt): Uri =
        Uri.parse("lvl-install-result://${context.packageName}/${attempt.sessionId}/${attempt.id}")

    private fun begin(context: Context, id: Int, version: String, versionCode: Long): Attempt =
        synchronized(journalLock) {
            val previous = readLocked(context)
            check(previous?.pending != true) { "An Android installation is already pending" }
            val signerHashes = installedSignerHashes(context)
            check(signerHashes.isNotEmpty()) { "Couldn't verify the installed LVL signature" }
            Attempt(UUID.randomUUID().toString(), id, version, versionCode, "created", null,
                System.currentTimeMillis(), signerHashes)
                .also { writeLocked(context, it) }
        }

    /** Exact attempt ID + session ID fence; an older PendingIntent cannot clear the latest attempt. */
    fun transition(context: Context, attemptId: String, sessionId: Int,
                   phase: String, message: String? = null): Attempt? = synchronized(journalLock) {
        val old = readLocked(context) ?: return@synchronized null
        if (old.id != attemptId || old.sessionId != sessionId || old.phase == "confirmed" ||
            (!old.pending && old.phase != "unknown" && phase != "confirmed") ||
            (old.phase in setOf("failed", "cancelled") && phase !in setOf("confirmed"))) return@synchronized null
        if (old.phase == "reported-success" && phase in setOf("created", "committing", "awaiting-confirmation"))
            return@synchronized null
        if (old.phase == "awaiting-confirmation" && phase in setOf("created", "committing"))
            return@synchronized null
        val next = old.copy(phase = phase, message = message?.take(180))
        writeLocked(context, next)
        next
    }

    /** A missing session is ambiguous. Installed package identity is the success criterion. */
    fun reconcile(context: Context): Attempt? = synchronized(journalLock) {
        val old = readLocked(context) ?: return@synchronized null
        val installed = runCatching {
            context.packageManager.getPackageInfo(
                context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        }.getOrNull()
        val actual = InstallVersionAttestation.matches(
            old.version, old.versionCode, old.signerHashes,
            installed?.versionName, installed?.longVersionCode, installedSignerHashes(context))
        if (actual) {
            if (old.phase == "confirmed") return@synchronized old
            return@synchronized old.copy(phase = "confirmed", message = null)
                .also { writeLocked(context, it) }
        }
        if (!old.pending) return@synchronized old
        val session = runCatching {
            context.packageManager.packageInstaller.getSessionInfo(old.sessionId)
        }.getOrNull()
        // Android may remove a committed install session before PackageManager
        // reports the replacement version. The gap isn't evidence of failure.
        // Keep the original durable pending attempt for a bounded period; the
        // next reconcile can confirm the installed package or observe an
        // authenticated explicit failure result. Old pre-migration journal
        // entries have no timestamp and retain their previous behavior.
        if (session == null && InstallSessionReconciliation.shouldAwaitPackagePublication(
                old.phase, old.createdAtMillis, System.currentTimeMillis()))
            return@synchronized old
        val next = when {
            session == null -> old.copy(phase = "unknown",
                message = "Android hasn't confirmed this update")
            session.installerPackageName != context.packageName ||
                (session.appPackageName != null && session.appPackageName != context.packageName) ->
                old.copy(phase = "failed", message = "The install session belongs to another app")
            else -> old
        }
        if (next !== old) writeLocked(context, next)
        next
    }

    /**
     * After process recreation, a pending confirmation remains accessible
     * through Android's own session-details screen when the platform provides it.
     * This also avoids pretending a missing session represents success.
     */
    fun remindPending(context: Context): Boolean {
        val attempt = reconcile(context) ?: return false
        if (attempt.phase != "awaiting-confirmation") return false
        val session = runCatching { context.packageManager.packageInstaller.getSessionInfo(attempt.sessionId) }
            .getOrNull() ?: return false
        if (session.installerPackageName != context.packageName ||
            (session.appPackageName != null && session.appPackageName != context.packageName)) return false
        val details = session.createDetailsIntent() ?: return false
        details.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching {
            val tap = PendingIntent.getActivity(context, 9, details,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            notify(context, 7, "Finish updating LVL", "Tap to continue installing the update", tap)
            true
        }.getOrDefault(false)
    }

    /** The component and unforgeable per-attempt PendingIntent must match our own session. */
    fun acceptResult(context: Context, intent: Intent): Attempt? {
        if (intent.action != ACTION_RESULT || intent.component?.className != InstallResultReceiver::class.java.name ||
            intent.component?.packageName != context.packageName || intent.`package` != context.packageName ||
            !intent.hasExtra(PackageInstaller.EXTRA_STATUS) || !intent.hasExtra(PackageInstaller.EXTRA_SESSION_ID)) return null
        val id = intent.getIntExtra(EXTRA_LVL_SESSION_ID, -1)
        if (id < 0 || id != intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -2)) return null
        val attemptId = intent.getStringExtra(EXTRA_LVL_ATTEMPT_ID) ?: return null
        val old = recorded(context) ?: return null
        if (old.id != attemptId || old.sessionId != id ||
            old.phase in setOf("confirmed", "failed", "cancelled")) return null
        if (intent.data != callbackData(context, old)) return null
        val session = runCatching { context.packageManager.packageInstaller.getSessionInfo(id) }.getOrNull()
        if (session != null && (session.installerPackageName != context.packageName ||
                (session.appPackageName != null && session.appPackageName != context.packageName))) return null
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -99) == PackageInstaller.STATUS_PENDING_USER_ACTION &&
            session == null) return null
        // Installation may have finished between callback delivery and this
        // receiver's wakeup. Reconcile only after the exact attempt/session
        // identity and callback URI are verified.
        val resolved = reconcile(context) ?: return null
        if (resolved.id != old.id || resolved.phase == "confirmed" ||
            (!resolved.pending && resolved.phase != "unknown")) return null
        return resolved
    }

    /** The exact installer session is required: an older result cannot fail a newer attempt. */
    @Volatile var onResult: ((Int, Boolean, String?) -> Unit)? = null

    /** Measured /data availability, not an estimate of Android's final install requirement. */
    fun availableBytes(context: Context): Long? =
        runCatching { StatFs(context.filesDir.absolutePath).availableBytes }.getOrNull()

    fun install(context: Context, apk: File, version: String, versionCode: Long, onSessionCreated: (Int) -> Unit) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            if (Build.VERSION.SDK_INT >= 34) setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
        }
        val id = installer.createSession(params)
        var attempt: Attempt? = null
        try {
            val created = begin(context, id, version, versionCode)
            attempt = created
            onSessionCreated(id)
            Log.i(TAG, "Created LVL APK install session $id, apkBytes=${apk.length()}, dataAvailableBytes=${availableBytes(context)}")
            installer.openSession(id).use { session ->
                session.openWrite("lvl.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, 1 shl 16) }
                    session.fsync(out)
                }
                // The system adds the result to this intent, so it must be mutable; it's explicit.
                val intent = Intent(context, InstallResultReceiver::class.java).setAction(ACTION_RESULT)
                    .setPackage(context.packageName).setData(callbackData(context, created))
                    .putExtra(EXTRA_LVL_SESSION_ID, id)
                    .putExtra(EXTRA_LVL_ATTEMPT_ID, created.id)
                val pending = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                transition(context, created.id, id, "committing")
                session.commit(pending.intentSender)
                Log.i(TAG, "Committed LVL APK install session $id")
            }
        } catch (error: Exception) {
            runCatching { installer.abandonSession(id) }
            attempt?.let { runCatching { transition(context, it.id, id, "failed", error.message ?: "Installation couldn't start") } }
            throw error
        }
    }

    internal fun channel(context: Context): String {
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "LVL updates", NotificationManager.IMPORTANCE_DEFAULT))
        return CHANNEL
    }

    internal fun notify(context: Context, id: Int, title: String, text: String, tap: PendingIntent) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(id, Notification.Builder(context, channel(context))
            .setSmallIcon(R.drawable.ic_stat_lvl)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build())
    }

    internal fun log(message: String) = Log.i(TAG, message)
}

/** Android's answer to an install: confirm with the user, or report the result. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val attempt = ApkInstall.acceptResult(context, intent) ?: return
        val sessionId = attempt.sessionId
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        ApkInstall.log("Install session $sessionId status $status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()}")
        val message = when (status) {
            PackageInstaller.STATUS_SUCCESS, PackageInstaller.STATUS_PENDING_USER_ACTION -> null
            PackageInstaller.STATUS_FAILURE_ABORTED -> "The update was cancelled"
            PackageInstaller.STATUS_FAILURE_STORAGE -> {
                val available = ApkInstall.availableBytes(context)
                "There isn't enough storage for the update" +
                    (available?.let { " (/data available: $it bytes)" } ?: "")
            }
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                "Android couldn't install this version over the installed one"
            else -> intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Android couldn't install the update"
        }
        val phase = when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> "awaiting-confirmation"
            PackageInstaller.STATUS_SUCCESS -> "reported-success"
            PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled"
            else -> "failed"
        }
        // The OS may instantiate this receiver without ever starting ServerService.
        // Commit the result before any UI launch or optional in-memory callback.
        if (ApkInstall.transition(context, attempt.id, sessionId, phase, message) == null) return
        // A replacement can become visible after acceptResult and before the
        // journal commit. The installed signed target wins over a late failure.
        val finalState = ApkInstall.reconcile(context)
        if (finalState?.phase == "confirmed") {
            ApkInstall.onResult?.invoke(sessionId, true, null)
            return
        }
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm == null) {
                    ApkInstall.transition(context, attempt.id, sessionId, "failed", "Android didn't ask to confirm the update")
                    ApkInstall.onResult?.invoke(sessionId, false, "Android didn't ask to confirm the update")
                    return
                }
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                val opened = MainActivity.visible && runCatching { context.startActivity(confirm) }.isSuccess
                if (!opened) {
                    // Away from LVL, Android doesn't let it open the confirmation: ask from a notification.
                    val tap = PendingIntent.getActivity(context, 7, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    ApkInstall.notify(context, 7, "Finish updating LVL", "Tap to install the new version", tap)
                }
            }
            else -> ApkInstall.onResult?.invoke(sessionId, status == PackageInstaller.STATUS_SUCCESS, message)
        }
    }
}

/** After LVL updated itself, Android has stopped it: offer to open the new version. */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        runCatching { ApkInstall.reconcile(context) }
            .onFailure { ApkInstall.log("Couldn't confirm the installed APK: ${it.javaClass.simpleName}") }
        val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty()
            .removeSuffix("-debug")
        val open = PendingIntent.getActivity(context, 8, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        ApkInstall.notify(context, 8, "LVL updated${if (version.isNotEmpty()) " to $version" else ""}", "Tap to open LVL", open)
    }
}
