import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, decide, inQuietHours } from '../gate.mjs';
import { withDefaults } from '../config-rw.mjs';

const NEW_REQ = { verdict: 'new', kind: null, score: 0, match: null, alreadySubmitted: false, sameAgency: false, reason: 'no prior match' };

function config(overrides = {}) {
  return withDefaults({
    profile: { fullName: 'Justin Williams', preferredRateHourly: 80 },
    policy: {
      remoteOnly: true,
      minConfidence: 0.85,
      autoSend: { enabled: true, categories: ['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM'], maxPerHour: 12, maxPerThread: 2 },
      autoArchive: { enabled: true, categories: ['REJECTION', 'ACK', 'JOB_ALERT', 'NEWSLETTER'], label: 'AIM/Archived' },
      approvals: { enabled: true, expireHours: 24 }
    },
    ...overrides
  });
}

const remoteFields = { workMode: 'remote', rate: { kind: 'hourly', min: 90, max: 95, raw: '$90/hr' }, title: 'Engineer' };
const message = { from: 'r@agency.com', subject: 'Remote role', body: 'Location: Remote. Rate: $90/hr' };

test('a clean remote req above floor auto-sends when every gate passes', () => {
  const result = decide({ category: 'NEW_REQ', confidence: 0.95, fields: remoteFields, message, duplicate: NEW_REQ, config: config() });
  assert.equal(result.action, ACTIONS.AUTO_SEND);
  assert.equal(result.template, 'NEW_REQ');
});

test('auto-send off routes everything to approval', () => {
  const settings = config();
  settings.policy.autoSend.enabled = false;
  const result = decide({ category: 'NEW_REQ', confidence: 0.99, fields: remoteFields, message, duplicate: NEW_REQ, config: settings });
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /autoSend\.enabled/);
});

test('low confidence blocks auto-send', () => {
  const result = decide({ category: 'NEW_REQ', confidence: 0.5, fields: remoteFields, message, duplicate: NEW_REQ, config: config() });
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /confidence/);
});

test('interviews are always escalated and never auto-replied', () => {
  const result = decide({ category: 'INTERVIEW', confidence: 0.99, fields: remoteFields, message, duplicate: NEW_REQ, config: config() });
  assert.equal(result.action, ACTIONS.ALERT);
  assert.equal(result.urgent, true);
  assert.equal(result.template, null);
});

test('rejections are archived, never answered', () => {
  const result = decide({ category: 'REJECTION', confidence: 0.95, fields: {}, message, duplicate: NEW_REQ, config: config() });
  assert.equal(result.action, ACTIONS.ARCHIVE);
  assert.equal(result.archive, true);
});

test('archive is skipped when autoArchive is off', () => {
  const settings = config();
  settings.policy.autoArchive.enabled = false;
  const result = decide({ category: 'ACK', confidence: 0.95, fields: {}, message, duplicate: NEW_REQ, config: settings });
  assert.equal(result.action, ACTIONS.IGNORE);
  assert.equal(result.archive, false);
});

test('remote-only archives an onsite role without replying', () => {
  const result = decide({
    category: 'NEW_REQ',
    confidence: 0.95,
    fields: { ...remoteFields, workMode: 'onsite' },
    message,
    duplicate: NEW_REQ,
    config: config()
  });
  assert.equal(result.action, ACTIONS.ARCHIVE);
  assert.equal(result.template, null);
  assert.equal(result.blockedBy, 'work-location preference');
});

test('remote-only archives hybrid, while remote + hybrid keeps it', () => {
  const strict = decide({ category: 'NEW_REQ', confidence: 0.95, fields: { ...remoteFields, workMode: 'hybrid' }, message, duplicate: NEW_REQ, config: config() });
  assert.equal(strict.action, ACTIONS.ARCHIVE);
  assert.equal(strict.template, null);

  const permissive = config();
  permissive.policy.allowHybrid = true;
  const relaxed = decide({ category: 'NEW_REQ', confidence: 0.95, fields: { ...remoteFields, workMode: 'hybrid' }, message, duplicate: NEW_REQ, config: permissive });
  assert.equal(relaxed.template, 'NEW_REQ');
});

test('all-locations mode keeps onsite opportunities', () => {
  const settings = config();
  settings.policy.workLocationMode = 'all';
  const result = decide({ category: 'NEW_REQ', confidence: 0.95, fields: { ...remoteFields, workMode: 'onsite' }, message, duplicate: NEW_REQ, config: settings });
  assert.equal(result.action, ACTIONS.AUTO_SEND);
  assert.equal(result.template, 'NEW_REQ');
});

test('a below-floor rate swaps in the rate decline', () => {
  const settings = config();
  settings.policy.rateFloorHourly = 75;
  const result = decide({
    category: 'NEW_REQ',
    confidence: 0.95,
    fields: { ...remoteFields, rate: { kind: 'hourly', min: 45, max: 45, raw: '$45/hr' } },
    message,
    duplicate: NEW_REQ,
    config: settings
  });
  assert.equal(result.template, 'DECLINE_RATE');
});

