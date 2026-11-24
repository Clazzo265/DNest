/**
 * DataNest production server.
 *
 * Serves the built frontend and the vault API from one process, with:
 *  - cookie sessions (no credentials in client-asserted headers),
 *  - a per-account API surface routed through the same handler the tests cover,
 *  - static hosting with a single-page fallback,
 *  - security headers, request limits, and a health endpoint for platforms.
 *
 * Environment:
 *   PORT                 listen port (default 8080)
 *   DATANEST_DATA_DIR    root for tables + storage (default ./data)
 *   DATANEST_STATIC_DIR  built frontend (default ./dist)
 *   DATANEST_ORIGIN      public origin, used for cookie `Secure` (optional)
 *   DATANEST_TRUST_PROXY=1 honour X-Forwarded-Proto
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { handler as vaultHandler } from '../backend/index';
import {
  accountKey,
  clearCookie,
  hashPassword,
  hashToken,
  newSessionToken,
  normaliseEmail,
  parseCookies,
  sessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  validEmail,
  verifyPassword,
  type SessionUser,
} from './auth';
import { adapter, type Ctx, type Result } from './sdk';

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = resolve(process.env.DATANEST_DATA_DIR || './data');
const STATIC_DIR = resolve(process.env.DATANEST_STATIC_DIR || './dist');
const USERS_TABLE = 'datanest_users';
const SESSIONS_TABLE = 'datanest_sessions';

/** 1 MiB of bytes becomes ~1.37 MB of base64; batch endpoints multiply that. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;


type UserRow = {
  __appdeploy_ddb_id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
};

type SessionRow = {
  __appdeploy_ddb_id: string;
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event, ...detail })
  );
}

function isSecure(headers: Record<string, string>): boolean {
  const origin = process.env.DATANEST_ORIGIN || '';
  if (origin.startsWith('https://')) return true;
  if (process.env.DATANEST_TRUST_PROXY === '1') {
    const proto = headers['x-forwarded-proto'];
    if (proto) return proto.split(',')[0].trim() === 'https';
  }
  return false;
}

async function readBody(
  stream: AsyncIterable<Buffer>
): Promise<{ raw: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      truncated = true;
      break;
    }
    chunks.push(chunk);
  }
  return { raw: Buffer.concat(chunks).toString('utf8'), truncated };
}

// ---- identity ---------------------------------------------------------------

async function findUserByEmail(email: string): Promise<UserRow | null> {
  // `appdeploy_system_id` keeps the row id, which is the account key.
  const page = await adapter.list<UserRow>(USERS_TABLE, {
    limit: 1000,
    appdeploy_system_id: true,
  });
  return page.items.find(row => row.email === email) ?? null;
}

/** Identity tables can outgrow one page; walk them until the row is found. */
async function findSessionByToken(tokenHash: string): Promise<SessionRow | null> {
  let nextToken: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const batch = await adapter.list<SessionRow>(SESSIONS_TABLE, {
      limit: 1000,
      nextToken,
      appdeploy_system_id: true,
    });
    const match = batch.items.find(row => row.tokenHash === tokenHash);
    if (match) return match;
    if (!batch.nextToken) return null;
    nextToken = batch.nextToken;
  }
  return null;
}

async function currentUser(cookies: Record<string, string>): Promise<SessionUser | null> {
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const tokenHash = hashToken(token);
  const session = await findSessionByToken(tokenHash);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    await adapter.delete(SESSIONS_TABLE, [session.__appdeploy_ddb_id]);
    return null;
  }

  const users = await adapter.get<UserRow>(USERS_TABLE, [session.userId]);
  const user = users[0];
  if (!user) return null;

  return { userId: user.__appdeploy_ddb_id, email: user.email, name: user.name };
}

/** Drop expired sessions; called opportunistically to keep the table small. */
async function pruneSessions(): Promise<void> {
  const sessions = await adapter.list<SessionRow>(SESSIONS_TABLE, {
    limit: 1000,
    appdeploy_system_id: true,
  });
  const now = Date.now();
  const stale = sessions.items
    .filter(row => row.expiresAt < now && row.__appdeploy_ddb_id)
    .map(row => row.__appdeploy_ddb_id);
  if (stale.length) await adapter.delete(SESSIONS_TABLE, stale);
}

