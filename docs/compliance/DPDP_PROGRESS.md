# DPDP Act 2023 — audit and remediation log

Branch `compliance/dpdp`, off `ab77fc6`. **Not pushed.**

This file is the decision log. It records what was found, what was built, what a
lawyer must review, and what is still open. Where I could not verify something from
code I say so rather than assuming.

**I am not a lawyer and this is not legal advice.** Every paragraph of customer-facing
legal text produced here is marked `LEGAL REVIEW` in the source and must be reviewed
by an Indian data-protection practitioner before the site serves real users.

---

## 1. Audit — what this codebase actually does with personal data

Evidence-based, from a full read of `backend/app/schema.sql`, the routers,
`worker.py`, `_box_src/speaker_clone.py` and the frontend. `file:line` given so each
finding is re-checkable.

### 1.1 Personal data stored

Fifteen tables; **twelve hold personal data**.

| Table | Personal data | Note |
|---|---|---|
| `users` | `email`, `password_hash`, `reset_token_sha256` | scrypt, salt embedded |
| `sessions` | `ip`, `user_agent`, `token_sha256`, `csrf` | one row per login, 7-day TTL, **never physically deleted** |
| `subscriptions` | Razorpay subscription/order ids | tied to a named person |
| `payments` | `provider_payment_id`, `method` (upi/card/netbanking) | no PAN or card number |
| `uploads` | `stored_path`, `original_name` | **the customer's video — every speaker's face and voice** |
| `jobs` | `output_path`, `output_r2_key`, `error_detail` | output is a synthetic recording of the speaker's voice |
| `job_segments` | `source_text`, `translated_text`, `speaker_label`, `profile_id` | verbatim of what a person said |
| `job_events` | `detail` | includes "speakers detected: SPEAKER_00, …" |
| `job_artifacts` | `payload` (≤400 KB/row) | **a second, unpruned copy of every transcript** |
| `usage_ledger` | `user_id`, `note` | append-only by design |
| `admin_audit` | `admin_user_id`, `ip`, `before_json`, `after_json` | append-only |
| `webhook_events` | `payload` verbatim | live Razorpay bodies carry payer email/contact/VPA |
| `webhook_rejects` | `ip`, `head` | first 200 bytes of a rejected body |
| `checkout_sessions` | `user_id`, provider ids | |
| `emails` | `to_email`, `body` (≤4000 chars) | **see FINDING-3** |

No personal data in `plans` or `gpu_state`.

### 1.2 Collection points

- `POST /api/auth/register` — email, password. **Side effect:** IP + User-Agent
  captured into `sessions` (`security.py:71-88`), never disclosed to the user.
- `POST /api/auth/login` — same, same side effect.
- `POST /api/auth/reset/request` / `reset/confirm` — email, token, new password.
- `POST /api/uploads` — **the video file**. `original_name` and `content_type` stored
  as sent (`routers/jobs.py:101-106`). No notice, no purpose statement, no retention
  statement at the point of collection.
- `POST /api/jobs` — upload id, target languages.
- `POST /api/billing/checkout` — plan code only; card/UPI go browser→Razorpay.
- `POST /api/billing/webhook` — Razorpay body, stored verbatim.

### 1.3 Third-party disclosures (all confirmed from code)

| Recipient | What reaches it | Evidence |
|---|---|---|
| AWS EC2 (ap-south-1) | **the entire video file**, transcripts, segment lists | `config.py:78-93`, `engine.py:116-125` |
| LLM translation via box-local proxy → Gemini | **every transcript line verbatim** + timings | `preset.py:215-222`, `worker.py:205-215` |
| OpenAI-compatible ASR proxy | audio, **including voice reference clips** | `_box_src/speaker_clone.py:519-523` |
| Razorpay | amount, currency, `notes:{plan_code, user_id}` | `billing.py:188-240` |
| AWS SES | recipient, subject, **full body on the command line** | `notify.py:76-88` |
| Cloudflare R2 | the finished dubbed video | `storage.py:74-133`, off by default |

Also in-repo but **not** reachable from the API: `pipeline/gcloud_stt.py`,
`gemini_audio.py`, `gcloud_dub.py`, `ai_script.py` reach Google Cloud directly.
Research drivers — noted so nobody wires them into the service without a DPA.

### 1.4 Trackers and cookies — genuinely clean

Searched `analytics|gtag|plausible|posthog|sentry|hotjar|clarity|pixel|cdn|unpkg|jsdelivr|googleapis|gstatic`
across `frontend/`: **zero matches.** Fonts are self-hosted
(`styles.css:29-34`). No `localStorage`, no `sessionStorage`, no `document.cookie`.

**Exactly one cookie: `vs_session`** — HttpOnly, SameSite=Lax, 7-day, and
`secure=COOKIE_SECURE` which **defaults to false** (`config.py:58-59`).

**Decision (D-1):** the cookie banner is built but ships in a state that reflects
reality — it declares one strictly-necessary cookie and no trackers. Building a
"manage your tracking preferences" dialogue for trackers that do not exist would be
consent theatre, and the DPDP Act does not require consent for a session cookie that
is essential to a service the user asked for. The banner exists so that the moment
anything non-essential is added, the gate is already in place and defaults to refused.

