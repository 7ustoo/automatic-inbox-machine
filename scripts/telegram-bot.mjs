#!/usr/bin/env node
/**
 * The Telegram bot: alerts you can act on, plus a chat interface to the ledger.
 *
 * Long-polls getUpdates, so it works from behind NAT with no public URL and no
 * webhook — the reason Telegram beats Slack for a local-first install.
 *
 * Access control: exactly one chat id may drive this bot. Pairing happens either
 * through a QR deep link carrying a one-time nonce (issued by the dashboard) or,
 * on a fresh install with no chat id yet, the first /start. Anything from any
 * other chat is dropped and logged — the bot holds your mailbox, so a stranger
 * who guesses the bot name must not be able to read a single row.
 */
import { readFileSync } from 'node:fs';
import { createTransport } from './transports/index.mjs';
import { read, set, setMany, addToArray } from './config-rw.mjs';
import { editReply, getOutbound, sendReply, skipReply } from './responder.mjs';
import { findOutboundReq } from './req-lookup.mjs';
import { pendingApprovals, readAll, rowsSince, stats } from './ledger.mjs';
import { activeChannels } from './notify/index.mjs';
import * as cards from './notify/format.mjs';
import { ask } from './ask.mjs';
import { buildRunners } from './accounts.mjs';
import { consumePairingNonce, getTelegramOffset, heartbeatAgeSeconds, setTelegramOffset } from './state.mjs';
import { installCrashGuards, log, logError, maskChatId } from './log.mjs';
import { answerCallback, editMessage, escapeHtml, getMe, getUpdates, isConfigured, sendMessage, sendTyping, setCommands } from './telegram-api.mjs';
import { dateOfBirth, loadEnv, ssnLast4, ssnLast4Malformed } from './env.mjs';
import { ensureDirs } from './os-paths.mjs';
import { SSN_LAST4_DISCLAIMER, buildSlots, templateReadiness } from './templates.mjs';

const COMMANDS = [
  { command: 'status', description: 'Account health, channels, paused state' },
  { command: 'today', description: "Today's inbox summary" },
  { command: 'stats', description: 'Stats over a window, e.g. /stats 168' },
  { command: 'pending', description: 'Drafts waiting for your call' },
  { command: 'interviews', description: 'Recent interview requests' },
  { command: 'subs', description: 'Submissions on record' },
  { command: 'dupes', description: 'Duplicate and collision flags' },
  { command: 'pause', description: 'Stop all sending immediately' },
  { command: 'resume', description: 'Re-enable sending' },
  { command: 'autosend', description: 'autosend on | off' },
  { command: 'remote', description: 'remote on | off' },
  { command: 'floor', description: 'Set hourly rate floor, e.g. /floor 70' },
  { command: 'block', description: 'Block a sender domain' },
  { command: 'dob', description: 'dob on | off — share date of birth' },
  { command: 'ssn', description: 'SSN last four: status, confirm, or off' },
  { command: 'templates', description: 'Which reply templates are ready' },
  { command: 'digest', description: 'Send the digest now' },
  { command: 'help', description: 'Command list' }
];

/** chatId -> outboundId awaiting replacement text from the Edit button. */
const awaitingEdit = new Map();

/* -------------------------------------------------------------------------- */
/* Access control                                                             */
/* -------------------------------------------------------------------------- */

function authorize(config, chatId, text) {
  const configured = String(config.notify?.telegram?.chatId || '');
  const incoming = String(chatId);

  if (configured && configured === incoming) return { ok: true, paired: true };

  const startMatch = /^\/start(?:@\w+)?\s+(\S+)/.exec(String(text || ''));
  if (startMatch && consumePairingNonce(startMatch[1])) {
    setMany({ 'notify.telegram.chatId': incoming, 'notify.telegram.enabled': true });
    log(`bot: paired with chat ${maskChatId(incoming)} via nonce`, { name: 'bot' });
    return { ok: true, justPaired: true };
  }

  // Fresh install convenience: the first /start claims the bot.
  if (!configured && /^\/start\b/.test(String(text || ''))) {
    setMany({ 'notify.telegram.chatId': incoming, 'notify.telegram.enabled': true });
    log(`bot: paired with chat ${maskChatId(incoming)} (first /start, no nonce)`, { name: 'bot' });
    return { ok: true, justPaired: true };
  }

  return { ok: false };
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

function version() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '?';
  }
}

