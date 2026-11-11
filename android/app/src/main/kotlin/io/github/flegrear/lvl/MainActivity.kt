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
import kotlin.concurrent.thread

/** Shows LVL's own web UI from the server that ServerService runs on this device. */
class MainActivity : Activity() {
    companion object {
        private const val REQUEST_FILES = 41
        private const val REQUEST_SIGN_IN = 42
        private const val LAST_SIGN_IN_REQUEST = 0x7fff

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
    @Volatile private var cookieReady = false
    @Volatile private var cookiePending = false
    @Volatile private var cookieFailed = false
    @Volatile private var serverReady = false
    @Volatile private var navigationStarted = false
    @Volatile private var authenticatedChild: ServerService.Child? = null
    private val freshProof = FreshChildProof()
    private var connectionSuspended = false
    private var cookieMutation = 0L
    private var nativeBridgeSupported = false
    private var localNavigationIntent = 0L
    private var signInRequestSerial = REQUEST_SIGN_IN - 1
    private var pendingSignInRequestCode: Int? = null
    private var pendingSignInChild: ServerService.Child? = null
    private var pendingSignInGeneration = 0
    private var failedMainFrameUrl: String? = null
    private var lastFailedMainFrameUrl: String? = null
    private var lastMainFrameFailureAt = 0L
    private var failedMainFrameRetries = 0

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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startup("activity_on_create")
        // Queue the service before creating WebView, which can be expensive on a cold process.
        ServerService.start(this)
        startup("service_launch_requested")
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        controls = PlaybackControls(this) { command, value -> sendMedia(command, value) }

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        // AndroidX may deliver a WebMessage on a different thread. Keep all
        // Activity state on its UI thread, and recheck the current lease after
        // the post so a queued action cannot outlive revoked authority.
        val nativeOperations = WebBridge(this,
            { playback -> runOnUiThread { if (currentlyAuthenticated()) onPlayback(playback) } },
            { runOnUiThread { if (currentlyAuthenticated()) enterPictureInPicture() } },
            { enabled -> runOnUiThread { if (currentlyAuthenticated()) setAppFullscreen(enabled) } },
            { enabled -> runOnUiThread { if (currentlyAuthenticated()) setReaderImmersive(enabled) } },
        )
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
            nativeBridgeSupported = TrustedWebBridge.install(this, base,
                authorized = {
                    serverReady && navigationStarted && currentlyAuthenticated()
                },
                dispatch = { action, args -> nativeOperations.dispatch(action, args) },
            )
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

        if (!nativeBridgeSupported) {
            status.text = "This Android WebView lacks the secure message channel LVL requires. Update Android System WebView."
            retryStartupButton.visibility = View.GONE
            return
        }
        // Clear a prior Android process's HttpOnly cookie before any navigation.
        // The initial proof request itself contains no LVL bearer.
        CookieManager.getInstance().setCookie(
            base, "lvl_access=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"
        ) {
            if (!isDestroyed && !isFinishing) waitForServer()
        }
    }

    private fun currentlyAuthenticated(child: ServerService.Child? = authenticatedChild): Boolean =
        freshProof.permits(child, waitGeneration, SystemClock.elapsedRealtime(),
            ServerService.isCurrentChild(child))

    // Native navigation must use the same short, background-renewed child proof
    // as the bridge and initial cookie. Never probe HTTP from the UI thread.
    private fun canNavigateLocally(child: ServerService.Child?, generation: Int): Boolean =
        child != null && authenticatedChild === child && generation == waitGeneration &&
            serverReady && cookieReady && navigationStarted && !isDestroyed && !isFinishing &&
            currentlyAuthenticated(child)

    private fun isLocalSignInCallback(uri: Uri): Boolean =
        isLocalUri(uri) && uri.encodedPath == "/anilist/callback" && uri.userInfo == null

