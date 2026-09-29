# Personal data breach runbook

**Scope:** the Kresker dubbing service — the FastAPI backend in `backend/`, the React
frontend in `frontend/`, the SQLite/Postgres database, and the GPU box in AWS
ap-south-1 that runs the dubbing pipeline.

**Statutory basis:** Digital Personal Data Protection Act, 2023 — s.8(6) requires a
Data Fiduciary to notify the Data Protection Board of India **and each affected Data
Principal** of a personal data breach. s.33 / Schedule sets the penalty for failing to
do so, which is separate from and can exceed the penalty for the breach itself.

> **LEGAL REVIEW REQUIRED.** The 72-hour target below is the working deadline this
> team operates to. Confirm the notified DPDP Rules for the exact window, the
> prescribed form, and the submission channel before the first real incident. The
> templates are drafts.

> **NOT YET CONFIGURED.** `VS_GRIEVANCE_NAME` and `VS_GRIEVANCE_EMAIL` are empty in
> this deployment, so there is no named person to run this. That is the first thing to
> fix — a runbook with no owner does not get executed.

---

## 0. The clock

| Point | Target | Why |
| --- | --- | --- |
| Detection → containment started | 1 hour | Stop it getting worse before you understand it |
| Detection → Board notified | **72 hours** | s.8(6). Notify on partial information rather than late |
| Detection → affected principals notified | **72 hours**, in parallel | s.8(6) requires both; do not serialise them |
| Notification → full written report | 7 days | Follow-up detail, root cause, remediation |

**Notify on incomplete information.** A first notice that says "approximately 400
accounts, email addresses and upload filenames, investigation continuing" filed at
hour 40 is compliance. A complete report at hour 90 is not.

**Start a timestamped log the moment you suspect a breach.** Every command run, every
finding, every decision, in UTC, in one file. The log is the evidence that this
procedure was followed; reconstructing it afterwards from memory is not.

---

## 1. Roles

| Role | Who | Does |
| --- | --- | --- |
| Incident Lead | *TO BE NAMED* | Owns the clock, makes the notify/no-notify call, single point of contact |
| Grievance Officer | `VS_GRIEVANCE_NAME` — **unset** | Files the Board notice, answers principals |
| Technical Lead | *TO BE NAMED* | Contains, preserves evidence, determines scope |
| Comms | *TO BE NAMED* | Sends the user notice, handles inbound |

One person may hold several roles. Nobody holds none — an unassigned role is a step
that does not happen.

---

## 2. What is actually at risk

Written out so scoping is a lookup rather than an investigation.

### 2.1 Database tables holding personal data

`backend/app/schema.sql`. Twenty tables; these are the ones that matter in a breach.

| Table | Personal data in it | Sensitivity |
| --- | --- | --- |
| `users` | Email, bcrypt password hash, `reset_token_sha256` | **High** — the hash is a credential |
| `sessions` | Session token hash, CSRF token, **IP address, User-Agent** | **High** — a live session token is account access |
| `emails` | Recipient address, subject, **and `body`** | **Critical** — see 2.4 |
| `uploads` | Original filename, byte size, duration, stored path | Medium — filenames are often personal |
| `jobs` | Language pair, state, output path, timings | Low on its own, links everything else |
| `job_segments` | **Full transcript and translation of the speech** | **High** — the actual content of the video |
| `job_artifacts` | Paths to intermediate files | Medium |
| `job_events` | Progress detail strings | Low |
| `payments` | Amount, currency, method type, Razorpay payment id | **High** — financial |
| `subscriptions` | Plan, period, Razorpay subscription/order id | Medium |
| `checkout_sessions` | Amount, plan, provider ids | Medium |
| `usage_ledger` | Minutes charged and refunded per job | Low |
| `inbox_messages` | Email, name, free-text message, **IP** | High — includes non-customers |
| `consent_records` | Email, purpose, decision, **IP, User-Agent** | Medium |
| `admin_audit` | Which admin did what to whom | Medium |
| `admin_access_log` | Which admin *read* whose data | Medium |
| `webhook_events`, `webhook_rejects` | Razorpay payloads | Medium |
| `plans`, `gpu_state` | No personal data | — |

