/**
 * Capacity model tests. These are the numbers the 1 TiB promise rests on, so
 * they are asserted exactly rather than approximately.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHUNK_SIZE,
  GIB,
  MAX_FILE_CHUNKS,
  MAX_FILE_SIZE,
  MAX_RECORD_BYTES,
  MIB,
  QUOTA_BYTES,
  TIB,
  formatBytes,
  partCountFor,
  partsForSize,
  publicLimits,
} from '../backend/limits';
import {
  BITS_PER_SHARD,
  MAX_SHARDS,
  SHARD_BYTES,
  countBits,
  emptyBitmap,
  firstMissing,
  markParts,
  missingInWindow,
  partSize,
  bitOf,
  indexOf,
  shardOf,
  summarize,
} from '../backend/parts';

test('quota is exactly one tebibyte', () => {
  assert.equal(QUOTA_BYTES, 1099511627776);
  assert.equal(TIB, 1099511627776);
  assert.equal(MAX_FILE_SIZE, QUOTA_BYTES);
});

test('a single 1 TiB file is accepted and fits the part budget', () => {
  assert.equal(partCountFor(TIB), 1_048_576);
  assert.equal(MAX_FILE_CHUNKS, 1_048_576);
  assert.ok(partCountFor(TIB) <= MAX_FILE_CHUNKS);
});

test('part count maths holds across the interesting boundaries', () => {
  assert.equal(partCountFor(0), 1, 'empty file still needs one part');
  assert.equal(partCountFor(1), 1);
  assert.equal(partCountFor(CHUNK_SIZE), 1);
  assert.equal(partCountFor(CHUNK_SIZE + 1), 2);
  assert.equal(partCountFor(50 * MIB), 50);
  assert.equal(partCountFor(1 * GIB), 1024);
  assert.equal(partCountFor(1000 * GIB), 1_024_000);
  // 1000 GB still fits inside a 1 TiB quota.
  assert.ok(1000 * GIB < QUOTA_BYTES);
  // But a 1 TiB + 1 byte object does not.
  assert.ok(partCountFor(QUOTA_BYTES + 1) > MAX_FILE_CHUNKS);
});

test('partsForSize enumerates the same count without materialising huge arrays', () => {
  assert.deepEqual(partsForSize(CHUNK_SIZE * 2 + 5), [0, 1, 2]);
  const many = partsForSize(CHUNK_SIZE * 1000);
  assert.equal(many.length, 1000);
  assert.equal(many[999], 999);
});

test('records stay small so they remain database items', () => {
  assert.equal(MAX_RECORD_BYTES, 184_320);
  assert.ok(MAX_RECORD_BYTES < MIB);
});

test('published limits never contradict the enforced constants', () => {
  const limits = publicLimits();
  assert.equal(limits.quotaBytes, QUOTA_BYTES);
  assert.equal(limits.chunkSize, CHUNK_SIZE);
  assert.equal(limits.maxFileSize, MAX_FILE_SIZE);
  assert.equal(limits.maxFileChunks, MAX_FILE_CHUNKS);
  assert.equal(limits.maxRecordBytes, MAX_RECORD_BYTES);
  // A full quota must be storable within the declared part ceiling.
  assert.equal(
    Math.ceil(limits.maxFileSize / limits.chunkSize),
    limits.maxFileChunks
  );
});

test('byte formatting is readable at terabyte scale', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * MIB), '5.0 MB');
  assert.equal(formatBytes(2 * GIB), '2.00 GB');
  assert.equal(formatBytes(TIB), '1.00 TB');
});

test('bitmap sharding fits a 1 TiB file in a few hundred rows', () => {
  // 1,048,576 parts / 4096 bits per shard = 256 shard rows per terabyte file.
  assert.equal(BITS_PER_SHARD, 4096);
  assert.equal(SHARD_BYTES, 512);
  assert.equal(MAX_SHARDS, 256);
  // Interleaved: neighbouring parts land in neighbouring rows so concurrent
  // workers do not contend on one row.
  assert.equal(shardOf(0), 0);
  assert.equal(shardOf(1), 1);
  assert.equal(shardOf(255), 255);
  assert.equal(shardOf(256), 0);
  assert.equal(shardOf(257), 1);
  assert.equal(shardOf(1_048_575), 255);
  assert.equal(bitOf(0), 0);
  assert.equal(bitOf(255), 0);
  assert.equal(bitOf(256), 1);
  assert.equal(bitOf(1_048_575), 4095);
  // Every part maps to a unique (shard, bit) cell.
  const cells = new Set<string>();
  for (const index of [0, 1, 255, 256, 4095, 65_536, 1_048_575]) {
    cells.add(shardOf(index) + ':' + bitOf(index));
    assert.equal(indexOf(shardOf(index), bitOf(index)), index);
  }
  assert.equal(cells.size, 7);
  // Whole-file bitmap is 128 KiB - small enough to hold in memory.
  const bitmap = emptyBitmap(MAX_FILE_CHUNKS);
  assert.equal(bitmap.length, 131_072);
});

test('bitmap operations are exact at the write and read boundaries', () => {
  const total = 10_000;
  const bitmap = emptyBitmap(total);
  assert.equal(countBits(bitmap, total), 0);
  assert.equal(firstMissing(bitmap, total), 0);

  // Set a bit in each shard, plus the first and last part.
  for (const index of [0, 4095, 4096, 8191, 8192, total - 1]) {
    bitmap[index >> 3] |= 1 << (index & 7);
  }
  assert.equal(countBits(bitmap, total), 6);
  assert.equal(firstMissing(bitmap, total), 1);

  assert.deepEqual(missingInWindow(bitmap, 0, 4), [1, 2, 3]);
  assert.deepEqual(missingInWindow(bitmap, 4095, 4097), []);
  assert.deepEqual(missingInWindow(bitmap, total - 2, total), [total - 2]);
});

test('part sizes tile the file exactly, including the final short part', () => {
  const size = CHUNK_SIZE * 2 + 5;
  assert.equal(partSize(0, size), CHUNK_SIZE);
  assert.equal(partSize(1, size), CHUNK_SIZE);
  assert.equal(partSize(2, size), 5);
  assert.equal(partSize(0, size) + partSize(1, size) + partSize(2, size), size);

  // A full 1 TiB file tiles to exactly 1 TiB.
  const tb = partSize(0, TIB) * MAX_FILE_CHUNKS;
  assert.equal(tb, TIB);
});

test('summarize reports progress without scanning a million entries', () => {
  const total = 100;
  const bitmap = emptyBitmap(total);
  bitmap[0] |= 0b0000_0111;
  const summary = summarize(bitmap, total, total * CHUNK_SIZE);
  assert.equal(summary.received, 3);
  assert.equal(summary.bytes, 3 * CHUNK_SIZE);
  assert.equal(summary.nextMissing, 3);
  assert.equal(summary.complete, false);
  void markParts;
});