    private fun monitorAuthenticatedChild(child: ServerService.Child, generation: Int) {
        thread(name = "lvl-proof-renewal", isDaemon = true) {
            val health = ActiveConnectionHealth()
            var lastDecision = ActiveConnectionHealth.Decision.RESTORED
            while (generation == waitGeneration && !isDestroyed && !isFinishing &&
                ServerService.isCurrentChild(child)) {
                try { Thread.sleep(450) } catch (_: InterruptedException) { return@thread }
                if (generation != waitGeneration || !ServerService.isCurrentChild(child)) break
                val probeStartedAt = SystemClock.elapsedRealtime()
                val sample = runCatching { child.identity.probeStatus(ServerService.PORT) }
                    .getOrDefault(ServerIdentity.ProbeStatus.UNAVAILABLE)
                if (generation != waitGeneration || !ServerService.isCurrentChild(child)) break
                val authenticated = sample == ServerIdentity.ProbeStatus.VERIFIED
                freshProof.record(child, generation, SystemClock.elapsedRealtime(), authenticated)
                val now = SystemClock.elapsedRealtime()
                val childAlive = ServerService.isCurrentChild(child)
                val decision = health.observe(now, sample, childAlive)
                val changed = decision != lastDecision
                if (changed) {
                    // Transition-only diagnostics: neither the bearer nor the
                    // per-child challenge, proof, URL or media details are logged.
                    Log.w("LVL-Connection",
                        "phase=${decision.name} sample=${sample.name} elapsed_ms=${health.unauthenticatedForMs(now)} " +
                            "probe_elapsed_ms=${now - probeStartedAt} child_alive=$childAlive")
                    lastDecision = decision
                }
                if (decision != ActiveConnectionHealth.Decision.RESTORED) {
                    val queuedAt = SystemClock.elapsedRealtime()
                    main.post {
                        if (generation == waitGeneration && authenticatedChild === child &&
                            !isDestroyed && !isFinishing) {
                            val mainDelay = SystemClock.elapsedRealtime() - queuedAt
                            if (changed && mainDelay >= 1_000L)
                                Log.w("LVL-Connection", "phase=${decision.name} main_delay_ms=$mainDelay")
                            when (decision) {
                                ActiveConnectionHealth.Decision.WAITING ->
                                    suspendAuthenticatedPage(child, generation, showOverlay = false)
                                ActiveConnectionHealth.Decision.SUSPEND ->
                                    suspendAuthenticatedPage(child, generation, showOverlay = true)
                                ActiveConnectionHealth.Decision.TERMINAL -> showStartupFailure()
                                else -> Unit
                            }
                        }
                    }
                    if (decision == ActiveConnectionHealth.Decision.TERMINAL) return@thread
                    continue
                }
                val queuedAt = SystemClock.elapsedRealtime()
                main.post {
                    if (generation == waitGeneration && authenticatedChild === child &&
                        !isDestroyed && !isFinishing) {
                        val mainDelay = SystemClock.elapsedRealtime() - queuedAt
                        if (changed && mainDelay >= 1_000L)
                            Log.w("LVL-Connection", "phase=RESTORED main_delay_ms=$mainDelay")
                        if (!cookieReady && !cookiePending && !cookieFailed)
                            installAuthenticatedCookie(child)
                        maybeNavigate()
                        retryFailedMainFrame(child)
                        maybeRevealWeb()
                    }
                }
            }
            if (generation == waitGeneration && authenticatedChild === child) {
                freshProof.revoke()
                main.post {
                    if (generation == waitGeneration && authenticatedChild === child &&
                        !isDestroyed && !isFinishing) showStartupFailure()
                }
            }
        }
    }

    private fun suspendAuthenticatedPage(child: ServerService.Child, generation: Int, showOverlay: Boolean = true) {
        if (generation != waitGeneration || authenticatedChild !== child ||
            isDestroyed || isFinishing || currentlyAuthenticated(child)) return
        if (!ServerService.isCurrentChild(child)) {
            showStartupFailure()
            return
        }
        if (connectionSuspended) {
            if (showOverlay) {
                web.visibility = View.INVISIBLE
                statusBox.visibility = View.VISIBLE
                status.text = getString(R.string.reconnecting)
                retryStartupButton.visibility = View.GONE
            }
            return
        }
        connectionSuspended = true
        freshProof.revoke()
        cookieReady = false
        cookiePending = true
        val mutation = ++cookieMutation
        if (showOverlay) {
            web.visibility = View.INVISIBLE
            statusBox.visibility = View.VISIBLE
            status.text = getString(R.string.reconnecting)
            retryStartupButton.visibility = View.GONE
        }
        startup("connection_suspended")
        // Keep this document and its local edits mounted. Neither its native
        // bridge nor a new bearer is admitted until fresh child proof returns.
        CookieManager.getInstance().setCookie(
            base, "lvl_access=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"
        ) { accepted ->
            if (mutation != cookieMutation || generation != waitGeneration ||
                authenticatedChild !== child || isDestroyed || isFinishing) return@setCookie
            cookiePending = false
            if (!accepted) {
                cookieFailed = true
                showStartupFailure()
                return@setCookie
            }
            if (currentlyAuthenticated(child)) installAuthenticatedCookie(child)
        }
    }

