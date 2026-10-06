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
  - the product itself: `backend-node/` (the engine wrapper described below, accounts, the
    job queue and worker, the GPU lifecycle, payments, privacy, admin), `frontend/`
    (website and dashboard) and `deploy/`;
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

## The engine wrapper

The backend never calls the AI models directly. Every call goes through one typed
interface, `Engine`, in [backend-node/src/engine.ts](backend-node/src/engine.ts), which has
two implementations:

| Implementation | What it is |
|---|---|
| `VoiceStudioEngine` | the real client: HTTP and server-sent events to the engine on the GPU server |
| `FakeEngine` ([src/fakeEngine.ts](backend-node/src/fakeEngine.ts)) | the same interface with no GPU and no cost, for local runs and tests |

`getEngine()` picks one from `VS_ENGINE_MODE` (`fake`, the default, or `real`).
`VS_ENGINE_URL`, `VS_CONNECT_TIMEOUT_S` and `VS_STREAM_READ_TIMEOUT_S` configure the real
client. The job worker, [backend-node/src/worker.ts](backend-node/src/worker.ts), is its
only caller.

### The interface

| Method | What it does | Returns, or raises |
|---|---|---|
| `waitReady(timeoutS, pollS, onWait)` | polls the engine until it answers, e.g. while the GPU server boots | the engine's info, or `EngineUnavailable` |
| `upload(videoPath, jobId)` | streams the video to the engine | the engine's reply |
| `waitPrep(jobId, timeoutS, pollS, onWait)` | waits for the voice to be separated from the background | the job record, with `vocals_path` |
| `transcribeStream(jobId, numSpeakers, onProgress)` | transcription, speaker detection and voice cloning, over server-sent events | `[segments, warnings]` |
| `storedSegments(jobId)` | the engine's own copy of the lines, with the ids it renders by | segments |
| `detectedSourceLang(jobId)` | the language the engine heard | a code such as `hi`, or `null` |
| `translate(body)` | translates every line to fit its time slot | `[lines, rawReply]`; `EngineError` on a refusal or a reply in an unknown shape |
| `generate(jobId, body)` | starts voice cloning and rendering | a task id; `EngineError` if none comes back |
| `taskStream(taskId, afterSeq)` | render progress over server-sent events; `afterSeq` resumes from a sequence number | an async iterator of events |
| `hasTrack(jobId, lang)`, `tracks(jobId)` | the real completion signal | whether that language's track exists |
| `download(jobId, query, dest)` | the finished MP4, written to a `.part` file and renamed when complete | bytes written |
| `deleteHistory(jobId)` | clears the job's media off the shared GPU server | nothing; never throws |

Errors are typed (`EngineError`, `EngineUnavailable`, and the transport errors
`ConnectError`, `ConnectTimeout`, `ReadTimeout` and `RemoteProtocolError`), so a failed
job records exactly why it failed.

### What it adds beyond calling a model API

- **Streaming.** Transcription and rendering report progress as server-sent events. The
  client decodes them incrementally (a line split across two network reads is still one
  line), skips anything that is not valid JSON, and keeps the richest segment list it has
  seen. Timeouts are per read, not per request, because a healthy stream can go quiet for
  minutes while voices are cloned; a stream that stalls keeps what already arrived.
