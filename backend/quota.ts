/**
 * Per-account usage accounting.
 *
 * The pre-existing app never measured aggregate usage, so "1 TB" could neither
 * be enforced nor displayed. This module keeps a single small usage row per
 * account:
 *
 *   usedBytes      committed bytes of every ready file + record content
 *   reservedBytes  bytes promised to uploads that are still in flight
 *   fileCount      number of file items
 *   recordCount    number of note/JSON items
 *
 * Usage lives in its own per-account table (`vault_usage_<user>`) with exactly
 * one row. That mirrors the existing per-account record table and avoids the
 * chicken-and-egg problem of looking a row up by a value we do not control:
 * the table is the index.
 *
 * Concurrency: there is no atomic counter primitive in the visible SDK surface,
 * so mutations use an optimistic lock (read version -> write version + 1 ->
 * verify). Losing writers retry against fresh state. A failed reservation is
 * still safe: it can only under-count transiently, and `reconcileUsage()`
 * rebuilds the truth from the part index at any time.
 */

import { db } from '@appdeploy/sdk';
import { MAX_RECORD_COUNT, QUOTA_BYTES } from './limits';

export type Usage = {
  usedBytes: number;
  reservedBytes: number;
  fileCount: number;
  recordCount: number;
  version: number;
  updatedAt: string;
};

export type UsageMutation = Partial<
  Pick<Usage, 'usedBytes' | 'reservedBytes' | 'fileCount' | 'recordCount'>
>;

export const USAGE_TABLE_PREFIX = 'vault_usage_';

const MAX_LOCK_ATTEMPTS = 5;

export function usageTableFor(workspaceId: string): string {
  return USAGE_TABLE_PREFIX + workspaceId;
}

function emptyUsage(): Usage {
  return {
    usedBytes: 0,
    reservedBytes: 0,
    fileCount: 0,
    recordCount: 0,
    version: 0,
    updatedAt: new Date().toISOString(),
  };
}

