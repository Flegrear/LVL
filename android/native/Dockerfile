# Build environment for LVL's Android native parts: Node.js and FFmpeg.
# Build:  docker build -t lvl-android-native:r28c android/native
# The NDK is pinned by version and SHA-1 (the checksum Google publishes in
# https://dl.google.com/android/repository/repository2-3.xml).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils patch make git file \
      python3 python-is-python3 gcc g++ clang lld zlib1g-dev \
      pkg-config nasm yasm cmake ninja-build \
 && rm -rf /var/lib/apt/lists/*

ARG NDK_VERSION=r28c
ARG NDK_SHA1=a7b54a5de87fecd125a17d54f73c446199e72a64
RUN curl -fsSL -o /tmp/ndk.zip "https://dl.google.com/android/repository/android-ndk-${NDK_VERSION}-linux.zip" \
 && echo "${NDK_SHA1}  /tmp/ndk.zip" | sha1sum -c - \
 && unzip -q /tmp/ndk.zip -d /opt \
 && mv "/opt/android-ndk-${NDK_VERSION}" /opt/android-ndk \
 && rm /tmp/ndk.zip

ENV ANDROID_NDK=/opt/android-ndk
WORKDIR /build