    private fun installAuthenticatedCookie(child: ServerService.Child) {
        if (!currentlyAuthenticated(child) || cookiePending || cookieReady) return
        cookiePending = true
        cookieReady = false
        val mutation = ++cookieMutation
        // The HttpOnly cookie is written only after the specific child proves its identity.
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setCookie(base, "lvl_access=${child.accessToken}; Path=/; HttpOnly; SameSite=Strict") { accepted ->
                if (mutation != cookieMutation) return@setCookie
                cookiePending = false
                if (isDestroyed || isFinishing || !currentlyAuthenticated(child) ||
                    authenticatedChild !== child) return@setCookie
                if (!accepted) {
                    cookieFailed = true
                    waiting = false
                    Log.e("LVL", "Couldn't set the local server access cookie")
                    status.text = "Couldn't configure LVL's secure connection. Reopen the app to retry."
                    return@setCookie
                }
                cookieReady = true
                if (connectionSuspended) startup("connection_restored")
                connectionSuspended = false
                startup("cookie_ready")
                maybeNavigate()
                retryFailedMainFrame(child)
                maybeRevealWeb()
            }
        }
    }

    private fun retryFailedMainFrame(child: ServerService.Child) {
        val url = failedMainFrameUrl ?: return
        if (!currentlyAuthenticated(child) || !cookieReady || authenticatedChild !== child) return
        if (!isLocalUri(Uri.parse(url))) {
            showStartupFailure()
            return
        }
        failedMainFrameUrl = null
        localNavigationIntent += 1
        // A failed Chromium main-frame request can have replaced the document
        // with an error page. Never reveal that page as the recovered route.
        web.visibility = View.INVISIBLE
        statusBox.visibility = View.VISIBLE
        status.text = getString(R.string.reconnecting)
        web.loadUrl(url)
    }

    private fun maybeNavigate() {
        if (!cookieReady || !serverReady || navigationStarted || isDestroyed || isFinishing ||
            !currentlyAuthenticated()) return
        localNavigationIntent += 1
        navigationStarted = true
        startup("webview_navigation")
        web.loadUrl("$base/home")
    }

    private fun maybeRevealWeb() {
        if (!navigationStarted || !currentlyAuthenticated() || !cookieReady || failedMainFrameUrl != null ||
            !isLocalUri(Uri.parse(web.url.orEmpty())) || web.progress != 100 ||
            web.visibility == View.VISIBLE) return
        web.visibility = View.VISIBLE
        statusBox.visibility = View.GONE
        startup("webview_visible")
    }

    override fun onStart() {
        super.onStart()
        stopped = false
        visible = true
        // Proof expiry already disables the native bridge/navigation. The
        // verifier distinguishes a slow live child from an exited generation
        // and owns any page-covering decision.
        if (navigationStarted && !currentlyAuthenticated()) {
            val child = authenticatedChild
            if (child != null && ServerService.isCurrentChild(child)) {
                Log.w("LVL-Connection", "phase=FOREGROUND_EXPIRED child_alive=true")
                suspendAuthenticatedPage(child, waitGeneration, showOverlay = false)
            } else showStartupFailure()
        }
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
        localNavigationIntent += 1
        pendingSignInRequestCode = null
        pendingSignInChild = null
        freshProof.revoke()
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
        if (requestCode in REQUEST_SIGN_IN..LAST_SIGN_IN_REQUEST) {
            if (requestCode != pendingSignInRequestCode) return
            val child = pendingSignInChild
            val generation = pendingSignInGeneration
            pendingSignInRequestCode = null
            pendingSignInChild = null
            val callback = data?.data ?: return
            // Preserve the token query/fragment, but reject callback lookalikes,
            // expired proof leases and a return from a replaced Node process.
            if (resultCode != RESULT_OK || !isLocalSignInCallback(callback) ||
                generation != waitGeneration || child !== authenticatedChild ||
                !canNavigateLocally(child, generation)) return
            localNavigationIntent += 1
            web.loadUrl(callback.toString())
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
        val child = authenticatedChild
        val generation = waitGeneration
        if (!canNavigateLocally(child, generation)) return
        val intent = ++localNavigationIntent
        // The page closes a dialog, menu or fullscreen first; only then does Back leave the page.
        web.evaluateJavascript("(function(){try{return !!(window.lvlAndroid && window.lvlAndroid.back())}catch(e){return false}})()") { handled ->
            // A queued JS callback must not navigate after a newer sign-in,
            // server replacement, proof expiry or activity teardown.
            if (intent != localNavigationIntent || !canNavigateLocally(child, generation)) return@evaluateJavascript
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
            isLocalUri(uri) -> {
                if (!currentlyAuthenticated()) {
                    Toast.makeText(this, "The LVL server connection changed. Try the download again.", Toast.LENGTH_LONG).show()
                    return
                }
                // Incremental reads enforce the 50 MiB cap even if the server
                // omits or lies about Content-Length. Never follow a redirect
                // with our privileged HttpOnly cookie.
                val script = """
                    (async () => {
                      const MAX = 50 * 1024 * 1024;
                      const response = await fetch(${JSONObject.quote(url)}, { credentials: 'same-origin', redirect: 'error' });
                      if (!response.ok) throw new Error("HTTP " + response.status);
                      if (!response.body?.getReader) throw new Error("This WebView can't stream downloads");
                      const reported = Number(response.headers.get('content-length'));
                      if (Number.isFinite(reported) && reported > MAX) throw new Error("The file is too large to save (50 MiB limit)");
                      const reader = response.body.getReader();
                      let count = 0;
                      const parts = [];
                      try {
                        while (true) {
                          const { done, value } = await reader.read();
                          if (done) break;
                          count += value.byteLength;
                          if (count > MAX) throw new Error("The file is too large to save (50 MiB limit)");
                          parts.push(value);
                        }
                      } catch (error) {
                        await reader.cancel().catch(() => {});
                        throw error;
                      } finally {
                        reader.releaseLock();
                      }
                      const blob = new Blob(parts, { type: response.headers.get('content-type') || ${JSONObject.quote(mimeType ?: "")} });
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
        connectionSuspended = false
        cookieMutation += 1
        waiting = false
        waitGeneration += 1
        localNavigationIntent += 1
        pendingSignInRequestCode = null
        pendingSignInChild = null
        failedMainFrameUrl = null
        lastFailedMainFrameUrl = null
        lastMainFrameFailureAt = 0L
        failedMainFrameRetries = 0
        freshProof.revoke()
        serverReady = false
        cookieReady = false
        cookiePending = false
        authenticatedChild = null
        navigationStarted = false
        web.stopLoading()
        web.loadUrl("about:blank")
        web.visibility = View.INVISIBLE
        CookieManager.getInstance().setCookie(
            base, "lvl_access=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"
        )
        statusBox.visibility = View.VISIBLE
        status.text = getString(R.string.start_failed)
        retryStartupButton.visibility = if (cookieFailed) View.GONE else View.VISIBLE
    }

    private fun retryStartup() {
        if (isDestroyed || isFinishing || cookieFailed) return
        connectionSuspended = false
        cookieMutation += 1
        localNavigationIntent += 1
        pendingSignInRequestCode = null
        pendingSignInChild = null
        failedMainFrameUrl = null
        lastFailedMainFrameUrl = null
        lastMainFrameFailureAt = 0L
        failedMainFrameRetries = 0
        retryStartupButton.visibility = View.GONE
        status.text = getString(R.string.starting)
        serverReady = false
        freshProof.revoke()
        cookieReady = false
        cookiePending = false
        authenticatedChild = null
        navigationStarted = false
        // The old terminal state may remain until Android delivers the start
        // command. Only a newer service revision can fail this retry.
        ignoredFailureRevision = ServerService.readinessRevision()
        ServerService.start(this)
        CookieManager.getInstance().setCookie(
            base, "lvl_access=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"
        ) {
            if (!isDestroyed && !isFinishing) waitForServer()
        }
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
                val child = ServerService.currentChild()
                val authenticated = child != null && runCatching {
                    child.identity.probe(ServerService.PORT)
                }.getOrDefault(false) && ServerService.isCurrentChild(child)
                val observedAt = SystemClock.elapsedRealtime()
                if (authenticated && child != null) {
                    main.post {
                        if (!isDestroyed && !isFinishing) {
                            if (generation != waitGeneration || cookieFailed) return@post
                            if (!ServerService.isCurrentChild(child)) {
                                waitForServer()
                                return@post
                            }
                            freshProof.record(child, generation, observedAt, true)
                            if (!currentlyAuthenticated(child)) {
                                waitForServer()
                                return@post
                            }
                            waiting = false
                            serverReady = true
                            authenticatedChild = child
                            startup("authenticated_health_ok")
                            monitorAuthenticatedChild(child, generation)
                            installAuthenticatedCookie(child)
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

    private fun isLocalUri(uri: Uri): Boolean =
        uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == ServerService.PORT

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
                val child = authenticatedChild
                Log.w("LVL-Connection", "phase=MAIN_FRAME_ERROR child_alive=${ServerService.isCurrentChild(child)} code=${error.errorCode}")
                if (child != null && ServerService.isCurrentChild(child) && navigationStarted) {
                    val attemptedUrl = uri.toString()
                    val now = SystemClock.elapsedRealtime()
                    failedMainFrameRetries = if (lastFailedMainFrameUrl == attemptedUrl &&
                        now - lastMainFrameFailureAt in 0..60_000L) failedMainFrameRetries + 1 else 1
                    lastFailedMainFrameUrl = attemptedUrl
                    lastMainFrameFailureAt = now
                    if (failedMainFrameRetries > 2) showStartupFailure()
                    else {
                        failedMainFrameUrl = attemptedUrl
                        suspendAuthenticatedPage(child, waitGeneration, showOverlay = true)
                    }
                } else showStartupFailure()
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            if (readerImmersive && Uri.parse(url).path != "/comic") setReaderImmersive(false)
            if (isLocalUri(Uri.parse(url))) {
                if (!currentlyAuthenticated()) {
                    val child = authenticatedChild
                    if (child != null && ServerService.isCurrentChild(child))
                        suspendAuthenticatedPage(child, waitGeneration, showOverlay = false)
                    else showStartupFailure()
                    return
                }
                startup("webview_page_started")
            }
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            if (isLocalUri(Uri.parse(url)) && currentlyAuthenticated())
                startup("webview_page_committed")
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (!request.isForMainFrame) {
                // Trailer/remote iframes may browse http(s), but child navigation
                // can never dispatch ACTION_VIEW, a sign-in activity or an intent.
                return !TrustedWebBridge.allowChildFrameNavigation(uri.scheme)
            }
            if (isLocalUri(uri)) return !canNavigateLocally(authenticatedChild, waitGeneration)
            // AniList's sign-in must come back to LVL's page in this WebView, so it opens in
            // LVL's sign-in screen rather than the browser.
            if (SignInActivity.handles(uri)) {
                val child = authenticatedChild
                val generation = waitGeneration
                if (!canNavigateLocally(child, generation)) return true
                signInRequestSerial = if (signInRequestSerial >= LAST_SIGN_IN_REQUEST) REQUEST_SIGN_IN
                    else signInRequestSerial + 1
                val requestCode = signInRequestSerial
                localNavigationIntent += 1
                pendingSignInRequestCode = requestCode
                pendingSignInChild = child
                pendingSignInGeneration = generation
                try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(SignInActivity.intent(this@MainActivity, uri, "$base/anilist/callback"), requestCode)
                } catch (_: ActivityNotFoundException) {
                    pendingSignInRequestCode = null
                    pendingSignInChild = null
                    openOutside(uri)
                }
                return true
            }
            if (TrustedWebBridge.allowExternalTopFrame(uri.scheme)) openOutside(uri)
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (isLocalUri(Uri.parse(url)) && navigationStarted &&
                currentlyAuthenticated()) {
                startup("webview_page_finished")
                maybeRevealWeb()
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
