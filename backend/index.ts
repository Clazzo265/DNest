import { router, json, error, requireAuth, db, storage } from '@appdeploy/sdk';

const CHUNK_SIZE = 1024 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_RECORD_BYTES = 180 * 1024;

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
};

function safeUserKey(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}

function tableFor(ctx: RequestContext): string {
  return 'vault_' + safeUserKey(ctx.user!.userId);
}

function filePath(ctx: RequestContext, id: string, index: number): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    'users/' +
    safeUserKey(ctx.user!.userId) +
    '/files/' +
    safeId +
    '/' +
    index +
    '.part'
  );
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

async function getRecord(
  ctx: RequestContext,
  id: string
): Promise<Record<string, unknown> | null> {
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
    const { __appdeploy_ddb_id, ...record } = item;
    return { ...record, id: __appdeploy_ddb_id };
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
    return error('This record is too large. The maximum is 180 KB.', 413);
  }
  if (!validateJson(kind, content)) {
    return error(
      'The JSON is invalid. Check the brackets, commas and quotation marks.',
      400
    );
  }

  const now = new Date().toISOString();
  const ids = await db.add(tableFor(ctx), [
    {
      kind,
      title,
      content,
      folder,
      tags: cleanTags(input.tags),
      createdAt: now,
      updatedAt: now,
    },
  ]);

  if (!ids[0])
    return error('The record could not be saved. Please try again.', 500);
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
    return error('This record is too large. The maximum is 180 KB.', 413);
  }
  if (!validateJson(String(existing.kind), content)) {
    return error(
      'The JSON is invalid. Check the brackets, commas and quotation marks.',
      400
    );
  }

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
  return json({ saved: true });
}

async function deleteRecord(ctx: RequestContext) {
  const id = ctx.params.id;
  const record = await getRecord(ctx, id);
  if (!record) return json({ deleted: true });

  if (record.kind === 'file') {
    const indexes = Array.isArray(record.uploadedChunks)
      ? record.uploadedChunks.filter((value): value is number =>
          Number.isInteger(value)
        )
      : [];

    if (indexes.length) {
      const paths = indexes.map(index => filePath(ctx, id, index));
      const removed = await storage.delete(paths);
      if (removed.some(ok => !ok)) {
        return error(
          'The file data could not be fully removed. Please retry.',
          500
        );
      }
    }
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
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE) {
    return error('Files must be 50 MB or smaller in this version.', 413);
  }

  const expectedChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
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
      uploadedChunks: [],
      status: 'uploading',
      createdAt: now,
      updatedAt: now,
    },
  ]);

  if (!ids[0])
    return error('The upload could not be started. Please try again.', 500);
  return json({ id: ids[0], expectedChunks, chunkSize: CHUNK_SIZE }, 201);
}

async function uploadFileChunk(ctx: RequestContext) {
  const id = ctx.params.id;
  const index = Number(ctx.params.index);
  const input = ctx.body as { base64?: unknown };
  const record = await getRecord(ctx, id);

  if (!record || record.kind !== 'file') return error('Upload not found.', 404);
  if (record.status !== 'uploading')
    return error('This upload is no longer active.', 409);
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= Number(record.expectedChunks)
  ) {
    return error('Invalid upload part.', 400);
  }
  if (
    typeof input?.base64 !== 'string' ||
    input.base64.length > Math.ceil(CHUNK_SIZE / 3) * 4 + 8 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
  ) {
    return error('The upload part is invalid. Please retry this part.', 400);
  }

  const uploaded = Array.isArray(record.uploadedChunks)
    ? record.uploadedChunks.filter((value): value is number =>
        Number.isInteger(value)
      )
    : [];

  if (uploaded.includes(index))
    return json({ uploaded: true, duplicate: true });

  const results = await storage.write([
    {
      path: filePath(ctx, id, index),
      content: input.base64,
      contentType: 'application/octet-stream',
    },
  ]);

  if (!results[0])
    return error('This part could not be stored. Please retry.', 500);

  const changed = await db.tx.update(
    tableFor(ctx),
    [
      {
        id,
        record: {
          uploadedChunks: [...uploaded, index],
          updatedAt: new Date().toISOString(),
        },
      },
    ],
    { patch: true }
  );

  if (!changed[0])
    return error(
      'The file part was stored but its progress could not be recorded. Retry the same part.',
      500
    );
  return json({ uploaded: true });
}

async function completeFileUpload(ctx: RequestContext) {
  const id = ctx.params.id;
  const record = await getRecord(ctx, id);

  if (!record || record.kind !== 'file') return error('Upload not found.', 404);
  if (record.status === 'ready') return json({ complete: true });

  const expected = Number(record.expectedChunks);
  const uploaded = Array.isArray(record.uploadedChunks)
    ? record.uploadedChunks
    : [];
  const complete =
    Number.isInteger(expected) &&
    uploaded.length === expected &&
    Array.from({ length: expected }, (_, index) => index).every(index =>
      uploaded.includes(index)
    );

  if (!complete)
    return error(
      'Some file parts are missing. Retry the upload before completing it.',
      409
    );

  const changed = await db.tx.update(
    tableFor(ctx),
    [
      {
        id,
        record: {
          status: 'ready',
          updatedAt: new Date().toISOString(),
        },
      },
    ],
    { patch: true }
  );

  if (!changed[0])
    return error('The file could not be finalized. Please retry.', 500);
  return json({ complete: true });
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

export const handler = router({
  'GET /api/records': [requireAuth(), async ctx => listRecords(ctx)],
  'POST /api/records': [requireAuth(), async ctx => createRecord(ctx)],
  'PUT /api/records/:id': [requireAuth(), async ctx => updateRecord(ctx)],
  'DELETE /api/records/:id': [requireAuth(), async ctx => deleteRecord(ctx)],
  'POST /api/files/start': [requireAuth(), async ctx => startFileUpload(ctx)],
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
