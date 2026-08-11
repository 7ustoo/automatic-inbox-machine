# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.2] — 2026-08-11

### Added

- Bring-your-own-AI setup for Claude, OpenAI, and Google Gemini, with direct
  provider key-page links and secure local key storage.
- Provider selection and one-click enablement in first-run setup and Settings.

### Changed

- AI now verifies every category eligible for auto-archive in addition to
  ambiguous, interview, RTR, and rate-confirmation messages.
- OpenAI setup clearly distinguishes API usage from ChatGPT and Codex plans.

## [1.5.1] — 2026-08-06

### Fixed

- Google authorization now waits up to 30 minutes and returns users to the app
  with clearer success and retry guidance.
- Update checks and one-click installer downloads now use the public
  `automatic-inbox-machine-releases` repository, so customers do not need access
  to the private source repository.

## [1.5.0] — 2026-08-06

Google sign-in and one-click self-update, both built on AMM's proven logic.

### Added

- **Sign in with Google.** The OAuth client resolves like AMM's: `.env` →
  `scripts/google-oauth-client.json` (CI injects it into release builds from repo
  secrets) → a local AMM install's client, borrowed automatically. On a machine
  with AMM, the Gmail option lights up with zero Google Cloud work. Whatever wins
  is exported into `process.env` so the log scrubber covers it from first read.
- Setup wizard defaults Gmail addresses to **Sign in with Google — recommended**;
  the app-password path is labelled with its real requirement (2-Step
  Verification) and the provider note explains the "not available for your
  account" dead end. After sign-in the wizard polls until Google redirects back,
  then advances itself.
- **One-click self-update**, ported from AMM's `self-update.mjs`: download the
  release installer → verify against `SHA256SUMS.txt` (a mismatch or an
  unverifiable download is discarded, never run) → config snapshot → detached
  cmd updater survives the app being killed → `/VERYSILENT /DIR=<install root>`
  → relaunch `AIM.exe --after-update`. Windows-only by design; elsewhere the UI
  links to the releases page.
- Update surfaces: the dashboard banner is now an **Install update** button, and
  the tray shows **Install update vX.Y.Z** when the watcher's six-hour check
  finds one.

### Fixed

- Defining the `--after-update` flag in the wrapper is load-bearing: Go's flag
  package exits on unknown flags, so the freshly installed binary would have died
  instantly at the end of every update.
- `/DIR` pins the upgrade to the current install root — AMM learned that without
  it, Inno can install a fresh copy next to the real one and relaunch that,
  which looks exactly like "the update wiped my settings".

### Notes

- Update checks need the GitHub releases API to be able to see the repo. While
  the repo is private, checks 404 gracefully and no prompt appears; they go live
  when the repo is public.

## [1.4.0] — 2026-08-05

**It is an actual application now.** Double-clicking it opens a native window with
its own title bar and taskbar identity — not a browser tab pointed at localhost.

The previous releases served the UI into the default browser and called that
pragmatic. It was not what was asked for, and "your app opens a web page" is a
reasonable thing to reject.

### Added

- **`wrapper/` — AIM.exe, a Go desktop wrapper.** Native WebView2 window, system
  tray, and supervision of the three Node processes as its own children, so
  quitting the app takes them with it instead of leaving orphaned `node.exe` in
  Task Manager.
- The window runs in an `AIM.exe --window-host` child process. WebView2 and the
  system tray each need to own a Win32 message loop pinned to the main OS thread
  and cannot both have it. It also means the taskbar groups the window under
  AIM.exe rather than msedge.exe, so pinning uses the app's own identity.
- Tray menu: Open, live status, Pause/Resume, Restart watcher, Open logs folder,
  Quit. The tray restarts the watcher on its own if it finds it dead.
- Embedded exe icon and version resource via `go-winres`, with the version synced
  from `package.json` by `scripts/build/sync-winres.mjs` so it cannot drift.
- Icon generator now also emits a PNG — `go-winres` decodes with Go's image
  package, which cannot read the uncompressed BMP-in-ICO form Windows accepts.
