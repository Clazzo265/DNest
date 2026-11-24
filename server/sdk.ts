/**
 * `@appdeploy/sdk` contract implementation for self-hosted DataNest.
 *
 * The backend is written against this interface. In a real AppDeploy deployment
 * the platform supplies it; here it is backed by `FileAdapter`, so the exact
 * backend code that the test suite exercises is what runs in production.
 */

import { join, resolve } from 'node:path';
import { FileAdapter } from './adapter';

export type Ctx = {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  user?: { userId: string; email?: string; name?: string };
  /** Canonical public base URL (no trailing slash) when the operator set one. */
  publicOrigin?: string;
  /** Active shared vault and the caller's role in it. */
  workspace?: { id: string; role: 'owner' | 'editor' | 'viewer' };
  headers: Record<string, string>;
  method: string;
  path: string;
};

export type Result = { statusCode: number; body: string; headers?: Record<string, string> };

/**
 * Data root, resolved here rather than in the HTTP layer.
 *
 * This module is imported before `server/index.ts` runs any statement (ES module
 * evaluation order), so deriving paths later silently ignored DATANEST_DATA_DIR
 * and wrote to ./data relative to the working directory. Resolving it at the
 * point of construction keeps env config authoritative.
 */
const DATA_ROOT = resolve(
  process.env.DATANEST_DATA_DIR || join(process.cwd(), 'data')
);

const adapter = new FileAdapter({
  tables: process.env.DATANEST_TABLES_DIR || join(DATA_ROOT, 'tables'),
  storage: process.env.DATANEST_STORAGE_DIR || join(DATA_ROOT, 'storage'),
});

export { adapter };

export const db = {
  add: (table: string, records: Record<string, unknown>[]) =>
    adapter.add(table, records),
  get: <T>(table: string, ids: string[]) => adapter.get<T>(table, ids),
  list: <T>(
    table: string,
    options?: { limit?: number; nextToken?: string; appdeploy_system_id?: boolean }
  ) => adapter.list<T>(table, options),
  delete: (table: string, ids: string[]) => adapter.delete(table, ids),
  tx: {
    update: (
      table: string,
      entries: { id: string; record: Record<string, unknown> }[],
      options?: { patch?: boolean }
    ) => adapter.update(table, entries, options),
  },
};

export const storage = {
  write: (objects: { path: string; content: string; contentType?: string }[]) =>
    adapter.writeObject(objects),
  read: (paths: string[]) => adapter.readObject(paths),
  delete: (paths: string[]) => adapter.deleteObject(paths),
};

/**
 * Realtime pub/sub. The vault does not push events yet; the module exists so the
 * SDK contract stays complete and callers never crash on a missing export.
 */
export const ws = {
  /** The platform addresses a set of connections; realtime is not wired yet. */
  async send(
    _connectionIds: string | string[],
    _payload?: unknown
  ): Promise<boolean> {
    return true;
  },
  async broadcast(_payload?: unknown): Promise<boolean> {
    return true;
  },
};

export function json(body: unknown, status = 200): Result {
  return {
    statusCode: status,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  };
}

export function error(message: string, status = 400): Result {
  return json({ error: message }, status);
}

/**
 * Route guard. Authentication is resolved by the HTTP layer (signed session
 * cookie) and handed in as `ctx.user`; this only enforces its presence.
 */
export function requireAuth() {
  return (ctx: Ctx) =>
    ctx.user ? null : error('Sign in to access your vault.', 401);
}

/** Middleware returns a Result to short-circuit, or null to continue. */
export type RouteHandler = (ctx: Ctx) => Promise<Result | null> | Result | null;

export function router(routes: Record<string, RouteHandler[]>) {
  // Pre-compute segments once; matching runs per request.
  const compiled = Object.entries(routes).map(([pattern, chain]) => {
    const [method, path] = pattern.split(' ');
    return {
      method,
      segments: path.split('/').filter(Boolean),
      chain,
      hasParams: path.includes(':'),
    };
  });

  // Specific routes win: fewer parameters first, so `chunks/read` is never
  // captured by `chunks/:index`.
  compiled.sort((a, b) => {
    const aParams = a.segments.filter(segment => segment.startsWith(':')).length;
    const bParams = b.segments.filter(segment => segment.startsWith(':')).length;
    return aParams - bParams;
  });

  return async (ctx: Ctx): Promise<Result> => {
    const requestSegments = ctx.path.split('/').filter(Boolean);

    for (const route of compiled) {
      if (route.method !== ctx.method) continue;
      if (route.segments.length !== requestSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(requestSegments[index]);
        } else if (segment !== requestSegments[index]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      const invoked: Ctx = { ...ctx, params };
      for (const middleware of route.chain) {
        const result = await middleware(invoked);
        if (result) return result;
      }
      return error('Not found.', 404);
    }

    return error(
      'No route for ' + ctx.method + ' ' + ctx.path + '.',
      404
    );
  };
}
