import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { BootFailure, ErrorBoundary, useBootGuard } from './Boot';
import { JoinPage } from './Join';
import './index.css';

/**
 * Two entry points share one bundle:
 *   /join/<workspaceId>/<token>  the invite landing page (public)
 *   everything else              the vault
 *
 * A path check keeps this dependency-free; adding a router for one extra route
 * would be more machinery than the split deserves.
 */
const isJoinRoute = /^\/join\/[^/]+/.test(window.location.pathname);

function Root() {
  // Surfaces the silent-failure case: a script that never loaded leaves an empty
  // root and, without this, a blank page with no explanation.
  const problem = useBootGuard();
  if (problem) return <BootFailure title="The app did not load" detail={problem} />;
  return isJoinRoute ? <JoinPage onJoined={() => {}} /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>
);