- macOS and Linux get a Chromium app-mode window (`--app=`, isolated profile),
  falling back to the default browser only when no Chromium-family browser exists.
- The installer provisions Microsoft's Evergreen WebView2 Runtime where it is
  missing, after verifying the bootstrapper's Authenticode signature.
- A local token file (`data/dashboard-token.txt`, 0600) lets the tray call the
  dashboard API. The browser CSRF token is per-process and cannot be shared with a
  sibling process; this proves local ownership instead.
- The dashboard publishes the port it actually bound to
  (`data/dashboard-port.txt`), so the wrapper cannot open a window against a port
  nothing is listening on.

### Changed

- **The interface is four tabs instead of eleven stacked panels**: Inbox,
  Activity, Settings, System. The selected tab survives a refresh.
- **Four stat tiles instead of eight.** Eight tiles of mostly zeros is a wall to
  scan past; the other counts moved into one subtitle line beneath.
- **One status pill instead of three.** Three competing pills meant reading all of
  them to answer the only question that matters — is it working right now. Detail
  moved to the pill's tooltip.
- Start Menu has one entry (the app) plus Uninstall. Stopping is in the tray menu,
  where a running app's quit belongs.
- Removed the VBScript launcher shims. AIM.exe is the entry point.

### Fixed

- A scrub test failed intermittently for a reason unrelated to itself.
  `node --test` runs files in **parallel**, in separate processes sharing one
  filesystem, and `setup.test.mjs` writes a real `.env` while it runs — so the
  other process could read credentials that existed for a few milliseconds.
  Neutralising the environment now calls `loadEnv()` first; deleting variables
  before the first load silently did nothing, because the next `scrub()` triggered
  a fresh read. Verified deterministic over repeated runs.
- The release workflow read the app version by running `AIM.exe --version`. A
  `-H windowsgui` binary has no stdout attached to a parent console, so that was
  unsound; it now reads the embedded version resource, which also proves the
  resource was embedded.

## [1.3.0] — 2026-08-05

Setup now happens entirely in the dashboard. Previously an installed copy told the
user to open a terminal and hand-edit a dotfile inside `%LOCALAPPDATA%` — which is
not setup, it is a dead end.

### Added

- **First-run setup wizard in the dashboard.** Three steps: connect an inbox, fill
  the reply profile, connect Telegram. It picks up wherever it left off on reload
  and disappears once complete.
- **Provider detection** (`mail-hosts.mjs`). Enter an email address and it fills in
  IMAP/SMTP host, port and TLS for Gmail, Outlook, Yahoo, AOL, iCloud, Fastmail,
  Zoho, GMX, Proton and Yandex, links straight to that provider's app-password
  page, and warns where one is mandatory. Custom domains get conventional
  hostnames, explicitly labelled a guess. No network lookups — a local-first mail
  agent should not phone a third party to find out where your mail lives.
- **`.env` writing from the dashboard** (`env-writer.mjs`), on an allowlist of keys
  with per-key validation. Values are never returned to the browser — the API
  exposes presence booleans only.
- **Actionable transport errors** (`friendly-errors.mjs`). "Command failed" now
  reads "the mail server rejected the password… you need an App Password, and
  2-Step Verification has to be on first," which is the real cause almost every
  time. `invalid_grant` names the Testing-mode 7-day token expiry specifically.
  Unrecognised errors pass through unchanged rather than getting a confident but
  wrong explanation.
- Add and remove inboxes from the account list. Removing one deletes its stored
  password; the submission ledger is kept.
- Inline fixes on the broken-account banner: **Authorize** for Gmail, **Update
  password** for IMAP.
- Date of birth and SSN last four are now entered in the UI. The SSN field only
  appears inside the consent notice, so the same interaction that enters it is the
  one that consents to it.
- 23 tests over provider detection, secret writing, and error translation.

### Fixed

- **The 15-second auto-refresh destroyed anything you were typing.** Every panel
  rebuilt from `innerHTML` on each poll, so an email address or a half-written
  reply vanished mid-entry. Panels holding focus or typed input are now left alone.
