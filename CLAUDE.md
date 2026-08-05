# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project

Automatic Inbox Machine (AIM) — a local-first recruiter-inbox agent for Windows, macOS,
and Linux. It watches N mail accounts, classifies each message, auto-replies to routine
recruiter mail, archives the rejection noise, detects duplicate requisitions across every
inbox, and surfaces interview requests over Telegram. There is no hosted backend.

Sibling to [automatic-munyun-machine](https://github.com/7ustoo/automatic-munyun-machine)
(AMM), which handles the outbound half of the same problem. AIM reads AMM's surfaced-role
history as an optional dedupe source and never writes into it.

`README.md` is the user-facing surface. `CONTEXT.md` is the running state-of-the-project
doc — read it before structural changes, update it after any commit that adds a command,
file, or schema field.

## Commands

```bash
npm install
npm start                 # launcher: bring up all three processes, open the UI
npm stop                  # stop them
npm run app-status        # what is up
npm run setup             # interactive wizard: accounts, profile, policy, pairing
npm run once              # one pass over new mail; the read-only shakedown mode
npm run watch             # long-running watcher (all accounts)
npm run bot               # long-running Telegram poller
npm run dashboard         # localhost console on :7391
npm run login -- <id>     # Gmail OAuth for one account
npm run register-tasks    # scheduler entries (add --remove to undo)
npm test                  # check-syntax + node:test suite
npm run check             # syntax only, ~1s
```

## Architecture

Four independent processes coordinating through the filesystem. Nothing shares memory.

```
Task Scheduler / launchd / systemd  ── at logon ──┐
                                                  │
  node scripts/watcher.mjs      ← reads mail, writes ledger, sends
  node scripts/telegram-bot.mjs ← long-poll getUpdates, approvals, Q&A
  node scripts/dashboard.mjs    ← localhost console (optional)
  node scripts/watchdog.mjs     ← every 5 min, restarts a dead watcher
                    │
              data/heartbeat.json
```

**Divergence from AMM worth knowing:** there is no Go wrapper here. AMM's wrapper exists
for a tray icon and process supervision; AIM gets supervision from the platform scheduler
plus `watchdog.mjs`, so adding a second language and a build step would buy a tray icon
and cost every user a Go toolchain. The dashboard is served straight from Node.

### The pipeline

`scripts/pipeline.mjs` is the spine. One message, one readable sequence, exactly one
ledger row at the end:

```
prepare → classify → fingerprint → dedupe → gate → draft → act → record
```

Each stage is its own module and each is independently testable:

| Module | Responsibility |
|---|---|
| `classify.mjs` | Orchestrates rules → optional Claude. Never model-only. |
| `rules.mjs` | Weighted patterns + hard precedence rules. The free classifier. |
| `extract.mjs` | Deterministic field extraction (title, client, rate, work mode) |
| `dedupe.mjs` | Fingerprints, JD sketches, duplicate and client-collision verdicts |
| `gate.mjs` | The decision engine. AND-gated auto-send, quiet hours. |
| `templates.mjs` | Reply templates with slot filling. Disabled beats blank. |
| `responder.mjs` | Queue, send, skip. Idempotent by ledger status. |
| `ledger.mjs` | Append-only JSONL + in-memory index |
| `accounts.mjs` | Per-account runner: own cursor, own backoff, own error state |
| `transports/` | `gmail` (REST over fetch) and `imap` (imapflow + nodemailer) |
| `notify/` | Channel fan-out: telegram, ntfy, webhook |

### Transport contract

Both transports implement the same surface, and `pipeline.mjs` never knows which it has:

```
connect() · listNewIds(cursor) · getMessage(id) · archive(msg, label)
applyLabel(msg, label) · markRead(msg) · sendReply({...}) · health() · disconnect()
```

Cursors are transport-shaped and opaque to callers — Gmail carries `historyId`, IMAP
carries `uidNext` + `uidValidity`. `state.mjs` stores whatever comes back. Adding a
provider means one file in `transports/` and one line in its `TRANSPORTS` map.

## Conventions

**Every write to `config.json` goes through `config-rw.mjs`.** Atomic temp-file + rename;
the watcher, bot, and dashboard can all touch it at once. Use `read()`, `set('dot.path',
value)`, `setMany()`, `addToArray()`, `upsertAccount()`. Never `JSON.stringify` +
`writeFileSync` it directly.

**Absolute paths for system binaries.** Some Windows installs are missing `System32` from
`PATH` — AMM hit this twice. `os-paths.mjs` resolves `POWERSHELL`, `CMD_EXE`, `SCHTASKS`
from `%SystemRoot%`. Never `spawn('schtasks', …)` bare.

**Secret scrubbing is not optional.** Everything user-visible goes through `log.mjs`'s
`log()`/`scrub()`, which strips bot tokens, API keys, OAuth and refresh tokens, and app
passwords by pattern as well as by value. Note the Telegram token pattern has *no leading
`\b`* — the token is glued to `bot` in the API URL, so a word boundary never matches
there. There is a test for this; don't "tidy" it back.

**`log()` must never throw.** A locked log file on Windows cannot be allowed to kill a
24/7 process. Every write is best-effort and swallows its own errors.

**Crash guards on every long-running entry point.** `installCrashGuards()` registers
`unhandledRejection` and `uncaughtException`. Poll loops back off exponentially on
`fetch failed`. Don't remove these — a transient network blip must not end the process.

**Telegram messages are HTML parse_mode.** Every interpolated value must go through
`escapeHtml()`. A subject line containing `<` will otherwise 400 the whole message.
Chunk at `MAX_MESSAGE_CHARS` (3900) with `chunk()`; buttons go on the final chunk only.

**Callback data stays under 64 bytes.** Format is `<verb>:<outboundId>` — `snd:`, `edt:`,
`skp:`, `blk:`. There is a test asserting the byte budget.

**The cursor advances even when individual messages fail.** The `messageKey` guard already
prevents reprocessing, and holding the cursor back would wedge an account on one poison
message forever.

**Nothing is ever deleted.** Archive = remove from inbox + apply a label (Gmail) or move
to a folder (IMAP). No `\Deleted` flag, no `messages.delete`, ever.

**Personal identifiers are tiered, not uniformly refused.** `classifySensitiveAsk()` in
`templates.mjs` splits a request into an opt-in tier (date of birth, SSN last four) and a
blocked tier (full SSN, driver's licence, passport, bank details, mother's maiden name).
Rules that must hold when touching this:

- Opt-in matches are stripped from the text *before* the blocked patterns run, so
  "last 4 of your SSN" is not read as a full-SSN request. Keep that ordering.
- Both opt-in values live in `.env` (`AIM_DATE_OF_BIRTH`, `AIM_SSN_LAST4`), never in
  `config.json` — `snapshot()` copies config into `data/backups/`. Only the *consent flags*
  belong in config.
- SSN last four is double-gated: value present AND `profile.ssnLast4Acknowledged`. Setting
  an env var is not consent.
- `ONBOARDING_INFO` must be allowlisted in `autoSend.categories` **by name** and never
  inherits permission from the triggering category. See `categoryAllowed` in `gate.mjs`.
- A mixed request is blocked by its worst element. Never partially answer one.
- The blocked tier has no config field and no template. Do not add either.

`onboarding.test.mjs` pins all of the above. If a change there makes a test fail, the test
is probably right.

**Version is single-sourced from `package.json`**, read through
`currentVersion()` in `update-checker.mjs`. Bumping means editing that file only —
but write it with LF and **no BOM**. PowerShell's `Set-Content -Encoding utf8`
writes one, and it made every surface report `0.0.0`.

**Strip the BOM on every read of a user-editable text file.** `stripBom` in
`normalize.mjs`. Applies to `config.json`, `.env`, the JSONL ledgers, and
`package.json`. Notepad writes one by default; without this the app refuses to
start with an error that does not explain itself.

**Never swallow every error in a catch.** `readJson`'s bare catch hid a missing
import and silently reverted every state write to defaults. A catch that recovers
from corrupt input must re-throw programming errors — see the `SyntaxError ||
error.code` check.

**Distribution.** `installer/aim.iss` + `.github/workflows/release.yml` build the
Windows installer on a `v*.*.*` tag. Two rules there:
- `\config.json`, `.env`, `data\*`, and `logs\*` must stay excluded from the
  payload. `npm test` creates them in the CI checkout, and `ignoreversion` would
  overwrite a real user's settings and ledger on upgrade.
- The bundled Node runtime is verified against Node's published SHASUMS256 before
  it is packaged. Do not remove that check.

**Personal data and secrets are gitignored:** `.env`, `config.json`, all of `data/` and
`logs/`, `google-oauth-client.json`, `*-token.json`, `*PRIVATE*.md`.
`config.example.json` is the shipping template — when adding a config field, add it there
too with a `_comment` if non-obvious, and to `DEFAULTS` in `config-rw.mjs`.

## Testing

`node:test`, no third-party framework. `npm test` runs `check-syntax.mjs` first and stops
if anything fails to parse.

Coverage concentrates where a bug is expensive:

- `rules.test.mjs` — precedence cases: rejection-after-interview, ATS receipt with an
  embedded JD, board digest vs real req, quoted-reply leakage
- `extract.test.mjs` — rate parsing (hourly vs annual vs years-of-experience), work mode,
  labelled lines
- `dedupe.test.mjs` — fingerprint collapse, cross-account duplicates, client collisions,
  window expiry, self-match
- `gate.test.mjs` — the full gate matrix, quiet hours wrapping midnight
- `templates.test.mjs` — slot filling, disabled-not-blank, no identity data emitted
- `pipeline.test.mjs` — end to end against a fake transport, writing to the real ledger
  under reserved account ids (`__test_a`, `__test_b`) and cleaning up in `after()`

`fixtures.mjs` holds realistic recruiter mail, deliberately including the messages that
fool naive keyword matching. New classification behaviour needs a fixture, not a tweak to
a threshold.

When adding a category, touch all four: `rules.mjs` (`CATEGORIES`, `PATTERNS`),
`gate.mjs` (routing), `notify/format.mjs` (`labelFor`, `icon`), and a fixture + test.

## Branching and releasing

Work on a version branch named for the release (`v1.1`, `v1.2`) — clean names only.
Never commit directly to `main`; the install instructions clone from it.

When the user says "push", "ship", "merge", or approves a change, that means the whole
sequence, unprompted:

1. Commit on the version branch with a clear message
2. Push and open a PR to `main`
3. Wait for CI. If it fails, fix and re-run — don't stop and report
4. Merge
5. Tag the merge commit `vX.Y.Z` matching `package.json` and push the tag

Stopping after the merge without tagging is a bug.

## Files worth knowing

- `CONTEXT.md` — running project state, file map, change history. Update after structural changes.
- `CHANGELOG.md` — Keep-a-Changelog. Add under `[Unreleased]` for any user-visible change.
- `config.example.json` — shipping template, mirrors `DEFAULTS` in `config-rw.mjs`
- `.env.example` — every secret the app reads, with the Google OAuth publishing-status gotcha documented
- `scripts/__tests__/fixtures.mjs` — the recruiter-mail corpus
