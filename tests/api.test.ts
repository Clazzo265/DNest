/**
 * End-to-end API tests against the real backend handler over HTTP.
 *
 * The provider SDK is not published, so `.devtesting/sdk` stands in for it (see
 * that file for the exact semantics it mirrors). Everything below - routing,
 * auth guard, quota maths, part accounting, storage round trips - is the
 * production code path.
 *
 * Run: npx tsx --test tests/api.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { CHUNK_SIZE, MIB, TIB } from '../backend/limits';

const PORT = 8791 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
let server: ReturnType<typeof spawn>;
let dataDir = '';

function headers(user: string) {
  return { 'x-test-user': user, 'content-type': 'application/json' };
}

async function call(
  method: string,
  path: string,
  user: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const response = await fetch(BASE + path, {
    method,
    headers: headers(user),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function makeBytes(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  let value = seed;
  for (let index = 0; index < size; index += 1) {
    value = (value * 1103515245 + 12345) & 0xff;
    out[index] = value;
  }
  return out;
}

before(async () => {
  // The platform packages are injected at deploy time; recreate the stand-ins.
  execFileSync(process.execPath, ['.devtesting/link.mjs'], { cwd: process.cwd() });
  dataDir = await mkdtemp(join(tmpdir(), 'datanest-test-'));
  server = spawn(
    process.execPath,
    ['--import', 'tsx', '.devtesting/server.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(PORT), HARNESS_DATA_DIR: dataDir },
      stdio: 'ignore',
      detached: true,
    }
  );

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(BASE + '/api/vault', { headers: headers('u1') });
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('harness did not start');
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

test('unauthenticated requests are rejected', async () => {
  const response = await fetch(BASE + '/api/vault');
  assert.equal(response.status, 401);
});

test('vault reports a 1 TiB quota and publishes its limits', async () => {
  const { status, data } = await call('GET', '/api/vault', 'quota-user');
  assert.equal(status, 200);
  assert.equal(data.limits.quotaBytes, TIB);
  assert.equal(data.limits.chunkSize, CHUNK_SIZE);
  assert.equal(data.quota.quotaBytes, TIB);
  assert.equal(data.quota.usedBytes, 0);
  assert.equal(data.quota.reservedBytes, 0);
  assert.equal(data.quota.percentUsed, 0);
  assert.equal(data.quota.remainingBytes, TIB);
});

test('a file larger than the whole quota is refused', async () => {
  const { status, data } = await call('POST', '/api/files/start', 'big-user', {
    name: 'too-big.bin',
    size: TIB + 1,
  });
  assert.equal(status, 413);
  assert.match(data.error, /cannot be larger/i);
});

test('an upload that would exceed remaining quota is refused', async () => {
  const user = 'quota-fill-user';
  const first = await call('POST', '/api/files/start', user, {
    name: 'big.bin',
    size: 1000 * 1024 * MIB, // 1000 GiB
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.expectedChunks, 1_024_000);

  const second = await call('POST', '/api/files/start', user, {
    name: 'over.bin',
    size: 100 * 1024 * MIB, // would push past 1 TiB
  });
  assert.equal(second.status, 413);
  assert.match(second.data.error, /1 TB/i);

  const vault = await call('GET', '/api/vault', user);
  assert.equal(vault.data.quota.reservedBytes, 1000 * 1024 * MIB);
  assert.ok(vault.data.quota.percentUsed > 97);
});

test('reservation is released when an oversized upload is abandoned', async () => {
  const user = 'release-user';
  const started = await call('POST', '/api/files/start', user, {
    name: 'half.bin',
    size: 512 * MIB,
  });
  assert.equal(started.status, 201);

  await call('DELETE', '/api/records/' + started.data.id, user);

  const vault = await call('GET', '/api/vault', user);
  assert.equal(vault.data.quota.reservedBytes, 0);
  assert.equal(vault.data.quota.usedBytes, 0);
});

test('upload, resume, verify and download a real file', async () => {
  const user = 'roundtrip-user';
  const bytes = makeBytes(3 * MIB + 1234);

  const started = await call('POST', '/api/files/start', user, {
    name: 'payload.bin',
    size: bytes.length,
    mimeType: 'application/octet-stream',
  });
  assert.equal(started.status, 201);
  const id = started.data.id;
  const expected = started.data.expectedChunks;
  assert.equal(expected, 4);

  // Send parts 0 and 2 only, leaving a gap.
  for (const index of [0, 2]) {
    const slice = bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    const part = await call('POST', `/api/files/${id}/chunks/${index}`, user, {
      base64: bytesToBase64(slice),
    });
    assert.equal(part.status, 200);
  }

  // Completing now must fail and say parts are missing.
  const premature = await call('POST', `/api/files/${id}/complete`, user, {});
  assert.equal(premature.status, 409);

  // Resume: the server tells us exactly what is left.
  const statusCheck = await call(
    'GET',
    `/api/files/${id}/status?parts=${encodeURIComponent(
      JSON.stringify([0, 1, 2, 3])
    )}`,
    user
  );
  assert.equal(statusCheck.status, 200);
  assert.equal(statusCheck.data.receivedParts, 2);
  assert.deepEqual(statusCheck.data.missing, [1, 3]);

  // Send the remaining parts as one batch.
  const batch = await call('POST', `/api/files/${id}/chunks`, user, {
    parts: [1, 3].map(index => ({
      index,
      base64: bytesToBase64(
        bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
      ),
    })),
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.data.receivedParts, 4);

  const complete = await call('POST', `/api/files/${id}/complete`, user, {});
  assert.equal(complete.status, 200);
  assert.equal(complete.data.quota.usedBytes, bytes.length);
  assert.equal(complete.data.quota.reservedBytes, 0);

  // Download in batches and compare byte for byte.
  const reassembled = new Uint8Array(bytes.length);
  let offset = 0;
  for (const group of [[0, 1], [2, 3]]) {
    const response = await call(
      'POST',
      `/api/files/${id}/chunks/read`,
      user,
      { indexes: group }
    );
    assert.equal(response.status, 200);
    for (const part of response.data.parts) {
      const chunk = Buffer.from(part.base64, 'base64');
      reassembled.set(chunk, offset);
      offset += chunk.length;
    }
  }
  assert.equal(offset, bytes.length);
  assert.deepEqual(Buffer.from(reassembled), Buffer.from(bytes));
});

test('a truncated part is rejected instead of corrupting the file', async () => {
  const user = 'short-part-user';
  const started = await call('POST', '/api/files/start', user, {
    name: 'exact.bin',
    size: 2 * MIB,
  });
  const id = started.data.id;

  const short = await call('POST', `/api/files/${id}/chunks/0`, user, {
    base64: bytesToBase64(makeBytes(MIB / 2)),
  });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /wrong size/i);

  // Completing must still fail: nothing valid was stored.
  const complete = await call('POST', `/api/files/${id}/complete`, user, {});
  assert.equal(complete.status, 409);
});

test('deleting a file frees its bytes back to the quota', async () => {
  const user = 'delete-user';
  const bytes = makeBytes(MIB);
  const started = await call('POST', '/api/files/start', user, {
    name: 'one.bin',
    size: bytes.length,
  });
  const id = started.data.id;
  await call('POST', `/api/files/${id}/chunks/0`, user, {
    base64: bytesToBase64(bytes),
  });
  await call('POST', `/api/files/${id}/complete`, user, {});

  let vault = await call('GET', '/api/vault', user);
  assert.equal(vault.data.quota.usedBytes, MIB);
  assert.equal(vault.data.quota.fileCount, 1);

  const removed = await call('DELETE', '/api/records/' + id, user);
  assert.equal(removed.status, 200);

  vault = await call('GET', '/api/vault', user);
  assert.equal(vault.data.quota.usedBytes, 0);
  assert.equal(vault.data.quota.fileCount, 0);
});

test('notes and JSON records are accounted and capped', async () => {
  const user = 'records-user';
  const created = await call('POST', '/api/records', user, {
    kind: 'note',
    title: 'Sized note',
    content: 'hello world',
  });
  assert.equal(created.status, 201);

  const vault = await call('GET', '/api/vault', user);
  assert.equal(vault.data.quota.recordCount, 1);
  assert.equal(vault.data.quota.usedBytes, 11);

  const tooBig = await call('POST', '/api/records', user, {
    kind: 'note',
    title: 'Huge',
    content: 'x'.repeat(200 * 1024),
  });
  assert.equal(tooBig.status, 413);
});

test('reconcile repairs drifted usage back to the part index', async () => {
  const user = 'reconcile-user';
  const bytes = makeBytes(2 * MIB);
  const started = await call('POST', '/api/files/start', user, {
    name: 'two.bin',
    size: bytes.length,
  });
  const id = started.data.id;
  for (const index of [0, 1]) {
    await call('POST', `/api/files/${id}/chunks/${index}`, user, {
      base64: bytesToBase64(
        bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
      ),
    });
  }
  await call('POST', `/api/files/${id}/complete`, user, {});

  const result = await call('POST', '/api/vault/reconcile', user, {});
  assert.equal(result.status, 200);
  assert.equal(result.data.quota.usedBytes, bytes.length);
  assert.equal(result.data.quota.fileCount, 1);
  assert.equal(result.data.parts, 2);
});

test('accounts cannot see or touch each other', async () => {
  const owner = 'isolate-a';
  const intruder = 'isolate-b';
  const started = await call('POST', '/api/files/start', owner, {
    name: 'secret.bin',
    size: MIB,
  });
  const id = started.data.id;
  await call('POST', `/api/files/${id}/chunks/0`, owner, {
    base64: bytesToBase64(makeBytes(MIB)),
  });
  await call('POST', `/api/files/${id}/complete`, owner, {});

  const listing = await call('GET', '/api/records', intruder);
  assert.equal(listing.data.items.length, 0);

  const peek = await call('GET', `/api/files/${id}/chunks/0`, intruder);
  assert.equal(peek.status, 404);
});

test('listing never ships the full part array', async () => {
  const user = 'listing-user';
  const started = await call('POST', '/api/files/start', user, {
    name: 'list.bin',
    size: 3 * MIB,
  });
  const id = started.data.id;
  await call('POST', `/api/files/${id}/chunks/0`, user, {
    base64: bytesToBase64(makeBytes(MIB)),
  });

  const listing = await call('GET', '/api/records', user);
  const item = listing.data.items.find((entry: any) => entry.id === id);
  assert.ok(item);
  assert.equal(item.uploadedChunks, undefined);
  assert.equal(item.receivedParts, 1);
  assert.equal(item.expectedChunks, 3);
  // Response stays small no matter how big the file is.
  assert.ok(JSON.stringify(item).length < 1500);
});