// ---- API --------------------------------------------------------------------

async function handleAuth(
  path: string,
  method: string,
  body: any,
  headers: Record<string, string>,
  cookies: Record<string, string>
): Promise<Result | null> {
  const secure = isSecure(headers);

  if (path === '/api/session' && method === 'GET') {
    const user = await currentUser(cookies);
    return {
      statusCode: 200,
      body: JSON.stringify({ user }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    };
  }

  if (path === '/api/auth/signup' && method === 'POST') {
    const email = normaliseEmail(String(body?.email || ''));
    const password = String(body?.password || '');
    const name = String(body?.name || '').trim().slice(0, 80);

    if (!validEmail(email)) return jsonError('Enter a valid email address.', 400);
    if (password.length < 10) {
      return jsonError('Use a password of at least 10 characters.', 400);
    }
    if (await findUserByEmail(email)) {
      return jsonError('An account with that email already exists.', 409);
    }

    const ids = await adapter.add(USERS_TABLE, [
      {
        email,
        name: name || email.split('@')[0],
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString(),
      },
    ]);
    if (!ids[0]) return jsonError('The account could not be created.', 500);

    const token = newSessionToken();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await adapter.add(SESSIONS_TABLE, [
      {
        tokenHash: hashToken(token),
        userId: ids[0],
        createdAt: Date.now(),
        expiresAt,
      },
    ]);
    log('account.created', { account: accountKey(ids[0]) });
    return {
      statusCode: 201,
      body: JSON.stringify({
        user: { userId: ids[0], email, name: name || email.split('@')[0] },
      }),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': sessionCookie(token, { secure }),
      },
    };
  }

  if (path === '/api/auth/signin' && method === 'POST') {
    const email = normaliseEmail(String(body?.email || ''));
    const password = String(body?.password || '');
    const user = await findUserByEmail(email);

    // Same response for unknown email and wrong password: no account enumeration.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      log('auth.failed', { email });
      return jsonError('Email or password is incorrect.', 401);
    }

    await pruneSessions();
    const token = newSessionToken();
    await adapter.add(SESSIONS_TABLE, [
      {
        tokenHash: hashToken(token),
        userId: user.__appdeploy_ddb_id,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
      },
    ]);
    if (!user.__appdeploy_ddb_id) {
      log('auth.error', { reason: 'user row has no id' });
      return jsonError('Your account record is damaged. Contact support.', 500);
    }
    log('auth.signin', { account: accountKey(user.__appdeploy_ddb_id) });
    return {
      statusCode: 200,
      body: JSON.stringify({
        user: {
          userId: user.__appdeploy_ddb_id,
          email: user.email,
          name: user.name,
        },
      }),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': sessionCookie(token, { secure }),
      },
    };
  }

  if (path === '/api/auth/signout' && method === 'POST') {
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const tokenHash = hashToken(token);
      const sessions = await adapter.list<SessionRow>(SESSIONS_TABLE, {
        limit: 1000,
        appdeploy_system_id: true,
      });
      const match = sessions.items.filter(row => row.tokenHash === tokenHash);
      if (match.length) {
        await adapter.delete(
          SESSIONS_TABLE,
          match.map(row => row.__appdeploy_ddb_id)
        );
      }
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ signedOut: true }),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': clearCookie(secure),
      },
    };
  }

  return null;
}

function jsonError(message: string, status: number): Result {
  return {
    statusCode: status,
    body: JSON.stringify({ error: message }),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  };
}

async function handleApi(
  url: URL,
  method: string,
  rawBody: string,
  headers: Record<string, string>
): Promise<Result> {
  const cookies = parseCookies(headers.cookie);

  let body: unknown = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonError('The request body was not valid JSON.', 400);
    }
  }

  const authResult = await handleAuth(url.pathname, method, body, headers, cookies);
  if (authResult) return authResult;

  const user = await currentUser(cookies);

  const ctx: Ctx = {
    body,
    params: {},
    query: Object.fromEntries(url.searchParams.entries()),
    user: user ? { userId: user.userId } : undefined,
    headers,
    method,
    path: url.pathname,
  };

  return (await vaultHandler(ctx)) as Result;
}

