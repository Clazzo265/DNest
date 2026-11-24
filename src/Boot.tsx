/**
 * Failure surface for the app shell.
 *
 * The invite page once showed a blank white screen because a script 404'd or
 * arrived with the wrong content type. Nothing was logged that a person could
 * see, and the natural conclusion was "the service is broken". A missing script
 * cannot be caught from inside React, so the shell also watches for it and says
 * so plainly instead of rendering nothing.
 */

import { Component, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Database, RefreshCw } from 'lucide-react';

type BoundaryState = { error: Error | null };

export class ErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <BootFailure
          title="This page hit an error"
          detail={this.state.error.message}
        />
      );
    }
    return this.props.children;
  }
}

export function BootFailure({
  title,
  detail,
}: {
  title: string;
  detail?: string | null;
}) {
  return (
    <main className="auth-screen">
      <div className="auth-backdrop orb-one" />
      <section className="auth-card join-card">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Database size={25} />
          </div>
          <span>DataNest</span>
        </div>
        <div className="join-symbol join-symbol-bad">
          <AlertTriangle size={22} />
        </div>
        <h1>{title}</h1>
        <p>
          {detail ||
            'Something went wrong loading the app. Reloading usually fixes it.'}
        </p>
        <button
          className="primary-button auth-button"
          onClick={() => window.location.reload()}
        >
          <RefreshCw size={16} /> Reload
        </button>
        <p className="boot-hint">
          If this keeps happening, the server may be serving an incomplete build.
          Rebuild with <code>npm run build</code> and check that{' '}
          <code>dist/assets</code> is present.
        </p>
      </section>
    </main>
  );
}

/**
 * Detects the specific failure that produces a silent blank page: a script or
 * stylesheet that did not load. Rendering the shell's own error is the only way
 * to surface it, since the application code never runs.
 */
export function useBootGuard(timeoutMs = 8000): string | null {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const broken = Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[src]')
    ).filter(
      script =>
        // Every module script in the shell must have completed. `readyState` is
        // unreliable across browsers, so use the marker the loader sets.
        script.dataset.loaded !== 'true' &&
        !(script as HTMLScriptElement & { __done?: boolean }).__done
    );

    function onError(event: Event) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
        setProblem('A required part of the app failed to load.');
      }
    }

    document.addEventListener('error', onError, true);
    const timer = window.setTimeout(() => {
      const root = document.getElementById('root');
      if (root && root.childElementCount === 0) {
        setProblem(
          broken.length
            ? 'The app script did not load.'
            : 'The app did not start.'
        );
      }
    }, timeoutMs);

    return () => {
      document.removeEventListener('error', onError, true);
      window.clearTimeout(timer);
    };
  }, [timeoutMs]);

  return problem;
}
