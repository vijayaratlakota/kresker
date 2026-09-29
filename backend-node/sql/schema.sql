-- Schema for the dubbing backend.
--
-- Mirrors section 7 of docs/website_backend_plan_v2.html plus the admin additions
-- from 10.2. Written for SQLite (local development) but kept deliberately close to
-- Postgres so the move is mechanical.
--
-- KNOWN DIFFERENCE FROM THE PLAN: the plan claims the queue on Postgres with
-- `SELECT ... FOR UPDATE SKIP LOCKED`. SQLite has no such thing, so locally the
-- queue is claimed with a single UPDATE ... WHERE state='queued' guarded by a
-- process-wide lock. Single-worker behaviour is identical; only multi-worker
-- contention differs. See app/worker.py.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,       -- scrypt, salt embedded
    role            TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
    created_at      TEXT NOT NULL,
    -- the free trial is a LIFETIME entitlement, so it must never live on a
    -- period counter that current_period_start could roll over (plan 3.4)
    free_trial_used_at TEXT,
    -- password reset: only the hash is stored, single use, 30 minute window
    reset_token_sha256 TEXT,
    reset_expires_at   TEXT,
    -- email confirmation. NULL means not confirmed, and an unconfirmed account
    -- cannot upload - which is what stops a throwaway address holding a GPU that
    -- bills by the hour. Same storage shape as the reset token above: hash only,
    -- single use, time limited.
    email_verified_at   TEXT,
    verify_token_sha256 TEXT,
    verify_expires_at   TEXT,
    -- Google's `sub`: the stable, opaque id for one Google account. NULL for an
    -- account that signs in with a password.
    --
    -- THE JOIN KEY IS THIS, NOT THE EMAIL. A Google account's address can change,
    -- and matching on the address alone would hand somebody else's rows to whoever
    -- holds that address next. `sub` never changes and is never reused.
    --
    -- The UNIQUE index on it is created in db._migrate rather than here: this file
    -- runs BEFORE the migrations, and on an existing database CREATE TABLE IF NOT
    -- EXISTS is a no-op, so an index over a column that has not been added yet
    -- would abort the whole script.
    google_sub          TEXT,

    -- ── one row per real INBOX, which is what makes the free tier finite ──────
    --
    -- The canonical form of `email` from app/emails.normalise: sub-address tags cut
    -- off, and Gmail's insignificant dots folded. UNIQUE, so john@gmail.com,
    -- john+1@gmail.com, j.o.hn@gmail.com and john@googlemail.com are ONE account
    -- instead of four.
    --
    -- They used to be four, and all four confirmation links landed in one inbox, so
    -- the confirmation gate in front of /api/uploads - the only thing rationing a GPU
    -- that bills by the hour - could be walked straight through at no cost.
    --
    -- `email` above still holds the address AS TYPED. Mail goes to that, because
    -- normalising the stored value would mean writing to a string the person does not
    -- recognise as theirs.
    --
    -- Its UNIQUE index lives in db._migrate for the same ordering reason as
    -- google_sub, and it is created only AFTER the backfill has resolved any
    -- pre-existing collisions.
    email_normalised    TEXT,

    -- ── the signup signals, captured because they cannot be reconstructed ─────
    --
    -- `sessions` already records an IP, but the earliest one there is the first
    -- successful LOGIN - which happens after confirmation, and never at all for an
    -- account that registers and stops. So there was no durable per-account signal to
    -- count, join on, or look at afterwards, and no way to add one retrospectively.
    --
    -- These two are also what the per-IP account-creation ceiling counts, which is why
    -- that ceiling survives a restart while the in-process rate limiter does not.
    signup_ip           TEXT,
    signup_user_agent   TEXT,

    -- 'active' | 'suspended'. Orthogonal to `role`, deliberately.
    --
    -- role='erased' is a DPDP tombstone: the personal data is already gone and the row
    -- only survives so the financial ledger still balances. Using it to stop an abusive
    -- account would mean destroying the evidence of the abuse in order to act on it,
    -- and it is irreversible. Suspension is neither.
    status              TEXT NOT NULL DEFAULT 'active',

    -- 1 = may start a checkout, 0 = may not. A SECOND, NARROWER LEVER than `status`.
    --
    -- Suspending stops the account using the product at all. That is the right answer to
    -- abuse and the wrong answer to a money problem: a disputed charge, a card being run
    -- through us in bulk, a refund argument still open. Those want the payments stopped
    -- and nothing else, because the person is very likely a real customer whose finished
    -- work should not vanish while it is sorted out.
    --
    -- Read through billing.purchasable_by, which is the one gate every buying path
    -- already goes through. Nothing else consults it, so setting it to 0 cannot
    -- accidentally take away access to anything already paid for.
    can_purchase        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,        -- public session id
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_sha256    TEXT NOT NULL,           -- ONLY the hash is stored, never the token
    csrf            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    ip              TEXT,
    user_agent      TEXT,
    revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS plans (
    code                    TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    interval                TEXT NOT NULL,   -- 'month' | 'year' | 'lifetime'
    price_paise             INTEGER NOT NULL,
    minutes_per_period      REAL NOT NULL,
    max_video_seconds       INTEGER NOT NULL,
    output_retention_days   REAL NOT NULL,   -- 7 paid, 1 free (plan 5.8)
    active                  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_code               TEXT NOT NULL REFERENCES plans(code),
    provider                TEXT NOT NULL,   -- 'razorpay' | 'manual'
    provider_subscription_id TEXT,           -- NULL for annual one-offs and manual grants
    status                  TEXT NOT NULL,   -- 'active' | 'expired' | 'cancelled'
    current_period_start    TEXT NOT NULL,
    current_period_end      TEXT NOT NULL,
    grace_until             TEXT,
    auto_renew              INTEGER NOT NULL DEFAULT 0,
    cancel_at               TEXT,
    created_at              TEXT NOT NULL,
    -- an annual plan is a one-off Order, so it has an order id and no
    -- subscription id. auto_renew above is the one honest column to read rather
    -- than inferring "will this renew?" from which id happens to be null
    provider_order_id       TEXT,
    -- which of the 14/3/0-day renewal reminders have already gone out, so a sweep
    -- that runs every 5 minutes does not mail the customer every 5 minutes
    reminded_json           TEXT,
    -- A DOWNGRADE THE CUSTOMER HAS ASKED FOR AND NOT YET RECEIVED.
    --
    -- Moving to a cheaper plan takes effect at the next renewal, never immediately,
    -- because an immediate downgrade is broken by construction: somebody on Creator
    -- who has used 30 of 50 minutes and drops to Starter's 10 has minutes_left
    -- clamped to zero, so they would pay for a plan they cannot use.
    --
    -- NULL means nothing is queued. `scheduled_at` is both what the dashboard tells
    -- them ("Starter from 28 September") and what makes applying it idempotent.
    scheduled_plan_code     TEXT REFERENCES plans(code),
    scheduled_at            TEXT,
    -- What the pending change waits for, which is not what its date says. A
    -- `downgrade` waits for the renewal date. An `upgrade` waits for money: the
    -- provider holds the change while the off-session charge is still processing, so
    -- applying one on a timer would hand over the dearer plan without being paid.
    scheduled_kind          TEXT,
    -- The page a plan-change amount still has to be paid on, when the provider collects
    -- by link rather than debiting the saved method. Kept rather than discarded: while
    -- such a link is unpaid the provider refuses any further change, so a customer who
    -- closed the tab would be stuck with no way back to it.
    scheduled_link          TEXT
);
CREATE INDEX IF NOT EXISTS ix_subs_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS payments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id),
    provider_payment_id TEXT NOT NULL UNIQUE,   -- makes a replayed webhook harmless
    amount_paise        INTEGER NOT NULL,       -- negative for a refund
    currency            TEXT NOT NULL DEFAULT 'INR',
    method              TEXT,                   -- upi | card | netbanking
    status              TEXT NOT NULL,          -- 'captured' | 'failed' | 'refunded'
    at                  TEXT NOT NULL,
    plan_code                TEXT,
    provider_order_id        TEXT,
    provider_subscription_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_payments_at ON payments(at);

