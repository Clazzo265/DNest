/**
 * Vault members and invitation.
 *
 * The product requirement is specifically "invite people over WhatsApp", so the
 * invite flow is built around a shareable link rather than an email send: no
 * mail server is involved, the owner gets a link and/or a prefilled WhatsApp
 * message, and the recipient can join whether or not they already have an
 * account.
 *
 * Security notes that matter for a shareable link:
 *  - the raw token is shown once and never recoverable, only its hash is stored;
 *  - links expire after 7 days and work exactly once;
 *  - the landing page shows only the vault name and the offered role;
 *  - joining requires being signed in, so a forwarded link cannot silently add
 *    somebody who never agreed.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  LoaderCircle,
  Mail,
  MessageCircle,
  Share2,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { errorMessage } from './transfer';

export type Role = 'owner' | 'editor' | 'viewer';

export type MemberRow = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: string;
};

export type InviteRow = {
  code: string;
  role: string;
  invitedEmail: string | null;
  createdAt: string;
  expiresAt: number;
};

type InviteApi = {
  members(ws?: string): Promise<{ members: MemberRow[]; invites: InviteRow[] }>;
  invite(input: {
    role: 'editor' | 'viewer';
    email?: string;
  }): Promise<{ token: string; code: string; path: string; expiresAt: number }>;
  revokeInvite(code: string): Promise<void>;
  setRole(userId: string, role: Role): Promise<void>;
  removeMember(userId: string): Promise<void>;
};

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  viewer: 'Can view',
};

const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control: manage members, invites and settings.',
  editor: 'Add, edit and delete items and upload files.',
  viewer: 'Read-only access, including downloads.',
};

/**
 * True when the invite URL points at a loopback address, which no one else can
 * open. Worth saying out loud rather than letting someone WhatsApp a dead link.
 */
export function isUnreachableLink(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/)/i.test(url);
}

/**
 * Build the absolute invite URL from wherever the app is actually served.
 * The workspace id is part of the path: an invite resolves against one vault, and
 * the join page needs to know which before the visitor has an account.
 */
export function inviteUrl(workspaceId: string, token: string): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : '';
  return (
    origin +
    '/join/' +
    encodeURIComponent(workspaceId) +
    '/' +
    encodeURIComponent(token)
  );
}

/**
 * WhatsApp deep link. `wa.me` opens the app on mobile and WhatsApp Web on
 * desktop, and the prefilled text works in both.
 */
export function whatsappShareUrl(message: string): string {
  return 'https://wa.me/?text=' + encodeURIComponent(message);
}

export function inviteMessage(vaultName: string, url: string): string {
  return (
    "I'd like to share my DataNest vault with you — \"" +
    vaultName +
    '".\n\nOpen this link to join:\n' +
    url +
    '\n\nThe link works once and expires in 7 days.'
  );
}

