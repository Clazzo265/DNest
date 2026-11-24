/**
 * Download path tests: verifies the streaming writer saves exactly the bytes
 * that were stored, including the short final part, and that the non-streaming
 * fallback produces the same file.
 */
import '../.devtesting/dom.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { CHUNK_SIZE } from '../backend/limits';

const PORT = 9400 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
let server: ReturnType<typeof spawn>;
let dataDir = '';
let written: Buffer[] = [];
let savedName = '';

before(async () => {
  await import('../.devtesting/node-dom.mjs');
  execFileSync(process.execPath, ['.devtesting/link.mjs'], { cwd: process.cwd() });
  dataDir = await mkdtemp(join(tmpdir(), 'datanest-download-'));
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
        headers: { 'x-test-user': 'download-user' },
      });
      if (response.status < 500) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('harness did not start');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  (globalThis as any).__DATANEST_BASE__ = BASE;
  // jsdom lacks Blob.arrayBuffer in some versions; TextEncoder covers it.
  if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
    (Blob.prototype as any).arrayBuffer = function arrayBuffer(this: Blob) {
      return new Response(this).arrayBuffer();
    };
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

function makeBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) out[index] = (index * 31 + 7) & 0xff;
  return out;
}

async function storeFile(name: string, bytes: Uint8Array): Promise<string> {
  const { uploadFile } = await import('../src/transfer');
  const file = new File([bytes], name);
  const handle = uploadFile(file, { concurrency: 4 });
  const result = await handle.promise;
  return result.id;
}

test('streaming download writes byte-exact data with flat memory', async () => {
  const size = CHUNK_SIZE * 2 + 4321;
  const bytes = makeBytes(size);
  const id = await storeFile('stream.bin', bytes);

  const streamer = (window as any).showSaveFilePicker;
  written = [];
  (window as any).showSaveFilePicker = async (options: { suggestedName: string }) => {
    savedName = options.suggestedName;
    return {
      createWritable: async () => ({
        write: async (data: Uint8Array) => {
          written.push(Buffer.from(data));
        },
        close: async () => {},
      }),
    };
  };

  const { downloadFile } = await import('../src/transfer');
  let lastPercent = -1;
  const mode = await downloadFile(
    { id, name: 'stream.bin', title: 'stream.bin', size, mimeType: 'application/octet-stream' },
    { onProgress: progress => { lastPercent = progress.percent; } }
  );

  (window as any).showSaveFilePicker = streamer;

  assert.equal(mode, 'streamed');
  assert.equal(savedName, 'stream.bin');
  const result = Buffer.concat(written);
  assert.equal(result.length, size, 'no padding past the declared size');
  assert.deepEqual(result, Buffer.from(bytes));
  assert.equal(lastPercent, 100);
});

test('non-streaming download produces the same bytes', async () => {
  const size = CHUNK_SIZE + 99;
  const bytes = makeBytes(size);
  const id = await storeFile('fallback.bin', bytes);

  const original = (window as any).showSaveFilePicker;
  delete (window as any).showSaveFilePicker;

  let downloaded: Buffer | null = null;
  const documentAny = document as any;
  const createElement = documentAny.createElement.bind(documentAny);
  documentAny.createElement = (tag: string) => {
    const element = createElement(tag);
    if (tag === 'a') {
      element.click = () => {};
    }
    return element;
  };
  const originalBlob = (globalThis as any).Blob;
  (globalThis as any).Blob = class extends originalBlob {
    constructor(parts: any[], options: any) {
      super(parts, options);
      downloaded = Buffer.concat((parts as Uint8Array[]).map(p => Buffer.from(p)));
    }
  };

  const { downloadFile } = await import('../src/transfer');
  const mode = await downloadFile({
    id,
    name: 'fallback.bin',
    title: 'fallback.bin',
    size,
    mimeType: 'application/octet-stream',
  });

  (globalThis as any).Blob = originalBlob;
  documentAny.createElement = createElement;
  if (original) (window as any).showSaveFilePicker = original;

  assert.equal(mode, 'blob');
  assert.ok(downloaded);
  assert.deepEqual(downloaded, Buffer.from(bytes));
});
