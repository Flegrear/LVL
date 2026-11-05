#!/usr/bin/env bash
# Cross-compiles the Node.js executable for Android inside the lvl-android-native image.
#
# Usage: build-node.sh <x86_64|arm64>
# Env:   NODE_VERSION (default 24.22.2), ANDROID_API (default 31), JOBS (default 8)
# Mounts: /build = Docker volume for sources and objects (fast, inside the VM)
#         /out   = output folder on the host (build/android-native in the worktree)
#
# Why these options:
# - small ICU: LVL needs Unicode property regexes (\p{L}) and String.prototype.normalize;
#   Node built without ICU rejects those regexes and the server would not start.
# - static libc++ and Android's own zlib: the executable depends only on system libraries.
# - 16 KB page alignment: required on phones that use 16 KB memory pages.
# - --openssl-no-asm: the assembly build of OpenSSL does not cross-compile for Android.
set -euo pipefail

ARCH="${1:?usage: build-node.sh <x86_64|arm64>}"
NODE_VERSION="${NODE_VERSION:-24.22.2}"
API="${ANDROID_API:-31}"
JOBS="${JOBS:-8}"
NDK="${ANDROID_NDK:-/opt/android-ndk}"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"

case "$ARCH" in
  x86_64) DEST_CPU=x64;   GYP_ARCH=x64;   TRIPLE=x86_64-linux-android;  ABI=x86_64 ;;
  arm64)  DEST_CPU=arm64; GYP_ARCH=arm64; TRIPLE=aarch64-linux-android; ABI=arm64-v8a ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 2 ;;
esac

CACHE=/build/cache
SRC="/build/node-v$NODE_VERSION-$ARCH"
OUT="/out/node/$ABI"
mkdir -p "$CACHE" "$OUT"

log() { echo "[build-node $ARCH $(date -u +%H:%M:%S)] $*"; }

TARBALL="$CACHE/node-v$NODE_VERSION.tar.xz"
# Always refresh the official checksum catalog and verify the tarball, even if
# this Docker volume already contains a cached source archive. Cache presence
# alone must never make an unverified source eligible for a release build.
curl -fsSL --retry 2 -o "$CACHE/SHASUMS256-v$NODE_VERSION.txt.part" \
  "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
mv "$CACHE/SHASUMS256-v$NODE_VERSION.txt.part" "$CACHE/SHASUMS256-v$NODE_VERSION.txt"
expected="$(awk -v f="node-v$NODE_VERSION.tar.xz" '$2 == f { print $1 }' "$CACHE/SHASUMS256-v$NODE_VERSION.txt")"
if ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Official Node.js SHA-256 digest missing for node-v$NODE_VERSION.tar.xz" >&2
  exit 1
fi
if [ ! -f "$TARBALL" ]; then
  log "downloading node-v$NODE_VERSION.tar.xz"
  curl -fsSL --retry 2 -o "$TARBALL.part" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION.tar.xz"
  mv "$TARBALL.part" "$TARBALL"
fi
NODE_SOURCE_SHA256="$(sha256sum "$TARBALL" | awk '{ print $1 }')"
if [ "$NODE_SOURCE_SHA256" != "$expected" ]; then
  echo "SHA-256 mismatch for cached or downloaded node-v$NODE_VERSION.tar.xz" >&2
  exit 1
fi

export CC="$TOOLCHAIN/bin/$TRIPLE$API-clang"
export CXX="$TOOLCHAIN/bin/$TRIPLE$API-clang++"
export AR="$TOOLCHAIN/bin/llvm-ar"
export LDFLAGS="-Wl,-z,max-page-size=16384 -static-libstdc++"
# Build tools that run during the build (torque, mksnapshot, ICU tools) use the host
# compiler. Without these, gyp falls back to CC/CXX, the Android compiler, and V8's host
# code fails on Android-only headers (seen: backtrace() undeclared in stack_trace_posix.cc).
export CC_host=gcc CXX_host=g++ AR_host=ar
export GYP_DEFINES="target_arch=$GYP_ARCH v8_target_arch=$GYP_ARCH android_target_arch=$GYP_ARCH host_os=linux OS=android android_ndk_path=$NDK"

if [ ! -f "$SRC/.lvl-unpacked" ]; then
  log "unpacking sources"
  rm -rf "$SRC"
  mkdir -p "$SRC"
  tar -xJf "$TARBALL" -C "$SRC" --strip-components=1
  touch "$SRC/.lvl-unpacked"
fi

