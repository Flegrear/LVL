package io.github.flegrear.lvl

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * WebMessageListener supplies both the sender's origin AND isMainFrame, which
 * addJavascriptInterface cannot provide. The adapter is installed at document
 * start, before any phone feature tries to detect window.LvlAndroid.
 */
object TrustedWebBridge {
    private const val MESSAGE_LIMIT = 70_100_000
    private val ACTIONS = setOf(
        "playbackState", "enterPictureInPicture", "setFullscreen",
        "setReaderImmersive", "saveDownload", "downloadFailed",
    )

    fun allowChildFrameNavigation(scheme: String?): Boolean =
        scheme in setOf("http", "https", "about")

    fun allowExternalTopFrame(scheme: String?): Boolean =
        scheme in setOf("http", "https", "mailto", "tel", "market")

    fun admitted(origin: String, isMainFrame: Boolean, expectedOrigin: String, action: String): Boolean =
        isMainFrame && origin == expectedOrigin && action in ACTIONS

    fun install(web: WebView, expectedOrigin: String, authorized: () -> Boolean, dispatch: (String, org.json.JSONArray) -> Unit): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return false
        val rules = setOf(expectedOrigin)
        return runCatching {
            WebViewCompat.addWebMessageListener(web, "LvlNativeBridge", rules) { view, message, sourceOrigin: Uri, isMainFrame, _ ->
                if (view !== web || !isMainFrame || sourceOrigin.toString() != expectedOrigin || !authorized()) return@addWebMessageListener
                val text = message.data ?: return@addWebMessageListener
                if (text.length > MESSAGE_LIMIT) return@addWebMessageListener
                val payload = runCatching { JSONObject(text) }.getOrNull() ?: return@addWebMessageListener
                val action = payload.optString("action", "")
                if (!admitted(sourceOrigin.toString(), isMainFrame, expectedOrigin, action)) return@addWebMessageListener
                val args = payload.optJSONArray("args") ?: return@addWebMessageListener
                runCatching { dispatch(action, args) }
            }
            WebViewCompat.addDocumentStartJavaScript(web, ADAPTER, rules)
        }.isSuccess
    }

    // The approved LVL top-frame application scripts are trusted. Untrusted
    // embedded content must stay cross-origin or opaque/sandboxed: a same-origin
    // child can legally invoke its parent's public API, which isMainFrame
    // attributes to the parent. Direct calls from any child frame are rejected.
    private val ADAPTER = """
        (() => {
          if (window.LvlAndroid || !window.LvlNativeBridge?.postMessage) return;
          const send = (action, args) => {
            try { window.LvlNativeBridge.postMessage(JSON.stringify({ action, args })); } catch (_) {}
          };
          const api = Object.freeze({
            playbackState: (v) => send('playbackState', [String(v)]),
            enterPictureInPicture: () => send('enterPictureInPicture', []),
            setFullscreen: (v) => send('setFullscreen', [Boolean(v)]),
            setReaderImmersive: (v) => send('setReaderImmersive', [Boolean(v)]),
            saveDownload: (n, m, b) => send('saveDownload', [String(n), String(m), String(b)]),
            downloadFailed: (n, m) => send('downloadFailed', [String(n), String(m)])
          });
          Object.defineProperty(window, 'LvlAndroid', { value: api, configurable: false, writable: false });
        })();
    """.trimIndent()
}
