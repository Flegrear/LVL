[CmdletBinding()]
param(
  [switch]$StageOnly,
  [string]$CompilerPath = '',
  [string]$NodeRuntimePath = ''
)

# New public LVL Windows setup. Only build/ and dist/ are written.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'build\installer'))
$payloadRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot 'payload'))
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot 'cache'))
$distRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$nodeVersion = '22.23.3'
$nodeHash = '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e'
$nodeLicenseHash = 'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4'
$nodeUrl = "https://nodejs.org/download/release/v$nodeVersion/win-x64/node.exe"
$nodeLicenseUrl = "https://raw.githubusercontent.com/nodejs/node/v$nodeVersion/LICENSE"

function Assert-Under([string]$Candidate, [string]$Base) {
  $full = [IO.Path]::GetFullPath($Candidate)
  $parent = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  if (-not $full.StartsWith($parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe output path outside $parent : $full"
  }
  return $full
}

function Assert-Hash([string]$File, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Missing verified asset: $File" }
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "SHA256 mismatch for $File. Expected $Expected, found $actual" }
}

function Download-Verified([string]$File, [string]$Url, [string]$Expected) {
  if (Test-Path -LiteralPath $File -PathType Leaf) {
    Assert-Hash $File $Expected
    return
  }
  $part = $File + '.download'
  if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
  try {
    Write-Host "Downloading pinned runtime asset: $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $part
    Assert-Hash $part $Expected
    Move-Item -LiteralPath $part -Destination $File
  } finally {
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
  }
}

function Find-InnoSetup([string]$Requested) {
  $candidates = [Collections.Generic.List[string]]::new()
  if ($Requested) {
    if (Test-Path -LiteralPath $Requested -PathType Container) {
      $candidates.Add((Join-Path $Requested 'ISCC.exe'))
    } else {
      $candidates.Add($Requested)
    }
  }
  if ($env:INNO_SETUP_COMPILER) { $candidates.Add($env:INNO_SETUP_COMPILER) }
  $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates.Add($command.Source) }
  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  if ($programFilesX86) { $candidates.Add((Join-Path $programFilesX86 'Inno Setup 6\ISCC.exe')) }
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')) }
  # Shared developer compiler is only a build tool. Never bundle it.
  if ($env:USERPROFILE) {
    $candidates.Add((Join-Path $env:USERPROFILE 'Code\Language-video-learner\build\tools\inno-6.7.3\ISCC.exe'))
  }
  foreach ($item in $candidates) {
    if ($item -and (Test-Path -LiteralPath $item -PathType Leaf)) { return [IO.Path]::GetFullPath($item) }
  }
  throw 'Inno Setup 6 ISCC.exe not found. Pass -CompilerPath or use -StageOnly.'
}

$payloadRoot = Assert-Under $payloadRoot $buildRoot
$cacheRoot = Assert-Under $cacheRoot $buildRoot
$distRoot = Assert-Under $distRoot $projectRoot

$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 build host required.' }
$hostNode = (& $node --version).TrimStart('v').Trim()
if ($LASTEXITCODE -ne 0 -or $hostNode -notmatch '^\d+\.\d+\.\d+$' -or
    [Version]$hostNode -lt [Version]'22.17.0') { throw "Node.js >=22.17.0 required for packaging; found $hostNode." }
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.name -ne 'lvl' -or $package.version -notmatch '^\d+\.\d+\.\d+$') {
  throw "LVL release builder requires a semantic version; got $($package.name) v$($package.version)."
}

New-Item -ItemType Directory -Path $buildRoot, $cacheRoot -Force | Out-Null
if (Test-Path -LiteralPath $payloadRoot) {
  Write-Host 'Replacing generated installer staging directory.'
  Remove-Item -LiteralPath (Assert-Under $payloadRoot $buildRoot) -Recurse -Force
}
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null

Write-Host 'Staging reviewed application inputs from positive source allowlist...'
& $node (Join-Path $PSScriptRoot 'stage.mjs') $payloadRoot
if ($LASTEXITCODE -ne 0) { throw 'Allowlisted source staging failed.' }