test('an unstated work mode blocks auto-send under remoteOnly', () => {
  const result = decide({ category: 'NEW_REQ', confidence: 0.99, fields: { ...remoteFields, workMode: 'unknown' }, message, duplicate: NEW_REQ, config: config() });
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /work mode unknown/);
});

test('a request for SSN or ID is never auto-answered', () => {
  const result = decide({
    category: 'RATE_CONFIRM',
    confidence: 0.99,
    fields: remoteFields,
    message: { ...message, body: 'Please send the last 4 digits of your SSN and your date of birth.' },
    duplicate: NEW_REQ,
    config: config()
  });
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /SSN/i);
});

test('a duplicate is surfaced, not answered, by default', () => {
  const duplicate = { verdict: 'duplicate', kind: 'fingerprint', score: 1, match: { titleRaw: 'X', agencyRaw: 'Y' }, alreadySubmitted: true, sameAgency: false, reason: 'identical' };
  const result = decide({ category: 'NEW_REQ', confidence: 0.99, fields: remoteFields, message, duplicate, config: config() });
  assert.equal(result.template, 'DUPLICATE');
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /autoReplyToDuplicates/);
});

test('a client collision always needs a human', () => {
  const collision = { verdict: 'client_collision', kind: 'client_window', score: 0.5, match: { clientRaw: 'Schwab' }, alreadySubmitted: true, sameAgency: false, reason: 'existing activity' };
  const result = decide({ category: 'NEW_REQ', confidence: 0.99, fields: remoteFields, message, duplicate: collision, config: config() });
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /same end client/);
});

test('paused stops everything except interview alerts', () => {
  const paused = config({ paused: true });
  const req = decide({ category: 'NEW_REQ', confidence: 0.99, fields: remoteFields, message, duplicate: NEW_REQ, config: paused });
  assert.equal(req.action, ACTIONS.IGNORE);

  const interview = decide({ category: 'INTERVIEW', confidence: 0.99, fields: remoteFields, message, duplicate: NEW_REQ, config: paused });
  assert.equal(interview.action, ACTIONS.ALERT);
});

test('blocklisted domains are dropped', () => {
  const settings = config();
  settings.policy.blocklistDomains = ['agency.com'];
  const result = decide({ category: 'NEW_REQ', confidence: 0.99, fields: remoteFields, message, duplicate: NEW_REQ, config: settings });
  assert.equal(result.action, ACTIONS.IGNORE);
  assert.equal(result.blockedBy, 'blocklist');
});

test('a no-reply address can never receive a generated response', () => {
  const result = decide({
    category: 'NEW_REQ',
    confidence: 0.99,
    fields: remoteFields,
    message: { ...message, from: 'no-reply@ats.example' },
    duplicate: NEW_REQ,
    config: config()
  });
  assert.equal(result.action, 'ignore');
  assert.equal(result.template, null);
  assert.match(result.blockedBy, /no-reply/);
});

test('volume caps block auto-send', () => {
  const hourly = decide({ category: 'NEW_REQ', confidence: 0.99, fields: remoteFields, message, duplicate: NEW_REQ, config: config(), counters: { sentLastHour: 12 } });
  assert.match(hourly.blockedBy, /hourly send cap/);

  const thread = decide({ category: 'NEW_REQ', confidence: 0.99, fields: remoteFields, message, duplicate: NEW_REQ, config: config(), counters: { sentOnThread: 2 } });
  assert.match(thread.blockedBy, /this thread/);
});

test('an empty fullName refuses to send unsigned mail', () => {
  const settings = config();
  settings.profile.fullName = '';
  const result = decide({ category: 'NEW_REQ', confidence: 0.99, fields: remoteFields, message, duplicate: NEW_REQ, config: settings });
  assert.equal(result.action, ACTIONS.APPROVE);
});

test('a specifically requested missing profile field prevents blind auto-send', () => {
  const fields = { ...remoteFields, requestedProfileFields: ['linkedin'] };
  const result = decide({
    category: 'NEW_REQ', confidence: 0.99, fields, message, duplicate: NEW_REQ,
    config: config(), slots: { requestedMissingFields: ['linkedin'] }
  });
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /linkedin/);
});

test('quiet hours wrap midnight correctly', () => {
  const settings = withDefaults({ policy: { quietHours: { enabled: true, start: '23:00', end: '07:00', timezone: 'UTC' } } });
  assert.equal(inQuietHours(settings, new Date('2026-08-05T23:30:00Z')), true);
  assert.equal(inQuietHours(settings, new Date('2026-08-05T02:00:00Z')), true);
  assert.equal(inQuietHours(settings, new Date('2026-08-05T12:00:00Z')), false);
  assert.equal(inQuietHours(settings, new Date('2026-08-05T07:00:00Z')), false);
});

test('quiet hours inside a single day do not wrap', () => {
  const settings = withDefaults({ policy: { quietHours: { enabled: true, start: '09:00', end: '17:00', timezone: 'UTC' } } });
  assert.equal(inQuietHours(settings, new Date('2026-08-05T12:00:00Z')), true);
  assert.equal(inQuietHours(settings, new Date('2026-08-05T20:00:00Z')), false);
});

test('quiet hours off is always false', () => {
  assert.equal(inQuietHours(withDefaults({}), new Date('2026-08-05T03:00:00Z')), false);
});
