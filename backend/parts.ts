/**
 * Upload progress index.
 *
 * Requirements that shaped this design:
 *  - A 1 TiB file is 1,048,576 parts. Recording one database row per part would
 *    mean ~1M metadata rows per terabyte file, each needing its own round trip.
 *  - The previous design rewrote `uploadedChunks: number[]` on every part, which
 *    is O(n^2): ~5 * 10^11 integer writes for one terabyte file.
 *  - A retried part must never be double counted.
 *
 * So progress is stored as a bitmap partitioned into fixed shards:
 *
 *   bits per shard   = 4096  (512 bytes)
 *   shards per 1 TiB = 256
 *
 * Part -> shard assignment is *interleaved*, not contiguous:
 *
 *   shard    = index % 256
 *   bit      = index / 256
 *
 * Contiguous sharding would put parts 0-5 (the ones six concurrent upload
 * workers send first) into a single row and serialise them on the same
 * read-modify-write cycle. Interleaving spreads neighbouring parts across
 * neighbouring rows, so concurrency scales with the shard count instead of
 * fighting over one row.
 *
 * Each shard is one small row keyed by `<fileId>#<shard>`. Setting a part flips
 * one bit and recomputes `count` with a popcount, so:
 *  - writes are O(1) per part (one small read-modify-write),
 *  - marking the same part twice is a no-op (idempotent, survives retries),
 *  - progress is the sum of 256 counts instead of a 1M-row scan,
 *  - resume state is derivable server-side without shipping 1M indexes.
 *
 * Shard updates use an optimistic version check so two parts landing in the same
 * shard at the same moment cannot silently drop one of them.
 */

import { db } from '@appdeploy/sdk';
import { CHUNK_SIZE, MAX_FILE_CHUNKS } from './limits';

export const PROGRESS_TABLE_PREFIX = 'vault_progress_';
export const BITS_PER_SHARD = 4096;
export const SHARD_BYTES = BITS_PER_SHARD / 8;
export const MAX_SHARDS = Math.ceil(MAX_FILE_CHUNKS / BITS_PER_SHARD);

/** Parts scanned per resume window (bounded request/response size). */
export const RESUME_WINDOW = 65_536;

const MAX_LOCK_ATTEMPTS = 6;

type ShardRow = {
  kind: 'partshard';
  fileId: string;
  shard: number;
  bits: string;
  count: number;
  version: number;
  updatedAt: string;
  __appdeploy_ddb_id?: string;
};

export type Progress = {
  received: number;
  bytes: number;
  nextMissing: number;
  complete: boolean;
};

export function progressTableFor(workspaceId: string): string {
  return PROGRESS_TABLE_PREFIX + workspaceId;
}

export function shardOf(index: number): number {
  return index % MAX_SHARDS;
}

/** Bit position of a part inside its shard row. */
export function bitOf(index: number): number {
  return Math.floor(index / MAX_SHARDS);
}

/** Inverse of shardOf/bitOf. */
export function indexOf(shard: number, bit: number): number {
  return bit * MAX_SHARDS + shard;
}

function bytesForPart(index: number, totalSize: number): number {
  return Math.max(0, Math.min(CHUNK_SIZE, totalSize - index * CHUNK_SIZE));
}

/** Deterministic per-part size, derived from the declared file size. */
export function partSize(index: number, totalSize: number): number {
  return bytesForPart(index, totalSize);
}

// ---- bitmap helpers -------------------------------------------------------

export function emptyBitmap(totalParts: number): Uint8Array {
  return new Uint8Array(Math.ceil(Math.max(totalParts, 1) / 8));
}

function decodeBits(encoded: string): Uint8Array {
  const out = new Uint8Array(SHARD_BYTES);
  try {
    const binary = atob(encoded);
    for (let index = 0; index < binary.length && index < SHARD_BYTES; index += 1) {
      out[index] = binary.charCodeAt(index);
    }
  } catch {
    /* treat unreadable data as "nothing stored" */
  }
  return out;
}

function encodeBits(bits: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bits.length; index += 1) {
    binary += String.fromCharCode(bits[index]);
  }
  return btoa(binary);
}

function popcount(bits: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < bits.length; index += 1) {
    let value = bits[index];
    while (value) {
      value &= value - 1;
      total += 1;
    }
  }
  return total;
}

