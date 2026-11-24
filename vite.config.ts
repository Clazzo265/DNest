import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The AppDeploy SDK packages are not published and are injected by the platform
 * at deploy time. `DATANEST_DEV_HARNESS=1` swaps in the local stubs in
 * `.devtesting/` so the app can be run and exercised outside AppDeploy. The
 * default (platform) build is untouched.
 */
const harness = process.env.DATANEST_DEV_HARNESS === '1';

/**
 * Production: `npm run build` resolves the platform packages to this
 * repository's own implementations, which run on the bundled Node server
 * (`server/`). Nothing here depends on AppDeploy being reachable.
 */
const selfHosted = !harness;

export default defineConfig({
  plugins: [react()],
  /**
   * Relative asset URLs keep the build working when the app is deployed under a
   * path or served through a proxy that rewrites the host. The server resolves
   * these against the build root at any route depth (see serveStatic), so the
   * invite page works at /join/<ws>/<token>.
   *
   * Override only if the app must be pinned to an absolute prefix.
   */
  base: process.env.DATANEST_BASE || './',
  resolve: harness
    ? {
        alias: {
          '@appdeploy/client': '/.devtesting/client.ts',
          '@appdeploy/sdk': '/.devtesting/sdk/index.ts',
        },
      }
    : selfHosted
      ? {
          alias: {
            '@appdeploy/client': '/src/platform/client.ts',
            '@appdeploy/sdk': '/server/sdk.ts',
          },
        }
      : undefined,
  server: harness
    ? {
        host: '0.0.0.0',
        allowedHosts: true,
        proxy: {
          '/api': {
            target: process.env.DATANEST_API || 'http://127.0.0.1:8787',
            changeOrigin: false,
          },
        },
      }
    : undefined,
  build: {
    outDir: process.env.APPDEPLOY_VITE_OUT_DIR || 'dist',
    sourcemap:
      process.env.APPDEPLOY_VITE_SOURCEMAP === 'hidden' ? 'hidden' : false,
    target: ['chrome87', 'edge88', 'firefox78', 'safari14'],
  },
});
