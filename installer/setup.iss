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

[UninstallDelete]
; Incremental releases may add files that were not in the first installer's
; uninstall log. These are managed source-only trees INSIDE {app}; public
; Library data and browser profile remain in %LOCALAPPDATA%\LVL elsewhere.
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\backend"
Type: filesandordirs; Name: "{app}\frontend"
Type: filesandordirs; Name: "{app}\learning"
Type: filesandordirs; Name: "{app}\shared"
Type: filesandordirs; Name: "{app}\ext-runner"
; Files arrive in the verified staging tree, then are moved to these live
; destinations; Inno's extraction log records their staging locations.
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\tests"
Type: filesandordirs; Name: "{app}\devtools"
Type: filesandordirs; Name: "{app}\docs"
Type: files; Name: "{app}\LVL.exe"
Type: files; Name: "{app}\installed-app.json"
Type: files; Name: "{app}\app.js"
Type: files; Name: "{app}\server.js"
Type: files; Name: "{app}\index.html"
Type: files; Name: "{app}\package.json"
Type: files; Name: "{app}\CHANGELOG.md"
Type: files; Name: "{app}\THIRD_PARTY_NOTICES.txt"
Type: filesandordirs; Name: "{app}\.lvl-patch-transaction"
Type: filesandordirs; Name: "{app}\.lvl-full-transaction"
Type: filesandordirs; Name: "{localappdata}\LVL\window-theme"

[Files]
; build.ps1 constructs this directory from scripts/release-inputs.mjs;
; never point this at the repository root or node_modules in the checkout.
; Inno's own extraction is the preparation phase. Only the verified staged
; tree is later swapped into the live target by the transaction helper.
Source: "{#PayloadDir}\*"; DestDir: "{code:FullStageDir}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Inno runs the signed installer payload's Node from its PRIVATE temporary
; directory so replacing the live/staged runtime cannot lock its executable.
Source: "{#PayloadDir}\runtime\node.exe"; Flags: dontcopy
; This exact reviewed helper is also contained by the generic staged payload;
; the temporary extraction must use those SAME bytes, never mutable SourcePath.
Source: "{#PayloadDir}\runtime\windows-install-transaction.mjs"; Flags: dontcopy

[Icons]
Name: "{group}\LVL"; Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; WorkingDir: "{app}"
Name: "{autodesktop}\LVL"; Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#LauncherName}"; Parameters: "--port 4273"; Description: "{cm:LaunchProgram,LVL}"; Flags: nowait postinstall skipifsilent unchecked

[Code]
const
  // Same AppId as [Setup]; a per-user install registers it under HKCU.
  InstalledKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D3C04C52-7A8E-4DC7-9B0A-1EAF4B4A8B8B}_is1';
  SilentUpdateArguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LVLRestart=1';

var
  InstallToken: string;
  TransactionStarted: Boolean;
  TransactionCommitted: Boolean;
  FreshInstall: Boolean;

function GetCurrentProcessId(): Integer;
  external 'GetCurrentProcessId@kernel32.dll stdcall';

function FullStageDir(Param: string): string;
begin
  Result := ExpandConstant('{app}\.lvl-full-transaction\pending');
end;

function Quoted(const Value: string): string;
begin
  Result := '"' + Value + '"';
end;

// The helper is extracted from this very setup and talks only to {app}.
// No live source or installed launcher is trusted for the transaction.
function RunInstallHelper(const Operation, More: string): Boolean;
var
  NodePath, ScriptPath, Args: string;
  ExitCode: Integer;