CREATE TABLE IF NOT EXISTS uploads (
    id                  TEXT PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stored_path         TEXT NOT NULL,
    original_name       TEXT,
    bytes               INTEGER,
    content_type        TEXT,
    -- what ffprobe actually found, never what the client claimed
    probed_duration_s   REAL,
    probed_has_audio    INTEGER,
    probed_codec        TEXT,
    -- 'ready', or 'deleted' once the retention sweep has removed the FILE (worker.ts,
    -- sweepSourceUploads). The row stays, because jobs point at it. Deliberately a
    -- value in an existing column rather than a new column: this schema must stay
    -- identical to the Python backend's, which is the rollback.
    status              TEXT NOT NULL,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id                  TEXT PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    upload_id           TEXT REFERENCES uploads(id),
    source_lang         TEXT,
    target_lang         TEXT NOT NULL,
    state               TEXT NOT NULL,   -- queued|preparing|transcribing|translating|
                                         -- rendering|exporting|done|failed|cancelled
    percent             REAL NOT NULL DEFAULT 0,
    attempts            INTEGER NOT NULL DEFAULT 0,
    -- the engine's own job id. Ours and theirs are kept separate on purpose.
    vs_job_id           TEXT,
    vs_task_id          TEXT,
    preset_version      TEXT,
    preset_sha256       TEXT,
    output_path         TEXT,          -- local disk copy
    output_r2_key       TEXT,          -- object key in Cloudflare R2, when enabled
    output_bytes        INTEGER,
    minutes_quoted      REAL,
    download_count      INTEGER NOT NULL DEFAULT 0,
    error_code          TEXT,
    error_detail        TEXT,
    origin              TEXT NOT NULL DEFAULT 'customer',  -- 'customer' | 'admin'
    billable            INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    queued_at           TEXT,
    started_at          TEXT,
    finished_at         TEXT,
    output_expires_at   TEXT,
    first_downloaded_at TEXT,
    output_deleted_at   TEXT,
    output_deleted_by   TEXT,             -- 'expiry' | 'user' | 'account_closure'
    -- stamped once, so a retry or a restart cannot email the customer twice
    notified_done_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS ix_jobs_state ON jobs(state);

-- The system of record for the transcript and the translation. The dashboard and
-- the admin panel read from here; nothing ever queries the engine.
CREATE TABLE IF NOT EXISTS job_segments (
    job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    seg_id          TEXT NOT NULL,      -- the engine's stable id, e.g. c000
    ordinal         INTEGER NOT NULL,
    start_s         REAL,
    end_s           REAL,
    speaker_label   TEXT,
    profile_id      TEXT,
    source_text     TEXT,
    translated_text TEXT,
    slot_seconds    REAL,
    fit_status      TEXT,
    PRIMARY KEY (job_id, seg_id)
);

CREATE TABLE IF NOT EXISTS job_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    at          TEXT NOT NULL,
    state       TEXT,
    percent     REAL,
    detail      TEXT,
    vs_seq      INTEGER,
    -- 1 = operator-only, never served to the customer. Machine states and addresses,
    -- container starts, object-storage keys, engine errors, segment ids. The customer's
    -- timeline says uploading, transcribing, translating and nothing about how any of
    -- it is built. See db.add_event.
    internal    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_events_job ON job_events(job_id, id);
-- The index over `internal` is NOT here. It is in db._MIGRATION_INDEXES, because
-- `internal` is also a migrated column and is therefore absent when this file runs
-- against a database that already has a job_events table - an index over a column that
-- does not exist yet aborts the whole script and leaves the rest of the schema
-- unapplied. The note above that list has the full reasoning.

CREATE TABLE IF NOT EXISTS job_artifacts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,
    payload TEXT NOT NULL,
    at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_artifacts_job ON job_artifacts(job_id);

-- APPEND-ONLY. Quota is SUM(minutes_charged), never a decrementing counter, so a
-- refund is a compensating row and the original charge is never touched (plan 3.2).
CREATE TABLE IF NOT EXISTS usage_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    job_id          TEXT REFERENCES jobs(id),
    minutes_charged REAL NOT NULL,       -- negative for a refund
    kind            TEXT NOT NULL,       -- 'charge' | 'refund'
    admin_user_id   INTEGER REFERENCES users(id),
    note            TEXT,
    at              TEXT NOT NULL,
    -- HOW MUCH OF THIS ROW CAME OUT OF THE TOP-UP BALANCE, rather than the plan's
    -- monthly allowance. Never larger than `minutes_charged`, same sign as it.
    --
    -- WHY IT HAS TO BE RECORDED AND CANNOT BE DERIVED. Plan minutes are a window
    -- ("charges since current_period_start") and top-up minutes are not a window at
    -- all - they sit still until spent. Working out after the fact which of the two a
    -- given charge drew on would mean replaying every period boundary the account has
    -- ever crossed, and `current_period_start` is overwritten on each renewal, so those
    -- boundaries no longer exist. Writing the split at charge time is the only version
    -- of this that survives a renewal.
    --
    -- Also in _MIGRATIONS: existing rows become 0.0, which is exactly right - they were
    -- all charged before top-ups existed, so every one of them was plan minutes.
    topup_minutes   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_ledger_user ON usage_ledger(user_id);

-- Minutes bought on top of a plan, one row per purchase. APPEND-ONLY like the ledger:
-- spending one does not touch its row, it writes `topup_minutes` on a usage_ledger row,
-- and the balance is the difference. Nothing here is ever a decrementing counter.
--
-- SUBSCRIBERS ONLY, AND THAT IS THE WHOLE POINT OF THE FEATURE. A top-up is an
-- adjustment to a plan you are already on, not a way to buy minutes without one - so
-- `voided_at` is set when a subscription lapses and the balance reads zero while there is
-- no active subscription. Both, deliberately: the read makes a lapse take effect the
-- instant it happens, and the write makes it permanent so resubscribing months later
-- does not resurrect minutes that were paid for under a plan that ended.
CREATE TABLE IF NOT EXISTS minute_topups (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id),
    pack_code           TEXT NOT NULL,
    minutes             REAL NOT NULL,
    amount_paise        INTEGER NOT NULL DEFAULT 0,
    provider            TEXT,
    -- The idempotency handle. One payment grants one pack, however many times the
    -- provider delivers the webhook.
    provider_payment_id TEXT,
    at                  TEXT NOT NULL,
    voided_at           TEXT,
    void_reason         TEXT
);
CREATE INDEX IF NOT EXISTS ix_topups_user ON minute_topups(user_id, voided_at);
-- UNIQUE with NULLs allowed, same as ux_users_google_sub: a manual grant may have no
-- payment id, but no two rows may claim the same one.
CREATE UNIQUE INDEX IF NOT EXISTS ux_topups_payment
    ON minute_topups(provider_payment_id);

