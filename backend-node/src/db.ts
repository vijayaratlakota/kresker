/**
 * SQLite access. Deliberately plain SQL rather than an ORM.
 *
 * The queue and ledger semantics are specific enough that hand-written SQL is clearer
 * about what actually happens than a mapper would be — and the SQL is the same SQL the
 * Python backend runs, against the same file, so the two can be swapped under a live
 * database without a migration.
 *
 * ── HOW THIS DIFFERS FROM THE PYTHON VERSION, AND WHY IT IS SAFE ─────────────
 *
 * Python kept one connection per thread and serialised writes through a process-wide
 * lock, because FastAPI runs requests on a thread pool. Node runs every request on one
 * thread, so there is ONE connection and nothing can interleave inside a synchronous
 * call. `better-sqlite3` is synchronous by design, which is exactly the property the
 * lock existed to provide.
 *
 * The rule that follows: A TRANSACTION MUST NEVER SPAN AN `await`. `transaction(fn)`
 * takes a synchronous function and TypeScript enforces it — a callback that returned a
 * promise would commit before its work ran.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DB_PATH, NODE_ROOT } from './config';
import { normalise } from './emails';
import * as paths from './paths';
import { PyFloat, fmtStamp, pyRound, pyStrip } from './py';

export type Row = Record<string, any>;
export type Params = unknown[];

let conn: Database.Database | null = null;
const cache = new Map<string, Database.Statement>();

/** UTC, ISO-8601, second precision. One format everywhere, so string order is time order. */
export function now(): string {
  return fmtStamp(new Date());
}

/** The one connection, opened on first use with the same pragmas Python sets. */
export function connect(): Database.Database {
  if (conn) return conn;
  const c = new Database(DB_PATH, { timeout: 30_000 });
  c.pragma('journal_mode = WAL');
  c.pragma('foreign_keys = ON');
  c.pragma('busy_timeout = 30000');
  // Python's sqlite3 runs with SQLite's default durability (FULL). better-sqlite3 is
  // built to default WAL databases to NORMAL, which can lose the last transactions on a
  // power cut. The ledger and the payments table are not the place to find that out.
  c.pragma('synchronous = FULL');
  conn = c;
  return c;
}

/** Close the connection (for tests and clean shutdown). */
export function close(): void {
  if (conn) {
    conn.close();
    conn = null;
    cache.clear();
  }
}

