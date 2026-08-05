/**
 * Telegram pairing — the part that removes the worst of the onboarding friction.
 *
 * Creating the bot still means a trip to @BotFather; that is Telegram's rule and
 * nothing here can change it. What this removes is the chat-ID scavenger hunt,
 * which is the step that actually confuses people. The dashboard renders a QR
 * code for a t.me deep link carrying a one-time nonce; scanning it on the phone
 * opens the bot, and the /start payload binds the chat automatically.
 */
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { getMe } from './telegram-api.mjs';
import { env } from './env.mjs';
import { read, setMany } from './config-rw.mjs';
import { issuePairingNonce } from './state.mjs';
import { log, maskChatId } from './log.mjs';

/** Confirms the token works and returns the bot identity. */
export async function validateToken() {
  if (!env('TG_TOKEN').trim()) {
    return { ok: false, error: 'TG_TOKEN is not set in .env' };
  }
  const me = await getMe();
  if (!me.ok) return { ok: false, error: me.error };
  return {
    ok: true,
    id: me.result.id,
    username: me.result.username,
    name: me.result.first_name,
    link: `https://t.me/${me.result.username}`
  };
}

/**
 * Issues a fresh pairing link plus a QR code for it.
 * Returns { ok, link, qrDataUrl, qrAscii, nonce, username }.
 */
export async function createPairingLink() {
  const identity = await validateToken();
  if (!identity.ok) return identity;

  const nonce = randomBytes(9).toString('base64url');
  issuePairingNonce(nonce);

  const link = `https://t.me/${identity.username}?start=${nonce}`;
  const [qrDataUrl, qrAscii] = await Promise.all([
    QRCode.toDataURL(link, { margin: 1, width: 320, errorCorrectionLevel: 'M' }),
    QRCode.toString(link, { type: 'terminal', small: true })
  ]);

  log(`telegram-setup: issued pairing link for @${identity.username}`, { name: 'setup' });
  return { ok: true, link, qrDataUrl, qrAscii, nonce, username: identity.username };
}

export function pairingStatus() {
  const config = read();
  const chatId = config.notify?.telegram?.chatId || '';
  return {
    tokenPresent: Boolean(env('TG_TOKEN').trim()),
    paired: Boolean(chatId),
    chatIdMasked: chatId ? maskChatId(chatId) : '',
    enabled: Boolean(config.notify?.telegram?.enabled)
  };
}

export function unpair() {
  setMany({ 'notify.telegram.chatId': '', 'notify.telegram.enabled': false });
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] && /telegram-setup\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const subcommand = process.argv[2] || 'pair';

  if (subcommand === 'status') {
    process.stdout.write(`${JSON.stringify(pairingStatus(), null, 2)}\n`);
    process.exit(0);
  }

  if (subcommand === 'unpair') {
    unpair();
    process.stdout.write('Unpaired. Send /start to the bot again to re-pair.\n');
    process.exit(0);
  }

  const result = await createPairingLink();
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    process.exit(1);
  }
  process.stdout.write(
    [
      '',
      `Bot: @${result.username}`,
      '',
      result.qrAscii,
      '',
      'Scan that with your phone, or open this link and press Start:',
      result.link,
      '',
      'The link is single-use and expires once claimed.',
      ''
    ].join('\n')
  );
  process.exit(0);
}