function coerce(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

type UsageRow = Usage & { kind: 'usage'; __appdeploy_ddb_id?: string };

async function findUsageRow(table: string): Promise<UsageRow | null> {
  const page = await db.list<UsageRow>(table, {
    limit: 5,
    appdeploy_system_id: true,
  });
  const row = page.items.find(item => item.kind === 'usage');
  return row ?? null;
}

function toUsage(row: UsageRow | null): Usage {
  if (!row) return emptyUsage();
  return {
    usedBytes: coerce(row.usedBytes),
    reservedBytes: coerce(row.reservedBytes),
    fileCount: coerce(row.fileCount),
    recordCount: coerce(row.recordCount),
    version: coerce(row.version),
    updatedAt:
      typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
  };
}

/** Read the usage row, creating it on first use. */
export async function readUsage(table: string): Promise<Usage> {
  const existing = await findUsageRow(table);
  if (existing) return toUsage(existing);

  const now = new Date().toISOString();
  await db.add(table, [
    {
      kind: 'usage',
      usedBytes: 0,
      reservedBytes: 0,
      fileCount: 0,
      recordCount: 0,
      version: 0,
      updatedAt: now,
    },
  ]);

  const created = await findUsageRow(table);
  return toUsage(created);
}

/**
 * Apply a mutation with optimistic locking. `mutator` receives current usage and
 * returns the fields to change; it may return `null` to abort without writing.
 */
export async function mutateUsage(
  table: string,
  mutator: (current: Usage) => UsageMutation | null
): Promise<Usage> {
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    const row = await findUsageRow(table);
    const current = row ? toUsage(row) : await readUsage(table).then(async () => {
      const refetched = await findUsageRow(table);
      return toUsage(refetched);
    });

    const patch = mutator(current);
    if (!patch) return current;

    const target = await findUsageRow(table);
    if (!target?.__appdeploy_ddb_id) {
      throw new Error('Usage row is unavailable.');
    }

    const next: Usage = {
      usedBytes: Math.max(0, current.usedBytes + (patch.usedBytes ?? 0)),
      reservedBytes: Math.max(
        0,
        current.reservedBytes + (patch.reservedBytes ?? 0)
      ),
      fileCount: Math.max(0, current.fileCount + (patch.fileCount ?? 0)),
      recordCount: Math.max(0, current.recordCount + (patch.recordCount ?? 0)),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    await db.tx.update(
      table,
      [
        {
          id: target.__appdeploy_ddb_id,
          record: { ...next, kind: 'usage' },
        },
      ],
      { patch: true }
    );

    // Verify we won the race; a later writer would have bumped the version again.
    const verify = await findUsageRow(table);
    if (verify && coerce(verify.version) === next.version) return next;
  }

  throw new Error(
    'Storage usage is busy right now. Please retry in a moment.'
  );
}

export type ReservationResult =
  | { ok: true; usage: Usage }
  | { ok: false; message: string; usage: Usage };

/**
 * Atomically promise `bytes` to an in-flight upload, or refuse it because the
 * account would exceed its quota. Reservations are counted against the quota so
 * ten concurrent 200 GB uploads cannot be started on a 1 TiB account.
 */
export async function reserveBytes(
  table: string,
  bytes: number
): Promise<ReservationResult> {
  let refusal = '';

  const usage = await mutateUsage(table, current => {
    const committed = current.usedBytes + current.reservedBytes;
    if (committed + bytes > QUOTA_BYTES) {
      const remaining = Math.max(0, QUOTA_BYTES - committed);
      refusal =
        'This upload needs ' +
        bytes +
        ' bytes but only ' +
        remaining +
        ' are left in your 1 TB vault.';
      return null;
    }
    return { reservedBytes: bytes };
  });

  if (refusal) return { ok: false, message: refusal, usage };
  if (usage.reservedBytes < bytes) {
    // Someone else's mutation landed first; report the authoritative state.
    const committed = usage.usedBytes + usage.reservedBytes;
    return {
      ok: false,
      message:
        'Not enough space left in your 1 TB vault for this upload. Free up space and retry.',
      usage: { ...usage, reservedBytes: committed - usage.usedBytes },
    };
  }
  return { ok: true, usage };
}

/** Reservation -> committed: move bytes out of reserved and into used. */
export async function commitReservation(
  table: string,
  bytes: number,
  files = 1
): Promise<Usage> {
  return mutateUsage(table, () => ({
    reservedBytes: -bytes,
    usedBytes: bytes,
    fileCount: files,
  }));
}

/** Release an unused reservation (failed/abandoned upload). */
export async function releaseReservation(
  table: string,
  bytes: number
): Promise<Usage> {
  return mutateUsage(table, () => ({ reservedBytes: -bytes }));
}

/** Remove a ready file's bytes from usage. */
export async function releaseCommitted(
  table: string,
  bytes: number,
  files: number
): Promise<Usage> {
  return mutateUsage(table, () => ({
    usedBytes: -bytes,
    fileCount: -files,
  }));
}

export async function adjustRecords(
  table: string,
  delta: number,
  recordBytes: number
): Promise<Usage> {
  return mutateUsage(table, () => ({
    recordCount: delta,
    usedBytes: recordBytes,
  }));
}

/**
 * Rebuild usage from authoritative data. `sum` is supplied by the caller (which
 * can read the parts index and record table); this only persists the result.
 */
export async function overwriteUsage(
  table: string,
  truth: { usedBytes: number; fileCount: number; recordCount: number }
): Promise<Usage> {
  return mutateUsage(table, () => ({
    usedBytes: truth.usedBytes - 0,
    reservedBytes: 0,
    fileCount: truth.fileCount,
    recordCount: truth.recordCount,
  }));
}

export function quotaSnapshot(usage: Usage) {
  const committed = usage.usedBytes + usage.reservedBytes;
  return {
    quotaBytes: QUOTA_BYTES,
    usedBytes: usage.usedBytes,
    reservedBytes: usage.reservedBytes,
    remainingBytes: Math.max(0, QUOTA_BYTES - committed),
    percentUsed: Math.min(100, (committed / QUOTA_BYTES) * 100),
    fileCount: usage.fileCount,
    recordCount: usage.recordCount,
    recordLimit: MAX_RECORD_COUNT,
    updatedAt: usage.updatedAt,
  };
}

/** Small helper used by the record endpoints to police item counts. */
export function recordBudgetExceeded(usage: Usage): boolean {
  return usage.recordCount >= MAX_RECORD_COUNT;
}