function stmt(sql: string): Database.Statement {
  let s = cache.get(sql);
  if (!s) {
    s = connect().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

/**
 * Parameters, bound the way Python's sqlite3 binds them.
 *
 * Python binds an `int` as INTEGER and a `float` as REAL. better-sqlite3 binds EVERY
 * JavaScript number as REAL, which is invisible in a typed column but not elsewhere: a
 * whole number written into a TEXT column is stored as "15.0" instead of "15", and into
 * an untyped column as a REAL that Python then reads back as 15.0. Since both backends
 * share this file, integral numbers are bound as INTEGER here, and a value that Python
 * held as a float is marked with PyFloat and bound as REAL.
 *
 * Also: True is 1, and there is no `undefined` in Python.
 */
function bind(params: Iterable<unknown>): unknown[] {
  const out: unknown[] = [];
  for (const p of params) {
    if (p === undefined) out.push(null);
    else if (p === true) out.push(1n);
    else if (p === false) out.push(0n);
    else if (p instanceof PyFloat) out.push(Number.isFinite(p.v) ? p.v : null);
    else if (typeof p === 'number') {
      if (!Number.isFinite(p)) out.push(null);
      else if (Object.is(p, -0)) out.push(p); // -0.0 is a float in Python too
      else if (Number.isSafeInteger(p)) out.push(BigInt(p));
      else out.push(p);
    } else out.push(p);
  }
  return out;
}

export function query<T extends Row = Row>(sql: string, params: Iterable<unknown> = []): T[] {
  return stmt(sql).all(...bind(params)) as T[];
}

export function one<T extends Row = Row>(sql: string, params: Iterable<unknown> = []): T | null {
  return (stmt(sql).get(...bind(params)) as T | undefined) ?? null;
}

/** The first column of the first row, or `dflt` when there is no row or it is NULL. */
export function scalar<T = any>(sql: string, params: Iterable<unknown> = [], dflt: T | null = null): T {
  const s = stmt(sql);
  const row = s.raw(true).get(...bind(params)) as unknown[] | undefined;
  s.raw(false);
  if (!row) return dflt as T;
  const v = row[0];
  return (v === null || v === undefined ? dflt : v) as T;
}

export interface ExecResult {
  /** cursor.rowcount */
  rowcount: number;
  /** cursor.lastrowid */
  lastrowid: number;
}

/** One write. A statement that returns rows (a PRAGMA, say) is run and its rows dropped. */
export function execute(sql: string, params: Iterable<unknown> = []): ExecResult {
  const s = stmt(sql);
  if (s.reader) {
    s.all(...bind(params));
    return { rowcount: -1, lastrowid: 0 };
  }
  const r = s.run(...bind(params));
  return { rowcount: r.changes, lastrowid: Number(r.lastInsertRowid) };
}

/**
 * The same statement for many rows, atomically.
 *
 * Python's version ran each row as its own implicit transaction. Doing them in one is
 * strictly safer — a crash can no longer leave half a transcript stored — and faster.
 */
export function executemany(sql: string, seq: Iterable<Iterable<unknown>>): void {
  const s = stmt(sql);
  transaction(() => {
    for (const p of seq) s.run(...bind(p));
  });
}

/**
 * A write transaction, `BEGIN IMMEDIATE` like Python's, so the write lock is taken up
 * front rather than discovered halfway through. Nested calls become savepoints.
 */
export function transaction<T>(fn: () => T): T {
  const wrapped = connect().transaction(fn);
  return wrapped.immediate();
}

/** Run a multi-statement script (schema.sql). */
export function exec(sql: string): void {
  connect().exec(sql);
}

/**
 * Every row of a table with each value in the type SQLite actually stored it as:
 * REAL as PyFloat, INTEGER as a number (or a BigInt past 2^53), BLOB as a Buffer.
 *
 * Ordinary reads cannot tell REAL 3.0 from INTEGER 3 — JavaScript has one number type —
 * and for most of the application that does not matter. It matters where rows are
 * written back out as text that has to match what Python writes: the migration archive
 * hashes every row, and a row that says `3` where Python said `3.0` is a different row.
 */
export function tableRowsTyped(table: string): Row[] {
  const cols = [...connect().prepare(`PRAGMA table_info("${table}")`).all()].map((c) => String((c as Row).name));
  if (!cols.length) throw new Error(`no such table: ${table}`);
  const select = cols.map((c) => `"${c}", typeof("${c}")`).join(', ');
  const st = connect().prepare(`SELECT ${select} FROM "${table}"`).raw(true).safeIntegers(true);
  const out: Row[] = [];
  for (const r of st.iterate() as Iterable<unknown[]>) {
    const row: Row = {};
    cols.forEach((c, i) => {
      const v = r[i * 2];
      const t = String(r[i * 2 + 1]);
      if (t === 'real') row[c] = new PyFloat(Number(v));
      else if (t === 'integer') {
        const b = v as bigint;
        row[c] = b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
      } else row[c] = v ?? null;
    });
    out.push(row);
  }
  return out;
}

/** The binding rules above, for code that talks to a second database directly. */
export function bindParams(params: Iterable<unknown>): unknown[] {
  return bind(params);
}

/** Column names of a table, or an empty set if it does not exist. */
export function tableColumns(table: string): Set<string> {
  try {
    const rows = connect().prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

// ANNUAL MINUTES ARE TWELVE TIMES THE MONTHLY FIGURE. Every annual row used to carry the
// monthly allowance while billing gave it a 365-day window — Pro annual sold 120 minutes a
// year for ₹14,390. The prices were right; only the allowance was wrong. Existing
// databases are corrected by fixAnnualAllowance, because these seeds are INSERT OR IGNORE.
export const DEFAULT_PLANS: ReadonlyArray<readonly [string, string, string, number, number, number, number]> = [
  //  code,          name,               interval,   paise, minutes, max video s, retention days
  ['free', 'Free', 'lifetime', 0, 1.0, 60, 1.0],
  ['starter', 'Starter', 'month', 29900, 10.0, 600, 7.0],
  ['creator', 'Creator', 'month', 99900, 50.0, 1800, 7.0],
  ['pro', 'Pro', 'month', 149900, 120.0, 1800, 7.0],
  ['starter_year', 'Starter (annual)', 'year', 287000, 120.0, 600, 7.0],
  ['creator_year', 'Creator (annual)', 'year', 959000, 600.0, 1800, 7.0],
  ['pro_year', 'Pro (annual)', 'year', 1439000, 1440.0, 1800, 7.0],
];

// Columns added after the first databases were created. CREATE TABLE IF NOT EXISTS will
// not add a column to a table that already exists, so they are applied explicitly and
// ignored when already present. Same list, same order, as db.py.
const MIGRATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['jobs', 'output_r2_key', 'TEXT'],
  ['users', 'reset_token_sha256', 'TEXT'],
  ['users', 'reset_expires_at', 'TEXT'],
  ['jobs', 'notified_done_at', 'TEXT'],
  // Email confirmation. NULL means "not confirmed", which is why the backfill matters.
  ['users', 'email_verified_at', 'TEXT'],
  ['users', 'verify_token_sha256', 'TEXT'],
  ['users', 'verify_expires_at', 'TEXT'],
  // Google sign-in. Its UNIQUE index is created below, after the column exists.
  ['users', 'google_sub', 'TEXT'],
  // One value per real inbox. Backfilled and then uniquely indexed, in that order.
  ['users', 'email_normalised', 'TEXT'],
  // Signup signals: not reconstructable after the fact.
  ['users', 'signup_ip', 'TEXT'],
  ['users', 'signup_user_agent', 'TEXT'],
  // 'active' | 'suspended'. NOT NULL with a default, so no reader has to treat NULL.
  ['users', 'status', "TEXT NOT NULL DEFAULT 'active'"],
  // 1 = operator-only event, never served to the customer.
  ['job_events', 'internal', 'INTEGER NOT NULL DEFAULT 0'],
  // How much of a ledger row came out of the top-up balance.
  ['usage_ledger', 'topup_minutes', 'REAL NOT NULL DEFAULT 0'],
  // Why the last attempt on a checkout failed: the provider's code and sentence.
  ['checkout_sessions', 'failure_code', 'TEXT'],
  ['checkout_sessions', 'failure_message', 'TEXT'],
  // 1 = may start a checkout. A narrower lever than suspension.
  ['users', 'can_purchase', 'INTEGER NOT NULL DEFAULT 1'],
  // NOTHING NODE-ONLY GOES HERE. The Python backend is the rollback and reads the same
  // database, and its schema.sql is what a portability restore builds from - a column
  // only this backend knew about would make every archive fail to restore there. (The
  // source-video sweep marks `uploads.status='deleted'` for exactly that reason.)
];

// Indexes over MIGRATED columns, so they cannot live in schema.sql (an index over a
// column that does not exist yet would abort the whole script on an existing database).
const MIGRATION_INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_google_sub ON users(google_sub)',
  // What actually enforces one account per inbox. Created only after the backfill.
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_normalised ON users(email_normalised)',
  'CREATE INDEX IF NOT EXISTS ix_users_signup_ip ON users(signup_ip, created_at)',
  'CREATE INDEX IF NOT EXISTS ix_events_job_visible ON job_events(job_id, internal, id)',
];

/**
 * Give every existing account its canonical inbox value, BEFORE the unique index.
 * Collisions are expected on a real database: the LOWEST id wins the canonical form and
 * any later row keeps its exact address, which is unique because `users.email` is.
 */
function backfillEmailNormalised(): void {
  let rows: Row[];
  try {
    rows = connect()
      .prepare('SELECT id, email FROM users WHERE email_normalised IS NULL ORDER BY id')
      .all() as Row[];
  } catch {
    return;
  }
  if (!rows.length) return;
  let taken: Set<string>;
  try {
    taken = new Set(
      (connect()
        .prepare('SELECT email_normalised FROM users WHERE email_normalised IS NOT NULL')
        .raw(true)
        .all() as unknown[][]).map((r) => String(r[0])),
    );
  } catch {
    taken = new Set();
  }
  const upd = connect().prepare('UPDATE users SET email_normalised=? WHERE id=?');
  for (const row of rows) {
    const uid = row.id;
    const email = row.email || '';
    let canonical = normalise(email);
    if (!canonical || taken.has(canonical)) {
      canonical = pyStrip(email || `user-${uid}@invalid`).toLowerCase();
    }
    taken.add(canonical);
    try {
      upd.run(canonical, uid);
    } catch {
      /* same as Python: a single row that cannot be written is left alone */
    }
  }
}

/**
 * Annual plans get twelve months of minutes — but ONLY on a row that is still exactly
 * wrong (annual == monthly). Anything else was chosen deliberately and is left alone.
 * It can only ever RAISE an allowance.
 */
export function fixAnnualAllowance(): number {
  let fixed = 0;
  let rows: Row[];
  try {
    rows = connect().prepare("SELECT code, minutes_per_period FROM plans WHERE interval='year'").all() as Row[];
  } catch {
    return 0;
  }
  for (const row of rows) {
    const code = String(row.code);
    if (!code.endsWith('_year')) continue;
    const base = code.slice(0, -'_year'.length);
    let m: Row | undefined;
    try {
      m = connect()
        .prepare("SELECT minutes_per_period FROM plans WHERE code=? AND interval='month'")
        .get(base) as Row | undefined;
    } catch {
      continue;
    }
    if (!m) continue;
    const monthly = Number(m.minutes_per_period);
    if (monthly <= 0 || Number(row.minutes_per_period) !== monthly) continue;
    try {
      connect().prepare('UPDATE plans SET minutes_per_period=? WHERE code=?').run(monthly * 12.0, code);
      fixed++;
    } catch {
      /* left alone */
    }
  }
  return fixed;
}

function migrate(): void {
  const added = new Set<string>();
  for (const [table, column, decl] of MIGRATIONS) {
    const cols = tableColumns(table);
    if (!cols.size || cols.has(column)) continue;
    try {
      connect().exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${decl}`);
      added.add(`${table}.${column}`);
    } catch {
      /* already there, or the table is unusual: same tolerance as Python */
    }
  }

  // Accounts that existed before confirmation was required are treated as confirmed,
  // stamped with their own creation time — otherwise the upgrade would lock every
  // existing customer out on the next restart.
  if (added.has('users.email_verified_at')) {
    try {
      connect()
        .prepare('UPDATE users SET email_verified_at = COALESCE(created_at, ?) WHERE email_verified_at IS NULL')
        .run(now());
    } catch {
      /* ignore */
    }
  }

  backfillEmailNormalised();

  for (const s of MIGRATION_INDEXES) {
    try {
      connect().exec(s);
    } catch {
      /* ignore, as Python does */
    }
  }

  migratePaths();
  fixAnnualAllowance();
}

/** (table, column) pairs that record a file location. */
const PATH_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['uploads', 'stored_path'],
  ['jobs', 'output_path'],
];

/** Rewrite absolute file paths into the portable form. Idempotent; runs on every start. */
function migratePaths(): number {
  let fixed = 0;
  for (const [table, column] of PATH_COLUMNS) {
    let rows: Row[];
    try {
      rows = connect()
        .prepare(`SELECT id, "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" != ''`)
        .all() as Row[];
    } catch {
      continue;
    }
    for (const row of rows) {
      const val = String(row.v);
      if (paths.portable(val)) continue;
      const rel = paths.toRelative(val);
      if (!rel) continue; // unrecognisable: the portability report flags it
      try {
        connect().prepare(`UPDATE "${table}" SET "${column}"=? WHERE id=?`).run(rel, row.id);
        fixed++;
      } catch {
        /* left alone */
      }
    }
  }
  if (fixed) console.log(`  paths       : rewrote ${fixed} absolute file path(s) to the portable form`);
  return fixed;
}

/** Any row still recording a machine-specific location. Should always be empty. */
export function unportableRows(): Row[] {
  const out: Row[] = [];
  for (const [table, column] of PATH_COLUMNS) {
    let rows: Row[];
    try {
      rows = query(`SELECT id, "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" != ''`);
    } catch {
      continue;
    }
    for (const r of rows) {
      if (!paths.portable(r.v)) out.push({ table, column, id: r.id, value: r.v });
    }
  }
  return out;
}

/** The schema file shipped with this package, a verified copy of the Python one. */
export const SCHEMA_PATH = path.join(NODE_ROOT, 'sql', 'schema.sql');

/** Create the schema if absent, apply additive migrations, seed the plans. */
export function initDb(): void {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  connect().exec(schema);
  migrate();
  const seed = connect().prepare(
    'INSERT OR IGNORE INTO plans (code, name, interval, price_paise, minutes_per_period,' +
      ' max_video_seconds, output_retention_days, active) VALUES (?,?,?,?,?,?,?,1)',
  );
  for (const row of DEFAULT_PLANS) seed.run(...row);
  connect()
    .prepare("INSERT OR IGNORE INTO gpu_state (id, instance_id, desired_state, updated_at) VALUES (1, NULL, 'unknown', ?)")
    .run(now());
}

// ── quota, computed from the ledger and never from a counter ────────────────

export function minutesUsed(userId: number, since?: string | null): number {
  if (since) {
    return Number(
      scalar('SELECT COALESCE(SUM(minutes_charged),0) FROM usage_ledger WHERE user_id=? AND at>=?', [userId, since], 0),
    );
  }
  return Number(scalar('SELECT COALESCE(SUM(minutes_charged),0) FROM usage_ledger WHERE user_id=?', [userId], 0));
}

/** The live subscription row, honouring the grace period. */
export function activeSubscription(userId: number): Row | null {
  const t = now();
  return one(
    'SELECT s.*, p.name AS plan_name, p.minutes_per_period, p.max_video_seconds,' +
      '       p.output_retention_days' +
      '  FROM subscriptions s JOIN plans p ON p.code = s.plan_code' +
      " WHERE s.user_id = ? AND s.status = 'active'" +
      "   AND (s.current_period_end >= ? OR COALESCE(s.grace_until,'') >= ?)" +
      ' ORDER BY s.id DESC LIMIT 1',
    [userId, t, t],
  );
}

/**
 * Minutes left: never negative, never above the allowance. The ceiling is a guard: a
 * negative ledger total once put a 10-minute plan on 11.4 minutes left.
 */
export function remaining(allowance: number, used: number): number {
  return pyRound(Math.min(allowance, Math.max(0.0, allowance - used)), 3);
}

// ── top-up minutes: bought on top of a plan, not on a monthly clock ─────────

export function topupGranted(userId: number): number {
  return Number(
    scalar('SELECT COALESCE(SUM(minutes),0) FROM minute_topups WHERE user_id=? AND voided_at IS NULL', [userId], 0),
  );
}

/** Minutes taken out of the top-up balance, net of refunds. `since` is for one period only. */
export function topupSpent(userId: number, since?: string | null): number {
  if (since) {
    return Number(
      scalar('SELECT COALESCE(SUM(topup_minutes),0) FROM usage_ledger WHERE user_id=? AND at>=?', [userId, since], 0),
    );
  }
  return Number(scalar('SELECT COALESCE(SUM(topup_minutes),0) FROM usage_ledger WHERE user_id=?', [userId], 0));
}

/** When the CURRENT top-up balance started: the last write-off, or null for all time. */
function topupEra(userId: number): string | null {
  return scalar<string | null>(
    'SELECT MAX(voided_at) FROM minute_topups WHERE user_id=? AND voided_at IS NOT NULL',
    [userId],
    null,
  );
}

/** Top-up minutes available right now. Zero without an active subscription. */
export function topupBalance(userId: number, subscribed?: boolean | null): number {
  const sub = subscribed ?? activeSubscription(userId) !== null;
  if (!sub) return 0.0;
  const granted = topupGranted(userId);
  if (granted <= 0.0) return 0.0;
  const spent = topupSpent(userId, topupEra(userId));
  return pyRound(Math.min(granted, Math.max(0.0, granted - spent)), 3);
}

/**
 * Split one charge into [from the plan, from the top-up balance]. Plan minutes go first
 * (they expire); any overdraft lands on the plan side. A pure function.
 */
export function splitCharge(minutes: number, planLeft: number, topupLeft: number): [number, number] {
  const m = Math.max(0.0, Number(minutes));
  let fromPlan = Math.min(m, Math.max(0.0, Number(planLeft)));
  const fromTopup = Math.min(m - fromPlan, Math.max(0.0, Number(topupLeft)));
  fromPlan += m - fromPlan - fromTopup;
  return [pyRound(fromPlan, 6), pyRound(fromTopup, 6)];
}

/** What one job was charged and credited, and how much of each was top-up. */
export function jobLedgerSplit(jobId: string): Record<string, number> {
  const s = (where: string, col: string): number =>
    Number(scalar(`SELECT COALESCE(SUM(${col}),0) FROM usage_ledger WHERE job_id=? AND ${where}`, [jobId], 0));
  const charged = s("kind='charge'", 'minutes_charged');
  const chargedTopup = s("kind='charge'", 'topup_minutes');
  const credited = Math.abs(s("kind<>'charge'", 'minutes_charged'));
  const creditedTopup = Math.abs(s("kind<>'charge'", 'topup_minutes'));
  const outstanding = charged - credited;
  const outTopup = Math.min(Math.max(0.0, chargedTopup - creditedTopup), Math.max(0.0, outstanding));
  return {
    charged: pyRound(charged, 6),
    charged_topup: pyRound(chargedTopup, 6),
    credited: pyRound(credited, 6),
    credited_topup: pyRound(creditedTopup, 6),
    outstanding: pyRound(outstanding, 6),
    outstanding_topup: pyRound(outTopup, 6),
  };
}

/** Write off every standing top-up row. Writes voided_at rather than deleting. */
export function voidTopups(userId: number, reason: string): number {
  const left = topupBalance(userId, true);
  if (topupGranted(userId) <= 0.0) return 0.0;
  execute('UPDATE minute_topups SET voided_at=?, void_reason=? WHERE user_id=? AND voided_at IS NULL', [
    now(),
    reason,
    userId,
  ]);
  return pyRound(left, 3);
}

export interface Entitlement {
  plan_code: string;
  plan_name: string;
  is_free: boolean;
  minutes_allowance: number;
  minutes_used: number;
  minutes_left: number;
  minutes_plan_left: number;
  minutes_topup_left: number;
  max_video_seconds: number;
  retention_days: number;
  period_end: string | null;
  auto_renew: boolean;
}

/**
 * What this user may do right now. With no subscription, the free plan — a LIFETIME
 * minute, measured against all-time usage. Admins are not special-cased here; the
 * gates skip quota for them, and this reports the plan they actually hold.
 */
export function entitlement(userId: number): Entitlement {
  const sub = activeSubscription(userId);
  if (sub) {
    const used = minutesUsed(userId, sub.current_period_start);
    const allowance = Number(sub.minutes_per_period);
    // The plan is charged for the period's usage less whatever came out of the top-up
    // balance, or a top-up minute would be deducted twice.
    const planUsed = used - topupSpent(userId, sub.current_period_start);
    const planLeft = remaining(allowance, planUsed);
    const topupLeft = topupBalance(userId, true);
    return {
      plan_code: sub.plan_code,
      plan_name: sub.plan_name,
      is_free: false,
      minutes_allowance: allowance,
      minutes_used: pyRound(used, 3),
      minutes_left: pyRound(planLeft + topupLeft, 3),
      minutes_plan_left: planLeft,
      minutes_topup_left: topupLeft,
      max_video_seconds: Math.trunc(Number(sub.max_video_seconds)),
      retention_days: Number(sub.output_retention_days),
      period_end: sub.current_period_end,
      auto_renew: Boolean(sub.auto_renew),
    };
  }
  const plan = one("SELECT * FROM plans WHERE code='free'")!;
  const used = minutesUsed(userId); // all time: the free trial never resets
  const allowance = Number(plan.minutes_per_period);
  const left = remaining(allowance, used);
  return {
    plan_code: 'free',
    plan_name: 'Free',
    is_free: true,
    minutes_allowance: allowance,
    minutes_used: pyRound(used, 3),
    minutes_left: left,
    minutes_plan_left: left,
    minutes_topup_left: 0.0,
    max_video_seconds: Math.trunc(Number(plan.max_video_seconds)),
    retention_days: Number(plan.output_retention_days),
    period_end: null,
    auto_renew: false,
  };
}

/**
 * One line of a job's history. `internal` keeps it out of everything the customer can
 * read: machines, addresses, containers, storage keys, engine errors, segment ids.
 * Defaults to visible, so a forgotten flag is a harmless message rather than a leak.
 */
export function addEvent(
  jobId: string,
  state: string | null,
  percent: number | null,
  detail: string | null,
  vsSeq: number | null = null,
  internal = false,
): void {
  execute(
    'INSERT INTO job_events (job_id, at, state, percent, detail, vs_seq, internal) VALUES (?,?,?,?,?,?,?)',
    [jobId, now(), state, percent, detail, vsSeq, internal ? 1 : 0],
  );
}

export function audit(
  adminUserId: number,
  action: string,
  opts: {
    targetUserId?: number | null;
    targetJobId?: string | null;
    before?: string | null;
    after?: string | null;
    reason?: string | null;
    ip?: string | null;
  } = {},
): void {
  execute(
    'INSERT INTO admin_audit (at, admin_user_id, action, target_user_id, target_job_id,' +
      ' before_json, after_json, reason, ip) VALUES (?,?,?,?,?,?,?,?,?)',
    [
      now(),
      adminUserId,
      action,
      opts.targetUserId ?? null,
      opts.targetJobId ?? null,
      opts.before ?? null,
      opts.after ?? null,
      opts.reason ?? null,
      opts.ip ?? null,
    ],
  );
}

/** Is this SQLite error a UNIQUE/PRIMARY KEY violation? Python's sqlite3.IntegrityError. */
export function isIntegrityError(e: unknown): boolean {
  const code = (e as { code?: string })?.code || '';
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}
