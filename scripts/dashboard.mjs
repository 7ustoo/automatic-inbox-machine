#!/usr/bin/env node
/**
 * Localhost dashboard.
 *
 * Node serves it directly — there is no Go wrapper here, unlike AMM. The wrapper
 * in AMM exists for a tray icon and process supervision; this app gets
 * supervision from the platform scheduler plus watchdog.mjs, so adding a second
 * language and a build step would buy a tray icon and cost every user a Go
 * toolchain. Same browser UI, one fewer thing to break.
 *
 * Security posture: bound to 127.0.0.1 only, and every state-changing POST needs
 * a per-process CSRF token that is injected into the page at render time. That
 * stops a random web page you have open from POSTing to your agent.
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { READ_ENDPOINTS, action, version } from './dashboard-api.mjs';
import { read } from './config-rw.mjs';
import { registerSelf } from './state.mjs';
import { PORT_FILE, ROOT, TOKEN_FILE, ensureDirs } from './os-paths.mjs';
import { installCrashGuards, log, logError } from './log.mjs';
import { loadEnv } from './env.mjs';

const CSRF_TOKEN = randomBytes(24).toString('hex');

/**
 * A second token, written to disk for local trusted callers — specifically the
 * desktop wrapper's tray menu, which needs to pause and resume the agent.
 *
 * The CSRF token exists to stop a random web page POSTing to this server, and it
 * only works because it is injected into the page and never leaves the browser.
 * That makes it unavailable to a sibling process. This token solves the other
 * problem: proving local ownership. It is written 0600, so possession of the file
 * already means the reader is this user, which is the whole claim being made.
 */
const LOCAL_TOKEN = randomBytes(24).toString('hex');

const WEB_DIR = join(ROOT, 'scripts', 'web');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

function serveShell(response) {
  let html = readFileSync(join(WEB_DIR, 'dashboard.html'), 'utf8');
  html = html.replace('__CSRF_TOKEN__', CSRF_TOKEN).replace('__VERSION__', version());
  response.writeHead(200, {
    'content-type': MIME['.html'],
    'cache-control': 'no-store',
    // No external anything: the UI must work fully offline, so the policy that
    // enforces it is declared rather than assumed.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'"
  });
  response.end(html);
}

/** Constant-time compare so a wrong header cannot be narrowed down by timing. */
function tokenMatches(candidate, expected) {
  const provided = Buffer.from(String(candidate || ''), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (provided.length !== wanted.length) return false;
  return timingSafeEqual(provided, wanted);
}

/** Either the in-page CSRF token (browser) or the on-disk local token (wrapper). */
function authorized(request) {
  return (
    tokenMatches(request.headers['x-aim-csrf'], CSRF_TOKEN) ||
    tokenMatches(request.headers['x-aim-token'], LOCAL_TOKEN)
  );
}

async function readBody(request, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body is not valid JSON');
  }
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    serveShell(response);
    return;
  }

  if (request.method === 'GET' && path.startsWith('/api/')) {
    const name = path.slice(5);
    const endpoint = READ_ENDPOINTS[name];
    if (!endpoint) {
      json(response, 404, { ok: false, error: `unknown endpoint "${name}"` });
      return;
    }
    const options = Object.fromEntries(url.searchParams.entries());
    if (options.limit) options.limit = Number(options.limit);
    if (options.hours) options.hours = Number(options.hours);
    const payload = name === 'funnel' ? endpoint(options.hours || 24) : endpoint(options);
    json(response, 200, { ok: true, data: payload });
    return;
  }

  if (request.method === 'POST' && path.startsWith('/api/action/')) {
    if (!authorized(request)) {
      json(response, 403, { ok: false, error: 'bad or missing token — reload the dashboard' });
      return;
    }
    const name = path.slice('/api/action/'.length);
    try {
      const payload = await readBody(request);
      const result = await action(name, payload);
      json(response, result.ok === false ? 400 : 200, result);
    } catch (error) {
      logError(`dashboard action ${name}`, error, { name: 'dashboard' });
      json(response, 500, { ok: false, error: String(error?.message || error) });
    }
    return;
  }

  // Static assets, path-traversal-proofed by rejecting anything with a separator.
  if (request.method === 'GET' && /^\/[\w.-]+\.(?:css|js|svg)$/.test(path)) {
    try {
      const file = readFileSync(join(WEB_DIR, path.slice(1)));
      response.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(file);
      return;
    } catch {
      json(response, 404, { ok: false, error: 'not found' });
      return;
    }
  }

  json(response, 404, { ok: false, error: 'not found' });
}

function main() {
  loadEnv();
  ensureDirs();
  installCrashGuards('dashboard');

  const config = read();
  const port = Number(config.dashboard?.port) || 7391;
  const host = config.dashboard?.host || '127.0.0.1';

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      logError('dashboard request', error, { name: 'dashboard' });
      if (!response.headersSent) json(response, 500, { ok: false, error: 'internal error' });
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      process.stderr.write(`Port ${port} is already in use. Change dashboard.port in config.json or stop the other process.\n`);
      process.exit(1);
    }
    logError('dashboard server', error, { name: 'dashboard' });
  });

  server.listen(port, host, () => {
    const bound = server.address()?.port || port;
    const address = `http://${host}:${bound}`;

    // Registered only once the port is actually bound, so a failed start never
    // leaves a PID behind claiming the dashboard is up.
    registerSelf('dashboard');

    // The desktop wrapper reads these to find and talk to us. The port is written
    // from server.address() rather than config, because if the configured port was
    // taken we may have bound elsewhere and the wrapper would open a window
    // pointing at nothing.
    try {
      writeFileSync(PORT_FILE, `${bound}\n`, { encoding: 'utf8', mode: 0o600 });
      writeFileSync(TOKEN_FILE, `${LOCAL_TOKEN}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      logError('dashboard: could not publish port/token files', error, { name: 'dashboard' });
    }

    log(`dashboard: listening on ${address}`, { name: 'dashboard' });
    process.stdout.write(`\n  Inbox agent dashboard → ${address}\n\n`);
  });

  const shutdown = () => {
    // Remove the discovery files so a wrapper started later cannot be pointed at
    // a port nothing is listening on.
    for (const file of [PORT_FILE, TOKEN_FILE]) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    try {
      rmSync(PORT_FILE, { force: true });
      rmSync(TOKEN_FILE, { force: true });
    } catch {
      /* best effort */
    }
  });
}

const invokedDirectly = process.argv[1] && /dashboard\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main();

export { CSRF_TOKEN, handle };