begin
  Result := False;
  NodePath := ExpandConstant('{tmp}\node.exe');
  ScriptPath := ExpandConstant('{tmp}\windows-install-transaction.mjs');
  Args := Quoted(ScriptPath) + ' ' + Operation
    + ' --app-root ' + Quoted(ExpandConstant('{app}')) + More;
  if Exec(NodePath, Args, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := ExitCode = 0;
end;

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
  // Even an Exec failure must terminate this original setup. Otherwise the
  // ordinary wizard appears while an installed app is being replaced.
  if not Exec(ExpandConstant('{srcexe}'), SilentUpdateArguments, '', SW_HIDE, ewNoWait, ResultCode) then
    Log('Could not start the required silent LVL upgrade child.');
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
  LauncherPath, RunnerPath, ScriptPath, ScriptText, Arguments: string;
  ExitCode: Integer;
begin
  Result := True;
  LauncherPath := ExpandConstant('{app}\LVL.exe');
  RunnerPath := ExpandConstant('{app}\ext-runner\');
  if not FileExists(LauncherPath) then
    exit;
  ScriptPath := ExpandConstant('{tmp}\lvl-public-stop-for-update.ps1');
  // Quit this LVL, then wait for the Comics runner (Java), which ends when LVL
  // closes its input; one still running after 10 s is stopped, so its files can
  // be replaced or removed.
  ScriptText :=
    '$ErrorActionPreference = ''Stop''' + #13#10 +
    '$target = [IO.Path]::GetFullPath(''' + PsSingleQuote(LauncherPath) + ''')' + #13#10 +
    '$running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {' + #13#10 +
    '  $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target, [StringComparison]::OrdinalIgnoreCase)' + #13#10 +
    '})' + #13#10 +
    'if ($running.Count -gt 0) {' + #13#10 +
    '  & $target --quit --port 4273' + #13#10 +
    '  $ids = @($running | ForEach-Object { [int]$_.ProcessId })' + #13#10 +
    '  $deadline = [DateTime]::UtcNow.AddSeconds(20)' + #13#10 +
    '  do {' + #13#10 +
    '    Start-Sleep -Milliseconds 100' + #13#10 +
    '    $alive = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)' + #13#10 +
    '  } while ($alive.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)' + #13#10 +
    '  if ($alive.Count -gt 0) { exit 23 }' + #13#10 +
    '}' + #13#10 +
    '$runnerDir = [IO.Path]::GetFullPath(''' + PsSingleQuote(RunnerPath) + ''')' + #13#10 +
    '$deadline = [DateTime]::UtcNow.AddSeconds(10)' + #13#10 +
    'do {' + #13#10 +
    '  $runner = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {' + #13#10 +
    '    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($runnerDir, [StringComparison]::OrdinalIgnoreCase)' + #13#10 +
    '  })' + #13#10 +
    '  if ($runner.Count -gt 0) { Start-Sleep -Milliseconds 250 }' + #13#10 +
    '} while ($runner.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)' + #13#10 +
    'if ($runner.Count -gt 0) {' + #13#10 +
    '  $runner | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }' + #13#10 +
    '  Start-Sleep -Milliseconds 500' + #13#10 +
    '}' + #13#10 +
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
var
  TokenFile, Handoff, Command: string;
  TokenBytes: AnsiString;
begin
  Result := '';
  TransactionCommitted := False;
  TransactionStarted := False;
  FreshInstall := not FileExists(ExpandConstant('{app}\installed-app.json'));
  TokenFile := ExpandConstant('{tmp}\lvl-install-token-' + IntToStr(GetCurrentProcessId()) + '.txt');
  if FileExists(TokenFile) then
    DeleteFile(TokenFile);
  try
    ExtractTemporaryFile('node.exe');
    ExtractTemporaryFile('windows-install-transaction.mjs');
  except
    Result := 'The installation helper could not be extracted. The existing LVL installation was preserved.';
    exit;
  end;
  Handoff := ExpandConstant('{param:LVLInstallToken|}');
  Command := ' --owner-pid ' + IntToStr(GetCurrentProcessId())
    + ' --token-output ' + Quoted(TokenFile);
  if Handoff <> '' then
    Command := Command + ' --token ' + Quoted(Handoff);
  if not RunInstallHelper('reserve', Command) then
  begin
    Result := 'Another LVL installation owns this target, or installation recovery is required.';
    exit;
  end;
  if not LoadStringFromFile(TokenFile, TokenBytes) then
  begin
    Result := 'Could not preserve the LVL installation ownership token.';
    exit;
  end;
  InstallToken := string(TokenBytes);
  InstallToken := Trim(InstallToken);
  DeleteFile(TokenFile);
  TransactionStarted := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Parameters: string;
  ExitCode: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;
  Parameters := ' --version ' + Quoted('{#AppVersion}') + ' --token ' + Quoted(InstallToken);
  if not RunInstallHelper('prepare-full', Parameters) then
    RaiseException('LVL staging verification failed. The previous installation is unchanged.');
  if not StopPublicLauncher() then
    RaiseException('LVL is still running. Quit it and retry setup.');
  if not RunInstallHelper('commit-full', Parameters) then
    RaiseException('LVL could not complete the verified replacement. The previous app was restored where possible.');
  TransactionCommitted := True;
  if FreshInstall then
  begin
    if not RunInstallHelper('ack-fresh', Parameters) then
      RaiseException('LVL first-install completion could not be acknowledged.');
    exit;
  end;
  if RestartAfterAutomaticUpgrade() then
  begin
    if not Exec(ExpandConstant('{app}\LVL.exe'), '--background --port 4273',
      ExpandConstant('{app}'), SW_HIDE, ewNoWait, ExitCode) then
    begin
      RunInstallHelper('rollback-full', '');
      TransactionCommitted := False;
      RaiseException('The upgraded LVL launcher could not start. The prior app was restored.');
    end;
  end;
end;

procedure DeinitializeSetup();
begin
  // Failed extraction, staging, or cancelled wizard: release this attempt's
  // lease without deleting an older/newer controller's transaction.
  if TransactionStarted and not TransactionCommitted then
    RunInstallHelper('cancel-full', ' --token ' + Quoted(InstallToken));
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopPublicLauncher();
  if not Result then
    MsgBox('Quit this installed LVL copy before uninstalling.', mbError, MB_OK);
end;
