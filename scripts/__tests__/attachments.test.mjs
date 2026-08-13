import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyMime } from '../transports/gmail.mjs';

test('Gmail replies become multipart MIME and carry the resume bytes', () => {
  const mime = buildReplyMime({
    fromEmail: 'candidate@example.com', fromName: 'Candidate', to: 'recruiter@example.com',
    subject: 'Re: Remote role', body: 'I am interested.', inReplyTo: '<original@example.com>',
    attachments: [{ filename: 'Candidate Resume.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-test') }],
    boundary: 'aim_test_boundary'
  });
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="aim_test_boundary"/);
  assert.match(mime, /Content-Disposition: attachment; filename="Candidate Resume\.pdf"/);
  assert.match(mime, new RegExp(Buffer.from('%PDF-test').toString('base64')));
  assert.match(mime, /In-Reply-To: <original@example\.com>/);
  assert.match(mime, /--aim_test_boundary--/);
});

test('decline-style plain replies remain simple text MIME when there is no attachment', () => {
  const mime = buildReplyMime({ fromEmail: 'a@example.com', to: 'b@example.com', subject: 'Re: X', body: 'No thanks.' });
  assert.match(mime, /Content-Type: text\/plain/);
  assert.doesNotMatch(mime, /multipart\/mixed/);
});