-- APPEND-ONLY. Two of the admin actions move money; this is how "why does this
-- account have Pro without paying" stays answerable (plan 10.2).
CREATE TABLE IF NOT EXISTS admin_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              TEXT NOT NULL,
    admin_user_id   INTEGER NOT NULL REFERENCES users(id),
    action          TEXT NOT NULL,
    target_user_id  INTEGER,
    target_job_id   TEXT,
    before_json     TEXT,
    after_json      TEXT,
    reason          TEXT,
    ip              TEXT
);

CREATE TABLE IF NOT EXISTS gpu_state (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id             TEXT,
    desired_state           TEXT,
    last_seen_running_at    TEXT,
    last_work_finished_at   TEXT,
    updated_at              TEXT
);

-- ── Billing and notification tables ──────────────────────────────────────────
-- These were once created imperatively at startup, which meant the schema FILE
-- did not describe the whole database. That is fine until an archive is restored
-- from this file and four tables are simply absent. The schema travels as source
-- (plan 11.1), so it has to be the whole truth; billing.ensure_tables() and
-- notify.ensure_tables() remain as idempotent safety nets for databases created
-- before this.

-- The idempotency record. `event_id` UNIQUE is what makes a replayed webhook
-- harmless: Razorpay retries, and a retry must be free.
CREATE TABLE IF NOT EXISTS webhook_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider        TEXT NOT NULL,
    event_id        TEXT NOT NULL UNIQUE,
    event_type      TEXT,
    at              TEXT NOT NULL,
    signature_ok    INTEGER NOT NULL,
    handled         INTEGER NOT NULL DEFAULT 0,
    result          TEXT,
    payload         TEXT
);

