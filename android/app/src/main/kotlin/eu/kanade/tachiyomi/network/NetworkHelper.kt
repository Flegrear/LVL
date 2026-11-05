package eu.kanade.tachiyomi.network

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modified for LVL's Android extension host. As in Mihon, cookies live in the WebView's
// CookieManager, so a browser check solved in a WebView applies to the extensions'
// requests, and the user agent is the WebView's own. Extensions use client,
// cloudflareClient and defaultUserAgentProvider().

import android.content.Context
import android.webkit.WebSettings
import eu.kanade.tachiyomi.network.interceptor.CloudflareInterceptor
import eu.kanade.tachiyomi.network.interceptor.UncaughtExceptionInterceptor
import eu.kanade.tachiyomi.network.interceptor.UserAgentInterceptor
import io.github.flegrear.lvl.comics.WebViewCookieJar
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Cache
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

class NetworkHelper(
    private val context: Context,
) {
    val cookieJar = WebViewCookieJar()

    private val userAgent = MutableStateFlow(browserUserAgent(context))
    val userAgentFlow = userAgent.asStateFlow()

    fun defaultUserAgentProvider(): String = userAgent.value

    fun setUserAgent(value: String) {
        if (value.isNotBlank()) userAgent.value = value
    }

    val client by lazy {
        OkHttpClient
            .Builder()
            .cookieJar(cookieJar)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(2, TimeUnit.MINUTES)
            .cache(Cache(directory = File(context.cacheDir, "network_cache"), maxSize = 5L * 1024 * 1024))
            .addInterceptor(UncaughtExceptionInterceptor())
            .addInterceptor(UserAgentInterceptor(::defaultUserAgentProvider))
            .addInterceptor(CloudflareInterceptor(context, cookieJar, ::defaultUserAgentProvider))
            .build()
    }

    @Deprecated("The regular client handles Cloudflare by default")
    @Suppress("UNUSED")
    val cloudflareClient by lazy { client }

    private companion object {
        const val FALLBACK = "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36"

        // The WebView's user agent without its WebView marks ("; wv", "Version/4.0"),
        // which some sites refuse; the same string goes to the WebView that solves checks.
        fun browserUserAgent(context: Context): String =
            runCatching { WebSettings.getDefaultUserAgent(context) }
                .getOrNull()
                ?.replace("; wv)", ")")
                ?.replace(Regex("""\s*Version/\d+(\.\d+)*"""), "")
                ?.takeIf { it.isNotBlank() }
                ?: FALLBACK
    }
}
