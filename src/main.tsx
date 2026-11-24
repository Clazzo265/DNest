import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isJoinRoute ? <JoinPage onJoined={() => {}} /> : <App />}
  </StrictMode>
);
