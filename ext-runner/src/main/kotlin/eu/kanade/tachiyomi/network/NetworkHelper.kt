package eu.kanade.tachiyomi.network

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modified for LVL's extension runner: the Cloudflare interceptor
// reports a browser check instead of solving it in a WebView (LVL verifies in its own
// window and passes the cookies back), no server source registry, and the HTTP cache
// lives in the runner's data folder.
// Extensions use client, cloudflareClient, cookieStore and defaultUserAgentProvider().

import android.content.Context
import eu.kanade.tachiyomi.network.interceptor.CloudflareInterceptor
import eu.kanade.tachiyomi.network.interceptor.UncaughtExceptionInterceptor
import eu.kanade.tachiyomi.network.interceptor.UserAgentInterceptor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Cache
import okhttp3.OkHttpClient
import java.io.File
import java.net.CookieHandler
import java.net.CookieManager
import java.net.CookiePolicy
import java.util.concurrent.TimeUnit

class NetworkHelper(
    context: Context,
) {
    val cookieStore = PersistentCookieStore(context)

    init {
        CookieHandler.setDefault(CookieManager(cookieStore, CookiePolicy.ACCEPT_ALL))
    }

    private val userAgent =
        MutableStateFlow(
            System.getProperty("lvl.runner.userAgent")
                ?: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        )
    val userAgentFlow = userAgent.asStateFlow()

    fun defaultUserAgentProvider(): String = userAgent.value

    fun setUserAgent(value: String) {
        if (value.isNotBlank()) userAgent.value = value
    }

    val client by lazy {
        OkHttpClient
            .Builder()
            .cookieJar(PersistentCookieJar(cookieStore))
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(2, TimeUnit.MINUTES)
            .cache(Cache(directory = File(context.cacheDir, "network_cache"), maxSize = 5L * 1024 * 1024))
            .addInterceptor(UncaughtExceptionInterceptor())
            .addInterceptor(UserAgentInterceptor(::defaultUserAgentProvider))
            .addInterceptor(CloudflareInterceptor())
            .build()
    }

    @Deprecated("The regular client handles Cloudflare by default")
    @Suppress("UNUSED")
    val cloudflareClient by lazy { client }
}