async function statusText(config) {
  const runners = buildRunners(config);
  const health = [];
  for (const runner of runners) {
    const result = await runner.health();
    await runner.close();
    health.push(result);
  }

  const age = heartbeatAgeSeconds();
  const watcherState = age === Infinity ? 'never started' : age < 180 ? `alive (${age}s ago)` : `STALE — last beat ${Math.round(age / 60)}m ago`;
  const summary = stats(24);

  const lines = [
    `<b>Inbox agent v${escapeHtml(version())}</b>`,
    '',
    `Watcher: ${escapeHtml(watcherState)}`,
    `Sending: <b>${config.paused ? 'PAUSED' : config.policy?.autoSend?.enabled ? 'auto-send ON' : 'approval only'}</b>`,
    `Channels: ${escapeHtml(activeChannels(config).join(', ') || 'none')}`,
    `Classifier: ${config.classify?.ai?.enabled ? escapeHtml(config.classify.ai.model) : 'rules only'}`,
    '',
    `<b>Accounts (${health.length})</b>`
  ];

  for (const account of health) {
    lines.push(
      `${account.ok ? '🟢' : '🔴'} <b>${escapeHtml(account.label)}</b> · ${escapeHtml(account.transport)}` +
        (account.lastSyncAt ? ` · synced ${escapeHtml(String(account.lastSyncAt).slice(11, 16))}Z` : ' · never synced') +
        (account.error ? `\n   ${escapeHtml(account.error.slice(0, 120))}` : '')
    );
  }

  lines.push(
    '',
    `<b>Last 24h</b>: ${summary.processed} processed · ${summary.archived} archived · ${summary.sent} replied · ${summary.pending} waiting`
  );
  return lines.join('\n');
}

function pendingText(config) {
  const rows = pendingApprovals({ expireHours: config.policy?.approvals?.expireHours || 24 });
  if (!rows.length) return 'Nothing waiting on you. 🎉';
  return [
    `<b>${rows.length} draft${rows.length === 1 ? '' : 's'} waiting</b>`,
    '',
    ...rows.map(
      (row, index) =>
        `${index + 1}. ${cards.icon(row.category)} <b>${escapeHtml(row.fields?.title || row.originalSubject || 'Untitled')}</b>\n` +
        `   ${escapeHtml(cards.labelFor(row.template))} → ${escapeHtml(row.to)}\n` +
        `   held: ${escapeHtml(String(row.blockedBy || row.reasons?.[0] || 'awaiting approval').slice(0, 90))}`
    ),
    '',
    'Each one has its own card above with Send / Edit / Skip. Scroll up, or /pending after new mail arrives.'
  ].join('\n');
}

function listInterviews(hours = 24 * 14) {
  const rows = rowsSince('messages', hours).filter((row) => row.category === 'INTERVIEW');
  if (!rows.length) return `No interview requests in the last ${Math.round(hours / 24)} days.`;
  return [
    `🚨 <b>${rows.length} interview request${rows.length === 1 ? '' : 's'}</b> (last ${Math.round(hours / 24)}d)`,
    '',
    ...rows
      .slice(-15)
      .reverse()
      .map(
        (row) =>
          `• <b>${escapeHtml(row.fields?.title || row.subject || 'Untitled')}</b>\n` +
          `  ${escapeHtml(row.fields?.agency || row.from)} · ${escapeHtml(String(row.ts).slice(0, 10))}` +
          (row.fields?.client ? ` · ${escapeHtml(row.fields.client)}` : '')
      )
  ].join('\n');
}

