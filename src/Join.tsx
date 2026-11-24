/**
 * Invite landing page (`/join/<workspaceId>/<token>`).
 *
 * This is what a WhatsApp recipient opens, often on a phone, often without an
 * account. So it must:
 *  - work before sign-in, showing only the vault name and the offered role;
 *  - offer sign-up and sign-in inline, because bouncing to a separate page loses
 *    people mid-flow;
 *  - return to the same invite after authenticating;
 *  - say plainly when a link is expired or already used.
 */

import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Database,
  LoaderCircle,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { auth, workspaces, type AppUser } from '@appdeploy/client';
import { errorMessage } from './transfer';

type Preview = {
  workspaceName: string;
  role: 'owner' | 'editor' | 'viewer';
  invitedEmail: string | null;
  expiresAt: number;
};

const ROLE_TEXT = {
  owner: 'You will be an owner of this vault.',
  editor: 'You will be able to add, edit and download everything.',
  viewer: 'You will be able to browse and download everything.',
} as const;

/**
 * Self-hosted builds put the token in the path (`/join/<ws>/<token>`); older
 * single-segment links (`/join/<token>`) are resolved by searching the user's
 * reachable workspaces is not possible before auth, so they are rejected with a
 * clear message rather than a blank screen.
 */
function readInvite(): { workspaceId: string; token: string } | null {
  if (typeof window === 'undefined') return null;
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'join') return null;
  if (parts.length === 3) {
    return { workspaceId: decodeURIComponent(parts[1]), token: decodeURIComponent(parts[2]) };
  }
  return null;
}

export function JoinPage({ onJoined }: { onJoined: (user: AppUser) => void }) {
  const invite = readInvite();

  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [user, setUser] = useState<AppUser | null>(null);
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [joined, setJoined] = useState<{ workspaceName: string; role: string } | null>(
    null
  );

  useEffect(() => {
    let active = true;

    async function load() {
      if (!invite) {
        setError('This invite link is incomplete. Ask for a fresh one.');
        setLoading(false);
        return;
      }
      try {
        const [details, session] = await Promise.all([
          workspaces.invitePreview(invite.workspaceId, invite.token),
          auth.getUser(),
        ]);
        if (!active) return;
        setPreview(details);
        setUser(session as AppUser | null);
        if (details.invitedEmail) {
          setForm(current => ({ ...current, email: details.invitedEmail! }));
        }
      } catch (caught) {
        if (!active) return;
        setError(errorMessage(caught));
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [invite?.workspaceId, invite?.token]);

  async function accept(): Promise<void> {
    if (!invite) return;
    setJoining(true);
    try {
      const result = await workspaces.acceptInvite(
        invite.workspaceId,
        invite.token
      );
      setJoined({ workspaceName: result.workspaceName, role: result.role });
      window.setTimeout(() => {
        // Land in the vault they just joined.
        window.location.href = '/?joined=1';
      }, 1200);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setJoining(false);
    }
  }

  async function authenticate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const signedIn =
        mode === 'signup'
          ? await auth.signUp!({
              email: form.email.trim(),
              password: form.password,
              name: form.name.trim(),
            })
          : await auth.signIn!({
              email: form.email.trim(),
              password: form.password,
            });
      setUser(signedIn);
      onJoined(signedIn);
      // Accept immediately after authenticating: no second click to forget.
      await accept();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="auth-screen">
        <div className="auth-card loading-card">
          <div className="brand-mark">
            <Database size={25} />
          </div>
          <LoaderCircle className="spin" size={24} />
          <p>Checking your invite…</p>
        </div>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="auth-screen">
        <div className="auth-backdrop orb-one" />
        <div className="auth-backdrop orb-two" />
        <section className="auth-card join-card">
          <div className="brand-lockup">
            <div className="brand-mark">
              <Database size={25} />
            </div>
            <span>DataNest</span>
          </div>
          <div className="join-heading">
            <div className="join-symbol join-symbol-bad">
              <X size={22} />
            </div>
            <h1>This link is not usable</h1>
            <p>{error || 'The invite may have expired or already been used.'}</p>
          </div>
          <a className="primary-button auth-button" href="/">
            Go to DataNest <ArrowRight size={16} />
          </a>
        </section>
      </main>
    );
  }

  if (joined) {
    return (
      <main className="auth-screen">
        <section className="auth-card join-card">
          <div className="join-symbol join-symbol-good">
            <Check size={24} />
          </div>
          <h1>You're in</h1>
          <p>
            You joined <strong>{joined.workspaceName}</strong> as{' '}
            {joined.role === 'viewer' ? 'a viewer' : 'an editor'}. Opening your
            vault…
          </p>
          <div className="join-progress">
            <LoaderCircle size={16} className="spin" /> Just a moment
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <div className="auth-backdrop orb-one" />
      <div className="auth-backdrop orb-two" />
      <section className="auth-card join-card">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Database size={25} />
          </div>
          <span>DataNest</span>
        </div>

        <div className="join-heading">
          <div className="join-symbol">
            <Users size={22} />
          </div>
          <span className="eyebrow">YOU'VE BEEN INVITED</span>
          <h1>{preview.workspaceName}</h1>
          <p>{ROLE_TEXT[preview.role]}</p>
        </div>

        {user ? (
          <button
            className="primary-button auth-button"
            onClick={() => void accept()}
            disabled={joining}
          >
            {joining ? (
              <>
                <LoaderCircle size={17} className="spin" /> Joining…
              </>
            ) : (
              <>
                Join this vault <ArrowRight size={17} />
              </>
            )}
          </button>
        ) : (
          <form className="auth-form" onSubmit={authenticate}>
            <div className="join-tabs">
              <button
                type="button"
                className={mode === 'signup' ? 'join-tab active' : 'join-tab'}
                onClick={() => setMode('signup')}
              >
                Create account
              </button>
              <button
                type="button"
                className={mode === 'signin' ? 'join-tab active' : 'join-tab'}
                onClick={() => setMode('signin')}
              >
                I have one
              </button>
            </div>

            {mode === 'signup' && (
              <label className="auth-field">
                <span>Name</span>
                <input
                  value={form.name}
                  onChange={event =>
                    setForm(current => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Your name"
                  autoComplete="name"
                  maxLength={80}
                />
              </label>
            )}
            <label className="auth-field">
              <span>Email</span>
              <input
                type="email"
                required
                value={form.email}
                onChange={event =>
                  setForm(current => ({ ...current, email: event.target.value }))
                }
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>
            <label className="auth-field">
              <span>
                Password
                {mode === 'signup' && (
                  <em className="auth-hint">at least 10 characters</em>
                )}
              </span>
              <input
                type="password"
                required
                minLength={mode === 'signup' ? 10 : undefined}
                value={form.password}
                onChange={event =>
                  setForm(current => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
                placeholder="••••••••••"
                autoComplete={
                  mode === 'signup' ? 'new-password' : 'current-password'
                }
              />
            </label>
            <button className="primary-button auth-button" type="submit" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={17} className="spin" /> Working…
                </>
              ) : (
                <>
                  {mode === 'signup' ? 'Create account and join' : 'Sign in and join'}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
        )}

        {error && <p className="inline-error">{error}</p>}
        <div className="auth-foot">
          <span>
            <ShieldCheck size={14} /> Invite expires{' '}
            {new Intl.DateTimeFormat(undefined, {
              month: 'short',
              day: 'numeric',
            }).format(new Date(preview.expiresAt))}
          </span>
          <span>Single use</span>
        </div>
      </section>
    </main>
  );
}
