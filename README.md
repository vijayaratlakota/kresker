# Kresker — AI video dubbing

**Live at [kresker.com](https://kresker.com).** Upload a video, pick up to eight languages, and
get it back dubbed — the same speaker's voice, speaking another language. The result is an MP4
whose default audio track is the dub, plus audio-only downloads (M4A, MP3, WAV).

It is for creators who want one video to reach viewers in other languages, Indian languages
above all, without hiring translators, voice artists and a studio for each one.

This repository is the product: the web backend, the website and dashboard, the code that
drives and extends the dubbing engine on the GPU machine, and the scripts that deploy it all.

## Who built what

I'm Vijay, Kresker's founder, and I designed and built this product. The dubbing engine
underneath it is open source and not mine:

- **The engine is [VoiceStudio](https://github.com/debpalash/VoiceStudio)** (AGPL-3.0), which
  runs in Docker on the GPU server. It provides vocal separation (Demucs), speaker diarization
  (pyannote), voice cloning (OmniVoice) and the basic dubbing flow.
- **What I built:**
  - the product itself: `backend-node/` (accounts, the job queue and worker, the GPU
    lifecycle, payments, privacy, admin), `frontend/` (website and dashboard) and `deploy/`;
  - new modules inside the engine, in `_box_src/`: `chirp_wire.py` rebuilds every line's
    timing from Google Chirp 2's word stream, checks it with MMS_FA forced alignment and
    splits lines at speaker changes; `head_language.py` finds and cuts source-language audio
    at the start of a dubbed line; `ref_quality.py` rejects bad voice-cloning reference clips;
    `services_voice_binding.py` keeps every line bound to its speaker's cloned voice;
    `dub_csv_import.py` imports a ready-made script;
  - my changes to VoiceStudio's own files, also in `_box_src/`;
  - `pipeline/`, my pipeline code, including Gemini translation with a character budget for
    every line (`voicestudio_dub.py`, `gemini_audio.py`);
  - the measurements behind the model choices: `docs/model_map.html` and `research/`.

`_box_src/` runs as part of VoiceStudio, so it is covered by VoiceStudio's licence, AGPL-3.0.

## Sample input and output

**Watch it.** The [kresker.com](https://kresker.com) homepage plays a real sample: an
87-second Hindi clip with its original audio, and the same picture dubbed into English,
Telugu, Tamil, Kannada and Spanish. You can switch language while it plays.

| | |
|---|---|
| **In** | A video (the site takes an MP4 of up to 30 minutes) and up to eight target languages. The site measures the video itself and shows the price before anything runs. |
| **Out** | An MP4 whose default audio track is the dub, and the dub alone as M4A, MP3 or WAV. |

**A real job:** a 12 min 40 s Hindi video with 6 speakers and 168 lines, dubbed into Telugu
([docs/pipeline_before_after.html](docs/pipeline_before_after.html)).

**Bring your own script.** The engine also takes a ready-made transcript and translation as a
CSV ([docs/INPUT_FORMAT.md](docs/INPUT_FORMAT.md)). Each row becomes one dubbed line in that
speaker's cloned voice:

```csv
speaker,start,end,source_text,target_text,notes
SPK1,3.184,6.027,"कहाँ है वो?","ఎక్కడ వాడు?",
SPK2,11.462,14.905,"ओए क्या कर रहा है?","ఒరేయ్ ఏం చేస్తున్నావ్?",offscreen
```

**Run it yourself.** [Run it locally](#run-it-locally) starts the whole product with a
stand-in engine and no GPU. Upload any video and you get it back with a silent audio track:
it shows the flow (upload, job stages, downloads), not dub quality.

## Results

Measured on real jobs. Each result names the file with the details.

- **Timing.** The transcriber's own timings put only 27.9% of lines where the words really
  are (46.2% were badly placed). Re-cutting the lines at Chirp 2's word boundaries raised that
  to 76.4% (11.1% badly placed). `_box_src/chirp_wire.py`
- **The right voice on each line.** Splitting lines at speaker changes raised the share of
  lines with only one speaker from 54.7% to 97.4%, so each line gets the right cloned voice.
  `_box_src/chirp_wire.py`
- **Translation.** gemini-3.1-pro-preview kept the meaning best of the three models tested:
  4.54/5, with 91.7% of lines rated 4 or 5, and picked as best on 56.9% of lines by a blind
  judge. `docs/model_map.html`
- **Fitting the time slot.** gemini-3.7-flash shortened over-long lines to fit their slot
  97.2% of the time, against 68.1% for 3.1-pro. Unchecked, shortening lost meaning on 68% of
  the lines it touched, so every shortened line goes through a loss check.
  `docs/model_map.html`
- **Voice-cloning references.** Bad reference clips had spoiled 92% of one job's lines;
  `ref_quality.py` now rejects them before cloning. `_box_src/ref_quality.py`
- **Languages.** WhisperX has no aligner for eight of the target languages (ta, kn, bn, mr,
  gu, pa, or, as); MMS_FA covers all of them with one model. `docs/model_map.html`

## Limitations, and where a person should check

- **No lip sync.** Only the audio changes; the picture is untouched.
- **Expression comes from the speaker's own audio.** The voice model takes no emotion input,
  so a flat reference clip gives a flat line.
- **Timing is good, not perfect.** On the measured job, 11% of lines were still badly placed,
  and splitting lines at speaker changes costs some timing accuracy: a correct voice was
  judged worth more.
- **Transcripts can differ between runs**, because the transcriber is an LLM.
- **A person should watch every dub before it is published**, checking names, numbers, brand
  terms and anything sensitive. Kresker does not fact-check, and a shortened line can still
  lose nuance. Only dub voices you have the right to use.

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
GPU server on EC2  (VoiceStudio in Docker, extended by _box_src/ and pipeline/: Python)
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
| `pipeline/` | My pipeline code and earlier experiments, including Gemini translation with a character budget per line. |
| `_box_src/` | Code that runs inside VoiceStudio on the GPU server: the modules I added, and VoiceStudio files I changed (AGPL-3.0). |
| `deploy/` | Staging, go-live, restart and rollback scripts, live health checks, a secret scanner. |
| `docs/`, `research/` | Architecture notes, runbooks, and the experiments behind pipeline decisions. |

## Engineering notes

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
build output; the licensed brand font and the demo videos.
