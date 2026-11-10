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

/**
 * Passes a Cloudflare check the way Mihon does: the page loads in a hidden WebView with
 * the same user agent as the request, and the check counts as passed when the site sets a
 * new cf_clearance cookie (shared with OkHttp through CookieManager). One check at a time.
 * Never call it on the main thread: it waits for the WebView, which lives there.
 */
object CloudflareSolver {
    private const val TIMEOUT_MS = 30_000L
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()

    @SuppressLint("SetJavaScriptEnabled")
    fun solve(context: Context, url: String, userAgent: String, oldClearance: String?): Boolean {
        check(Looper.myLooper() != Looper.getMainLooper()) { "CloudflareSolver.solve can't run on the main thread" }
        synchronized(lock) {
            // An interactive check owns the site's verification session while it is open.
            // Do not launch a competing hidden browser that might retrigger the challenge.
            if (VerifyActivity.open) return false
            val cookies = runCatching { CookieManager.getInstance() }.getOrNull() ?: return false
            var view: WebView? = null
            main.post {
                if (VerifyActivity.open) return@post
                view = WebView(context.applicationContext).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.userAgentString = userAgent
                    cookies.setAcceptThirdPartyCookies(this, true)
                    webViewClient = WebViewClient()
                    loadUrl(url)
                }
            }
            val started = SystemClock.uptimeMillis()
            var solved = false
            try {
                while (SystemClock.uptimeMillis() - started < TIMEOUT_MS) {
                    if (VerifyActivity.open) break
                    Thread.sleep(500)
                    val clearance = cookieValue(cookies.getCookie(url), "cf_clearance")
                    if (clearance != null && clearance != oldClearance) {
                        solved = true
                        break
                    }
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } finally {
                main.post {
                    view?.stopLoading()
                    view?.destroy()
                }
                cookies.flush()
            }
            Log.i("LVL-Comics", "Browser check for $url ${if (solved) "passed" else "not passed"} in ${SystemClock.uptimeMillis() - started} ms")
            return solved
        }
    }

    private fun cookieValue(header: String?, name: String): String? =
        header?.split(';')?.map { it.trim() }?.firstOrNull { it.startsWith("$name=") }?.substringAfter('=')
}