### 2.2 Files on disk

| Path | Contents | Deleted by |
| --- | --- | --- |
| `backend/data/uploads/` | **Source videos as uploaded.** Faces and voices. | Nothing automatic (FINDING-1). Only account closure. |
| `backend/data/outputs/` | Dubbed videos | `worker.sweep_expired`, on the plan's timer |
| `backend/data/app.db` | The whole database | — |
| `backend/data/secret.key` | Download-token signing key | — |
| `backend/data/mail/` | Written messages when the mail backend is `file` | — |

At the time of the audit, `data/uploads` held **149 files / 270 MB** with no deletion
path. Assume in any breach scoping that every source video ever uploaded is still
present.

### 2.3 On the GPU box (AWS ap-south-1)

Per-job working directories under the VoiceStudio job root contain the source video,
separated speech and background stems, **per-speaker voice reference clips**
(`voice_<speaker_id>.wav`, `seg_ref_<seg_id>.wav`) and the rendered audio.
`engine.delete_history` is called on success. **FINDING-2: it is not called when a job
fails**, so failed jobs leave the source video and the voice clips on the box
indefinitely. Assume they are there.

A voice clip is biometric-adjacent personal data about whoever is speaking, who is
frequently **not** the account holder. That materially widens who has to be notified.

### 2.4 The single worst row type in the database

`emails.body` stores the message as sent, and the password-reset message contains a
**live reset URL with the raw token in it** (`notify.py`). A dump of `emails` is
therefore a dump of working account-takeover links for every reset requested inside the
token validity window.

**If `emails` is in scope, treat it as a credential breach, not a message-log breach.**
Force-expire every outstanding reset token immediately (section 4).

### 2.5 Third parties that also hold some of it

Named so a supply-chain incident can be scoped without re-deriving the list.

| Recipient | What they have |
| --- | --- |
| AWS EC2 `ap-south-1` (instance `i-041b48c591cb86e19`) | The entire video, during processing |
| LLM translation service, reached via the box proxy `172.17.0.1:8900` | Every transcript line verbatim, with timings |
| OpenAI-compatible ASR proxy | Audio from the video, including voice reference clips |
| Razorpay | Amount, plan, and `user_id` in the order `notes` |
| AWS SES | Full message bodies, passed on the command line |
| Cloudflare R2 | The finished dubbed video (only if `VS_R2_*` is configured) |

Also present in the repository but **not reachable from the API**:
`pipeline/gcloud_stt.py`, `gemini_audio.py`, `gcloud_dub.py`, `ai_script.py` talk to
Google Cloud directly. Confirm they were not in use before excluding them.

---

## 3. Detect

Anything on this list starts the clock.

- A row appears in `admin_access_log` for an admin session you cannot account for
- `GET /api/admin/access-log` shows a `db.query` with a `SELECT` nobody owns
- `GET /api/admin/sessions` shows a session from an unexpected country or ASN
- `GET /api/admin/audit` shows a grant, revoke or refund nobody performed
- Unexplained growth or shrinkage of `data/uploads` or `data/outputs`
- The GPU box has an inbound security-group rule nobody added
- A customer reports content of theirs appearing somewhere it should not
- A dependency you use announces a compromise
- `data/secret.key` has a modification time you cannot explain

**A near-miss with no confirmed access is still worth logging.** It is not notifiable,
and it is how you find the gap before it is.

---

## 4. Contain — first 60 minutes

Do these in order. Do not skip straight to investigation; a breach that is still
running gets bigger while you read logs.

