package io.github.flegrear.lvl.comics

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import eu.kanade.tachiyomi.network.NetworkHelper
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.lang.ref.WeakReference

/**
 * LVL's Verify screen for sites whose check needs a person (an interactive Cloudflare
 * Turnstile), like Mihon's WebView: the site opens with the same cookies and user agent as
 * the app's requests. A successful Cloudflare check needs its clearance cookie as well as
 * the site's page; Done always closes the screen without claiming a check succeeded.
 */
class VerifyActivity : Activity() {
    companion object {
        private const val EXTRA_URL = "url"
        private const val EXTRA_GENERATION = "generation"
        private const val PENDING_TIMEOUT_MS = 15_000L
        private val CHECK_TITLE = Regex(
            "just a moment|attention required|un momento|un instant|einen moment|ddos-guard|security check|verificaci[oó]n|checking your browser",
            RegexOption.IGNORE_CASE,
        )

        private val sessions = VerifySessionState(SystemClock::uptimeMillis, PENDING_TIMEOUT_MS)
        val open: Boolean get() = sessions.snapshot().open
        val passed: Boolean get() = sessions.snapshot().passed
        val finishedAt: Long get() = sessions.snapshot().finishedAt
        internal val state: VerifySessionState.Snapshot get() = sessions.snapshot()
        // A completed visible session still invalidates work started before it.
        // Unlike snapshot.open/generation, this revision is never reset on close.
        internal fun isIdleRevision(revision: Long): Boolean =
            sessions.isIdleRevision(revision)
        // The same native session monitor serializes visible verification
        // transitions with the cookies RPC's synchronous mutation producer.
        // This is not an attestation of asynchronous WebView persistence.
        internal fun <T> withIdleRevision(revision: Long, write: () -> T): T? =
            sessions.withIdleRevision(revision, write)

        fun start(context: Context, url: String): Boolean {
            val address = Uri.parse(url)
            if ((address.scheme != "http" && address.scheme != "https") || address.host.isNullOrBlank()) return false
            val generation = sessions.begin(url) ?: return true
            try {
                context.startActivity(
                    Intent(context, VerifyActivity::class.java)
                        .putExtra(EXTRA_URL, url)
                        .putExtra(EXTRA_GENERATION, generation)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                )
            } catch (error: RuntimeException) {
                sessions.launchFailed(generation)
                throw error
            }
            // startActivity accepts a request before the OS creates or reuses the screen.
            // A generation-fenced timeout prevents a lost launch from blocking requests forever.
            Handler(Looper.getMainLooper()).postDelayed({ sessions.expire(generation) }, PENDING_TIMEOUT_MS)
            return true
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var web: WebView
    private lateinit var title: TextView
    private var verificationGeneration = -1L
    private var clearSince = 0L
    private var sawChallenge = false
    private var initialClearance: String? = null

    private fun clearance(url: String): String? =
        CookieManager.getInstance().getCookie(url)
            ?.split(';')
            ?.map { it.trim() }
            ?.firstOrNull { it.startsWith("cf_clearance=") }
            ?.substringAfter('=')
            ?.takeIf { it.isNotBlank() }

    private fun isSitePage(url: String): Boolean {
        val address = Uri.parse(url)
        return address.host?.isNotBlank() == true &&
            (address.scheme.equals("https", ignoreCase = true) || address.scheme.equals("http", ignoreCase = true))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        val generation = intent.getLongExtra(EXTRA_GENERATION, -1L)
        if (!isSitePage(url) || !sessions.attach(generation, url, this, savedInstanceState != null)) {
            finish()
            return
        }
        verificationGeneration = generation
        initialClearance = clearance(url)
        val pad = (12 * resources.displayMetrics.density).toInt()
        title = TextView(this).apply {
            text = "Verify ${android.net.Uri.parse(url).host.orEmpty()}"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER_VERTICAL
        }
        val done = Button(this).apply {
            text = "Done"
            setOnClickListener { finish() }
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.BLACK)
            setPadding(pad, pad / 2, pad / 2, pad / 2)
            addView(title, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(done, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.userAgentString = runCatching { Injekt.get<NetworkHelper>().defaultUserAgentProvider() }.getOrNull() ?: settings.userAgentString
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    clearSince = 0L
                }

                override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, response: WebResourceResponse?) {
                    val status = response?.statusCode
                    if (request?.isForMainFrame == true && (status == 403 || status == 429 || status == 503)) sawChallenge = true
                }
            }
            loadUrl(url)
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            fitsSystemWindows = true
            addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(web, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        })
        scheduleWatch(generation)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        val generation = intent.getLongExtra(EXTRA_GENERATION, -1L)
        if (!isSitePage(url) || !sessions.attach(generation, url, this, false)) return
        setIntent(intent)
        verificationGeneration = generation
        // An old poll must never execute against a newer intent's mutable web
        // state and accidentally complete the new generation.
        main.removeCallbacksAndMessages(null)
        clearSince = 0L
        sawChallenge = false
        initialClearance = clearance(url)
        if (::title.isInitialized) title.text = "Verify ${Uri.parse(url).host.orEmpty()}"
        if (::web.isInitialized) {
            web.stopLoading()
            web.loadUrl(url)
        }
        scheduleWatch(generation)
    }

    private fun scheduleWatch(generation: Long) {
        main.postDelayed({ watch(generation) }, 1000)
    }

    // A normal-looking title alone can belong to a challenge or an error page. Wait for
    // a stable page and a clearance cookie usable by OkHttp. Sites may redirect to a
    // different canonical domain before solving the challenge.
    private fun watch(generation: Long) {
        if (isFinishing || isDestroyed || generation != verificationGeneration ||
            !sessions.isCurrent(generation, this)) return
        val pageTitle = web.title.orEmpty()
        val currentUrl = web.url.orEmpty()
        val challengeTitle = CHECK_TITLE.containsMatchIn(pageTitle)
        if (challengeTitle) sawChallenge = true
        val cookie = if (currentUrl.isNotBlank()) clearance(currentUrl) else null
        val hasClearance = cookie != null && (!sawChallenge || cookie != initialClearance)
        val onCheck = pageTitle.isBlank() || challengeTitle || web.progress < 100 ||
            !isSitePage(currentUrl) || Uri.parse(currentUrl).path.orEmpty().startsWith("/cdn-cgi/") ||
            !hasClearance
        if (onCheck) {
            clearSince = 0
        } else if (clearSince == 0L) {
            clearSince = SystemClock.uptimeMillis()
        } else if (SystemClock.uptimeMillis() - clearSince >= 2000) {
            if (sessions.complete(generation, this)) {
                CookieManager.getInstance().flush()
                finish()
            }
            return
        }
        scheduleWatch(generation)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        CookieManager.getInstance().flush()
        if (::web.isInitialized) {
            web.stopLoading()
            web.destroy()
        }
        sessions.destroyed(verificationGeneration, this, System.currentTimeMillis())
        super.onDestroy()
    }
}

