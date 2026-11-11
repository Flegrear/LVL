package io.github.flegrear.lvl

import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * One private proof authority per Node child. Only its child environment receives the key.
 * A public status response, matching PID text or a reflected challenge is never proof.
 *
 * Android's separate app UIDs protect this in-process key, the child's
 * environment and WebView cookies from unrelated apps. Same-UID code is
 * trusted. HTTP proof establishes the listener at the instant it replies;
 * independent later HTTP/WebView connections cannot atomically pin the same
 * socket owner. The Activity uses short, continuously renewed proof leases
 * and revokes them on failure, without claiming to close that OS-level race.
 */
class ServerIdentity private constructor(private val key: ByteArray) {
    enum class ProbeStatus { VERIFIED, UNAVAILABLE, REJECTED }

    val childEnvironmentKey: String = encoder.encodeToString(key)

    fun newChallenge(): String = encoder.encodeToString(ByteArray(24).also { random.nextBytes(it) })

    fun verify(challenge: String, responseProof: String?): Boolean {
        if (!validChallenge(challenge) || responseProof == null || !proofPattern.matches(responseProof)) return false
        val supplied = runCatching { decoder.decode(responseProof) }.getOrNull() ?: return false
        if (supplied.size != 32) return false
        val expected = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(key, "HmacSHA256"))
        }.doFinal("LVL-Android-Child:v1:$challenge".toByteArray(StandardCharsets.UTF_8))
        return MessageDigest.isEqual(expected, supplied)
    }

    /** A fresh challenge for *each* HTTP attempt; no secret or proof is logged/persisted. */
    fun probe(port: Int): Boolean = probeStatus(port) == ProbeStatus.VERIFIED

    fun probeStatus(port: Int): ProbeStatus {
        val challenge = newChallenge()
        val connection = try {
            URI("http://127.0.0.1:$port/api/health").toURL().openConnection() as HttpURLConnection
        } catch (_: Exception) {
            return ProbeStatus.UNAVAILABLE
        }
        connection.apply {
            connectTimeout = 1000
            readTimeout = 2000
            useCaches = false
            // This listener is still untrusted. Never disclose the bearer to
            // it, and never follow a Location redirect to another endpoint.
            instanceFollowRedirects = false
            requestMethod = "GET"
            setRequestProperty("X-LVL-Android-Challenge", challenge)
        }
        return try {
            if (connection.responseCode == 200 && verify(challenge, connection.getHeaderField("X-LVL-Android-Proof")))
                ProbeStatus.VERIFIED
            else ProbeStatus.REJECTED
        } catch (_: Exception) {
            // A timeout or refused connection is not a forged health response.
            // Both are unauthenticated; callers may distinguish their recovery UX.
            ProbeStatus.UNAVAILABLE
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private val encoder = Base64.getUrlEncoder().withoutPadding()
        private val decoder = Base64.getUrlDecoder()
        private val random = SecureRandom()
        private val challengePattern = Regex("^[A-Za-z0-9_-]{32,128}$")
        private val proofPattern = Regex("^[A-Za-z0-9_-]{43}$")

        fun create(): ServerIdentity = ServerIdentity(ByteArray(32).also { random.nextBytes(it) })

        // Used by the isolated JVM fixture to test native verification against the Node protocol.
        fun fromEnvironmentKey(key: String): ServerIdentity {
            require(proofPattern.matches(key))
            val bytes = decoder.decode(key)
            require(bytes.size == 32)
            return ServerIdentity(bytes)
        }

        private fun validChallenge(value: String) = challengePattern.matches(value)
    }
}
