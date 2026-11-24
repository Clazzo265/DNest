# DataNest

DataNest is a private, account-scoped universal data vault for files, notes and structured JSON records.

**Capacity: 1 TiB (1099511627776 bytes) per account, enforced.** A single file may use the whole quota.

## What changed to make 1 TB real

The original snapshot capped files at 50 MiB and had no usage accounting at all. Reaching 1 TB required fixing four independent limits, not one:

| Limit | Before | Now |
| --- | --- | --- |
| Max file size | 50 MiB constant | 1 TiB (the full quota) |
| Aggregate usage | untracked, unenforceable | reserved + committed bytes per account |
| Upload bookkeeping | `uploadedChunks: number[]` on the record, rewritten per part (O(n²)) | interleaved bitmap shards in a separate table |
| Upload transport | 1 part per request, serial | bounded-concurrency workers with retry + resume |
| Download | whole file assembled in a `Uint8Array` | batched parts streamed straight to disk |
| Listing payload | grew with part count | constant size (`receivedParts` only) |

### Capacity model (`backend/limits.ts`)

- `QUOTA_BYTES = 1 TiB` — enforced per account, per upload.
- `MAX_FILE_SIZE = 1 TiB` — one file may consume the whole vault.
- `CHUNK_SIZE = 1 MiB` — retained deliberately: it is the size the existing
  transport already proved works against the platform request-body limit. A 1 TiB
  file is 1,048,576 parts.
- `MAX_RECORD_BYTES = 180 KiB` — notes/JSON stay small so they remain database items.
- `MAX_RECORD_COUNT = 100,000` — bounds table scans.
- Every one of these is served to the client by `GET /api/vault`, so the UI can
  never disagree with the server about limits.

### Quota accounting (`backend/quota.ts`)

One usage row per account in `vault_usage_<user>`:

- `usedBytes` — committed bytes (ready files + record content)
- `reservedBytes` — bytes promised to in-flight uploads
- `fileCount`, `recordCount`

Uploads **reserve before writing**, so ten concurrent 200 GB uploads cannot be
started on a 1 TiB account and fail later; the eleventh is refused up front with
the actual remaining space. Reservations are escalated to `usedBytes` on
`/complete`, released on delete, and reclaimed by the sweep endpoint. Mutations
use optimistic versioning and retry against fresh state.

### Upload index (`backend/parts.ts`)

Progress is a bitmap partitioned into 256 shard rows per 1 TiB file (4096 bits
each). Part → shard assignment is **interleaved** (`shard = index % 256`,
`bit = index / 256`) so six concurrent workers writing parts 0–5 touch six
different rows instead of serialising on one.

- Setting a part is a popcount of one 512-byte row, not a million-element array rewrite.
- Marking a part twice is a no-op, so retries are safe.
- Writes use lock-free OR-register convergence: each writer asserts its own bits
  and re-applies if a concurrent writer clobbered them, so no part is ever lost.
- Duplicate rows created by racing first-writes are merge-read, never trusted to
  shadow data.
- Resume state is derived server-side (`GET /api/files/:id/status?from=N`), so a
  client never has to remember what it sent.

### Transport (`src/transfer.ts`)

- Bounded concurrency (6 by default) with exponential backoff on 408/429/5xx and
  network faults; per-part retry.
- Resume continues an existing upload id instead of restarting it.
- Post-flight verification re-checks the server's part count before declaring
  success, and re-sends anything missing (up to three passes).
- Downloads use the File System Access API when available, writing part batches
  straight to disk — memory stays flat. Without it, the UI warns before a large
  download because the browser must buffer it.
- Batch read endpoint cuts download requests by 8x.

## Measured behaviour

`tests/scale.test.ts` uploads through the real client and real backend while
instrumenting the network layer:

```
upload:  64 MB in 1.1s (57.5 MB/s), peak in-flight 8.0 MB across 6 requests
upload: 256 MB in 4.4s (58.6 MB/s), peak in-flight 8.0 MB across 6 requests
```

