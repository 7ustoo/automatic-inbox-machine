# CONTEXT

Running state of the project. Read before structural changes; update after any commit
that adds a command, file, or schema field.

**Version:** 1.2.0 · **Node:** ≥20 (developed on 24.18) · **Tests:** 165 passing

## Current state

Complete and self-consistent. Every subsystem described in the README exists and is
exercised by tests. Not yet run against a live mailbox — the Gmail OAuth client and
Telegram bot token are user-supplied, so first-run verification belongs to the operator
via `npm run once`.

## File map

```
scripts/
  os-paths.mjs          paths, ensureDirs, absolute system-binary paths
  env.mjs               .env loader (no dotenv dep), per-account secret lookup
  log.mjs               scrubbed logging, crash guards, masking
  config-rw.mjs         atomic config.json access, DEFAULTS, validate()
  state.mjs             per-account cursors, telegram offset, pairing nonce, heartbeat
  ledger.mjs            append-only JSONL, LedgerIndex, stats/query helpers
  normalize.mjs         text normalization, title/company keys, similarity metrics
  rules.mjs             weighted patterns + precedence — the free classifier
  extract.mjs           labelled lines, rate/work-mode/duration/agency extraction
  classify.mjs          rules → optional Claude, prepareMessage()
  dedupe.mjs            fingerprints, JD bottom-k sketches, duplicate verdicts
  gate.mjs              decision engine, AND-gated auto-send, quiet hours
  templates.mjs         reply templates, slot filling, sensitive-data guard
  responder.mjs         outbound queue/send/skip/edit, idempotent by status
  req-lookup.mjs        recovers the req behind an outbound row after a restart
  pipeline.mjs          the spine: prepare→classify→dedupe→gate→draft→act→record
  accounts.mjs          AccountRunner: per-inbox cursor, backoff, isolation
  watcher.mjs           long-running loop, digest scheduling, --once mode
  watchdog.mjs          heartbeat check + restart
  telegram-api.mjs      Bot API over fetch: chunking, escaping, keyboards
  telegram-bot.mjs      poll loop, access control, commands, callbacks, Q&A
  telegram-setup.mjs    token validation, QR pairing links, unpair
  ask.mjs               NL questions over a pre-aggregated ledger snapshot
  amm-bridge.mjs        read-only AMM history as a dedupe source
  dashboard.mjs         localhost HTTP server, CSRF, static assets
  dashboard-api.mjs     dashboard reads and actions (returns no secrets)
  setup-wizard.mjs      interactive setup; never prompts for secrets
  scheduler-register.mjs  Task Scheduler / launchd / systemd
  uninstall.mjs         removes scheduler entries, optionally data
  check-syntax.mjs      node --check over every .mjs
  run-tests.mjs         syntax gate + node:test
  transports/
    index.mjs           factory + cursor shaping
    gmail.mjs           Gmail REST over fetch
    gmail-oauth.mjs     installed-app PKCE flow, loopback redirect, token cache
    imap.mjs            imapflow + mailparser + nodemailer
  notify/
    index.mjs           fan-out, quiet-hours hold + flush
    format.mjs          card and digest rendering, keyboards
    telegram.mjs        push sink
    ntfy.mjs            zero-account phone push (alerts only)
    webhook.mjs         generic JSON sink, Discord/Slack-shaped
  web/
    dashboard.html      single-file console: inline CSS/JS, no external requests
  __tests__/            fixtures + 8 test files
```

## Data files (all gitignored)

| Path | Shape |
|---|---|
| `data/messages.jsonl` | one row per processed message: category, confidence, gate reasons, action, extracted fields |
| `data/reqs.jsonl` | unique requisitions: fingerprint, normalized title/client, JD sample + bottom-k sketch |
| `data/submissions.jsonl` | what you are actually in play for — the dedupe backbone |
| `data/outbound.jsonl` | replies: `pending` → `sending` → `sent`/`failed`/`skipped`/`expired` |
| `data/events.jsonl` | audit trail, plus quiet-hours-held notifications |
| `data/state.json` | per-account cursors, telegram offset, pairing nonce, last digest date |
| `data/heartbeat.json` | watcher liveness for the watchdog and dashboard |
| `data/tokens/<id>-token.json` | Gmail OAuth tokens, mode 0600 |

## Decisions and why

**JSONL over SQLite.** `better-sqlite3` is a native addon. An end user installing a job
tool should never meet `node-gyp`. At a few hundred messages a day an append plus an
in-memory index rebuilt at startup is faster to reason about and greppable when something
looks wrong.

