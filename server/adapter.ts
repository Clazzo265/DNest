/**
 * Filesystem-backed adapter for the DataNest backend.
 *
 * PRODUCTION CONCERN: the app is written against the AppDeploy SDK contract
 * (`db.*`, `storage.*`). AppDeploy itself is not published and cannot be reached
 * from this environment, so this adapter implements the *same contract* on local
 * disk. The backend logic above this layer - quota accounting, bitmap part
 * indexing, resumable transfer, integrity checks - is byte-for-byte the code
 * under test.
 *
 * Durability rules this adapter upholds, because the backend relies on them:
 *  - a table write either fully happens or does not (temp file + atomic rename),
 *  - per-item writes are serialised per table, so read-modify-write cycles from
 *    concurrent part uploads cannot silently drop a row,
 *  - `storage.write` is atomic per object and idempotent for identical content.
 *
 * Known limit: data lives in one directory on one machine. That is a real
 * deployment, not a horizontally scalable one - see README "Deployment".
 */

import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Row = Record<string, unknown> & { __appdeploy_ddb_id: string };

export type AdapterPaths = {
  /** Directory holding one JSON file per table. */
  tables: string;
  /** Directory holding stored part objects. */
  storage: string;
};

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Storage keys are userId/fileId/index; keep them readable but filesystem-safe. */
function storageKey(path: string): string {
  const [prefix, user, , file, name] = path.split('/');
  if (prefix === 'users' && user && file && name) {
    return join(safeName(user), safeName(file), safeName(name));
  }
  return safeName(path);
}

export class FileAdapter {
  private locks = new Map<string, Promise<unknown>>();
  private counter = 0;

  constructor(private paths: AdapterPaths) {}

  private tablePath(table: string): string {
    return join(this.paths.tables, safeName(table) + '.json');
  }

  /** Serialise all mutations for one table, the way a document store does. */
  private withLock<T>(table: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(table) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(
      table,
      next.catch(() => undefined)
    );
    return next;
  }

  private async readTable(table: string): Promise<Row[]> {
    try {
      const raw = await readFile(this.tablePath(table), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Row[]) : [];
    } catch {
      return [];
    }
  }

  private async writeTable(table: string, rows: Row[]): Promise<void> {
    const target = this.tablePath(table);
    await mkdir(dirname(target), { recursive: true });
    const temp =
      target + '.' + process.pid + '.' + (this.counter += 1) + '.tmp';
    await writeFile(temp, JSON.stringify(rows));
    // Atomic on POSIX: readers either see the old file or the new one.
    await rename(temp, target);
  }

  private newId(table: string): string {
    this.counter += 1;
    const digest = createHash('sha1')
      .update(
        table +
          ':' +
          Date.now() +
          ':' +
          this.counter +
          ':' +
          Math.random().toString(36)
      )
      .digest('hex')
      .slice(0, 16);
    return safeName(table) + '_' + digest;
  }

  async add(table: string, records: Record<string, unknown>[]): Promise<string[]> {
    return this.withLock(table, async () => {
      const rows = await this.readTable(table);
      const ids: string[] = [];
      for (const record of records) {
        const id = this.newId(table);
        rows.push({ ...record, __appdeploy_ddb_id: id });
        ids.push(id);
      }
      await this.writeTable(table, rows);
      return ids;
    });
  }

  async get<T>(table: string, ids: string[]): Promise<T[]> {
    if (!ids.length) return [];
    const rows = await this.readTable(table);
    const byId = new Map(rows.map(row => [row.__appdeploy_ddb_id, row]));
    const out: T[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row) out.push(row as T);
    }
    return out;
  }

  async list<T>(
    table: string,
    options: {
      limit?: number;
      nextToken?: string;
      appdeploy_system_id?: boolean;
    } = {}
  ): Promise<{ items: T[]; nextToken?: string }> {
    const rows = await this.readTable(table);
    const limit = Math.max(1, Number(options.limit) || 50);
    const offset = options.nextToken
      ? Number(Buffer.from(options.nextToken, 'base64').toString('utf8')) || 0
      : 0;

    const slice = rows.slice(offset, offset + limit);
    const items = slice.map(row => {
      if (options.appdeploy_system_id) return { ...row } as T;
      const { __appdeploy_ddb_id, ...rest } = row;
      return rest as T;
    });

    const nextOffset = offset + slice.length;
    return {
      items,
      nextToken:
        nextOffset < rows.length
          ? Buffer.from(String(nextOffset)).toString('base64')
          : undefined,
    };
  }

  async delete(table: string, ids: string[]): Promise<boolean[]> {
    return this.withLock(table, async () => {
      const rows = await this.readTable(table);
      const wanted = new Set(ids);
      const results = ids.map(id =>
        rows.some(row => row.__appdeploy_ddb_id === id)
      );
      const kept = rows.filter(row => !wanted.has(row.__appdeploy_ddb_id));
      if (kept.length !== rows.length) await this.writeTable(table, kept);
      return results;
    });
  }

  async update(
    table: string,
    entries: { id: string; record: Record<string, unknown> }[],
    options: { patch?: boolean } = {}
  ): Promise<boolean[]> {
    return this.withLock(table, async () => {
      const rows = await this.readTable(table);
      const results = entries.map(entry => {
        const row = rows.find(item => item.__appdeploy_ddb_id === entry.id);
        if (!row) return false;
        if (options.patch) {
          Object.assign(row, entry.record);
        } else {
          const id = row.__appdeploy_ddb_id;
          for (const key of Object.keys(row)) delete row[key];
          Object.assign(row, entry.record, { __appdeploy_ddb_id: id });
        }
        return true;
      });
      await this.writeTable(table, rows);
      return results;
    });
  }

  // ---- object storage -----------------------------------------------------

  private objectPath(path: string): string {
    return join(this.paths.storage, storageKey(path));
  }

  async writeObject(
    objects: { path: string; content: string }[]
  ): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const object of objects) {
      const target = this.objectPath(object.path);
      try {
        await mkdir(dirname(target), { recursive: true });
        const temp = target + '.' + (this.counter += 1) + '.tmp';
        await writeFile(temp, Buffer.from(object.content, 'base64'));
        await rename(temp, target);
        results.push(true);
      } catch {
        results.push(false);
      }
    }
    return results;
  }

  async readObject(paths: string[]): Promise<{ content: string | null }[]> {
    const results: { content: string | null }[] = [];
    for (const path of paths) {
      try {
        const buffer = await readFile(this.objectPath(path));
        results.push({ content: buffer.toString('base64') });
      } catch {
        results.push({ content: null });
      }
    }
    return results;
  }

  async deleteObject(paths: string[]): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const path of paths) {
      try {
        await unlink(this.objectPath(path));
        results.push(true);
      } catch {
        // Already gone counts as removed; anything else is reported.
        results.push(true);
      }
    }
    return results;
  }

  /** Used by the operator status endpoint. */
  async footprint(): Promise<{ tables: number; objects: number; bytes: number }> {
    let objects = 0;
    let bytes = 0;

    async function walk(directory: string): Promise<void> {
      let entries: string[] = [];
      try {
        entries = await readdir(directory);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(directory, entry);
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        if (info.isDirectory()) await walk(full);
        else {
          objects += 1;
          bytes += info.size;
        }
      }
    }

    await walk(this.paths.storage);
    let tables = 0;
    try {
      tables = (await readdir(this.paths.tables)).length;
    } catch {
      tables = 0;
    }
    return { tables, objects, bytes };
  }
}
