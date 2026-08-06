/**
 * IMAP/SMTP host guesses by email domain.
 *
 * Setup asking someone for their IMAP hostname is asking the wrong person a
 * question they cannot answer. The overwhelming majority of inboxes are on one of
 * a dozen providers, so guess, show the guess, and let it be corrected.
 *
 * Deliberately not autodiscovery-over-the-network: no DNS SRV lookups, no
 * Thunderbird ISPDB fetch. A local-first mail agent should not phone a third
 * party to find out where your mail lives, and a static table covers the cases.
 */

const PROVIDERS = [
  {
    match: /^(gmail\.com|googlemail\.com)$/i,
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    note: 'Needs 2-Step Verification enabled, then an App Password (not your normal password). If Google says app passwords are "not available for your account", 2-Step Verification is off — use Sign in with Google instead, which needs neither.'
  },
  {
    match: /^(outlook\.com|hotmail\.com|live\.com|msn\.com|passport\.com)$/i,
    label: 'Outlook / Hotmail',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    appPasswordUrl: 'https://account.microsoft.com/security',
    note: 'Personal Microsoft accounts need an app password created under Security → Advanced security options.'
  },
  {
    match: /^(yahoo\.[a-z.]+|ymail\.com|rocketmail\.com)$/i,
    label: 'Yahoo',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    note: 'Yahoo requires an app password; your normal password will be rejected.'
  },
  {
    match: /^(aol\.com)$/i,
    label: 'AOL',
    imap: { host: 'imap.aol.com', port: 993, secure: true },
    smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    appPasswordUrl: 'https://login.aol.com/account/security',
    note: 'Requires an app password.'
  },
  {
    match: /^(icloud\.com|me\.com|mac\.com)$/i,
    label: 'iCloud',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    appPasswordUrl: 'https://appleid.apple.com/account/manage',
    note: 'Create an app-specific password at appleid.apple.com.'
  },
  {
    match: /^(fastmail\.(com|fm)|messagingengine\.com)$/i,
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    appPasswordUrl: 'https://app.fastmail.com/settings/security/apppasswords',
    note: 'Create an app password with Mail (IMAP/SMTP) access.'
  },
  {
    match: /^(zoho\.(com|eu))$/i,
    label: 'Zoho Mail',
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    appPasswordUrl: 'https://accounts.zoho.com/home#security/apppassword',
    note: 'Generate an application-specific password.'
  },
  {
    match: /^(gmx\.[a-z.]+|mail\.com)$/i,
    label: 'GMX',
    imap: { host: 'imap.gmx.com', port: 993, secure: true },
    smtp: { host: 'mail.gmx.com', port: 587, secure: false },
    appPasswordUrl: '',
    note: 'IMAP access must be enabled in your GMX settings first.'
  },
  {
    match: /^(proton\.me|protonmail\.com|pm\.me)$/i,
    label: 'Proton Mail',
    imap: { host: '127.0.0.1', port: 1143, secure: false },
    smtp: { host: '127.0.0.1', port: 1025, secure: false },
    appPasswordUrl: 'https://proton.me/mail/bridge',
    note: 'Proton only exposes IMAP through Proton Bridge, which must be running locally. Requires a paid plan.'
  },
  {
    match: /^(yandex\.[a-z.]+)$/i,
    label: 'Yandex',
    imap: { host: 'imap.yandex.com', port: 993, secure: true },
    smtp: { host: 'smtp.yandex.com', port: 465, secure: true },
    appPasswordUrl: '',
    note: 'Enable IMAP in Yandex Mail settings.'
  }
];

export function emailDomainOf(address) {
  // The optional trailing '>' matters: addresses arrive as
  // `Raj <raj@apex.com>` from mail headers, and anchoring on end-of-string
  // without allowing it silently returned no domain at all.
  const match = String(address || '').toLowerCase().match(/@([^\s>@]+)>?\s*$/);
  return match ? match[1].replace(/[.,;>]+$/, '') : '';
}

/**
 * Best guess for an address.
 *
 * @returns {{ provider, imap, smtp, appPasswordUrl, note, guessed, supportsGmailApi }}
 */
export function guessMailHosts(address) {
  const domain = emailDomainOf(address);
  if (!domain) {
    return { provider: '', imap: null, smtp: null, appPasswordUrl: '', note: '', guessed: false, supportsGmailApi: false, domain: '' };
  }

  for (const provider of PROVIDERS) {
    if (provider.match.test(domain)) {
      return {
        provider: provider.label,
        domain,
        imap: { ...provider.imap },
        smtp: { ...provider.smtp },
        appPasswordUrl: provider.appPasswordUrl,
        note: provider.note,
        guessed: true,
        supportsGmailApi: /^(gmail\.com|googlemail\.com)$/i.test(domain)
      };
    }
  }

  // Custom domain. imap.<domain> / smtp.<domain> is the near-universal
  // convention and is right often enough to be a useful starting point — and it
  // is presented as a guess to be corrected, not as fact.
  return {
    provider: '',
    domain,
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    smtp: { host: `smtp.${domain}`, port: 465, secure: true },
    appPasswordUrl: '',
    note: `No known settings for ${domain}. These are the conventional hostnames — check them against your provider's documentation, then use Test to confirm.`,
    guessed: false,
    supportsGmailApi: false
  };
}

/** Turns an address into a config-safe account id: "jus7o.dev@gmail.com" -> "jus7o-dev". */
export function accountIdFor(address, taken = []) {
  const base =
    String(address || '')
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'inbox';

  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}