- **A phantom inbox appeared on every fresh install.** `initFromExample()` copied
  the template's placeholder account verbatim, so `you@gmail.com` showed up as a
  real configured, permanently-broken inbox. Fresh configs now start with no
  accounts, which is also what makes `needsSetup` mean what it says.
- **Clearing a secret did not clear it from the running process.** `reloadEnv()`
  only sets what the file contains and cannot know a key was deleted, so the
  dashboard kept reporting a cleared value as present.
- `emailDomainOf` returned nothing for `Name <a@b.com>` — the end-anchor did not
  allow the trailing `>` that mail headers always carry.
- Config errors are suppressed while setup is still running. Telling someone who
  just installed the app that it has no accounts configured, while showing them the
  form to configure it, is noise.

### Changed

- Newly written secrets become scrubbable immediately, rather than at next
  restart: `reloadEnv()` invalidates the log scrubber's cache through a callback
  (`env.mjs` cannot import `log.mjs` without a cycle).
- The terminal wizard (`npm run setup`) is now documented as a developer escape
  hatch. It still refuses to prompt for secrets.

## [1.2.1] — 2026-08-05

### Fixed

- The setup `.exe` had a blank **File version** in Explorer's Details tab — no
  `VersionInfo*` directives were set in the Inno Setup script. On an unsigned
  download that already has to get past SmartScreen, missing version metadata
  reads as a repackaged or half-finished binary. Now carries version, product
  name, company, description, and copyright.
- The release workflow's runtime-verification step inherited the exit code from
  `app.mjs --status`, which correctly returns 1 when nothing is running. GitHub's
  PowerShell wrapper appends `exit $LASTEXITCODE`, so the step failed immediately
  after logging success, and the v1.2.0 installer never published on the first
  attempt.

## [1.2.0] — 2026-08-05

Ships as a downloadable Windows application. Also fixes three bugs found while
building it, two of which were silently discarding data.

### Added

- **Windows installer.** Inno Setup script (`installer/aim.iss`) producing
  `aim-setup-vX.Y.Z.exe`, built and published by `.github/workflows/release.yml`
  on any `v*.*.*` tag. Bundles a portable Node runtime — verified against Node's
  published SHASUMS256 before packaging — so a machine with no Node works.
  Installs per-user to `%LOCALAPPDATA%`, no admin prompt.
- **`scripts/app.mjs`** — the application entry point. Starts the dashboard,
  watcher, and bot as detached children, opens the browser, exits. `--stop`,
  `--status`, and `--no-open` modes. Exposed as `npm start` / `npm stop` /
  `npm run app-status`.
- **VBScript launcher shims** (`installer/aim-launch.vbs`, `aim-stop.vbs`) so
  shortcuts start the agent with no console window. Start Menu gets Start, Stop,
  and Uninstall entries; desktop shortcut is optional.
- **Procedural icon generator** (`scripts/build/make-icon.mjs`). The icon is code
  rather than a committed binary, so what ships in the installer's title bar is
  reviewable. Small sizes get a simplified glyph — at 16px a flap, a gradient, and
  a status dot turn into a smudge.
- **Update checking** against GitHub Releases, self-throttled to every six hours
  and cached in `state.json`. Surfaces as a dashboard banner with a direct
  installer link and a line in Telegram `/status`. It never downloads or installs
  anything.
- Per-process heartbeats for the bot, so the launcher can tell a dead bot from a
  dead watcher.
- 24 tests covering state round-trips, PID registration, liveness, and version
  comparison.

### Fixed

- **Every state write was being silently discarded.** `readJson` in `state.mjs`
  called `stripBom` without importing it; the bare `catch` swallowed the
  `ReferenceError` and returned defaults, so the file on disk was correct while
  every read said otherwise. Symptom was the daily digest re-sending every three
  seconds. `node --check` cannot catch a `ReferenceError`, so `state.test.mjs` now
  asserts read-after-write on every accessor, and the catch re-throws anything
  that is not a parse or I/O error.
