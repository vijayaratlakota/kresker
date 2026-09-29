# kresker.com backend — Node.js + Express + TypeScript

The website backend: accounts, sign-in (password and Google), uploads, the dubbing job
queue, delivery links, payments (Dodo, Razorpay test mode), top-ups, the privacy (DPDP)
endpoints, maintenance mode, SEO files and the admin panel.

It is a line-for-line port of the Python/FastAPI backend in `../backend/app`, and it is
**byte-compatible** with it: same SQLite database and schema, same `vs_session` cookie,
same scrypt password hashes, same `secret.key`-signed download links, same mail outbox,
same JSON and error shapes, and the same requests to the dubbing engine. Either backend
can run against the same data, so switching is a restart, not a migration.

**The dubbing pipeline itself is not here and was not changed.** It still runs in Python
on the GPU box. This backend talks to it over HTTP, exactly as the Python one did.

## Requirements

- Node.js **24.10 or newer** (the admin database browser needs `node:sqlite`'s
  authorizer; on Node 22 everything else works and the browser answers 503).
- `ffprobe`/`ffmpeg`, the AWS CLI and `ssh` for real mode — the same tools as before.

## Run it

```powershell
npm ci
npm run build
$env:VS_ENGINE_MODE = "fake"      # stand-in engine, no GPU, no cost
node dist/main.js --host 127.0.0.1 --port 8099
```

It reads the same `VS_*` environment variables as the Python backend and, by default,
the same data directory (`../backend/data`).

## Layout

| Python (`backend/app`) | Node (`src`) | What it does |
|---|---|---|
| `main.py` | `main.ts` | Express app, middleware order, error pages, startup |
| `routers/*.py` | `routers/*.ts` | the REST API: auth, jobs, delivery, billing, privacy, admin, dbbrowse |
| `db.py`, `schema.sql` | `db.ts`, `sql/schema.sql` | SQLite (better-sqlite3), migrations, quota ledger |
| `security.py`, `tokens.py`, `passwords.py` | same names `.ts` | sessions, scrypt, signed download tokens |
| `billing.py` | `billing.ts` | checkout, webhooks, plan changes, disputes, renewals |
| `worker.py`, `engine.py`, `preset.py` | same names `.ts` | the job queue and the engine client |
| `gpu.py`, `watchdog.py` | `gpu.ts`, `watchdog.ts` | GPU box start/stop, and the standalone watchdog |
| `media.py`, `storage.py`, `notify.py` | same names `.ts` | ffmpeg checks, R2 storage, email |
| FastAPI / Starlette / pydantic | `http.ts`, `validate.ts`, `cookies.ts`, `emailstr.ts` | routing, 404/405/422 rules, validation, cookies |
| (Python itself) | `py.ts` | Python-exact JSON floats, rounding, timestamps, string rules |

`src/dbquery.ts` is the admin database browser's read-only query runner (see below).

## How it was verified

| Check | Command | Result |
|---|---|---|
| The 20 existing Python API suites, pointed at this server | `npm run verify` (`scripts/verify_all.ps1`) | 1,599 checks, same counts as Python, 0 failed |
| Byte parity with Python: hashes, sessions, tokens, preset, engine requests, emails, prices, pages, 368 validation cases | `backend\.venv\Scripts\python.exe scripts\parity\run_parity.py` | 171 / 171 |
| ffmpeg outputs (tagged MP4, m4a/mp3/wav) are identical bytes | `...\python.exe scripts\parity\media_check.py` | 26 / 26 |
| GPU stop decisions + the original watchdog suite against `dist/watchdog.js` | `...\python.exe scripts\parity\gpu_node_check.py` | 31 / 31 |
| Nothing a customer reads names the infrastructure | `npm test` (typecheck + `scripts/disclosure_node.js`) | 23 / 23 |

The engine check drives both clients through a whole job against a capture server and
compares every request (method, path, query, headers, body) — including the multipart
upload — byte for byte.

## Deploying (prepared, not yet run)

Nothing below has been run against the server. Payments are live there, so every step
that changes the live site needs an explicit `-Yes`.

1. `deploy\_ship_node.ps1` — installs Node 24 beside the system Node (checksum-verified),
   builds this package on the box, and smoke-tests it on port 8199 with a throwaway
   database. **Does not touch the live service, the live database or nginx.**
2. `deploy\_cutover_node.ps1 -Action GoLive -Yes` — backs up the live database, points
   `voicestudio.service` (and the GPU watchdog timer) at Node with one systemd drop-in
   file each, restarts, and **switches straight back to Python if Node does not answer
   within 30 seconds**. Refuses while a dub is running or queued.
3. `deploy\_cutover_node.ps1 -Action Rollback -Yes` — deletes the drop-ins; Python is back.
   `-Action Status` shows which one is serving; `-Action Restart -Yes` deploys a newer
   Node build.

Users stay signed in across the switch, and links already sent keep working.

## Deliberate differences from the Python backend

- **Database browser**: SQLite's authorizer (which blanks password hashes, tokens and
  email bodies however a query is written) is not exposed by better-sqlite3, so each
  query runs in a short-lived child process using Node's own `node:sqlite`. Two SQLite
  libraries must never open one database file in the same process — see `dbquery.ts`.
- **Golden preset guard**: before every render the worker checks the preset's SHA-256 is
  still `853a9e63…`, and refuses the job if not. Python had no such guard.
- **Engine requests** say `User-Agent: kresker-backend (node)` and `Connection: close`;
  everything else on the wire is identical.
- **Numbers**: a few API fields print a whole float as `28` rather than `28.0`. Same
  value; every client reads it the same. Anything hashed or sent to the engine keeps
  Python's exact form.
- **Signature compares** on malformed (non-ASCII) input return "no match" instead of
  Python's 500.
- On Windows, a Scheduled Task running `node.exe` opens a console window (there is no
  `nodew.exe`); the production watchdog runs from systemd on Linux, where this does not
  apply.

### Fixed in Node only (2026-09-27)

These were bugs in both backends. They are fixed here; the Python rollback still has
them, so switching back brings them back (and `backend/_test_new.py` now fails one check
on Python: the job-done email link).

- **Closing an account with a dub** works. Python answers 500 (`FOREIGN KEY constraint
  failed`: uploads were deleted before the jobs that point at them) and has already
  deleted the files. Node deletes jobs before uploads, deletes files only after the
  commit, and answers 409 while one of the account's dubs is being made.
- **Source videos are deleted on a timer**, on the same clock as the dubs made from them
  (`worker.sweepSourceUploads`). The row stays with `uploads.status='deleted'` - a value,
  not a new column, so the schema is still identical to Python's. `POST /api/jobs` on such
  an upload answers 410. The privacy notice states the rule from the same constants.
  `VS_SOURCE_SWEEP_SINCE=<UTC timestamp>` leaves uploads created before it alone; it was
  set on the server when this went live, so the existing backlog is deleted only when the
  operator removes it.
- **Emailed links** go to real pages: job done `/app/jobs/<id>` (was `/?job=`), job failed
  and the Google welcome `/app` (was `/app/dubbing`, a 404), renewal `/app/billing` (was
  `/billing`, a 404).
- **Admin force stop** answers 409 when this server does not run the GPU (demo engine or
  `VS_GPU_AUTO=0`) instead of calling `aws ec2 stop-instances` anyway, and 502 when AWS
  refuses the stop instead of 200.
- **`/db` "Run SELECT"** sends the CSRF token (`static/db.html` is this backend's own copy).
