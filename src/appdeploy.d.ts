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
    patch<T = any>(url: string, body?: unknown): Promise<ApiResponse<T>>;
    delete<T = any>(url: string): Promise<ApiResponse<T>>;
  };

  export type AppUser = { userId: string; email: string; name: string };

  export type WorkspaceSummary = {
    id: string;
    name: string;
    kind: 'personal' | 'shared';
    role: 'owner' | 'editor' | 'viewer';
    ownerId: string;
    memberCount: number;
    quota: {
      quotaBytes: number;
      usedBytes: number;
      reservedBytes: number;
      remainingBytes: number;
      percentUsed: number;
      fileCount: number;
      recordCount: number;
    };
  };

  export const workspaces: {
    list(): Promise<{
      workspaces: WorkspaceSummary[];
      activeId: string;
      role: 'owner' | 'editor' | 'viewer' | null;
    }>;
    create(name: string): Promise<WorkspaceSummary>;
    rename(name: string): Promise<void>;
    members(ws?: string): Promise<{
      members: {
        userId: string;
        email: string;
        name: string;
        role: 'owner' | 'editor' | 'viewer';
        joinedAt: string;
      }[];
      invites: {
        code: string;
        role: string;
        invitedEmail: string | null;
        createdAt: string;
        expiresAt: number;
      }[];
    }>;
    invite(input: {
      role: 'editor' | 'viewer';
      email?: string;
    }): Promise<{ token: string; code: string; path: string; url: string; expiresAt: number }>;
    revokeInvite(code: string): Promise<void>;
    setRole(
      userId: string,
      role: 'owner' | 'editor' | 'viewer'
    ): Promise<void>;
    removeMember(userId: string): Promise<void>;
    invitePreview(
      workspaceId: string,
      token: string
    ): Promise<{
      workspaceName: string;
      role: 'owner' | 'editor' | 'viewer';
      invitedEmail: string | null;
      expiresAt: number;
    }>;
    acceptInvite(
      workspaceId: string,
      token: string
    ): Promise<{ workspaceId: string; workspaceName: string; role: string }>;
  };

  export const auth: {
    getUser(): Promise<unknown>;
    signInWithRedirect(): Promise<void>;
    signOut(): Promise<void>;
    /** Self-hosted build only: cookie session endpoints. */
    signIn?(input: { email: string; password: string }): Promise<AppUser>;
    signUp?(input: {
      email: string;
      password: string;
      name?: string;
    }): Promise<AppUser>;
  };

  export type { ApiResponse, ApiError, RequestOptions };
}
