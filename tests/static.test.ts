/**
 * Static serving and the invite page's real failure mode.
 *
 * The invite link once rendered a blank white page. The cause was not the invite
 * logic: the build references assets relatively, so opening /join/<ws>/<token>
 * made the browser request /join/<ws>/<token>/assets/index-abc.js, the server
 * answered with index.html and a JavaScript content type, and the browser
 * refused to execute it. Nothing logged, nothing rendered.
 *
 * These tests pin the properties that make a deep link work at all.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const PORT = 9800 + Math.floor(Math.random() * 150);
const BASE = 'http://127.0.0.1:' + PORT;
let dataDir = '';
let staticDir = '';
let server: ReturnType<typeof spawn>;
let jsName = '';
let cssName = '';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'datanest-static-data-'));
  staticDir = await mkdtemp(join(tmpdir(), 'datanest-static-dist-'));

  // A minimal build with the same shape vite produces: relative references.
  jsName = 'assets/index-TEST123.js';
  cssName = 'assets/index-TEST123.css';
  await mkdir(join(staticDir, 'assets'), { recursive: true });
  await writeFile(
    join(staticDir, 'index.html'),
    [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="./' + cssName + '">',
      '</head><body><div id="root"></div>',
      '<script type="module" src="./' + jsName + '"></script>',
      '</body></html>',
    ].join('')
  );
  await writeFile(join(staticDir, jsName), 'console.log("vault")');
  await writeFile(join(staticDir, cssName), 'body{margin:0}');

  server = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', './server/register.ts', 'server/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        DATANEST_DATA_DIR: dataDir,
        DATANEST_STATIC_DIR: staticDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(BASE + '/healthz')).ok) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(resolve => setTimeout(resolve, 120));
  }
});

after(async () => {
  try {
    if (server?.pid) process.kill(-server.pid, 'SIGKILL');
  } catch {
    server?.kill('SIGKILL');
  }
  await rm(dataDir, { recursive: true, force: true });
  await rm(staticDir, { recursive: true, force: true });
});

test('the shell references its assets relatively', async () => {
  const html = await readFile(join(staticDir, 'index.html'), 'utf8');
  assert.match(html, /src="\.\//, 'relative script reference is the premise');
});

test('a deep route serves the app shell as HTML', async () => {
  const response = await fetch(BASE + '/join/ws-abc/token123');
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') || '',
    /text\/html/,
    'a route must return HTML, never a script content type'
  );
  const html = await response.text();
  assert.match(html, /<div id="root">/);
});

test('assets resolve from a deep route, so the page can actually boot', async () => {
  // This is the exact request a phone makes after opening an invite link.
  for (const path of [
    '/join/ws-abc/token123/' + jsName,
    '/join/ws-abc/' + jsName,
  ]) {
    const response = await fetch(BASE + path);
    assert.equal(response.status, 200, 'expected 200 for ' + path);
    assert.match(
      response.headers.get('content-type') || '',
      /javascript/,
      'a script must be served as JavaScript: ' + path
    );
    assert.equal(await response.text(), 'console.log("vault")');
  }

  const css = await fetch(BASE + '/join/ws-abc/token123/' + cssName);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);
});

test('a missing asset 404s instead of masquerading as the app', async () => {
  for (const path of [
    '/assets/missing-abc123.js',
    '/join/ws-abc/missing-abc123.css',
    '/join/ws-abc/token/missing-abc123.js',
  ]) {
    const response = await fetch(BASE + path);
    assert.equal(response.status, 404, path + ' must not return the shell');
    assert.ok(
      !(response.headers.get('content-type') || '').includes('html'),
      path + ' must not answer with HTML'
    );
  }
});

test('path traversal cannot escape the build root', async () => {
  const response = await fetch(BASE + '/../../../../etc/passwd', {
    redirect: 'manual',
  });
  const body = await response.text();
  assert.ok(!body.includes('root:x:'), 'system files must never be served');
});

test('the invite API still works alongside static serving', async () => {
  const signup = await fetch(BASE + '/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'static@example.com',
      password: 'a long enough password',
      name: 'Static',
    }),
  });
  assert.equal(signup.status, 201);
  const cookie = (signup.headers.getSetCookie?.() ?? [])
    .map(entry => entry.split(';')[0])
    .join('; ');

  const created = await (
    await fetch(BASE + '/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Static vault' }),
    })
  ).json();

  const invite = await (
    await fetch(BASE + '/api/workspace/invites?ws=' + created.workspace.id, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ role: 'editor' }),
    })
  ).json();

  // The page for the generated link must boot, including its assets.
  const page = await fetch(BASE + invite.path);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  const script = await fetch(BASE + invite.path + '/' + jsName);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') || '', /javascript/);
});
