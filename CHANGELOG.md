# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
