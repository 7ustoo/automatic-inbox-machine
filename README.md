# Automatic Inbox Machine

**Your recruiter inbox, run from Telegram.**

If you contract, your inbox is 90% noise: thank-you-for-applying receipts, rejection
form letters, job-board digests, and the same requisition shotgunned to you by four
different agencies. The three emails that actually matter — an interview request, a
right-to-represent, a rate confirmation — are buried underneath.

This watches every inbox you own, answers the routine mail, archives the noise,
catches the same role showing up twice, and messages you on Telegram the moment
someone wants to interview you.

Local-first. No hosted backend. Your mail never leaves your machine except to reach
your mail provider and, if you enable it, a classifier call to Anthropic.

```
Gmail / IMAP ──► classify ──► dedupe ──► gate ──► reply · archive · alert
   (N inboxes)    rules,        across      every           │
                  then Claude   all inboxes  check must     ▼
                  for ties                   pass       Telegram
```

---

## What it actually does

| Mail that arrives | What happens |
|---|---|
| "We're moving forward with other candidates" | Labelled and archived. Never deleted. You never see it. |
| "Thank you for applying" (ATS receipt) | Same. Counted in the digest, silent. |
| "27 new jobs matching your search" | Same. |
| "Can you share your availability for a screening call?" | 🚨 **Telegram alert, immediately.** Never auto-replied. |
| "I need your RTR before I submit you" | Reply with your details — gated on the duplicate check |
| "What's your expected hourly rate?" | Reply with your rate, availability, work authorization |
| A new fully-remote req above your floor | Reply expressing interest, ask for the client name |
| The same req from a second agency | "I'm already submitted for this by *X* on *date*" |
| A different role at a client you're already with | ⚠️ **Collision alert.** Needs your call, never automated. |
| "Send your DOB and last 4 of your SSN" | Opt-in. Off by default; on once you enable it. See below. |
| "Send your full SSN / licence / bank details" | Alert only. No template can send these, in any configuration. |

Then you can just ask it things:

> **How many reqs this week?**
> 34 new requirements in the last 7 days. 6 were duplicates, 2 became interview requests.

> **Who submitted me to Deloitte?**
> BrightPath Resourcing, on Jul 28, for Sr. Java Developer. One other agency pitched
> the same client on Aug 2 — you skipped that one.

---

## Why the duplicate detection is the point

Two agencies submitting you to the same end client is what gets your profile killed —
**by the client, not by the agency.** You look like you're shopping yourself around,
and both submissions get binned.

The dedupe ledger is deliberately **shared across every inbox you configure.** A req
that lands at three addresses from three agencies is one requisition, and the second
and third get flagged with who pitched it first and when. Matching runs three ways:

1. Normalized title + client (`Sr. Java Developer (Remote) - W2` → `senior java developer`, `Deloitte Consulting LLP` → `deloitte`)
2. Job-description overlap, so the same JD reworded still collides
3. **Client-level collision** — a *different* role at a client you're already in play with

That third one is never auto-answered. It's the expensive mistake, so it gets a human.

---

## Install

### Windows — download the installer

