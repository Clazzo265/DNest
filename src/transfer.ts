/**
 * Transfer engine for the 1 TB vault.
 *
 * The previous client sent one part at a time, waited for the response, and
 * buffered whole files in memory on download. That cannot reach terabyte scale:
 * a 1 TiB upload is 1,048,576 sequential round trips, and a download would try
 * to allocate a 1 TiB `Uint8Array`.
 *
 * This module provides:
 *  - bounded-concurrency uploads with per-part retry and exponential backoff,
 *  - resume from server-derived state (no client-side bookkeeping required),
 *  - constant-memory downloads via the File System Access API when available,
 *  - batched part reads so the request count drops by the batch factor,
 *  - honest capability reporting so the UI can warn when a browser cannot stream.
 */

import { api } from '@appdeploy/client';

export type Limits = {
  quotaBytes: number;
  chunkSize: number;
  maxFileSize: number;
  maxFileChunks: number;
  maxRecordBytes: number;
  maxRecordCount: number;
  maxPartsPerRequest: number;
  recommendedConcurrency: number;
  uploadStaleMs: number;
};

export type Quota = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  remainingBytes: number;
  percentUsed: number;
  fileCount: number;
  recordCount: number;
  recordLimit: number;
  updatedAt: string;
};

export type TransferProgress = {
  partsDone: number;
  partsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  percent: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  phase: 'starting' | 'encoding' | 'sending' | 'finalizing' | 'done';
};

export type UploadHandle = {
  id?: string;
  promise: Promise<{ id: string; quota: Quota | null }>;
  cancel: () => void;
};

const DEFAULT_CONCURRENCY = 6;
const BATCH_READ_SIZE = 8;
const MAX_PART_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 400;

/** Errors worth retrying: network faults, throttling, and server faults. */
function isRetryable(error: unknown): boolean {
  const candidate = error as {
    response?: { status?: number };
    status?: number;
    message?: string;
  };
  const status = candidate?.response?.status ?? candidate?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  const message = String(candidate?.message || '').toLowerCase();
  return (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('failed to fetch') ||
    message.includes('load failed')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function errorMessage(value: unknown): string {
  if (value && typeof value === 'object') {
    const candidate = value as {
      message?: string;
      response?: { data?: { error?: string; message?: string } };
    };
    return (
      candidate.response?.data?.error ||
      candidate.response?.data?.message ||
      candidate.message ||
      'Something went wrong. Please try again.'
    );
  }
  return 'Something went wrong. Please try again.';
}

// ---- base64 ---------------------------------------------------------------
// Chunked so a 1 MiB part never risks a call-stack overflow from spread
// operators on large arrays, and so encoding stays linear.

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    binary += String.fromCharCode.apply(
      null,
      slice as unknown as number[]
    );
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error('The file could not be read from disk.'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.readAsDataURL(blob);
  });
}

// ---- formatting -----------------------------------------------------------

export function formatBytes(bytes = 0): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes < 1024 ** 4) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  return (bytes / 1024 ** 4).toFixed(2) + ' TB';
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return Math.ceil(seconds) + 's';
  if (seconds < 3600) return Math.ceil(seconds / 60) + ' min';
  if (seconds < 86400) return (seconds / 3600).toFixed(1) + ' h';
  return (seconds / 86400).toFixed(1) + ' days';
}

// ---- vault state ----------------------------------------------------------

export async function fetchVault(): Promise<{ limits: Limits; quota: Quota }> {
  const response = await api.get('/api/vault');
  return response.data as { limits: Limits; quota: Quota };
}

export async function reconcileVault(): Promise<{ quota: Quota; parts: number }> {
  const response = await api.post('/api/vault/reconcile', {});
  return response.data as { quota: Quota; parts: number };
}

export async function sweepVault(): Promise<{
  reclaimed: number;
  reclaimedBytes: number;
  quota: Quota;
}> {
  const response = await api.post('/api/vault/sweep', {});
  return response.data as {
    reclaimed: number;
    reclaimedBytes: number;
    quota: Quota;
  };
}

