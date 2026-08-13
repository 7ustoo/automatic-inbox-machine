# Troubleshooting

## "Windows protected your PC" (SmartScreen)

Click **More info** → **Run anyway**. It appears because the installer is unsigned
and unknown to SmartScreen, and it only nags once per downloaded file.

To remove it for everyone permanently, releases must be code-signed. The workflow
is already wired for **Microsoft Trusted Signing** (same as AMM): create a Trusted
Signing account in Azure (~$10/month, identity validation required), then set five
repo secrets — `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TS_ACCOUNT`, `AZURE_TS_PROFILE`. Every release after that signs both
`AIM.exe` and the installer automatically; without the secrets, signing skips
itself with a warning and releases stay unsigned-but-working.

---

Start with the dashboard (`npm run dashboard`) — the banners at the top state the actual
problem most of the time. Failing that, `logs/watcher.log`, `logs/bot.log`, and
`logs/transport.log` are plain text and safe to read; secrets are scrubbed before write.

---

## The watcher

### "Watcher stale" or "watcher never started"

The watcher writes a heartbeat every few seconds. Stale means the process is gone.

```bash
npm run watch
```

If it exits immediately, it printed why. The usual cause is a config error — the watcher
refuses to start against an invalid config rather than half-running.

If it was registered to start at login and didn't, check the scheduler entry:

```bash
npm run register-tasks
```

On Windows the entries are `aim-watcher`, `aim-bot`, `aim-watchdog` in Task Scheduler.

### Nothing is being classified, but the watcher is alive

Check `/status` in Telegram or the accounts panel. A red account means the transport is
failing; the error is on the row. Also check whether the agent is paused — `/resume`.

### It processed a huge backlog on first run

By design it doesn't: a first run or an expired cursor takes only the recent tail
(Gmail: `newer_than:2d`; IMAP: the last ~60 UIDs). If you want history processed, that is
deliberately not automatic.

---

## Gmail

### "Gmail account X is not authorized"

```bash
npm run login -- X
```

### It worked for a week and then stopped

**This is the big one.** Your Google Cloud OAuth app is in **Testing** status, where
refresh tokens for test users expire after 7 days.

Fix it permanently: Google Cloud Console → APIs & Services → OAuth consent screen →
**Publish app** / set to **In production**. Verification is not required for your own use —
you will click through one "unverified app" warning at consent. Then re-run
`npm run login -- <id>`.

### "Gmail 403 insufficient permissions"

The token was issued for narrower scopes than the agent needs. It requires `gmail.modify`
*and* `gmail.send`. Delete `data/tokens/<id>-token.json` and re-run `npm run login -- <id>`
so consent is requested again.

