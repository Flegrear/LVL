package io.github.flegrear.lvl.updates

import java.security.MessageDigest

/**
 * PackageInstaller status describes one session; the installed package is
 * the authoritative result. New attempts also pin the previous signing
 * identity, allowing Android signing-key rotations through common ancestry.
 */
object InstallVersionAttestation {
    fun signerDigests(certificates: Iterable<ByteArray>): Set<String> =
        certificates.map { certificate ->
            MessageDigest.getInstance("SHA-256").digest(certificate)
                .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        }.toSet()

    fun matches(
        expectedVersion: String,
        expectedCode: Long,
        expectedSignerDigests: Set<String>,
        installedVersion: String?,
        installedCode: Long?,
        installedSignerDigests: Set<String>,
    ): Boolean {
        if (installedVersion?.removeSuffix("-debug") != expectedVersion ||
            installedCode != expectedCode || installedSignerDigests.isEmpty()) return false
        // The pre-0.2.2 journal has no signer pin. Android enforces signing
        // continuity for an in-place replacement of this exact package; still
        // require current PackageManager signer metadata to be available.
        if (expectedSignerDigests.isEmpty()) return true
        return expectedSignerDigests.any { it in installedSignerDigests }
    }
}
