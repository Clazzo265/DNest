# Local verification harness (not part of the deployed app)

The AppDeploy packages (`@appdeploy/sdk`, `@appdeploy/client`) are injected by the
platform at deploy time and are **not published to npm** — `npm view @appdeploy/sdk`
returns 404. Without them this repository cannot be built or run, so this folder
contains dependency-free stand-ins that mirror the semantics DataNest relies on.

| File | Purpose |
| --- | --- |
| `sdk/index.ts` | `db`, `storage`, `router`, `json`, `error`, `requireAuth` stand-ins backed by JSON files. Table access is serialised and writes are atomic (temp + rename), because a real document store gives per-item atomicity that a plain JSON file does not. |
| `client.ts` | `api` / `auth` stand-in used by `src/`. Provides a demo identity since there is no identity provider locally. |
| `server.ts` | HTTP server that adapts Node requests to the backend `handler`. |
| `link.mjs` | Copies the stand-ins into `node_modules/@appdeploy/*` under the real package names. Idempotent; run automatically by the test hooks and `npm run harness`. |
| `node-dom.mjs`, `dom.mjs` | Minimal `FileReader` / jsdom globals so browser code can run under Node tests. |
| `serve.sh` | Backend on :8787 plus Vite on :5173 proxying `/api`. |

Nothing in this folder ships to production. The production build resolves the real
platform packages, and `src/appdeploy.d.ts` declares the shape the app expects from
them so `tsc` can check the client without the vendor SDK.