- **A UTF-8 BOM in `config.json` made the app refuse to start**, with an error that
  did not say why. Notepad and PowerShell's `Set-Content -Encoding utf8` both write
  one. Every read of a user-editable text file now strips it — config, `.env`, the
  JSONL ledgers, and `package.json`.
- **`version()` reported `0.0.0` everywhere** since 1.1.0, because the version bump
  wrote a BOM into `package.json`. The three duplicate implementations are now one
  BOM-tolerant `currentVersion()` in `update-checker.mjs`.
- **PID registration raced.** Three processes starting within milliseconds all
  read the same shared `pids.json`, so the last write won and the lost
  registrations made Stop silently skip those processes. Now one file per process
  under `data/pids/`, which has no such window.
- **Liveness could be fooled by a stale heartbeat file.** A fresh beat left behind
  by an exited process made the launcher skip starting a dead watcher. Liveness
  now requires a fresh beat **and** a live PID.
- `app.mjs --stop` reports honestly when something is running but unregistered, and
  verifies with a re-probe instead of assuming the signal worked.

### Changed

- Long-running processes self-register their PID rather than the launcher
  recording what it spawned. After a reboot the scheduler starts them directly, so
  a launcher-only record would be empty and Stop would do nothing.

## [1.1.0] — 2026-08-05

Date of birth and SSN last four are now supported as opt-in onboarding details,
replacing the previous blanket refusal. Everything else in that family stays blocked.

### Added

- `AIM_DATE_OF_BIRTH` and `AIM_SSN_LAST4` in `.env`. They live there rather than in
  `config.json` because config is snapshotted into `data/backups/` on change, and identity
  data should not be copied around.
- `profile.provideDateOfBirth` (default true) and `profile.ssnLast4Acknowledged`
  (default false) as consent flags. The values themselves are never stored in config.
- `ONBOARDING_INFO` reply template. Includes only the fields actually available and
  consented to, and states that full SSN, ID scans, and banking details are not sent by
  email — offering the onboarding portal or a phone call instead.
- `/ssn` and `/dob` Telegram commands. `/ssn` prints the rundown and current state;
  `/ssn confirm` enables, `/ssn off` disables.
- Dashboard "Onboarding details" panel. The confirm button only exists after the notice
  has rendered, so consent cannot be reached in a single click.
- Two-tier sensitive-ask classification (`classifySensitiveAsk`). Opt-in matches are
  removed from the text before the blocked patterns run, so "last 4 of your SSN" is read
  as the narrow ask rather than tripping the full-SSN rule on the word inside it.
- 19 tests covering the tiering, both consent gates, template rendering with fields
  withheld, category-inheritance refusal, and config validation.

### Changed

- `resolveConditionals` now takes the trailing newline with a dropped whole-line block. A
  withheld field previously left a blank line mid-list, which reads as a render failure.
- Sending an onboarding reply requires `ONBOARDING_INFO` to be allowlisted in
  `policy.autoSend.categories` **by name**. It deliberately does not inherit permission
  from the category that triggered it — a rate question with a DOB ask attached should not
  authorise mailing identity data.
- `validate()` rejects a malformed `AIM_SSN_LAST4` as a hard error. A full SSN pasted into
  that field is the exact accident the four-digit constraint exists to catch.
- Onboarding values are scrubbed from logs by value regardless of length; the previous
  8-character floor would have let four digits through.
- The dashboard API reports presence and consent as booleans only. The values are never
  serialized into a response that ends up in browser memory or a screenshot.

### Still never sendable

Full SSN, driver's licence, passport, bank account or routing details, voided cheque,
mother's maiden name. No config field, no template, no override.

## [1.0.0] — 2026-08-05

Initial release.

### Added

**Mail ingestion**
- Multi-account watcher. Each inbox gets its own cursor, backoff, and error state, so one
  broken account never stops the others.
- Gmail transport over the REST API with `fetch` — no `googleapis` dependency. Incremental
  sync via `history.list`, with a bounded backfill when the cursor ages out.