function listSubmissions(filterText = '') {
  const needle = filterText.trim().toLowerCase();
  let rows = readAll('submissions');
  if (needle) {
    rows = rows.filter(
      (row) =>
        String(row.clientRaw || '').toLowerCase().includes(needle) ||
        String(row.agencyRaw || '').toLowerCase().includes(needle) ||
        String(row.titleRaw || '').toLowerCase().includes(needle)
    );
  }
  if (!rows.length) return needle ? `No submissions matching "${escapeHtml(needle)}".` : 'No submissions on record yet.';
  return [
    `<b>${rows.length} submission${rows.length === 1 ? '' : 's'}</b>${needle ? ` matching "${escapeHtml(needle)}"` : ''}`,
    '',
    ...rows
      .slice(-20)
      .reverse()
      .map(
        (row) =>
          `• <b>${escapeHtml(row.titleRaw || 'Untitled')}</b>\n` +
          `  ${escapeHtml(row.clientRaw || 'client not named')} via ${escapeHtml(row.agencyRaw || row.recruiterEmail)}\n` +
          `  ${escapeHtml(String(row.submittedAt).slice(0, 10))} · ${escapeHtml(row.accountId)}`
      )
  ].join('\n');
}

function listDupes(hours = 24 * 30) {
  const rows = rowsSince('messages', hours).filter((row) => row.duplicateVerdict && row.duplicateVerdict !== 'new');
  if (!rows.length) return 'No duplicates or client collisions flagged.';
  const collisions = rows.filter((row) => row.duplicateVerdict === 'client_collision');
  return [
    `♻️ <b>${rows.length} flagged</b> · ${collisions.length} client collision${collisions.length === 1 ? '' : 's'}`,
    '',
    ...rows
      .slice(-15)
      .reverse()
      .map(
        (row) =>
          `${row.duplicateVerdict === 'client_collision' ? '⚠️' : '♻️'} <b>${escapeHtml(row.fields?.title || row.subject)}</b>\n` +
          `  ${escapeHtml(row.duplicateSummary || row.duplicateVerdict)}\n` +
          `  from ${escapeHtml(row.fields?.agency || row.from)} · ${escapeHtml(String(row.ts).slice(0, 10))}`
      )
  ].join('\n');
}

