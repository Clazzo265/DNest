/** LOCAL TEST HARNESS ONLY: stub for @appdeploy/client used by the dev harness. */
type Call = { url: string; init: RequestInit };

/** Resolved per request so tests can point the adapter at a fresh server. */
function apiBase(): string {
  return (globalThis as any).__DATANEST_BASE__ || '';
}
const DEMO_USER = 'demo-nest-owner';

async function send(request: Call) {
  const response = await fetch(apiBase() + request.url, {
    ...request.init,
    headers: {
      'content-type': 'application/json',
      // The harness has no auth proxy, so identity travels as a header.
      'x-test-user': DEMO_USER,
      ...(request.init.headers as any),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(
      (data && (data.error || data.message)) || 'Request failed'
    ) as Error & { response?: { status: number; data: unknown } };
    error.response = { status: response.status, data };
    throw error;
  }
  return { data };
}

function withQuery(url: string, params?: Record<string, string>) {
  if (!params) return url;
  const search = new URLSearchParams(params).toString();
  return search ? url + '?' + search : url;
}

export const api = {
  get: (url: string, options: { params?: Record<string, string>; signal?: AbortSignal } = {}) =>
    send({ url: withQuery(url, options.params), init: { method: 'GET', signal: options.signal } }),
  post: (url: string, body?: unknown, options: { signal?: AbortSignal } = {}) =>
    send({ url, init: { method: 'POST', body: JSON.stringify(body ?? {}), signal: options.signal } }),
  put: (url: string, body?: unknown) =>
    send({ url, init: { method: 'PUT', body: JSON.stringify(body ?? {}) } }),
  delete: (url: string) => send({ url, init: { method: 'DELETE' } }),
  patch: (url: string, body?: unknown) =>
    send({ url, init: { method: 'PATCH', body: JSON.stringify(body ?? {}) } }),
};

/** Dev harness: only what the tests use. */
export const workspaces = {
  async list() {
    const response = await api.get('/api/workspaces');
    return response.data;
  },
  async create(name: string) {
    const response = await api.post('/api/workspaces', { name });
    return (response.data as any).workspace;
  },
  async rename(name: string) {
    await api.patch('/api/workspace', { name });
  },
  async members(ws?: string) {
    const response = await api.get(
      ws ? '/api/workspace?ws=' + encodeURIComponent(ws) : '/api/workspace'
    );
    return response.data;
  },
  async invite(input: any) {
    const response = await api.post('/api/workspace/invites', input);
    return response.data;
  },
  async revokeInvite(code: string) {
    await api.delete('/api/workspace/invites/' + encodeURIComponent(code));
  },
  async setRole(userId: string, role: string) {
    await api.patch('/api/workspace/members/' + encodeURIComponent(userId), { role });
  },
  async removeMember(userId: string) {
    await api.delete('/api/workspace/members/' + encodeURIComponent(userId));
  },
  async invitePreview(workspaceId: string, token: string) {
    const response = await api.get(
      '/api/invites/' + encodeURIComponent(workspaceId) + '/' + encodeURIComponent(token)
    );
    return response.data;
  },
  async acceptInvite(workspaceId: string, token: string) {
    const response = await api.post(
      '/api/invites/' + encodeURIComponent(workspaceId) + '/' + encodeURIComponent(token),
      {}
    );
    return response.data;
  },
};

export const auth = {
  async getUser(): Promise<unknown> {
    // The local harness has no identity provider, so a demo account is used.
    // Swap for the real @appdeploy/client to use the platform's sign-in.
    return (
      (globalThis as any).__DATANEST_USER__ ?? {
        userId: DEMO_USER,
        name: 'Demo owner',
        email: 'owner@datanest.local',
      }
    );
  },
  async signInWithRedirect(): Promise<void> {
    throw new Error('Sign-in is not available in the local harness.');
  },
  async signOut(): Promise<void> {
    (globalThis as any).__DATANEST_USER__ = null;
  },
};
