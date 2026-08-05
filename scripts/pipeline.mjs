/**
 * The per-message pipeline. Everything the agent decides about one email happens
 * here, in one readable sequence, and every branch ends with exactly one ledger
 * row so the audit trail can never disagree with what actually happened.
 *
 *   prepare -> classify -> fingerprint -> dedupe -> gate -> draft -> act -> record
 */
import { append, sentInLastHour, sentOnThread } from './ledger.mjs';
import { classify, prepareMessage } from './classify.mjs';
import { buildReqRecord, checkDuplicate, describeMatch } from './dedupe.mjs';
import { ACTIONS, decide } from './gate.mjs';
import { buildReply, buildSlots } from './templates.mjs';
import { queueReply, sendReply } from './responder.mjs';
import { notify } from './notify/index.mjs';
import * as cards from './notify/format.mjs';
import { log, logError } from './log.mjs';

/** Categories that get a requisition record and take part in dedupe. */
const REQ_CATEGORIES = new Set(['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM', 'INTERVIEW']);

/** Machine-generated bulk mail we never treat as a real recruiter conversation. */
function isBulkMail(message) {
  if (/auto-(?:replied|generated|submitted)/i.test(message.autoSubmitted || '')) return true;
  if (/\b(?:bulk|list|junk)\b/i.test(message.precedence || '')) return true;
  return false;
}

/**
 * Processes one raw message.
 *
 * @returns {{ category, action, category, outboundId?, duplicate?, skipped?: string }}
 */
