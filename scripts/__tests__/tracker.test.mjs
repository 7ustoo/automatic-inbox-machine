import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationTracker, isApplicationReceipt } from '../application-tracker.mjs';
import { interviewTracker, isResearchCandidate, lookupInterviewPosting, parseResearchResponse, updateTelegramInterviewAlert } from '../interview-research.mjs';
import { emailJobWorkMode, interviewBrief } from '../interview-brief.mjs';
import { maybeSendTrackerDigest, trackerDigestMessage } from '../tracker-digest.mjs';

const now = Date.parse('2026-10-21T18:00:00Z');
const base = { receivedAt: '2026-10-21T17:00:00Z', accountId: 'mail', from: 'jobs@example.com', fromName: 'Example', fields: {} };

test('application counts only confirmation emails and leaves codes and status updates out', () => {
  const rows = [
    { ...base, id: 'receipt', category: 'ACK', subject: 'We received your application for Engineer' },
    { ...base, id: 'code', category: 'ACK', subject: 'Security code for your application' },
    { ...base, id: 'update', category: 'ACK', subject: 'Update on your application' },
    { ...base, id: 'reject', category: 'REJECTION', subject: 'Thank you for your application' }
  ];
  assert.equal(isApplicationReceipt(rows[0]), true);
  const tracker = applicationTracker({ rows, now });
  assert.equal(tracker.last24h, 1);
  assert.equal(tracker.last7d, 1);
  assert.equal(tracker.byEmailWorkMode7d.unknown, 1);
});

test('interview tracker groups reminders and catches an explicitly missed invitation', () => {
  const messages = [
    { ...base, id: 'first', category: 'INTERVIEW', subject: 'Turo - Interview Availability', from: 'recruiter@turo.com',
      fields: { client: 'Turo', title: 'Turo - Interview Availability' }, summary: 'A call to discuss the Senior Security Engineer position.' },
    { ...base, id: 'reminder', category: 'INTERVIEW', subject: 'Reminder - Your Interview with Turo', from: 'recruiter@turo.com',
      fields: { client: 'Turo' }, summary: 'Please book an interview time.' },
    { ...base, id: 'missed', category: 'ACK', subject: 'Interview Request - Systems Administrator Application | Trace3 Gov',
      from: 'recruiter@trace3.com', fields: { client: 'Trace3' }, summary: 'Please schedule an interview for the Systems Administrator position.' },
    { ...base, id: 'receipt', category: 'INTERVIEW', subject: 'Thank you for your application to NVIDIA', summary: 'Application received.' }
  ];
  assert.equal(isResearchCandidate(messages[2]), true);
  const result = interviewTracker({ messages, research: [], now });
  assert.equal(result.total, 2);
  assert.deepEqual(result.rows.map((row) => row.title).sort(), ['Senior Security Engineer', 'Systems Administrator']);
});

test('web results must cite the exact job link, ignoring search tracking parameters', () => {
  const payload = { output: [
    { type: 'web_search_call', action: { sources: [{ url: 'https://careers.example.com/jobs/123?utm_source=openai' }] } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ exactRoleMatch: true, workMode: 'remote',
      postingUrl: 'https://careers.example.com/jobs/123', location: 'Remote US', sourceType: 'employer', evidence: 'Posting says remote.' }) }] }
  ] };
  const found = parseResearchResponse(payload);
  assert.equal(found.status, 'verified');
  assert.equal(found.workMode, 'remote');
  assert.equal(found.postingUrl, 'https://careers.example.com/jobs/123');
  payload.output[1].content[0].text = payload.output[1].content[0].text.replace('/123', '/999');
  assert.equal(parseResearchResponse(payload).status, 'unknown');
});

test('posting lookup sends only role metadata and runs one bounded web search', async () => {
  const row = { ...base, category: 'INTERVIEW', subject: 'Interview for Cloud Engineer',
    fields: { title: 'Cloud Engineer', client: 'Example' }, body: 'PRIVATE EMAIL BODY' };
  let request;
  const fakeFetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output: [
      { type: 'web_search_call', action: { sources: [{ url: 'https://example.com/jobs/123' }] } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ exactRoleMatch: true, workMode: 'hybrid',
        postingUrl: 'https://example.com/jobs/123', location: 'Chicago', sourceType: 'employer', evidence: 'Three office days.' }) }] }
    ] }) };
  };
  const result = await lookupInterviewPosting(row, { apiKey: 'test-key', fetchImpl: fakeFetch });
  assert.equal(result.workMode, 'hybrid');
  assert.equal(request.store, false);
  assert.equal(request.tools[0].type, 'web_search');
  assert.equal(request.tools[0].search_context_size, 'low');
  assert.equal(request.input.includes('PRIVATE EMAIL BODY'), false);
});

