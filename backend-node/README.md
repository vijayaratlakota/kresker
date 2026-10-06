# kresker.com backend — Node.js + Express + TypeScript

The website backend: accounts and sign-in (password and Google), uploads, the dubbing job
queue and worker, delivery links, payments and top-ups, the privacy (DPDP) endpoints,
maintenance mode, SEO files and the admin panel.

The AI work happens on a separate GPU server running the dubbing engine. This backend
drives it through one typed wrapper, [`src/engine.ts`](src/engine.ts). Its interface, a
usage example and its tests are described in the
[repository README](../README.md#the-engine-wrapper).

## Requirements

- Node.js **24.10 or newer** (the admin database browser needs `node:sqlite`'s
  authorizer; on Node 22 everything else works and that browser answers 503).
- `ffprobe` and `ffmpeg`. Real mode also needs the AWS CLI, for GPU start/stop and file
  storage.

## Run it

```bash
npm ci
npm run build
VS_ENGINE_MODE=fake VS_DATA_DIR=./data VS_COOKIE_INSECURE=1 node dist/main.js --host 127.0.0.1 --port 8099
```

`VS_ENGINE_MODE=fake`, the default, uses the stand-in engine: no GPU and nothing billed.
In development the API describes itself at `/docs` (Swagger UI), `/redoc` and
`/openapi.json`; `VS_PRODUCTION=1` removes those routes.

## Test it

```bash
npm test
```

This builds the TypeScript (strict mode), runs `scripts/disclosure_node.js` (nothing a
customer reads names the infrastructure), then runs the tests in [`test/`](test/) with
Node's built-in test runner. One test uses a real S3 bucket and is skipped unless it is
given a credentials file:

```bash
KRESKER_S3_TEST_ENV=/path/to/storage.env npm test
```

## Usage example

```bash
node examples/dub.js my-video.mp4 te
```

[`examples/dub.js`](examples/dub.js) runs one whole dub through the engine wrapper: the
fake engine by default, the real one with `VS_ENGINE_MODE=real` and `VS_ENGINE_URL`.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `VS_ENGINE_MODE` | `fake` | `fake` (no GPU) or `real` |
| `VS_ENGINE_URL` | `http://127.0.0.1:3900` | where the real engine answers |
| `VS_CONNECT_TIMEOUT_S` | `30` | connect timeout for engine calls |
| `VS_STREAM_READ_TIMEOUT_S` | `900` | the longest silence allowed on an engine stream, per read |
| `VS_DATA_DIR` | `../backend/data` | uploads, outputs and the SQLite database; set it explicitly |
| `VS_R2_ENABLED`, `VS_R2_ENV` | `0`, `~/.secrets/r2.env` | switches file storage on, and names its credentials file: `STORAGE_*` keys for AWS S3, `R2_*` keys for Cloudflare R2 (the variable names predate S3 support) |
| `VS_GPU_AUTO` | `1` | real mode: start the GPU server for a job and stop it when idle |
| `VS_PRODUCTION` | unset | `1` turns the interactive API docs off |
| `VS_COOKIE_INSECURE` | `0` | `1` allows the session cookie over plain http, for local runs |

## Layout

| File in `src/` | What it does |
|---|---|
| `main.ts` | the Express app, middleware order, security headers, error pages, start-up |
| `http.ts`, `validate.ts` | routing, and request validation from declared schemas: a 422 listing every problem, and the OpenAPI document |
| `routers/*.ts` | the REST API: auth, jobs, delivery, billing, privacy, admin, the database browser |
| `engine.ts`, `fakeEngine.ts` | the engine wrapper: the typed interface, the HTTP and server-sent-events client, and the GPU-free stand-in |
| `worker.ts`, `preset.ts` | the job queue: runs each dub through the wrapper, checks what comes back, refunds failures |
| `storage.ts` | S3 or R2 file storage: presigned browser uploads, signed downloads, sweeps |
| `gpu.ts`, `watchdog.ts` | GPU server start and stop, and the standalone watchdog |
| `db.ts`, `../sql/schema.sql` | SQLite (better-sqlite3), migrations, the append-only minutes ledger |
| `security.ts`, `tokens.ts`, `passwords.ts`, `cookies.ts` | sessions, scrypt password hashes, signed download tokens |
| `billing.ts` | checkout, webhooks, plan changes, disputes, renewals |
| `media.ts`, `notify.ts`, `emails.ts` | ffmpeg checks and audio downloads, email |
| `py.ts` | JSON, number and string formatting that matches what the Python engine sends and expects |
| `dbquery.ts` | the admin database browser's read-only query runner, in its own process |
