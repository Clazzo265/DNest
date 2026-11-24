/**
 * DataNest capacity model.
 *
 * The product promise is a 1 TiB (1024^4 byte) per-account vault. Every limit
 * below is derived from that promise, and any number that a client may need to
 * reason about is served to it by `GET /api/vault/limits` so the two sides can
 * never disagree.
 */

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;
export const TIB = 1024 * GIB;

/** The advertised and enforced per-account quota: 1 TiB. */
export const QUOTA_BYTES = TIB;

/**
 * Bytes per upload part.
 *
 * Kept at 1 MiB deliberately. It is the size the pre-existing transport already
 * proved works against the platform's request-body limit (1 MiB of bytes becomes
 * ~1.37 MB of base64 JSON). Raising it would cut the request count for a 1 TiB
 * file from ~1.05M to ~262k, but it risks hard platform-level body rejections we
 * cannot verify from this repository, and a rejected body fails the whole
 * upload rather than one part. 1 MiB is the safe, proven unit.
 */
export const CHUNK_SIZE = MIB;

/** Largest single object the vault accepts: the whole quota. */
export const MAX_FILE_SIZE = QUOTA_BYTES;

/** Hard ceiling on part count for one file (1,048,576 for a 1 TiB upload). */
export const MAX_FILE_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE);

/** Notes and JSON records stay small: they live in a database item. */
export const MAX_RECORD_BYTES = 180 * KIB;

/** Item-count ceiling so a single account cannot exhaust the table scan budget. */
export const MAX_RECORD_COUNT = 100_000;

/** Parts accepted in a single batched upload/check request. */
export const MAX_PARTS_PER_REQUEST = 16;

/** Independent upload requests a client should keep in flight. */
export const RECOMMENDED_CONCURRENCY = 6;

/** An incomplete upload that is older than this is reclaimable. */
export const UPLOAD_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function partCountFor(sizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 1;
  return Math.max(1, Math.ceil(sizeBytes / CHUNK_SIZE));
}

export function partsForSize(sizeBytes: number): number[] {
  const total = partCountFor(sizeBytes);
  return Array.from({ length: total }, (_, index) => index);
}

export type CapacityLimits = {
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

export function publicLimits(): CapacityLimits {
  return {
    quotaBytes: QUOTA_BYTES,
    chunkSize: CHUNK_SIZE,
    maxFileSize: MAX_FILE_SIZE,
    maxFileChunks: MAX_FILE_CHUNKS,
    maxRecordBytes: MAX_RECORD_BYTES,
    maxRecordCount: MAX_RECORD_COUNT,
    maxPartsPerRequest: MAX_PARTS_PER_REQUEST,
    recommendedConcurrency: RECOMMENDED_CONCURRENCY,
    uploadStaleMs: UPLOAD_STALE_MS,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < KIB) return bytes + ' B';
  if (bytes < MIB) return (bytes / KIB).toFixed(1) + ' KB';
  if (bytes < GIB) return (bytes / MIB).toFixed(1) + ' MB';
  if (bytes < TIB) return (bytes / GIB).toFixed(2) + ' GB';
  return (bytes / TIB).toFixed(2) + ' TB';
}
