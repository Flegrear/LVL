package io.github.flegrear.lvl

import android.app.Activity
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast

/**
 * window.LvlAndroid in the page (frontend/phone/android-bridge.js). The WebView only ever
 * shows LVL's own pages from 127.0.0.1 (other addresses open outside the app), so only LVL
 * calls these. They run on the WebView's bridge thread; everything that touches the UI is
 * posted to the main thread.
 */
class WebBridge(
    private val activity: Activity,
    private val onPlayback: (Playback) -> Unit,
    private val onPictureInPicture: () -> Unit,
    private val onFullscreen: (Boolean) -> Unit = {},
    private val onReaderImmersive: (Boolean) -> Unit = {},
) {
    @JavascriptInterface
    fun playbackState(json: String) {
        val playback = Playback.parse(json)
        activity.runOnUiThread { onPlayback(playback) }
    }

    @JavascriptInterface
    fun enterPictureInPicture() {
        activity.runOnUiThread { onPictureInPicture() }
    }

    /** The player's fullscreen: the app hides the system bars and turns the screen. */
    @JavascriptInterface
    fun setFullscreen(on: Boolean) {
        activity.runOnUiThread { onFullscreen(on) }
    }

    /** Only the comic reader requests immersive system bars; page content stays visible. */
    @JavascriptInterface
    fun setReaderImmersive(on: Boolean) {
        activity.runOnUiThread { onReaderImmersive(on) }
    }

    @JavascriptInterface
    fun saveDownload(name: String, mimeType: String, base64: String) {
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            Downloads.save(activity, name, mimeType, bytes)
            toast("Saved to Downloads: ${Downloads.safeName(name)}")
        } catch (error: Exception) {
            Log.w("LVL", "Download failed: $name", error)
            toast("Couldn't save ${Downloads.safeName(name)}: ${error.message}")
        }
    }

    @JavascriptInterface
    fun downloadFailed(name: String, message: String) {
        toast("Couldn't save ${Downloads.safeName(name)}: ${message.take(120)}")
    }

    private fun toast(text: String) {
        activity.runOnUiThread { Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }
    }
}