- IMAP/SMTP transport via `imapflow` + `mailparser` + `nodemailer`, covering Gmail,
  Outlook, Fastmail, and custom domains with an app password.
- Gmail OAuth: installed-app authorization code flow with PKCE and a loopback redirect.

**Classification**
- Rules engine: weighted patterns per category with subject matches weighted heavier, plus
  hard precedence rules for rejection-after-interview, ATS receipts containing a full job
  description, and job-board digests masquerading as requirements.
- Optional Claude tiebreaker (`claude-haiku-4-5` by default) for messages the rules cannot
  settle. Degrades to rules on any API failure.
- Deterministic field extraction: title, client, agency, recruiter, location, work mode,
  rate (hourly vs annual), duration, employment type, visa, req id.
- Quoted-reply and signature stripping so a deep thread does not re-fire rules from
  earlier messages.

**Deduplication**
- Requisition fingerprints that collapse title decoration and company legal suffixes.
- Job-description matching via bottom-k shingle sketches with a containment-style
  comparison, so a padded or reworded JD still collides.
- Ledger shared across every configured inbox — the same req arriving at three addresses
  is one requisition.
- Client-collision detection: a different role at a client you are already in play with,
  surfaced but never auto-answered.
- Optional read-only bridge to automatic-munyun-machine's surfaced-role history.

**Actions**
- AND-gated auto-send: enabled flag, category allowlist, confidence floor, remote-only,
  rate floor, dedupe clear, blocklist, hourly and per-thread caps, and a signature check.
  Caps are re-checked at send time, not only when queued.
- Reply templates with slot filling and conditional clauses. A template with an unfilled
  required slot is disabled rather than sent with a gap.
- Auto-archive for rejections, application receipts, job alerts, and newsletters — label
  and remove from inbox on Gmail, move to folder on IMAP. Never deletes.
- Hard refusal to auto-send personal identifiers (SSN, date of birth, ID, bank details).
  No template can emit them and no config field stores them.
- Interview requests are always escalated and never auto-replied.

**Telegram**
- Alert cards with inline Send / Edit / Skip / Block buttons, editing the card in place on
  action instead of posting a second message.
- Commands: `/status` `/today` `/stats` `/pending` `/interviews` `/subs` `/dupes`
  `/templates` `/pause` `/resume` `/autosend` `/remote` `/floor` `/block` `/digest` `/help`.
- Natural-language questions answered from a pre-aggregated ledger snapshot, with a
  deterministic fallback that works with no API key.
- QR deep-link pairing carrying a one-time nonce — no chat ID to look up by hand.
- Single-chat access control; updates from any other chat are dropped and logged.

**Other channels**
- ntfy.sh sink for zero-account phone push (alerts only).
- Generic webhook sink shaped so Discord and Slack incoming webhooks work unmodified.
- Quiet hours that hold non-urgent pushes and flush them when the window closes. Interview
  alerts always break through.

**Operations**
- Localhost dashboard: account health, stat tiles, approval queue with inline editing,
  classified inbox stream, duplicates, submissions, policy toggles, profile editor,
  Telegram pairing. Single file, inline CSS and JS, no external requests, light and dark.
- Per-process CSRF token on every state-changing request; server bound to 127.0.0.1.
- Watchdog that detects a stale heartbeat, restarts the watcher, and pushes a notification.
- Scheduler registration for Windows Task Scheduler, launchd, and systemd user units.
- Interactive setup wizard that never prompts for a secret.
- Daily digest with per-category breakdown.
- Secret scrubbing on every log line by pattern and by value: bot tokens, API keys, OAuth
  and refresh tokens, app passwords. Chat IDs and addresses are masked.

### Notes

- Auto-send ships **disabled**. `npm run once` is a read-only pass for validating
  classification against your own mail before granting autonomy.
- Google Cloud OAuth apps left in "Testing" expire refresh tokens every 7 days, which
  kills a 24/7 watcher. Set the app to "In production" — see `.env.example`.
