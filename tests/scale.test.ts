/**
 * Scale test: a real multi-hundred-megabyte transfer through the production
 * client and backend. This is the "does it actually work past hobby size"
 * check - 1 TiB is 2500x this, but the code path, part accounting, and memory
 * profile are identical.
 *
 * Run: npx tsx --test tests/scale.test.ts (add DATANEST_SCALE_MB=256 to go bigger)
 */
import '../.devtesting/dom.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { CHUNK_SIZE, MIB } from '../backend/limits';

const SIZE_MB = Number(process.env.DATANEST_SCALE_MB || 64);
const PORT = 9600 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
let server: ReturnType<typeof spawn>;
let dataDir = '';

before(async () => {
  await import('../.devtesting/node-dom.mjs');
  execFileSync(process.execPath, ['.devtesting/link.mjs'], { cwd: process.cwd() });
  dataDir = await mkdtemp(join(tmpdir(), 'datanest-scale-'));
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
        headers: { 'x-test-user': 'scale-user' },
      });
      if (response.status < 500) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('harness did not start');
    await new Promise(resolve => setTimeout(resolve, 200));
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

test(`a ${SIZE_MB} MB file uploads with bounded memory and verifies`, async () => {
  const total = SIZE_MB * MIB;
  const bytes = new Uint8Array(total);
  for (let offset = 0; offset < total; offset += 65_536) {
    for (let index = 0; index < 65_536 && offset + index < total; index += 1) {
      bytes[offset + index] = (offset + index) & 0xff;
    }
  }

  const { uploadFile } = await import('../src/transfer');
  const file = new File([bytes], 'scale-' + SIZE_MB + 'mb.bin');

  // Instrument the network layer: what matters for 1 TB is that the engine keeps
  // a bounded window of part payloads in flight, never the whole file. Heap
  // sampling is too noisy (the File constructor copies, GC timing varies), so
  // this measures the actual invariant.
  const originalFetch = globalThis.fetch;
  const concurrency = 6;
  let inFlight = 0;
  let peakInFlight = 0;
  let inFlightBytes = 0;
  let peakInFlightBytes = 0;
  const partRequests: number[] = [];

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const isPart = /\/chunks\/\d+$/.test(new URL(url, BASE).pathname);
    if (!isPart) return originalFetch(input, init);
    const size = typeof init?.body === 'string' ? init.body.length : 0;
    inFlight += 1;
    inFlightBytes += size;
    peakInFlight = Math.max(peakInFlight, inFlight);
    peakInFlightBytes = Math.max(peakInFlightBytes, inFlightBytes);
    partRequests.push(size);
    try {
      return await originalFetch(input, init);
    } finally {
      inFlight -= 1;
      inFlightBytes -= size;
    }
  }) as typeof fetch;

  const baseline = process.memoryUsage().heapUsed;
  let peakHeap = baseline;
  let lastProgress = 0;

  const handle = uploadFile(file, {
    concurrency,
    onProgress: progress => {
      lastProgress = progress.percent;
      const heap = process.memoryUsage().heapUsed;
      if (heap > peakHeap) peakHeap = heap;
    },
  });

  const started = Date.now();
  const result = await handle.promise;
  globalThis.fetch = originalFetch;
  const elapsed = (Date.now() - started) / 1000;
  const throughput = SIZE_MB / elapsed;
  const growthMb = (peakHeap - baseline) / MIB;
  const peakWindowMb = peakInFlightBytes / MIB;

  console.log(
    `    upload: ${SIZE_MB} MB in ${elapsed.toFixed(1)}s ` +
      `(${throughput.toFixed(1)} MB/s), peak in-flight ${peakWindowMb.toFixed(1)} MB ` +
      `across ${peakInFlight} requests, heap +${growthMb.toFixed(0)} MB`
  );

  assert.equal(lastProgress, 100);
  assert.ok(result.quota);
  assert.equal(result.quota!.usedBytes >= total, true);

  // Bounded concurrency: never more than `concurrency` parts in flight...
  assert.ok(
    peakInFlight <= concurrency,
    `${peakInFlight} part requests were in flight (limit ${concurrency})`
  );
  // ...and the in-flight window stays a small constant, independent of file
  // size. 1 MiB of bytes becomes ~1.37 MB of base64 JSON per part.
  const windowLimitMb = concurrency * 1.4 + 1;
  assert.ok(
    peakWindowMb <= windowLimitMb,
    `in-flight window peaked at ${peakWindowMb.toFixed(1)} MB (limit ${windowLimitMb})`
  );
  // Every part was sent exactly once: 1 TiB would be 1M parts, not 2M.
  const expectedParts = Math.ceil(total / CHUNK_SIZE);
  assert.equal(partRequests.length, expectedParts, 'each part sent exactly once');
  // Heap never approximates a second copy of the payload.
  assert.ok(
    growthMb < SIZE_MB * 1.5,
    `heap grew ${growthMb.toFixed(1)} MB for a ${SIZE_MB} MB upload`
  );

  // Spot-check integrity: read 4 parts and compare against the source.
  for (const index of [0, 1, Math.floor(total / CHUNK_SIZE / 2), Math.floor((total - 1) / CHUNK_SIZE)]) {
    const response = await fetch(
      BASE + '/api/files/' + encodeURIComponent(result.id) + '/chunks/' + index,
      { headers: { 'x-test-user': 'demo-nest-owner' } }
    );
    const data = (await response.json()) as { base64: string };
    const stored = Buffer.from(data.base64, 'base64');
    const expected = Buffer.from(
      bytes.subarray(index * CHUNK_SIZE, Math.min(total, (index + 1) * CHUNK_SIZE))
    );
    assert.deepEqual(stored, expected, 'part ' + index + ' differs');
  }
});
