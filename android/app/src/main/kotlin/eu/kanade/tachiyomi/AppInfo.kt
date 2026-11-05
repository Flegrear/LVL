package eu.kanade.tachiyomi

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modified for LVL's Android extension host (same as the desktop runner's): a fixed
// version, and the image types listed here.

object AppInfo {
    fun getVersionCode() = 1

    fun getVersionName() = "1.0"

    fun getSupportedImageMimeTypes(): List<String> =
        listOf("image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/jxl", "image/heif")
}
