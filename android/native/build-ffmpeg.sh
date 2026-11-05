#!/usr/bin/env bash
# Cross-compiles ffmpeg and ffprobe for Android inside the lvl-android-native image.
#
# Usage: build-ffmpeg.sh <x86_64|arm64>
# Env:   FFMPEG_VERSION (default 7.1.5), WEBP_VERSION (default 1.6.0), ANDROID_API (31), JOBS (4 max)
# Mounts: /build = Docker volume, /out = build/android-native in the worktree
#
# LGPL build (user decision 2026-10-31): no --enable-gpl, so no libx264. Only what LVL's
# server asks FFmpeg for (server.js and backend/media/*.js, checked 2026-10-31):
# - remux to fragmented MP4 (-c:v copy, -movflags frag_keyframe+empty_moov+default_base_moof)
#   with audio converted to AAC from AC-3, E-AC-3, DTS, TrueHD, Opus, FLAC, Vorbis or MP3
# - embedded subtitles to WebVTT, ASS or SRT; probing with ffprobe (-show_packets, -show_frames)
# - speech activity as raw 16-bit PCM (-af aresample, highpass, lowpass, -f s16le), also as a
#   second output of every remux (server.js), so a missing filter there fails the whole remux
# - posters to WebP (-vf scale, -c:v libwebp, -f webp) from JPEG, PNG or WebP on a pipe
# Inputs arrive over LVL's own loopback HTTP server, so http and tcp are the only network
# protocols; there is no TLS.
set -euo pipefail

ARCH="${1:?usage: build-ffmpeg.sh <x86_64|arm64>}"
FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.5}"
WEBP_VERSION="${WEBP_VERSION:-1.6.0}"
API="${ANDROID_API:-31}"
JOBS="${JOBS:-4}"
if ! [[ "$JOBS" =~ ^[1-4]$ ]]; then echo "FFmpeg builds require JOBS between 1 and 4" >&2; exit 2; fi
# These reviewed source archive digests bind both fresh and cached downloads.
# Changing either upstream version requires a separately reviewed recipe.
if [ "$FFMPEG_VERSION" != "7.1.5" ] || [ "$WEBP_VERSION" != "1.6.0" ]; then
  echo "Unreviewed FFmpeg or libwebp version" >&2; exit 2
fi
FFMPEG_SOURCE_SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
WEBP_SOURCE_SHA256=e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564
NDK="${ANDROID_NDK:-/opt/android-ndk}"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"

case "$ARCH" in
  x86_64) FF_ARCH=x86_64;  FF_CPU=x86-64;   TRIPLE=x86_64-linux-android;  ABI=x86_64 ;;
  arm64)  FF_ARCH=aarch64; FF_CPU=armv8-a;  TRIPLE=aarch64-linux-android; ABI=arm64-v8a ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 2 ;;
esac

CACHE=/build/cache
WORK="/build/ffmpeg-$FFMPEG_VERSION-$ARCH"
PREFIX="$WORK/prefix"
# Keep the deployable FFmpeg untouched until a candidate is explicitly
# validated and selected for packaging.
OUT="/out/ffmpeg/candidates/$ABI"
mkdir -p "$CACHE" "$OUT" "$WORK"
log() { echo "[build-ffmpeg $ARCH $(date -u +%H:%M:%S)] $*"; }

