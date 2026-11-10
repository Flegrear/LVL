package lvl.runner

import com.android.apksig.ApkVerifier
import net.dongliu.apk.parser.ApkFile
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

class ApkTrustException(message: String) : IllegalArgumentException(message)

// A copied snapshot is verified and is the only APK read for manifest parsing and
// dex conversion. Download replacement cannot swap the bytes after verification.
object ApkTrust {
    data class Admission(val apk: File, val digest: String, val signer: String)
    private const val MAX_APK_BYTES = 20L * 1024 * 1024

    private val fingerprintPattern = Regex("(?i)(?:[0-9a-f]{64}|(?:[0-9a-f]{2}:){31}[0-9a-f]{2})")
    private val packagePattern = Regex("[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z][a-zA-Z0-9_]*)+")

    fun admit(
        source: File,
        expectedPackage: String,
        expectedFingerprint: String,
        snapshotDir: File,
    ): Admission {
        if (!packagePattern.matches(expectedPackage) || !fingerprintPattern.matches(expectedFingerprint))
            throw ApkTrustException("The repository has no valid approved package and SHA-256 signing fingerprint")
        if (!source.isFile || source.length() !in 1..MAX_APK_BYTES) throw ApkTrustException("The extension file is missing or too large")
        snapshotDir.mkdirs()
        val snapshot = Files.createTempFile(snapshotDir.toPath(), "signed-", ".apk")
        try {
            Files.copy(source.toPath(), snapshot, StandardCopyOption.REPLACE_EXISTING)
            val result = ApkVerifier.Builder(snapshot.toFile()).build().verify()
            if (!result.isVerified) throw ApkTrustException("The extension APK signature or signed bytes are invalid")
            // Rotation: only the active, verified signer is authorized by the repository;
            // an old certificate in a valid lineage does not grant a different new signer.
            // Multiple concurrent signers are refused, since a repository supplies one key.
            val signers = result.signerCertificates
            if (signers.size != 1) throw ApkTrustException("The extension must have exactly one verified signing identity")
            val actual = MessageDigest.getInstance("SHA-256").digest(signers.single().encoded)
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
            if (actual != expectedFingerprint.replace(":", "").lowercase())
                throw ApkTrustException("The extension APK was signed by a different publisher")
            val packageName = ApkFile(snapshot.toFile()).use { it.apkMeta.packageName }
            if (packageName != expectedPackage)
                throw ApkTrustException("The extension manifest package differs from its approved repository identity")
            val digest = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(snapshot))
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
            return Admission(snapshot.toFile(), digest, actual)
        } catch (error: ApkTrustException) {
            Files.deleteIfExists(snapshot)
            throw error
        } catch (error: Exception) {
            Files.deleteIfExists(snapshot)
            throw ApkTrustException("The extension APK signature could not be verified: ${error.message ?: "invalid file"}")
        }
    }
}
