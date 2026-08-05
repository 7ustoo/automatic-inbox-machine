; Inno Setup script for Automatic Inbox Machine
; Build with: iscc installer\aim.iss
; Output:     installer\dist\aim-setup-vX.Y.Z.exe
;
; Requires Inno Setup 6.x — https://jrsoftware.org/isinfo.php
;
; Two things must be staged by CI before this runs (see release.yml):
;   wrapper\dist\AIM.exe  — the application: native window, tray, supervisor
;   runtime\node.exe      — bundled Node, so a machine with no Node still works
;
; AIM.exe is the only user-facing entry point. It opens a native WebView2 window,
; not a browser, and supervises the Node processes as its own children so quitting
; the app takes them with it.

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
#if !FileExists(AddBackslash(SourcePath) + "..\wrapper\dist\AIM.exe")
  #error "wrapper\dist\AIM.exe not found. Build it first: cd wrapper && make build"
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
; Shortcuts point at AIM.exe. The AppUserModelID matches the one the process sets
; for itself, so Windows groups and pins the window as this app rather than as
; Microsoft Edge — which is what happens if a WebView2 window has no identity.
;
; There is no separate Stop entry any more: quitting is in the tray menu, where a
; running app's quit belongs.
Name: "{group}\{#MyAppName}"; Filename: "{app}\wrapper\dist\AIM.exe"; \
  WorkingDir: "{app}"; IconFilename: "{app}\installer\logo.ico"; \
  AppUserModelID: "{#MyAppUserModelID}"; Comment: "Open Automatic Inbox Machine"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\wrapper\dist\AIM.exe"; \
  WorkingDir: "{app}"; IconFilename: "{app}\installer\logo.ico"; \
  AppUserModelID: "{#MyAppUserModelID}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; \
  GroupDescription: "Additional tasks:"; Flags: unchecked
Name: "startuptasks"; Description: "Start automatically when I sign in (recommended for 24/7 watching)"; \
  GroupDescription: "Additional tasks:"

[Code]
// WebView2 detection. Microsoft documents these registry locations and this
// product GUID for per-machine and per-user runtime discovery. A non-empty
// version other than 0.0.0.0 means the shared runtime is available.
function WebView2VersionValid(Version: String): Boolean;
begin
  Result := (Version <> '') and (Version <> '0.0.0.0');
end;

function WebView2RuntimePresent(): Boolean;
var
  Version: String;
  ClientKey: String;
begin
  ClientKey := 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result :=
    (RegQueryStringValue(HKCU, ClientKey, 'pv', Version) and WebView2VersionValid(Version)) or
    (RegQueryStringValue(HKLM64, ClientKey, 'pv', Version) and WebView2VersionValid(Version)) or
    (RegQueryStringValue(HKLM32, ClientKey, 'pv', Version) and WebView2VersionValid(Version));
end;

function NeedsWebView2(): Boolean;
begin
  Result := (not WebView2RuntimePresent()) and
    FileExists(ExpandConstant('{app}\runtime\MicrosoftEdgeWebView2Setup.exe'));
end;

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
begin
  // /T takes the supervised node children and the window host with it. Without
  // this the upgrade silently fails to replace AIM.exe — Windows locks a running
  // executable — and the old binary keeps running until reboot, which makes every
  // "fixed in this release" look broken on upgraded machines.
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM AIM.exe /T /F',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { taskkill exits non-zero when nothing matched, which is the normal
    fresh-install case. Give the OS a beat to release the file locks. }
  Sleep(1200);
  Result := '';
end;

[Run]
; The native window needs Microsoft's Evergreen WebView2 Runtime. Windows 11 and
; most Windows 10 machines already have it; the registry check above means this
; only runs where it is genuinely missing. The bootstrapper's Authenticode
; signature is verified in release.yml before it is ever packaged.
Filename: "{app}\runtime\MicrosoftEdgeWebView2Setup.exe"; \
  Parameters: "/silent /install"; \
  WorkingDir: "{app}"; \
  StatusMsg: "Installing the Microsoft WebView2 Runtime…"; \
  Check: NeedsWebView2; \
  Flags: runhidden waituntilterminated

; Register the scheduled tasks so the agent survives a reboot.
Filename: "{app}\runtime\node.exe"; \
  Parameters: """{app}\scripts\scheduler-register.mjs"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Registering startup tasks…"; \
  Tasks: startuptasks; \
  Flags: runhidden waituntilterminated

; Launch. Fresh installs land on the setup wizard; upgrades open normally and the
; watcher picks up where it left off.
Filename: "{app}\wrapper\dist\AIM.exe"; \
  WorkingDir: "{app}"; \
  Description: "Start {#MyAppName}"; \
  Flags: postinstall nowait skipifsilent

[UninstallRun]
; Stop the app, then remove the scheduled tasks, before the files disappear.
Filename: "{sys}\taskkill.exe"; \
  Parameters: "/IM AIM.exe /T /F"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "StopApp"
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