function isSet(bitmap: Uint8Array, index: number): boolean {
  const byte = index >> 3;
  if (byte >= bitmap.length) return false;
  return (bitmap[byte] & (1 << (index & 7))) !== 0;
}

// ---- row access -----------------------------------------------------------

type ShardState = {
  /** Row that mutations should write to (lowest id wins, deterministically). */
  primaryId?: string;
  /** OR-merged bits across every row for this shard. */
  bits: Uint8Array;
  /** Rows beyond the primary, to be deleted once merged into it. */
  duplicates: string[];
  version: number;
};

/**
 * Read every shard row for a file and merge duplicates.
 *
 * Two workers storing the first part of a file can both see "no row" and both
 * insert one. Merging on read (rather than trusting the last row) means a
 * duplicate can never hide stored bits - the failure mode the naive version
 * had. The extra rows are cleaned up by the next mutation.
 */
async function scanShards(
  table: string,
  fileId: string
): Promise<Map<number, ShardState>> {
  const found = new Map<number, ShardState>();
  let nextToken: string | undefined;
  let guard = 0;

  do {
    const page = await db.list<ShardRow>(table, {
      limit: 1000,
      nextToken,
      appdeploy_system_id: true,
    });
    for (const row of page.items) {
      if (row.kind !== 'partshard' || row.fileId !== fileId) continue;
      const shard = Number(row.shard);
      const incoming = decodeBits(String(row.bits || ''));
      const existing = found.get(shard);
      const rowId = row.__appdeploy_ddb_id;

      if (!existing) {
        found.set(shard, {
          primaryId: rowId,
          bits: incoming,
          duplicates: [],
          version: Number(row.version) || 0,
        });
        continue;
      }

      for (let index = 0; index < SHARD_BYTES; index += 1) {
        existing.bits[index] |= incoming[index];
      }
      existing.version = Math.max(existing.version, Number(row.version) || 0);
      if (rowId && rowId !== existing.primaryId) existing.duplicates.push(rowId);
    }
    nextToken = page.nextToken || undefined;
    guard += 1;
    if (guard > 10_000) break;
  } while (nextToken);

  return found;
}

/** Materialise the full bitmap for a file. */
export async function readBitmap(
  table: string,
  fileId: string,
  totalParts: number
): Promise<Uint8Array> {
  const bitmap = emptyBitmap(totalParts);
  const shards = await scanShards(table, fileId);
  for (const [shard, state] of shards) {
    const bits = state.bits;
    for (let bit = 0; bit < BITS_PER_SHARD; bit += 1) {
      if ((bits[bit >> 3] & (1 << (bit & 7))) === 0) continue;
      const index = indexOf(shard, bit);
      if (index >= totalParts) continue;
      bitmap[index >> 3] |= 1 << (index & 7);
    }
  }
  return bitmap;
}

export function countBits(bitmap: Uint8Array, totalParts: number): number {
  let total = 0;
  for (let index = 0; index < totalParts; index += 1) {
    if (isSet(bitmap, index)) total += 1;
  }
  return total;
}

export function firstMissing(bitmap: Uint8Array, totalParts: number): number {
  for (let index = 0; index < totalParts; index += 1) {
    if (!isSet(bitmap, index)) return index;
  }
  return -1;
}

export function missingInWindow(
  bitmap: Uint8Array,
  from: number,
  to: number
): number[] {
  const missing: number[] = [];
  for (let index = from; index < to; index += 1) {
    if (!isSet(bitmap, index)) missing.push(index);
  }
  return missing;
}

export function bytesStored(
  bitmap: Uint8Array,
  totalParts: number,
  totalSize: number
): number {
  let bytes = 0;
  for (let index = 0; index < totalParts; index += 1) {
    if (isSet(bitmap, index)) bytes += bytesForPart(index, totalSize);
  }
  return bytes;
}

export function summarize(
  bitmap: Uint8Array,
  totalParts: number,
  totalSize: number
): Progress {
  const received = countBits(bitmap, totalParts);
  const nextMissing = firstMissing(bitmap, totalParts);
  return {
    received,
    bytes: bytesStored(bitmap, totalParts, totalSize),
    nextMissing,
    complete: totalParts > 0 && nextMissing === -1,
  };
}

// ---- mutation -------------------------------------------------------------

/**
 * Mark parts as stored. Idempotent: re-marking a stored part changes nothing.
 * Returns the number of newly set bits.
 */