fetch() { # url file
  local expected
  case "$2" in
    "ffmpeg-$FFMPEG_VERSION.tar.xz") expected="$FFMPEG_SOURCE_SHA256" ;;
    "libwebp-$WEBP_VERSION.tar.gz") expected="$WEBP_SOURCE_SHA256" ;;
    *) echo "Unreviewed native source archive: $2" >&2; exit 2 ;;
  esac
  if [ ! -f "$CACHE/$2" ]; then
    log "downloading $2"
    curl -fsSL --connect-timeout 15 --max-time 120 --retry 2 -o "$CACHE/$2.part" "$1"
    mv "$CACHE/$2.part" "$CACHE/$2"
  fi
  local actual
  actual="$(sha256sum "$CACHE/$2" | awk '{ print $1 }')"
  if [ "$actual" != "$expected" ]; then
    echo "Source SHA-256 mismatch for fresh or cached $2" >&2; exit 1
  fi
  echo "$2 sha256 $actual" >> "$WORK/sources.txt"
}
: > "$WORK/sources.txt"
fetch "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-$WEBP_VERSION.tar.gz" "libwebp-$WEBP_VERSION.tar.gz"
# Debian redistributes the byte-identical upstream archive; the reviewed digest
# above remains authoritative. Fetch it before spending hours compiling Node.
fetch "https://deb.debian.org/debian/pool/main/f/ffmpeg/ffmpeg_$FFMPEG_VERSION.orig.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz"

export CC="$TOOLCHAIN/bin/$TRIPLE$API-clang"
export CXX="$TOOLCHAIN/bin/$TRIPLE$API-clang++"
PAGE_FLAGS="-Wl,-z,max-page-size=16384"

# libwebp (BSD licence), static, for the poster encoder.
if [ ! -f "$PREFIX/lib/libwebp.a" ]; then
  log "building libwebp $WEBP_VERSION"
  rm -rf "$WORK/libwebp-$WEBP_VERSION" "$WORK/webp-build"
  tar -xzf "$CACHE/libwebp-$WEBP_VERSION.tar.gz" -C "$WORK"
  cmake -S "$WORK/libwebp-$WEBP_VERSION" -B "$WORK/webp-build" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$ABI" -DANDROID_PLATFORM="android-$API" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF \
    -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF \
    -DWEBP_BUILD_EXTRAS=OFF -DWEBP_BUILD_LIBWEBPMUX=OFF
  cmake --build "$WORK/webp-build" -j "$JOBS"
  cmake --install "$WORK/webp-build"
fi

SRC="$WORK/ffmpeg-$FFMPEG_VERSION"
rm -rf "$SRC"
tar -xJf "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK"
cd "$SRC"

# Component names are configure's, not the codec or format names: the MP4 subtitle codec
# "mov_text" is `movtext`, and the raw "s16le" format's muxer is `pcm_s16le`. A name that
# doesn't match is skipped without a warning, so the enabled lists are checked below.
DEMUXERS="matroska,mov,mpegts,avi,flv,ogg,wav,mp3,aac,ac3,eac3,dts,dtshd,truehd,flac,ass,srt,webvtt,image2,image_jpeg_pipe,image_png_pipe,image_webp_pipe,rawvideo"
MUXERS="mp4,mov,webvtt,ass,srt,pcm_s16le,null,webp"
DECODERS="h264,hevc,vp9,mpeg4,mpeg2video,mjpeg,png,webp,rawvideo,aac,aac_latm,ac3,eac3,dca,truehd,mlp,mp3,mp2,opus,vorbis,flac,alac,pcm_s16le,pcm_s24le,pcm_f32le,ass,ssa,srt,subrip,webvtt,movtext,text"
# h264_mediacodec: the phone's own H.264 encoder (Android MediaCodec through the NDK; no libx264,
# so the build stays LGPL). LVL converts video the browser can't play (HEVC 10-bit and others)
# with it.
ENCODERS="aac,pcm_s16le,libwebp,ass,ssa,srt,subrip,webvtt,movtext,h264_mediacodec"
PARSERS="h264,hevc,aac,aac_latm,ac3,dca,mlp,mpegaudio,opus,vorbis,flac,vp9,av1,mjpeg,png,webp"
BSFS="aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,vp9_superframe,null"
FILTERS="aresample,aformat,anull,highpass,lowpass,pan,volume,scale,format,null,copy,setpts,asetpts"

