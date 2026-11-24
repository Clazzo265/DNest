/**
 * Type surface for the AppDeploy runtime packages.
 *
 * These modules are injected by the AppDeploy platform and are not published to
 * npm, so the repository cannot resolve their real declarations. This file
 * declares exactly the API DataNest uses, keeping `tsc` honest about how the
 * client is called without pretending to ship the vendor SDK.
 *
 * Keep this in sync with the adapter in `src/transfer.ts` and the backend.
 */

declare module '@appdeploy/client' {
  type RequestOptions = {
    params?: Record<string, string>;
    signal?: AbortSignal;
  };

  type ApiResponse<T = unknown> = { data: T };

  type ApiError = Error & {
    response?: { status: number; data?: { error?: string; message?: string } };
  };

  export const api: {
    get<T = any>(url: string, options?: RequestOptions): Promise<ApiResponse<T>>;
    post<T = any>(
      url: string,
      body?: unknown,
      options?: { signal?: AbortSignal }
    ): Promise<ApiResponse<T>>;
    put<T = any>(url: string, body?: unknown): Promise<ApiResponse<T>>;
    delete<T = any>(url: string): Promise<ApiResponse<T>>;
  };

  export const auth: {
    getUser(): Promise<unknown>;
    signInWithRedirect(): Promise<void>;
    signOut(): Promise<void>;
  };

  export type { ApiResponse, ApiError, RequestOptions };
}
