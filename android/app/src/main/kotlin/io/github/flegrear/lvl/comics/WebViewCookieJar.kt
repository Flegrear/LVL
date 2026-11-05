package io.github.flegrear.lvl.comics

import android.webkit.CookieManager
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * OkHttp cookies kept in the WebView's CookieManager, as Mihon does: a browser check
 * solved in a WebView (cf_clearance) then applies to the extensions' own requests.
 */
class WebViewCookieJar : CookieJar {
    private val manager: CookieManager? by lazy { runCatching { CookieManager.getInstance() }.getOrNull() }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val manager = manager ?: return
        val target = url.toString()
        for (cookie in cookies) manager.setCookie(target, cookie.toString())
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val header = manager?.getCookie(url.toString()) ?: return emptyList()
        return header.split(';').mapNotNull { Cookie.parse(url, it.trim()) }
    }

    /** One cookie's value for the url, or null. */
    fun value(url: HttpUrl, name: String): String? =
        loadForRequest(url).firstOrNull { it.name == name }?.value

    /** Cookies LVL got elsewhere (a check solved in its own window), as Set-Cookie strings. */
    fun add(url: HttpUrl, setCookies: List<String>): Int {
        val manager = manager ?: return 0
        val target = url.toString()
        var added = 0
        for (text in setCookies) {
            if (Cookie.parse(url, text) == null) continue
            manager.setCookie(target, text)
            added += 1
        }
        manager.flush()
        return added
    }
}
