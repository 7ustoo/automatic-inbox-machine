/**
 * Gmail OAuth — installed-app authorization code flow with PKCE and a loopback
 * redirect. Same shape AMM uses, extended from gmail.send to gmail.modify so the
 * agent can read, label, and archive as well as reply.
 *
 * Token cache lives at data/tokens/<accountId>-token.json, gitignored.
 *
 * A note that matters operationally: if the Google Cloud OAuth app is left in
 * "Testing", refresh tokens for its test users expire after 7 days and a 24/7
 * watcher dies every week. Set the app to "In production". A public multi-user
 * release also needs Google verification for its Gmail scopes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.mjs';
import { log, resetSecretCache } from '../log.mjs';
import { ROOT, ensureDirs, tokenPath } from '../os-paths.mjs';
import { resolveAmmPath } from '../amm-bridge.mjs';
import { stripBom } from '../normalize.mjs';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send'
];

/** Refresh this many seconds before actual expiry so no request races the clock. */
const REFRESH_SKEW_SECONDS = 120;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkcePair() {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Accepts every shape a Google OAuth client arrives in: the flat
 * `{clientId, clientSecret}` AMM's CI writes, and Google Cloud's own download
 * format `{installed: {client_id, client_secret}}` (or `{web: ...}`).
 */
export function parseOAuthClientConfig(value = {}) {
  const nested = value?.installed || value?.web || {};
  return {
    clientId: String(value?.clientId || nested.client_id || '').trim(),
    clientSecret: String(value?.clientSecret || nested.client_secret || '').trim()
  };
}

const OWN_CLIENT_FILE = join(ROOT, 'scripts', 'google-oauth-client.json');

function readClientFile(path) {
  try {
    return parseOAuthClientConfig(JSON.parse(stripBom(readFileSync(path, 'utf8'))));
  } catch {
    return { clientId: '', clientSecret: '' };
  }
}

let cachedClient = null;

/**
 * Resolution order, same pattern as AMM:
 *   1. .env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
 *   2. scripts/google-oauth-client.json — CI injects this into release builds
 *      from repo secrets, exactly like AMM does
 *   3. a local AMM install's scripts/google-oauth-client.json — this app is a
 *      sibling of AMM, so a dev machine that has AMM signed in already has a
 *      working Desktop-app client sitting right there. Borrowing it is what
 *      makes "Sign in with Google" light up with zero Google Cloud setup.
 *
 * Whatever wins is exported into process.env so the log scrubber treats the
 * values as secrets from the moment they are first read.
 */
export function clientCredentials() {
  if (cachedClient) return cachedClient;

  const fromEnv = { clientId: env('GOOGLE_CLIENT_ID').trim(), clientSecret: env('GOOGLE_CLIENT_SECRET').trim() };
  let chosen = fromEnv;

  if (!chosen.clientId) {
    const own = readClientFile(OWN_CLIENT_FILE);
    if (own.clientId) chosen = own;
  }

  if (!chosen.clientId) {
    const ammRoot = resolveAmmPath('', ROOT);
    if (ammRoot) {
      const borrowed = readClientFile(join(ammRoot, 'scripts', 'google-oauth-client.json'));
      if (borrowed.clientId) {
        chosen = borrowed;
        log('gmail-oauth: using the Google OAuth client from the local AMM install', { name: 'oauth', stdout: false });
      }
    }
  }

  if (chosen.clientId) {
    if (!process.env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = chosen.clientId;
    if (chosen.clientSecret && !process.env.GOOGLE_CLIENT_SECRET) process.env.GOOGLE_CLIENT_SECRET = chosen.clientSecret;
    resetSecretCache();
    cachedClient = chosen;
  }
  return chosen;
}

export function hasClientCredentials() {
  return Boolean(clientCredentials().clientId);
}

export function buildAuthUrl({ clientId, redirectUri, challenge, state, loginHint = '' }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // Without this an account that has already consented returns no refresh
    // token, and the watcher silently loses access an hour later.
    prompt: 'consent',
    state
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Token cache                                                                */
/* -------------------------------------------------------------------------- */

export function readTokens(accountId) {
  const path = tokenPath(accountId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeTokens(accountId, tokens) {
  ensureDirs();
  const path = tokenPath(accountId);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
  return tokens;
}

export function hasTokens(accountId) {
  const tokens = readTokens(accountId);
  return Boolean(tokens?.refresh_token);
}

function storeTokenResponse(accountId, payload, previous = {}) {
  const tokens = {
    access_token: payload.access_token || previous.access_token || '',
    // Google omits refresh_token on refresh responses — keep the original.
    refresh_token: payload.refresh_token || previous.refresh_token || '',
    scope: payload.scope || previous.scope || SCOPES.join(' '),
    token_type: payload.token_type || 'Bearer',
    expiresAt: new Date(Date.now() + (Number(payload.expires_in) || 3600) * 1000).toISOString(),
    obtainedAt: new Date().toISOString()
  };
  return writeTokens(accountId, tokens);
}

/* -------------------------------------------------------------------------- */
/* Exchange and refresh                                                       */
/* -------------------------------------------------------------------------- */

async function postForm(body) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Google token endpoint refused: ${detail}`);
  }
  return payload;
}

export async function exchangeCode({ accountId, code, verifier, redirectUri }) {
  const { clientId, clientSecret } = clientCredentials();
  const payload = await postForm({
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  return storeTokenResponse(accountId, payload);
}

export async function refreshAccessToken(accountId) {
  const previous = readTokens(accountId);
  if (!previous?.refresh_token) throw new Error(`no refresh token for account "${accountId}" — run \`npm run login -- ${accountId}\``);

  const { clientId, clientSecret } = clientCredentials();
  const payload = await postForm({
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    refresh_token: previous.refresh_token,
    grant_type: 'refresh_token'
  });
  return storeTokenResponse(accountId, payload, previous);
}

/**
 * Valid bearer token for an account, refreshing when close to expiry.
 * Throws with actionable text when the account has never been authorized.
 */
export async function getAccessToken(accountId) {
  const tokens = readTokens(accountId);
  if (!tokens?.refresh_token) {
    throw new Error(`Gmail account "${accountId}" is not authorized. Run: npm run login -- ${accountId}`);
  }

  const expiresAt = Date.parse(tokens.expiresAt || '');
  const stillValid = Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_SKEW_SECONDS * 1000;
  if (stillValid && tokens.access_token) return tokens.access_token;

  const refreshed = await refreshAccessToken(accountId);
  return refreshed.access_token;
}

/* -------------------------------------------------------------------------- */
/* Interactive authorization                                                  */
/* -------------------------------------------------------------------------- */

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Google account connected</title>
<style>body{font:15px/1.6 system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
.card{max-width:32rem;padding:2rem;border:1px solid #30363d;border-radius:12px;background:#161b22}
h1{font-size:1.1rem;margin:0 0 .5rem}.ok{color:#7ee787}p{margin-bottom:0}</style>
<div class="card"><h1><span class="ok">✓</span> Google account connected</h1><p>Return to Automatic Inbox Machine. You can close this tab.</p></div>
<script>setTimeout(()=>window.close(),1800)</script>`;

const FAILURE_PAGE = `<!doctype html><meta charset="utf-8"><title>Authorization failed</title>
<style>body{font:15px/1.6 system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
.card{max-width:32rem;padding:2rem;border:1px solid #f85149;border-radius:12px;background:#161b22}</style>
<div class="card"><h1>Google connection wasn’t completed</h1><p>Return to Automatic Inbox Machine and try again.</p></div>`;

/**
 * Runs the full interactive flow: spins a loopback server, prints the URL,
 * waits for the redirect, exchanges the code. Resolves with the stored tokens.
 */
export async function authorizeAccount({ accountId, email = '', timeoutMs = 30 * 60 * 1000, onUrl } = {}) {
  const { clientId } = clientCredentials();
  if (!clientId) {
    throw new Error('No Google OAuth client available. Release builds bundle one; on a dev checkout, install automatic-munyun-machine alongside this repo or set GOOGLE_CLIENT_ID in .env.');
  }

  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(16));

  return new Promise((resolve, reject) => {
    let port = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(value);
    };

    const server = createServer(async (request, response) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/' && url.pathname !== '/oauth2callback') {
        response.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (error || !code) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE);
        finish(new Error(`authorization denied: ${error || 'no code returned'}`));
        return;
      }
      if (returnedState !== state) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE);
        finish(new Error('state mismatch — aborting, this could be a forged callback'));
        return;
      }

      try {
        const redirectUri = `http://127.0.0.1:${port}`;
        const tokens = await exchangeCode({ accountId, code, verifier, redirectUri });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_PAGE);
        log(`gmail-oauth: authorized account "${accountId}"`, { name: 'oauth' });
        finish(null, tokens);
      } catch (exchangeError) {
        response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE);
        finish(exchangeError);
      }
    });

    const timer = setTimeout(() => finish(new Error('authorization timed out before Google sign-in finished — try again from the app')), timeoutMs);

    server.on('error', (serverError) => finish(serverError));
    server.listen(0, '127.0.0.1', () => {
      const { port: bound } = server.address();
      port = bound;
      const url = buildAuthUrl({ clientId, redirectUri: `http://127.0.0.1:${port}`, challenge, state, loginHint: email });
      if (typeof onUrl === 'function') onUrl(url);
      else {
        process.stdout.write(`\nOpen this URL to authorize ${email || accountId}:\n\n${url}\n\nWaiting for the redirect...\n`);
      }
    });
  });
}

/* -------------------------------------------------------------------------- */
/* CLI: npm run login -- <accountId>                                          */
/* -------------------------------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gmail-oauth.mjs')) {
  const accountId = process.argv[2];
  if (!accountId) {
    process.stderr.write('usage: npm run login -- <accountId>\n');
    process.exit(1);
  }
  const { read } = await import('../config-rw.mjs');
  const account = (read().accounts || []).find((candidate) => candidate.id === accountId);
  if (!account) {
    process.stderr.write(`no account "${accountId}" in config.json\n`);
    process.exit(1);
  }
  try {
    await authorizeAccount({ accountId, email: account.email });
    process.stdout.write(`\nDone. "${accountId}" is authorized.\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`\nFailed: ${error.message}\n`);
    process.exit(1);
  }
}