cd "$SRC"
# V8's trap handler (WebAssembly bounds checks through signals) must be off in both
# toolsets. The Android binary already has it off (V8 excludes Android), but the build-time
# tools are compiled by the Linux host compiler, where V8's header turns it on, while gyp
# picks the handler's sources by OS=android and leaves them out: mksnapshot then fails to
# link (undefined trap_handler::TryHandleSignal and RegisterDefaultTrapHandler). Node's own
# android-patches/trap-handler.h.patch made the same change but no longer applies to V8 13.6.
TRAP_H=deps/v8/src/trap-handler/trap-handler.h
if ! grep -q 'LVL Android build' "$TRAP_H"; then
  log "turning V8's trap handler off for both toolsets"
  stamp=$(stat -c %Y "$TRAP_H")
  python3 - "$TRAP_H" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
start = text.index("#if V8_HOST_ARCH_X64 && V8_TARGET_ARCH_X64")
end_marker = "#define V8_TRAP_HANDLER_SUPPORTED false\n#endif"
end = text.index(end_marker, start) + len(end_marker)
text = text[:start] + "// LVL Android build: no trap handler in either toolset (see build-node.sh).\n#define V8_TRAP_HANDLER_SUPPORTED false" + text[end:]
open(path, "w").write(text)
PY
  # About 2,000 objects include this header, but only the .cc files found below use the
  # switch, and only their host copies change (the Android copies already had it off; the
  # one class whose layout depends on it, Sandbox, isn't built). So a partly built tree keeps
  # the header's timestamp and recompiles just those objects instead of most of V8.
  touch -d "@$stamp" "$TRAP_H"
  if [ -d out/Release/obj.host ]; then
    for cc in $(grep -rl -E 'V8_TRAP_HANDLER_SUPPORTED|V8_TRAP_HANDLER_VIA_SIMULATOR' deps/v8/src --include='*.cc'); do
      find out/Release/obj.host -path "*/${cc%.cc}.o" -print -delete
    done
  fi
fi

CONFIGURE_ARGS="--dest-cpu=$DEST_CPU --dest-os=android --cross-compiling --openssl-no-asm --with-intl=small-icu --shared-zlib --without-npm --without-corepack --without-inspector"
# Configure again only when the settings change, so a rerun continues where it stopped.
if [ "$(cat .lvl-configure 2>/dev/null)" != "$CONFIGURE_ARGS API=$API NDK=$NDK" ]; then
  log "configuring for $DEST_CPU, API $API"
  # shellcheck disable=SC2086
  ./configure $CONFIGURE_ARGS
  echo "$CONFIGURE_ARGS API=$API NDK=$NDK" > .lvl-configure
fi
# Host objects compiled with the wrong compiler by an earlier run must not be reused.
if [ -f out/Release/.lvl-host-compiler ] && [ "$(cat out/Release/.lvl-host-compiler)" != "$CXX_host" ]; then rm -rf out/Release/obj.host; fi
if [ ! -f out/Release/.lvl-host-compiler ]; then rm -rf out/Release/obj.host; fi
mkdir -p out/Release && echo "$CXX_host" > out/Release/.lvl-host-compiler
log "building the node executable with $JOBS jobs"
# Only the `node` target: Node's default `all` also builds C++ test programs (cctest,
# embedtest, fuzzers) and the OpenSSL command-line tool, which the app doesn't ship.
make -C out BUILDTYPE=Release -j"$JOBS" node 2>&1 | tee "$OUT/make.log"

log "stripping and recording build facts"
"$TOOLCHAIN/bin/llvm-strip" -o "$OUT/node" out/Release/node
cp LICENSE "$OUT/LICENSE.node.txt"
{
  echo "node $NODE_VERSION for Android $ABI (API $API), built $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node-v$NODE_VERSION.tar.xz sha256 $NODE_SOURCE_SHA256"
  echo "ndk: $(head -n 1 "$NDK/source.properties" 2>/dev/null) $(grep -m1 Pkg.Revision "$NDK/source.properties" 2>/dev/null)"
  echo "configure: $CONFIGURE_ARGS"
  echo "file: $(file -b "$OUT/node")"
  echo "size: $(stat -c %s "$OUT/node") bytes (stripped)"
  echo "needed libraries:"; "$TOOLCHAIN/bin/llvm-readelf" -d "$OUT/node" | awk '/NEEDED/ { print "  " $NF }'
  echo "LOAD segment alignment:"; "$TOOLCHAIN/bin/llvm-readelf" -lW "$OUT/node" | awk '$1 == "LOAD" { print "  " $NF }'
} > "$OUT/BUILDINFO.txt"
cat "$OUT/BUILDINFO.txt"
log "done"
