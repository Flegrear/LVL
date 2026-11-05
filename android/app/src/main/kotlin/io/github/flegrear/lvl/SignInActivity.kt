package io.github.flegrear.lvl

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Signing in to AniList from Settings › Library. On Windows LVL's own window goes to AniList
 * and AniList sends it back to LVL's page with the account token. In the app that page lives
 * in the main WebView, which only shows LVL itself (other sites open in the browser, where the
 * token couldn't reach LVL). So AniList's pages open here, in a separate WebView without the
 * app's bridge, and the return to LVL's callback page goes back to the main WebView, which
 * finishes the sign-in as on Windows. Cancel closes the screen without signing in.
 */
class SignInActivity : Activity() {
    companion object {
        private const val EXTRA_URL = "url"
        private const val EXTRA_RETURN = "return"

        /** Pages that start a sign-in here instead of in the browser. */
        fun handles(uri: Uri): Boolean =
            uri.scheme == "https" && uri.host == "anilist.co" && uri.path.orEmpty().startsWith("/api/v2/oauth/authorize")

        fun intent(context: Context, url: Uri, returnPrefix: String): Intent =
            Intent(context, SignInActivity::class.java)
                .putExtra(EXTRA_URL, url.toString())
                .putExtra(EXTRA_RETURN, returnPrefix)
    }

    private lateinit var web: WebView
    private var returnPrefix = ""

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = Uri.parse(intent.getStringExtra(EXTRA_URL).orEmpty())
        returnPrefix = intent.getStringExtra(EXTRA_RETURN).orEmpty()
        if (!handles(url) || !returnPrefix.startsWith("http://127.0.0.1:")) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }
        val pad = (12 * resources.displayMetrics.density).toInt()
        val title = TextView(this).apply {
            text = "Sign in to AniList"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER_VERTICAL
        }
        val cancel = Button(this).apply {
            text = "Cancel"
            setOnClickListener {
                setResult(RESULT_CANCELED)
                finish()
            }
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.BLACK)
            setPadding(pad, pad / 2, pad / 2, pad / 2)
            addView(title, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(cancel, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = SignInClient()
            loadUrl(url.toString())
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            fitsSystemWindows = true
            addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(web, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        })
    }

    // The return to LVL's callback page ends the sign-in; it's handed to the main WebView,
    // never loaded here (this WebView has no access to LVL).
    private fun returned(url: String): Boolean {
        if (!url.startsWith(returnPrefix)) return false
        setResult(RESULT_OK, Intent().setData(Uri.parse(url)))
        finish()
        return true
    }

    private inner class SignInClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (returned(url)) return true
            // Sign-in pages stay here; anything that isn't a web page (mail links) opens outside.
            if (request.url.scheme == "https") return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            if (returned(url)) view.stopLoading()
        }
    }

    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack()
        else {
            setResult(RESULT_CANCELED)
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }
}
