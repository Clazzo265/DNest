/**
 * Object-storage helpers for file parts.
 *
 * A 1 TiB file is ~1,048,576 stored objects. Deleting them one at a time would
 * be ~1M round trips, so removals are issued as batched `storage.delete` calls
 * with a fixed concurrency window. Failures are reported instead of thrown so
 * the caller can leave the item in place for a retry rather than losing track of
 * orphaned objects.
 */

import { storage } from '@appdeploy/sdk';

const DELETE_BATCH = 100;

const DELETE_CONCURRENCY = 4;

export function partStoragePath(
  userKey: string,
  fileId: string,
  index: number
): string {
  const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '');
  return 'users/' + userKey + '/files/' + safeId + '/' + index + '.part';
}

export type RemoveResult = { deleted: number; failed: boolean };

/** Remove the stored objects for the given part indexes. */
export async function deleteStoredParts(
  userKey: string,
  fileId: string,
  indexes: number[]
): Promise<RemoveResult> {
  if (!indexes.length) return { deleted: 0, failed: false };

  const batches: number[][] = [];
  for (let offset = 0; offset < indexes.length; offset += DELETE_BATCH) {
    batches.push(indexes.slice(offset, offset + DELETE_BATCH));
  }

  let deleted = 0;
  let failed = false;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const batch = batches[cursor];
      cursor += 1;
      if (!batch) return;
      const paths = batch.map(index => partStoragePath(userKey, fileId, index));
      try {
        const results = await storage.delete(paths);
        deleted += results.filter(Boolean).length;
        if (results.some(ok => !ok)) failed = true;
      } catch {
        failed = true;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DELETE_CONCURRENCY, batches.length) }, () =>
      worker()
    )
  );

  return { deleted, failed };
}

/**
 * Delete every stored object belonging to a file, driven by the part index.
 * `discoverIndexes` is injected so this module does not need to know how the
 * index is stored.
 */
export async function deleteChunksFor(
  userKey: string,
  fileId: string,
  discoverIndexes: () => Promise<number[]>
): Promise<RemoveResult> {
  try {
    const indexes = await discoverIndexes();
    return await deleteStoredParts(userKey, fileId, indexes);
  } catch {
    return { deleted: 0, failed: true };
  }
}
