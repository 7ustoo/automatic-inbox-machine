#!/usr/bin/env node
/**
 * Interactive setup.
 *
 * Deliberately does not prompt for secrets. Tokens, app passwords and API keys go
 * into .env by your own hand — the wizard only checks whether they are present.
 * Typing a credential into a prompt puts it in your shell history and in this
 * process's memory for no benefit, and the file is two lines to edit.
 */
import { createInterface } from 'node:readline/promises';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_EXAMPLE_PATH, CONFIG_PATH, ROOT, ensureDirs } from './os-paths.mjs';
import { read, upsertAccount, validate, write } from './config-rw.mjs';
import { env, loadEnv, ssnLast4, ssnLast4Malformed } from './env.mjs';
import { SSN_LAST4_DISCLAIMER } from './templates.mjs';
import { createPairingLink } from './telegram-setup.mjs';
import { register } from './scheduler-register.mjs';
import { resolveAmmPath } from './amm-bridge.mjs';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const out = (text = '') => process.stdout.write(`${text}\n`);
const rule = (label) => out(`\n${label}\n${'─'.repeat(Math.max(12, label.length))}`);

async function askText(question, fallback = '') {
  const answer = (await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim();
  return answer || fallback;
}

async function askYesNo(question, defaultYes = true) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

async function askNumber(question, fallback = 0) {
  const answer = await askText(question, String(fallback));
  const value = Number(answer);
  return Number.isFinite(value) ? value : fallback;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'inbox';
}

async function main() {
  loadEnv();
  ensureDirs();

  out('');
  out('  Automatic Inbox Machine — setup');
  out('  ══════════════════════════════');
  out('');
  out('  This walks through accounts, your reply profile, and how loud the agent is');
  out('  allowed to be. Nothing is sent to anyone during setup.');

  /* ----- config file ----------------------------------------------------- */

  if (!existsSync(CONFIG_PATH)) {
    copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
    out('\n  Created config.json from the template.');
  } else {
    const overwrite = await askYesNo('\n  config.json already exists. Keep it and edit in place?', true);
    if (!overwrite) {
      copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
      out('  Reset config.json from the template.');
    }
  }

  const config = read();
  config.accounts = [];

  /* ----- accounts -------------------------------------------------------- */

  rule('1. Inboxes');
  out('  Add every address recruiters mail you at. The dedupe ledger is shared');
  out('  across all of them, which is how the same req landing in three inboxes');
  out('  gets caught.');

  const count = Math.max(1, Math.min(10, await askNumber('\n  How many inboxes?', 1)));

  for (let index = 0; index < count; index += 1) {
    out(`\n  ── Inbox ${index + 1} of ${count}`);
    const email = await askText('  Email address:');
    if (!email.includes('@')) {
      out('  That does not look like an address. Skipping.');
      continue;
    }
    const label = await askText('  Short label:', email.split('@')[0]);
    const id = slugify(await askText('  Config id (lowercase, no spaces):', slugify(label)));

    out('');
    out('   gmail — Gmail API. Best fidelity: real labels, reliable threading.');
    out('           Needs a Google Cloud OAuth client (see .env.example).');
    out('   imap  — app password. Works with Gmail, Outlook, Fastmail, custom domains.');
    const isGmail = await askYesNo('  Use the Gmail API for this inbox?', /gmail|googlemail/i.test(email));

    const account = {
      id,
      label,
      email,
      transport: isGmail ? 'gmail' : 'imap',
      enabled: true,
      pollSeconds: 45,
      replyFromName: ''
    };

    if (!isGmail) {
      const guessHost = email.split('@')[1] || '';
      account.imap = {
        host: await askText('  IMAP host:', /gmail|googlemail/i.test(guessHost) ? 'imap.gmail.com' : `imap.${guessHost}`),
        port: await askNumber('  IMAP port:', 993),
        secure: true
      };
      account.smtp = {
        host: await askText('  SMTP host:', /gmail|googlemail/i.test(guessHost) ? 'smtp.gmail.com' : `smtp.${guessHost}`),
        port: await askNumber('  SMTP port:', 465),
        secure: true
      };
      const key = `IMAP_PASSWORD_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
      out(`\n  Put the app password in .env as:  ${key}=...`);
      out(`  ${env(key) ? '  ✔ already set' : '  ⚠ not set yet'}`);
    }

    config.accounts.push(account);
  }

  write(config);

  /* ----- profile --------------------------------------------------------- */

  rule('2. Reply profile');
  out('  These fill the reply templates. Leave anything blank and the templates');
  out('  that need it stay disabled rather than sending a gap.');

  const profile = read().profile;
  profile.fullName = await askText('\n  Full name (signs every reply):', profile.fullName);
  profile.phone = await askText('  Phone:', profile.phone);
  profile.contactEmail = await askText('  Contact email for replies:', profile.contactEmail || config.accounts[0]?.email || '');
  profile.city = await askText('  City:', profile.city);
  profile.state = await askText('  State:', profile.state);
  profile.workAuth = await askText('  Work authorization (e.g. US Citizen, GC, H1B):', profile.workAuth);
  profile.availability = await askText('  Availability:', profile.availability || '2 weeks from offer');
  profile.linkedin = await askText('  LinkedIn URL:', profile.linkedin);
  profile.preferredRateHourly = await askNumber('  Your hourly rate:', profile.preferredRateHourly);

  /* ----- onboarding details ---------------------------------------------- */

  out('');
  out('  ── Onboarding details');
  out('  Recruiters ask for these to build your candidate profile. Both values live');
  out('  in .env, not config.json — config gets snapshotted into backups and');
  out('  identity data should not be copied around.');

  profile.provideDateOfBirth = await askYesNo(
    `\n  Share date of birth in onboarding replies?${env('AIM_DATE_OF_BIRTH') ? ' (value found in .env)' : ' (set AIM_DATE_OF_BIRTH in .env)'}`,
    true
  );

  out('');
  out('  SSN — last four digits');
  out('  ' + '·'.repeat(50));
  for (const line of SSN_LAST4_DISCLAIMER.split('\n')) out(`  ${line}`);
  out('  ' + '·'.repeat(50));

  if (ssnLast4Malformed()) {
    out('\n  ⚠ AIM_SSN_LAST4 is set but is not four digits. If you pasted a full SSN');
    out('    there, remove it — the full number is never sendable. Leaving this off.');
    profile.ssnLast4Acknowledged = false;
  } else if (!ssnLast4()) {
    out('\n  AIM_SSN_LAST4 is not set in .env, so there is nothing to enable yet.');
    out('  Add it later and run `/ssn confirm` in Telegram, or use the dashboard.');
    profile.ssnLast4Acknowledged = false;
  } else {
    profile.ssnLast4Acknowledged = await askYesNo('\n  Enable SSN last four in onboarding replies?', false);
    if (profile.ssnLast4Acknowledged) {
      out('  → Enabled. It is still not sent unattended unless you add ONBOARDING_INFO');
      out('    to policy.autoSend.categories — otherwise you approve each one.');
    } else {
      out('  → Left off. Those requests come to you as an alert.');
    }
  }

  out('');
  out('  Never storable and never sendable, whatever the above: full SSN, driver\'s');
  out('  licence, passport, bank or routing details.');

  /* ----- policy ---------------------------------------------------------- */

  rule('3. Policy');
  const policy = read().policy;
  policy.remoteOnly = await askYesNo('  Remote roles only?', true);
  if (policy.remoteOnly) policy.allowHybrid = await askYesNo('  Accept hybrid as remote?', false);
  policy.rateFloorHourly = await askNumber('  Hourly floor (below this becomes a decline draft, 0 disables):', policy.rateFloorHourly || 0);
  policy.autoArchive.enabled = await askYesNo('  Auto-archive rejections and application receipts?', true);

  out('');
  out('  Auto-send replies without asking first?');
  out('  Recommended: NO for the first few days. Everything becomes a one-tap');
  out('  approval in Telegram, so you see exactly what it would have said and can');
  out('  tune the thresholds before handing over the keys.');
  policy.autoSend.enabled = await askYesNo('  Enable auto-send now?', false);
  if (policy.autoSend.enabled && !profile.fullName) {
    out('  → Auto-send needs a full name to sign with. Leaving it off.');
    policy.autoSend.enabled = false;
  }
  if (policy.autoSend.enabled) {
    policy.autoSend.categories = ['RTR_REQUEST', 'RATE_CONFIRM', 'NEW_REQ'];
    out('  → Auto-send on for RTR, rate and interest replies. Interviews are never');
    out('    auto-replied, whatever this is set to.');
  }

  /* ----- classifier ------------------------------------------------------ */

  rule('4. Classifier');
  const classify = read().classify;
  out('  Rules handle the flood for free. Claude only sees what the rules cannot');
  out('  settle, which is a few cents a day at typical volume.');
  if (env('ANTHROPIC_API_KEY')) {
    classify.ai.enabled = await askYesNo('\n  ANTHROPIC_API_KEY found. Use Claude for ambiguous mail?', true);
  } else {
    out('\n  ANTHROPIC_API_KEY is not set in .env — running rules-only.');
    out('  Add it later and flip classify.ai.enabled, or use the dashboard toggle.');
    classify.ai.enabled = false;
  }

  /* ----- AMM bridge ------------------------------------------------------ */

  const ammPath = resolveAmmPath('', ROOT);
  const ammBridge = read().ammBridge;
  if (ammPath) {
    rule('5. Automatic Munyun Machine');
    out(`  Found an AMM install at ${ammPath}`);
    out('  The bridge reads the roles AMM already surfaced, read-only, as an extra');
    out('  dedupe signal. It never writes into AMM.');
    ammBridge.enabled = await askYesNo('\n  Enable the bridge?', true);
    if (ammBridge.enabled) ammBridge.path = ammPath;
  }

  const merged = read();
  merged.accounts = config.accounts;
  merged.profile = profile;
  merged.policy = policy;
  merged.classify = classify;
  merged.ammBridge = ammBridge;
  write(merged);

  /* ----- telegram -------------------------------------------------------- */

  rule('6. Telegram');
  if (!env('TG_TOKEN')) {
    out('  No TG_TOKEN in .env yet. To create a bot:');
    out('    1. Open Telegram and message @BotFather');
    out('    2. Send /newbot, pick a name and a username');
    out('    3. Copy the token into .env as TG_TOKEN=...');
    out('');
    out('  Then run `npm run dashboard` and scan the pairing QR, or just send');
    out('  /start to your new bot. You never have to look up a chat ID.');
  } else {
    const pair = await askYesNo('  Token found. Generate a pairing QR now?', true);
    if (pair) {
      const result = await createPairingLink();
      if (result.ok) {
        out('');
        out(result.qrAscii);
        out(`  Scan that, or open: ${result.link}`);
        out('  Then press Start in Telegram. Single use.');
      } else {
        out(`  Could not reach Telegram: ${result.error}`);
      }
    }
  }

  /* ----- scheduling ------------------------------------------------------ */

  rule('7. Run at startup');
  const schedule = await askYesNo('  Register the watcher, bot and watchdog to start at login?', true);
  if (schedule) {
    for (const result of register()) {
      out(`  ${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.error ? ` — ${result.error}` : ''}`);
    }
  } else {
    out('  Skipped. Run `npm run register-tasks` later, or start by hand.');
  }

  /* ----- gmail authorization --------------------------------------------- */

  const gmailAccounts = read().accounts.filter((account) => account.transport === 'gmail');
  if (gmailAccounts.length) {
    rule('8. Authorize Gmail');
    if (!env('GOOGLE_CLIENT_ID')) {
      out('  GOOGLE_CLIENT_ID is not set. Create a Desktop-app OAuth client in Google');
      out('  Cloud, enable the Gmail API, and set the app to "In production" — test');
      out('  mode expires refresh tokens every 7 days and will kill the watcher.');
      out('  Details are in .env.example.');
    } else {
      out('  Authorize each Gmail inbox with:');
      for (const account of gmailAccounts) out(`    npm run login -- ${account.id}`);
    }
  }

  /* ----- done ------------------------------------------------------------ */

  const check = validate(read());
  rule('Done');
  if (check.errors.length) {
    out('  Config errors still to fix:');
    for (const error of check.errors) out(`    ✖ ${error}`);
  }
  for (const warning of check.warnings) out(`    ⚠ ${warning}`);

  out('');
  out('  Next:');
  out('    npm run dashboard    open the console at http://127.0.0.1:7391');
  out('    npm run once         one read-only pass over new mail');
  out('    npm run watch        start the watcher');
  out('    npm run bot          start the Telegram bot');
  out('');
  out('  Start with `npm run once` and look at what it classified before turning');
  out('  auto-send on. That is the whole point of shipping it off by default.');
  out('');

  // A .env stub, if there is not one yet, so the next step is obvious.
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    writeFileSync(envPath, '# Fill these in. See .env.example for details.\nTG_TOKEN=\nANTHROPIC_API_KEY=\nGOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\n', 'utf8');
    out('  Created an empty .env for you to fill in.\n');
  }
}

main()
  .then(() => {
    rl.close();
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`\nSetup failed: ${error.message}\n`);
    rl.close();
    process.exit(1);
  });
