#ifndef PayloadDir
  #error PayloadDir must be supplied by installer/build.ps1.
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by installer/build.ps1.
#endif
#ifndef AppVersion
  #error AppVersion must be supplied by installer/build.ps1.
#endif

#define AppName "LVL"
#define LauncherName "LVL.exe"

[Setup]
; First public release identity. Do not reuse the private alpha-v0.2 AppId.
AppId={{D3C04C52-7A8E-4DC7-9B0A-1EAF4B4A8B8B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=LVL
DefaultDirName={localappdata}\Programs\LVL
DefaultGroupName=LVL
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
; The downloadable installer is LVL-Setup.exe; the installed app is {app}\LVL.exe.
OutputBaseFilename=LVL-Setup
SetupIconFile={#PayloadDir}\assets\platform\favicon.ico
UninstallDisplayIcon={app}\{#LauncherName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UsePreviousAppDir=yes
UsePreviousGroup=no
DisableDirPage=no
; User data and browser profiles live outside the installation and survive uninstall.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Future installs remove obsolete development-only folders from THIS public
; app directory, regardless of what an older public package installed.
Type: filesandordirs; Name: "{app}\tests"
Type: filesandordirs; Name: "{app}\devtools"
Type: filesandordirs; Name: "{app}\docs"

[UninstallDelete]
; Incremental releases may add files that were not in the first installer's
; uninstall log. These are managed source-only trees INSIDE {app}; public
; Library data and browser profile remain in %LOCALAPPDATA%\LVL elsewhere.
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\backend"
Type: filesandordirs; Name: "{app}\frontend"
Type: filesandordirs; Name: "{app}\learning"
Type: filesandordirs; Name: "{app}\shared"
Type: filesandordirs; Name: "{app}\.lvl-patch-transaction"

[Files]
; build.ps1 constructs this directory from scripts/release-inputs.mjs;
; never point this at the repository root or node_modules in the checkout.
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\LVL"; Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; WorkingDir: "{app}"
Name: "{autodesktop}\LVL"; Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; Description: "{cm:LaunchProgram,LVL}"; Flags: nowait postinstall skipifsilent unchecked
; Only an updater-invoked silent in-place setup passes /LVLRestart=1.
; Start the replacement public launcher AFTER files are installed and the
; previous public launcher has exited; never open another/private instance.
Filename: "{app}\{#LauncherName}"; Parameters: "--background --port 4273"; Flags: nowait runhidden; Check: RestartAfterAutomaticUpgrade

[Code]
function RestartAfterAutomaticUpgrade(): Boolean;
begin
  Result := ExpandConstant('{param:LVLRestart|0}') = '1';
end;

// On an in-place PUBLIC update, only stop this install's exact executable.
// Never contact the private v0.2 launcher, installation or user profile.
function PsSingleQuote(const Value: string): string;
begin
  Result := Value;
  StringChangeEx(Result, '''', '''''', True);
end;

function StopPublicLauncher(): Boolean;
var
  LauncherPath, ScriptPath, ScriptText, Arguments: string;
  ExitCode: Integer;
begin
  Result := True;
  LauncherPath := ExpandConstant('{app}\LVL.exe');
  if not FileExists(LauncherPath) then
    exit;
  ScriptPath := ExpandConstant('{tmp}\lvl-public-stop-for-update.ps1');
  ScriptText :=
    '$ErrorActionPreference = ''Stop''' + #13#10 +
    '$target = [IO.Path]::GetFullPath(''' + PsSingleQuote(LauncherPath) + ''')' + #13#10 +
    '$running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {' + #13#10 +
    '  $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target, [StringComparison]::OrdinalIgnoreCase)' + #13#10 +
    '})' + #13#10 +
    'if ($running.Count -eq 0) { exit 0 }' + #13#10 +
    '& $target --quit --port 4273' + #13#10 +
    '$ids = @($running | ForEach-Object { [int]$_.ProcessId })' + #13#10 +
    '$deadline = [DateTime]::UtcNow.AddSeconds(20)' + #13#10 +
    'do {' + #13#10 +
    '  Start-Sleep -Milliseconds 100' + #13#10 +
    '  $alive = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)' + #13#10 +
    '} while ($alive.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)' + #13#10 +
    'if ($alive.Count -gt 0) { exit 23 }' + #13#10 +
    'exit 0' + #13#10;
  if not SaveStringToFile(ScriptPath, ScriptText, False) then
  begin
    Result := False;
    exit;
  end;
  Arguments := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath + '"';
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
  DeleteFile(ScriptPath);
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
begin
  if StopPublicLauncher() then
    Result := ''
  else
    Result := 'This LVL installation is still running. Quit it and try Setup again.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopPublicLauncher();
  if not Result then
    MsgBox('Quit this installed LVL copy before uninstalling.', mbError, MB_OK);
end;