function helpText() {
  return [
    `<b>Inbox agent v${escapeHtml(version())}</b>`,
    '',
    'I watch your inboxes, answer the routine recruiter mail, archive the rejection noise, and shout when someone wants to interview you.',
    '',
    '<b>Reading</b>',
    '/status — accounts, channels, watcher health',
    '/today — the last 24 hours',
    '/stats 168 — any window, in hours',
    '/pending — drafts waiting on you',
    '/interviews — recent interview requests',
    '/subs [client] — submissions on record',
    '/dupes — duplicates and client collisions',
    '/templates — which replies can be filled',
    '',
    '<b>Control</b>',
    '/pause · /resume — stop or restart all sending',
    '/autosend on|off — reply without asking',
    '/remote on|off — remote-only filter',
    '/floor 70 — hourly rate floor',
    '/block example.com — blocklist a domain',
    '/dob on|off — share date of birth in onboarding replies',
    '/ssn — SSN last four: read the rundown, then confirm or leave off',
    '/digest — send the digest now',
    '',
    '<b>Or just ask</b>',
    'How many reqs this week? Who submitted me to Deloitte? What did you archive today?'
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Callback handling                                                          */
/* -------------------------------------------------------------------------- */

async function transportForOutbound(config, row) {
  const account = (config.accounts || []).find((candidate) => candidate.id === row.accountId);
  if (!account) throw new Error(`account "${row.accountId}" is no longer in config.json`);
  const transport = createTransport(account);
  await transport.connect();
  return transport;
}

async function handleCallback(update, config) {
  const callback = update.callback_query;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = String(callback.data || '');
  const [action, outboundId] = data.split(':');

  const row = getOutbound(outboundId);
  if (!row) {
    await answerCallback(callback.id, 'That draft is gone from the ledger.', { alert: true });
    return;
  }

  if (action === 'skp') {
    skipReply(outboundId, 'skipped from Telegram');
    await answerCallback(callback.id, 'Skipped.');
    await editMessage(chatId, messageId, `⏭ <b>Skipped</b> · ${escapeHtml(cards.labelFor(row.template))}\n\n${escapeHtml(row.fields?.title || row.originalSubject || '')}`);
    return;
  }

  if (action === 'blk') {
    const domain = String(row.originalFrom || '').split('@')[1];
    if (domain) addToArray('policy.blocklistDomains', domain.toLowerCase());
    skipReply(outboundId, 'sender blocked');
    await answerCallback(callback.id, domain ? `Blocked ${domain}.` : 'No domain to block.');
    await editMessage(chatId, messageId, `🚫 <b>Blocked ${escapeHtml(domain || 'sender')}</b> · draft skipped.`);
    return;
  }

  if (action === 'edt') {
    awaitingEdit.set(String(chatId), outboundId);
    await answerCallback(callback.id, 'Send me the replacement text.');
    await sendMessage(
      chatId,
      [
        `✏️ <b>Editing reply to ${escapeHtml(row.to)}</b>`,
        '',
        'Send the full replacement body as your next message. It will be queued, not sent, so you can review it again.',
        '',
        'Current draft:',
        `<pre>${escapeHtml(String(row.body || '').slice(0, 1500))}</pre>`,
        '',
        'Send /cancel to leave it alone.'
      ].join('\n')
    );
    return;
  }

  if (action === 'snd') {
    if (row.status === 'sent') {
      await answerCallback(callback.id, 'Already sent.', { alert: true });
      return;
    }
    await answerCallback(callback.id, 'Sending…');
    try {
      const transport = await transportForOutbound(config, row);
      const reqRecord = findOutboundReq(row);
      const result = await sendReply({ outboundId, transport, config, reqRecord, via: 'manual' });
      await transport.disconnect();

      if (result.ok) {
        await editMessage(
          chatId,
          messageId,
          [`✅ <b>Sent</b> · ${escapeHtml(cards.labelFor(row.template))}`, '', `To: ${escapeHtml(row.to)}`, `<b>${escapeHtml(row.fields?.title || row.originalSubject || '')}</b>`].join('\n')
        );
      } else {
        await editMessage(chatId, messageId, `⚠️ <b>Not sent</b>: ${escapeHtml(result.reason)}\n\nThe draft is still in /pending.`);
      }
    } catch (error) {
      logError('bot send callback', error, { name: 'bot' });
      await editMessage(chatId, messageId, `⚠️ <b>Send failed</b>: ${escapeHtml(String(error?.message || error).slice(0, 200))}`);
    }
    return;
  }

  await answerCallback(callback.id, 'Unknown button.');
}

/* -------------------------------------------------------------------------- */
/* Command handling                                                           */
/* -------------------------------------------------------------------------- */

async function handleText(chatId, text, config) {
  const trimmed = String(text || '').trim();

  // An in-progress edit swallows the next message, unless it is /cancel.
  if (awaitingEdit.has(String(chatId))) {
    const outboundId = awaitingEdit.get(String(chatId));
    awaitingEdit.delete(String(chatId));
    if (/^\/cancel\b/i.test(trimmed)) {
      await sendMessage(chatId, 'Edit cancelled — the original draft is untouched.');
      return;
    }
    const updated = editReply(outboundId, trimmed);
    if (!updated) {
      await sendMessage(chatId, 'That draft can no longer be edited (already sent or gone).');
      return;
    }
    await sendMessage(
      chatId,
      [`✏️ <b>Draft updated</b> · to ${escapeHtml(updated.to)}`, '', `<pre>${escapeHtml(updated.body.slice(0, 1500))}</pre>`].join('\n'),
      { keyboard: cards.approvalKeyboard(outboundId, { hasDraft: true }) }
    );
    return;
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@[\w_]+$/, '');
  const argument = rest.join(' ');

  switch (command) {
    case '/start':
    case '/help':
      await sendMessage(chatId, helpText());
      return;

    case '/status':
      await sendMessage(chatId, await statusText(config));
      return;

    case '/today': {
      const summary = stats(24);
      const interviews = rowsSince('messages', 24).filter((row) => row.category === 'INTERVIEW');
      await sendMessage(chatId, cards.digestCard({ stats: summary, pending: summary.pending, interviews }));
      return;
    }

    case '/stats': {
      const hours = Math.max(1, Math.min(24 * 365, Number(argument) || 24));
      const summary = stats(hours);
      const interviews = rowsSince('messages', hours).filter((row) => row.category === 'INTERVIEW');
      await sendMessage(
        chatId,
        cards.digestCard({ stats: summary, pending: summary.pending, interviews, windowLabel: `the last ${hours}h` })
      );
      return;
    }

    case '/pending':
      await sendMessage(chatId, pendingText(config));
      return;

    case '/interviews':
      await sendMessage(chatId, listInterviews(Number(argument) ? Number(argument) * 24 : 24 * 14));
      return;

    case '/subs':
    case '/submissions':
      await sendMessage(chatId, listSubmissions(argument));
      return;

    case '/dupes':
    case '/duplicates':
      await sendMessage(chatId, listDupes());
      return;

    case '/pause':
      set('paused', true);
      await sendMessage(chatId, '⏸ <b>Paused.</b> Nothing will be sent or archived until /resume. Interview alerts still come through.');
      return;

    case '/resume':
      set('paused', false);
      await sendMessage(chatId, '▶️ <b>Resumed.</b>');
      return;

    case '/autosend': {
      const value = argument.toLowerCase();
      if (value !== 'on' && value !== 'off') {
        await sendMessage(chatId, `Auto-send is <b>${config.policy?.autoSend?.enabled ? 'ON' : 'OFF'}</b>. Use /autosend on or /autosend off.`);
        return;
      }
      if (value === 'on' && !config.profile?.fullName) {
        await sendMessage(chatId, '⚠️ Set <code>profile.fullName</code> in config.json first — I will not send unsigned mail.');
        return;
      }
      set('policy.autoSend.enabled', value === 'on');
      await sendMessage(
        chatId,
        value === 'on'
          ? '⚡ <b>Auto-send ON.</b> RTR, rate and interest replies will go out without asking, when every gate passes. Interviews are still never auto-replied.'
          : '🛑 <b>Auto-send OFF.</b> Everything routes to approval.'
      );
      return;
    }

    case '/remote': {
      const value = argument.toLowerCase();
      if (value !== 'on' && value !== 'off') {
        await sendMessage(chatId, `Remote-only is <b>${config.policy?.remoteOnly ? 'ON' : 'OFF'}</b>. Use /remote on or /remote off.`);
        return;
      }
      set('policy.remoteOnly', value === 'on');
      await sendMessage(chatId, `Remote-only is now <b>${value === 'on' ? 'ON' : 'OFF'}</b>.`);
      return;
    }

    case '/floor': {
      const value = Number(argument);
      if (!Number.isFinite(value) || value < 0) {
        await sendMessage(chatId, `Hourly floor is <b>$${config.policy?.rateFloorHourly || 0}</b>. Set it with /floor 70.`);
        return;
      }
      set('policy.rateFloorHourly', value);
      await sendMessage(chatId, `Hourly floor set to <b>$${value}</b>. Anything below gets a decline draft instead of interest.`);
      return;
    }

    case '/block': {
      const domain = argument.trim().toLowerCase().replace(/^.*@/, '');
      if (!domain || !domain.includes('.')) {
        const current = config.policy?.blocklistDomains || [];
        await sendMessage(chatId, current.length ? `Blocked domains:\n${current.map((entry) => `• ${escapeHtml(entry)}`).join('\n')}` : 'No blocked domains. Use /block example.com');
        return;
      }
      addToArray('policy.blocklistDomains', domain);
      await sendMessage(chatId, `🚫 Blocked <b>${escapeHtml(domain)}</b>.`);
      return;
    }

    case '/dob': {
      const present = Boolean(dateOfBirth());
      const value = argument.toLowerCase();
      if (value !== 'on' && value !== 'off') {
        await sendMessage(
          chatId,
          [
            `Date of birth sharing is <b>${config.profile?.provideDateOfBirth === false ? 'OFF' : 'ON'}</b>.`,
            present ? 'A value is set in .env.' : '⚠️ No value set — add <code>AIM_DATE_OF_BIRTH</code> to .env.',
            '',
            'Recruiters routinely need it for VMS and background-check paperwork. Use /dob on or /dob off.'
          ].join('\n')
        );
        return;
      }
      set('profile.provideDateOfBirth', value === 'on');
      await sendMessage(
        chatId,
        value === 'on'
          ? `Date of birth will be included in onboarding replies.${present ? '' : ' Set <code>AIM_DATE_OF_BIRTH</code> in .env — nothing to send until you do.'}`
          : 'Date of birth will not be included. Those requests come to you instead.'
      );
      return;
    }

    case '/ssn': {
      const value = argument.toLowerCase();
      const acknowledged = config.profile?.ssnLast4Acknowledged === true;
      const present = Boolean(ssnLast4());

      if (value === 'confirm' || value === 'on') {
        if (ssnLast4Malformed()) {
          await sendMessage(
            chatId,
            '⚠️ <b>AIM_SSN_LAST4 is not four digits.</b>\n\nIf you pasted a full SSN there, remove it — the full number is never sendable. Put only the last four, then run /ssn confirm again.'
          );
          return;
        }
        if (!present) {
          await sendMessage(chatId, 'Nothing to confirm — <code>AIM_SSN_LAST4</code> is not set in .env. Add the four digits there first, then /ssn confirm.');
          return;
        }
        set('profile.ssnLast4Acknowledged', true);
        await sendMessage(
          chatId,
          [
            '✅ <b>SSN last four is now enabled.</b>',
            '',
            'It will be included when a recruiter asks for onboarding details. It is still not auto-<i>sent</i> unless you also add <code>ONBOARDING_INFO</code> to <code>policy.autoSend.categories</code> — otherwise you get an approval card and see exactly what goes out.',
            '',
            'Turn it back off any time with /ssn off.'
          ].join('\n')
        );
        return;
      }

      if (value === 'off') {
        set('profile.ssnLast4Acknowledged', false);
        await sendMessage(chatId, '🛑 <b>SSN last four disabled.</b> Those requests come to you as an alert instead.');
        return;
      }

      await sendMessage(
        chatId,
        [
          `<b>SSN last four</b> — currently <b>${acknowledged && present ? 'ENABLED' : 'DISABLED'}</b>`,
          `Value in .env: ${ssnLast4Malformed() ? '⚠️ set but not four digits' : present ? 'set' : 'not set'}`,
          `Acknowledged: ${acknowledged ? 'yes' : 'no'}`,
          '',
          escapeHtml(SSN_LAST4_DISCLAIMER),
          '',
          'Enable with <b>/ssn confirm</b>. Disable with <b>/ssn off</b>.'
        ].join('\n')
      );
      return;
    }

    case '/templates': {
      const slots = buildSlots({ profile: config.profile, fields: {}, accountEmail: config.accounts?.[0]?.email || '' });
      const rows = templateReadiness(slots);
      await sendMessage(
        chatId,
        [
          '<b>Template readiness</b>',
          '',
          ...rows.map((row) => `${row.ready ? '✅' : '⚠️'} ${escapeHtml(row.label)}${row.ready ? '' : ` — needs ${escapeHtml(row.missing.join(', '))}`}`),
          '',
          'Missing slots come from <code>profile</code> in config.json.'
        ].join('\n')
      );
      return;
    }

    case '/digest': {
      const summary = stats(24);
      const interviews = rowsSince('messages', 24).filter((row) => row.category === 'INTERVIEW');
      await sendMessage(chatId, cards.digestCard({ stats: summary, pending: summary.pending, interviews }));
      return;
    }

    case '/cancel':
      await sendMessage(chatId, 'Nothing to cancel.');
      return;

    default:
      break;
  }

  if (command.startsWith('/')) {
    await sendMessage(chatId, `Unknown command ${escapeHtml(command)}. /help for the list.`);
    return;
  }

  // Anything else is a question for the ledger.
  await sendTyping(chatId);
  const result = await ask(trimmed);
  await sendMessage(chatId, escapeHtml(result.answer));
}

/* -------------------------------------------------------------------------- */
/* Main loop                                                                  */
/* -------------------------------------------------------------------------- */

async function main() {
  loadEnv();
  ensureDirs();
  installCrashGuards('bot');

  if (!isConfigured()) {
    process.stderr.write(
      [
        'TG_TOKEN is not set.',
        '',
        'Create a bot: open Telegram, message @BotFather, send /newbot, and put the',
        'token in .env as TG_TOKEN=...  Then run `npm run dashboard` and scan the QR',
        'code, or just send /start to your bot.',
        ''
      ].join('\n')
    );
    process.exit(1);
  }

  const me = await getMe();
  if (!me.ok) {
    process.stderr.write(`Telegram rejected the token: ${me.error}\n`);
    process.exit(1);
  }
  log(`bot: running as @${me.result?.username}`, { name: 'bot' });
  await setCommands(COMMANDS);

  let offset = getTelegramOffset();
  let backoffMs = 0;

  const shutdown = () => {
    log('bot: shutting down', { name: 'bot' });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  for (;;) {
    const updates = await getUpdates(offset);

    if (!updates.ok) {
      // Exponential backoff on transient failures so a Telegram outage does not
      // turn into a tight retry loop against their API.
      backoffMs = Math.min(60000, backoffMs ? backoffMs * 2 : 2000);
      log(`bot: getUpdates failed (${updates.error}) — retrying in ${backoffMs}ms`, { name: 'bot' });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    backoffMs = 0;

    for (const update of updates.result || []) {
      offset = update.update_id + 1;
      setTelegramOffset(offset);

      try {
        const config = read();
        const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
        const text = update.message?.text || '';

        const auth = authorize(config, chatId, text);
        if (!auth.ok) {
          log(`bot: dropped update from unauthorized chat ${maskChatId(chatId)}`, { name: 'bot' });
          if (update.callback_query) await answerCallback(update.callback_query.id, 'Not your bot.');
          continue;
        }

        if (auth.justPaired) {
          await sendMessage(
            chatId,
            [
              '✅ <b>Paired.</b> This chat now controls your inbox agent.',
              '',
              'I will message you when a recruiter wants to interview you, when a new remote req lands, and when the same role shows up twice.',
              '',
              helpText()
            ].join('\n')
          );
          if (/^\/start/.test(text)) continue;
        }

        if (update.callback_query) {
          await handleCallback(update, read());
          continue;
        }

        if (text) await handleText(chatId, text, read());
      } catch (error) {
        logError('bot update', error, { name: 'bot' });
      }
    }
  }
}

const invokedDirectly = process.argv[1] && /telegram-bot\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    logError('bot fatal', error, { name: 'bot' });
    process.exit(1);
  });
}

export { authorize, helpText, listDupes, listInterviews, listSubmissions, pendingText };