-- Every webhook we REFUSED, and why. Kept beside the accepted ones because a run
-- of signature failures is either a bad secret or somebody probing, and neither
-- is visible if the only record is a log line that rotated away.
CREATE TABLE IF NOT EXISTS webhook_rejects (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    ip      TEXT,
    why     TEXT,
    bytes   INTEGER,
    head    TEXT
);

CREATE TABLE IF NOT EXISTS checkout_sessions (
    id                       TEXT PRIMARY KEY,
    user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_code                TEXT NOT NULL,
    provider                 TEXT NOT NULL,
    mode                     TEXT NOT NULL,   -- 'order' | 'subscription'
    provider_order_id        TEXT,
    provider_subscription_id TEXT,
    amount_paise             INTEGER NOT NULL,
    status                   TEXT NOT NULL,   -- 'created' | 'paid' | 'failed'
    created_at               TEXT NOT NULL,
    completed_at             TEXT,

    -- WHY THE LAST ATTEMPT FAILED. The provider's own code, plus their sentence, kept for the
    -- operator.
    --
    -- These exist because the reason was being thrown away. Every failure reached the customer
    -- as the same words - "no money was taken, you can try again" - which is right for a
    -- declined card and wrong for a failure on the provider's side, where retrying the same
    -- card does exactly the same thing. A customer following that advice spends attempts until
    -- the rate limiter locks them out of paying us at all.
    --
    -- What the customer is shown is DERIVED from the code by `billing.failure_advice`, never
    -- copied from `failure_message`: their wording describes their infrastructure, and nothing
    -- a customer reads is allowed to.
    failure_code             TEXT,
    failure_message          TEXT
);
CREATE INDEX IF NOT EXISTS ix_checkout_user ON checkout_sessions(user_id);