log "configuring FFmpeg $FFMPEG_VERSION for $FF_ARCH, API $API"
PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" ./configure \
  --target-os=android --enable-cross-compile --arch="$FF_ARCH" --cpu="$FF_CPU" \
  --cc="$CC" --cxx="$CXX" --ar="$TOOLCHAIN/bin/llvm-ar" --nm="$TOOLCHAIN/bin/llvm-nm" \
  --ranlib="$TOOLCHAIN/bin/llvm-ranlib" --strip="$TOOLCHAIN/bin/llvm-strip" \
  --sysroot="$TOOLCHAIN/sysroot" --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-O2 -fPIC -I$PREFIX/include" --extra-ldflags="$PAGE_FLAGS -L$PREFIX/lib" \
  --extra-libs="-lm" \
  --enable-pic --disable-shared --enable-static \
  --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-ffplay \
  --enable-ffmpeg --enable-ffprobe --enable-zlib --enable-libwebp \
  --enable-jni --enable-mediacodec \
  --enable-avcodec --enable-avformat --enable-avfilter --enable-swresample --enable-swscale \
  --enable-protocol=file,pipe,http,tcp \
  --enable-demuxer="$DEMUXERS" --enable-muxer="$MUXERS" \
  --enable-decoder="$DECODERS" --enable-encoder="$ENCODERS" \
  --enable-parser="$PARSERS" --enable-bsf="$BSFS" --enable-filter="$FILTERS" \
  2>&1 | tee "$OUT/configure.log"
grep -q '^License: LGPL' "$OUT/configure.log" || { echo "FFmpeg configured with a licence other than LGPL" >&2; exit 1; }
missing=""
check_enabled() { # kind list
  local kind="$1" name
  for name in ${2//,/ }; do
    grep -q "^#define CONFIG_$(echo "$name" | tr '[:lower:]' '[:upper:]')_${kind} 1" config_components.h || missing="$missing ${name}_$(echo "$kind" | tr '[:upper:]' '[:lower:]')"
  done
}
check_enabled DEMUXER "$DEMUXERS"; check_enabled MUXER "$MUXERS"; check_enabled DECODER "$DECODERS"
check_enabled ENCODER "$ENCODERS"; check_enabled PARSER "$PARSERS"; check_enabled BSF "$BSFS"; check_enabled FILTER "$FILTERS"
if [ -n "$missing" ]; then echo "Requested components that configure didn't enable:$missing" >&2; exit 1; fi

log "building with $JOBS jobs"
make -j"$JOBS" ffmpeg ffprobe > "$OUT/make.log" 2>&1 || { tail -40 "$OUT/make.log" >&2; exit 1; }
test -x ffmpeg && test -x ffprobe

"$TOOLCHAIN/bin/llvm-strip" -o "$OUT/ffmpeg" ffmpeg
"$TOOLCHAIN/bin/llvm-strip" -o "$OUT/ffprobe" ffprobe
cp COPYING.LGPLv2.1 "$OUT/LICENSE.ffmpeg.txt"
cp "$WORK/libwebp-$WEBP_VERSION/COPYING" "$OUT/LICENSE.libwebp.txt"
{
  echo "FFmpeg $FFMPEG_VERSION + libwebp $WEBP_VERSION for Android $ABI (API $API), built $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat "$WORK/sources.txt"
  grep -E '^License:' "$OUT/configure.log"
  for bin in ffmpeg ffprobe; do
    echo "$bin: $(stat -c %s "$OUT/$bin") bytes (stripped); needs: $("$TOOLCHAIN/bin/llvm-readelf" -d "$OUT/$bin" | awk '/NEEDED/ { gsub(/[][]/, "", $NF); printf "%s ", $NF }')"
    echo "$bin LOAD alignment: $("$TOOLCHAIN/bin/llvm-readelf" -lW "$OUT/$bin" | awk '$1 == "LOAD" { printf "%s ", $NF }')"
  done
} > "$OUT/BUILDINFO.txt"
cat "$OUT/BUILDINFO.txt"
log "done"
