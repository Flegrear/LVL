package io.github.flegrear.lvl

import android.app.Activity
import android.util.Log
import android.widget.Toast
import org.json.JSONArray

/** Native operations reached only through TrustedWebBridge's checked top-frame listener. */
class WebBridge(
    private val activity: Activity,
    private val onPlayback: (Playback) -> Unit,
    private val onPictureInPicture: () -> Unit,
    private val onFullscreen: (Boolean) -> Unit = {},
    private val onReaderImmersive: (Boolean) -> Unit = {},
) {
    fun dispatch(action: String, args: JSONArray) {
        when (action) {
            "playbackState" -> if (args.length() == 1 && args.opt(0) is String) {
                val json = args.getString(0)
                if (json.length <= 12_000) runCatching { onPlayback(Playback.parse(json)) }
            }
            "enterPictureInPicture" -> if (args.length() == 0) onPictureInPicture()
            "setFullscreen" -> if (args.length() == 1 && args.opt(0) is Boolean) onFullscreen(args.getBoolean(0))
            "setReaderImmersive" -> if (args.length() == 1 && args.opt(0) is Boolean) onReaderImmersive(args.getBoolean(0))
            "saveDownload" -> if (args.length() == 3 && (0..2).all { args.opt(it) is String }) {
                val name = args.getString(0).take(255)
                val mime = args.getString(1).take(128)
                val base64 = args.getString(2)
                if (base64.length <= Downloads.MAX_BASE64_CHARS) {
                    kotlin.concurrent.thread(name = "lvl-save-download") { saveDownload(name, mime, base64) }
                } else downloadFailed(name, "The file is too large to save")
            }
            "downloadFailed" -> if (args.length() == 2 && args.opt(0) is String && args.opt(1) is String)
                downloadFailed(args.getString(0).take(255), args.getString(1).take(120))
        }
    }

    private fun saveDownload(name: String, mimeType: String, base64: String) {
        try {
            Downloads.saveBase64(activity, name, mimeType, base64)
            toast("Saved to Downloads: ${Downloads.safeName(name)}")
        } catch (error: Exception) {
            Log.w("LVL", "Download failed: $name", error)
            toast("Couldn't save ${Downloads.safeName(name)}: ${error.message}")
        }
    }

    private fun downloadFailed(name: String, message: String) {
        toast("Couldn't save ${Downloads.safeName(name)}: ${message.take(120)}")
    }

    private fun toast(text: String) {
        activity.runOnUiThread { Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }
    }
}
