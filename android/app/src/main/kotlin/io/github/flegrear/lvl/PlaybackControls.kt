package io.github.flegrear.lvl

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.util.Rational
import android.view.WindowManager
import org.json.JSONObject

/** What the web player reports (android-bridge.js playbackSnapshot). */
data class Playback(
    val hasVideo: Boolean = false,
    val playing: Boolean = false,
    val width: Int = 0,
    val height: Int = 0,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val rate: Float = 1f,
    val title: String = "",
    /** The Watch page shows a video, also while it's still loading. */
    val videoOpen: Boolean = false,
) {
    companion object {
        fun parse(json: String): Playback = try {
            val o = JSONObject(json)
            Playback(
                hasVideo = o.optBoolean("hasVideo"),
                playing = o.optBoolean("playing"),
                width = o.optInt("width").coerceAtLeast(0),
                height = o.optInt("height").coerceAtLeast(0),
                positionMs = (o.optDouble("position", 0.0) * 1000).toLong().coerceAtLeast(0),
                durationMs = (o.optDouble("duration", 0.0) * 1000).toLong().coerceAtLeast(0),
                rate = o.optDouble("rate", 1.0).toFloat().takeIf { it > 0f } ?: 1f,
                title = o.optString("title").take(200),
                videoOpen = o.optBoolean("videoOpen"),
            )
        } catch (_: Exception) {
            Playback()
        }
    }
}

/**
 * Android's side of the player: keeps the screen on while a video plays, publishes a media
 * session (lock screen, notification, headset and Bluetooth buttons) and the
 * picture-in-picture settings. Commands from those controls go back to the page through [send].
 */
class PlaybackControls(private val activity: Activity, private val send: (command: String, value: Double?) -> Unit) {
    companion object {
        const val ACTION = "io.github.flegrear.lvl.MEDIA_COMMAND"
        const val EXTRA_COMMAND = "command"
        private const val CHANNEL = "playback"
        private const val NOTIFICATION_ID = 2
        // Android accepts picture-in-picture shapes between 1:2.39 and 2.39:1.
        private val WIDEST = Rational(239, 100)
        private val TALLEST = Rational(100, 239)
    }

    private val notifications = activity.getSystemService(NotificationManager::class.java)
    private val session = MediaSession(activity, "LVL")
    var current = Playback()
        private set

    init {
        notifications.createNotificationChannel(
            NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
        )
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() = send("play", null)
            override fun onPause() = send("pause", null)
            override fun onStop() = send("pause", null)
            override fun onSeekTo(pos: Long) = send("seek", pos / 1000.0)
            override fun onFastForward() = send("forward", null)
            override fun onRewind() = send("rewind", null)
            override fun onSkipToNext() = send("forward", null)
            override fun onSkipToPrevious() = send("rewind", null)
        })
    }

    fun update(next: Playback) {
        val previous = current
        current = next
        if (next.playing) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        holdWifi(next.playing)
        updateSession(previous)
        updateNotification()
        activity.setPictureInPictureParams(pictureInPictureParams())
    }

    // While a video plays the torrent keeps downloading it; Wi-Fi's power saving (with the screen
    // in picture-in-picture or dimmed) can slow that down enough to stall playback. Android's
    // own players hold this lock for streaming; it's released as soon as playback pauses or ends.
    private val wifiLock = runCatching {
        activity.applicationContext.getSystemService(WifiManager::class.java)
            ?.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "LVL:playback")
            ?.apply { setReferenceCounted(false) }
    }.getOrNull()

    private fun holdWifi(on: Boolean) {
        val lock = wifiLock ?: return
        runCatching { if (on && !lock.isHeld) lock.acquire() else if (!on && lock.isHeld) lock.release() }
    }

    /** Commands from the notification, picture-in-picture buttons and headphone unplugging. */
    fun handle(intent: Intent) {
        val command = intent.getStringExtra(EXTRA_COMMAND) ?: return
        send(command, null)
    }

    fun pictureInPictureParams(): PictureInPictureParams {
        val shape = if (current.width > 0 && current.height > 0) Rational(current.width, current.height) else Rational(16, 9)
        val ratio = when {
            shape > WIDEST -> WIDEST
            shape < TALLEST -> TALLEST
            else -> shape
        }
        return PictureInPictureParams.Builder()
            .setAspectRatio(ratio)
            // Going Home while a video plays opens picture-in-picture by itself.
            .setAutoEnterEnabled(current.hasVideo && current.playing)
            .setSeamlessResizeEnabled(false)
            .setActions(listOf(remoteAction("rewind"), remoteAction("toggle"), remoteAction("forward")))
            .build()
    }

    fun release() {
        holdWifi(false)
        notifications.cancel(NOTIFICATION_ID)
        session.isActive = false
        session.release()
    }

    private fun updateSession(previous: Playback) {
        if (!current.hasVideo) {
            session.isActive = false
            return
        }
        if (previous.title != current.title || previous.durationMs != current.durationMs || !session.isActive) {
            session.setMetadata(
                MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, current.title.ifBlank { "LVL" })
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, "LVL")
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, current.durationMs)
                    .build(),
            )
        }
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND or
                        PlaybackState.ACTION_STOP,
                )
                .setState(
                    if (current.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    current.positionMs,
                    if (current.playing) current.rate else 0f,
                )
                .build(),
        )
        session.isActive = true
    }

    private fun updateNotification() {
        if (!current.hasVideo) {
            notifications.cancel(NOTIFICATION_ID)
            return
        }
        val open = PendingIntent.getActivity(
            activity, 0,
            Intent(activity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(activity, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_lvl)
            .setContentTitle(current.title.ifBlank { "LVL" })
            .setContentText(if (current.playing) "Playing" else "Paused")
            .setContentIntent(open)
            .setOngoing(current.playing)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(notificationAction("rewind"))
            .addAction(notificationAction("toggle"))
            .addAction(notificationAction("forward"))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
        notifications.notify(NOTIFICATION_ID, notification)
    }

    private fun commandIntent(command: String): PendingIntent = PendingIntent.getBroadcast(
        activity,
        command.hashCode(),
        Intent(ACTION).setPackage(activity.packageName).putExtra(EXTRA_COMMAND, command),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun icon(command: String): Icon = Icon.createWithResource(
        activity,
        when (command) {
            "rewind" -> android.R.drawable.ic_media_rew
            "forward" -> android.R.drawable.ic_media_ff
            else -> if (current.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        },
    )

    private fun label(command: String): String = when (command) {
        "rewind" -> "Back 10 seconds"
        "forward" -> "Forward 10 seconds"
        else -> if (current.playing) "Pause" else "Play"
    }

    private fun notificationAction(command: String): Notification.Action =
        Notification.Action.Builder(icon(command), label(command), commandIntent(command)).build()

    private fun remoteAction(command: String): RemoteAction =
        RemoteAction(icon(command), label(command), label(command), commandIntent(command))
}
