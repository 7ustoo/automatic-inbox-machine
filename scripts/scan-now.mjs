/** On-demand, seven-day inbox catch-up. Historical mail only creates review drafts. */
import { append, find, LedgerIndex, readAll } from './ledger.mjs';
import { classify, prepareMessage } from './classify.mjs';
import { buildReqRecord, checkDuplicate, describeMatch } from './dedupe.mjs';
import { ACTIONS, decide, isVerificationEmail } from './gate.mjs';
import { buildReply, buildSlots } from './templates.mjs';
import { queueReply } from './responder.mjs';
import { createTransport } from './transports/index.mjs';
import { logError } from './log.mjs';
import { clearScanActive, markScanActive, touchScanActive } from './scan-marker.mjs';

const REPLYABLE = new Set(['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM']);
let current = { running: false, phase: 'idle', checked: 0, drafts: 0, jobAlerts: 0,
  skipped: 0, errors: [], accountsDone: 0, accountsTotal: 0, startedAt: '', finishedAt: '' };

export function scanStatus() { return { ...current, errors: [...current.errors] }; }

/** Start in the dashboard process so the button can show live progress. */
export function startScan(config, { transportFactory = createTransport } = {}) {
  if (current.running) return { ok: false, error: 'A scan is already running.' };
  if (config.paused) return { ok: false, error: 'Resume AIM before scanning.' };
  if (config.policy?.interviewAlertsOnly === true) {
    return { ok: false, error: 'Choose Review replies or Auto-reply before scanning.' };
  }
  const accounts = (config.accounts || []).filter((account) => account.enabled !== false);
  if (!accounts.length) return { ok: false, error: 'Enable an inbox before scanning.' };
  if (!markScanActive()) return { ok: false, error: 'A scan is already running.' };
  current = { running: true, phase: 'listing', checked: 0, drafts: 0, jobAlerts: 0,
    skipped: 0, errors: [], accountsDone: 0, accountsTotal: accounts.length,
    startedAt: new Date().toISOString(), finishedAt: '' };
  void runScan(config, accounts, transportFactory).catch((error) => {
    logError('seven-day scan', error, { name: 'scan' });
    current.errors.push(String(error?.message || error).slice(0, 250));
    current.phase = 'failed';
    current.running = false;
    current.finishedAt = new Date().toISOString();
    clearScanActive();
  });
  return { ok: true, status: scanStatus() };
}

async function runScan(config, accounts, transportFactory) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const index = LedgerIndex.load();
  const priorByProvider = new Map(index.messages
    .filter((row) => row.providerId)
    .map((row) => [`${row.accountId}:${row.providerId}`, row]));
  const outboundKeys = new Set(readAll('outbound').map((row) => row.messageKey).filter(Boolean));
  // Reuse the normal decision rules, but do not send, notify, move, or label
  // historical mail regardless of whether Auto-reply is selected.
  const reviewConfig = {
    ...config,
    policy: { ...config.policy, interviewAlertsOnly: false,
      autoSend: { ...config.policy?.autoSend, enabled: false },
      autoArchive: { ...config.policy?.autoArchive, enabled: false },
      approvals: { ...config.policy?.approvals, enabled: true } }
  };

  for (const account of accounts) {
    const transport = transportFactory(account);
    try {
      await transport.connect();
      const ids = await transport.listRecentIds({ since });
      current.phase = 'scanning';
      for (const id of ids) {
        touchScanActive();
        try {
          const providerId = typeof id === 'object' ? String(id.uid) : String(id);
          const prior = priorByProvider.get(`${account.id}:${providerId}`);
          if (prior?.receivedAt && String(prior.receivedAt) < since) continue;
          if (prior && !(prior.action === 'ignore' && prior.blockedBy === 'interview alerts only')) {
            if (prior.category === 'JOB_ALERT') current.jobAlerts += 1;
            else current.skipped += 1;
            current.checked += 1;
            continue;
          }

          const raw = await transport.getMessage(id);
          if (!raw || String(raw.receivedAt || raw.date || '') < since) continue;
          current.checked += 1;
          const message = prepareMessage(raw);
          if (outboundKeys.has(message.messageKey) ||
              message.from === String(message.accountEmail || '').toLowerCase() ||
              isVerificationEmail(message)) {
            current.skipped += 1;
            continue;
          }
          const verdict = await classify(message, reviewConfig);
          const { category, confidence, fields } = verdict;
          if (category === 'JOB_ALERT') { current.jobAlerts += 1; continue; }
          if (!REPLYABLE.has(category)) { current.skipped += 1; continue; }

          const reqRecord = buildReqRecord({ fields, message, category });
          const duplicate = config.dedupe?.enabled
            ? checkDuplicate(reqRecord, { reqs: index.reqs, submissions: index.submissions }, config.dedupe)
            : { verdict: 'new' };
          const slots = buildSlots({ profile: config.profile, fields,
            duplicate: describeMatch(duplicate), accountEmail: message.accountEmail });
          const decision = decide({ category, confidence, fields, message, duplicate,
            config: reviewConfig, slots, decidedBy: verdict.decidedBy });
          if (decision.action !== ACTIONS.APPROVE) { current.skipped += 1; continue; }
          if (find('outbound', (row) => row.messageKey === message.messageKey)) {
            current.skipped += 1;
            continue;
          }

          const draft = buildReply(decision.template, slots, config.replyTemplates || {});
          const row = queueReply({ message, category, template: decision.template, draft,
            decision: { ...decision, reasons: ['Found in the seven-day scan', ...decision.reasons],
              blockedBy: null },
            reqRecord, summary: verdict.summary, status: 'pending', accountLabel: account.label || account.id });
          outboundKeys.add(message.messageKey);
          current.drafts += 1;

          if (!prior) {
            const stored = append('messages', {
              messageKey: message.messageKey, accountId: message.accountId,
              accountLabel: account.label || account.id, threadId: message.threadId,
              gmailThreadId: message.gmailThreadId || '', rfcMessageId: message.rfcMessageId || '',
              providerId: message.providerId, from: message.from, fromName: message.fromName,
              subject: message.subject, receivedAt: message.receivedAt,
              category, confidence, decidedBy: verdict.decidedBy, reason: verdict.reason,
              summary: verdict.summary || '', action: ACTIONS.APPROVE, template: decision.template,
              outboundId: row.id, archived: false, notified: false,
              duplicateVerdict: duplicate.verdict, fields
            });
            index.recordMessage(stored);
          }
          if (duplicate.verdict === 'new' && !index.reqs.some((req) => req.messageKey === message.messageKey)) {
            index.recordReq(append('reqs', reqRecord));
          }
        } catch (error) {
          logError(`seven-day scan ${account.id}`, error, { name: 'scan' });
          current.errors.push(`${account.label || account.id}: ${String(error?.message || error).slice(0, 160)}`);
          current.skipped += 1;
        }
      }
    } catch (error) {
      logError(`seven-day scan inbox ${account.id}`, error, { name: 'scan' });
      current.errors.push(`${account.label || account.id}: ${String(error?.message || error).slice(0, 160)}`);
    } finally {
      await transport.disconnect().catch(() => {});
      current.accountsDone += 1;
    }
  }
  current.running = false;
  current.phase = current.errors.length ? 'finished-with-errors' : 'complete';
  current.finishedAt = new Date().toISOString();
  clearScanActive();
}
