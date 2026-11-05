package eu.kanade.tachiyomi.network.interceptor

// LVL's Android extension host. Extensions built on keiyoushi's core check that the
// default client has an interceptor with this name. As in Mihon, a Cloudflare check page is
// solved in a hidden WebView that shares its cookies with OkHttp (CookieManager), and the
// request is sent again. A check the WebView can't pass by itself (an interactive
// Turnstile) fails with a marked message, as on the desktop: LVL then reports that the site
// asks for a browser check.

import android.content.Context
import io.github.flegrear.lvl.comics.CloudflareSolver
import io.github.flegrear.lvl.comics.WebViewCookieJar
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

const val BROWSER_CHECK_MARK = "LVL-BROWSER-CHECK"

class CloudflareInterceptor(
    private val context: Context,
    private val cookieJar: WebViewCookieJar,
    private val userAgent: () -> String,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val response = chain.proceed(request)
        if (!isCheck(response)) return response
        response.close()
        val old = cookieJar.value(request.url, "cf_clearance")
        val agent = request.header("User-Agent") ?: userAgent()
        if (!CloudflareSolver.solve(context, request.url.toString(), agent, old)) {
            throw IOException("$BROWSER_CHECK_MARK ${request.url.host} asks for a browser check")
        }
        val again = chain.proceed(request)
        if (!isCheck(again)) return again
        again.close()
        throw IOException("$BROWSER_CHECK_MARK ${request.url.host} asks for a browser check")
    }

    private fun isCheck(response: Response): Boolean {
        if (response.code !in setOf(403, 429, 503)) return false
        if (response.header("cf-mitigated") == "challenge") return true
        if (!response.header("Server").orEmpty().contains("cloudflare", ignoreCase = true)) return false
        val head = runCatching { response.peekBody(64 * 1024).string() }.getOrDefault("")
        return head.contains("challenge-platform") || head.contains("cf-chl") || head.contains("Just a moment")
    }
}