The in-flight window is **constant** as the file grows — that is what makes the
1 TiB case survivable. Every part is sent exactly once, and spot-checked parts
are byte-identical to the source.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/vault` | Published limits + current usage |
| POST | `/api/vault/reconcile` | Recompute usage from stored parts |
| POST | `/api/vault/sweep` | Release abandoned uploads (7 days stale) |
| GET/POST | `/api/records` | List / create notes and JSON |
| PUT/DELETE | `/api/records/:id` | Update / delete (frees quota) |
| POST | `/api/files/start` | Reserve quota, create upload |
| GET | `/api/files/:id/status` | Resume state: `from`, `limit`, `missing[]` |
| POST | `/api/files/:id/chunks/:index` | Store one part |
| POST | `/api/files/:id/chunks` | Store up to 16 parts in one request |
| POST | `/api/files/:id/complete` | Verify completeness, commit quota |
| POST | `/api/files/:id/chunks/read` | Read up to 16 parts in one response |
| GET | `/api/files/:id/chunks/:index` | Read one part |

Route order matters: literal segments (`chunks`, `chunks/read`) are registered
before `:index`, or `read` would be parsed as a part number.

## Verification

```bash
npm install
npm run typecheck   # frontend + backend + server types
npm test            # 42 tests
DATANEST_SCALE_MB=256 npm test   # bigger scale run
```

| Suite | Covers |
| --- | --- |
| `tests/capacity.test.ts` | quota maths, part tiling, bitmap sharding |
| `tests/api.test.ts` | routing, quota enforcement, resume, isolation |
| `tests/transfer.test.ts` | concurrency, retry, resume, base64 exactness |
| `tests/download.test.ts` | streaming + fallback byte-identical output |
| `tests/scale.test.ts` | 64 MB upload, bounded in-flight window |
| `tests/server.test.ts` | sessions, security headers, request limits, restart durability |

The AppDeploy SDK is injected by the platform and is not published to npm, so
`.devtesting/` contains dependency-free stand-ins (plus a Node HTTP harness) used
only by the tests. `.devtesting/link.mjs` wires them into `node_modules` under the
real package names; it is idempotent and runs automatically in the test hooks.

Run the app locally with a working backend:

```bash
npm run harness     # backend on :8787, Vite on :5173 proxying /api
```

`DATANEST_DEV_HARNESS=1` swaps the client adapter for the local stub. The default
build is unchanged and still expects the platform-injected packages.

## Deployment

DataNest is a self-contained Node service: it serves the built frontend, the API,
and stores vault bytes on disk. One process, one volume.

### Local / any Docker host

```bash
docker build -t datanest .
docker run -d --name datanest -p 8080:8080 \
  -v datanest-data:/data \
  datanest
```

The `-v` is not optional: without it every deploy wipes the vault.

### Without Docker

```bash
npm ci
npm run build
DATANEST_DATA_DIR=/var/lib/datanest PORT=8080 npm start
```

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port (binds `0.0.0.0`) |
| `DATANEST_DATA_DIR` | `./data` | Root for tables + stored parts. **Back this up.** |
| `DATANEST_STATIC_DIR` | `./dist` | Built frontend |
| `DATANEST_ORIGIN` | — | Public origin; set to an `https://` URL to mark cookies `Secure` |
| `DATANEST_TRUST_PROXY` | — | Set `1` behind a TLS-terminating proxy so `X-Forwarded-Proto` is honoured |

### Platform blueprints in this repo

- `.github/workflows/ci.yml` — typecheck, build, 42 tests, server smoke test, Docker build + boot check.
- `.github/workflows/publish.yml` — pushes `ghcr.io/<owner>/datanest:latest` on green `main`.
- `Dockerfile` — multi-stage build, non-root user, `/data` volume, healthcheck.
- `fly.toml`, `render.yaml` — one-command deploys with the required persistent volume.

### Health

`GET /healthz` returns `{"ok":true,"uptime":...}` and is wired into the Docker
healthcheck and every platform blueprint.

### What "deployed" means here, precisely

This environment can only reach GitHub, so the image is built and published by CI
rather than started on a public host from this session. The service is verified
running locally with the full suite, including a restart test that kills the
process and proves accounts, notes and file bytes come back byte-identical.

## Operational notes

- **Deleting a file** removes its part objects in batched, concurrent
  `storage.delete` calls (~1M objects for a 1 TiB file) and frees the quota only
  after the index is cleared.
- **Reconciliation** rebuilds usage from the record table and reports part counts,
  so drift is repairable rather than permanent.
- **Sweeping** removes uploads abandoned for 7 days and releases their reservation,
  so a crashed browser cannot permanently consume quota.
- **Legacy files** uploaded with the old `uploadedChunks` array are converted into
  the bitmap on first read, delete, or completion.

## Honest limits

- 1 TiB per account is a **cost** decision, not only an engineering one. The
  storage ceiling of the AppDeploy platform itself is not verifiable from this
  repository: `@appdeploy/sdk` is not published (`npm view @appdeploy/sdk` → 404).
  Confirm the provider's per-object and total-byte quotas before advertising the
  figure to users.
- A 1 TiB file is ~1,048,576 requests. At 60 MB/s that is about 4.9 hours; the
  design tolerates interruption, but it does not make the transfer fast.
- Browsers without the File System Access API must buffer downloads in memory,
  which caps practical download size regardless of what the vault stores.
- No Google Drive, OneDrive, Dropbox or federated storage pool is implemented.
  Provider integrations must be built and verified separately before advertising
  pooled capacity.
