package io.github.flegrear.lvl.updates

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle

/** A stale notification from attempt A cannot open confirmation for attempt B. */
class InstallConfirmationActivity : Activity() {
    companion object {
        const val ACTION_CONFIRM = "io.github.flegrear.lvl.UPDATE_CONFIRM"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            val request = intent ?: return
            if (request.action != ACTION_CONFIRM ||
                request.component?.className != javaClass.name ||
                request.component?.packageName != packageName ||
                request.`package` != packageName) return
            val sessionId = request.getIntExtra(ApkInstall.EXTRA_LVL_SESSION_ID, -1)
            val attemptId = request.getStringExtra(ApkInstall.EXTRA_LVL_ATTEMPT_ID) ?: return
            if (sessionId < 0 || request.data == null ||
                !ApkInstall.ownedConfirmation(this, attemptId, sessionId, request.data)) return
            val next: Intent? = if (Build.VERSION.SDK_INT >= 33)
                request.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            else {
                @Suppress("DEPRECATION")
                request.getParcelableExtra(Intent.EXTRA_INTENT)
            }
            val details = next ?: packageManager.packageInstaller
                .getSessionInfo(sessionId)?.createDetailsIntent() ?: return
            startActivity(details.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            // Android may retire the session after its journal was checked.
        } finally {
            finish()
        }
    }
}
