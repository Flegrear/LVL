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
import android.os.Build
import android.os.StatFs
import android.util.Log
import io.github.flegrear.lvl.MainActivity
import io.github.flegrear.lvl.R
import java.io.File

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
    private const val CHANNEL = "updates"

    /** The exact installer session is required: an older result cannot fail a newer attempt. */
    @Volatile var onResult: ((Int, Boolean, String?) -> Unit)? = null

    /** Measured /data availability, not an estimate of Android's final install requirement. */
    fun availableBytes(context: Context): Long? =
        runCatching { StatFs(context.filesDir.absolutePath).availableBytes }.getOrNull()

    fun install(context: Context, apk: File, onSessionCreated: (Int) -> Unit) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            if (Build.VERSION.SDK_INT >= 34) setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
        }
        val id = installer.createSession(params)
        try {
            onSessionCreated(id)
            Log.i(TAG, "Created LVL APK install session $id, apkBytes=${apk.length()}, dataAvailableBytes=${availableBytes(context)}")
            installer.openSession(id).use { session ->
                session.openWrite("lvl.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, 1 shl 16) }
                    session.fsync(out)
                }
                // The system adds the result to this intent, so it must be mutable; it's explicit.
                val intent = Intent(context, InstallResultReceiver::class.java).setAction(ACTION_RESULT)
                    .setPackage(context.packageName).putExtra(EXTRA_LVL_SESSION_ID, id)
                val pending = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                session.commit(pending.intentSender)
                Log.i(TAG, "Committed LVL APK install session $id")
            }
        } catch (error: Exception) {
            runCatching { installer.abandonSession(id) }
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
        val sessionId = intent.getIntExtra(ApkInstall.EXTRA_LVL_SESSION_ID, -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        ApkInstall.log("Install session $sessionId status $status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()}")
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm == null) {
                    ApkInstall.onResult?.invoke(sessionId, false, "Android didn't ask to confirm the update")
                    return
                }
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (MainActivity.visible) {
                    context.startActivity(confirm)
                } else {
                    // Away from LVL, Android doesn't let it open the confirmation: ask from a notification.
                    val tap = PendingIntent.getActivity(context, 7, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    ApkInstall.notify(context, 7, "Finish updating LVL", "Tap to install the new version", tap)
                }
            }
            PackageInstaller.STATUS_SUCCESS -> ApkInstall.onResult?.invoke(sessionId, true, null)
            PackageInstaller.STATUS_FAILURE_ABORTED -> ApkInstall.onResult?.invoke(sessionId, false, "The update was cancelled")
            PackageInstaller.STATUS_FAILURE_STORAGE -> {
                val observed = ApkInstall.availableBytes(context)
                val detail = observed?.let { " (/data available at failure: $it bytes; Android may need more)" }.orEmpty()
                ApkInstall.onResult?.invoke(sessionId, false, "There isn't enough storage for the update$detail")
            }
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                ApkInstall.onResult?.invoke(sessionId, false, "Android couldn't install this version over the installed one")
            else -> ApkInstall.onResult?.invoke(sessionId, false, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Android couldn't install the update")
        }
    }
}

/** After LVL updated itself, Android has stopped it: offer to open the new version. */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty()
            .removeSuffix("-debug")
        val open = PendingIntent.getActivity(context, 8, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        ApkInstall.notify(context, 8, "LVL updated${if (version.isNotEmpty()) " to $version" else ""}", "Tap to open LVL", open)
    }
}
