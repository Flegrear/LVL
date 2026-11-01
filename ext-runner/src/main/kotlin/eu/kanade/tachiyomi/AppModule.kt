package eu.kanade.tachiyomi

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modified for LVL's extension runner: what extensions get
// through Injekt (the app, the network, the JavaScript engine, Json, ProtoBuf),
// without the server's XML (used only by its local source).

import android.app.Application
import eu.kanade.tachiyomi.network.JavaScriptEngine
import eu.kanade.tachiyomi.network.NetworkHelper
import kotlinx.serialization.json.Json
import kotlinx.serialization.protobuf.ProtoBuf
import org.koin.core.module.Module
import org.koin.dsl.module

fun createAppModule(app: Application): Module =
    module {
        single { app }
        single { NetworkHelper(app) }
        single { JavaScriptEngine(app) }
        single<Json> {
            Json {
                ignoreUnknownKeys = true
                explicitNulls = false
            }
        }
        single<ProtoBuf> { ProtoBuf }
    }