**No Go wrapper (diverges from AMM).** AMM's wrapper buys a tray icon and supervision.
Here supervision comes from the platform scheduler plus `watchdog.mjs`, so a second
language and a build step would cost every user a toolchain for a tray icon.

**Two mail transports, on purpose.** `gmail.modify` is a *restricted* OAuth scope. Fine
for the author's own Cloud project; for a distributed app it triggers Google verification
plus a CASA security assessment. IMAP + app password needs none of that and covers
non-Gmail providers, so it is the path that makes the project shippable to other people.

**Rules before model, never model-only.** Rules settle the bulk of a flooded inbox for
free and deterministically. The model is a tiebreaker, so an API outage degrades behaviour
instead of stopping the agent.

**Auto-send ships off.** The first days are for watching what it *would* have said. Every
blocked reply becomes a one-tap approval rather than being dropped, so nothing is lost
while thresholds get tuned.

**Client collisions are never automated.** A second agency pitching the same end client is
the expensive mistake — the client kills your profile, not the agency. That decision
always goes to the human.

**Telegram over Slack.** Slack needs Socket Mode plus two tokens plus workspace install
rights, and the workspace most job seekers have is their employer's. Telegram needs one
token and is personal by default. The QR pairing flow removes the chat-ID step, which was
the genuinely confusing part.

## Known gaps

- **IMAP polls rather than IDLE.** `imapflow` supports IDLE; the current loop polls on
  `pollSeconds`. Push would cut interview-alert latency from ~45s to near zero.
- **Attachments are ignored.** A JD sent only as a PDF classifies on the covering note.
- **The Telegram edit flow is in-memory.** Restarting the bot mid-edit loses the pending
  edit target (the draft itself is safe in the ledger).
- **Digest timing is hour-granular** and fires on the first tick at or after the hour.
- **No pagination in the dashboard stream** — capped at the most recent rows.
- **`ask.mjs` sends a ledger snapshot,** so answers are bounded by what the snapshot
  aggregates. Very specific historical questions may fall outside it.

## Hard-won lessons

Things that broke once and must not break again. Each has a test.

**Never swallow every error in a catch.** `readJson`'s bare catch hid a missing
import, so every state write silently reverted to defaults while the file on disk
was correct. A catch that recovers from corrupt input must re-throw programming
errors.

**Strip the BOM on every user-editable file read.** Notepad and PowerShell's
`Set-Content -Encoding utf8` both write one. It made `config.json` unreadable and
`package.json`'s version report `0.0.0`.

**No shared mutable file across processes.** Three processes start within
milliseconds at login; a shared `pids.json` meant read-modify-write and lost
registrations. One file per writer.

**Liveness needs two independent signals.** A heartbeat file outlives the process
that wrote it, and PIDs get recycled. Freshness *and* a live PID.

**Never ship user state in the installer payload.** `npm test` creates
`config.json` and `data/*.jsonl` in the CI checkout; with `ignoreversion` they
overwrite a real user's settings on upgrade. Excluded in the `.iss` and scrubbed
again in the workflow — AMM shipped this bug once and it reset people's configs.

## Change history

**1.2.0** — shipped as a downloadable Windows app: Inno Setup installer with a
bundled Node runtime, `app.mjs` launcher, VBS shims for windowless startup,
procedural icon, release workflow on tag. Update checking against GitHub Releases.
Fixed three silent-data-loss bugs: state writes discarded by a swallowed
`ReferenceError`, BOM intolerance across every config read, and a PID registration
race. Liveness now requires a fresh beat and a live PID.

**1.1.0** — date of birth and SSN last four became opt-in onboarding details instead of a
blanket refusal. Two-tier sensitive-ask classification, `ONBOARDING_INFO` template,
`/ssn` + `/dob` commands, dashboard consent panel behind a rendered notice. Values held in
`.env` so they stay out of config snapshots; consent flags in config. `ONBOARDING_INFO`
never inherits auto-send permission from its triggering category. Fixed
`resolveConditionals` leaving a blank line where a withheld field was.

**1.0.0** — initial build. Multi-account watcher (Gmail REST + IMAP), rules+Claude
classifier, cross-account dedupe with client-collision detection, AND-gated auto-send with
Telegram approvals, auto-archive, interview alerting, QR pairing, NL Q&A over the ledger,
localhost dashboard, watchdog, three-platform scheduling, 122 tests.