**[Download the latest `aim-setup-*.exe`](https://github.com/7ustoo/automatic-inbox-machine-releases/releases/latest)**

Double-click it. No admin needed, and **you do not need Node installed** — the
installer bundles its own runtime.

It installs to `%LOCALAPPDATA%\automatic-inbox-machine`, adds a Start Menu entry
(plus an optional desktop shortcut), and offers to register startup tasks so the
agent is watching mail again after a reboot.

**It opens as a real application window** — its own title bar, its own taskbar
entry, no browser, no console. It also lives in the system tray: closing the window
leaves the agent watching your mail, and the tray menu is where you pause, restart
the watcher, or quit for real.

**Setup happens entirely in the dashboard.** No terminal, no config files, no
editing dotfiles. It asks for your email address, guesses your provider's IMAP
settings, takes an app password, collects the details that fill your replies, and
walks you through connecting Telegram. Then it starts watching.

Windows will show a SmartScreen warning — the installer is unsigned. **More info →
Run anyway.** A code-signing certificate costs a few hundred a year and this is a
free tool; if you'd rather not click through it, use the git install below.

| Tray menu | What it does |
|---|---|
| Open Inbox Agent | Show the window (or raise it if already open) |
| *status line* | Whether it is watching, paused, or stopped |
| Pause / Resume | Stop or restart sending and archiving |
| Restart watcher | Reconnect and resume reading mail |
| Open logs folder | For when something needs diagnosing |
| Quit | Stop watching and exit completely |

Upgrading: run the new installer over the top. Your `config.json`, `.env`, and
`data/` ledger are preserved — the installer stops the running agent first so
nothing is copied over a locked file.

### macOS, Linux, or from source

Needs [Node 20+](https://nodejs.org).

```bash
git clone https://github.com/7ustoo/automatic-inbox-machine.git
cd automatic-inbox-machine
npm install
npm start
```

`npm start` opens the same dashboard setup flow. There's also `npm run setup` — an
interactive terminal wizard that does the same job — but it exists as a developer
escape hatch, not the path anyone is expected to take.

The wizard walks through inboxes, your reply profile, and how much autonomy the agent
gets. It never asks you to type a secret — those go in `.env` by your own hand.

### 1. Connect an inbox

**Sign in with Google (recommended for Gmail).** One click: your browser opens,
you approve, done. No passwords, no 2-Step Verification required. Release builds
bundle the OAuth client (same pattern as AMM); a dev checkout sitting next to a
local `automatic-munyun-machine` install borrows its client automatically.

**App password** — for Outlook, Yahoo, iCloud, Fastmail, custom domains, or Gmail
if you prefer. Requires 2-Step Verification on the account first. If Google's
app-password page says it's **"not available for your account"**, that's what it
looks like when 2-Step Verification is off — use Sign in with Google instead.

### 2. Connect Telegram

Message [@BotFather](https://t.me/botfather), send `/newbot`, and paste the token
into the dashboard. Then **scan the pairing QR** it shows you — that opens your bot
and binds the chat automatically. You never look up a chat ID or touch a config file.

Prefer no bot at all? Set `NTFY_TOPIC` to an unguessable string and install the
[ntfy](https://ntfy.sh) app. Zero accounts, zero tokens — alerts only, no conversation.

### 3. Watch it before you trust it

```bash
npm run once
```

One read-only pass. Classifies, logs, alerts — sends nothing, archives nothing.
Look at what it decided in the dashboard, tune the thresholds, *then* hand over
the keys. Auto-send ships **off** for exactly this reason.

```bash
npm start          # start everything and open the dashboard (what the shortcut runs)
npm stop           # stop everything
npm run app-status # what is currently up
```

Or run the pieces individually:

```bash
npm run watch      # the long-running watcher
npm run bot        # the Telegram bot
npm run dashboard  # console at http://127.0.0.1:7391
npm run register-tasks   # start all three at login
```

---

## Telegram commands

**Reading** — `/status` `/today` `/stats 168` `/pending` `/interviews` `/subs [client]` `/dupes` `/templates`

**Control** — `/pause` `/resume` `/autosend on|off` `/remote on|off` `/floor 70` `/block agency.com` `/dob on|off` `/ssn` `/digest`

Anything that isn't a command is a question about your inbox.

`/pause` is the hard stop. Nothing sends or archives until `/resume`. Interview alerts
still come through, because that's never the thing you want to switch off.

---

## Safety, concretely

Auto-send is gated by **AND**, not OR. Every applicable check must pass:

- `policy.autoSend.enabled` is on, and the template is in `autoSend.categories`
- Classifier confidence ≥ `policy.minConfidence` (default 0.85)
- Role is remote (or hybrid, if you allow it) — an unstated work mode blocks the send
- Rate at or above your floor
- Not a duplicate, not a client collision
- Sender not blocklisted
- Under the hourly cap and the per-thread cap
- `profile.fullName` is set — it will not send unsigned mail

Anything that fails a gate becomes a Telegram card with **Send / Edit / Skip**, so it's
never silently dropped. Caps are re-checked at send time, not just when queued, so an
approval sitting in Telegram for an hour can't bypass the cap it was queued under.

**Never automated, whatever the config says:** interview requests, rejections, and any
request for a full SSN, driver's licence, passport, or bank details. There is no template
that can emit those and no config field to store them.

**Archive means archive.** Rejections get a label and leave the inbox. Nothing is ever
deleted, and everything is recoverable from All Mail.

---

## Onboarding details (date of birth, SSN last four)

Recruiters ask for these constantly — VMS platforms use them to tell you apart from
someone with the same name and to spot duplicate submissions. So they're supported, but
tiered and opt-in.

Both values live in **`.env`, never `config.json`** — `config.json` gets snapshotted into
`data/backups/` when it changes, and identity data shouldn't be copied around.

```
AIM_DATE_OF_BIRTH=04/12
AIM_SSN_LAST4=1234
```

**Date of birth** is on once set. Toggle with `/dob off`.

**SSN last four** needs a second, explicit step. Setting the env var is not consent to
mail it — you also confirm after reading the notice:

```
/ssn            # shows the rundown and current state
/ssn confirm    # enables it
/ssn off        # disables it
```

Or use the dashboard's Onboarding panel, where the confirm button only appears after the
notice is rendered.

> Most recruiters ask for the last four of your SSN to create a candidate profile for you
> in their system. It's a routine ask in staffing and the risk in providing it is low.
> That said: it's your data and your decision. This project is not responsible for what
> happens to the information once it leaves your mailbox.

Three things worth knowing about how it's wired:

1. **A reply carrying these never inherits auto-send permission from its category.** If a
   recruiter asks for your rate *and* your SSN last four, having `RATE_CONFIRM` allowlisted
   is not enough — `ONBOARDING_INFO` has to be allowlisted by name. Two separate decisions:
   *may the agent include this* and *may the agent send it unasked*.
2. **A mixed request is blocked by its worst element.** "DOB, last 4, and a copy of your
   licence" doesn't get partially answered — the licence request makes the whole thing
   yours to handle.
3. **`AIM_SSN_LAST4` must be exactly four digits.** Anything else is a hard config error,
   because a full SSN pasted into that field is precisely the accident this exists to catch.

Every generated reply also states plainly that you don't send full SSN, ID scans, or
banking details by email, and offers the onboarding portal or a phone call instead.

Never storable and never sendable regardless: full SSN, driver's licence, passport, bank
account or routing details, mother's maiden name.

---

## Configuration

`config.json` — created from `config.example.json` by the wizard. Every field has a
comment there. The interesting ones:

| Key | Default | What it does |
|---|---|---|
| `accounts[]` | — | One entry per inbox. `transport` is `gmail` or `imap`. |
| `policy.autoSend.enabled` | `false` | The master switch for replying without asking |
| `policy.minConfidence` | `0.85` | Confidence floor for auto-send |
| `policy.remoteOnly` | `true` | Onsite roles get a decline draft |
| `policy.rateFloorHourly` | `0` | Below this becomes a decline draft. 0 disables. |
| `policy.autoArchive.categories` | rejections, receipts, alerts, newsletters | What leaves the inbox |
| `policy.quietHours` | off | Holds non-urgent pushes. Interviews always break through. |
| `dedupe.sameClientWindowDays` | `45` | How long a client collision stays live |
| `profile.provideDateOfBirth` | `true` | Include DOB in onboarding replies (value in `.env`) |
| `profile.ssnLast4Acknowledged` | `false` | Consent flag for SSN last four. Set it via `/ssn confirm`, not by hand. |
| `classify.ai.enabled` | `false` | Claude for ambiguous mail. Rules-only works fine without it. |
| `ammBridge.enabled` | `false` | Read-only bridge to [automatic-munyun-machine](https://github.com/7ustoo/automatic-munyun-machine) |

Secrets live in `.env` only — see `.env.example`. `config.json`, `data/`, `logs/`,
and `.env` are all gitignored.

---

## How classification works

**Rules first, model second, never model-only.** Weighted regex patterns per category,
with subject matches counted heavier than body matches, plus hard precedence rules for
the cases naive keyword matching gets wrong:

- "Thank you for interviewing with us… unfortunately" → **rejection**, not interview
- "We'll keep your resume on file" → **rejection**
- An ATS receipt that restates the whole job description → **receipt**, not a new req
- A job-board digest full of job titles → **digest**, not a requirement

That settles the bulk of a flooded inbox for free and with no latency. Claude
(`claude-haiku-4-5` by default) is only asked about messages the rules can't settle, or
in the three categories where a wrong call is expensive. If the API is down,
misconfigured, or out of budget, the agent degrades to rules and keeps running.

When rules and model agree, confidence compounds. When they disagree, the model's call
is taken but confidence is capped — so a contested message still has to clear the
auto-send gate on its own merits instead of sailing through.

---

## Storage

Append-only JSONL under `data/`, indexed in memory at startup:

`messages.jsonl` · every message and why it was classified and acted on
`reqs.jsonl` · unique requisitions with title, client, rate, JD sketch
`submissions.jsonl` · what you're actually in play for — the dedupe backbone
`outbound.jsonl` · every reply, queued → sent/skipped/expired
`events.jsonl` · audit trail

No SQLite on purpose: `better-sqlite3` is a native addon, and nobody installing a job
tool should meet a `node-gyp` error. At a few hundred messages a day, an append plus an
in-memory index is faster to reason about and trivially greppable when something looks
wrong.

Every message leaves exactly one row recording the classification, the confidence, the
gate reasons, and the action. If you ever wonder why the agent did something, the answer
is in the row.

---

## Development

```bash
npm test     # syntax check + node:test suite
npm run check # syntax only
```

122 tests, no third-party test framework. Coverage is on the parts where a bug is
expensive: classification precedence, rate parsing, dedupe verdicts, the gate matrix,
template slot-filling, secret scrubbing, and an end-to-end pipeline pass against a fake
transport.

Architecture notes and conventions are in [CLAUDE.md](CLAUDE.md); running project state
is in [CONTEXT.md](CONTEXT.md).

---

## Related

[**Automatic Munyun Machine**](https://github.com/7ustoo/automatic-munyun-machine) — the
outbound half. It finds and ranks roles against your resume; this one handles what comes
back. Set `ammBridge.enabled` and this reads the roles AMM already surfaced as an extra
dedupe signal. Read-only, and fine if you don't have it.

## License

MIT
