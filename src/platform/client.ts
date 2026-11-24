/**
 * `@appdeploy/client` implementation for self-hosted DataNest.
 *
 * Talks to the bundled server (`server/index.ts`) over relative URLs, so the app
 * and API always share an origin and no CORS or absolute host is involved.
 * Credentials ride in an HttpOnly session cookie the browser attaches
 * automatically; this module never touches tokens.
 */

export type ApiResponse<T = unknown> = { data: T; status: number };

export type ApiError = Error & {
  response?: { status: number; data?: { error?: string; message?: string } };
};

type RequestOptions = {
  params?: Record<string, string>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

function buildUrl(url: string, params?: Record<string, string>): string {
  if (!params) return url;
  const search = new URLSearchParams(params).toString();
  return search ? url + '?' + search : url;
}

async function send<T>(
  url: string,
  init: RequestInit
): Promise<ApiResponse<T>> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }

  if (!response.ok) {
    const payload = data as { error?: string; message?: string } | null;
    const error = new Error(
      payload?.error || payload?.message || 'Request failed (' + response.status + ').'
    ) as ApiError;
    error.response = { status: response.status, data: payload ?? undefined };
    throw error;
  }

  return { data: data as T, status: response.status };
}

export const api = {
  get: <T = any>(url: string, options: RequestOptions = {}) =>
    send<T>(buildUrl(url, options.params), {
      method: 'GET',
      signal: options.signal,
      headers: options.headers,
    }),

  post: <T = any>(
    url: string,
    body?: unknown,
    options: { signal?: AbortSignal; headers?: Record<string, string> } = {}
  ) =>
    send<T>(url, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
      signal: options.signal,
      headers: options.headers,
    }),

  put: <T = any>(url: string, body?: unknown) =>
    send<T>(url, { method: 'PUT', body: JSON.stringify(body ?? {}) }),

  delete: <T = any>(url: string) => send<T>(url, { method: 'DELETE' }),
};

export type AppUser = { userId: string; email: string; name: string };

export const auth = {
  /** Returns the signed-in user, or null. Never throws for an anonymous visitor. */
  async getUser(): Promise<AppUser | null> {
    try {
      const response = await api.get<{ user: AppUser | null }>('/api/session');
      return response.data?.user ?? null;
    } catch {
      return null;
    }
  },

  async signUp(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<AppUser> {
    const response = await api.post<{ user: AppUser }>(
      '/api/auth/signup',
      input
    );
    return response.data.user;
  },

  async signIn(input: { email: string; password: string }): Promise<AppUser> {
    const response = await api.post<{ user: AppUser }>(
      '/api/auth/signin',
      input
    );
    return response.data.user;
  },

  async signOut(): Promise<void> {
    await api.post('/api/auth/signout', {});
  },
};