---

## 2. Findings — ranked, with severity

These are defects, not paperwork. Several block DPDP compliance outright.

### FINDING-1 — Original uploads are never deleted `[HIGH]`
Retention deletes **outputs only** (`worker.sweep_expired`, `worker.py:457-490`).
`uploads.stored_path` — the customer's source video — has no deletion path at all.
`routers/jobs.py:205-210` states it outright: *"the worker only ever reads
`uploads.stored_path` and never deletes it."* Confirmed on disk: 149 files, 270 MB in
`data/uploads`, oldest well past any retention window.

DPDP s.8(7) requires erasure once the purpose is served. The purpose of the source
video is served when the dub is delivered.

### FINDING-2 — Voice clips survive on the GPU box after a failed job `[HIGH]`
`engine.delete_history(vs_job)` is the **last statement inside the `try`**
(`worker.py:376`). The `except` at `:379-386` goes straight to `_fail()` and never
cleans up. So **every failed job leaves the source video and every per-speaker and
per-line voice clip on the shared GPU box indefinitely.** Two aggravating factors:
`engine.delete_history` swallows all exceptions (`engine.py:311-318`), and
`_box_src/dub_core.py:342-352` deliberately keeps the directory when another
`dub_history` row references it.

Voice is plausibly sensitive personal data. There is no age-based sweep on the box.

### FINDING-3 — Live password-reset URLs are persisted in the database `[HIGH]`
`emails.body` stores the message verbatim (≤4000 chars, `notify.py:66-71`), and for
`kind='password_reset'` that body contains the reset URL **with the raw token**
(`notify.py:151-158`). Under the default `file` backend it is also written to
`data/mail/*.txt`. That token is a credential equivalent, and it is readable by:
`GET /api/admin/mail`, and the DB browser, whose redaction list `_HIDE`
(`dbbrowse.py:150-155`) covers `password_hash`, `token_sha256`, `csrf` — **but not
`reset_token_sha256` and not `emails.body`.**

### FINDING-4 — No account deletion, no per-user export `[HIGH]`
DPDP ss.11-13 rights (access, correction, erasure) have **no implementation**.
`grep delete_account|close_account|account_closure` finds only a schema comment.
Worse, it is currently *impossible*: `payments.user_id` and `usage_ledger.user_id`
have **no `ON DELETE CASCADE`** (`schema.sql:80,188`), so with `foreign_keys=ON` a
user row cannot be deleted while any payment or ledger row exists.

`portability.export()` exists but is an **installation-migration archive** — every row
of all tables including `users.password_hash` — not a per-principal export.

### FINDING-5 — `X-Forwarded-For` trusted unconditionally `[MEDIUM]`
`deps.client_ip` (`deps.py:19-23`) reads the header with no trusted-proxy allowlist.
Every IP in `sessions`, `admin_audit` and `webhook_rejects` is caller-controllable,
and every IP-keyed rate-limit bucket is trivially bypassed. Both an integrity problem
for the audit trail and a security one.

### FINDING-6 — Admin reads are entirely unaudited `[MEDIUM]`
`db.audit()` is called for every admin **write**, and for no **read**.
`GET /api/admin/sessions` returns every user's email + IP + User-Agent;
`GET /api/admin/mail` returns every message ever sent; `POST /api/admin/db/query`
(`dbbrowse.py:134-152`) runs arbitrary SELECTs over `users`, `emails`,
`job_segments`. None leaves a trace.

### FINDING-7 — No captcha anywhere `[MEDIUM]`
The brief says "unverified captcha". The reality is stronger: there is **none**.
`grep captcha|turnstile|hcaptcha|recaptcha` matches only a vendored Pygments symbol.
There is no token, so there is nothing to verify. The only anti-automation control is
in-process rate limiting (`ratelimit.py:19-21`) which resets on restart, does not span
processes, and is bypassable via FINDING-5.

### FINDING-8 — No encryption at rest `[MEDIUM]`
The brief says "fail-open encryption". The reality: **there is no layer to fail**.
`grep Fernet|AES|encrypt|cryptography|at_rest` across `backend/app/` → nothing. The
SQLite file is plain, uploads and outputs are plain files, `storage.put` passes no
`--sse` (`storage.py:84-101`). `data/secret.key` is `chmod 0600` best-effort — **a
no-op on Windows, which is where this currently runs** (`config.py:150-163`).

### FINDING-9 — HTTPS assumed, never enforced `[HIGH in production]`
`COOKIE_SECURE` defaults off. No `HTTPSRedirectMiddleware`, no HSTS, no
`TrustedHostMiddleware`, no security headers, no CORS middleware — `main.py` adds only
routers, an error handler and a static mount. `PUBLIC_BASE_URL` defaults to
`http://…`. **In the default configuration the session cookie travels in clear text.**

### FINDING-10 — Two sources of truth for retention `[LOW]`
`plans.output_retention_days` exists per plan and **is never read**; the worker uses
the `config.py` constants off `is_free` (`worker.py:348-352`). The column is
decorative, which is exactly how a published retention period drifts from the enforced
one.

