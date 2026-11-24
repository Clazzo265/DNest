/**
 * Workspaces: shared vaults with members and roles.
 *
 * Before this, a vault *was* an account: tables were named `vault_<userKey>` and
 * storage lived under `users/<userKey>/`. There was no way for a second person to
 * reach that data, so "invite a member" had nothing to attach to.
 *
 * A workspace is now the unit of data ownership:
 *
 *   vault index     vault_ws_<workspaceId>          records
 *   usage           vault_usage_ws_<workspaceId>    quota counters
 *   parts           vault_progress_ws_<workspaceId> upload bitmaps
 *   storage         workspaces/<workspaceId>/files/...
 *   members         ws_members_<workspaceId>        userId -> role
 *   invites         ws_invites_<workspaceId>        pending tokens
 *
 * Every personal account still works exactly as before: signing up creates a
 * workspace with a deterministic id (`personal-<accountKey>`) owned by that user,
 * so existing data keeps resolving and every API call keeps a concrete
 * workspace to scope to.
 *
 * Roles:
 *   owner   full control, can invite and remove members, cannot be removed
 *   editor  can create, edit and delete items and upload files
 *   viewer  read-only, including downloads
 *
 * Invites are 192-bit random tokens stored only as SHA-256 hashes, so a leaked
 * database file cannot be replayed as working invites. They expire and are
 * single-use.
 */

import { createHash, randomBytes } from 'node:crypto';
import { db } from '@appdeploy/sdk';

export type Role = 'owner' | 'editor' | 'viewer';
export type WorkspaceKind = 'personal' | 'shared';

export type Workspace = {
  id: string;
  __appdeploy_ddb_id?: string;
  kind: WorkspaceKind;
  name: string;
  ownerId: string;
  createdAt: string;
};

export type Member = {
  __appdeploy_ddb_id?: string;
  workspaceId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: string;
  invitedBy?: string;
};

export type Invite = {
  __appdeploy_ddb_id?: string;
  workspaceId: string;
  tokenHash: string;
  role: Role;
  invitedBy: string;
  invitedEmail?: string;
  createdAt: string;
  expiresAt: number;
  acceptedAt?: string | null;
  acceptedBy?: string | null;
};

const WORKSPACES_TABLE = 'ws_workspaces';
const USERS_TABLE = 'datanest_users';
const SHORT_CODE_LENGTH = 12;

/** Invites expire after 7 days: long enough for WhatsApp, short enough to matter. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function membersTableFor(workspaceId: string): string {
  return 'ws_members_' + workspaceId;
}

export function invitesTableFor(workspaceId: string): string {
  return 'ws_invites_' + workspaceId;
}

/** Deterministic personal workspace id: keeps pre-workspace data addressable. */
export function personalWorkspaceId(accountKey: string): string {
  return 'personal-' + accountKey;
}

export function vaultTableFor(workspaceId: string): string {
  return 'vault_' + workspaceId;
}

export function usageTableFor(workspaceId: string): string {
  return 'vault_usage_' + workspaceId;
}

export function progressTableFor(workspaceId: string): string {
  return 'vault_progress_' + workspaceId;
}

export function canWrite(role: Role | null): boolean {
  return role === 'owner' || role === 'editor';
}

export function canAdmin(role: Role | null): boolean {
  return role === 'owner';
}

// ---- workspaces -------------------------------------------------------------

export async function getWorkspace(id: string): Promise<Workspace | null> {
  if (!id) return null;
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const batch = await db.list<Workspace>(WORKSPACES_TABLE, {
      limit: 1000,
      nextToken,
      appdeploy_system_id: true,
    });
    const match = batch.items.find(row => row.id === id);
    if (match) return match;
    if (!batch.nextToken) return null;
    nextToken = batch.nextToken;
  }
  return null;
}

async function listAllWorkspaces(): Promise<Workspace[]> {
  const all: Workspace[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const batch = await db.list<Workspace>(WORKSPACES_TABLE, {
      limit: 1000,
      nextToken,
      appdeploy_system_id: true,
    });
    all.push(...batch.items);
    if (!batch.nextToken) break;
    nextToken = batch.nextToken;
  }
  return all;
}

