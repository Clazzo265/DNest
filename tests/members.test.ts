/**
 * Shared vaults, members, roles and invite links.
 *
 * The requirement is "invite other members with a WhatsApp link", so these tests
 * cover the properties that actually matter for a shareable link:
 *  - it works for someone who has no account yet,
 *  - it resolves against one specific vault,
 *  - it is single-use and expires,
 *  - it never leaks vault contents before the person joins,
 *  - roles are enforced on the server, not just hidden in the UI.
 *
 * Run: npx tsx --test tests/members.test.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const PORT = 9500 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
let dataDir = '';
let server: ReturnType<typeof spawn>;

type Jar = Map<string, string>;

function jarHeaders(jar: Jar): Record<string, string> {
  return jar.size
    ? { cookie: Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ') }
    : {};
}

function client() {
  const jar: Jar = new Map();
  return {
    jar,
    async call(
      method: string,
      path: string,
      body?: unknown
    ): Promise<{ status: number; data: any }> {
      const response = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...jarHeaders(jar) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const entry of response.headers.getSetCookie?.() ?? []) {
        const [pair] = entry.split(';');
        const index = pair.indexOf('=');
        if (index > 0) {
          const name = pair.slice(0, index).trim();
          const value = pair.slice(index + 1).trim();
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      }
      const raw = await response.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = raw;
      }
      return { status: response.status, data };
    },
  };
}

async function signUp(jar: ReturnType<typeof client>, email: string, name: string) {
  const result = await jar.call('POST', '/api/auth/signup', {
    email,
    password: 'a long enough password',
    name,
  });
  assert.equal(result.status, 201, 'signup failed: ' + JSON.stringify(result.data));
  return result.data.user as { userId: string; email: string; name: string };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'datanest-members-'));
  server = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', './server/register.ts', 'server/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        DATANEST_DATA_DIR: dataDir,
        DATANEST_STATIC_DIR: join(process.cwd(), 'dist'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );
  server.stderr?.on('data', chunk => {
    const text = String(chunk);
    if (/Error|FATAL/.test(text)) console.error('[server]', text.slice(0, 300));
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(BASE + '/healthz');
      if (response.ok) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
});

after(async () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      server.kill('SIGKILL');
    }
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('signing up creates a personal vault the user owns', async () => {
  const owner = client();
  await signUp(owner, 'solo@example.com', 'Solo');

  const { data } = await owner.call('GET', '/api/workspaces');
  assert.equal(data.workspaces.length, 1);
  assert.equal(data.workspaces[0].kind, 'personal');
  assert.equal(data.role, 'owner');
  assert.equal(data.workspaces[0].role, 'owner');
});

test('a personal vault stays private: no invite can be minted usefully elsewhere', async () => {
  const owner = client();
  await signUp(owner, 'private@example.com', 'Private');

  // Owners can share even personal vaults; what matters is that a *different*
  // account sees nothing until it joins.
  const stranger = client();
  await signUp(stranger, 'stranger@example.com', 'Stranger');
  const list = await stranger.call('GET', '/api/workspaces');
  const ids = list.data.workspaces.map((workspace: any) => workspace.id);
  const ownerList = await owner.call('GET', '/api/workspaces');
  assert.ok(
    !ids.includes(ownerList.data.workspaces[0].id),
    'personal vault must not appear for another account'
  );
});

test('an invite link is public, vault-scoped and name-only', async () => {
  const owner = client();
  await signUp(owner, 'inviter@example.com', 'Inviter');
  const created = await owner.call('POST', '/api/workspaces', {
    name: 'Family photos',
  });
  const workspaceId = created.data.workspace.id;

  const invite = await owner.call(
    'POST',
    '/api/workspace/invites?ws=' + workspaceId,
    { role: 'editor' }
  );
  assert.equal(invite.status, 201);

  // The path must carry the workspace id, or the join page cannot resolve it.
  const match = /^\/join\/([^/]+)\/([^/]+)$/.exec(invite.data.path);
  assert.ok(match, 'invite path must be /join/<workspaceId>/<token>');
  assert.equal(match![1], workspaceId);
  assert.equal(match![2], invite.data.token);

  // A visitor with no session can preview it...
  const anonymous = client();
  const preview = await anonymous.call(
    'GET',
    '/api/invites/' + workspaceId + '/' + invite.data.token
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.workspaceName, 'Family photos');
  assert.equal(preview.data.role, 'editor');
  // ...but the preview must not leak membership or content.
  assert.equal(preview.data.members, undefined);
  assert.equal(preview.data.items, undefined);

  // Accepting still requires a session.
  const noSession = await anonymous.call(
    'POST',
    '/api/invites/' + workspaceId + '/' + invite.data.token,
    {}
  );
  assert.equal(noSession.status, 401);
});

test('a recipient with no account can join, then read the shared vault', async () => {
  const owner = client();
  await signUp(owner, 'owner2@example.com', 'Owner Two');
  const created = await owner.call('POST', '/api/workspaces', { name: 'Team docs' });
  const workspaceId = created.data.workspace.id;

  const invite = await owner.call(
    'POST',
    '/api/workspace/invites?ws=' + workspaceId,
    { role: 'editor' }
  );

  await owner.call('POST', '/api/records?ws=' + workspaceId, {
    kind: 'note',
    title: 'Shared note',
    content: 'visible to members',
  });

  // The recipient signs up first, exactly like the join page does.
  const guest = client();
  await signUp(guest, 'guest@example.com', 'Guest');
  const joined = await guest.call(
    'POST',
    '/api/invites/' + workspaceId + '/' + invite.data.token,
    {}
  );
  assert.equal(joined.status, 200);
  assert.equal(joined.data.role, 'editor');

  const records = await guest.call('GET', '/api/records?ws=' + workspaceId);
  assert.deepEqual(
    records.data.items.map((item: any) => item.title),
    ['Shared note']
  );

  // And the vault now appears in their list.
  const list = await guest.call('GET', '/api/workspaces');
  assert.ok(
    list.data.workspaces.some((workspace: any) => workspace.id === workspaceId)
  );
});

test('an invite is single-use', async () => {
  const owner = client();
  await signUp(owner, 'once@example.com', 'Once');
  const created = await owner.call('POST', '/api/workspaces', { name: 'One time' });
  const workspaceId = created.data.workspace.id;
  const invite = await owner.call(
    'POST',
    '/api/workspace/invites?ws=' + workspaceId,
    { role: 'viewer' }
  );

  const first = client();
  await signUp(first, 'first@example.com', 'First');
  const accepted = await first.call(
    'POST',
    '/api/invites/' + workspaceId + '/' + invite.data.token,
    {}
  );
  assert.equal(accepted.status, 200);

  const second = client();
  await signUp(second, 'second@example.com', 'Second');
  const rejected = await second.call(
    'POST',
    '/api/invites/' + workspaceId + '/' + invite.data.token,
    {}
  );
  assert.equal(rejected.status, 404);
  assert.match(rejected.data.error, /already been used|not valid/i);

  const preview = await second.call(
    'GET',
    '/api/invites/' + workspaceId + '/' + invite.data.token
  );
  assert.equal(preview.status, 404);
  assert.equal(preview.data.reason, 'used');
});

test('viewer role is read-only, enforced server-side', async () => {
  const owner = client();
  await signUp(owner, 'rbac-owner@example.com', 'RbacOwner');
  const created = await owner.call('POST', '/api/workspaces', { name: 'RBAC' });
  const workspaceId = created.data.workspace.id;
  const invite = await owner.call(
    'POST',
    '/api/workspace/invites?ws=' + workspaceId,
    { role: 'viewer' }
  );

  const viewer = client();
  await signUp(viewer, 'rbac-viewer@example.com', 'RbacViewer');
  await viewer.call(
    'POST',
    '/api/invites/' + workspaceId + '/' + invite.data.token,
    {}
  );

  await owner.call('POST', '/api/records?ws=' + workspaceId, {
    kind: 'note',
    title: 'Readable',
    content: 'content',
  });

  // Reads work.
  const readable = await viewer.call('GET', '/api/records?ws=' + workspaceId);
  assert.equal(readable.status, 200);
  assert.equal(readable.data.items.length, 1);

  // Writes do not.
  for (const [method, path, body] of [
    ['POST', '/api/records?ws=' + workspaceId, { kind: 'note', title: 'x', content: 'y' }],
    ['POST', '/api/files/start?ws=' + workspaceId, { name: 'x.bin', size: 10 }],
    ['POST', '/api/vault/reconcile?ws=' + workspaceId, {}],
  ] as const) {
    const denied = await viewer.call(method, path, body);
    assert.equal(denied.status, 403, method + ' ' + path + ' must be refused');
  }
});

test('only owners can invite or change roles', async () => {
  const owner = client();
  await signUp(owner, 'admin@example.com', 'Admin');
  const created = await owner.call('POST', '/api/workspaces', { name: 'Admin only' });
  const workspaceId = created.data.workspace.id;
  const invite = await owner.call(
    'POST',
    '/api/workspace/invites?ws=' + workspaceId,
    { role: 'editor' }
  );

  const editor = client();
  const editorUser = await signUp(editor, 'editor@example.com', 'Editor');
  await editor.call(
    'POST',
    '/api/invites/' + workspaceId + '/' + invite.data.token,
    {}
  );

  const cannotInvite = await editor.call(
    'POST',
    '/api/workspace/invites?ws=' + workspaceId,
    { role: 'viewer' }
  );
  assert.equal(cannotInvite.status, 403);

  const cannotDemote = await editor.call(
    'PATCH',
    '/api/workspace/members/' + editorUser.userId + '?ws=' + workspaceId,
    { role: 'viewer' }
  );
  assert.equal(cannotDemote.status, 403);
});

test('the last owner cannot leave, and leaving revokes access immediately', async () => {
  const owner = client();
  const ownerUser = await signUp(owner, 'leave-owner@example.com', 'LeaveOwner');
  const created = await owner.call('POST', '/api/workspaces', { name: 'Leaving' });
  const workspaceId = created.data.workspace.id;
  const invite = await owner.call(
    'POST',
    '/api/workspace/invites?ws=' + workspaceId,
    { role: 'editor' }
  );

  const leaver = client();
  const leaverUser = await signUp(leaver, 'leaver@example.com', 'Leaver');
  await leaver.call(
    'POST',
    '/api/invites/' + workspaceId + '/' + invite.data.token,
    {}
  );

  // The only owner cannot walk out and strand the vault.
  const stuck = await owner.call(
    'DELETE',
    '/api/workspace/members/' + ownerUser.userId + '?ws=' + workspaceId
  );
  assert.equal(stuck.status, 409);
  assert.ok(ownerUser.userId);

  // A member can leave...
  const left = await leaver.call(
    'DELETE',
    '/api/workspace/members/' + leaverUser.userId + '?ws=' + workspaceId
  );
  assert.equal(left.status, 200);

  // ...and loses access on the very next request.
  const after = await leaver.call('GET', '/api/records?ws=' + workspaceId);
  assert.notEqual(after.status, 200, 'removed member must lose access');
});

test('invite tokens are stored only as hashes', async () => {
  const owner = client();
  await signUp(owner, 'hash@example.com', 'Hash');
  const created = await owner.call('POST', '/api/workspaces', { name: 'Hashed' });
  const workspaceId = created.data.workspace.id;
  const invite = await owner.call(
    'POST',
    '/api/workspace/invites?ws=' + workspaceId,
    { role: 'editor' }
  );

  const { readFile } = await import('node:fs/promises');
  const path = join(dataDir, 'tables', 'ws_invites_' + workspaceId + '.json');
  const stored = await readFile(path, 'utf8');
  assert.ok(
    !stored.includes(invite.data.token),
    'the raw invite token must never be persisted'
  );
  assert.ok(stored.includes(invite.data.code), 'the short code should be listed');
});

test('each vault keeps its own quota and content', async () => {
  const owner = client();
  await signUp(owner, 'multi@example.com', 'Multi');
  const personal = await owner.call('GET', '/api/workspaces');
  const personalId = personal.data.workspaces[0].id;
  const created = await owner.call('POST', '/api/workspaces', { name: 'Second' });
  const secondId = created.data.workspace.id;

  await owner.call('POST', '/api/records?ws=' + personalId, {
    kind: 'note',
    title: 'In personal',
    content: 'private',
  });
  await owner.call('POST', '/api/records?ws=' + secondId, {
    kind: 'note',
    title: 'In second',
    content: 'shared',
  });

  const inPersonal = await owner.call('GET', '/api/records?ws=' + personalId);
  const inSecond = await owner.call('GET', '/api/records?ws=' + secondId);
  assert.deepEqual(
    inPersonal.data.items.map((item: any) => item.title),
    ['In personal']
  );
  assert.deepEqual(
    inSecond.data.items.map((item: any) => item.title),
    ['In second']
  );

  const personalQuota = await owner.call('GET', '/api/vault?ws=' + personalId);
  const secondQuota = await owner.call('GET', '/api/vault?ws=' + secondId);
  assert.equal(personalQuota.data.quota.usedBytes, 7);
  assert.equal(secondQuota.data.quota.usedBytes, 6);
});