### FINDING-11 — Unauthenticated `/api/health` and `/db` page `[LOW]`
`/api/health` returns the engine URL, full engine `sysinfo`, storage config and job
counts with no auth (`main.py:74-100`). `GET /db` serves the browser page with no auth
check (only the API behind it is gated).

### FINDING-12 — The whole database was staged for commit `[HIGH]` — **closed**

Not found by reading the code. Found by looking at the Source Control panel, which
showed 577 files staged and a commit message ready to go.

Of those 577, **396 were runtime data**:

| Staged for commit | Count | What is in it |
| --- | --- | --- |
| SQLite databases + `-wal`/`-shm` sidecars | 169 | 75 user rows with password hashes, 66 sessions with IP and User-Agent, 60 sent emails, 84 jobs, 57 uploads, 278 transcript segments, 13 payments |
| `backend/data/mail/**` | 128 | The file-backend outbox as plain text, including **11 password-reset emails with a live token URL** |
| Portability export archives (`_port_tmp`, `_port_api_tmp`) | 80 | The same rows again as `.jsonl` — `users`, `emails`, `sessions` |
| `frontend/dist/**` | 14 | Stale build output, already two builds behind |
| `backend/data/secret.key` | 1 | **The live key that signs download tokens** |

Three of the staged `emails` rows carried a reset URL with the raw token, and one
`users` row had a non-null `reset_token_sha256` — which is FINDING-3 exactly, one
`git commit` away from being permanent. The `-wal` sidecars are worse than the `.db`
files in one respect: they hold rows not yet checkpointed into the main file, so they
are the same exposure with none of the visibility.

The accounts are `@example.com` test accounts, so real-world harm was small. That is
luck, not design: `live.db` is the real-mode database with the actual admin account,
and `secret.key` is the live signing key of the running backend. **Git history is
permanent** — deleting the file in a later commit does not remove the blob, so this
would have been a breach that could not be withdrawn without rewriting history.

**Fixed:** `.gitignore` extended by shape rather than by filename (the previous rules
named individual files, which is why a new throwaway database was never on the list):
`backend/data/`, `*.db` / `*.db-wal` / `*.db-shm` / `*.sqlite*`, `*.key`, the
portability scratch directories, `frontend/dist/`, `*.tsbuildinfo`, `*.bak*`, and
`backend/_box_ip.txt`. Then all 396 unstaged with `git restore --staged` — index only,
nothing removed from disk. Nothing was ever committed, so no history rewrite was needed.

**The second half of the same problem: the index was also missing source.** With the
data removed, `_index_coherence.py` (kept, at the repo root) found that the staged
`App.tsx` imported eight files that were not staged at all — the entire
`frontend/src/legal/` directory, `PrivacyCenter.tsx`, `AdminInbox.tsx`, both marketing
demo components, `LanguagePicker.tsx`, and the homepage demo video. 31 more staged
files held a blob older than the version on disk, and one (`poster.jpg`) had been
deleted from disk while still staged as an addition. A commit of that index would have
produced a tree that does not compile. Index and working tree now match exactly, and
every relative import of a staged file is also staged.

---

## 3. What already helped

Worth recording, because it made this tractable:

- `admin_audit` is already append-only with `reason` and `ip` — a usable spine.
- Retention is already modelled *and* automated for outputs.
- Only **hashes** of session and reset tokens are stored; reset is single-use, 30-min,
  and revokes every session on use.
- Delivery is least-privilege: private bucket, HMAC-signed single-object tokens, 300 s
  TTL, verified by a doorman that makes no access decision of its own.
- `notify.job_done` already states the deletion date as an absolute date and tells the
  customer they may delete it themselves — a real transparency artifact.
- Passwords: scrypt N=2^14, r=8, p=1, 16-byte salt, `compare_digest`, parameters read
  back from the stored string so cost can be raised later.
- Login/register return identical errors; reset always answers the same. No enumeration.

---

## 4. Decisions

**D-1 — The consent banner declares reality, not a template.** See §1.4. One
strictly-necessary cookie, no trackers. The gate is built and defaults to refused so
that adding a tracker later cannot ship without passing through it.

**D-2 — Consent checkboxes are per-purpose and unticked, and the two that are
*necessary for the service* are separated from the one that is not.** Processing the
video to produce a dub is what the user asked for; marketing email is not. Bundling
them into one "I agree" is precisely what DPDP s.6(1) prohibits.

**D-3 — Voice cloning gets its own consent line.** The product clones a speaker's
voice from the uploaded video, and the uploader is frequently not the only speaker in
it. The upload consent therefore asks the uploader to confirm they have the right to
submit other people's voices, and says plainly that clips are sent to a third-party
transcription service. This is the one place where a generic notice would be
misleading.

**D-4 — Consent records are immutable rows, not a boolean on `users`.** A boolean
cannot answer "what exactly did they agree to, and when". Each row stores purpose,
granted/withdrawn, notice version, timestamp, IP and User-Agent. Withdrawal is a new
row, never an update — same reasoning as the usage ledger.