export async function createWorkspace(input: {
  id?: string;
  kind: WorkspaceKind;
  name: string;
  ownerId: string;
}): Promise<Workspace> {
  const id =
    input.id ||
    (input.kind === 'personal'
      ? personalWorkspaceId(input.ownerId.replace(/[^a-zA-Z0-9]/g, ''))
      : 'ws-' + randomBytes(8).toString('hex'));

  const workspace: Workspace = {
    id,
    kind: input.kind,
    name: input.name,
    ownerId: input.ownerId,
    createdAt: new Date().toISOString(),
  };
  await db.add(WORKSPACES_TABLE, [workspace as unknown as Record<string, unknown>]);
  return workspace;
}

/**
 * Return the user's personal workspace, creating it on first use.
 *
 * Accounts that existed before workspaces did get a workspace with the
 * deterministic id, so their existing tables resolve without a migration step.
 */
export async function ensurePersonalWorkspace(input: {
  userId: string;
  accountKey: string;
  name: string;
  email: string;
}): Promise<Workspace> {
  const id = personalWorkspaceId(input.accountKey);
  const existing = await getWorkspace(id);
  if (existing) {
    // Self-heal a missing membership row (e.g. created before this existed).
    await ensureMember({
      workspaceId: id,
      userId: input.userId,
      email: input.email,
      name: input.name,
      role: 'owner',
    });
    return existing;
  }

  const workspace = await createWorkspace({
    id,
    kind: 'personal',
    name: input.name + "'s vault",
    ownerId: input.userId,
  });
  await ensureMember({
    workspaceId: id,
    userId: input.userId,
    email: input.email,
    name: input.name,
    role: 'owner',
  });
  return workspace;
}

/** Workspaces a user can reach: their own plus those they were invited to. */
export async function workspacesForUser(userId: string): Promise<Workspace[]> {
  const all = await listAllWorkspaces();
  const reachable: Workspace[] = [];

  for (const workspace of all) {
    if (workspace.ownerId === userId) {
      reachable.push(workspace);
      continue;
    }
    const membership = await getMember(workspace.id, userId);
    if (membership) reachable.push(workspace);
  }

  return reachable.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'personal' ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const workspace = await getWorkspace(id);
  if (!workspace?.__appdeploy_ddb_id) return;
  await db.tx.update(
    WORKSPACES_TABLE,
    [{ id: workspace.__appdeploy_ddb_id, record: { name } }],
    { patch: true }
  );
}

export async function deleteWorkspaceRow(id: string): Promise<void> {
  const workspace = await getWorkspace(id);
  if (workspace?.__appdeploy_ddb_id) {
    await db.delete(WORKSPACES_TABLE, [workspace.__appdeploy_ddb_id]);
  }
}

// ---- members ---------------------------------------------------------------

export async function listMembers(workspaceId: string): Promise<Member[]> {
  const page = await db.list<Member>(membersTableFor(workspaceId), {
    limit: 1000,
    appdeploy_system_id: true,
  });
  return page.items.sort((a, b) => {
    if (a.role !== b.role) return ROLE_RANK[b.role] - ROLE_RANK[a.role];
    return a.joinedAt.localeCompare(b.joinedAt);
  });
}

export async function getMember(
  workspaceId: string,
  userId: string
): Promise<Member | null> {
  const members = await listMembers(workspaceId);
  return members.find(member => member.userId === userId) ?? null;
}

export async function ensureMember(input: {
  workspaceId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  invitedBy?: string;
}): Promise<Member> {
  const existing = await getMember(input.workspaceId, input.userId);
  if (existing) return existing;

  const member: Member = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    email: input.email,
    name: input.name,
    role: input.role,
    joinedAt: new Date().toISOString(),
    invitedBy: input.invitedBy,
  };
  await db.add(membersTableFor(input.workspaceId), [
    member as unknown as Record<string, unknown>,
  ]);
  return member;
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: Role
): Promise<boolean> {
  const member = await getMember(workspaceId, userId);
  if (!member?.__appdeploy_ddb_id) return false;
  await db.tx.update(
    membersTableFor(workspaceId),
    [{ id: member.__appdeploy_ddb_id, record: { role } }],
    { patch: true }
  );
  return true;
}