// ---- upload ---------------------------------------------------------------

type StartResponse = {
  id: string;
  expectedChunks: number;
  chunkSize: number;
  quota: Quota;
};

async function startUpload(file: File): Promise<StartResponse> {
  const response = await api.post('/api/files/start', {
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    folder: '',
    tags: [],
    lastModified: file.lastModified,
  });
  return response.data as StartResponse;
}

type StatusResponse = {
  expectedChunks: number;
  receivedParts: number;
  nextMissing: number;
  window: { from: number; to: number };
  missing: number[];
};

/** Ask the server which parts are still missing, in bounded windows. */
async function partStatus(id: string, from: number): Promise<StatusResponse> {
  const response = await api.get(
    '/api/files/' + encodeURIComponent(id) + '/status',
    { params: { from: String(from), limit: '1' } }
  );
  return response.data as StatusResponse;
}

/**
 * Upload a file with bounded concurrency and resume support.
 *
 * Returns a handle immediately so the UI can show progress and cancel. Passing
 * `resumeId` continues an existing upload instead of creating a second record.
 */
export function uploadFile(
  file: File,
  options: {
    concurrency?: number;
    resumeId?: string;
    onProgress?: (progress: TransferProgress) => void;
    onStarted?: (id: string, quota: Quota) => void;
    onQuota?: (quota: Quota) => void;
  } = {}
): UploadHandle {
  const controller = new AbortController();
  const started = performance.now();

  let cancelled = false;
  let uploadId = options.resumeId || '';
  let quota: Quota | null = null;

  const promise = (async () => {
    let expectedChunks = 0;
    let chunkSize = 0;

    if (uploadId) {
      const status = await api.get(
        '/api/files/' + encodeURIComponent(uploadId) + '/status',
        { params: { from: '0', limit: '1' } }
      );
      expectedChunks = Number(status.data.expectedChunks) || 0;
      chunkSize = Number(status.data.chunkSize) || 0;
      uploadId = String(status.data.id);
    } else {
      const start = await startUpload(file);
      uploadId = start.id;
      expectedChunks = start.expectedChunks;
      chunkSize = start.chunkSize;
      quota = start.quota;
      options.onStarted?.(uploadId, start.quota);
    }

    const totalBytes = file.size;
    let bytesDone = 0;
    let partsDone = 0;
    let lastReport = 0;

    const report = (phase: TransferProgress['phase']) => {
      const now = performance.now();
      // Throttle UI updates; a 1M-part upload would otherwise flood React.
      if (phase === 'sending' && now - lastReport < 200) return;
      lastReport = now;
      const elapsed = Math.max(0.001, (now - started) / 1000);
      const rate = bytesDone / elapsed;
      const remaining = Math.max(0, totalBytes - bytesDone);
      options.onProgress?.({
        partsDone,
        partsTotal: expectedChunks,
        bytesDone,
        bytesTotal: totalBytes,
        percent:
          totalBytes > 0
            ? Math.min(100, Math.round((bytesDone / totalBytes) * 100))
            : 100,
        bytesPerSecond: rate,
        etaSeconds: rate > 0 ? remaining / rate : null,
        phase,
      });
    };

    report('starting');

    // Build the work from the server's view of what is missing. This is what
    // makes resume work after a crash, a reload or a network drop: the client
    // never trusts its own bookkeeping.
    let cursor = 0;
    const queue: number[] = [];
    let exhausted = false;

    /**
     * Pull the next window of missing parts. Turns are serialised with a mutex
     * so concurrent workers cannot both advance the cursor and skip a window.
     */
    let refillLock: Promise<void> = Promise.resolve();
    async function refill(): Promise<void> {
      const previous = refillLock;
      let release: () => void = () => {};
      refillLock = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;
      try {
        if (exhausted || cursor >= expectedChunks) {
          exhausted = true;
          return;
        }
        const page = await partStatus(uploadId, cursor);
        const to = Math.max(page.window.to, cursor + 1);
        for (const index of page.missing) {
          if (!queue.includes(index)) queue.push(index);
        }
        cursor = to;
        if (cursor >= expectedChunks) exhausted = true;
      } finally {
        release();
      }
    }

    await refill();

    let lastError: unknown = null;

    async function worker(): Promise<void> {
      for (;;) {
        if (cancelled || controller.signal.aborted) return;
        if (!queue.length) {
          if (exhausted) return;
          await refill();
          // Another worker may have pushed work, so re-check rather than exit.
          if (!queue.length) {
            if (exhausted) return;
            continue;
          }
        }
        const index = queue.shift();
        if (index === undefined) return;

        const offset = index * chunkSize;
        const part = file.slice(
          Math.min(offset, file.size),
          Math.min(file.size, offset + chunkSize)
        );

        let attempt = 0;
        for (;;) {
          if (cancelled) return;
          try {
            const base64 = await blobToBase64(part);
            report('encoding');
            await api.post(
              '/api/files/' + encodeURIComponent(uploadId) + '/chunks/' + index,
              { base64, bytes: part.size },
              { signal: controller.signal }
            );
            partsDone += 1;
            bytesDone += part.size;
            report('sending');
            break;
          } catch (error) {
            lastError = error;
            attempt += 1;
            if (cancelled) return;
            if (attempt >= MAX_PART_ATTEMPTS || !isRetryable(error)) {
              throw new Error(
                'Upload stopped at part ' +
                  index +
                  ' after ' +
                  attempt +
                  ' attempts: ' +
                  errorMessage(error)
              );
            }
            await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          }
        }
      }
    }

    const concurrency = Math.max(1, options.concurrency || DEFAULT_CONCURRENCY);
    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(1, expectedChunks)) },
      () => worker()
    );
    await Promise.all(workers);

    if (cancelled) {
      throw new Error(
        'Upload cancelled. The parts already sent are kept, so you can resume.'
      );
    }
    if (lastError && partsDone === 0) throw lastError;

    // Never claim success on trust: confirm the server holds every part.
    report('finalizing');
    let verified = await partStatus(uploadId, 0);
    let verificationPasses = 0;
    while (
      verified.receivedParts < verified.expectedChunks &&
      verificationPasses < 3 &&
      !cancelled
    ) {
      verificationPasses += 1;
      cursor = 0;
      exhausted = false;
      await refill();
      const retryWorkers = Array.from(
        { length: Math.min(concurrency, Math.max(1, expectedChunks)) },
        () => worker()
      );
      await Promise.all(retryWorkers);
      verified = await partStatus(uploadId, 0);
    }
    if (verified.receivedParts < verified.expectedChunks) {
      throw new Error(
        'Upload incomplete: the server has ' +
          verified.receivedParts +
          ' of ' +
          verified.expectedChunks +
          ' parts. Resume to continue from where it stopped.'
      );
    }

    const complete = await api.post(
      '/api/files/' + encodeURIComponent(uploadId) + '/complete',
      {}
    );
    quota = (complete.data as { quota: Quota }).quota ?? quota;
    if (quota) options.onQuota?.(quota);
    report('done');

    return { id: uploadId, quota };
  })();

  return {
    get id() {
      return uploadId;
    },
    promise,
    cancel: () => {
      cancelled = true;
      controller.abort();
    },
  };
}