**D-5 — Data-rights requests are logged with a statutory clock, not just emailed.**
An email can be missed; a row with a due date can be surfaced in the admin dashboard
and counted. Response window set to 30 days as a working default — **LEGAL REVIEW:
confirm against the Rules as notified.**

**D-6 — The grievance contact is a placeholder, and deliberately loud about it.**
`VS_GRIEVANCE_*` env vars with obviously-fake defaults, and the privacy page renders a
visible warning when they are unset. A privacy policy naming nobody is worse than no
policy, so it must be impossible to ship this by accident.

**D-6a — ...but loud in the right place. The footer warning moved.** The first build
put a red `role="alert"` block in the footer of *every* page, homepage included. The
reasoning behind D-6 holds; the placement did not.

The warning exists so the **operator** cannot ship without noticing. A visitor cannot
appoint a grievance officer, and a red alarm on the landing page reads as a broken
product rather than an unfinished configuration. The operator is already told in three
places that can be acted on: `GET /api/admin/dpdp` reports it as a failing check with
the fix named, `/app/admin/inbox` renders that checklist above the messages, and it is
item 1 in §7 below.

So `GrievanceBlock` took an `unconfigured` prop:

- `'warn'` — Privacy Notice §12 and the Contact page. On a legal document the absence
  of a published grievance route is information the reader is entitled to.
- `'hide'` — the footer. Nothing at all until there is a contact, and the whole
  section including its `border-t` divider is left out rather than emptied, because a
  rule with a gap under it is its own small bug. The moment the env vars are set, the
  real contact appears in the footer of every page, which is what s.13(1) asks for.

The card chrome also moved from the call sites into the component. Privacy and Contact
each wrapped it in a grey bordered card, which put a red alert inside a grey box; the
two branches need different boxes, so the component owns both.

Pinned by four verifier checks, because "where does the warning appear" is exactly the
kind of thing that drifts back: the footer must contain `unconfigured="hide"` and gate
on `hasContact`, the gate must sit above the divider, and both legal pages must still
carry the bare `<GrievanceBlock />`.

**D-7 — Server-side enforcement of the signup tick is a switch, and the switch is on
the compliance checklist.** The signup form always sends a consent map and refuses to
submit until the necessary boxes are ticked. Whether the *API* refuses a registration
without it is `VS_REQUIRE_SIGNUP_CONSENT`, default off.

Rejected: enforcing unconditionally. Sixteen internal scripts (`_e2e.py`,
`_test_billing.py`, `_verify_ui.py` and others) register with `{email, password}`, and
breaking every one of them was a poor trade for a rule the only real client already
enforces. Rejected also: leaving the server not caring and saying nothing — that is
consent theatre, which D-2 exists to avoid. So the switch is reported by
`consent.readiness()` as a **failing check** until it is on, and there is a second check
that counts accounts with no `service_terms` record at all. Configuration can lie;
`SELECT COUNT(*)` cannot.

**D-8 — The signup and upload checkboxes were removed. The records were not.**
Reversal of the UI half of D-2, at the product owner's direction, after seeing it
built: three unticked boxes with two paragraphs of third-party-processing detail in
front of somebody trying to sign up, and two more above the dropzone on every upload
until the record existed. Every comparable product (ElevenLabs was the reference) is
email, password, button, and one line of linked legal text underneath.

What replaced them:

| Was | Is |
| --- | --- |
| Three unticked boxes on signup, submit gated on two of them | Email + password + `Sign up`, with "By continuing you agree to our Terms of Service, Privacy Notice and Disclaimer" underneath |
| Two unticked boxes above the dropzone, dropzone disabled until ticked | One line under the dropzone: "By uploading you confirm you have the right to every voice in the file, and agree to it being processed as described in our Privacy Notice and Disclaimer" |
| `consent_records` written with `method='checkbox'` | `consent_records` written with `method='terms_acceptance'` |

**Be clear about what this costs.** DPDP s.6(1) wants consent that is free, specific,
informed and unambiguous, given by clear affirmative action. An unticked box is the
strongest available evidence of all four. "By continuing you agree" is weaker: the
affirmative action is pressing a button whose primary purpose is something else. It is
what the market does and it is not the same thing, and if this is ever tested the
checkbox version would have been easier to defend. That is a commercial judgement about
conversion against evidentiary strength, and it is the product owner's to make — it is
recorded here rather than absorbed silently.

**What was deliberately kept, because the cost above is bounded by it:**

- **The record still exists and is still written before the data moves.** `service_terms`
  at registration, `process_video` + `voice_clone` awaited before the first upload byte.
  "What did this account agree to, when, against which notice version" still has an
  answer, which is most of what s.6 actually asks a fiduciary to be able to produce.
- **`method` tells the truth.** New allowlist `consent.METHODS`, and the `method` column
  now records `terms_acceptance` rather than `checkbox`. The column exists precisely so
  the two can be told apart; recording the stronger label for the weaker control would
  have turned the audit trail into a false document. `POST /api/privacy/consent` takes
  `method` from the caller and validates it, so the banner says `banner` and a settings
  toggle says `settings`.
