# Build two signed LVL Android APKs and package the exact assets ReleaseFeed expects.
# Runs only after the batch owner grants APK staging and Gradle access.
# Signing secrets are read from environment, never from command-line arguments or source files.
[CmdletBinding()]
param(
  [string] $OutDir = "tmp/android-batch/release/assets",
  [string] $GradleCommand = "",
  [string] $ApkSigner = "",
  [switch] $SkipStage,
  [string] $ReviewedCommit = "",
  [string] $CandidateVersion = ""
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ($SkipStage) { throw 'Retained Android staging cannot establish release source provenance; fresh staging is required.' }
if (-not $ReviewedCommit -or -not $CandidateVersion) {
  throw 'Signed Android release requires explicit -ReviewedCommit and -CandidateVersion.'
}
$sourceCheck = @('scripts/release-provenance.mjs', 'verify', '--platform', 'android',
  '--reviewed-commit', $ReviewedCommit, '--version', $CandidateVersion)
Push-Location $root
try { & node @sourceCheck; if ($LASTEXITCODE -ne 0) { throw 'Android release source is not equal to reviewed commit/version.' } }
finally { Pop-Location }
$androidVersion = Get-Content -LiteralPath (Join-Path $root 'android\app-version.json') -Raw | ConvertFrom-Json
$version = [string]$androidVersion.version
$versionCode = [int]$androidVersion.versionCode
if ($version -cne $CandidateVersion) { throw 'Android candidate version differs from app-version.json.' }
if ($versionCode -lt 205) { throw 'Android versionCode must be greater than all previous synthetic builds (204)' }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $root 'build\tools\android-sdk' }
$gradle = if ($GradleCommand) { $GradleCommand } elseif (Test-Path (Join-Path $root 'build\tools\gradle-9.8.2\bin\gradle.bat')) { Join-Path $root 'build\tools\gradle-9.8.2\bin\gradle.bat' } else { (Get-Command gradle -ErrorAction SilentlyContinue).Source }
$signer = if ($ApkSigner) { $ApkSigner } else { Join-Path $sdk 'build-tools\37.0.0\apksigner.bat' }
$aapt = Join-Path $sdk 'build-tools\37.0.0\aapt2.exe'
$cert = [string] $env:LVL_ANDROID_CERT_SHA256
$expectedKeys = @('LVL_ANDROID_KEYSTORE','LVL_ANDROID_KEYSTORE_PASSWORD','LVL_ANDROID_KEY_ALIAS','LVL_ANDROID_KEY_PASSWORD')
foreach ($key in $expectedKeys) { if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key))) { throw "Missing Android release signing credential $key" } }
if (-not (Test-Path -LiteralPath $env:LVL_ANDROID_KEYSTORE -PathType Leaf)) { throw 'Android signing keystore file is missing' }
if ($cert -notmatch '^[0-9a-fA-F]{64}$') { throw 'LVL_ANDROID_CERT_SHA256 must contain the trusted signing certificate fingerprint' }
$cert = $cert.ToLowerInvariant()
if (-not $gradle -or -not (Get-Command $gradle -ErrorAction SilentlyContinue)) { throw 'Gradle 9.8.2 is required; specify -GradleCommand if it is not installed' }
if (-not (Test-Path -LiteralPath $signer -PathType Leaf)) { throw "Android build-tools 37 apksigner is missing at $signer" }
if (-not (Test-Path -LiteralPath $aapt -PathType Leaf)) { throw "Android build-tools 37 aapt2 is missing at $aapt" }
if (-not (Test-Path -LiteralPath $sdk -PathType Container)) { throw "Android SDK is missing at $sdk" }
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
if (-not $env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = Join-Path $root 'build\gradle-home' }