function formatWhen(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function MembersPanel({
  api,
  workspaceId,
  vaultName,
  currentUserId,
  currentRole,
  onToast,
  onChanged,
}: {
  api: InviteApi;
  workspaceId: string;
  vaultName: string;
  currentUserId: string;
  currentRole: Role;
  onToast: (message: string) => void;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [email, setEmail] = useState('');
  const [freshInvite, setFreshInvite] = useState<{
    token: string;
    url: string;
    code: string;
  } | null>(null);
  const [copied, setCopied] = useState('');

  const isOwner = currentRole === 'owner';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.members(workspaceId);
      setMembers(data.members || []);
      setInvites(data.invites || []);
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [api, workspaceId, onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      onToast('Copied to clipboard.');
      window.setTimeout(() => setCopied(''), 2000);
    } catch {
      onToast('Copy failed. Select the link and copy it manually.');
    }
  }

  async function createInvite() {
    setBusy('invite');
    try {
      const invite = await api.invite({
        role,
        email: email.trim() || undefined,
      });
      const url = inviteUrl(workspaceId, invite.token);
      setFreshInvite({ token: invite.token, url, code: invite.code });
      setEmail('');
      await load();
      onToast('Invite link ready. Share it however you like.');
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy('');
    }
  }

  async function remove(userId: string) {
    setBusy(userId);
    try {
      await api.removeMember(userId);
      onToast('Member removed.');
      await load();
      onChanged();
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy('');
    }
  }

  async function changeRole(userId: string, next: Role) {
    setBusy(userId);
    try {
      await api.setRole(userId, next);
      onToast('Role updated.');
      await load();
      onChanged();
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy('');
    }
  }

  async function revoke(code: string) {
    setBusy(code);
    try {
      await api.revokeInvite(code);
      onToast('Invite revoked.');
      await load();
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy('');
    }
  }

  if (loading) {
    return (
      <div className="members-loading">
        <LoaderCircle size={18} className="spin" /> Loading members…
      </div>
    );
  }

  return (
    <div className="members-panel">
      {isOwner && (
        <section className="invite-card">
          <div className="invite-card-head">
            <div className="invite-icon">
              <UserPlus size={18} />
            </div>
            <div>
              <strong>Invite a member</strong>
              <span>
                Create a link, then share it on WhatsApp, by email, or anywhere
                else.
              </span>
            </div>
          </div>

          <div className="invite-controls">
            <label className="invite-field">
              <span>They can</span>
              <select
                value={role}
                onChange={event =>
                  setRole(event.target.value as 'editor' | 'viewer')
                }
              >
                <option value="editor">Edit and upload</option>
                <option value="viewer">View and download</option>
              </select>
            </label>
            <label className="invite-field">
              <span>
                For <em className="optional-label">optional</em>
              </span>
              <input
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="their@email.com"
                type="email"
              />
            </label>
            <button
              className="primary-button create-invite"
              onClick={() => void createInvite()}
              disabled={busy === 'invite'}
            >
              {busy === 'invite' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Share2 size={15} />
              )}
              Create link
            </button>
          </div>

          {freshInvite && (
            <div className="invite-result">
              <div className="invite-result-head">
                <Shield size={14} />
                <span>Shown once — copy it now</span>
              </div>
              <code className="invite-link">{freshInvite.url}</code>
              {isUnreachableLink(freshInvite.url) && (
                <p className="invite-warning">
                  This link points at <strong>localhost</strong>, so it only works
                  on this computer. Open DataNest through its public address (or
                  deploy it) and create the invite there.
                </p>
              )}
              <div className="invite-actions">
                <button
                  className="ghost-button"
                  onClick={() => void copy(freshInvite.url, 'link')}
                >
                  {copied === 'link' ? (
                    <Check size={14} />
                  ) : (
                    <Copy size={14} />
                  )}
                  Copy link
                </button>
                <a
                  className="whatsapp-button"
                  href={whatsappShareUrl(
                    inviteMessage(vaultName, freshInvite.url)
                  )}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <MessageCircle size={15} /> Share on WhatsApp
                </a>
                <a
                  className="ghost-button"
                  href={
                    'mailto:?subject=' +
                    encodeURIComponent('Join my DataNest vault') +
                    '&body=' +
                    encodeURIComponent(
                      inviteMessage(vaultName, freshInvite.url)
                    )
                  }
                >
                  <Mail size={14} /> Email
                </a>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="member-list-card">
        <div className="member-list-head">
          <strong>
            <Users size={15} /> {members.length}{' '}
            {members.length === 1 ? 'member' : 'members'}
          </strong>
        </div>
        <ul className="member-list">
          {members.map(member => {
            const isSelf = member.userId === currentUserId;
            return (
              <li key={member.userId} className="member-row">
                <div className="member-avatar">
                  {(member.name || member.email || 'U')[0].toUpperCase()}
                </div>
                <div className="member-copy">
                  <strong>
                    {member.name || member.email || 'Member'}
                    {isSelf && <em className="member-you">you</em>}
                  </strong>
                  <span>{member.email || 'No email on file'}</span>
                </div>
                {isOwner && !isSelf ? (
                  <select
                    className="role-select"
                    value={member.role}
                    onChange={event =>
                      void changeRole(
                        member.userId,
                        event.target.value as Role
                      )
                    }
                    disabled={busy === member.userId}
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Can edit</option>
                    <option value="viewer">Can view</option>
                  </select>
                ) : (
                  <span className={'role-badge role-' + member.role}>
                    {ROLE_LABEL[member.role]}
                  </span>
                )}
                {(isOwner || isSelf) && (
                  <button
                    className="icon-button member-remove"
                    onClick={() => void remove(member.userId)}
                    disabled={busy === member.userId}
                    title={isSelf ? 'Leave vault' : 'Remove member'}
                    aria-label={isSelf ? 'Leave vault' : 'Remove member'}
                  >
                    {busy === member.userId ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <UserMinus size={15} />
                    )}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="role-legend">
          <strong>Can edit:</strong> {ROLE_HELP.editor}{' '}
          <strong>Can view:</strong> {ROLE_HELP.viewer}
        </p>
      </section>

      {isOwner && invites.length > 0 && (
        <section className="member-list-card">
          <div className="member-list-head">
            <strong>Pending invites</strong>
            <span className="pending-hint">
              Links can be used once, and expire after 7 days
            </span>
          </div>
          <ul className="member-list">
            {invites.map(invite => (
              <li key={invite.code} className="member-row invite-row">
                <div className="member-avatar invite-avatar">
                  <UserPlus size={15} />
                </div>
                <div className="member-copy">
                  <strong>
                    {invite.invitedEmail || 'Anyone with the link'}
                  </strong>
                  <span>
                    {ROLE_LABEL[invite.role as Role] || invite.role} · expires{' '}
                    {formatWhen(invite.expiresAt)}
                  </span>
                </div>
                <button
                  className="ghost-button danger-ghost"
                  onClick={() => void revoke(invite.code)}
                  disabled={busy === invite.code}
                >
                  {busy === invite.code ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export { MessageCircle, X };