- **Nothing optional was folded into the sentence.** `product_email` moved from
  `where='signup'` to `where='settings'` — it is now asked for *nowhere* except the
  account's own privacy page, and analytics only from the banner. This is stricter than
  before: an optional tick sitting next to a necessary one gets swept along with it, and
  it now has to be sought out. Both verifiers assert that no optional purpose has
  `where` in `('signup','upload')`, so re-bundling one cannot ship quietly.
- **The voice-rights assertion stayed on the page**, not just in the Disclaimer. It is
  the uploader confirming they may submit somebody else's biometric-adjacent data, which
  is the one sentence that protects the business rather than the user.

**The published copy was corrected in the same change.** Privacy §3, Terms §8 and
About §3 all described unticked per-purpose boxes. Leaving that in would have been the
exact drift the notice-served-from-code design exists to prevent — a notice describing
a UI that no longer exists is a false statement regardless of intent.

`ConsentChecks.tsx` deleted (nothing used it), along with the now-dead
`disabledReason` prop on `Dropzone`. `useUploadConsent` reduced to a recorder: it no
longer blocks the upload if the write fails, because the acceptance also exists at
signup and refusing a paying customer's upload over a logging failure costs more than
it protects. The gap is visible instead — `readiness()` counts accounts with no record.

**Consent may be *granted* for a necessary purpose but not *withdrawn*.** First pass
had `POST /api/privacy/consent` refuse any required purpose outright, which left the
upload gate with nowhere to record its answer — both upload purposes are necessary.
Granting is ordinary (ticking the boxes above the upload button, or re-consenting after
a notice-version bump); withdrawing is account closure and gets an error that says so.

**The upload gate does not re-ask on every upload.** It asks when there is no record
for the current notice version, and skips when there is. Re-asking every time is
friction that teaches people to click through without reading, which is the opposite of
informed. It fails *towards* asking: if the consent lookup or the notice fetch fails,
it asks.

**Consent is recorded before the bytes move, and the upload stops if the record
fails.** `persist()` is awaited, and a failure aborts the upload with a message rather
than proceeding. A consent row written after the video has already been sent proves
nothing about the order things happened in.

**The refusal is stored, not just the grant.** `payload` sends an explicit `false` for
every purpose shown but not ticked. Otherwise "they never answered" and "they said no"
are indistinguishable later.

**`dbbrowse` redaction is table-aware, and the free-form SELECT path errs towards
hiding.** `emails.body` is hidden; `inbox_messages.body` is not, because that is the
message somebody deliberately sent us. The arbitrary-SQL path cannot know which table a
column came from, so there `body` and `html` are hidden regardless — a hand-written
query selecting `body` is far more likely to be reading `emails`.

**The Terms page had to be created before a clause could be added to it.** There was no
Terms surface in the codebase at all. §8 is the data-protection clause the brief asked
for; the surrounding ten sections exist so it is not floating on its own.

**Trackers get a gate, not a preferences dialog.** `legal/tracking.ts` exposes one
function, `allowTracking()`, which returns false unless somebody explicitly opted in,
and refuses on malformed or absent storage. Any future analytics script must pass it.
Building a category-based cookie manager for vendors that do not exist would have been
the theatre D-1 rejects.

**Erasure and export are self-service for signed-in users, and a logged request for
everybody else.** The session is what makes the fast path safe — there is nothing left
to verify. An unauthenticated erasure that executed immediately would let anyone who
knows an email address destroy that person's account.

**The admin inbox refuses to resolve a rights request without a note.** Client-side, on
the kinds that carry a deadline. "Resolved" alone does not survive a regulator asking
how a request was answered.

---

## 5. Built

Everything below is on branch `compliance/dpdp`, nothing pushed. The tuned VoiceStudio
pipeline, its container and the golden preset were not touched.

### 5.1 Database — `backend/app/schema.sql` (+3 tables, appended)

| Table | Purpose |
| --- | --- |
| `consent_records` | Append-only consent ledger. Purpose, granted/withdrawn, notice version, method, IP, User-Agent. `user_id` nullable for consent captured before the account exists. |
| `inbox_messages` | Contact messages **and** rights requests in one table (`kind`), with `due_at` set only for the kinds that have a statutory deadline, plus `handled_by` / `handled_note`. |
| `admin_access_log` | Which admin *read* whose personal data. Separate from `admin_audit` so ten thousand reads do not bury the twelve writes that move money. |

### 5.2 Backend

**`backend/app/consent.py` — new.** The single implementation of "what did this account
agree to". `NOTICE_VERSION`, `GRIEVANCE_*`, `RIGHTS_RESPONSE_DAYS`, the five `PURPOSES`,
`purposes_for()`, `record()` / `record_many()`, `current_for()` (uses `MAX(id)`, not
`MAX(at)` — `db.now()` is second-precision and a grant plus withdrawal in the same
second would tie), `history_for()`, `submit()`, `overdue_count()`, `readiness()`.

