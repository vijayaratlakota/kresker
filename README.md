# Kresker — AI video dubbing

**Live at [kresker.com](https://kresker.com).** Upload a video, pick up to eight languages, and
get it back dubbed — the same speaker's voice, speaking another language. The result is an MP4
whose default audio track is the dub, plus audio-only downloads (M4A, MP3, WAV).

This repository is the product: the web backend, the website and dashboard, the dubbing
pipeline that runs on the GPU machine, and the scripts that deploy it all.

## How it fits together

```
Browser ── React app (public pages prerendered for SEO)
   │  HTTPS through Cloudflare
   ▼
nginx on an Ubuntu EC2 server ── serves the built website
   │  /api, /dl, /db
   ▼
Node.js backend  (backend-node/: Express + TypeScript, SQLite, run by systemd)
   ├─ accounts, sessions, billing, privacy, admin
   ├─ job queue + worker: runs each dub, records every stage
   ├─ GPU lifecycle: starts the GPU server when a dub is requested, stops it when idle
   └─ scheduled sweeps: retention, renewal reminders, session cleanup
   │
   ▼
GPU server on EC2  (pipeline/, _box_src/: Python)
   speech/background separation → transcription → translation fitted to each line's
   time slot → voice cloning → rendering the new audio track

Cloudflare R2: direct browser uploads and video delivery · Dodo Payments: subscriptions,
annual plans and minute top-ups (signed webhooks) · Resend: transactional email
```

## What is where

| Folder | What it is |
|---|---|
| `backend-node/` | The production backend. Node.js 24, Express, TypeScript (strict), better-sqlite3. Routers for auth, jobs, billing, privacy, admin, downloads; the worker, GPU lifecycle, payments, mail. |
| `frontend/` | React 18 + Vite 6 + Tailwind CSS 4. Dashboard, admin panel, pricing and legal pages. `scripts/prerender.mjs` renders the public pages to static HTML. |
| `pipeline/`, `_box_src/` | The dubbing engine on the GPU server. |
| `deploy/` | Staging, go-live, restart and rollback scripts, live health checks, a secret scanner. |
| `docs/`, `research/` | Architecture notes, runbooks, and the experiments behind pipeline decisions. |

## Engineering notes

- **Backend rewritten from Python (FastAPI) to Node.js + TypeScript without changing its
  behaviour.** The Node version was held to the original's black-box HTTP test suite (20 suites,
  1,591 checks), and then both ran side by side on copies of the production database: 227
  requests, every one identical apart from documented, deliberate differences.
- **Security.** Session tokens stored only as hashes, CSRF header on every change, the admin
  password asked again for anything that moves money or locks an account, rate limits, a strict
  Content-Security-Policy, and an audit log of every admin look at someone's personal data. The
  admin SQL browser runs in a read-only child process behind SQLite's authorizer.
- **Payments.** Monthly mandates, one-off annual plans and top-up packs; webhooks verified and
  idempotent; minutes tracked in an append-only ledger, so refunds are new rows, never edits.
- **Privacy (India's DPDP Act).** Consent records, one-click data export, account erasure that
  keeps anonymised financial records, and automatic deletion of dubbed videos and of the
  uploaded originals on a published schedule.
- **GPU cost control.** The GPU server is started only when a customer asks for a dub and
  stopped after ten idle minutes, with a systemd watchdog as a second guard.
- **Deploys.** Each backend release is built and smoke-tested on the server beside the live
  service, then swapped in after a database backup, with an automatic revert if it does not
  pass its health check. Website releases need no restart at all.
- **Testing.** TypeScript strict mode, source-level checks on what the API discloses, and
  Playwright checks on a 390px phone screen in WebKit (iPhone Safari's engine) and Chromium.

## Run it locally

```bash
# backend - the dubbing engine is simulated, so no GPU, payment keys or email are needed
cd backend-node
npm ci && npm run build
VS_ENGINE_MODE=fake VS_DATA_DIR=./data VS_COOKIE_INSECURE=1 node dist/main.js --port 8099

# website, in a second terminal (proxies /api to the backend on 8099)
cd frontend
npm ci && npm run dev
```

The first account you sign up with becomes the admin.

## Not in this repository

By design: credentials, keys and server addresses; customer data (databases, uploads, mail);
the legacy Python backend kept privately as a rollback; build output; the licensed brand font
and the demo videos.