-- Every message sent, so "did we tell them?" is a query rather than a guess.
CREATE TABLE IF NOT EXISTS emails (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    to_email    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    subject     TEXT,
    body        TEXT,
    backend     TEXT,
    ok          INTEGER,
    error       TEXT,
    user_id     INTEGER,
    job_id      TEXT
);
CREATE INDEX IF NOT EXISTS ix_emails_at ON emails(at);

-- ══════════════════════════════════════════════════════════════════════════════
-- DPDP Act 2023 tables
--
-- Added on branch compliance/dpdp. See DPDP_PROGRESS.md for the audit these came
-- out of. Three tables, and each one exists because a boolean could not have
-- answered the question it has to answer.
-- ══════════════════════════════════════════════════════════════════════════════

-- APPEND-ONLY, and that is the whole point (decision D-4).
--
-- A `marketing_ok` boolean on `users` can tell you the current state and nothing
-- else. DPDP s.6 requires you to be able to show WHAT was agreed to, WHEN, and
-- against which version of the notice — and s.6(4)/(6) give the principal the right
-- to withdraw, which means the history matters as much as the present.
--
-- So consent is a ledger, exactly like usage_ledger: withdrawal is a NEW row with
-- granted=0, never an UPDATE. The current state is the latest row per (user,
-- purpose). An UPDATE would destroy the evidence that consent ever existed, which
-- is the evidence you need if it is ever disputed.
CREATE TABLE IF NOT EXISTS consent_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    -- NULL user_id is legitimate: consent captured at the point of collection,
    -- before the account row exists. Linked by email in that window.
    email           TEXT,
    purpose         TEXT NOT NULL,   -- see consent.PURPOSES; one row per purpose
    granted         INTEGER NOT NULL,-- 1 = given, 0 = withdrawn
    notice_version  TEXT NOT NULL,   -- which Privacy Notice they were shown
    -- How it was collected, so "they ticked a box" can be distinguished from
    -- "they accepted the terms" later — the difference between strong and weak
    -- evidence. Allowlisted in consent.METHODS:
    --   'terms_acceptance' | 'settings' | 'banner' | 'checkbox' | 'api' | 'admin'
    method          TEXT NOT NULL DEFAULT 'terms_acceptance',
    at              TEXT NOT NULL,
    ip              TEXT,
    user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS ix_consent_user ON consent_records(user_id, purpose, id);
