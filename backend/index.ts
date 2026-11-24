import { router, json, error, requireAuth, db, storage } from '@appdeploy/sdk';
import {
  CHUNK_SIZE,
  MAX_FILE_CHUNKS,
  MAX_FILE_SIZE,
  MAX_PARTS_PER_REQUEST,
  MAX_RECORD_BYTES,
  MAX_RECORD_COUNT,
  QUOTA_BYTES,
  UPLOAD_STALE_MS,
  formatBytes,
  partCountFor,
  publicLimits,
} from './limits';
import {
  adjustRecords,
  commitReservation,
  mutateUsage,
  quotaSnapshot,
  readUsage,
  recordBudgetExceeded,
  releaseCommitted,
  releaseReservation,
  reserveBytes,
  usageTableFor,
} from './quota';
import {
  RESUME_WINDOW,
  accountProgressTotals,
  backfillLegacyParts,
  deleteProgress,
  markParts,
  missingInWindow,
  progressTableFor,
  readBitmap,
  summarize,
} from './parts';
import { deleteChunksFor, deleteStoredParts } from './chunks';

type RequestContext = {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  user?: { userId: string };
};

type RecordInput = {
  kind?: string;
  title?: string;
  content?: string;
  folder?: string;
  tags?: unknown;
};

type FileStartInput = {
  name?: string;
  size?: number;
  mimeType?: string;
  folder?: string;
  tags?: unknown;
  lastModified?: number;
};

type ChunkBatchInput = {
  parts?: unknown;
};

const BASE64_CHUNK_LIMIT = Math.ceil(CHUNK_SIZE / 3) * 4 + 8;

function safeUserKey(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}

function tableFor(ctx: RequestContext): string {
  return 'vault_' + safeUserKey(ctx.user!.userId);
}

function usageTable(ctx: RequestContext): string {
  return usageTableFor(safeUserKey(ctx.user!.userId));
}

function progressTable(ctx: RequestContext): string {
  return progressTableFor(safeUserKey(ctx.user!.userId));
}

/**
 * Load the authoritative part bitmap for a file, converting legacy records that
 * stored parts as a plain `uploadedChunks` array.
 */
async function loadBitmap(
  ctx: RequestContext,
  id: string,
  record: Record<string, unknown>
): Promise<Uint8Array> {
  const totalParts = Number(record.expectedChunks) || 0;
  const legacy = Array.isArray(record.uploadedChunks)
    ? record.uploadedChunks.filter((value): value is number =>
        Number.isInteger(value)
      )
    : [];

  if (legacy.length) {
    await backfillLegacyParts(progressTable(ctx), id, legacy, totalParts);
  }
  return readBitmap(progressTable(ctx), id, totalParts);
}

function filePath(ctx: RequestContext, id: string, index: number): string {
  return storagePath(safeUserKey(ctx.user!.userId), id, index);
}

function storagePath(userKey: string, id: string, index: number): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return 'users/' + userKey + '/files/' + safeId + '/' + index + '.part';
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim().slice(0, 32))
    .filter(Boolean)
    .slice(0, 10);
}

function validText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function validateJson(kind: string, content: string): boolean {
  if (kind !== 'json') return true;
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function getRecord(
  ctx: RequestContext,
  id: string
): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const rows = await db.get<Record<string, unknown>>(tableFor(ctx), [id]);
  return rows[0] ?? null;
}

async function listRecords(ctx: RequestContext) {
  const page = await db.list<Record<string, unknown>>(tableFor(ctx), {
    limit: 50,
    nextToken: ctx.query.nextToken || undefined,
    appdeploy_system_id: true,
  });

  const items = page.items.map(item => {
    const { __appdeploy_ddb_id, uploadedChunks, ...record } = item;
    const received = Number(record.receivedParts) || 0;
    const expected = Number(record.expectedChunks) || 0;
    return {
      ...record,
      id: __appdeploy_ddb_id,
      // Progress numbers only; the full part list is never shipped in a listing.
      uploadedChunks: undefined,
      receivedParts: received,
      expectedChunks: expected,
      status:
        record.status === 'uploading' && received === expected && expected > 0
          ? 'uploading'
          : record.status,
    };
  });

  return json({ items, nextToken: page.nextToken || null });
}

