package io.github.flegrear.lvl.comics

import okhttp3.Dns
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException

/**
 * Resolves only to public addresses. Used for pages LVL's server asks the app to fetch
 * (browserRequest): the server checks the address first, but the app resolves the name
 * again, and a name that now points at the phone or the home network must not be reached.
 * Extensions keep the normal resolver (some read a self-hosted server on the home network).
 */
object PublicOnlyDns : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val all = Dns.SYSTEM.lookup(hostname)
        val public = all.filter(::isPublic)
        if (public.isEmpty()) throw UnknownHostException("$hostname resolves only to a private or local address")
        return public
    }

    fun isPublic(address: InetAddress): Boolean {
        if (address.isLoopbackAddress || address.isAnyLocalAddress || address.isLinkLocalAddress ||
            address.isSiteLocalAddress || address.isMulticastAddress) return false
        val bytes = address.address
        if (address is Inet6Address) {
            // Unique local addresses (fc00::/7) and IPv4-mapped private addresses.
            if ((bytes[0].toInt() and 0xfe) == 0xfc) return false
            val mapped = bytes.size == 16 && bytes.take(10).all { it.toInt() == 0 } && bytes[10].toInt() == -1 && bytes[11].toInt() == -1
            if (mapped) return isPublic(InetAddress.getByAddress(bytes.copyOfRange(12, 16)))
            return true
        }
        val a = bytes[0].toInt() and 0xff
        val b = bytes[1].toInt() and 0xff
        // Carrier-grade NAT (100.64/10) and the 0.0.0.0/8 block.
        if (a == 100 && b in 64..127) return false
        if (a == 0) return false
        return true
    }
}
