# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
