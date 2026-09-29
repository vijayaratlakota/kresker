-- PostgreSQL schema. The production target (plan section 7: "PostgreSQL on
-- Amazon RDS") and the reason a move between AWS accounts is pg_dump / pg_restore
-- rather than a project.
--
-- Kept beside app/schema.sql and held to it by _test_portability.py, which
-- compares the two table by table and column by column. They cannot drift
-- silently: adding a column to one and not the other fails the test.
--
-- THREE DELIBERATE CHOICES, because each one looks wrong until you see why:
--
-- 1. Timestamps are TEXT, not TIMESTAMPTZ. Every time value in this application is
--    a UTC ISO-8601 string with second precision, written by one function
--    (db.now()). Ordering and range comparison on that format are identical to
--    ordering on the instant, so `expires_at <= ?` behaves the same in both
--    engines. Switching to TIMESTAMPTZ would be more idiomatic and would change
--    the semantics of every comparison in the codebase at the same time. That is
--    a separate change, made deliberately, not smuggled in during a migration.
--
-- 2. Booleans are INTEGER, not BOOLEAN. The export archive carries 0 and 1, and
--    the application treats them as 0 and 1 throughout. Keeping the type means the
--    restore is a plain INSERT rather than a cast, and a cast that goes wrong
--    silently inverts a flag like `billable`.
--
-- 3. REAL becomes DOUBLE PRECISION. SQLite's REAL already IS a 64-bit float, so
--    Postgres REAL (32-bit) would quietly lose precision on the minute ledger.
--    Money is stored in paise as an integer and is not affected either way, but
--    minutes are fractional and are summed.

CREATE TABLE IF NOT EXISTS users (
    id                 BIGSERIAL PRIMARY KEY,
    email              TEXT NOT NULL UNIQUE,
    password_hash      TEXT NOT NULL,
    role               TEXT NOT NULL DEFAULT 'user',
    created_at         TEXT NOT NULL,
    free_trial_used_at TEXT,
    reset_token_sha256 TEXT,
    reset_expires_at   TEXT,
    -- email confirmation; see the SQLite schema for why an unconfirmed account
    -- cannot upload
    email_verified_at   TEXT,
    verify_token_sha256 TEXT,
    verify_expires_at   TEXT,
    -- Google's `sub`, the stable id for one Google account; NULL for a password
    -- account. See the SQLite schema for why the address is not the join key.
    google_sub          TEXT,
    -- The canonical form of `email` (app/emails.normalise): one value per real inbox,
    -- so Gmail dots and +tags cannot buy a second free plan. See the SQLite schema for
    -- why `email` keeps the address as typed.
    email_normalised    TEXT,
    -- Captured at registration because `sessions.ip` only exists after a first login,
    -- and neither can be reconstructed later. Also what the durable per-IP
    -- account-creation ceiling counts.
    signup_ip           TEXT,
    signup_user_agent   TEXT,
    -- 'active' | 'suspended'. Separate from role='erased', which is an irreversible
    -- DPDP tombstone and therefore no way to stop an abusive account.
    status              TEXT NOT NULL DEFAULT 'active',
    -- 1 = may start a checkout, 0 = may not. Narrower than `status`: it stops the money
    -- and nothing else, which is what a disputed charge wants and a suspension does not.
    can_purchase        INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_google_sub ON users(google_sub);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_normalised ON users(email_normalised);
-- Answers "how many accounts came from this address, and when" in one index scan,
-- which is both the signup ceiling's query and the admin abuse view's.
CREATE INDEX IF NOT EXISTS ix_users_signup_ip ON users(signup_ip, created_at);

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_sha256 TEXT NOT NULL,
    csrf         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS plans (
    code                  TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    interval              TEXT NOT NULL,
    price_paise           BIGINT NOT NULL,
    minutes_per_period    DOUBLE PRECISION NOT NULL,
    max_video_seconds     BIGINT NOT NULL,
    output_retention_days DOUBLE PRECISION NOT NULL,
    active                INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id                       BIGSERIAL PRIMARY KEY,
    user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_code                TEXT NOT NULL REFERENCES plans(code),
    provider                 TEXT NOT NULL,
    provider_subscription_id TEXT,
    status                   TEXT NOT NULL,
    current_period_start     TEXT NOT NULL,
    current_period_end       TEXT NOT NULL,
    grace_until              TEXT,
    auto_renew               INTEGER NOT NULL DEFAULT 0,
    cancel_at                TEXT,
    created_at               TEXT NOT NULL,
    provider_order_id        TEXT,
    reminded_json            TEXT,
    -- A downgrade the customer has asked for and not yet received. It takes effect at
    -- the next renewal, never immediately: dropping from Creator's 50 minutes to
    -- Starter's 10 having already used 30 would clamp minutes_left to zero, so they
    -- would be paying for a plan they cannot use. NULL means nothing is queued.
    scheduled_plan_code      TEXT REFERENCES plans(code),
    scheduled_at             TEXT,
    -- What the pending change waits for: a `downgrade` waits for the renewal date, an
    -- `upgrade` waits for money, because the provider holds the change while the
    -- off-session charge is still processing.
    scheduled_kind           TEXT,
    -- The page a plan-change amount still has to be paid on, when the provider collects
    -- by link. Kept because an unpaid link blocks every further change, so discarding it
    -- would leave the customer with no way back to it.
    scheduled_link           TEXT
);
CREATE INDEX IF NOT EXISTS ix_subs_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS payments (
    id                       BIGSERIAL PRIMARY KEY,
    user_id                  BIGINT NOT NULL REFERENCES users(id),
    provider_payment_id      TEXT NOT NULL UNIQUE,
    amount_paise             BIGINT NOT NULL,
    currency                 TEXT NOT NULL DEFAULT 'INR',
    method                   TEXT,
    status                   TEXT NOT NULL,
    at                       TEXT NOT NULL,
    plan_code                TEXT,
    provider_order_id        TEXT,
    provider_subscription_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_payments_at ON payments(at);

CREATE TABLE IF NOT EXISTS uploads (
    id                TEXT PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- relative to the data directory. NEVER an absolute path: see app/paths.py
    stored_path       TEXT NOT NULL,
    original_name     TEXT,
    bytes             BIGINT,
    content_type      TEXT,
    probed_duration_s DOUBLE PRECISION,
    probed_has_audio  INTEGER,
    probed_codec      TEXT,
    status            TEXT NOT NULL,
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id                  TEXT PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    upload_id           TEXT REFERENCES uploads(id),
    source_lang         TEXT,
    target_lang         TEXT NOT NULL,
    state               TEXT NOT NULL,
    percent             DOUBLE PRECISION NOT NULL DEFAULT 0,
    attempts            INTEGER NOT NULL DEFAULT 0,
    vs_job_id           TEXT,
    vs_task_id          TEXT,
    preset_version      TEXT,
    preset_sha256       TEXT,
    output_path         TEXT,
    output_r2_key       TEXT,
    output_bytes        BIGINT,
    minutes_quoted      DOUBLE PRECISION,
    download_count      INTEGER NOT NULL DEFAULT 0,
    error_code          TEXT,
    error_detail        TEXT,
    origin              TEXT NOT NULL DEFAULT 'customer',
    billable            INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    queued_at           TEXT,
    started_at          TEXT,
    finished_at         TEXT,
    output_expires_at   TEXT,
    first_downloaded_at TEXT,
    output_deleted_at   TEXT,
    output_deleted_by   TEXT,
    notified_done_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS ix_jobs_state ON jobs(state);

-- On Postgres this is where the queue is claimed with
--   SELECT id FROM jobs WHERE state='queued' ORDER BY queued_at
--   FOR UPDATE SKIP LOCKED LIMIT 1
-- which is the construct SQLite has no equivalent for. See app/worker.py: locally
-- a process-wide lock plus a guarded UPDATE gives the same single-worker
-- guarantee, and only multi-worker contention behaves differently.

CREATE TABLE IF NOT EXISTS job_segments (
    job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    seg_id          TEXT NOT NULL,
    ordinal         INTEGER NOT NULL,
    start_s         DOUBLE PRECISION,
    end_s           DOUBLE PRECISION,
    speaker_label   TEXT,
    profile_id      TEXT,
    source_text     TEXT,
    translated_text TEXT,
    slot_seconds    DOUBLE PRECISION,
    fit_status      TEXT,
    PRIMARY KEY (job_id, seg_id)
);

CREATE TABLE IF NOT EXISTS job_events (
    id      BIGSERIAL PRIMARY KEY,
    job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    at      TEXT NOT NULL,
    state   TEXT,
    percent DOUBLE PRECISION,
    detail  TEXT,
    vs_seq  BIGINT,
    -- 1 = operator-only, never served to the customer. See db.add_event.
    internal INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_events_job ON job_events(job_id, id);
CREATE INDEX IF NOT EXISTS ix_events_job_visible
    ON job_events(job_id, internal, id);

CREATE TABLE IF NOT EXISTS job_artifacts (
    id      BIGSERIAL PRIMARY KEY,
    job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,
    payload TEXT NOT NULL,
    at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_artifacts_job ON job_artifacts(job_id);

-- APPEND-ONLY. Quota is SUM(minutes_charged), never a decrementing counter, so a
-- refund is a compensating row and the original charge is never touched.
CREATE TABLE IF NOT EXISTS usage_ledger (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    job_id          TEXT REFERENCES jobs(id),
    minutes_charged DOUBLE PRECISION NOT NULL,
    kind            TEXT NOT NULL,
    admin_user_id   BIGINT REFERENCES users(id),
    note            TEXT,
    at              TEXT NOT NULL,
    -- How much of this row came out of the top-up balance rather than the plan's monthly
    -- allowance. Written at charge time because it cannot be derived afterwards: plan
    -- minutes are a window on `current_period_start`, and a renewal overwrites it.
    topup_minutes   DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_ledger_user ON usage_ledger(user_id);

-- Minutes bought on top of a plan, one row per purchase. APPEND-ONLY like the ledger:
-- spending one writes `usage_ledger.topup_minutes`, and the balance is the difference.
-- `voided_at` is set when a subscription lapses - a top-up adjusts a plan, so it cannot
-- outlive one.
CREATE TABLE IF NOT EXISTS minute_topups (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id),
    pack_code           TEXT NOT NULL,
    minutes             DOUBLE PRECISION NOT NULL,
    amount_paise        BIGINT NOT NULL DEFAULT 0,
    provider            TEXT,
    provider_payment_id TEXT,
    at                  TEXT NOT NULL,
    voided_at           TEXT,
    void_reason         TEXT
);
CREATE INDEX IF NOT EXISTS ix_topups_user ON minute_topups(user_id, voided_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_topups_payment
    ON minute_topups(provider_payment_id);

-- APPEND-ONLY.
CREATE TABLE IF NOT EXISTS admin_audit (
    id             BIGSERIAL PRIMARY KEY,
    at             TEXT NOT NULL,
    admin_user_id  BIGINT NOT NULL REFERENCES users(id),
    action         TEXT NOT NULL,
    target_user_id BIGINT,
    target_job_id  TEXT,
    before_json    TEXT,
    after_json     TEXT,
    reason         TEXT,
    ip             TEXT
);

CREATE TABLE IF NOT EXISTS gpu_state (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id           TEXT,
    desired_state         TEXT,
    last_seen_running_at  TEXT,
    last_work_finished_at TEXT,
    updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS webhook_events (
    id           BIGSERIAL PRIMARY KEY,
    provider     TEXT NOT NULL,
    event_id     TEXT NOT NULL UNIQUE,
    event_type   TEXT,
    at           TEXT NOT NULL,
    signature_ok INTEGER NOT NULL,
    handled      INTEGER NOT NULL DEFAULT 0,
    result       TEXT,
    payload      TEXT
);

CREATE TABLE IF NOT EXISTS webhook_rejects (
    id    BIGSERIAL PRIMARY KEY,
    at    TEXT NOT NULL,
    ip    TEXT,
    why   TEXT,
    bytes BIGINT,
    head  TEXT
);

CREATE TABLE IF NOT EXISTS checkout_sessions (
    id                       TEXT PRIMARY KEY,
    user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_code                TEXT NOT NULL,
    provider                 TEXT NOT NULL,
    mode                     TEXT NOT NULL,
    provider_order_id        TEXT,
    provider_subscription_id TEXT,
    amount_paise             BIGINT NOT NULL,
    status                   TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    completed_at             TEXT,
    -- Why the last attempt failed: the provider's code and sentence, for the operator. What the
    -- customer is shown is derived from the code by billing.failure_advice, never copied from
    -- the message - their wording describes their infrastructure.
    failure_code             TEXT,
    failure_message          TEXT
);
CREATE INDEX IF NOT EXISTS ix_checkout_user ON checkout_sessions(user_id);

CREATE TABLE IF NOT EXISTS emails (
    id       BIGSERIAL PRIMARY KEY,
    at       TEXT NOT NULL,
    to_email TEXT NOT NULL,
    kind     TEXT NOT NULL,
    subject  TEXT,
    body     TEXT,
    backend  TEXT,
    ok       INTEGER,
    error    TEXT,
    user_id  BIGINT,
    job_id   TEXT
);
CREATE INDEX IF NOT EXISTS ix_emails_at ON emails(at);

-- ── DPDP Act 2023 ────────────────────────────────────────────────────────────
-- Mirrors of the three tables added on branch compliance/dpdp. The reasoning for
-- each one lives beside its SQLite twin in schema.sql; only the type mapping
-- differs here. APPEND-ONLY, all three: consent withdrawal is a new row, an admin
-- read is a new row, and neither is ever updated.

CREATE TABLE IF NOT EXISTS consent_records (
    id             BIGSERIAL PRIMARY KEY,
    user_id        BIGINT REFERENCES users(id) ON DELETE CASCADE,
    email          TEXT,
    purpose        TEXT NOT NULL,
    granted        INTEGER NOT NULL,
    notice_version TEXT NOT NULL,
    method         TEXT NOT NULL DEFAULT 'terms_acceptance',
    at             TEXT NOT NULL,
    ip             TEXT,
    user_agent     TEXT
);
CREATE INDEX IF NOT EXISTS ix_consent_user ON consent_records(user_id, purpose, id);
CREATE INDEX IF NOT EXISTS ix_consent_email ON consent_records(email);

CREATE TABLE IF NOT EXISTS inbox_messages (
    id           BIGSERIAL PRIMARY KEY,
    kind         TEXT NOT NULL,
    user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    email        TEXT NOT NULL,
    name         TEXT,
    subject      TEXT,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'new',
    due_at       TEXT,
    at           TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    handled_at   TEXT,
    handled_by   BIGINT REFERENCES users(id),
    handled_note TEXT
);
CREATE INDEX IF NOT EXISTS ix_inbox_status ON inbox_messages(status, at);
CREATE INDEX IF NOT EXISTS ix_inbox_due ON inbox_messages(due_at);

CREATE TABLE IF NOT EXISTS admin_access_log (
    id             BIGSERIAL PRIMARY KEY,
    at             TEXT NOT NULL,
    admin_user_id  BIGINT NOT NULL REFERENCES users(id),
    surface        TEXT NOT NULL,
    target_user_id BIGINT,
    rows_returned  INTEGER,
    detail         TEXT,
    ip             TEXT
);
CREATE INDEX IF NOT EXISTS ix_access_at ON admin_access_log(at);
CREATE INDEX IF NOT EXISTS ix_access_admin ON admin_access_log(admin_user_id, at);

-- After a restore, reset every sequence past the highest id that came across.
-- Skipping this is the classic pg_restore footgun: the first insert collides with
-- an existing primary key and the API starts returning 500 for no visible reason.
--
--   SELECT setval(pg_get_serial_sequence('users','id'),
--                 COALESCE((SELECT MAX(id) FROM users), 1));
-- ... and the same for subscriptions, payments, job_events, job_artifacts,
--     usage_ledger, admin_audit, webhook_events, webhook_rejects, emails,
--     consent_records, inbox_messages, admin_access_log.

-- Runtime settings an admin can change without a deploy. See the note beside its
-- SQLite twin in schema.sql for why this is key/value rather than typed columns.
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL,
    updated_by BIGINT REFERENCES users(id)
);
