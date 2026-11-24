/**
 * Deployment tests: the production server (`server/index.ts`), not the harness.
 *
 * These cover the things that only matter once the app is actually deployed and
 * would never show up in the API tests: cookie sessions, static hosting, security
 * headers, request limits, and — most importantly — that data survives a restart
 * and that accounts cannot see each other.
 *
 * Run: npx tsx --test tests/server.test.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { MIB } from '../backend/limits';

const PORT = 9800 + Math.floor(Math.random() * 150);
const BASE = 'http://127.0.0.1:' + PORT;
let dataDir = '';
let staticDir = '';
let server: ReturnType<typeof spawn>;

type CookieJar = Map<string, string>;

function cookieHeader(jar: CookieJar): Record<string, string> {
  return jar.size
    ? { cookie: Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ') }
    : {};
}

let base = BASE;

async function call(
  method: string,
  path: string,
  jar: CookieJar = new Map(),
  body?: unknown
): Promise<{ status: number; data: any; raw: string; headers: Headers }> {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...cookieHeader(jar) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Persist any cookie the server sets, like a browser would.
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const [pair] = entry.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }

  const raw = await response.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  return { status: response.status, data, raw, headers: response.headers };
}

let activePort = PORT;

async function startServer(port = activePort): Promise<void> {
  activePort = port;
  server = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './server/register.ts',
      'server/index.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DATANEST_DATA_DIR: dataDir,
        DATANEST_STATIC_DIR: staticDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );
  // Surface server-side failures instead of a bare "fetch failed".
  server.stderr?.on('data', chunk => {
    const text = String(chunk);
    if (/Error|error|FATAL/.test(text)) console.error('[server]', text.slice(0, 400));
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/healthz');
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function stopServer(): Promise<void> {
  if (!server?.pid) return;
  // Kill only the process group we started. Without `detached` the child shares
  // the test runner's group, and killing that group takes down the test itself.
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    try {
      server.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  server = undefined as never;
  // SIGKILL returns immediately; wait for the port to actually be released.
  await new Promise(resolve => setTimeout(resolve, 800));
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'datanest-server-data-'));
  staticDir = join(process.cwd(), 'dist');
  await startServer();
});

after(async () => {
  await stopServer();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('health endpoint answers for platform probes', async () => {
  const { status, data } = await call('GET', '/healthz');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

test('the built app is served with security headers', async () => {
  const response = await fetch(BASE + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  const html = await response.text();
  assert.match(html, /<div id="root">/);
});

test('unknown paths fall back to the app shell, not a 404 page', async () => {
  const response = await fetch(BASE + '/some/deep/link');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="root">/);
});

test('anonymous users get 401 from every vault endpoint', async () => {
  for (const path of ['/api/vault', '/api/records']) {
    const { status } = await call('GET', path);
    assert.equal(status, 401, path + ' should require a session');
  }
  // A client cannot assert its own identity through headers.
  const spoofed = await fetch(BASE + '/api/vault', {
    headers: { 'x-test-user': 'somebody-else' },
  });
  assert.equal(spoofed.status, 401, 'header identity must not be trusted');
});

test('signup, session, and signout lifecycle', async () => {
  const jar: CookieJar = new Map();

  const created = await call('POST', '/api/auth/signup', jar, {
    email: 'owner@example.com',
    password: 'a long enough password',
    name: 'Owner',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.email, 'owner@example.com');
  assert.ok(jar.size > 0, 'a session cookie should be set');

  const setCookie = created.headers.getSetCookie?.() ?? [];
  assert.ok(
    setCookie.some(
      entry =>
        entry.includes('HttpOnly') &&
        entry.includes('SameSite=Lax') &&
        entry.includes('Path=/')
    ),
    'session cookie must be HttpOnly + SameSite',
    );

  const session = await call('GET', '/api/session', jar);
  assert.equal(session.data.user.email, 'owner@example.com');

  const signedOut = await call('POST', '/api/auth/signout', jar, {});
  assert.equal(signedOut.status, 200);
  const after = await call('GET', '/api/vault', jar);
  assert.equal(after.status, 401, 'session must be revoked server-side');
});

test('signin rejects bad credentials without revealing which part failed', async () => {
  await call('POST', '/api/auth/signup', new Map(), {
    email: 'real@example.com',
    password: 'a long enough password',
  });

  const wrongPassword = await call('POST', '/api/auth/signin', new Map(), {
    email: 'real@example.com',
    password: 'definitely wrong',
  });
  const unknownUser = await call('POST', '/api/auth/signin', new Map(), {
    email: 'nobody@example.com',
    password: 'definitely wrong',
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.equal(
    wrongPassword.data.error,
    unknownUser.data.error,
    'errors must be indistinguishable to prevent account enumeration'
  );
});

test('weak passwords and duplicate emails are refused', async () => {
  const weak = await call('POST', '/api/auth/signup', new Map(), {
    email: 'weak@example.com',
    password: 'short',
  });
  assert.equal(weak.status, 400);

  await call('POST', '/api/auth/signup', new Map(), {
    email: 'dupe@example.com',
    password: 'a long enough password',
  });
  const dupe = await call('POST', '/api/auth/signup', new Map(), {
    email: 'dupe@example.com',
    password: 'another long password',
  });
  assert.equal(dupe.status, 409);
});

test('a full upload/download round trip through the deployed server', async () => {
  const jar: CookieJar = new Map();
  await call('POST', '/api/auth/signup', jar, {
    email: 'roundtrip@example.com',
    password: 'a long enough password',
  });

  const vault = await call('GET', '/api/vault', jar);
  assert.equal(vault.data.quota.quotaBytes, 1099511627776);

  const size = 2 * MIB + 777;
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 13) & 0xff;

  const started = await call('POST', '/api/files/start', jar, {
    name: 'deployed.bin',
    size,
  });
  assert.equal(started.status, 201);
  const { id, expectedChunks, chunkSize } = started.data;
  assert.equal(expectedChunks, 3);

  for (let index = 0; index < expectedChunks; index += 1) {
    const part = bytes.subarray(
      index * chunkSize,
      Math.min(size, (index + 1) * chunkSize)
    );
    const stored = await call(
      'POST',
      `/api/files/${id}/chunks/${index}`,
      jar,
      { base64: part.toString('base64') }
    );
    assert.equal(stored.status, 200);
  }

  const complete = await call('POST', `/api/files/${id}/complete`, jar, {});
  assert.equal(complete.status, 200);
  assert.equal(complete.data.quota.usedBytes, size);

  const chunk = await call('GET', `/api/files/${id}/chunks/${expectedChunks - 1}`, jar);
  assert.equal(chunk.status, 200);
  const tail = Buffer.from(chunk.data.base64, 'base64');
  assert.deepEqual(
    tail,
    bytes.subarray((expectedChunks - 1) * chunkSize, size),
    'the final short part must be byte-exact'
  );
});

test('accounts are isolated on the deployed server', async () => {
  const alice: CookieJar = new Map();
  const bob: CookieJar = new Map();

  await call('POST', '/api/auth/signup', alice, {
    email: 'alice@example.com',
    password: 'a long enough password',
  });
  await call('POST', '/api/auth/signup', bob, {
    email: 'bob@example.com',
    password: 'a long enough password',
  });

  await call('POST', '/api/records', alice, {
    kind: 'note',
    title: 'Alice private note',
    content: 'for alice only',
  });

  const bobsRecords = await call('GET', '/api/records', bob);
  assert.equal(bobsRecords.data.items.length, 0);

  const alicesRecords = await call('GET', '/api/records', alice);
  assert.equal(alicesRecords.data.items.length, 1);
  assert.equal(alicesRecords.data.items[0].title, 'Alice private note');
});

test('oversized requests are rejected instead of exhausting memory', async () => {
  const jar: CookieJar = new Map();
  await call('POST', '/api/auth/signup', jar, {
    email: 'big@example.com',
    password: 'a long enough password',
  });

  // 40 MB body, past the 32 MB cap.
  const huge = 'x'.repeat(40 * 1024 * 1024);
  const response = await fetch(BASE + '/api/records', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookieHeader(jar) },
    body: JSON.stringify({ kind: 'note', title: 'huge', content: huge }),
  });
  assert.equal(response.status, 413);
});

test('data survives a full server restart', async () => {
  /**
   * Self-contained: this test runs its own server, in its own data directory, on
   * its own port. Durability should not depend on the shared server surviving
   * ten other tests, and a port clash must never look like data loss.
   */
  const port = PORT + 700;
  const dedicated = await mkdtemp(join(tmpdir(), 'datanest-durable-'));
  const ownBase = 'http://127.0.0.1:' + port;
  const ownServer = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './server/register.ts',
      'server/index.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DATANEST_DATA_DIR: dedicated,
        DATANEST_STATIC_DIR: staticDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );
  ownServer.stderr?.on('data', chunk =>
    console.error('[durable]', String(chunk).slice(0, 400))
  );

  const waitUp = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(ownBase + '/healthz');
        if (response.ok) return;
      } catch {
        /* not up */
      }
      if (Date.now() > deadline) throw new Error('dedicated server did not start');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  };

  const jar: CookieJar = new Map();
  const local = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(ownBase + path, {
      method,
      headers: { 'content-type': 'application/json', ...cookieHeader(jar) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const [pair] = entry.split(';');
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  };

  try {
    await waitUp();

    const size = MIB;
    const bytes = Buffer.alloc(size, 7);
    const bytes2 = Buffer.alloc(4096, 3);

    const signedUp = await local('POST', '/api/auth/signup', {
      email: 'durable@example.com',
      password: 'a long enough password',
    });
    assert.equal(signedUp.status, 201);

    const started = await local('POST', '/api/files/start', {
      name: 'durable.bin',
      size: size + bytes2.length,
    });
    assert.equal(started.status, 201);
    const id = started.data.id;
    const payload = Buffer.concat([bytes, bytes2]);

    const first = await local('POST', `/api/files/${id}/chunks/0`, {
      base64: payload.subarray(0, MIB).toString('base64'),
    });
    assert.equal(first.status, 200);
    const second = await local('POST', `/api/files/${id}/chunks/1`, {
      base64: payload.subarray(MIB).toString('base64'),
    });
    assert.equal(second.status, 200);
    const done = await local('POST', `/api/files/${id}/complete`, {});
    assert.equal(done.status, 200);

    const noteContent = 'survives restart';
    const note = await local('POST', '/api/records', {
      kind: 'note',
      title: 'Durable note',
      content: noteContent,
    });
    assert.equal(note.status, 201);

    const before = await local('GET', '/api/vault');
    assert.equal(
      before.data.quota.usedBytes,
      payload.length + Buffer.byteLength(noteContent)
    );

    // ---- restart the process against the same data directory ----
    try {
      process.kill(-ownServer.pid!, 'SIGKILL');
    } catch {
      ownServer.kill('SIGKILL');
    }
    await new Promise(resolve => setTimeout(resolve, 900));

    const restarted = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        './server/register.ts',
        'server/index.ts',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          DATANEST_DATA_DIR: dedicated,
          DATANEST_STATIC_DIR: staticDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }
    );
    restarted.stderr?.on('data', chunk =>
      console.error('[durable-restart]', String(chunk).slice(0, 400))
    );

    try {
      await waitUp();

      const reauth: CookieJar = new Map();
      const response = await fetch(ownBase + '/api/auth/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'durable@example.com',
          password: 'a long enough password',
        }),
      });
      assert.equal(response.status, 200, 'account must survive a restart');
      for (const entry of response.headers.getSetCookie?.() ?? []) {
        const [pair] = entry.split(';');
        const index = pair.indexOf('=');
        if (index > 0) reauth.set(pair.slice(0, index), pair.slice(index + 1));
      }

      const after = await fetch(ownBase + '/api/vault', {
        headers: cookieHeader(reauth),
      }).then(r => r.json() as Promise<any>);
      assert.equal(
        after.quota.usedBytes,
        before.data.quota.usedBytes,
        'usage must survive a restart'
      );

      const records = await fetch(ownBase + '/api/records', {
        headers: cookieHeader(reauth),
      }).then(r => r.json() as Promise<any>);
      const titles = records.items.map((item: any) => item.title);
      assert.ok(titles.includes('Durable note'), 'notes must survive a restart');

      // The stored bytes must be readable *and* identical after the restart.
      const file = records.items.find((item: any) => item.title === 'durable.bin');
      assert.ok(file, 'file must survive a restart');
      const rebuilt = Buffer.alloc(payload.length);
      let offset = 0;
      for (const index of [0, 1]) {
        const chunk = await fetch(
          ownBase + `/api/files/${file.id}/chunks/${index}`,
          { headers: cookieHeader(reauth) }
        ).then(r => r.json() as Promise<{ base64: string }>);
        const bytesOut = Buffer.from(chunk.base64, 'base64');
        bytesOut.copy(rebuilt, offset);
        offset += bytesOut.length;
      }
      assert.deepEqual(
        rebuilt,
        payload,
        'stored bytes must be byte-identical after a restart'
      );
    } finally {
      try {
        process.kill(-restarted.pid!, 'SIGKILL');
      } catch {
        restarted.kill('SIGKILL');
      }
    }
  } finally {
    try {
      process.kill(-ownServer.pid!, 'SIGKILL');
    } catch {
      /* already stopped */
    }
    await rm(dedicated, { recursive: true, force: true });
  }
});
