import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The AppDeploy SDK packages are not published and are injected by the platform
 * at deploy time. `DATANEST_DEV_HARNESS=1` swaps in the local stubs in
 * `.devtesting/` so the app can be run and exercised outside AppDeploy. The
 * default (platform) build is untouched.
 */
const harness = process.env.DATANEST_DEV_HARNESS === '1';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: harness
    ? {
        alias: {
          '@appdeploy/client': '/.devtesting/client.ts',
          '@appdeploy/sdk': '/.devtesting/sdk/index.ts',
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
