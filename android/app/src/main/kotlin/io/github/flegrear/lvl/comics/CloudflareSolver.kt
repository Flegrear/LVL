package io.github.flegrear.lvl.comics

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Hidden, single-owner WebView challenge. Never block the main thread. Any
 * intervening visible verification (even one already closed) invalidates the
 * hidden challenge's ownership of both WebView callbacks and cookie results.
 */
object CloudflareSolver {
    private const val TIMEOUT_MS = 30_000L
    private const val MAIN_HANDOFF_MS = 2_500L
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()

    private class HiddenSession(val revision: Long) {
        @Volatile var cancelled = false
        var view: WebView? = null // main thread only
    }

    // A timed-out posted callback must not resurrect an abandoned WebView.
    // The ownership check and all WebView/CookieManager operations run on main.
    private fun <T> onMain(session: HiddenSession, action: () -> T?): T? {
        val finished = CountDownLatch(1)
        val value = AtomicReference<T?>()
        if (!main.post {
                try {
                    if (!session.cancelled && VerifyActivity.isIdleRevision(session.revision))
                        value.set(action())
                } catch (_: RuntimeException) {
                    // No ambiguous WebView/cookie result can grant clearance.
                } finally {
                    finished.countDown()
                }
            }) return null
        try {
            if (!finished.await(MAIN_HANDOFF_MS, TimeUnit.MILLISECONDS)) {
                session.cancelled = true
                return null
            }
        } catch (_: InterruptedException) {
            session.cancelled = true
            Thread.currentThread().interrupt()
            return null
        }
        return value.get()
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun solve(context: Context, url: String, userAgent: String, oldClearance: String?): Boolean {
        check(Looper.myLooper() != Looper.getMainLooper()) { "CloudflareSolver.solve can't run on the main thread" }
        synchronized(lock) {
            val initial = VerifyActivity.state
            if (initial.open) return false
            val session = HiddenSession(initial.revision)
            val started = SystemClock.uptimeMillis()
            var solved = false
            try {
                val created = onMain(session) {
                    val webView = WebView(context.applicationContext)
                    session.view = webView
                    webView.apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.userAgentString = userAgent
                        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                        webViewClient = WebViewClient()
                        loadUrl(url)
                    }
                    true
                }
                if (created != true) return false
                while (SystemClock.uptimeMillis() - started < TIMEOUT_MS) {
                    if (session.cancelled || !VerifyActivity.isIdleRevision(session.revision)) break
                    Thread.sleep(500)
                    val clearance = onMain(session) {
                        if (session.view == null) null
                        else cookieValue(CookieManager.getInstance().getCookie(url), "cf_clearance")
                    }
                    if (clearance != null && clearance != oldClearance) {
                        // Reject a cookie minted by a newer visible generation.
                        solved = VerifyActivity.isIdleRevision(session.revision) && !session.cancelled
                        break
                    }
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } finally {
                session.cancelled = true
                main.post {
                    session.view?.stopLoading()
                    session.view?.destroy()
                    session.view = null
                    runCatching { CookieManager.getInstance().flush() }
                }
            }
            // Do not expose a query string, account token or credential in logs.
            Log.i("LVL-Comics", "Hidden browser check ${if (solved) "passed" else "not passed"} in ${SystemClock.uptimeMillis() - started} ms")
            return solved
        }
    }

    private fun cookieValue(header: String?, name: String): String? =
        header?.split(';')?.map { it.trim() }?.firstOrNull { it.startsWith("$name=") }?.substringAfter('=')
}