- **Checking what the models return, before money is spent on it.** The worker refuses to
  render when a translation covers fewer lines than the transcript (filling the gaps with
  the source text would make a dub in the wrong language), when no line has a cloned voice
  (every line would come out in a stock voice), when line ids do not match the engine's
  own (each line would lose its speaker's voice), or when the render settings' SHA-256
  differs from the approved preset. A render counts as finished only when the engine
  reports that language's track, not when the progress stream says so.
- **Validated inputs and structured outputs.** Every API route declares its body, query and
  path parameters. A bad request gets a 422 listing every problem, and the same
  declarations generate the OpenAPI document (`/openapi.json` and `/docs`, in
  development). Language codes are checked before they reach a file name or ffmpeg, an
  upload's size is read from storage instead of trusted from the browser, and each job
  reports its state, progress and events as JSON.
- **Reliability.** Requests that start work are never retried automatically, so a slow
  reply cannot start a second render. The GPU server is started on demand, and the engine
  must answer before a job begins. A job left behind by a crash is requeued at most twice,
  then failed. Every failure refunds the customer's minutes through an append-only ledger,
  so a refund cannot be paid twice. The raw model replies are stored with each job, and a
  finished dub that cannot be copied to storage is still served from the server's disk.
- **Provider configuration.** The engine (real or fake) and file storage (AWS S3,
  Cloudflare R2 or local disk, chosen by which keys the credentials file holds) are
  settings, not code.

### Usage example

[backend-node/examples/dub.js](backend-node/examples/dub.js) runs one whole dub through the
interface, in the order the worker uses. With no settings it uses `FakeEngine`:

```bash
cd backend-node
npm ci && npm run build
node examples/dub.js talk.mp4 te
```

```text
engine: fake://in-process   job: 0089cdf1
  separating speech from background (fake)
  transcribe: fake transcribing line 1/14
  ...
  warning: fake engine: transcript is placeholder text
transcribed 14 lines (stored: 14)
translated 14 lines, e.g. "[te] [fake source line 1]"
  rendering 100%
wrote …/talk.te.mp4 (7693708 bytes)
```

The core of it:

```js
const { getEngine, newJobId } = require('./dist/engine');

const engine = getEngine();                        // VS_ENGINE_MODE=fake | real
const id = newJobId();
await engine.waitReady();
await engine.upload('talk.mp4', id);
await engine.waitPrep(id);
await engine.transcribeStream(id, null, (ev) => console.log(ev.detail));
const lines = await engine.storedSegments(id);     // the ids the engine renders by
const [translated] = await engine.translate({ segments: lines, source_lang: 'hi', target_lang: 'te' });
const task = await engine.generate(id, { segments: translated, language_code: 'te' });
for await (const ev of engine.taskStream(task)) if (ev.type === 'done') break;
if (await engine.hasTrack(id, 'te')) await engine.download(id, { default_track: 'te' }, 'talk.te.mp4');
```

In production the worker also sends the approved render settings from
[src/preset.ts](backend-node/src/preset.ts) with `translate` and `generate`.

### Tests

`npm test` in `backend-node/` builds the TypeScript in strict mode, runs the disclosure
checks, then runs [backend-node/test/](backend-node/test/) with Node's built-in test runner:

- the real client against a stand-in engine that misbehaves the way the real one can: a
  stream that goes silent, junk lines inside a stream, an HTTP error, a refused
  translation, a reply in an unknown shape, a render that returns no task id, and an
  engine that is not running at all;
- one whole dub through `FakeEngine`;
- provider configuration for the engine and for storage, including presigned upload URLs
  compared byte for byte with an independent implementation of AWS's SigV4 signing;
- an opt-in integration test against a real S3 bucket (`KRESKER_S3_TEST_ENV`).

Today 19 tests pass and the opt-in one is skipped; pointed at the live bucket, it passes
too.

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

AWS S3 (Mumbai): browser uploads and finished videos, through short-lived signed links ·
CloudFront: the homepage demo reel · Dodo Payments: subscriptions, annual plans and minute
top-ups (signed webhooks) · Resend: transactional email
```

## What is where

| Folder | What it is |
|---|---|
| `backend-node/` | The production backend. Node.js 24, Express, TypeScript (strict), better-sqlite3. The engine wrapper, routers for auth, jobs, billing, privacy, admin and downloads, the worker, GPU lifecycle, payments and mail. Tests in `test/`, a usage example in `examples/`. |
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
- **Files and backups.** Uploads and finished videos sit in a private, encrypted S3 bucket
  in Mumbai, reached only through short-lived signed links. The database is copied off the
  server every night to a separate versioned bucket, and the server's backup key can only
  add copies: it cannot list, read or delete them.
- **Deploys.** Each backend release is built and smoke-tested on the server beside the live
  service, then swapped in after a database backup, with an automatic revert if it does not
  pass its health check. Website releases need no restart at all.
- **Testing.** TypeScript strict mode, the engine and storage tests above (`npm test`),
  source-level checks on what the API discloses, and Playwright checks on a 390px phone
  screen in WebKit (iPhone Safari's engine) and Chromium.

## Run it locally

```bash
# backend - the dubbing engine is simulated, so no GPU, payment keys or email are needed
cd backend-node
npm ci && npm test        # builds, then runs the checks and tests
VS_ENGINE_MODE=fake VS_DATA_DIR=./data VS_COOKIE_INSECURE=1 node dist/main.js --port 8099

# website, in a second terminal (proxies /api to the backend on 8099)
cd frontend
npm ci && npm run dev
```

The first account you sign up with becomes the admin.

## Not in this repository

By design: credentials, keys and server addresses; customer data (databases, uploads, mail);
build output; the licensed brand font and the demo videos.