**`backend/app/routers/privacy.py` — new.** Public where the law requires it.

| Route | Auth | What |
| --- | --- | --- |
| `GET /api/privacy/notice` | none | Retention, recipients, cookies, purposes, grievance — served from `config.py` and `consent.py` so the published notice cannot drift from the code |
| `POST /api/contact` | none | Contact message → admin inbox, ack by email |
| `POST /api/privacy/request` | none | Rights request, logged with a due date, ack by email |
| `GET /api/privacy/consent` | user | Current state + full history |
| `POST /api/privacy/consent` | user + CSRF | Append a decision. Grants a necessary purpose; refuses to withdraw one |
| `GET /api/privacy/export` | user | s.11 access — everything about that user, minus credential hashes |
| `POST /api/privacy/erase` | user + CSRF + password + `confirm:"DELETE"` | s.12(3) erasure |

**`backend/app/routers/admin.py` — appended.** `log_read()` (best-effort by design: a
logging failure must not lock an admin out of an incident), `GET /inbox`,
`POST /inbox/{id}`, `GET /users/{id}/consent`, `GET /dpdp`, `GET /access-log`.
`log_read` wired into `/users`, `/users/{id}/jobs`, `/sessions`, `/mail`, `/inbox`,
`/users/{id}/consent` and `/access-log` — which logs itself, because an audit trail an
admin can read without trace has a hole in exactly the shape of an admin.

**`backend/app/routers/auth.py`.** New `Registration(Credentials)` model carrying
`consent`; `/login` untouched. Consent recorded against the new `user_id` in the same
request. `VS_REQUIRE_SIGNUP_CONSENT` gate (D-7).

**`backend/app/routers/dbbrowse.py`.** FINDING-3 partially closed: `reset_token_sha256`
added to `_HIDE`; `emails.body` and `emails.html` hidden via a new table-aware
`_HIDE_BY_TABLE`; `body`/`html` hidden in the free-form SELECT path where the table is
unknown. `log_read` added to `GET /table/{name}` and `POST /query`, the latter recording
the SQL itself since that is the only record of what an arbitrary SELECT reached.

**`backend/app/ratelimit.py`.** `contact` and `privacy_request` at 5/hour. This is what
stands in for the captcha that does not exist (FINDING-7).

**`backend/app/notify.py`.** `contact_ack()`, `rights_ack()`, `account_erased()`.

**`backend/app/main.py`.** `privacy` router registered.

### 5.3 Frontend — public pages

New directory `frontend/src/legal/`.

| Route | File | Notes |
| --- | --- | --- |
| `/privacy` | `Privacy.tsx` | 12 sections. Retention, recipients and cookies rendered from `/api/privacy/notice`. States the FINDING-1 upload-retention gap and the FINDING-7/8/9 security gaps in §8 rather than only listing strengths |
| `/terms` | `Terms.tsx` | §8 is the data-protection clause |
| `/disclaimer` | `Disclaimer.tsx` | Where machine dubbing actually slips, named specifically; voice-rights warning |
| `/about` | `About.tsx` | No invented company facts. Entity details marked as placeholders |
| `/contact` | `Contact.tsx` | Two modes, one inbox. `?kind=access` opens rights mode |

Shared: `LegalPage.tsx` (page shell + `Clause` / `Bullets` / `DataTable`, and the
`LEGAL REVIEW PENDING` banner), `useNotice.ts` (cached single fetch),
`Grievance.tsx` (renders a red warning when unconfigured — D-6).

### 5.4 Frontend — consent

- **`ConsentChecks.tsx`** — per-purpose checkboxes. `useState({})` and nothing seeds
  it; no `defaultChecked` anywhere. Necessary and optional rendered as visually
  distinct groups. Real `<input type="checkbox">`, styled, not a div with a role.
- **`ConsentBanner.tsx`** — declares one cookie and zero trackers, offers the analytics
  choice, does not block the page, hides itself on the legal pages, reappears when the
  notice version changes. "No analytics" and "That's fine" are the same size and shape.
- **`tracking.ts`** — the gate. `allowTracking()` defaults to refused.
- **Signup** (`auth/Signup.tsx`) — `purposes_for('signup')`, submit gated on the
  necessary ticks, decision sent with the registration.
- **Upload** (`app/Dubbing.tsx` + `useUploadConsent.ts`) — `purposes_for('upload')`
  above the dropzone, dropzone disabled with a stated reason until ticked, recorded
  before the first byte moves.

### 5.5 Frontend — dashboard

- **`/app/privacy`** (`app/PrivacyCenter.tsx`) — one-click export, the consent ledger
  shown to the person it belongs to, optional-consent withdrawal, and account closure
  behind password + typing `DELETE`. What is retained is listed *before* the button,
  not after.
- **`/app/admin/inbox`** (`app/admin/AdminInbox.tsx`) — one list, server-sorted by
  urgency, deadline shown as days-remaining **and** an absolute date, `new` / `overdue`
  counts, the DPDP readiness checklist inline with the fix for each failing item, and a
  specific warning on erasure requests about verifying identity first.
