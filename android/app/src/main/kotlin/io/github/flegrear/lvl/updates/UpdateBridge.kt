package io.github.flegrear.lvl.updates

import android.util.Base64
import android.util.Log
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.concurrent.thread

/**
 * The endpoint LVL's server uses for updates, the same one the Windows launcher offers
 * (server.js, requestNativeUpdate): a loopback port and a per-launch secret, passed to the
 * server as LANGUAGE_VIDEO_LEARNER_UPDATE_BRIDGE="port:secret". Each connection sends one
 * JSON line with the secret and an action, and gets one JSON line back.
 */
class UpdateBridge(private val handle: (JsonObject) -> JsonElement) {
    companion object {
        private const val TAG = "LVL-Updates"
        private const val MAX_REQUEST = 8192
    }

    // 32 random bytes in standard Base64: 43 characters and "=", the form server.js accepts.
    private val secret: String = ByteArray(32).also { SecureRandom().nextBytes(it) }.let { Base64.encodeToString(it, Base64.NO_WRAP) }
    private var server: ServerSocket? = null

    /** Starts listening (once) and returns the value for LANGUAGE_VIDEO_LEARNER_UPDATE_BRIDGE. */
    @Synchronized
    fun start(): String {
        server?.let { return "${it.localPort}:$secret" }
        val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        server = socket
        thread(name = "lvl-update-bridge", isDaemon = true) {
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (_: Exception) { break }
                thread(name = "lvl-update-bridge-client", isDaemon = true) { answer(client) }
            }
        }
        return "${socket.localPort}:$secret"
    }

    @Synchronized
    fun stop() {
        runCatching { server?.close() }
        server = null
    }

    private fun answer(client: Socket) {
        client.use { socket ->
            socket.soTimeout = 4000
            val reply = try {
                val line = readLine(socket) ?: return
                val command = Json.parseToJsonElement(line) as? JsonObject ?: throw IllegalArgumentException("Invalid request")
                val sent = command["secret"]?.jsonPrimitive?.contentOrNull.orEmpty()
                if (!MessageDigest.isEqual(sent.toByteArray(), secret.toByteArray())) {
                    Log.w(TAG, "Refused an update request without the right secret")
                    buildJsonObject { put("error", JsonPrimitive("Unauthorized")) }
                } else {
                    handle(command)
                }
            } catch (error: Exception) {
                buildJsonObject { put("error", JsonPrimitive(error.message ?: "Invalid request")) }
            }
            runCatching {
                socket.getOutputStream().apply {
                    write((reply.toString() + "\n").toByteArray())
                    flush()
                }
            }
        }
    }

    private fun readLine(socket: Socket): String? {
        val input = socket.getInputStream()
        val bytes = ByteArrayOutputStream()
        while (bytes.size() <= MAX_REQUEST) {
            val next = input.read()
            if (next < 0) return null
            if (next == '\n'.code) return bytes.toString(Charsets.UTF_8.name())
            bytes.write(next)
        }
        throw IllegalArgumentException("Request too large")
    }
}
