# Builds LVL's Android native parts (Node.js or FFmpeg) in the lvl-android-native Docker image.
#
#   pwsh android/native/docker-build.ps1 -What node -Arch x86_64
#   pwsh android/native/docker-build.ps1 -What ffmpeg -Arch arm64 -Jobs 4
#   pwsh android/native/docker-build.ps1 -BuildImage
#
# Sources and objects stay in the Docker volume lvl-android-native-build (fast, inside the VM);
# results go to build/android-native/<what>/<abi>/ in this checkout. A Node build takes about an
# hour per processor type on a 6-core PC; FFmpeg takes a few minutes.
#
# The recipe runs from a copy made inside the container, with Windows line endings removed:
# bash reads a script while it runs, so editing the original during a build is then safe, and
# a checkout that turned LF into CRLF still works.
[CmdletBinding()]
param(
  [ValidateSet("node", "ffmpeg")] [string] $What = "node",
  [ValidateSet("x86_64", "arm64")] [string] $Arch = "x86_64",
  [ValidateRange(1, 64)] [int] $Jobs = 8,
  [string] $Image = "lvl-android-native:r28c",
  [switch] $BuildImage
)
$ErrorActionPreference = "Stop"
$native = $PSScriptRoot
$root = (Resolve-Path (Join-Path $native "..\..")).Path

if ($BuildImage) {
  docker build -t $Image $native
  exit $LASTEXITCODE
}

$out = Join-Path $root "build\android-native"
New-Item -ItemType Directory -Path $out -Force | Out-Null
$name = "lvl-android-$What-$Arch"
$inner = "tr -d '\r' < /scripts/build-$What.sh > /tmp/build.sh && exec bash /tmp/build.sh $Arch"
docker run --rm --name $name `
  -v "lvl-android-native-build:/build" `
  -v "${out}:/out" `
  -v "${native}:/scripts:ro" `
  -e "JOBS=$Jobs" `
  $Image bash -c $inner
exit $LASTEXITCODE