// ---- download -------------------------------------------------------------

export type DownloadProgress = {
  partsDone: number;
  partsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  percent: number;
};

type DownloadPart = { index: number; base64: string };

async function readParts(
  id: string,
  indexes: number[],
  signal?: AbortSignal
): Promise<DownloadPart[]> {
  const response = await api.post(
    '/api/files/' + encodeURIComponent(id) + '/chunks/read',
    { indexes },
    { signal }
  );
  return (response.data as { parts: DownloadPart[] }).parts;
}

/** Capability detection drives how the UI can present large downloads. */
export function supportsStreamingSave(): boolean {
  return typeof (window as unknown as { showSaveFilePicker?: unknown })
    .showSaveFilePicker === 'function';
}

/**
 * Download a stored file.
 *
 * With the File System Access API the bytes go straight to disk batch by batch,
 * so memory stays flat regardless of file size - that is what makes a 1 TB file
 * downloadable at all. Without it, the browser must hold the file in memory, so
 * the caller is told the ceiling up front instead of failing halfway.
 */
export async function downloadFile(
  item: { id: string; name?: string; title: string; size?: number; mimeType?: string },
  options: {
    onProgress?: (progress: DownloadProgress) => void;
    signal?: AbortSignal;
  } = {}
): Promise<'streamed' | 'blob'> {
  const filename = item.name || item.title || 'download';

  const statusResponse = await api.get(
    '/api/files/' + encodeURIComponent(item.id) + '/status',
    { params: { from: '0', limit: '1' } }
  );
  const partsTotal = Number(statusResponse.data.expectedChunks) || 0;
  const chunkSize = Number(statusResponse.data.chunkSize) || 1024 * 1024;
  const bytesTotal = Number(item.size) || partsTotal * chunkSize;

  let bytesDone = 0;
  let partsDone = 0;
  const report = () => {
    options.onProgress?.({
      partsDone,
      partsTotal,
      bytesDone,
      bytesTotal,
      percent:
        bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0,
    });
  };
  report();

  const streamer = supportsStreamingSave()
    ? window as unknown as {
        showSaveFilePicker: (options: {
          suggestedName: string;
        }) => Promise<{
          createWritable: () => Promise<{
            write: (data: Uint8Array) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      }
    : null;

  if (streamer) {
    const handle = await streamer.showSaveFilePicker({
      suggestedName: filename,
    });
    const writable = await handle.createWritable();
    let written = 0;
    for (let start = 0; start < partsTotal; start += BATCH_READ_SIZE) {
      if (options.signal?.aborted) break;
      const indexes: number[] = [];
      for (
        let index = start;
        index < Math.min(partsTotal, start + BATCH_READ_SIZE);
        index += 1
      ) {
        indexes.push(index);
      }
      const parts = await readParts(item.id, indexes, options.signal);
      for (const part of parts) {
        const bytes = base64ToBytes(part.base64);
        // Never write past the declared size (a padded final part would
        // otherwise corrupt the file with trailing zeros).
        const allowed = bytesTotal - written;
        const slice = bytes.length > allowed ? bytes.subarray(0, allowed) : bytes;
        await writable.write(slice);
        written += slice.length;
        bytesDone += slice.length;
        partsDone += 1;
      }
      report();
    }
    await writable.close();
    report();
    return 'streamed';
  }

  // Fallback: assemble in memory. Fine for normal files, unsafe for huge ones.
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let start = 0; start < partsTotal; start += BATCH_READ_SIZE) {
    if (options.signal?.aborted) break;
    const indexes: number[] = [];
    for (
      let index = start;
      index < Math.min(partsTotal, start + BATCH_READ_SIZE);
      index += 1
    ) {
      indexes.push(index);
    }
    const parts = await readParts(item.id, indexes, options.signal);
    for (const part of parts) {
      const bytes = base64ToBytes(part.base64);
      chunks.push(bytes);
      total += bytes.length;
      bytesDone += bytes.length;
      partsDone += 1;
    }
    report();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const blob = new Blob([merged], {
    type: item.mimeType || 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'blob';
}

/** Practical ceiling for the non-streaming download path. */
export const BLOB_DOWNLOAD_SAFE_LIMIT = 512 * 1024 * 1024;

export function saveTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFilename(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .trim()
      .slice(0, 120) || 'untitled'
  );
}
