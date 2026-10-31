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
; LVL's installation identity. Every release keeps this exact AppId.
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
; The folder is chosen on the first install only; updates reuse it silently.
DisableDirPage=auto
; User data and browser profiles live outside the installation and survive uninstall.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Replace the app folders completely, so files dropped from LVL never stay
; behind after an update. User data and the browser profile live in
; %LOCALAPPDATA%\LVL, never here. Earlier development folders go too.
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\backend"
Type: filesandordirs; Name: "{app}\frontend"
Type: filesandordirs; Name: "{app}\learning"
Type: filesandordirs; Name: "{app}\shared"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\.lvl-patch-transaction"
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
Type: filesandordirs; Name: "{localappdata}\LVL\window-theme"

[Files]
; build.ps1 constructs this directory from scripts/release-inputs.mjs;
; never point this at the repository root or node_modules in the checkout.
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\LVL"; Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; WorkingDir: "{app}"
Name: "{autodesktop}\LVL"; Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; Description: "{cm:LaunchProgram,LVL}"; Flags: nowait postinstall skipifsilent unchecked
; Every update setup runs silently and passes /LVLRestart=1 (see [Code]).
; Start the replacement launcher AFTER files are installed and the previous
; launcher has exited; never open another instance.
Filename: "{app}\{#LauncherName}"; Parameters: "--background --port 4273"; Flags: nowait runhidden; Check: RestartAfterAutomaticUpgrade

[Code]
const
  // Same AppId as [Setup]; a per-user install registers it under HKCU.
  InstalledKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D3C04C52-7A8E-4DC7-9B0A-1EAF4B4A8B8B}_is1';
  SilentUpdateArguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LVLRestart=1';

// Updating an installed LVL never shows the wizard, whoever started this
// setup (the updater, an older updater that passes no options, or the user):
// start this same setup again silently, in the same folder with LVL restarted
// afterwards, and close this copy. A first install keeps the normal wizard.
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if WizardSilent() or not RegKeyExists(HKCU, InstalledKey) then
    exit;
  if Exec(ExpandConstant('{srcexe}'), SilentUpdateArguments, '', SW_SHOWNORMAL, ewNoWait, ResultCode) then
    Result := False;
end;

function RestartAfterAutomaticUpgrade(): Boolean;
begin
  Result := ExpandConstant('{param:LVLRestart|0}') = '1';
end;

// On an in-place update, only stop this install's exact executable.
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
