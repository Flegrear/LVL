package eu.kanade.tachiyomi

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modified for LVL's extension runner: the version is the
// runner's, and the image types are listed here instead of the server's ImageUtil.

object AppInfo {
    fun getVersionCode() = 1

    fun getVersionName() = "1.0"

    fun getSupportedImageMimeTypes(): List<String> =
        listOf("image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/jxl", "image/heif")
}