export async function processMessage({ raw, transport, config, index, account, ammCorpus = [] }) {
  const message = prepareMessage(raw);
  const accountLabel = account.label || account.id;

  /* ----- cheap rejections before any work -------------------------------- */

  if (index.hasMessage(message.messageKey)) {
    return { skipped: 'already processed', category: null, action: null };
  }

  // Mail from yourself is either a sent copy or your own reply landing back in
  // the inbox. Either way there is nothing to classify.
  if (message.from && message.from === String(message.accountEmail || '').toLowerCase()) {
    index.recordMessage({ messageKey: message.messageKey, accountId: message.accountId, threadId: message.threadId });
    return { skipped: 'from self', category: null, action: null };
  }

  /* ----- classify -------------------------------------------------------- */

  const verdict = await classify(message, config);
  const { category, confidence, fields } = verdict;

  /* ----- dedupe ---------------------------------------------------------- */

  let reqRecord = null;
  let duplicate = { verdict: 'new', kind: null, score: 0, match: null, alreadySubmitted: false, sameAgency: false, reason: 'not checked' };

  if (REQ_CATEGORIES.has(category)) {
    reqRecord = buildReqRecord({ fields, message, category });
    if (config.dedupe?.enabled) {
      duplicate = checkDuplicate(
        reqRecord,
        { reqs: [...index.reqs, ...ammCorpus], submissions: index.submissions },
        config.dedupe
      );
    }
  }

  /* ----- decide ---------------------------------------------------------- */

  const decision = decide({
    category,
    confidence,
    fields,
    message,
    duplicate,
    config,
    counters: {
      sentLastHour: sentInLastHour(),
      sentOnThread: sentOnThread(message.accountId, message.threadId)
    }
  });

  /* ----- draft ----------------------------------------------------------- */

  const duplicateSummary = duplicate.match ? describeMatch(duplicate) : '';
  const slots = buildSlots({
    profile: config.profile,
    fields,
    duplicate: duplicateSummary,
    accountEmail: message.accountEmail
  });
  const draft = decision.template ? buildReply(decision.template, slots) : null;

  /* ----- act ------------------------------------------------------------- */

  let outboundId = null;
  let archived = false;
  let notified = false;

  try {
    if (decision.action === ACTIONS.ARCHIVE) {
      await transport.archive(message, config.policy?.autoArchive?.label || 'AIM/Archived');
      archived = true;
    }

    if (decision.action === ACTIONS.ALERT) {
      const html =
        category === 'INTERVIEW'
          ? cards.interviewAlert({ message, fields, accountLabel })
          : duplicate.verdict !== 'new'
            ? cards.duplicateCard({ message, fields, duplicate, summary: duplicateSummary, accountLabel })
            : cards.approvalCard({ message, fields, category, template: decision.template, reasons: decision.reasons, draft, accountLabel, confidence });

      const result = await notify(
        {
          category,
          urgent: decision.urgent,
          title: category === 'INTERVIEW' ? 'Interview request' : cards.labelFor(category),
          html,
          accountId: message.accountId
        },
        config
      );
      notified = result.delivered.length > 0 || result.held;
    }

    if (decision.action === ACTIONS.APPROVE) {
      const row = queueReply({
        message,
        category,
        template: decision.template,
        draft,
        decision,
        reqRecord,
        status: 'pending',
        accountLabel
      });
      outboundId = row.id;

      const html =
        duplicate.verdict !== 'new'
          ? `${cards.duplicateCard({ message, fields, duplicate, summary: duplicateSummary, accountLabel })}\n\n${draft?.ok ? '<b>Draft ready below.</b>' : ''}`
          : cards.approvalCard({ message, fields, category, template: decision.template, reasons: decision.reasons, draft, accountLabel, confidence });

      const result = await notify(
        {
          category,
          urgent: false,
          title: cards.labelFor(decision.template || category),
          html,
          keyboard: cards.approvalKeyboard(row.id, { hasDraft: Boolean(draft?.ok) }),
          accountId: message.accountId
        },
        config
      );
      notified = result.delivered.length > 0 || result.held;
    }

    if (decision.action === ACTIONS.AUTO_SEND) {
      if (!draft?.ok) {
        // The gate cleared it but the template cannot be filled. Downgrade to an
        // approval card rather than sending a half-rendered reply.
        const row = queueReply({
          message,
          category,
          template: decision.template,
          draft,
          decision: { ...decision, reasons: [...decision.reasons, draft?.reason || 'template could not be filled'] },
          reqRecord,
          status: 'pending',
          accountLabel
        });
        outboundId = row.id;
        await notify(
          {
            category,
            title: cards.labelFor(decision.template || category),
            html: cards.approvalCard({ message, fields, category, template: decision.template, reasons: [draft?.reason || 'template incomplete'], draft, accountLabel, confidence }),
            keyboard: cards.approvalKeyboard(row.id, { hasDraft: false }),
            accountId: message.accountId
          },
          config
        );
      } else {
        const row = queueReply({ message, category, template: decision.template, draft, decision, reqRecord, status: 'queued', accountLabel });
        outboundId = row.id;

        const sent = await sendReply({ outboundId: row.id, transport, config, reqRecord, via: 'auto' });
        if (sent.ok) {
          await notify(
            {
              category,
              title: `Auto-replied · ${cards.labelFor(decision.template)}`,
              html: cards.sentCard({ message, fields, template: decision.template, accountLabel, to: row.to }),
              accountId: message.accountId
            },
            config
          );
        } else {
          log(`pipeline: auto-send blocked at send time (${sent.reason}) — leaving for approval`, { name: 'pipeline' });
          await notify(
            {
              category,
              title: cards.labelFor(decision.template),
              html: cards.approvalCard({ message, fields, category, template: decision.template, reasons: [sent.reason], draft, accountLabel, confidence }),
              keyboard: cards.approvalKeyboard(row.id, { hasDraft: true }),
              accountId: message.accountId
            },
            config
          );
        }
      }
    }
  } catch (error) {
    logError(`pipeline action ${decision.action}`, error, { name: 'pipeline' });
    append('events', { type: 'action_failed', action: decision.action, messageKey: message.messageKey, error: String(error?.message || error).slice(0, 300) });
  }

  /* ----- record ---------------------------------------------------------- */

  const row = append('messages', {
    messageKey: message.messageKey,
    accountId: message.accountId,
    accountLabel,
    threadId: message.threadId,
    providerId: message.providerId,
    from: message.from,
    fromName: message.fromName,
    subject: message.subject,
    receivedAt: message.receivedAt,
    category,
    confidence,
    decidedBy: verdict.decidedBy,
    reason: verdict.reason,
    action: decision.action,
    template: decision.template,
    gateReasons: decision.reasons,
    blockedBy: decision.blockedBy,
    archived,
    notified,
    outboundId,
    duplicateOf: duplicate.match ? duplicate.match.fingerprint || duplicate.match.reqFingerprint || 'match' : null,
    duplicateVerdict: duplicate.verdict,
    duplicateSummary,
    fields: {
      title: fields.title,
      client: fields.client,
      agency: fields.agency,
      recruiterName: fields.recruiterName,
      location: fields.location,
      workMode: fields.workMode,
      rate: fields.rate,
      duration: fields.duration,
      employmentType: fields.employmentType
    }
  });

  index.recordMessage(row);
  if (reqRecord && duplicate.verdict === 'new') {
    const stored = append('reqs', reqRecord);
    index.recordReq(stored);
  }

  return {
    category,
    confidence,
    action: decision.action,
    template: decision.template,
    outboundId,
    archived,
    duplicate: duplicate.verdict,
    subject: message.subject
  };
}