async function createRecord(ctx: RequestContext) {
  const input = ctx.body as RecordInput;
  const kind = input?.kind;
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const content = input?.content;
  const folder =
    typeof input?.folder === 'string' ? input.folder.trim().slice(0, 60) : '';

  if (kind !== 'note' && kind !== 'json') {
    return error('Choose either a note or a JSON record.', 400);
  }
  if (!title || title.length > 120) {
    return error('A title between 1 and 120 characters is required.', 400);
  }
  if (!validText(content, MAX_RECORD_BYTES)) {
    return error(
      'This record is too large. The maximum is ' +
        formatBytes(MAX_RECORD_BYTES) +
        '.',
      413
    );
  }
  if (!validateJson(kind, content)) {
    return error(
      'The JSON is invalid. Check the brackets, commas and quotation marks.',
      400
    );
  }

  const usage = await readUsage(usageTable(ctx));
  if (recordBudgetExceeded(usage)) {
    return error(
      'You have reached the ' +
        MAX_RECORD_COUNT.toLocaleString() +
        ' item limit for notes and records. Remove some items to add more.',
      409
    );
  }

  const contentBytes = byteLength(content);
  if (usage.usedBytes + contentBytes > QUOTA_BYTES) {
    return error('This record would exceed your 1 TB vault quota.', 413);
  }

  const now = new Date().toISOString();
  const ids = await db.add(tableFor(ctx), [
    {
      kind,
      title,
      content,
      folder,
      tags: cleanTags(input.tags),
      size: contentBytes,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  if (!ids[0])
    return error('The record could not be saved. Please try again.', 500);

  await adjustRecords(usageTable(ctx), 1, contentBytes);
  return json({ id: ids[0], saved: true }, 201);
}

async function updateRecord(ctx: RequestContext) {
  const input = ctx.body as RecordInput;
  const id = ctx.params.id;
  const existing = await getRecord(ctx, id);

  if (!existing) return error('This item no longer exists.', 404);

  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const content = input?.content;
  const folder =
    typeof input?.folder === 'string' ? input.folder.trim().slice(0, 60) : '';

  if (!title || title.length > 120) {
    return error('A title between 1 and 120 characters is required.', 400);
  }
  if (!validText(content, MAX_RECORD_BYTES)) {
    return error(
      'This record is too large. The maximum is ' +
        formatBytes(MAX_RECORD_BYTES) +
        '.',
      413
    );
  }
  if (!validateJson(String(existing.kind), content)) {
    return error(
      'The JSON is invalid. Check the brackets, commas and quotation marks.',
      400
    );
  }

  const previousBytes = Number(existing.size) || 0;
  const nextBytes = byteLength(content);

  const changed = await db.tx.update(
    tableFor(ctx),
    [
      {
        id,
        record: {
          title,
          content,
          folder,
          tags: cleanTags(input.tags),
          size: nextBytes,
          updatedAt: new Date().toISOString(),
        },
      },
    ],
    { patch: true }
  );

  if (!changed[0])
    return error(
      'The record could not be updated. Refresh and try again.',
      409
    );

  if (nextBytes !== previousBytes) {
    await adjustRecords(usageTable(ctx), 0, nextBytes - previousBytes);
  }
  return json({ saved: true });
}

async function deleteRecord(ctx: RequestContext) {
  const id = ctx.params.id;
  const record = await getRecord(ctx, id);
  if (!record) return json({ deleted: true });

  const usageTableName = usageTable(ctx);

  if (record.kind === 'file') {
    // Measure before removing: the bitmap is the authority on bytes occupied.
    const bitmap = await loadBitmap(ctx, id, record);
    const measured = summarize(bitmap, Number(record.expectedChunks) || 0, Number(record.size) || 0);
    const freed = measured.received > 0 ? measured.bytes : Number(record.size) || 0;

    const chunkRemoval = await deleteChunksFor(
      safeUserKey(ctx.user!.userId),
      id,
      async () => {
        const indexes: number[] = [];
        const total = bitmap.length * 8;
        for (let index = 0; index < total; index += 1) {
          if (bitmap[index >> 3] & (1 << (index & 7))) indexes.push(index);
        }
        return indexes;
      }
    );
    const index = await deleteProgress(progressTable(ctx), id);
    if (index.failed) {
      return error(
        'The file index could not be fully removed. Please retry.',
        500
      );
    }
    if (chunkRemoval.failed) {
      return error(
        'The file data could not be fully removed. Please retry.',
        500
      );
    }

    const wasReady = record.status === 'ready';
    if (wasReady) {
      await releaseCommitted(usageTableName, freed, 1);
    } else {
      await mutateUsage(usageTableName, current => ({
        reservedBytes: -Math.min(current.reservedBytes, Number(record.size) || 0),
      }));
    }
  } else {
    const freedBytes = Number(record.size) || 0;
    await adjustRecords(usageTableName, -1, -freedBytes);
  }

  const deleted = await db.delete(tableFor(ctx), [id]);
  if (!deleted[0])
    return error('The item could not be deleted. Please retry.', 500);
  return json({ deleted: true });
}

async function startFileUpload(ctx: RequestContext) {
  const input = ctx.body as FileStartInput;
  const name =
    typeof input?.name === 'string' ? input.name.trim().slice(0, 255) : '';
  const size = Number(input?.size);
  const mimeType =
    typeof input?.mimeType === 'string'
      ? input.mimeType.slice(0, 120)
      : 'application/octet-stream';
  const folder =
    typeof input?.folder === 'string' ? input.folder.trim().slice(0, 60) : '';

  if (!name) return error('Choose a file with a valid name.', 400);
  if (!Number.isSafeInteger(size) || size < 0) {
    return error('The file size could not be read. Please try again.', 400);
  }
  if (size > MAX_FILE_SIZE) {
    return error(
      'A single file cannot be larger than your ' +
        formatBytes(MAX_FILE_SIZE) +
        ' vault.',
      413
    );
  }

  // Reserve quota before touching storage so parallel uploads cannot overshoot.
  const reservation = await reserveBytes(usageTable(ctx), size);
  if (!reservation.ok) return error(reservation.message, 413);

  const expectedChunks = partCountFor(size);
  if (expectedChunks > MAX_FILE_CHUNKS) {
    await releaseReservation(usageTable(ctx), size);
    return error('This file needs more parts than the vault supports.', 413);
  }

  const now = new Date().toISOString();
  const ids = await db.add(tableFor(ctx), [
    {
      kind: 'file',
      title: name,
      name,
      size,
      mimeType: mimeType || 'application/octet-stream',
      folder,
      tags: cleanTags(input.tags),
      expectedChunks,
      receivedParts: 0,
      receivedBytes: 0,
      recentParts: [],
      status: 'uploading',
      createdAt: now,
      updatedAt: now,
    },
  ]);

  if (!ids[0]) {
    await releaseReservation(usageTable(ctx), size);
    return error('The upload could not be started. Please try again.', 500);
  }

  return json(
    {
      id: ids[0],
      expectedChunks,
      chunkSize: CHUNK_SIZE,
      quota: quotaSnapshot(reservation.usage),
    },
    201
  );
}

function coerceIndexes(value: unknown, expectedChunks: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(entry => (typeof entry === 'number' ? entry : Number(entry)))
    .filter(
      entry =>
        Number.isInteger(entry) && entry >= 0 && entry < expectedChunks
    )
    .slice(0, expectedChunks);
}

/**
 * Upload one part. Metadata now travels in the body next to the base64 payload,
 * so a client can fingerprint parts and the server can keep an accurate byte
 * count without an extra round trip.
 */
async function uploadFileChunk(ctx: RequestContext) {
  const id = ctx.params.id;
  const index = Number(ctx.params.index);
  const input = ctx.body as { base64?: unknown; bytes?: unknown };

  const record = await getRecord(ctx, id);
  if (!record || record.kind !== 'file') return error('Upload not found.', 404);
  if (record.status !== 'uploading')
    return error('This upload is no longer active.', 409);

  const expectedChunks = Number(record.expectedChunks) || 0;
  if (!Number.isInteger(index) || index < 0 || index >= expectedChunks) {
    return error('Invalid upload part.', 400);
  }

  if (
    typeof input?.base64 !== 'string' ||
    input.base64.length > BASE64_CHUNK_LIMIT ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
  ) {
    return error('The upload part is invalid. Please retry this part.', 400);
  }

  // Work out the expected size of this part from the declared file size so a
  // truncated/oversized part is rejected rather than silently corrupting data.
  const declaredSize = Number(record.size) || 0;
  const offset = index * CHUNK_SIZE;
  const expectedBytes = Math.max(
    0,
    Math.min(CHUNK_SIZE, declaredSize - offset)
  );
  const actualBytes = Math.floor((input.base64.length * 3) / 4) -
    (input.base64.endsWith('==') ? 2 : input.base64.endsWith('=') ? 1 : 0);

  if (expectedBytes >= 0 && actualBytes !== expectedBytes) {
    return error(
      'This part has the wrong size (' +
        actualBytes +
        ' bytes, expected ' +
        expectedBytes +
        '). Please retry it.',
      400
    );
  }

  const results = await storage.write([
    {
      path: filePath(ctx, id, index),
      content: input.base64,
      contentType: 'application/octet-stream',
    },
  ]);

  if (!results[0])
    return error('This part could not be stored. Please retry.', 500);

  const totalParts = expectedChunks;
  const declared = Number(record.size) || 0;
  await markParts(progressTable(ctx), id, [index], totalParts);
  const bitmap = await readBitmap(progressTable(ctx), id, totalParts);
  const progress = summarize(bitmap, totalParts, declared);

  await db.tx.update(
    tableFor(ctx),
    [
      {
        id,
        record: {
          receivedParts: progress.received,
          receivedBytes: progress.bytes,
          updatedAt: new Date().toISOString(),
        },
      },
    ],
    { patch: true }
  );

  return json({
    uploaded: true,
    index,
    bytes: actualBytes,
    receivedParts: progress.received,
    expectedChunks,
  });
}

/** Resume support: which parts of this upload still need sending? */
async function getUploadStatus(ctx: RequestContext) {
  const id = ctx.params.id;
  const record = await getRecord(ctx, id);
  if (!record || record.kind !== 'file') return error('Upload not found.', 404);

  const expectedChunks = Number(record.expectedChunks) || 0;
  const bitmap = await loadBitmap(ctx, id, record);
  const declared = Number(record.size) || 0;
  const progress = summarize(bitmap, expectedChunks, declared);

  // `from` lets a client resume without downloading a million indexes: it asks
  // for the first window that still contains a gap.
  const from = Math.max(0, Math.min(Number(ctx.query.from) || 0, expectedChunks));
  const to = Math.min(expectedChunks, from + RESUME_WINDOW);

  return json({
    id,
    status: record.status,
    expectedChunks,
    chunkSize: CHUNK_SIZE,
    receivedParts: progress.received,
    receivedBytes: progress.bytes,
    nextMissing: progress.nextMissing,
    window: { from, to },
    missing: missingInWindow(bitmap, from, to),
  });
}

/**
 * Batch alternative to one-request-per-part. Cuts the round-trip count by the
 * batch factor for clients that prefer fewer, larger requests.
 */
async function uploadChunkBatch(ctx: RequestContext) {
  const id = ctx.params.id;
  const record = await getRecord(ctx, id);
  if (!record || record.kind !== 'file') return error('Upload not found.', 404);
  if (record.status !== 'uploading')
    return error('This upload is no longer active.', 409);

  const input = ctx.body as ChunkBatchInput;
  const expectedChunks = Number(record.expectedChunks) || 0;
  const declaredSize = Number(record.size) || 0;
  const parts = Array.isArray(input?.parts) ? input.parts : [];

  if (!parts.length)
    return error('Send at least one part in the batch.', 400);
  if (parts.length > MAX_PARTS_PER_REQUEST)
    return error(
      'At most ' + MAX_PARTS_PER_REQUEST + ' parts per batch.',
      413
    );

  const accepted: { index: number; size: number; base64: string }[] = [];
  for (const raw of parts) {
    const entry = raw as { index?: unknown; base64?: unknown };
    const index = Number(entry.index);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expectedChunks
    ) {
      return error('Invalid part index in the batch.', 400);
    }
    if (
      typeof entry.base64 !== 'string' ||
      entry.base64.length > BASE64_CHUNK_LIMIT ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64)
    ) {
      return error('Invalid part payload in the batch.', 400);
    }
    const offset = index * CHUNK_SIZE;
    const expectedBytes = Math.max(
      0,
      Math.min(CHUNK_SIZE, declaredSize - offset)
    );
    const actualBytes =
      Math.floor((entry.base64.length * 3) / 4) -
      (entry.base64.endsWith('==') ? 2 : entry.base64.endsWith('=') ? 1 : 0);
    if (actualBytes !== expectedBytes) {
      return error('Part ' + index + ' has the wrong size.', 400);
    }
    accepted.push({ index, size: actualBytes, base64: entry.base64 });
  }

  const written = await storage.write(
    accepted.map(part => ({
      path: filePath(ctx, id, part.index),
      content: part.base64,
      contentType: 'application/octet-stream',
    }))
  );
  if (written.some(ok => !ok)) {
    return error('One or more parts could not be stored. Please retry.', 500);
  }

  await markParts(
    progressTable(ctx),
    id,
    accepted.map(part => part.index),
    expectedChunks
  );

  const bitmap = await readBitmap(progressTable(ctx), id, expectedChunks);
  const progress = summarize(bitmap, expectedChunks, declaredSize);
  await db.tx.update(
    tableFor(ctx),
    [
      {
        id,
        record: {
          receivedParts: progress.received,
          receivedBytes: progress.bytes,
          updatedAt: new Date().toISOString(),
        },
      },
    ],
    { patch: true }
  );

  return json({
    uploaded: accepted.length,
    receivedParts: progress.received,
    expectedChunks,
  });
}

async function completeFileUpload(ctx: RequestContext) {
  const id = ctx.params.id;
  const record = await getRecord(ctx, id);

  if (!record || record.kind !== 'file') return error('Upload not found.', 404);
  if (record.status === 'ready') {
    return json({ complete: true, quota: quotaSnapshot(await readUsage(usageTable(ctx))) });
  }

  const expected = Number(record.expectedChunks) || 0;
  const declaredSize = Number(record.size) || 0;

  const bitmap = await loadBitmap(ctx, id, record);
  const progress = summarize(bitmap, expected, declaredSize);

  if (progress.received !== expected) {
    return error(
      'Some file parts are missing (' +
        (expected - progress.received) +
        ' of ' +
        expected +
        '). Retry the upload before completing it.',
      409
    );
  }

  // Guard against a short upload: every declared byte must be accounted for.
  if (progress.bytes !== declaredSize) {
    return error(
      'Only ' +
        progress.bytes +
        ' of ' +
        declaredSize +
        ' bytes were received. Please re-upload the missing parts.',
      409
    );
  }

  const changed = await db.tx.update(
    tableFor(ctx),
    [
      {
        id,
        record: {
          status: 'ready',
          receivedParts: progress.received,
          receivedBytes: progress.bytes,
          uploadedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    ],
    { patch: true }
  );

  if (!changed[0])
    return error('The file could not be finalized. Please retry.', 500);

  const usage = await commitReservation(usageTable(ctx), declaredSize);
  return json({ complete: true, quota: quotaSnapshot(usage) });
}

async function readFileChunk(ctx: RequestContext) {
  const id = ctx.params.id;
  const index = Number(ctx.params.index);
  const record = await getRecord(ctx, id);

  if (!record || record.kind !== 'file' || record.status !== 'ready') {
    return error('This file is not available to download.', 404);
  }
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= Number(record.expectedChunks)
  ) {
    return error('Invalid file part.', 400);
  }

  const result = await storage.read([filePath(ctx, id, index)]);
  if (!result[0]?.content)
    return error('A file part could not be read. Please retry.', 500);
  return json({
    base64: result[0].content,
    mimeType: record.mimeType || 'application/octet-stream',
  });
}

/**
 * Bulk-read a contiguous run of parts in one response. The downloader uses this
 * to avoid one round trip per MiB when reassembling a large file.
 */
async function readFileChunkBatch(ctx: RequestContext) {
  const id = ctx.params.id;
  const record = await getRecord(ctx, id);

  if (!record || record.kind !== 'file' || record.status !== 'ready') {
    return error('This file is not available to download.', 404);
  }

  const expected = Number(record.expectedChunks) || 0;
  const body = ctx.body as { indexes?: unknown };
  const indexes = coerceIndexes(body?.indexes, expected);
  if (!indexes.length) return error('No valid parts requested.', 400);
  if (indexes.length > MAX_PARTS_PER_REQUEST) {
    return error('At most ' + MAX_PARTS_PER_REQUEST + ' parts per request.', 413);
  }

  const results = await storage.read(
    indexes.map(index => filePath(ctx, id, index))
  );

  const parts = indexes.map((index, position) => {
    const content = results[position]?.content;
    return content
      ? { index, base64: content }
      : { index, base64: null };
  });

  if (parts.some(part => !part.base64)) {
    return error('Some file parts could not be read. Please retry.', 500);
  }

  return json({
    parts,
    mimeType: record.mimeType || 'application/octet-stream',
  });
}

/** Everything a client needs to boot: limits plus current usage. */
async function vaultStatus(ctx: RequestContext) {
  const usage = await readUsage(usageTable(ctx));
  return json({
    limits: publicLimits(),
    quota: quotaSnapshot(usage),
  });
}

/**
 * Recompute usage from authoritative data.
 *
 * The record table is the authority for committed bytes: `POST /complete` only
 * succeeds when the stored bitmap covers every declared byte, so a ready file's
 * declared size is exactly what it occupies. The progress table is additionally
 * scanned to report how many parts exist, which exposes orphaned shards.
 */
async function reconcileVault(ctx: RequestContext) {
  const totals = await accountProgressTotals(progressTable(ctx));

  let fileBytes = 0;
  let fileCount = 0;
  let recordCount = 0;
  let recordBytes = 0;
  let nextToken: string | undefined;
  let guard = 0;

  do {
    const page = await db.list<Record<string, unknown>>(tableFor(ctx), {
      limit: 1000,
      nextToken,
    });
    for (const item of page.items) {
      if (item.kind === 'file') {
        fileCount += 1;
        if (item.status === 'ready') fileBytes += Number(item.size) || 0;
      } else {
        recordCount += 1;
        recordBytes += Number(item.size) || 0;
      }
    }
    nextToken = page.nextToken || undefined;
    guard += 1;
    if (guard > 1_000) break;
  } while (nextToken);

  const usage = await readUsage(usageTable(ctx));
  const drifted = usage.usedBytes !== fileBytes + recordBytes;

  const updated = await mutateUsage(usageTable(ctx), () => ({
    usedBytes: fileBytes + recordBytes - usage.usedBytes,
    reservedBytes: -usage.reservedBytes,
    fileCount: fileCount - usage.fileCount,
    recordCount: recordCount - usage.recordCount,
  }));

  return json({
    reconciled: true,
    drifted,
    parts: totals.parts,
    filesWithParts: totals.files.size,
    quota: quotaSnapshot(updated),
  });
}

/**
 * Housekeeping: release reservations held by uploads that were abandoned long
 * enough ago that the client is certainly gone.
 */
async function sweepStaleUploads(ctx: RequestContext) {
  const cutoff = Date.now() - UPLOAD_STALE_MS;
  let nextToken: string | undefined;
  let reclaimedBytes = 0;
  let reclaimed = 0;
  let guard = 0;

  do {
    const page = await db.list<Record<string, unknown>>(tableFor(ctx), {
      limit: 1000,
      nextToken,
      appdeploy_system_id: true,
    });
    for (const item of page.items) {
      if (item.kind !== 'file' || item.status === 'ready') continue;
      const updated = Date.parse(String(item.updatedAt || item.createdAt || 0));
      if (!Number.isFinite(updated) || updated > cutoff) continue;
      reclaimedBytes += Number(item.size) || 0;
      reclaimed += 1;
      const id = String(item.__appdeploy_ddb_id || '');
      if (!id) continue;
      const bitmap = await loadBitmap(ctx, id, item);
      const known: number[] = [];
      for (let index = 0; index < bitmap.length * 8; index += 1) {
        if (bitmap[index >> 3] & (1 << (index & 7))) known.push(index);
      }
      await deleteProgress(progressTable(ctx), id);
      const removal = await deleteStoredParts(
        safeUserKey(ctx.user!.userId),
        id,
        known
      );
      if (removal.failed) continue;
      await db.delete(tableFor(ctx), [id]);
    }
    nextToken = page.nextToken || undefined;
    guard += 1;
    if (guard > 1_000) break;
  } while (nextToken);

  if (reclaimed) {
    await mutateUsage(usageTable(ctx), current => ({
      reservedBytes: -Math.min(current.reservedBytes, reclaimedBytes),
    }));
  }

  return json({
    reclaimed,
    reclaimedBytes,
    quota: quotaSnapshot(await readUsage(usageTable(ctx))),
  });
}

export const handler = router({
  'GET /api/vault': [requireAuth(), async ctx => vaultStatus(ctx)],
  'POST /api/vault/reconcile': [requireAuth(), async ctx => reconcileVault(ctx)],
  'POST /api/vault/sweep': [requireAuth(), async ctx => sweepStaleUploads(ctx)],
  'GET /api/records': [requireAuth(), async ctx => listRecords(ctx)],
  'POST /api/records': [requireAuth(), async ctx => createRecord(ctx)],
  'PUT /api/records/:id': [requireAuth(), async ctx => updateRecord(ctx)],
  'DELETE /api/records/:id': [requireAuth(), async ctx => deleteRecord(ctx)],
  'POST /api/files/start': [requireAuth(), async ctx => startFileUpload(ctx)],
  'GET /api/files/:id/status': [
    requireAuth(),
    async ctx => getUploadStatus(ctx),
  ],
  // Literal segments must be registered before ':index' or 'read' would be
  // captured as a part number.
  'POST /api/files/:id/chunks': [
    requireAuth(),
    async ctx => uploadChunkBatch(ctx),
  ],
  'POST /api/files/:id/chunks/read': [
    requireAuth(),
    async ctx => readFileChunkBatch(ctx),
  ],
  'POST /api/files/:id/chunks/:index': [
    requireAuth(),
    async ctx => uploadFileChunk(ctx),
  ],
  'POST /api/files/:id/complete': [
    requireAuth(),
    async ctx => completeFileUpload(ctx),
  ],
  'GET /api/files/:id/chunks/:index': [
    requireAuth(),
    async ctx => readFileChunk(ctx),
  ],
});

export { storagePath, MAX_RECORD_COUNT };
