package io.github.flegrear.lvl

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Shows LVL's own web UI from the server that ServerService runs on this device. */
class MainActivity : Activity() {
    companion object {
        private const val REQUEST_FILES = 41
        private const val REQUEST_SIGN_IN = 42

        /** True while LVL is on screen (Android then lets it open the update confirmation). */
        @Volatile var visible = false
            private set
    }

    private val base = "http://127.0.0.1:${ServerService.PORT}"
    private val main = Handler(Looper.getMainLooper())
    private val chrome = LvlChromeClient()
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var statusBox: ScrollView
    private lateinit var status: TextView
    private lateinit var retryStartupButton: Button
    private lateinit var controls: PlaybackControls
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var inPictureInPicture = false
    private var pictureInPictureEndedAt = 0L
    private var stopped = false
    @Volatile private var waiting = false
    @Volatile private var waitGeneration = 0
    private var ignoredFailureRevision: Long? = null
    private var cookieReady = false
    private var cookieFailed = false
    private var serverReady = false
    private var navigationStarted = false

    private fun startup(event: String) {
        Log.i("LVL-Startup", "event=$event t_ms=${SystemClock.elapsedRealtime()}")
    }

    private val mediaReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                PlaybackControls.ACTION -> controls.handle(intent)
                // Headphones unplugged or Bluetooth gone: pause rather than play out loud.
                AudioManager.ACTION_AUDIO_BECOMING_NOISY -> if (controls.current.playing) sendMedia("pause", null)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startup("activity_on_create")
        // Queue the service before creating WebView, which can be expensive on a cold process.
        ServerService.start(this)
        startup("service_launch_requested")
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        controls = PlaybackControls(this) { command, value -> sendMedia(command, value) }

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.userAgentString = settings.userAgentString + " LVL-Android/" +
                packageManager.getPackageInfo(packageName, 0).versionName
            webViewClient = LvlWebViewClient()
            webChromeClient = chrome
            addJavascriptInterface(WebBridge(this@MainActivity, { onPlayback(it) }, { enterPictureInPicture() },
                { setAppFullscreen(it) }, { setReaderImmersive(it) }), "LvlAndroid")
            setDownloadListener { url, _, contentDisposition, mimeType, _ -> download(url, contentDisposition, mimeType) }
            visibility = View.INVISIBLE
        }
        startup("webview_created")
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            text = getString(R.string.starting)
        }
        retryStartupButton = Button(this).apply {
            text = getString(R.string.retry_start)
            visibility = View.GONE
            setOnClickListener { retryStartup() }
        }
        val startupPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(status, LinearLayout.LayoutParams(MATCH_PARENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(retryStartupButton, LinearLayout.LayoutParams(android.view.ViewGroup.LayoutParams.WRAP_CONTENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        statusBox = ScrollView(this).apply {
            isFillViewport = true
            addView(startupPanel, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        root.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(statusBox, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setContentView(root)

        // Android 15+ draws apps edge to edge; until the UI handles safe areas itself, keep it
        // clear of the system bars, cutouts and the keyboard. Fullscreen video and
        // picture-in-picture use the whole window.
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
            if (customView == null && !inPictureInPicture && !appFullscreen && !readerImmersive) view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            else view.setPadding(0, 0, 0, 0)
            WindowInsets.CONSUMED
        }

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBack() }
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }
        registerReceiver(
            mediaReceiver,
            IntentFilter().apply {
                addAction(PlaybackControls.ACTION)
                addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
            },
            Context.RECEIVER_NOT_EXPORTED,
        )

        // Health probing can overlap WebView cookie initialization. Navigation still
        // waits for both independent prerequisites in maybeNavigate().
        waitForServer()
        // The server's access key, as a cookie only LVL's own pages send (JavaScript can't read it).
        // The callback is the write barrier for navigation; flush() blocks the UI thread on disk.
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setCookie(base, "lvl_access=${ServerService.accessToken}; Path=/; HttpOnly; SameSite=Strict") { accepted ->
                if (isDestroyed || isFinishing) return@setCookie
                if (!accepted) {
                    cookieFailed = true
                    waiting = false
                    Log.e("LVL", "Couldn't set the local server access cookie")
                    status.text = "Couldn't configure LVL's secure connection. Reopen the app to retry."
                    return@setCookie
                }
                cookieReady = true
                startup("cookie_ready")
                maybeNavigate()
            }
        }
    }

    private fun maybeNavigate() {
        if (!cookieReady || !serverReady || navigationStarted || isDestroyed || isFinishing) return
        navigationStarted = true
        startup("webview_navigation")
        web.loadUrl("$base/home")
    }

    override fun onStart() {
        super.onStart()
        stopped = false
        visible = true
    }

    override fun onStop() {
        stopped = true
        visible = false
        if (readerImmersive) setReaderImmersive(false)
        // Closing the picture-in-picture window stops the activity: pause instead of playing unseen.
        if (inPictureInPicture || SystemClock.uptimeMillis() - pictureInPictureEndedAt < 1500) sendMedia("pause", null)
        super.onStop()
    }

    override fun onDestroy() {
        waiting = false
        waitGeneration += 1
        try { unregisterReceiver(mediaReceiver) } catch (_: IllegalArgumentException) {}
        controls.release()
        web.destroy()
        super.onDestroy()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPictureInPicture = isInPictureInPictureMode
        if (!isInPictureInPictureMode) pictureInPictureEndedAt = SystemClock.uptimeMillis()
        root.requestApplyInsets()
        web.evaluateJavascript("window.lvlAndroid && window.lvlAndroid.pip($isInPictureInPictureMode)", null)
        if (!isInPictureInPictureMode && stopped) sendMedia("pause", null)
    }

    @Deprecated("Back handling for Android 12; Android 13+ uses the OnBackInvokedCallback above")
    override fun onBackPressed() {
        goBack()
    }

    @Deprecated("Activity result for the file chooser")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_SIGN_IN) {
            // LVL's callback page reads the token from the address and finishes the sign-in.
            val back = data?.data?.toString().orEmpty()
            if (resultCode == RESULT_OK && back.startsWith("$base/anilist/callback")) web.loadUrl(back)
            return
        }
        if (requestCode != REQUEST_FILES) return super.onActivityResult(requestCode, resultCode, data)
        val callback = fileCallback ?: return
        fileCallback = null
        val picked = if (resultCode != RESULT_OK || data == null) emptyList() else buildList {
            val clip = data.clipData
            if (clip != null) for (i in 0 until clip.itemCount) add(clip.getItemAt(i).uri)
            else data.data?.let(::add)
        }
        callback.onReceiveValue(picked.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    private fun goBack() {
        if (readerImmersive) {
            setReaderImmersive(false)
            return
        }
        if (appFullscreen) {
            setAppFullscreen(false)
            return
        }
        if (customView != null) {
            chrome.onHideCustomView()
            return
        }
        // The page closes a dialog, menu or fullscreen first; only then does Back leave the page.
        web.evaluateJavascript("(function(){try{return !!(window.lvlAndroid && window.lvlAndroid.back())}catch(e){return false}})()") { handled ->
            if (handled == "true") return@evaluateJavascript
            if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
        }
    }

    private fun sendMedia(command: String, value: Double?) {
        val argument = value?.takeIf { it.isFinite() }?.toString() ?: "null"
        web.evaluateJavascript("window.lvlAndroid && window.lvlAndroid.media(${JSONObject.quote(command)}, $argument)", null)
    }

    private var lastPlayback = Playback()

    // The player's fullscreen in the app (android-bridge.js): the page lays the video over the
    // whole window (html.android-fullscreen) and the app hides the system bars and turns the
    // screen. Unlike the web Fullscreen API it needs no tap at that moment, so it also works
    // when a torrent takes a while to start, and when the phone is turned.
    private var appFullscreen = false
    private var readerImmersive = false
    private var fullscreenByRotation = false
    // Turning the phone sideways opens fullscreen again only after it has been upright: after
    // leaving fullscreen while it's held sideways, the page stays as it is.
    private var rotationArmed = true

    private fun setAppFullscreen(on: Boolean, byRotation: Boolean = false) {
        if (on == appFullscreen || (on && inPictureInPicture)) return
        if (on && readerImmersive) setReaderImmersive(false)
        appFullscreen = on
        if (on) {
            fullscreenByRotation = byRotation
            root.setPadding(0, 0, 0, 0)
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
            // Turned by the user: it follows the phone, so turning it upright leaves fullscreen.
            if (!byRotation) requestedOrientation = fullscreenOrientation(lastPlayback)
        } else {
            fullscreenByRotation = false
            rotationArmed = resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            window.insetsController?.show(WindowInsets.Type.systemBars())
            root.requestApplyInsets()
        }
        web.evaluateJavascript("window.lvlAndroid && window.lvlAndroid.fullscreen($on)", null)
    }

    // Comic reading hides only Android chrome. It never rotates the screen, changes
    // the reader's page/scroll position or alters the HTML canvas. Native refuses
    // requests from an unrelated page or a video/PiP session.
    private fun setReaderImmersive(on: Boolean) {
        if (isDestroyed || isFinishing) return
        if (on) {
            val page = runCatching { Uri.parse(web.url ?: "").path }.getOrNull()
            if (page != "/comic" || appFullscreen || customView != null || inPictureInPicture || stopped) return
        }
        if (readerImmersive == on) return
        readerImmersive = on
        if (on) {
            root.setPadding(0, 0, 0, 0)
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.insetsController?.show(WindowInsets.Type.systemBars())
            root.requestApplyInsets()
        }
        web.evaluateJavascript("window.lvlAndroid && window.lvlAndroid.readerImmersive($on)", null)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (inPictureInPicture) return
        if (newConfig.orientation != Configuration.ORIENTATION_LANDSCAPE) {
            rotationArmed = true
            if (appFullscreen && fullscreenByRotation) setAppFullscreen(false)
            return
        }
        if (rotationArmed && !appFullscreen && customView == null && lastPlayback.videoOpen) setAppFullscreen(true, byRotation = true)
    }

    // The page's playback state: media controls, and fullscreen follows the video's shape once
    // it's known (fullscreen starts before the first frame, landscape until then).
    private fun onPlayback(playback: Playback) {
        val before = fullscreenOrientation(lastPlayback)
        lastPlayback = playback
        controls.update(playback)
        val after = fullscreenOrientation(playback)
        if ((customView != null || (appFullscreen && !fullscreenByRotation)) && after != before) requestedOrientation = after
        // Leaving the player (or closing the video) leaves fullscreen.
        if (appFullscreen && !playback.videoOpen) setAppFullscreen(false)
    }

    // A tall (portrait) video stays upright; everything else turns to landscape.
    private fun fullscreenOrientation(playback: Playback) =
        if (playback.width > 0 && playback.height > playback.width) ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

    private fun enterPictureInPicture() {
        if (!controls.current.hasVideo || isInPictureInPictureMode) return
        try {
            enterPictureInPictureMode(controls.pictureInPictureParams())
        } catch (error: IllegalStateException) {
            Log.w("LVL", "Picture-in-picture isn't available", error)
        }
    }

    private fun download(url: String, contentDisposition: String?, mimeType: String?) {
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        val uri = Uri.parse(url)
        when {
            uri.scheme == "http" && uri.host == "127.0.0.1" -> {
                // LVL's own files: the page fetches them and saves them through the bridge.
                val script = """
                    (async () => {
                      const response = await fetch(${JSONObject.quote(url)});
                      if (!response.ok) throw new Error("HTTP " + response.status);
                      const blob = await response.blob();
                      const data = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
                        reader.onerror = () => reject(reader.error);
                        reader.readAsDataURL(blob);
                      });
                      LvlAndroid.saveDownload(${JSONObject.quote(name)}, blob.type || ${JSONObject.quote(mimeType ?: "")}, data);
                    })().catch((error) => LvlAndroid.downloadFailed(${JSONObject.quote(name)}, String(error && error.message || error)));
                """.trimIndent()
                web.evaluateJavascript(script, null)
            }
            uri.scheme == "https" -> {
                val request = DownloadManager.Request(uri)
                    .setTitle(name)
                    .setMimeType(mimeType)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, Downloads.safeName(name))
                getSystemService(DownloadManager::class.java).enqueue(request)
                Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
            }
            else -> Toast.makeText(this, "This download can't be saved", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showStartupFailure() {
        waiting = false
        waitGeneration += 1
        serverReady = false
        navigationStarted = false
        web.stopLoading()
        web.visibility = View.INVISIBLE
        statusBox.visibility = View.VISIBLE
        status.text = getString(R.string.start_failed)
        retryStartupButton.visibility = if (cookieFailed) View.GONE else View.VISIBLE
    }

    private fun retryStartup() {
        if (isDestroyed || isFinishing || cookieFailed) return
        retryStartupButton.visibility = View.GONE
        status.text = getString(R.string.starting)
        serverReady = false
        navigationStarted = false
        // The old terminal state may remain until Android delivers the start
        // command. Only a newer service revision can fail this retry.
        ignoredFailureRevision = ServerService.readinessRevision()
        ServerService.start(this)
        waitForServer()
    }

    private fun waitForServer() {
        val generation = ++waitGeneration
        val previousFailure = ignoredFailureRevision
        ignoredFailureRevision = null
        waiting = true
        thread(name = "lvl-wait") {
            val deadline = SystemClock.elapsedRealtime() + 180_000
            while (waiting && generation == waitGeneration) {
                // Observe the revision before checking health so a concurrent Node-ready
                // notification cannot be lost between the check and the subsequent wait.
                val revision = ServerService.readinessRevision()
                if (healthy()) {
                    main.post {
                        if (!isDestroyed && !isFinishing) {
                            if (generation != waitGeneration || cookieFailed) return@post
                            waiting = false
                            serverReady = true
                            startup("http_health_ok")
                            maybeNavigate()
                        }
                    }
                    return@thread
                }
                val serverStopped = !ServerService.running && ServerService.state.startsWith("The server") &&
                    (previousFailure == null || revision != previousFailure)
                val late = SystemClock.elapsedRealtime() > deadline
                main.post {
                    if (!isDestroyed && !isFinishing && !cookieFailed && generation == waitGeneration) {
                        if (late || serverStopped) showStartupFailure()
                        else status.text = getString(R.string.starting)
                    }
                }
                if (late || serverStopped) return@thread
                // A Node listening/error event wakes this wait immediately; the bounded
                // fallback still catches readiness if a service notification is missed.
                ServerService.awaitReadinessAfter(revision, 400L)
            }
        }
    }

    private fun healthy(): Boolean = try {
        val connection = URL("$base/api/health").openConnection() as HttpURLConnection
        connection.connectTimeout = 1000
        connection.readTimeout = 2000
        connection.setRequestProperty("Cookie", "lvl_access=${ServerService.accessToken}")
        try { connection.responseCode == 200 } finally { connection.disconnect() }
    } catch (_: Exception) {
        false
    }

    private fun openOutside(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            Log.w("LVL", "No app opens $uri")
        }
    }

    private inner class LvlWebViewClient : WebViewClient() {
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            val uri = request.url
            if (request.isForMainFrame && uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == ServerService.PORT) {
                Log.w("LVL", "Local page unavailable: ${error.errorCode}")
                showStartupFailure()
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            if (readerImmersive && Uri.parse(url).path != "/comic") setReaderImmersive(false)
            if (url.startsWith(base)) startup("webview_page_started")
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            if (url.startsWith(base)) startup("webview_page_committed")
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.host == "127.0.0.1" && uri.port == ServerService.PORT) return false
            // AniList's sign-in must come back to LVL's page in this WebView, so it opens in
            // LVL's sign-in screen rather than the browser.
            if (SignInActivity.handles(uri)) {
                try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(SignInActivity.intent(this@MainActivity, uri, "$base/anilist/callback"), REQUEST_SIGN_IN)
                } catch (_: ActivityNotFoundException) {
                    openOutside(uri)
                }
                return true
            }
            openOutside(uri)
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (url.startsWith(base) && navigationStarted) {
                startup("webview_page_finished")
                web.visibility = View.VISIBLE
                statusBox.visibility = View.GONE
                startup("webview_visible")
            }
        }
    }

    private inner class LvlChromeClient : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback
            root.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            root.setPadding(0, 0, 0, 0)
            // Fullscreen video turns to the video's shape (Android ignores this on large screens).
            requestedOrientation = fullscreenOrientation(lastPlayback)
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }

        override fun onHideCustomView() {
            val view = customView ?: return
            root.removeView(view)
            customView = null
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            window.insetsController?.show(WindowInsets.Type.systemBars())
            root.requestApplyInsets()
            customViewCallback?.onCustomViewHidden()
            customViewCallback = null
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            // accept="" lists can mix MIME types and extensions (".srt"); Android filters only by
            // MIME type, so any extension or wildcard means "any file" and LVL checks the file.
            val accept = params.acceptTypes.flatMap { it.split(",") }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            val mimes = accept.filter { "/" in it && !it.startsWith(".") }.distinct()
            val anyFile = accept.isEmpty() || accept.any { it.startsWith(".") || it == "*/*" }
            val intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
            if (anyFile || mimes.isEmpty()) intent.type = "*/*"
            else if (mimes.size == 1) intent.type = mimes[0]
            else intent.setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(intent, REQUEST_FILES)
                true
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            Log.d("LVL-Web", "${message.messageLevel()} ${message.sourceId()}:${message.lineNumber()} ${message.message()}")
            return true
        }
    }
}
