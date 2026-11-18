#ifndef PayloadDir
  #error PayloadDir must be supplied by installer/build.ps1.
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by installer/build.ps1.
#endif
#ifndef AppVersion
  #error AppVersion must be supplied by installer/build.ps1.
#endif
#ifndef UninstallObserverSha256
  #error UninstallObserverSha256 must be the reviewed packaged LVL.exe hash supplied by installer/build.ps1.
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
; Older observer copies have distinct immutable digest directories across
; upgrades. Remove them only AFTER InitializeUninstall checked all processes.
Type: filesandordirs; Name: "{app}\.lvl-uninstall-observers"
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
; The very same reviewed C# launcher is embedded for pre-extraction process
; identity. Its temporary copy is only a bounded read-only process probe;
; Inno still stages/promotes the normal packaged LVL.exe through its journal.
Source: "{#PayloadDir}\LVL.exe"; Flags: dontcopy
; Uninstall cannot ExtractTemporaryFile from a prior setup's dontcopy resource.
; Preserve a version-addressed copy of the CURRENT packaged native observer
; alongside the app. The signed uninstaller contains its expected SHA-256,
; supplied at compile time from the same payload/LVL.exe. Never execute the
; installed launcher as an --await-stopped provider: older versions lack it.
; Distinct digest directories preserve an older uninstaller if an upgrade fails.
Source: "{#PayloadDir}\LVL.exe"; DestDir: "{app}\.lvl-uninstall-observers\{#UninstallObserverSha256}"; DestName: "LVL.exe"; Flags: ignoreversion

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
  BootstrapProofHash: string;
  SetupFailureStage: string;
  LastFailedHelperExit: Integer;

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

// A public attempt ID is only a correlation key. Never interpret it as a
// lease credential or allow it to supply a directory or executable path.
function ValidPublicAttempt(const Value: string): Boolean;
var
  J: Integer;
  C: Char;
begin
  Result := Length(Value) = 32;
  if not Result then exit;
  for J := 1 to Length(Value) do
  begin
    C := Value[J];
    if not (((C >= '0') and (C <= '9')) or
      ((C >= 'a') and (C <= 'f'))) then
    begin
      Result := False;
      exit;
    end;
  end;
end;

// Write only failures, never a supposed "installed" success marker.
// The verified package/physical-root/journal contract is independent.
// An interrupted installer may still leave no receipt; /LOG remains useful.
procedure RecordSetupFailure();
var
  Attempt, Folder, Target, Stage, Contents: string;
begin
  Attempt := ExpandConstant('{param:LVLAttemptId|}');
  if not ValidPublicAttempt(Attempt) then exit;
  if TransactionCommitted and (SetupFailureStage = '') then exit;
  Stage := SetupFailureStage;
  if Stage = '' then Stage := 'setup-incomplete';
  Folder := ExpandConstant('{localappdata}\LVL\data\installer-outcomes');
  Target := Folder + '\' + Attempt + '.status';
  Contents := 'lvl-setup-failure-v1' + #10 + Attempt + #10
    + '{#AppVersion}' + #10 + Stage + #10
    + IntToStr(LastFailedHelperExit) + #10;
  try
    if ForceDirectories(Folder) then
      if not SaveStringToFile(Target, Contents, False) then
        Log('LVL Setup failure receipt could not be written.');
  except
    Log('LVL Setup failure receipt could not be persisted.');
  end;
end;

// The helper is extracted from this very setup and talks only to {app}.
// No live source or installed launcher is trusted for the transaction.
function RunInstallHelper(const Operation, More: string): Boolean;
var
  NodePath, ScriptPath, Args: string;
  ExitCode: Integer;