Push-Location $root
try {
  & node android/tools/release-check.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Native Android release source validation failed' }
  & node android/stage-app.mjs --release --abi arm64-v8a --abi x86_64 --reviewed-commit $ReviewedCommit --candidate-version $CandidateVersion
  if ($LASTEXITCODE -ne 0) { throw 'Android release staging failed' }
  & node android/tools/release-check.mjs --stage-dir (Join-Path $root 'build\android-stage') --version $version --reviewed-commit $ReviewedCommit
  if ($LASTEXITCODE -ne 0) { throw 'Staged Android release content failed validation' }
  # A release APK must be produced from a clean package output, not reused
  # incremental ZIP state from an earlier (possibly debug) Gradle invocation.
  & $gradle -p (Join-Path $root 'android') --project-cache-dir (Join-Path $root 'build\android-gradle\.gradle') --console=plain --no-daemon clean assembleRelease
  if ($LASTEXITCODE -ne 0) { throw "Android Gradle build failed (exit $LASTEXITCODE)" }

  $apkDir = Join-Path $root 'build\android-gradle\app\outputs\apk\release'
  $metadata = Get-Content -LiteralPath (Join-Path $apkDir 'output-metadata.json') -Raw | ConvertFrom-Json
  if ($metadata.applicationId -cne 'io.github.flegrear.lvl' -or $metadata.variantName -cne 'release' -or $metadata.elements.Count -ne 2) { throw 'Invalid Android release split metadata' }
  $hashes = @{}
  $foundAbis = @()
  $verifiedApks = @()
  foreach ($element in $metadata.elements) {
    if ($element.filters.Count -ne 1 -or $element.filters[0].filterType -cne 'ABI') { throw 'Unexpected Android APK split' }
    $abi = [string] $element.filters[0].value
    if ($abi -notin @('arm64-v8a', 'x86_64') -or $abi -in $foundAbis -or $element.versionName -cne $version -or $element.versionCode -ne $versionCode) { throw "Unexpected APK ABI/version: $abi" }
    if ($element.outputFile -cnotmatch '^app-[A-Za-z0-9_-]+-release\.apk$') { throw 'Unexpected release APK filename' }
    $foundAbis += $abi
    $apk = Join-Path $apkDir $element.outputFile
    if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw "Missing Android APK: $apk" }
    $badging = (& $aapt dump badging $apk) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Cannot read APK manifest for $abi" }
    $packageLine = ($badging -split "`n" | Where-Object { $_ -like 'package:*' } | Select-Object -First 1)
    if ($packageLine -notmatch "name='io\.github\.flegrear\.lvl'" -or
        $packageLine -notmatch "versionCode='$([regex]::Escape([string]$element.versionCode))'" -or
        $packageLine -notmatch "versionName='$([regex]::Escape($version))'") { throw "APK identity/version mismatch for $abi" }
    $signature = (& $signer verify --verbose --print-certs $apk) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed for $abi" }
    # Current build-tools report "V2 Signer: certificate SHA-256 digest" for v2-only
    # APKs; other apksigner versions may use the older "Signer #1" form.
    $match = [regex]::Match($signature, '(?im)^(?:V[234](?:\.\d+)? Signer:|Signer #\d+) certificate SHA-256 digest:\s*([0-9a-fA-F:]+)\s*$')
    if (-not $match.Success -or $match.Groups[1].Value.Replace(':','').ToLowerInvariant() -cne $cert) { throw "Unexpected signing certificate for $abi" }
    if ($signature -notmatch '(?im)^Verified using v[23] scheme.*:\s*true\s*$') { throw "APK signature scheme v2/v3 was not verified for $abi" }
    & node android/tools/release-check.mjs --stage-dir (Join-Path $root 'build\android-stage') --version $version --reviewed-commit $ReviewedCommit --apk $apk
    if ($LASTEXITCODE -ne 0) { throw "Signed APK payload differs from staged reviewed release: $abi" }
    $hashes[$abi] = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
    $verifiedApks += $apk
  }
  $evidenceDir = Join-Path $root 'tmp\android-batch\release'
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $evidence = Join-Path $evidenceDir 'signature-evidence.json'
  [ordered]@{version=$version;reviewedCommit=$ReviewedCommit;signerSha256=$cert;apks=$hashes} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $evidence -Encoding utf8
  # Gradle also writes optional baselineProfiles/*.dm build metadata. Give the
  # strict asset packager only the APKs whose identity and signature we checked.
  $verifiedApkDir = Join-Path $evidenceDir 'verified-apks'
  if (Test-Path -LiteralPath $verifiedApkDir) {
    $inputItem = Get-Item -LiteralPath $verifiedApkDir -Force
    if (-not $inputItem.PSIsContainer -or ($inputItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        @(Get-ChildItem -LiteralPath $verifiedApkDir -Force).Count -ne 0) { throw 'Verified APK input directory must be ordinary and empty' }
  } else { New-Item -ItemType Directory -Path $verifiedApkDir | Out-Null }
  Copy-Item -LiteralPath (Join-Path $apkDir 'output-metadata.json') -Destination (Join-Path $verifiedApkDir 'output-metadata.json')
  foreach ($verifiedApk in $verifiedApks) {
    Copy-Item -LiteralPath $verifiedApk -Destination (Join-Path $verifiedApkDir (Split-Path -Leaf $verifiedApk))
  }
  $out = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }
  $assetsArgs = @('android/tools/release-assets.mjs','--apk-dir',$verifiedApkDir,'--out-dir',$out,'--version',$version,'--evidence',$evidence)
  & node @assetsArgs
  if ($LASTEXITCODE -ne 0) { throw 'Android release asset packaging failed' }
  Write-Host "Android release assets created in $out"
} finally {
  Pop-Location
}