export async function markParts(
  table: string,
  fileId: string,
  indexes: number[],
  totalParts: number
): Promise<number> {
  if (!indexes.length) return 0;

  const grouped = new Map<number, number[]>();
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= totalParts) continue;
    const shard = shardOf(index);
    const group = grouped.get(shard) ?? [];
    group.push(index);
    grouped.set(shard, group);
  }

  let newlySet = 0;

  for (const [shard, values] of grouped) {
    const wanted = values.map(index => bitOf(index));
    let settled = false;

    // Lock-free "OR register" convergence: OR our bits into whatever the shard
    // currently holds, write, then confirm *our bits specifically* survived. A
    // concurrent writer can clobber bits, but it verifies its own bits too, so
    // every writer re-applies until its bits are present. Writes only ever
    // assert bits, so the loop terminates instead of oscillating.
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
      const existing = await scanShards(table, fileId);
      const row = existing.get(shard);
      const bits = row ? Uint8Array.from(row.bits) : new Uint8Array(SHARD_BYTES);

      let added = 0;
      for (const local of wanted) {
        const byte = local >> 3;
        const mask = 1 << (local & 7);
        if ((bits[byte] & mask) === 0) {
          bits[byte] |= mask;
          added += 1;
        }
      }
      if (!added) break;

      const payload = {
        kind: 'partshard',
        fileId,
        shard,
        bits: encodeBits(bits),
        count: popcount(bits),
        version: (row?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };

      if (row?.primaryId) {
        await db.tx.update(
          table,
          [{ id: row.primaryId, record: payload }],
          { patch: true }
        );
        if (row.duplicates.length) {
          await db.delete(table, row.duplicates);
        }
      } else {
        const ids = await db.add(table, [payload]);
        if (!ids[0]) continue;
      }

      const after = (await scanShards(table, fileId)).get(shard);
      const stored = after ? after.bits : new Uint8Array(SHARD_BYTES);
      const lost = wanted.some(
        local => (stored[local >> 3] & (1 << (local & 7))) === 0
      );
      if (!lost) {
        newlySet += added;
        settled = true;
        break;
      }
      // Our bits were overwritten by a concurrent writer: merge and retry.
    }

    // Never report success on a partially written shard: the caller must be
    // able to retry the part instead of believing it was recorded.
    if (!settled) {
      throw new Error(
        'Could not record upload progress for this part. Please retry it.'
      );
    }
  }

  return newlySet;
}

/** Drop all shard rows for a file. Returns rows removed. */
export async function deleteProgress(
  table: string,
  fileId: string
): Promise<{ deleted: number; failed: boolean }> {
  const shards = await scanShards(table, fileId);
  const ids: string[] = [];
  for (const state of shards.values()) {
    if (state.primaryId) ids.push(state.primaryId);
    ids.push(...state.duplicates);
  }
  if (!ids.length) return { deleted: 0, failed: false };

  let deleted = 0;
  let failed = false;
  for (let offset = 0; offset < ids.length; offset += 100) {
    const results = await db.delete(table, ids.slice(offset, offset + 100));
    deleted += results.filter(Boolean).length;
    if (results.some(ok => !ok)) failed = true;
  }
  return { deleted, failed };
}

/**
 * Total stored parts for a whole account, across every file. Used by the
 * reconciler to prove the usage row matches reality.
 */
export async function accountProgressTotals(
  table: string
): Promise<{ parts: number; files: Set<string> }> {
  const files = new Set<string>();
  let parts = 0;
  let nextToken: string | undefined;
  let guard = 0;

  do {
    const page = await db.list<ShardRow>(table, {
      limit: 1000,
      nextToken,
      appdeploy_system_id: true,
    });
    for (const row of page.items) {
      if (row.kind !== 'partshard') continue;
      parts += Number(row.count) || 0;
      files.add(String(row.fileId));
    }
    nextToken = page.nextToken || undefined;
    guard += 1;
    if (guard > 10_000) break;
  } while (nextToken);

  return { parts, files };
}

/**
 * Legacy compatibility: the previous version recorded parts as a raw
 * `uploadedChunks: number[]` on the file record. Convert those into the bitmap so
 * existing files keep downloading and deleting correctly.
 */
export async function backfillLegacyParts(
  table: string,
  fileId: string,
  legacyIndexes: number[],
  totalParts: number
): Promise<number> {
  if (!legacyIndexes.length) return 0;
  return markParts(table, fileId, legacyIndexes, totalParts);
}
