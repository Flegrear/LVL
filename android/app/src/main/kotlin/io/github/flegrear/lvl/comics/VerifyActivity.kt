package io.github.flegrear.lvl.comics

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
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
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import eu.kanade.tachiyomi.network.NetworkHelper
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * LVL's Verify screen for sites whose check needs a person (an interactive Cloudflare
 * Turnstile), like Mihon's WebView: the site opens with the same cookies and user agent as
 * the app's requests. Once the site shows its own page for two seconds, the check counts as
 * passed and the screen closes by itself; Done closes it at any time.
 */
class VerifyActivity : Activity() {
    companion object {
        private const val EXTRA_URL = "url"
        private val CHECK_TITLE = Regex(
            "just a moment|attention required|un momento|un instant|einen moment|ddos-guard|security check|verificaci[oó]n|checking your browser",
            RegexOption.IGNORE_CASE,
        )

        @Volatile var open = false
            private set
        @Volatile var passed = false
            private set
        @Volatile var finishedAt = 0L
            private set

        fun start(context: Context, url: String): Boolean {
            if (open) return true
            open = true
            passed = false
            context.startActivity(Intent(context, VerifyActivity::class.java).putExtra(EXTRA_URL, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return true
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var web: WebView
    private var clearSince = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            finish()
            return
        }
        val pad = (12 * resources.displayMetrics.density).toInt()
        val title = TextView(this).apply {
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
            webViewClient = WebViewClient()
            loadUrl(url)
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            fitsSystemWindows = true
            addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(web, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        })
        main.postDelayed(::watch, 1000)
    }

    // Passed: the page title isn't a check page any more, two seconds in a row.
    private fun watch() {
        if (isFinishing || isDestroyed) return
        val pageTitle = web.title.orEmpty()
        val onCheck = pageTitle.isBlank() || CHECK_TITLE.containsMatchIn(pageTitle) || web.progress < 100
        if (onCheck) {
            clearSince = 0
        } else if (clearSince == 0L) {
            clearSince = SystemClock.uptimeMillis()
        } else if (SystemClock.uptimeMillis() - clearSince >= 2000) {
            passed = true
            CookieManager.getInstance().flush()
            finish()
            return
        }
        main.postDelayed(::watch, 1000)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        CookieManager.getInstance().flush()
        if (::web.isInitialized) web.destroy()
        open = false
        finishedAt = System.currentTimeMillis()
        super.onDestroy()
    }
}