CREATE INDEX IF NOT EXISTS ix_consent_email ON consent_records(email);

-- Messages from the Contact form, and every data-rights request.
--
-- Deliberately ONE table rather than two. A rights request that arrives as a plain
-- contact message is still a rights request and still starts the statutory clock;
-- splitting them into separate tables would make it possible to answer one inbox
-- and not the other. `kind` distinguishes them, `due_at` is only set for the ones
-- that have a deadline.
CREATE TABLE IF NOT EXISTS inbox_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 'contact'  a general enquiry
    -- 'access' | 'correction' | 'erasure' | 'withdraw' | 'grievance'
    --            a DPDP right being exercised (ss.11-13) or a grievance (s.13)
    kind            TEXT NOT NULL,
    -- Set when the sender was signed in. NULL for an anonymous contact form, which
    -- is why `email` is stored alongside rather than only referenced.
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email           TEXT NOT NULL,
    name            TEXT,
    subject         TEXT,
    body            TEXT NOT NULL,
    -- 'new' | 'in_progress' | 'resolved' | 'rejected'
    status          TEXT NOT NULL DEFAULT 'new',
    -- The statutory clock (decision D-5). NULL for a general enquiry, which has no
    -- deadline; set for every rights request so the admin dashboard can show what
    -- is running out of time. LEGAL REVIEW: 30 days is a working default.
    due_at          TEXT,
    at              TEXT NOT NULL,
    ip              TEXT,
    user_agent      TEXT,
    -- Filled when an admin acts. `handled_note` is the record of WHAT was done,
    -- because "resolved" on its own does not survive a regulator asking how.
    handled_at      TEXT,
    handled_by      INTEGER REFERENCES users(id),
    handled_note    TEXT
);
CREATE INDEX IF NOT EXISTS ix_inbox_status ON inbox_messages(status, at);
CREATE INDEX IF NOT EXISTS ix_inbox_due ON inbox_messages(due_at);

-- Which admin READ whose personal data (FINDING-6).
--
-- `admin_audit` covers every admin write and no admin read. But the admin surface
-- includes endpoints that return every user's email, IP and User-Agent, every email
-- body ever sent, and an arbitrary-SELECT database browser. Under DPDP s.8(5) the
-- fiduciary must be able to account for access to personal data, and "we log
-- changes" does not cover somebody reading the whole users table.
--
-- Kept separate from admin_audit rather than merged: reads are high-volume and
-- writes are rare, and mixing them would bury the twelve rows that move money in
-- ten thousand that do not.
CREATE TABLE IF NOT EXISTS admin_access_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              TEXT NOT NULL,
    admin_user_id   INTEGER NOT NULL REFERENCES users(id),
    -- What was looked at, e.g. 'admin.sessions', 'admin.mail', 'db.query'
    surface         TEXT NOT NULL,
    -- Which principal's data, when the read was scoped to one
    target_user_id  INTEGER,
    -- How many rows came back, so a browse can be told from a bulk pull
    rows_returned   INTEGER,
    detail          TEXT,
    ip              TEXT
);
CREATE INDEX IF NOT EXISTS ix_access_at ON admin_access_log(at);
CREATE INDEX IF NOT EXISTS ix_access_admin ON admin_access_log(admin_user_id, at);

-- Runtime settings an ADMIN can change without a deploy.
--
-- Deliberately a key/value table rather than a column on a singleton row like
-- `gpu_state`. The difference matters for the one thing stored here today —
-- maintenance mode — because the reason it is on is as important as the fact that it
-- is: "we are migrating the database, back in 20 minutes" is what the public page
-- shows, and a boolean column has nowhere to put that.
--
-- Every write records WHO and WHEN. Turning the whole site off is the single most
-- disruptive button in the admin panel, and "the site was down for an hour" needs to
-- be answerable with a name and a timestamp rather than a shrug.
--
-- Values are TEXT and the caller parses. A typed column per setting would mean a
-- migration for every new one, which is exactly the friction this table exists to
-- remove.
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT NOT NULL,
    updated_by  INTEGER REFERENCES users(id)
);