begin
  Result := False;
  // All Inno helper actions use the same embedded, extracted launcher whose
  // SHA-256 is obtained directly from Inno's trusted installer payload.
  // The detached helper independently checks this file before every OS query.
  if Length(BootstrapProofHash) <> 64 then
    exit;
  NodePath := ExpandConstant('{tmp}\node.exe');
  ScriptPath := ExpandConstant('{tmp}\windows-install-transaction.mjs');
  Args := Quoted(ScriptPath) + ' ' + Operation
    + ' --app-root ' + Quoted(ExpandConstant('{app}'))
    + ' --bootstrap-native ' + Quoted(ExpandConstant('{tmp}\LVL.exe'))
    + ' --bootstrap-sha256 ' + Quoted(BootstrapProofHash) + More;
  ExitCode := -1;
  if Exec(NodePath, Args, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := ExitCode = 0;
  if not Result then
  begin
    LastFailedHelperExit := ExitCode;
    Log('LVL setup helper ' + Operation + ' failed with exit code '
      + IntToStr(ExitCode));
  end;
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

// Request the OLD installed binary's quit BEFORE creating a 'preparing'
// journal. Older shipped binaries do not know the newer preparing/--quit
// exception and may otherwise start their own crash recovery while quitting.
// The preflight native observer waits for this spawned --quit child to exit
// before the new journal can be written. Never force-stop by name.
function RequestPublicLauncherQuit(): Boolean;
var
  LauncherPath, RootPath: string;
  ExitCode: Integer;
begin
  Result := True;
  LauncherPath := ExpandConstant('{app}\LVL.exe');
  if not FileExists(LauncherPath) then
    exit;
  RootPath := ExpandConstant('{app}');
  // Old --quit is advisory; verified quiet ownership is mandatory below.
  Result := Exec(LauncherPath, '--quit --port 4273', RootPath,
    SW_HIDE, ewNoWait, ExitCode);
end;

// The uninstaller cannot retrieve installer-only temporary resources. It
// copies its versioned packaged observer into this uninstall's private {tmp},
// checks a digest BAKED INTO this uninstaller at compilation, then executes
// the existing C# no-UI Win32 owner/birth/image observer. A digest read solely
// from the installed filesystem could be forged by that same filesystem.
function RunVerifiedUninstallObserver(const RootPath: string): Boolean;
var
  BundledImage, PrivateImage, Arguments, PinnedDigest: string;
  ExitCode: Integer;
begin
  Result := False;
  PinnedDigest := '{#UninstallObserverSha256}';
  if Length(PinnedDigest) <> 64 then
    exit;
  BundledImage := ExpandConstant('{app}\.lvl-uninstall-observers\{#UninstallObserverSha256}\LVL.exe');
  PrivateImage := ExpandConstant('{tmp}\LVL.exe');
  if not FileExists(BundledImage) or FileExists(PrivateImage) then
    exit;
  try
    try
      // Both checks are needed: the installed copy can change between checks
      // and the private copy is the only executable this uninstaller launches.
      if Lowercase(GetSHA256OfFile(BundledImage)) <> PinnedDigest then
        exit;
      if not FileCopy(BundledImage, PrivateImage, True) then
        exit;
      if Lowercase(GetSHA256OfFile(PrivateImage)) <> PinnedDigest then
        exit;
      Arguments := '--await-stopped --app-root ' + Quoted(RootPath)
        + ' --bootstrap-image ' + Quoted(PrivateImage)
        + ' --bootstrap-sha256 ' + Quoted(PinnedDigest);
      if Exec(PrivateImage, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
        Result := ExitCode = 0;
    except
      Result := False;
    end;
  finally
    if FileExists(PrivateImage) then
      DeleteFile(PrivateImage);
  end;
end;

// No new quit process is started after the new prepared journal exists.
// Both upgrade and uninstall require an exact installed-root observer.
function StopPublicLauncher(): Boolean;
var
  RootPath: string;
begin
  RootPath := ExpandConstant('{app}');
  if TransactionStarted then
  begin
    // Installation's native observer is already pinned to the temporary
    // current setup and to its exact lease/prepare journal.
    Result := RunInstallHelper('await-stop', ' --token ' + Quoted(InstallToken));
  end
  else
    // Even if the legacy installed launcher file was removed, ext-runner
    // processes still need native root ownership checks before uninstall.
    Result := RunVerifiedUninstallObserver(RootPath);
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  TokenFile, Handoff, Command: string;
  TokenBytes: AnsiString;
begin
  Result := '';
  TransactionCommitted := False;
  TransactionStarted := False;
  BootstrapProofHash := '';
  SetupFailureStage := 'extract-private-helper';
  LastFailedHelperExit := -1;
  FreshInstall := not FileExists(ExpandConstant('{app}\installed-app.json'));
  TokenFile := ExpandConstant('{tmp}\lvl-install-token-' + IntToStr(GetCurrentProcessId()) + '.txt');
  if FileExists(TokenFile) then
    DeleteFile(TokenFile);
  try
    ExtractTemporaryFile('node.exe');
    ExtractTemporaryFile('windows-install-transaction.mjs');
    ExtractTemporaryFile('LVL.exe');
    BootstrapProofHash := Lowercase(GetSHA256OfFile(ExpandConstant('{tmp}\LVL.exe')));
    if Length(BootstrapProofHash) <> 64 then
      RaiseException('Installer-embedded process proof hash is unavailable');
  except
    RecordSetupFailure();
    Result := 'The verified installation helper could not be extracted. The existing LVL installation was preserved.';
    exit;
  end;
  Handoff := ExpandConstant('{param:LVLInstallToken|}');
  Command := ' --owner-pid ' + IntToStr(GetCurrentProcessId())
    + ' --owner-image ' + Quoted(ExpandConstant('{srcexe}'))
    + ' --token-output ' + Quoted(TokenFile);
  if Handoff <> '' then
    Command := Command + ' --token ' + Quoted(Handoff);
  SetupFailureStage := 'reserve-install-lease';
  if not RunInstallHelper('reserve', Command) then
  begin
    RecordSetupFailure();
    Result := 'Another LVL installation owns this target, or installation recovery is required.';
    exit;
  end;
  SetupFailureStage := 'read-install-token';
  if not LoadStringFromFile(TokenFile, TokenBytes) then
  begin
    RecordSetupFailure();
    Result := 'Could not preserve the LVL installation ownership token.';
    exit;
  end;
  InstallToken := string(TokenBytes);
  InstallToken := Trim(InstallToken);
  DeleteFile(TokenFile);
  TransactionStarted := True;
  SetupFailureStage := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Parameters: string;
  ExitCode: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;
  Parameters := ' --version ' + Quoted('{#AppVersion}') + ' --token ' + Quoted(InstallToken);
  SetupFailureStage := 'request-legacy-quit';
  if not RequestPublicLauncherQuit() then
    RaiseException('LVL could not request the installed launcher to quit.');
  // This check is intentionally BEFORE prepare-full. Its owned staging lease
  // and absent journal prevent an old launcher from racing recovery setup.
  SetupFailureStage := 'preflight-native-stop';
  if not RunInstallHelper('preflight-stop', ' --token ' + Quoted(InstallToken)) then
    RaiseException('The existing LVL launcher did not stop before preparing the upgrade.');
  SetupFailureStage := 'verify-payload-stage';
  if not RunInstallHelper('prepare-full', Parameters) then
    RaiseException('LVL staging verification failed. The previous installation is unchanged.');
  SetupFailureStage := 'await-legacy-stop';
  if not StopPublicLauncher() then
    RaiseException('LVL is still running. Quit it and retry setup.');
  SetupFailureStage := 'commit-or-recovery';
  if not RunInstallHelper('commit-full', Parameters) then
    RaiseException('LVL could not complete the verified replacement. The previous app was restored where possible.');
  TransactionCommitted := True;
  SetupFailureStage := '';
  if FreshInstall then
  begin
    SetupFailureStage := 'acknowledge-fresh';
    if not RunInstallHelper('ack-fresh', Parameters) then
      RaiseException('LVL first-install completion could not be acknowledged.');
    SetupFailureStage := '';
    exit;
  end;
  if RestartAfterAutomaticUpgrade() then
  begin
    SetupFailureStage := 'restart-new-launcher';
    if not Exec(ExpandConstant('{app}\LVL.exe'), '--background --port 4273',
      ExpandConstant('{app}'), SW_HIDE, ewNoWait, ExitCode) then
    begin
      RunInstallHelper('rollback-full', '');
      TransactionCommitted := False;
      RaiseException('The upgraded LVL launcher could not start. The prior app was restored.');
    end;
    SetupFailureStage := '';
  end;
end;

procedure DeinitializeSetup();
begin
  // Failed extraction, staging, or cancelled wizard: release this attempt's
  // lease without deleting an older/newer controller's transaction.
  // Preserve the original stage/exit before cancellation can fail, too.
  RecordSetupFailure();
  if TransactionStarted and not TransactionCommitted then
    if not RunInstallHelper('cancel-full', ' --token ' + Quoted(InstallToken)) then
      Log('LVL setup cancellation could not confirm complete recovery.');
end;

function InitializeUninstall(): Boolean;
begin
  Result := RequestPublicLauncherQuit() and StopPublicLauncher();
  if not Result then
    MsgBox('LVL could not verify that the launcher and extension runner have stopped. Quit LVL, or repair this installation with its trusted setup, before uninstalling.', mbError, MB_OK);
end;
