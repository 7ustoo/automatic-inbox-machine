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
| "Send your SSN and date of birth" | Alert only. The agent has no template that can send these. |

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

Needs [Node 20+](https://nodejs.org).

```bash
git clone https://github.com/7ustoo/automatic-inbox-machine.git
cd automatic-inbox-machine
npm install
npm run setup
```

The wizard walks through inboxes, your reply profile, and how much autonomy the agent
gets. It never asks you to type a secret — those go in `.env` by your own hand.

### 1. Pick a transport per inbox

**`imap`** — an app password. Works with Gmail, Outlook, Fastmail, custom domains.
Nothing to register, no OAuth consent screen. Requires 2FA on the account.

**`gmail`** — the Gmail API. Better fidelity: real labels, reliable threading,
incremental sync. Costs you a one-time Google Cloud setup:

- Create an **OAuth client ID → Desktop app**, enable the **Gmail API**
- Scopes: `gmail.modify` + `gmail.send`
- **Set the app's publishing status to "In production", not "Testing."** Test-user
  refresh tokens expire every 7 days and will silently kill a 24/7 watcher. You'll
  click through one "unverified app" warning; that's it.
- Then: `npm run login -- <accountId>` per inbox

> If you plan to distribute this to other people, use the IMAP path. `gmail.modify` is
> a *restricted* scope, and a distributed app using it needs Google verification plus a
> CASA security assessment — real money, weeks of process, and they can say no.

### 2. Connect Telegram

Message [@BotFather](https://t.me/botfather), send `/newbot`, put the token in `.env`
as `TG_TOKEN=…`. Then run `npm run dashboard` and **scan the pairing QR** — it opens
your bot and binds the chat automatically. You never look up a chat ID.

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
npm run watch      # the long-running watcher
npm run bot        # the Telegram bot
npm run dashboard  # console at http://127.0.0.1:7391
npm run register-tasks   # start all three at login
```

---

## Telegram commands

**Reading** — `/status` `/today` `/stats 168` `/pending` `/interviews` `/subs [client]` `/dupes` `/templates`

**Control** — `/pause` `/resume` `/autosend on|off` `/remote on|off` `/floor 70` `/block agency.com` `/digest`

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

**Never automated, whatever the config says:** interview requests, rejections, and
anything asking for an SSN, date of birth, ID, or bank details. There is no template
that can emit those and no config field to store them.

**Archive means archive.** Rejections get a label and leave the inbox. Nothing is ever
deleted, and everything is recoverable from All Mail.

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