- **`AppShell.tsx`** — `Your data` in the main nav (same number of clicks as billing)
  and `Inbox` in the admin nav, with a count badge that turns red when something is
  past its deadline. Literal Tailwind class strings only.
- **`Footer.tsx`** — `Company & legal` column and the grievance block on every page.

### 5.6 Documents

- **`BREACH_RUNBOOK.md`** — new. 72-hour clock, containment commands for this stack,
  the twenty-table sensitivity map, what is on disk, what is on the GPU box, the six
  third parties, Board notice template, user notice templates (including the
  hash-exposed and voice-clip-exposed variants), and the non-account-holder problem:
  people who appear as speakers in somebody else's upload are Data Principals we hold
  data about and cannot contact.
- **This file.**

---

## 6. Needs lawyer review

Every block marked `LEGAL REVIEW` in source. Specifically:
- The Privacy Notice's characterisation of the legal basis for each purpose.
- Whether voice clips constitute sensitive personal data under the Rules as notified,
  and whether the current consent language is sufficient for **third-party** speakers
  in an uploaded video.
- The 30-day rights-response window (D-5).
- Cross-border transfer position: transcripts reach an LLM provider and audio reaches
  an ASR provider. Both sit behind a proxy on the GPU box; **their actual endpoints,
  models and retention terms are not in this repo and could not be confirmed from
  code.** This must be established before the notice can honestly name them.
- Whether this service is a Significant Data Fiduciary (s.10) at any projected scale.
- The Disclaimer's limitation-of-liability wording.
- Children's data: there is no age gate. DPDP s.9 forbids tracking and targeted
  advertising to children and requires verifiable parental consent. **Open.**
- The Terms as a whole (`legal/Terms.tsx`) — it did not exist before this branch and is
  engineering-drafted throughout. §9 liability in particular.
- The entity identity placeholders: `Privacy §1`, `Terms §1`, `About §5`. DPDP s.5
  requires the Data Fiduciary to be identifiable and right now it is not.
- The nomination right (s.14). No mechanism exists; the notice says so. Confirm whether
  handling it manually through the contact form is acceptable.
- Whether the erasure design holds: personal data destroyed, payment records retained
  de-linked under s.8(7). The response itemises what was kept and why. Confirm the
  retention basis and the period.
- Whether logging the IP of a contact-form sender needs its own disclosure beyond the
  line already on the form.
- The Board notification channel and prescribed form (`BREACH_RUNBOOK.md §6`).

---

## 7. Open items

Ordered by how much they would matter in an incident, not by effort.

### Must be done before real users

| # | Item | Where |
| --- | --- | --- |
| 1 | Appoint a Grievance Officer: `VS_GRIEVANCE_NAME`, `VS_GRIEVANCE_EMAIL`, `VS_GRIEVANCE_ADDRESS`. Until then every page footer shows a red warning, by design | `consent.py` |
| 2 | `VS_COOKIE_SECURE=1`, TLS termination, HSTS, `VS_PUBLIC_BASE_URL=https://…` (FINDING-9) | `config.py`, deployment |
| 3 | `VS_REQUIRE_SIGNUP_CONSENT=1` in production (D-7) | `auth.py` |
| 4 | `VS_NOTICE_VERSION` set to a reviewed version, off the `-draft` default | `consent.py` |
| 5 | Fill the entity placeholders in Privacy §1, Terms §1, About §5 | `legal/` |
| 6 | Name the Incident Lead and Technical Lead in the runbook | `BREACH_RUNBOOK.md §1` |

All six are reported by `GET /api/admin/dpdp` — items 1-4 as failing checks with the fix
named, and the checklist is rendered inline at the top of the admin inbox.

### Findings still open

| Finding | Status |
| --- | --- |
| FINDING-1 — source uploads never deleted | **Open.** Account closure now deletes them, which is the only path there is. `worker.sweep_expired` still deletes outputs only. The Privacy Notice states this rather than claiming a window we do not enforce |
| FINDING-2 — failed jobs leave source video + voice clips on the GPU box | **Open.** Requires moving `engine.delete_history` out of the `try` in `worker.py` and into `_fail()`. Deliberately not touched: it is inside the tuned pipeline's call path |
| FINDING-3 — live reset URLs in `emails.body` | **Partially closed.** No longer readable through `dbbrowse` or `/api/privacy/export`, and erasure deletes the rows. The root cause — storing the URL at all — is unchanged. Fix: store a redacted body, or drop `body` after a short window |
| FINDING-4 — no export / no deletion | **Closed.** `GET /api/privacy/export`, `POST /api/privacy/erase`, no schema cascade added to `payments` or `usage_ledger` |
| FINDING-5 — `X-Forwarded-For` trusted unconditionally | **Open.** Every logged IP in `sessions`, `consent_records`, `inbox_messages` and `admin_access_log` is caller-controlled. Fix: a trusted-proxy allowlist in `deps.client_ip`. Noted in the runbook so logged IPs are not mistaken for identification |
| FINDING-6 — admin reads unaudited | **Closed** for the seven read endpoints and both database-browser routes |
| FINDING-7 — no captcha | **Open, mitigated.** 5/hour per IP on `/api/contact` and `/api/privacy/request`. With FINDING-5 open, the limit is bypassable by forging the header |
| FINDING-8 — no encryption at rest | **Open.** Stated in the notice rather than glossed over |
| FINDING-9 — HTTPS never enforced | **Open.** Now on the readiness checklist |
| FINDING-10 — two sources of truth for retention | **Open.** `plans.output_retention_days` still unread; the notice reads the constants the worker actually uses, so the published figure is the true one |
| FINDING-11 — unauthenticated `/api/health` and `/db` | **Open** |
| FINDING-12 — the whole database staged for commit | **Closed.** 396 files unstaged, `.gitignore` extended by shape. Nothing was committed, so no history rewrite. `_index_coherence.py` guards the other half — a commit that does not build |