test('today counts follow Central calendar day and count distinct new interview roles', () => {
  const late = Date.parse('2026-10-22T02:30:00Z'); // 9:30 p.m. Central on October 21
  const previous = Date.parse('2026-10-21T04:30:00Z'); // 11:30 p.m. Central on October 20
  const rows = [
    { ...base, id: 'yesterday', receivedAt: new Date(previous).toISOString(), category: 'ACK', subject: 'We received your application' },
    { ...base, id: 'today', receivedAt: new Date(late).toISOString(), category: 'ACK', subject: 'We received your application' }
  ];
  assert.equal(applicationTracker({ rows, now: late + 60_000 }).today, 1);
  const messages = [
    { ...base, id: 'first', receivedAt: new Date(previous).toISOString(), category: 'INTERVIEW', subject: 'Interview for Engineer', fields: { client: 'Example', title: 'Engineer' } },
    { ...base, id: 'reminder', receivedAt: new Date(late).toISOString(), category: 'INTERVIEW', subject: 'Interview reminder for Engineer', fields: { client: 'Example', title: 'Engineer' } },
    { ...base, id: 'new', receivedAt: new Date(late).toISOString(), category: 'INTERVIEW', subject: 'Interview for Designer', fields: { client: 'Other', title: 'Designer' } }
  ];
  const tracked = interviewTracker({ messages, research: [], now: late + 60_000 });
  assert.equal(tracked.total, 2);
  assert.equal(tracked.today.total, 1);
});

test('nightly tracker sends once at 10 p.m. Central and retries a failed send', async () => {
  const config = { notify: { trackerDigest: { enabled: true } } };
  const atTen = Date.parse('2026-10-22T03:05:00Z');
  let marked = '';
  let sent = 0;
  const options = {
    isAvailable: () => true, getLastSent: () => marked, markSent: (date) => { marked = date; },
    getApplications: () => ({ today: 3, last7d: 22 }),
    getInterviews: () => ({ today: { total: 1, counts: { remote: 1 } }, total: 5, counts: { remote: 2, unknown: 3 } }),
    retryIntervalMs: 0,
    sender: async () => { sent += 1; return { ok: sent > 1, error: 'offline' }; }
  };
  assert.equal(await maybeSendTrackerDigest(config, { ...options, now: atTen - 3_600_000 }), false);
  assert.equal(await maybeSendTrackerDigest(config, { ...options, now: atTen }), false);
  assert.equal(marked, '');
  assert.equal(await maybeSendTrackerDigest(config, { ...options, now: atTen }), true);
  assert.equal(marked, '2026-10-21');
  assert.equal(await maybeSendTrackerDigest(config, { ...options, now: atTen }), false);
  assert.equal(sent, 2);
  marked = '';
  assert.equal(await maybeSendTrackerDigest(config, { ...options, now: atTen + 3_600_000 }), true);
  assert.equal(marked, '2026-10-21');
  assert.match(trackerDigestMessage({ date: marked, applications: { today: 3, last7d: 22 },
    interviews: { today: { total: 1, counts: { remote: 1 } }, total: 5, counts: { remote: 2, unknown: 3 } } }),
  /Application confirmation emails: <b>3<\/b>/);
});

test('interview brief separates direct scheduling from a vague interview mention', () => {
  assert.equal(interviewBrief({ subject: 'Interview Request', summary: 'Please choose a time to speak.' }).kind, 'scheduling');
  assert.equal(interviewBrief({ subject: 'Application update', summary: 'We considered your interview feedback.' }).kind, 'unclear');
  assert.equal(interviewBrief({ subject: 'One-way video screening' }).kind, 'screening');
});

test('a remote interview does not prove the job is remote', () => {
  assert.equal(emailJobWorkMode({ fields: { workMode: 'remote' }, subject: 'Remote interview for Engineer' }), 'unknown');
  assert.equal(emailJobWorkMode({ fields: { workMode: 'remote' }, summary: 'The role is fully remote.' }), 'remote');
});

test('verified posting edits the existing Telegram alert and preserves the email button', async () => {
  const config = { accounts: [{ id: 'mail', email: 'jobs@gmail.com', transport: 'gmail' }],
    notify: { telegram: { enabled: true, chatId: '123' } } };
  const identity = { key: 'example|engineer', title: 'Engineer', company: 'Example' };
  const messages = [{ ...base, accountId: 'mail', category: 'INTERVIEW', threadId: '19c123abc456def0',
    subject: 'Interview for Engineer', interviewRoleTitle: 'Engineer', fields: { client: 'Example', title: 'Engineer' },
    telegramMessageId: 77, summary: 'Please choose an interview time.' }];
  let edited;
  await updateTelegramInterviewAlert(config, identity, { status: 'verified', workMode: 'onsite',
    note: 'Employer posting says five days in office.', postingUrl: 'https://example.com/jobs/42', location: 'Chicago' },
  { messages, editor: async (...args) => { edited = args; return { ok: true }; } });
  assert.equal(edited[0], '123');
  assert.equal(edited[1], 77);
  assert.match(edited[2], /On site/);
  assert.match(edited[2], /verified in a matching posting/);
  assert.equal(edited[3].keyboard.length, 2);
  assert.match(edited[3].keyboard[0][0].url, /#all\/19c123abc456def0$/);
});