export async function removeMember(
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const member = await getMember(workspaceId, userId);
  if (!member?.__appdeploy_ddb_id) return false;
  const results = await db.delete(membersTableFor(workspaceId), [
    member.__appdeploy_ddb_id,
  ]);
  return Boolean(results[0]);
}

export async function countOwners(workspaceId: string): Promise<number> {
  const members = await listMembers(workspaceId);
  return members.filter(member => member.role === 'owner').length;
}

// ---- invites ---------------------------------------------------------------

export function newInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Short, human-shareable code. Only useful together with the full token, which
 * is why it can be this short: it disambiguates a link, it does not authenticate
 * one on its own.
 */
export function shortCodeFor(token: string): string {
  return hashInviteToken(token).slice(0, SHORT_CODE_LENGTH);
}

export async function createInvite(input: {
  workspaceId: string;
  role: Role;
  invitedBy: string;
  invitedEmail?: string;
}): Promise<{ invite: Invite; token: string; code: string }> {
  const token = newInviteToken();
  const invite: Invite = {
    workspaceId: input.workspaceId,
    tokenHash: hashInviteToken(token),
    role: input.role,
    invitedBy: input.invitedBy,
    invitedEmail: input.invitedEmail,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + INVITE_TTL_MS,
    acceptedAt: null,
    acceptedBy: null,
  };
  await db.add(invitesTableFor(input.workspaceId), [
    invite as unknown as Record<string, unknown>,
  ]);
  return { invite, token, code: shortCodeFor(token) };
}

export async function listInvites(workspaceId: string): Promise<Invite[]> {
  const page = await db.list<Invite>(invitesTableFor(workspaceId), {
    limit: 1000,
    appdeploy_system_id: true,
  });
  const now = Date.now();
  return page.items
    .filter(
      invite => !invite.acceptedAt && Number(invite.expiresAt) > now
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findInviteByToken(
  workspaceId: string,
  token: string
): Promise<Invite | null> {
  const page = await db.list<Invite>(invitesTableFor(workspaceId), {
    limit: 1000,
    appdeploy_system_id: true,
  });
  const tokenHash = hashInviteToken(token);
  return page.items.find(invite => invite.tokenHash === tokenHash) ?? null;
}

export async function markInviteAccepted(
  workspaceId: string,
  invite: Invite,
  userId: string
): Promise<void> {
  if (!invite.__appdeploy_ddb_id) return;
  await db.tx.update(
    invitesTableFor(workspaceId),
    [
      {
        id: invite.__appdeploy_ddb_id,
        record: { acceptedAt: new Date().toISOString(), acceptedBy: userId },
      },
    ],
    { patch: true }
  );
}

export async function revokeInvite(
  workspaceId: string,
  code: string
): Promise<boolean> {
  const page = await db.list<Invite>(invitesTableFor(workspaceId), {
    limit: 1000,
    appdeploy_system_id: true,
  });
  const match = page.items.find(
    invite => invite.tokenHash.slice(0, SHORT_CODE_LENGTH) === code
  );
  if (!match?.__appdeploy_ddb_id) return false;
  const results = await db.delete(invitesTableFor(workspaceId), [
    match.__appdeploy_ddb_id,
  ]);
  return Boolean(results[0]);
}

/** Look up a user by email so an invite can be bound to an existing account. */
export async function findUserByEmail(
  email: string
): Promise<{ userId: string; email: string; name: string } | null> {
  const page = await db.list<{
    __appdeploy_ddb_id?: string;
    email: string;
    name: string;
  }>(USERS_TABLE, { limit: 1000, appdeploy_system_id: true });
  const match = page.items.find(
    row => row.email === email.trim().toLowerCase()
  );
  if (!match?.__appdeploy_ddb_id) return null;
  return {
    userId: match.__appdeploy_ddb_id,
    email: match.email,
    name: match.name,
  };
}