```powershell
# 1 ── Cut off remote access to the engine. Lock the box's inbound rules to nothing.
#      This is the aws_lock_ip.ps1 pattern, with an IP that matches no one.
aws ec2 revoke-security-group-ingress --profile videotrans --region ap-south-1 `
    --group-id <sg-id> --protocol tcp --port 22 --cidr 0.0.0.0/0

# 2 ── Revoke every session. Everyone signs in again; that is acceptable today.
sqlite3 backend/data/app.db "UPDATE sessions SET revoked_at = datetime('now');"

# 3 ── Kill every outstanding password-reset token. See 2.4 for why this is not optional.
sqlite3 backend/data/app.db "UPDATE users SET reset_token_sha256=NULL, reset_expires_at=NULL;"

# 4 ── Snapshot the evidence BEFORE changing anything else. Read-only copy.
Copy-Item backend\data\app.db "backend\data\_incident_$(Get-Date -Format yyyyMMddHHmmss).db"

# 5 ── Rotate the download-token signing key. Invalidates every outstanding link.
Remove-Item backend\data\secret.key   # regenerated on next start
```

Then:

- **Do not delete anything else.** Deleting the attacker's traces deletes your evidence
  and your ability to scope the breach, which is what the notice requires.
- Preserve `admin_access_log`, `admin_audit`, `sessions` and `emails` before any
  cleanup. They are the only record of what was reached.
- If the credential that was compromised is an AWS key, rotate it in IAM and check
  CloudTrail for what it did before you revoked it.
- If the compromise is in the deployed code, take the service offline rather than
  leave a backdoored version serving. An outage is recoverable; a continuing breach
  compounds.

---

## 5. Scope — what to establish before notifying

Answer these five. Partial answers are fine; unrecorded answers are not.

1. **What categories of personal data?** Use the table in 2.1. Name categories, not
   column names — "email addresses, IP addresses and video transcripts", not
   "`users.email`, `sessions.ip`, `job_segments.source_text`".
2. **How many principals?** `SELECT COUNT(*) FROM users WHERE ...`. Include people who
   are **not** account holders: anyone who appears as a speaker in somebody else's
   uploaded video, and anyone who used the contact form.
3. **When did it start and has it stopped?** From `admin_access_log`, `sessions`,
   CloudTrail, and access logs.
4. **What is the likely consequence?** Account takeover, exposure of video content,
   financial exposure, identity/voice misuse. Be concrete.
5. **What have you done about it?** Section 4, itemised with times.

---

## 6. Notify the Data Protection Board — within 72 hours

> **LEGAL REVIEW:** submission channel and prescribed form to be confirmed against the
> notified DPDP Rules. File on the official channel; email only as a fallback with a
> record of sending.

### Template — Board notice

```
Subject: Personal data breach notification under s.8(6), DPDP Act 2023 — [ENTITY NAME]

To: The Data Protection Board of India

1. DATA FIDUCIARY
   Entity name:            [LEGAL ENTITY NAME]
   Registered address:     [ADDRESS]
   Service:                Kresker — automated video dubbing
   Grievance Officer:      [NAME], [EMAIL], [PHONE]
   Incident contact:       [NAME], [EMAIL], [PHONE]

2. THE BREACH
   Detected at:            [YYYY-MM-DD HH:MM IST]
   Estimated to have begun: [YYYY-MM-DD HH:MM IST] / unknown
   Ongoing?                [contained at HH:MM IST / ongoing]
   How detected:           [e.g. anomalous entry in the admin read-access log]
   Nature:                 [unauthorised access / disclosure / loss / alteration]

3. PERSONAL DATA AFFECTED
   Categories:             [e.g. email addresses; IP addresses and User-Agent strings;
                            uploaded video files; transcripts of speech in those
                            videos; per-speaker voice reference audio; payment
                            references. NO card or UPI credentials — those are held by
                            the payment provider and never reach our systems.]
   Approximate number of Data Principals affected: [N]
   Of whom account holders: [N]
   Of whom non-account-holders (speakers appearing in uploaded videos, contact form
   senders): [N]
   Special categories:     [voice recordings — biometric-adjacent; state explicitly]