# package-lock is required to install exact packages but is not itself bundled.
Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination (Join-Path $payloadRoot 'package-lock.json')
Write-Host 'Installing locked production dependencies in isolated staging...'
& $npm ci --omit=dev --no-audit --no-fund --prefix $payloadRoot
if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)." }
Remove-Item -LiteralPath (Join-Path $payloadRoot 'package-lock.json') -Force

# Prune irrelevant platform binaries/development directories ONLY in staging.
$ffprobeBin = Join-Path $payloadRoot 'node_modules\ffprobe-static\bin'
foreach ($platform in @('darwin', 'linux')) {
  $folder = Join-Path $ffprobeBin $platform
  if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force }
}
$win32Ia32 = Join-Path $ffprobeBin 'win32\ia32'
if (Test-Path -LiteralPath $win32Ia32) { Remove-Item -LiteralPath $win32Ia32 -Recurse -Force }
$modulesDir = Join-Path $payloadRoot 'node_modules'
$developmentDirs = @(Get-ChildItem -LiteralPath $modulesDir -Directory -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name.ToLowerInvariant() -in @('test', 'tests', '__tests__', 'docs', 'devtools', 'benchmarks', 'examples', 'coverage', '.github', '.history') } |
  Sort-Object { $_.FullName.Length } -Descending)
foreach ($dir in $developmentDirs) {
  if (Test-Path -LiteralPath $dir.FullName) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
}
# Some published npm packages put test.js directly in their runtime folder
# rather than in tests/. These files are never entrypoints of the locked
# production dependencies. Remove them from the disposable staged copy only.
$developmentFiles = @(Get-ChildItem -LiteralPath $modulesDir -File -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(?:test(?:[-_.].*)?|.*\.(?:test|spec)\.(?:[cm]?js|tsx?|jsx)|vitest\.config\.[cm]?js)$' })
foreach ($file in $developmentFiles) {
  if (Test-Path -LiteralPath $file.FullName) { Remove-Item -LiteralPath $file.FullName -Force }
}
# Install only what runs: no package docs, type definitions, TypeScript
# sources or source maps (licence and notice files stay), and native
# prebuilds for Windows x64 only. installer/verify.mjs fails the build if
# any of these remain.
$documentationFiles = @(Get-ChildItem -LiteralPath $modulesDir -File -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { ($_.Name -match '\.(?:md|markdown|map|d\.[cm]?ts|[cm]?ts)$') -and ($_.Name -notmatch '^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$') })
foreach ($file in $documentationFiles) {
  if (Test-Path -LiteralPath $file.FullName) { Remove-Item -LiteralPath $file.FullName -Force }
}
$otherPlatformBuilds = @(Get-ChildItem -LiteralPath $modulesDir -Directory -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'prebuilds' } | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -Force } |
  Where-Object { $_.Name -ne 'win32-x64' })
foreach ($dir in $otherPlatformBuilds) {
  if (Test-Path -LiteralPath $dir.FullName) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
}

$nodeCache = Join-Path $cacheRoot "node-v$nodeVersion-win-x64.exe"
$licenseCache = Join-Path $cacheRoot "node-v$nodeVersion-LICENSE.txt"
if ($NodeRuntimePath) {
  Assert-Hash $NodeRuntimePath $nodeHash
  Copy-Item -LiteralPath $NodeRuntimePath -Destination $nodeCache -Force
} else {
  Download-Verified $nodeCache $nodeUrl $nodeHash
}
Download-Verified $licenseCache $nodeLicenseUrl $nodeLicenseHash
$runtimeDir = Join-Path $payloadRoot 'runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Copy-Item -LiteralPath $nodeCache -Destination (Join-Path $runtimeDir 'node.exe')
Copy-Item -LiteralPath $licenseCache -Destination (Join-Path $runtimeDir 'LICENSE.txt')
# The standalone patch helper is NOT part of source asset selection or Git
# diff patches: it is installed by the one-time bootstrap/full setup.
$patchHelper = Join-Path $projectRoot 'runtime\update-apply.mjs'
if (-not (Test-Path -LiteralPath $patchHelper -PathType Leaf)) {
  throw 'Missing bundled offline patch helper runtime/update-apply.mjs.'
}
Copy-Item -LiteralPath $patchHelper -Destination (Join-Path $runtimeDir 'update-apply.mjs')