### Next, in order

1. **FINDING-1.** Add an upload-retention sweep. Largest single reduction in breach
   scope available, and the notice currently has to admit it.
2. **FINDING-5.** Trusted-proxy allowlist. Cheap, and it is what makes every logged IP
   and every rate limit mean something.
3. **FINDING-3 at the root.** Stop persisting the reset URL.
4. **FINDING-2.** Cleanup on failure, once someone is willing to touch that path.
5. **Age gate**, if s.9 turns out to bite.
6. **Encryption at rest** for `data/uploads` and `data/outputs`.
7. **Re-consent flow** for the accounts that predate the ledger. The readiness check
   already counts them; nothing yet asks them.

### Verification

| Suite | Before | After |
| --- | --- | --- |
| `npx tsc -b --force` | clean | clean |
| `npm run build` | clean | clean, 338 modules |
| `_verify_all.ps1` (backend) | 350 checks / 12 suites | **489 checks / 13 suites, 0 failures** |
| `_verify_ui.py` (frontend) | 223 checks | **305 checks, 0 failures** |

New backend suite **`backend/_test_dpdp.py`** — 139 checks, registered in
`_verify_all.ps1` with its own database. It runs last and gets its own server
process because the final section floods the contact form until it returns 429, and
because it erases an account, neither of which is state to hand to the next suite.

The interesting assertions are the negatives:

- an anonymous erasure *request* does **not** erase — the account still signs in
  afterwards
- a required purpose can be granted but **not** withdrawn, and the refusal says
  "close your account" instead
- withdrawal **appends**: history grows by two after a grant and a withdrawal, and
  `current` reflects the newest row
- a refusal at signup is stored as `granted=0`, not dropped
- the export contains no `password_hash` and no `token_sha256`, and never an email
  body
- `emails.body`, `users.password_hash` and `users.reset_token_sha256` all read
  `<hidden>` through the database browser, including via a hand-written
  `SELECT body FROM emails`
- `inbox_messages.body` is **not** hidden, because that is the message somebody sent
- after erasure the `users` row is `erased-{id}@invalid` with `role='erased'`, and the
  consent records, sessions and messages are gone
- the access log records `admin.users`, `admin.sessions`, `admin.mail`,
  `admin.user_jobs`, `admin.inbox`, `admin.user_consent`, `admin.access_log`,
  `db.table` and `db.query`, with the target user id on the scoped ones
- signup consent is stored as `method='terms_acceptance'`, and an invented method is
  refused, so a client cannot describe a weak control as a strong one
- no optional purpose has `where` in `('signup','upload')` — the check that stops D-8's
  minimal signup quietly re-acquiring a bundled consent

`_verify_ui.py` gained 82 checks: the seven new routes serve on a hard refresh, the
public endpoints work through the dev proxy, a stranger's message reaches the admin
inbox, the three tables exist, and a set of source assertions that a screenshot could
never catch — signup contains no `type="checkbox"`, the `signUp()` consent argument is
*exactly* `{ service_terms: true }`, the upload awaits `record()` before sending, the
gate defaults to refused, the footer links to all five pages, and the Terms carry
`id="data-protection"`. Plus a bundle scan for fourteen analytics vendors and four
third-party CDNs, which is what keeps the notice's "no trackers" sentence true rather
than aspirational.

Two of those checks were wrong on the first attempt, both the same way: they searched
for a word (`defaultChecked`, `product_email`) that appears in the *comment explaining
why it is absent*. Both now match the code — the JSX attribute form, and the call's
actual argument list via regex. A source assertion that can be satisfied by prose is
worse than no assertion.

`_verify_all.ps1` now pins `VS_TEST_BASE`. `_test_dpdp.py` honours that variable so it
can run beside a live backend that already owns 8099, but the sweep *is* what owns 8099
while it runs — a value left in the shell from an ad-hoc run pointed the suite at a dead
port, and it reported `NO SUMMARY LINE` rather than a failure, which is the worst way
for a test to break.

`app/postgres_schema.sql` also gained the three tables. `_test_portability.py`
compares the two schemas table-by-table and column-by-column, so it caught the
omission immediately (20 tables, 20 compared, 47/0 after).

Nothing was pushed. Branch `compliance/dpdp`, base `ab77fc6`.
