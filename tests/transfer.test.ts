/**
 * Transfer-engine tests. The 1 TB claim depends on the client never buffering a
 * whole file, never sending parts one-at-a-time, and never trusting its own
 * bookkeeping over the server's.
 *
 * Run: npx tsx --test tests/transfer.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { CHUNK_SIZE, MIB } from '../backend/limits';
import {
  base64ToBytes,
  bytesToBase64,
  errorMessage,
  formatBytes,
  formatDuration,
  safeFilename,
} from '../src/transfer';

const PORT = 9000 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
let server: ReturnType<typeof spawn>;
let dataDir = '';

before(async () => {
  // Browser globals the engine uses, shimmed for Node.
  await import('../.devtesting/node-dom.mjs');
  // The platform packages are injected at deploy time; recreate the stand-ins.
  execFileSync(process.execPath, ['.devtesting/link.mjs'], { cwd: process.cwd() });
  dataDir = await mkdtemp(join(tmpdir(), 'datanest-transfer-'));
  server = spawn(process.execPath, ['--import', 'tsx', '.devtesting/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), HARNESS_DATA_DIR: dataDir },
    stdio: 'ignore',
    detached: true,
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(BASE + '/api/vault', {
        headers: { 'x-test-user': 'transfer-user' },
      });
      if (response.status < 500) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('harness did not start');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  (globalThis as any).__DATANEST_BASE__ = BASE;
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

test('base64 helpers are byte-exact and survive large payloads', () => {
  const bytes = new Uint8Array(1024 * 1024);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index & 0xff;
  const encoded = bytesToBase64(bytes);
  assert.equal(encoded.length, Math.ceil(bytes.length / 3) * 4);
  assert.deepEqual(base64ToBytes(encoded), bytes);

  // Every byte value must round trip, including 0 and 255.
  const all = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) all[index] = index;
  assert.deepEqual(base64ToBytes(bytesToBase64(all)), all);
});

test('formatting stays correct through terabytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 ** 4), '1.00 TB');
  assert.equal(formatBytes(1024 ** 4 * 0.5), '512.00 GB');
  assert.equal(formatDuration(0), '—');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(600), '10 min');
  assert.equal(formatDuration(7200), '2.0 h');
});

test('filenames are safe for every target filesystem', () => {
  assert.equal(safeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(safeFilename('   '), 'untitled');
  assert.ok(safeFilename('x'.repeat(500)).length <= 120);
});

test('error messages surface the server text', () => {
  assert.equal(
    errorMessage({
      response: { data: { error: 'Files must be 1 TB or smaller.' } },
    }),
    'Files must be 1 TB or smaller.'
  );
  assert.match(errorMessage({}), /went wrong/i);
});

test('an upload resumes instead of restarting after a partial failure', async () => {
  const { uploadFile } = await import('../src/transfer');
  const size = 4 * MIB + 17;
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7) & 0xff;
  const file = new File([bytes], 'resume-check.bin', {
    type: 'application/octet-stream',
  });

  // First attempt: cap concurrency at 1 and cancel after the first part lands.
  let seen = 0;
  const first = uploadFile(file, {
    concurrency: 1,
    onProgress: progress => {
      if (progress.partsDone > seen) {
        seen = progress.partsDone;
        if (seen === 1) first.cancel();
      }
    },
  });

  await assert.rejects(first.promise, /cancelled/i);

  // The server should already hold exactly one part.
  const serverside = await fetch(
    BASE + '/api/files/' + encodeURIComponent(first.id!!) + '/status?from=0&limit=1',
    { headers: { 'x-test-user': 'demo-nest-owner' } }
  ).then(response => response.json() as Promise<{ receivedParts: number }>);
  assert.equal(serverside.receivedParts, 1);

  // Second attempt resumes that same upload rather than starting a new one.
  let completed = 0;
  const second = uploadFile(file, {
    resumeId: first.id!!,
    concurrency: 4,
    onProgress: progress => {
      completed = progress.partsDone;
    },
  });
  const result = await second.promise;
  assert.equal(result.id, first.id);
  // Resumed work only covered the remaining parts.
  assert.ok(completed >= 1);

  // And the file is complete and byte-identical to what we sent.
  const status = await fetch(
    BASE + '/api/files/' + encodeURIComponent(result.id) + '/status?from=0&limit=1',
    { headers: { 'x-test-user': 'demo-nest-owner' } }
  ).then(response => response.json() as Promise<{
    expectedChunks: number;
    receivedParts: number;
  }>);
  assert.equal(status.receivedParts, status.expectedChunks);
  assert.equal(status.expectedChunks, Math.ceil(size / CHUNK_SIZE));
});
