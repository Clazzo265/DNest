/**
 * LOCAL TEST HARNESS ONLY.
 *
 * Stands in for @appdeploy/sdk (not published to npm, not vendored in this
 * repo) so the backend can be typechecked and exercised over real HTTP in this
 * environment. It is dependency-free and mirrors the semantics the DataNest
 * backend relies on: per-table ids, paginated list, patch updates.
 */
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Ctx = {
  body: any;
  params: Record<string, string>;
  query: Record<string, string>;
  user?: { userId: string };
};

const DATA_DIR = process.env.HARNESS_DATA_DIR || join(process.cwd(), '.devtesting/data');
const storageDir = join(DATA_DIR, 'storage');
let idCounter = 0;

function safe(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
function tableFile(table: string) {
  return join(DATA_DIR, 'tables', safe(table) + '.json');
}
function flatPath(path: string) {
  return join(storageDir, safe(path.replace(/\//g, '__')));
}

/**
 * A real document store gives atomic per-item writes. A JSON file does not, so
 * table access is serialised through a per-table queue and writes are atomic
 * (temp file + rename). Without this, concurrent part uploads can interleave
 * read-modify-write cycles and the harness loses rows the real backend would
 * keep.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(table: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(table) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(
    table,
    next.catch(() => undefined)
  );
  return next;
}

async function readTable(table: string): Promise<any[]> {
  try {
    return JSON.parse(await readFile(tableFile(table), 'utf8'));
  } catch {
    return [];
  }
}
async function writeTable(table: string, rows: any[]) {
  const target = tableFile(table);
  await mkdir(dirname(target), { recursive: true });
  const temp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  await writeFile(temp, JSON.stringify(rows));
  await rename(temp, target);
}
function nextId(table: string, _row: any) {
  idCounter += 1;
  return safe(table) + '_' + Date.now().toString(36) + '_' + idCounter + '_' + Math.random().toString(36).slice(2, 7);
}

export const ws: any = {
  async send() {
    return true;
  },
};

export const db = {
  async add(table: string, records: any[]): Promise<string[]> {
    return withLock(table, async () => {
    const rows = await readTable(table);
    const ids: string[] = [];
    for (const record of records) {
      const id = nextId(table, record);
      rows.push({ ...record, __appdeploy_ddb_id: id });
      ids.push(id);
    }
    await writeTable(table, rows);
    return ids;
    });
  },
  async get<T = any>(table: string, ids: string[]): Promise<T[]> {
    const rows = await readTable(table);
    return ids.map(id => rows.find(row => row.__appdeploy_ddb_id === id)).filter(Boolean) as T[];
  },
  async list<T = any>(table: string, options: any = {}): Promise<{ items: T[]; nextToken?: string }> {
    const rows = await readTable(table);
    const limit = Number(options.limit) || 50;
    const start = Number(options.nextToken ? Buffer.from(options.nextToken, 'base64').toString() : 0) || 0;
    const slice = rows.slice(start, start + limit);
    const items = slice.map(row => {
      if (options.appdeploy_system_id) return { ...row };
      const { __appdeploy_ddb_id, ...rest } = row;
      return rest;
    });
    const nextIndex = start + slice.length;
    return {
      items: items as T[],
      nextToken: nextIndex < rows.length ? Buffer.from(String(nextIndex)).toString('base64') : undefined,
    };
  },
  async delete(table: string, ids: string[]): Promise<boolean[]> {
    return withLock(table, async () => {
    const rows = await readTable(table);
    const results = ids.map(id => {
      const at = rows.findIndex(row => row.__appdeploy_ddb_id === id);
      if (at === -1) return false;
      rows.splice(at, 1);
      return true;
    });
    await writeTable(table, rows);
    return results;
    });
  },
  tx: {
    async update(table: string, entries: any[], options: any = {}): Promise<boolean[]> {
      return withLock(table, async () => {
      const rows = await readTable(table);
      const results = entries.map(entry => {
        const row = rows.find(item => item.__appdeploy_ddb_id === entry.id);
        if (!row) return false;
        if (options.patch) {
          Object.assign(row, entry.record);
        } else {
          const id = row.__appdeploy_ddb_id;
          Object.keys(row).forEach(key => delete row[key]);
          Object.assign(row, entry.record, { __appdeploy_ddb_id: id });
        }
        return true;
      });
      await writeTable(table, rows);
      return results;
      });
    },
  },
};

export const storage = {
  async write(objects: { path: string; content: string; contentType?: string }[]) {
    await mkdir(storageDir, { recursive: true });
    const results: boolean[] = [];
    for (const object of objects) {
      try {
        await writeFile(flatPath(object.path), Buffer.from(object.content, 'base64'));
        results.push(true);
      } catch {
        results.push(false);
      }
    }
    return results;
  },
  async read(paths: string[]) {
    const results: { content: string | null }[] = [];
    for (const path of paths) {
      try {
        results.push({ content: (await readFile(flatPath(path))).toString('base64') });
      } catch {
        results.push({ content: null });
      }
    }
    return results;
  },
  async delete(paths: string[]) {
    const results: boolean[] = [];
    for (const path of paths) {
      try {
        await unlink(flatPath(path));
        results.push(true);
      } catch {
        results.push(false);
      }
    }
    return results;
  },
};

export function json(body: any, status = 200) {
  return { statusCode: status, body: JSON.stringify(body) };
}
export function error(message: string, status = 400) {
  return { statusCode: status, body: JSON.stringify({ error: message }) };
}
export function requireAuth() {
  return (ctx: Ctx) => {
    if (!ctx.user) return error('Authentication required.', 401);
    return null;
  };
}
export function router(routes: Record<string, ((ctx: Ctx) => any)[]>) {
  return async (event: any) => {
    const method = event.requestContext?.http?.method || event.method || 'GET';
    const rawPath = event.rawPath || event.path || '/';
    const body = event.body ? JSON.parse(event.body) : {};
    const query = event.queryStringParameters || {};
    const headers = event.headers || {};
    const user = headers['x-test-user'] ? { userId: headers['x-test-user'] } : event.user;

    for (const [pattern, chain] of Object.entries(routes)) {
      const [routeMethod, routePath] = pattern.split(' ');
      if (routeMethod !== method) continue;
      const routeParts = routePath.split('/');
      const pathParts = rawPath.split('/');
      if (routeParts.length !== pathParts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < routeParts.length; i += 1) {
        if (routeParts[i].startsWith(':')) params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        else if (routeParts[i] !== pathParts[i]) { matched = false; break; }
      }
      if (!matched) continue;

      // Mirror the production resolver: every request acts on a workspace.
      const ctx: Ctx & { workspace?: { id: string; role: string } } = {
        body,
        params,
        query,
        user: user as any,
        workspace: user
          ? {
              id:
                (query as any).ws ||
                'personal-' +
                  String((user as any).userId).replace(/[^a-zA-Z0-9]/g, ''),
              role: 'owner',
            }
          : undefined,
      };
      for (const middleware of chain) {
        const result = await middleware(ctx);
        if (result) return result;
      }
      return { statusCode: 404, body: JSON.stringify({ error: 'Not found.' }) };
    }
    return { statusCode: 404, body: JSON.stringify({ error: 'Not found.' }) };
  };
}