// ---- static ----------------------------------------------------------------

function safeJoin(root: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath);
  const normalised = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = join(root, normalised);
  // Refuse anything that escapes the static root.
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function serveStatic(url: URL): Promise<Result & { file?: string } | null> {
  const root = STATIC_DIR;
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = safeJoin(root, pathname);
  if (!candidate) return null;

  const info = await stat(candidate).catch(() => null);
  if (info?.isFile()) {
    const body = await readFile(candidate);
    return {
      statusCode: 200,
      body: body.toString('binary'),
      file: candidate,
      headers: {
        'content-type': MIME[extname(candidate).toLowerCase()] || 'application/octet-stream',
        // Hashed asset names are immutable; HTML must always revalidate.
        'cache-control': /\/assets\//.test(candidate)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      },
    };
  }

  // Single-page app: unknown paths render the app shell.
  const fallback = join(root, 'index.html');
  const fallbackInfo = await stat(fallback).catch(() => null);
  if (!fallbackInfo?.isFile()) return null;

  const body = await readFile(fallback);
  return {
    statusCode: 200,
    body: body.toString('binary'),
    file: fallback,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    },
  };
}

// ---- server -----------------------------------------------------------------

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
};

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.setHeader(key, value);
  }

  const method = (request.method || 'GET').toUpperCase();
  const url = new URL(request.url || '/', 'http://localhost');

  try {
    if (url.pathname === '/healthz') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const { raw, truncated } = await readBody(request);
      if (truncated) {
        response.statusCode = 413;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            error:
              'That request was too large. Send fewer parts per batch.',
          })
        );
        return;
      }

      const result = await handleApi(url, method, raw, headers);
      response.statusCode = result.statusCode;
      for (const [key, value] of Object.entries(result.headers || {})) {
        response.setHeader(key, value);
      }
      response.end(result.body);
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const result = await serveStatic(url);
      if (result) {
        response.statusCode = result.statusCode;
        for (const [key, value] of Object.entries(result.headers || {})) {
          response.setHeader(key, value);
        }
        if (method === 'HEAD') {
          response.end();
        } else if (result.file) {
          // Stream assets instead of buffering them in memory.
          await new Promise<void>((done, fail) => {
            const stream = createReadStream(result.file!);
            stream.on('error', fail);
            stream.on('end', done);
            stream.pipe(response);
          });
        } else {
          response.end(Buffer.from(result.body, 'binary'));
        }
        return;
      }
    }

    response.statusCode = 404;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('Not found');
  } catch (error) {
    log('request.error', {
      method,
      path: url.pathname,
      message: String((error as Error)?.message || error),
    });
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({ error: 'The server hit an unexpected problem.' })
      );
    } else {
      response.end();
    }
  } finally {
    const duration = Date.now() - startedAt;
    if (url.pathname.startsWith('/api/') && duration > 1000) {
      log('request.slow', { method, path: url.pathname, ms: duration });
    }
  }
});

async function main(): Promise<void> {
  await mkdir(join(DATA_DIR, 'tables'), { recursive: true });
  await mkdir(join(DATA_DIR, 'storage'), { recursive: true });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(PORT, '0.0.0.0', () => done());
  });

  log('server.started', {
    port: PORT,
    data: DATA_DIR,
    static: STATIC_DIR,
    node: process.version,
  });
}

// Fail loudly rather than serving a half-broken process.
process.on('unhandledRejection', reason => {
  log('unhandled.rejection', { reason: String(reason) });
});
process.on('SIGTERM', () => {
  log('server.stopping', { signal: 'SIGTERM' });
  server.close(() => process.exit(0));
});

void main().catch(error => {
  log('server.failed', { message: String(error?.message || error) });
  process.exit(1);
});

export { server };
