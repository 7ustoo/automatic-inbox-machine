/**
 * Turns transport errors into something a person can act on.
 *
 * The raw strings are useless to the user who will actually see them. An IMAP
 * server rejecting an app password reports "Command failed"; Gmail reports
 * "Invalid credentials (Failure)". Neither tells someone that 2-Step
 * Verification has to be on before an App Password can even be created — which is
 * the actual cause the overwhelming majority of the time.
 *
 * Deliberately conservative: anything unrecognised passes through unchanged
 * rather than being replaced with a confident guess. A wrong explanation is worse
 * than an opaque one, because it sends the user off fixing the wrong thing.
 */

const RULES = [
  {
    match: /invalid credentials|authentication fail|auth.*(?:fail|reject)|login fail|\[AUTHENTICATIONFAILED\]|command failed/i,
    message:
      'The mail server rejected the password. For Gmail, Yahoo, Outlook and iCloud you need an App Password, not your normal login password — and 2-Step Verification has to be switched on before you can create one.'
  },
  {
    match: /application-specific password|app password required/i,
    message: 'This account requires an app-specific password. Create one in your provider’s security settings and paste that instead.'
  },
  {
    match: /imap access is disabled|imap.*not enabled|\[ALERT\].*IMAP/i,
    message: 'IMAP access is switched off for this mailbox. Enable it in your mail provider’s settings, then test again.'
  },
  {
    match: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    message: 'That server hostname could not be found. Check the IMAP host under server settings — a typo here is the usual cause.'
  },
  {
    match: /ECONNREFUSED/i,
    message: 'The server refused the connection. The host is reachable but not on that port — check the IMAP port (993 for TLS).'
  },
  {
    match: /ETIMEDOUT|ESOCKETTIMEDOUT|timed? out/i,
    message: 'The connection timed out. Either the server is unreachable from here, or a firewall is blocking the port.'
  },
  {
    match: /self.signed certificate|unable to verify|CERT_|DEPTH_ZERO/i,
    message: 'The server’s TLS certificate could not be verified. That is expected for some self-hosted mail servers and a red flag for anything else.'
  },
  {
    match: /no IMAP password for account/i,
    message: 'No password stored for this inbox yet. Use Update password to add one.'
  },
  {
    match: /is not authorized|no refresh token/i,
    message: 'This Gmail account has not been authorized yet. Use Authorize to grant access.'
  },
  {
    match: /invalid_grant/i,
    message:
      'Google rejected the saved authorization. This is what happens when the OAuth app is still in "Testing" — those tokens expire after 7 days. Set the app to "In production" in Google Cloud, then authorize again.'
  },
  {
    match: /insufficient.*(?:permission|scope)|ACCESS_TOKEN_SCOPE/i,
    message: 'The Google authorization is missing the scopes this needs. Authorize again and accept all requested permissions.'
  },
  {
    match: /rate.?limit|too many|429|quota/i,
    message: 'The provider is rate-limiting us. It will retry on its own with a longer gap; nothing for you to do.'
  },
  {
    match: /Proton Bridge|127\.0\.0\.1:1143/i,
    message: 'Proton only exposes IMAP through Proton Bridge, which has to be running on this machine.'
  }
];

/**
 * @param raw the original error message
 * @returns { message, original, translated } — `message` is safe to show a user
 */
export function friendlyError(raw) {
  const original = String(raw || '').trim();
  if (!original) return { message: '', original: '', translated: false };

  for (const rule of RULES) {
    if (rule.match.test(original)) {
      return { message: rule.message, original, translated: true };
    }
  }
  return { message: original, original, translated: false };
}

/** One-line form for logs and compact UI: the explanation plus the raw cause. */
export function friendlyErrorLine(raw) {
  const { message, original, translated } = friendlyError(raw);
  if (!translated) return message;
  return `${message} (${original.slice(0, 120)})`;
}