4. LIKELY CONSEQUENCES
   [Concrete. e.g. "Password hashes were exposed. Reset tokens in the exposed email
   log were live at the time of access, creating a risk of account takeover for the
   N accounts that had requested a reset in the preceding 60 minutes. Uploaded videos
   and their transcripts may have been read, exposing the content of those videos and
   the voices of people appearing in them who are not our customers."]

5. MEASURES TAKEN
   [Timestamped. e.g.
    HH:MM  inbound access to the processing server revoked
    HH:MM  all sessions revoked, forcing re-authentication
    HH:MM  all outstanding password-reset tokens invalidated
    HH:MM  download-token signing key rotated
    HH:MM  forensic copy of the database taken and preserved
    HH:MM  affected Data Principals notified by email]

6. MEASURES PROPOSED
   [e.g. mandatory password reset on next sign-in; encryption at rest for stored
    videos; deletion of source uploads on a timer; IP allowlist on the admin surface.]

7. NOTIFICATION TO DATA PRINCIPALS
   Method:                 email to the address on each account
   Sent at:                [YYYY-MM-DD HH:MM IST]
   Number notified:        [N]
   Non-account-holders:    [how they were reached, or why they could not be —
                            note that we hold no contact details for a person who
                            merely appears in somebody else's uploaded video]

8. STATUS
   [Investigation continuing. A full written report will follow by YYYY-MM-DD.]

Signed,
[NAME], [ROLE], [ENTITY]
[DATE]
```

---

## 7. Notify affected people — within 72 hours, in parallel

Send it directly. Do not put it only on a status page and count that as notice.

Write it for somebody who is not technical and did not ask to have a bad day. Say what
happened, what of theirs is involved, what you have already done, what they should do,
and how to reach a human. No hedging, no "we take your privacy seriously", no burying
the lede.

### Template — user notice (account holders)

```
Subject: Someone accessed [DATA] from your Kresker account — what we know and what to do

Hello,

On [DATE] we found that someone gained unauthorised access to part of our system.
Your account was affected. I am writing to tell you exactly what happened rather
than the least I can get away with.

WHAT WAS ACCESSED
  [Plain list. e.g.
   - Your email address
   - The IP addresses you have signed in from
   - The names of the video files you uploaded
   - The transcripts of the speech in those videos
   - The videos themselves]

WHAT WAS NOT
  - Your password. We only ever store a one-way hash of it and cannot read it
    ourselves. [Delete this line if hashes were exposed and use the paragraph below.]
  - Your card or UPI details. Those go to our payment provider directly and have
    never been stored on our systems.

WHAT WE HAVE ALREADY DONE
  - Closed the access route, at [TIME] on [DATE].
  - Signed every device out of every account, so any stolen session is now useless.
  - Invalidated every outstanding password-reset link.
  - Rotated the keys that sign download links.
  - Notified the Data Protection Board of India, as the law requires.

WHAT YOU SHOULD DO
  1. Sign in and change your password. [If you have used that password anywhere
     else, change it there too — that is the real risk with a reused password.]
  2. If your video had other people speaking in it, please tell them. Their voice
     may have been included in what was accessed, and we have no way to contact
     them ourselves.
  3. Check your library and tell us if anything looks wrong.

WHY THIS HAPPENED
  [One or two honest sentences. No jargon and no blame-shifting.]

WHAT WE ARE CHANGING
  [Specific and verifiable. e.g. "Uploaded videos will be encrypted at rest and
   deleted automatically on the same timer as the dubbed output."]

Reply to this email and a person will answer. If you are not satisfied with how we
handle it, you can complain to our Grievance Officer at [EMAIL], and escalate to the
Data Protection Board of India.

I am sorry. This was our failure, not yours.

[NAME]
[ROLE], [ENTITY]
```

### If password hashes were exposed

Add, and mean it:

```
YOUR PASSWORD
  Passwords are stored as a bcrypt hash, never as the password itself, so whoever
  took the data cannot simply read yours. Bcrypt is deliberately slow to attack,
  but a short or common password could still be worked out given time. Please
  change it now, and change it anywhere else you have used the same one.
  We have signed you out everywhere, so you will be asked for the new one.
```

### If voice clips were exposed

Add:

```
ABOUT THE VOICES IN YOUR VIDEO
  To keep the speaker's voice in the dub, we cut short audio clips of each person
  speaking in your file. Those clips were among the data accessed. They are a few
  seconds each, and they are enough for someone to imitate a voice.

  If people other than you appear in that video, they have a right to know. We
  hold no contact details for them, so we cannot tell them ourselves — please pass
  this on.
```

### Non-account-holders

People who appear as speakers in somebody else's upload are Data Principals whose data
we hold and whom **we cannot contact**, because we never had their details. Do not
quietly drop them:

- Say so explicitly in section 7 of the Board notice.
- Ask the uploader to pass the notice on (template above).
- Publish the notice at a stable public URL so it can be pointed to.

---

## 8. After

Within 7 days of notifying:

- **Written root cause.** Not "human error". The specific decision, missing control or
  unpatched thing, and why the existing controls did not catch it.
- **Timeline** from the incident log, in UTC.
- **Remediation with owners and dates.** Anything without both is not remediation.
- **Update this runbook** with whatever it did not cover. Every incident finds a gap in
  the procedure; the gap is worth more than the postmortem.
- **Check the known-gap list** in `DPDP_PROGRESS.md §7`. If the breach exploited
  something already on it, that is the finding: it was known and not fixed.

---

## 9. Known gaps that make a breach worse today

Written here rather than only in the audit, because these are the things that will turn
a small incident into a notifiable one. Each is tracked in `DPDP_PROGRESS.md`.

| Gap | Effect in a breach |
| --- | --- |
| FINDING-1 — source uploads are never deleted | Every video ever uploaded is in scope, not just recent ones |
| FINDING-2 — failed jobs leave data on the GPU box | Source videos and voice clips persist there with no cleanup |
| FINDING-3 — `emails.body` holds live reset URLs | A message-log breach becomes an account-takeover breach |
| FINDING-5 — `X-Forwarded-For` is trusted unconditionally | Logged IPs may be attacker-chosen; do not treat them as identification |
| FINDING-8 — no encryption at rest | Disk or snapshot access is immediately readable data |
| FINDING-9 — `COOKIE_SECURE` off, no HSTS | On plain HTTP, session cookies are interceptable in transit |
| FINDING-11 — `/api/health` and `/db` unauthenticated | Free reconnaissance: engine URL, storage config, system info |

---

## 10. Quick reference

```powershell
# Who read what, most recent first
curl -b cookies.txt http://127.0.0.1:8099/api/admin/access-log?limit=500

# Who changed what
curl -b cookies.txt http://127.0.0.1:8099/api/admin/audit?limit=500

# Live sessions, with IP and User-Agent
curl -b cookies.txt http://127.0.0.1:8099/api/admin/sessions

# What we have told people (subjects only — bodies are never returned by the API)
curl -b cookies.txt http://127.0.0.1:8099/api/admin/mail?limit=500

# DPDP configuration state, with the fix for each failing check
curl -b cookies.txt http://127.0.0.1:8099/api/admin/dpdp

# Row counts per table, for scoping
sqlite3 backend/data/app.db ".tables"
sqlite3 backend/data/app.db "SELECT COUNT(*) FROM users;"

# What is on disk
Get-ChildItem backend\data\uploads | Measure-Object -Property Length -Sum
Get-ChildItem backend\data\outputs | Measure-Object -Property Length -Sum
```

**Board contact:** *TO BE CONFIRMED — insert the official channel for breach
notification under the notified DPDP Rules.*
