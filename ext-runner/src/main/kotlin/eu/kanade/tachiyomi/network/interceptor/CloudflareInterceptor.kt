package eu.kanade.tachiyomi.network.interceptor

// LVL's extension runner. Extensions built on keiyoushi's core
// check that the default client has an interceptor with this name. Suwayomi's
// solves Cloudflare checks in a WebView (Chromium); the runner has none, so this
// one only recognises a check page and fails with a marked message. LVL then opens
// its own Verify window and sends the cookies and user agent back ("cookies" op),
// which the cookie jar and the user-agent interceptor apply to the next requests.

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

const val BROWSER_CHECK_MARK = "LVL-BROWSER-CHECK"

class CloudflareInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (!isCheck(response)) return response
        val host = chain.request().url.host
        response.close()
        throw IOException("$BROWSER_CHECK_MARK $host asks for a browser check")
    }

    private fun isCheck(response: Response): Boolean {
        if (response.code !in setOf(403, 429, 503)) return false
        if (response.header("cf-mitigated") == "challenge") return true
        if (!response.header("Server").orEmpty().contains("cloudflare", ignoreCase = true)) return false
        val head = runCatching { response.peekBody(64 * 1024).string() }.getOrDefault("")
        return head.contains("challenge-platform") || head.contains("cf-chl") || head.contains("Just a moment")
    }
}