# Launcher uses installed marker to isolate data/profile and bundled runtime.
$marker = [ordered]@{
  schemaVersion = 1
  appId = 'lvl-public'
  installType = 'per-user'
  version = $package.version
  port = 4273
  dataRoot = '%LOCALAPPDATA%\LVL\data'
  browserProfile = '%LOCALAPPDATA%\LVL\browser-profile'
}
$markerJson = $marker | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $payloadRoot 'installed-app.json'), $markerJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

$launcherSource = Join-Path $projectRoot 'launcher\Launcher.cs'
$updaterSource = Join-Path $projectRoot 'launcher\LvlUpdater.cs'
if (-not (Test-Path -LiteralPath $updaterSource -PathType Leaf)) {
  throw 'Public launcher dependency launcher/LvlUpdater.cs missing; complete launcher integration first.'
}
# Stamp the compiled Windows Properties version without changing the authored
# launcher source for every tagged release. The package.json version is the
# single source of truth for installer, manifest, and launcher binary.
$launcherCode = [IO.File]::ReadAllText($launcherSource)
$assemblyPattern = '(?m)(\[assembly: Assembly(?:File)?Version\(")\d+\.\d+\.\d+\.\d+("\)\])'
if ([regex]::Matches($launcherCode, $assemblyPattern).Count -ne 2) {
  throw 'Cannot stamp launcher: expected both AssemblyVersion attributes.'
}
$launcherStamped = Join-Path $buildRoot 'Launcher-stamped.cs'
$replacement = '${1}' + $package.version + '.0${2}'
[IO.File]::WriteAllText($launcherStamped,
  [regex]::Replace($launcherCode, $assemblyPattern, $replacement), [Text.UTF8Encoding]::new($false))
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'Windows Framework C# compiler is unavailable.' }
$launchExe = Join-Path $payloadRoot 'LVL.exe'
$cscArgs = @(
  '/nologo', '/utf8output', '/target:winexe', '/optimize+', '/platform:x64', '/warn:4',
  "/out:$launchExe", "/win32icon:$(Join-Path $payloadRoot 'assets\platform\favicon.ico')",
  '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
  '/reference:System.Web.Extensions.dll', $launcherStamped, $updaterSource
)
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "LVL launcher compilation failed ($LASTEXITCODE)." }

Write-Host 'Generating dependency, Node, FFmpeg and FFprobe license notices...'
& $node (Join-Path $PSScriptRoot 'notices.mjs') $payloadRoot
if ($LASTEXITCODE -ne 0) { throw 'Third-party license generation failed.' }
Write-Host 'Auditing payload and bundled binary executables...'
& $node (Join-Path $PSScriptRoot 'verify.mjs') $payloadRoot
if ($LASTEXITCODE -ne 0) { throw 'Installer payload validation failed.' }
Write-Host "Verified payload: $payloadRoot"
if ($StageOnly) { Write-Host 'StageOnly: no setup compiled.'; exit 0 }

$iscc = Find-InnoSetup $CompilerPath
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
# Remove only the four known full-setup artifacts from this generated output
# folder, so a failed build can never leave a stale installer or checksum.
# The installed launcher at build/installer/payload/LVL.exe is untouched.
foreach ($artifactName in @('LVL.exe', 'LVL.exe.sha256', 'LVL-Setup.exe', 'LVL-Setup.exe.sha256')) {
  $artifact = Assert-Under (Join-Path $distRoot $artifactName) $distRoot
  if (Test-Path -LiteralPath $artifact -PathType Leaf) { Remove-Item -LiteralPath $artifact -Force }
}
Write-Host "Compiling Windows setup with $iscc"
& $iscc "/DPayloadDir=$payloadRoot" "/DOutputDir=$distRoot" "/DAppVersion=$($package.version)" (Join-Path $PSScriptRoot 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed ($LASTEXITCODE)." }
$setupExe = Join-Path $distRoot 'LVL-Setup.exe'
if (-not (Test-Path -LiteralPath $setupExe -PathType Leaf)) { throw "Expected installer missing: $setupExe" }
$setupHash = (Get-FileHash -LiteralPath $setupExe -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $distRoot 'LVL-Setup.exe.sha256'),
  "$setupHash *LVL-Setup.exe`n", [Text.UTF8Encoding]::new($false))
Write-Host "Built LVL setup v$($package.version): $setupExe"