### "invalid_client"

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env` don't match a live OAuth client, or
the client is a Web application rather than **Desktop app**. The loopback redirect this
uses only works with a Desktop client.

---

## IMAP

### "no IMAP password for account X"

The variable name is derived from the account id, uppercased with non-alphanumerics as
underscores. Account `primary` needs:

```
IMAP_PASSWORD_PRIMARY=xxxx xxxx xxxx xxxx
```

### Gmail rejects the app password

App passwords require 2-Step Verification on the account. If you can't create one, 2FA is
off. Paste the 16 characters with or without spaces — both work.

### "Mailbox does not exist" when archiving

The agent creates `AIM/Archived` on first use. If your server uses `.` as the hierarchy
delimiter it becomes `AIM.Archived` automatically. If creation is denied, set
`policy.autoArchive.label` to an existing folder name.

### Large messages classify oddly

Messages over 2 MB skip the full-source download and classify on headers alone. A job
description sent only as a PDF attachment is not read at all — attachments are ignored.

---

## Telegram

### The bot doesn't answer

1. `TG_TOKEN` set in `.env`? The dashboard's Telegram panel says so plainly.
2. Is `npm run bot` running? It's a separate process from the watcher.
3. Have you pressed **Start** in the chat? Telegram blocks bots from messaging first.

### "dropped update from unauthorized chat"

Exactly one chat may drive the bot. Either you're messaging from a different account, or
`notify.telegram.chatId` points at an old chat. Re-pair:

```bash
npm run pair
```

Scan the QR, press Start. The link is single-use.

### Alerts arrive but buttons do nothing

The buttons are handled by the bot process, the alerts by the watcher. If the watcher is
running and the bot isn't, you get alerts you can't act on. Start the bot.

### "That draft is gone from the ledger"

The approval expired. Default is 24 hours (`policy.approvals.expireHours`) — deliberately
so a stale offer can't be fired days later. Reply by hand.

---

## Classification

### It archived something it shouldn't have

Nothing is deleted — it's labelled and out of the inbox. Find it under `AIM/Archived` or in
All Mail. Then either add a phrase to `classify.extraInterviewPhrases` so it classifies
correctly, or drop the category from `policy.autoArchive.categories`.

### It misread a message

`npm run once` and check the dashboard stream — each row shows the category, confidence,
who decided (`rules`, `model`, or `rules+model`), and the gate reasons. If the rules got it
wrong and AI is off, adding a Claude, OpenAI, or Gemini key and enabling `classify.ai.enabled` fixes most edge cases. If the rules
got it wrong systematically, add the phrase to `classify.extraRejectionPhrases` or
`classify.extraInterviewPhrases`.

### Duplicates aren't being caught

Dedupe needs a client name to be confident. If agencies aren't naming the end client
("our direct client"), title-only matching is all that's available. Lower
`dedupe.titleSimilarity` toward 0.75 to catch more, at the cost of false positives.

### It flagged a duplicate that wasn't one

Raise `dedupe.titleSimilarity` and `dedupe.jdSimilarity`. Note that a *client collision*
isn't claiming the roles are the same — it's telling you that you're already in play at
that client, which is a different and usually more important warning.

---

## Sending

### It never sends anything

That's the default. Auto-send ships off. `/autosend on` in Telegram, or the dashboard
toggle. It also requires `profile.fullName` — it won't send unsigned mail.

### A reply was blocked with auto-send on

The card says why. Every gate must pass: confidence, work-location preference, rate floor, dedupe clear,
not blocklisted, under the hourly and per-thread caps. An unstated work mode blocks the
send under a restrictive location preference — the agent won't claim a role is remote when the email didn't say.

### My resume was not attached

Open Settings → Profile, upload a PDF, DOC, or DOCX (10 MB maximum), and leave the
resume switch enabled. It is attached only to interest, RTR, and rate replies—not
declines, duplicate notices, interview alerts, or unrelated mail.

### My profile looks blank after an update

Update to v1.5.4 or newer. Earlier dashboards saved the profile correctly but rendered
empty inputs, which made preserved data look lost. The Candidate profile now pre-fills
every saved value. `config.json`, `.env`, the resume, and all ledgers are excluded from
installer replacement and are snapshotted before a one-click update.

### A terminal window flashes every few minutes

Update to v1.5.4 or newer. Older Windows scheduled tasks launched `cmd.exe` every five
minutes for the watchdog. Current tasks launch the GUI-mode `AIM.exe --background ...`
entry point, which starts Node with `CREATE_NO_WINDOW`; no PowerShell or terminal host is
part of the recurring background path.

### Install update downloads but the app does not reopen

v1.5.3 fixes a process-tree shutdown bug that could replace the files but kill the
updater before it relaunched AIM. Install v1.5.3 manually once if you are still on an
older version; subsequent one-click updates stop the registered processes first and
relaunch automatically. Details are recorded in `data/update/update.log`.

### It won't send my SSN / date of birth / ID

Correct, and not configurable. There is no template that can emit those and nowhere in
`config.json` to store them. Those messages come to you as an alert; send them yourself
if you choose to.

### A reply went to the wrong address

Replies go to `Reply-To` when present, otherwise `From`, and always from the address the
mail arrived at. If an agency sets a `Reply-To` you don't expect, that's why.

---

## Data

### Can I reset without losing dedupe history?

`data/submissions.jsonl` is the dedupe backbone — keep it. `messages.jsonl`,
`outbound.jsonl`, and `events.jsonl` can be truncated freely. `reqs.jsonl` holds what
you've been *pitched*; deleting it loses cross-agency duplicate detection for past reqs.

### The ledger has a corrupt line

Malformed lines are skipped and counted, not fatal. Check `logs/ledger.log`. Files are
plain JSONL — one object per line, safe to edit by hand.

### Full reset

```bash
npm run uninstall-agent -- --purge
```

Removes scheduler entries and, on confirmation, `data/` and `logs/`. Your mailbox is not
touched: archived mail stays archived and the labels remain.
