; Inno Setup script for Automatic Inbox Machine
; Build with: iscc installer\aim.iss
; Output:     installer\dist\aim-setup-vX.Y.Z.exe
;
; Requires Inno Setup 6.x — https://jrsoftware.org/isinfo.php
;
; Unlike AMM there is no Go wrapper to build first. The user-facing launcher is
; installer\aim-launch.vbs, which starts scripts\app.mjs with no console window.
; That costs a tray icon and saves every user a Go toolchain.
;
; The bundled Node runtime under runtime\node.exe is staged by CI before this
; runs (see .github/workflows/release.yml). Without it a fresh machine with no
; system Node installs successfully and then cannot start anything.

#define MyAppName "Automatic Inbox Machine"
#define MyAppShort "aim"
; Normally injected by CI via `iscc /DMyAppVersion=X.Y.Z` so the installer
; filename tracks package.json. The literal is only a fallback for a dev box.
#ifndef MyAppVersion
  #define MyAppVersion "1.2.0"
#endif
#define MyAppPublisher "Justin Williams"
#define MyAppURL "https://github.com/7ustoo/automatic-inbox-machine"
#define MyAppUserModelID "AutomaticInboxMachine.Desktop"

; Catch the most common build mistake at preprocess time rather than at the
; user's install time.
#if !FileExists(AddBackslash(SourcePath) + "logo.ico")
  #error "installer\logo.ico not found. Generate it first: node scripts/build/make-icon.mjs"
#endif
#if !FileExists(AddBackslash(SourcePath) + "..\node_modules\imapflow\package.json")
  #error "node_modules is missing or incomplete. Run `npm ci` before packaging."
#endif

[Setup]
AppId={{7A31C4E2-1B6D-4C8F-9E22-A1M1NB0XM4CH}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\automatic-inbox-machine
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
OutputDir=dist
OutputBaseFilename=aim-setup-v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
; No admin prompt: everything lives under the user's LocalAppData and the
; scheduled tasks are registered with /rl limited.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=logo.ico
UninstallDisplayIcon={app}\installer\logo.ico
UninstallFilesDir={app}

; Version resource on the setup .exe itself. Without these, Explorer's Details
; tab shows a blank "File version", which reads as a half-finished or repackaged
; binary — exactly the wrong signal on an unsigned download that already has to
; get past SmartScreen. VersionInfoVersion needs a plain numeric quad, so the
; version is passed through as-is from package.json.
VersionInfoVersion={#MyAppVersion}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Setup
VersionInfoCopyright=Copyright (C) 2026 {#MyAppPublisher}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Ship the whole repo under {app}. Source is one level up since the .iss lives
; in installer\.
;
; node_modules IS included: every runtime dependency is pure JS, so CI's
; `npm ci` output ships inside the installer and the user never runs npm. That
; removes a multi-minute silent step at install time that looks like a hang.
;
; \config.json, data\*, and .env MUST stay excluded. `npm test` in CI creates
; config.json and data\*.jsonl in the checkout as a side effect; without these
; exclusions they ride into the payload and — with ignoreversion — overwrite the
; user's real settings and ledger on every upgrade. AMM shipped that bug once
; (its v7.1) and it silently reset people's configs. The leading backslash pins
; the pattern to the payload root so a dependency's own config.json still ships.
Source: "..\*"; DestDir: "{app}"; \
  Excludes: "\config.json,\.env,\.env.local,data\*,logs\*,installer\dist\*,.git\*,.github\*,.claude\*,*.log,*.zip,*.tmp,node_modules\.cache\*,*-token.json"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Everything points at the VBS shim, never node.exe — see aim-launch.vbs for why.
Name: "{group}\{#MyAppName}"; Filename: "{app}\installer\aim-launch.vbs"; \
  WorkingDir: "{app}"; IconFilename: "{app}\installer\logo.ico"; \
  AppUserModelID: "{#MyAppUserModelID}"; Comment: "Open the inbox agent dashboard"
Name: "{group}\Stop {#MyAppName}"; Filename: "{app}\installer\aim-stop.vbs"; \
  WorkingDir: "{app}"; IconFilename: "{app}\installer\logo.ico"; \
  Comment: "Stop watching mail"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\installer\aim-launch.vbs"; \
  WorkingDir: "{app}"; IconFilename: "{app}\installer\logo.ico"; \
  AppUserModelID: "{#MyAppUserModelID}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; \
  GroupDescription: "Additional tasks:"; Flags: unchecked
Name: "startuptasks"; Description: "Start automatically when I sign in (recommended for 24/7 watching)"; \
  GroupDescription: "Additional tasks:"

[Code]
// An install counts as configured when config.json survived a previous setup.
// Gates the finish-page checkbox wording: a fresh install lands on the setup
// panel, an upgrade should just start watching again.
function IsConfigured(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\config.json'));
end;

// Windows locks files that a running process has open, so an upgrade over a live
// install can silently fail to replace scripts. Stop the agent first. AMM hit
// exactly this: the tray kept running the OLD binary until reboot, which made
// every "fixed in this release" look broken on upgraded machines.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  StopScript: String;
begin
  StopScript := ExpandConstant('{app}\scripts\app.mjs');
  if FileExists(StopScript) and FileExists(ExpandConstant('{app}\runtime\node.exe')) then
  begin
    Exec(ExpandConstant('{app}\runtime\node.exe'), '"' + StopScript + '" --stop',
         ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1200);
  end;

  // Belt and braces: anything still holding our files goes now. taskkill exits
  // non-zero when nothing matched, which is the normal fresh-install case.
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM node.exe /FI "WINDOWTITLE eq automatic-inbox-machine*" /F',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(400);
  Result := '';
end;

[Run]
; Register the scheduled tasks so the agent survives a reboot. Runs hidden and
; is skipped entirely if the user unticked the task.
Filename: "{app}\runtime\node.exe"; \
  Parameters: """{app}\scripts\scheduler-register.mjs"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Registering startup tasks…"; \
  Tasks: startuptasks; \
  Flags: runhidden waituntilterminated

; Launch. On a fresh install the dashboard opens on its setup panel; on an
; upgrade it opens normally and the watcher picks up where it left off.
; skipifsilent keeps unattended installs from popping a browser window.
Filename: "{app}\installer\aim-launch.vbs"; \
  WorkingDir: "{app}"; \
  Description: "Start {#MyAppName} and open the dashboard"; \
  Flags: postinstall nowait skipifsilent shellexec

[UninstallRun]
; Stop the agent and remove the scheduled tasks before the files disappear.
; Uses the bundled runtime — a machine that never had system Node still needs
; this to work, and [UninstallDelete] has not run yet at this point.
Filename: "{app}\runtime\node.exe"; \
  Parameters: """{app}\scripts\app.mjs"" --stop"; \
  WorkingDir: "{app}"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "StopAgent"
Filename: "{app}\runtime\node.exe"; \
  Parameters: """{app}\scripts\uninstall.mjs"" --yes"; \
  WorkingDir: "{app}"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "RemoveTasks"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}"
