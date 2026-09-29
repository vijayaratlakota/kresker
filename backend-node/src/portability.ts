/**
 * Moving this installation to another AWS account, or off AWS entirely.
 *
 * The design rule is that nothing which matters may exist only as a setting somebody
 * clicked, and this module is how that rule is checked rather than asserted. It writes a
 * self-describing archive — every row of every table, the schema as source, and a
 * manifest of what was counted — and can verify and restore it.
 *
 *   * No secret ever enters the archive: secrets are reported by NAME and whether set.
 *   * The archive is text (JSONL and SQL), readable by a person when something disagrees.
 *   * Checksums are order-independent: rows are hashed as a sorted set.
 *
 * The archive format is the Python backend's, line for line — REAL values are written as
 * `3.0`, keys sorted, UTF-8 — so an archive made by either backend verifies and restores
 * with the other. Videos are not in it; they live in R2 or on disk and the report says
 * which.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as billing from './billing';
import { DATA_DIR, DB_PATH, NODE_ROOT } from './config';
import * as db from './db';
import { PyFloat, canonicalJson, errText, fmtStamp, pyDumps, pyLoads, pyRepr, pyRound, pySplitlines, pyStrip, sha256Hex } from './py';
import * as storage from './storage';

export const ARCHIVE_VERSION = 1;

// Every table the application owns, listed explicitly so a table added without thinking
// about migration shows up as a failure rather than being silently left out.
export const TABLES = [
  'users', 'sessions', 'plans', 'subscriptions', 'payments',
  'checkout_sessions', 'webhook_events', 'webhook_rejects',
  'uploads', 'jobs', 'job_segments', 'job_events', 'job_artifacts',
  'usage_ledger', 'admin_audit', 'emails', 'gpu_state',
];

// Worthless after a move, and live credentials besides.
export const SKIP_ROWS = new Set(['sessions']);

const SQL_DIR = path.join(NODE_ROOT, 'sql');

// name -> [env var, built-in default]. A default on an AWS identifier in a new account
// means it still drives the OLD account's resources.
const ENV_KEYS: Array<[string, string, string | null]> = [
  ['engine_mode', 'VS_ENGINE_MODE', 'fake'],
  ['engine_url', 'VS_ENGINE_URL', 'http://127.0.0.1:3900'],
  ['db_path', 'VS_DB_PATH', null],
  ['data_dir', 'VS_DATA_DIR', null],
  ['public_base_url', 'VS_PUBLIC_BASE_URL', null],
  ['gpu_instance_id', 'VS_GPU_INSTANCE_ID', 'i-041b48c591cb86e19'],
  ['gpu_container_id', 'VS_GPU_CONTAINER_ID', '9276383fe31e'],
  ['aws_profile', 'VS_AWS_PROFILE', 'videotrans'],
  ['aws_region', 'VS_AWS_REGION', 'ap-south-1'],
  ['ssh_key', 'VS_SSH_KEY', null],
  ['r2_enabled', 'VS_R2_ENABLED', '0'],
  ['r2_prefix', 'VS_R2_PREFIX', 'dubs'],
  ['mail_backend', 'VS_MAIL_BACKEND', 'file'],
  ['ses_from', 'VS_SES_FROM', 'no-reply@example.com'],
  ['deployment', 'VS_DEPLOYMENT', 'unnamed-dev'],
];

// Named, never valued. The new account supplies its own.
const SECRET_KEYS: Array<[string, string]> = [
  ['razorpay_key_id', 'VS_RAZORPAY_KEY_ID'],
  ['razorpay_key_secret', 'VS_RAZORPAY_KEY_SECRET'],
  ['razorpay_webhook_secret', 'VS_RAZORPAY_WEBHOOK_SECRET'],
  // a FILE, not an environment variable: VS_DODO_ENV only overrides the default path
  ['dodo_credentials_file', '(file) dodo.env'],
  ['r2_credentials_file', 'VS_R2_ENV'],
  ['download_token_secret', '(file) data/secret.key'],
];

/** Every environment-derived value, and whether it was actually set. */
export function envReport(): Record<string, any> {
  const values: Record<string, any> = {};
  const defaulted: string[] = [];
  for (const [name, v, dflt] of ENV_KEYS) {
    const raw = process.env[v];
    if (raw !== undefined && raw !== '') values[name] = { value: raw, env: v, source: 'environment' };
    else {
      values[name] = { value: dflt, env: v, source: 'default' };
      if (dflt !== null) defaulted.push(name);
    }
  }
  const secrets: Record<string, any> = {};
  for (const [name, v] of SECRET_KEYS) {
    if (v.startsWith('(file)')) {
      const f = v.includes('dodo') ? billing.dodoEnvFile() : path.join(DATA_DIR, 'secret.key');
      secrets[name] = { where: f, set: existsSync(f), moves_with_the_archive: false };
    } else {
      secrets[name] = { where: v, set: Boolean(process.env[v]), moves_with_the_archive: false };
    }
  }
  const awsDefaulted = defaulted.filter((n) => n.startsWith('gpu_') || n.startsWith('aws_'));
  return {
    deployment: values.deployment.value,
    values,
    secrets,
    still_on_built_in_defaults: defaulted,
    warning: awsDefaulted.length
      ? 'these AWS identifiers are still the built-in defaults, which point at ' +
        'the ORIGINAL account: ' +
        awsDefaulted.join(', ') +
        '. Set them explicitly in a new account, or this installation will ' +
        "drive the old account's resources while appearing to be configured."
      : null,
    host: { platform: platformName(), node: process.versions.node },
  };
}

/** platform.system() spelling. */
function platformName(): string {
  const p = os.platform();
  return p === 'win32' ? 'Windows' : p === 'darwin' ? 'Darwin' : p === 'linux' ? 'Linux' : p;
}

// ── fingerprints ──────────────────────────────────────────────────────────────

/** A hash of the LIVE table/column layout, not of the schema file, so drift shows. */
export function schemaFingerprint(): string {
  const parts: string[] = [];
  for (const t of TABLES) {
    let cols: db.Row[];
    try {
      cols = db.query(`PRAGMA table_info("${t}")`);
    } catch {
      cols = [];
    }
    parts.push(t + '(' + cols.map((c) => `${c.name}:${String(c.type || '').toUpperCase()}`).join(',') + ')');
  }
  return sha256Hex(Buffer.from(parts.join('|'), 'utf8'));
}

function rowToJson(row: db.Row): string {
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    d[k] = Buffer.isBuffer(v) ? { __bytes_b64__: v.toString('base64') } : v;
  }
  return canonicalJson(d);
}

/** Order-independent: two correct databases may order rows differently. */
function tableDigest(lines: string[]): string {
  // Python sorts str by code point
  const sorted = [...lines].sort((a, b) => {
    const x = [...a];
    const y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const dd = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
      if (dd) return dd;
    }
    return x.length - y.length;
  });
  const h = createHash('sha256');
  for (const line of sorted) {
    h.update(Buffer.from(line, 'utf8'));
    h.update('\n');
  }
  return h.digest('hex');
}

type Scalar = (sql: string, dflt: unknown) => unknown;

function totalsWith(s: Scalar): Record<string, unknown> {
  return {
    users: s('SELECT COUNT(*) FROM users', 0),
    admins: s("SELECT COUNT(*) FROM users WHERE role='admin'", 0),
    jobs: s('SELECT COUNT(*) FROM jobs', 0),
    jobs_done: s("SELECT COUNT(*) FROM jobs WHERE state='done'", 0),
    segments: s('SELECT COUNT(*) FROM job_segments', 0),
    translated_segments: s("SELECT COUNT(*) FROM job_segments WHERE translated_text IS NOT NULL AND translated_text != ''", 0),
    minutes_charged_total: new PyFloat(pyRound(Number(s('SELECT COALESCE(SUM(minutes_charged),0) FROM usage_ledger', 0.0)), 6)),
    cash_paise_total: s("SELECT COALESCE(SUM(amount_paise),0) FROM payments WHERE status IN ('captured','refunded')", 0),
    active_subscriptions: s("SELECT COUNT(*) FROM subscriptions WHERE status='active'", 0),
    admin_audit_entries: s('SELECT COUNT(*) FROM admin_audit', 0),
    emails_sent: s('SELECT COUNT(*) FROM emails', 0),
  };
}

/** The numbers a migration is checked against. Money and minutes are SUMMED, not counted. */
export function totals(): Record<string, unknown> {
  return totalsWith((sql, dflt) => db.scalar(sql, [], dflt));
}

// ── export ────────────────────────────────────────────────────────────────────

/** Where archives may be written: configuration, read on every call. */
export function exportRoot(): string {
  return process.env.VS_EXPORT_ROOT || path.join(DATA_DIR, 'export');
}

export class PortabilityError extends Error {
  override name = 'ValueError';
}

/** Python's Path.write_text: '\n' becomes the platform's line ending. */
function writeText(file: string, text: string): void {
  writeFileSync(file, process.platform === 'win32' ? text.replace(/\n/g, '\r\n') : text, 'utf8');
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Write the archive under exportRoot(). Takes a NAME, never a path: the archive holds
 * every users row including password hashes, so a caller must not be able to land it
 * somewhere public. The name is reduced to one path component and re-checked after
 * resolution.
 */
export function exportArchive(name: string | null = null): Record<string, unknown> {
  const stamp = fmtStamp(new Date()).replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
  const leaf = pyStrip(name || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || stamp;
  let root = exportRoot();
  mkdirSync(root, { recursive: true });
  root = realpathSync(path.resolve(root));
  const out = path.resolve(root, leaf);
  if (out !== root && !isWithin(out, root)) throw new PortabilityError(`export name escapes the export directory: ${pyRepr(name)}`);
  mkdirSync(path.join(out, 'tables'), { recursive: true });

  const tablesMeta: Record<string, unknown> = {};
  for (const t of TABLES) {
    const lines: string[] = [];
    if (!SKIP_ROWS.has(t)) {
      try {
        for (const row of db.tableRowsTyped(t)) lines.push(rowToJson(row));
      } catch (e) {
        tablesMeta[t] = { rows: 0, sha256: null, error: errText(e) };
        continue;
      }
    }
    writeText(path.join(out, 'tables', `${t}.jsonl`), lines.join('\n') + (lines.length ? '\n' : ''));
    tablesMeta[t] = { rows: lines.length, sha256: tableDigest(lines), rows_excluded_by_design: SKIP_ROWS.has(t) };
  }

  // the schema travels as SOURCE
  for (const f of ['schema.sql', 'postgres_schema.sql']) {
    const src = path.join(SQL_DIR, f);
    if (existsSync(src)) copyFileSync(src, path.join(out, f));
  }

  const manifest = {
    archive_version: ARCHIVE_VERSION,
    archive_dir: out,
    created_at: fmtStamp(new Date()),
    source_db: DB_PATH,
    source_db_bytes: existsSync(DB_PATH) ? statSync(DB_PATH).size : 0,
    schema_fingerprint: schemaFingerprint(),
    tables: tablesMeta,
    totals: totals(),
    environment: envReport(),
    rows_with_machine_specific_paths: db.unportableRows(),
    files_not_in_this_archive: fileNote(),
    restore_with:
      'node -e "console.log(require(\'./dist/portability\').restore(String.raw`<this directory>`, String.raw`<new .db path>`))"',
  };
  writeText(path.join(out, 'manifest.json'), pyDumps(manifest, { indent: 2, ensureAscii: false }));
  return manifest;
}

function fileNote(): Record<string, unknown> {
  const onR2 = db.scalar('SELECT COUNT(*) FROM jobs WHERE output_r2_key IS NOT NULL', [], 0);
  const local = db.scalar('SELECT COUNT(*) FROM jobs WHERE output_path IS NOT NULL AND output_r2_key IS NULL AND output_deleted_at IS NULL', [], 0);
  return {
    note: 'this archive contains the database only. Videos are separate.',
    delivery_backend: storage.status().backend,
    outputs_on_r2: onR2,
    outputs_on_local_disk_only: local,
    action_required: local
      ? `copy ${path.join(DATA_DIR, 'uploads')} and ${path.join(DATA_DIR, 'outputs')} to the new host; ${local} finished video(s) exist only on local disk`
      : 'nothing to copy: R2 is not in any AWS account, so the videos do not move when the AWS account changes',
  };
}

// ── verify ────────────────────────────────────────────────────────────────────

function readText(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Re-read the archive and check it against its own manifest. */
export function verify(archive: string): Record<string, unknown> {
  const a = archive;
  const man = pyLoads(readText(path.join(a, 'manifest.json'))) as Record<string, any>;
  const problems: string[] = [];
  const checked: Record<string, unknown> = {};

  for (const [t, meta] of Object.entries(man.tables as Record<string, any>)) {
    const f = path.join(a, 'tables', `${t}.jsonl`);
    if (!existsSync(f)) {
      problems.push(`${t}: file missing from the archive`);
      continue;
    }
    const lines = pySplitlines(readText(f)).filter((ln) => pyStrip(ln));
    const digest = tableDigest(lines);
    checked[t] = { rows: lines.length, sha256: digest };
    if (lines.length !== Number(meta.rows)) problems.push(`${t}: manifest says ${meta.rows} rows, file has ${lines.length}`);
    if (meta.sha256 && digest !== meta.sha256) problems.push(`${t}: checksum does not match the manifest`);
    for (const ln of lines) {
      try {
        pyLoads(ln);
      } catch {
        problems.push(`${t}: a line is not valid JSON`);
        break;
      }
    }
  }
  const unport = man.rows_with_machine_specific_paths;
  if (Array.isArray(unport) && unport.length) {
    problems.push(`${unport.length} row(s) record an absolute file path, which will not resolve on another machine`);
  }
  for (const f of ['schema.sql', 'postgres_schema.sql']) {
    if (!existsSync(path.join(a, f))) problems.push(`${f} is missing; the schema must travel as source`);
  }
  return { ok: !problems.length, problems, tables: checked, manifest_totals: man.totals, archive: a };
}

// ── restore ───────────────────────────────────────────────────────────────────

/**
 * Build a fresh database from the archive and compare it with the manifest. Refuses to
 * touch an existing file: a restore that can overwrite a live database is one bad
 * argument away from being the incident.
 */
export function restore(archive: string, into: string): Record<string, unknown> {
  const a = archive;
  const target = into;
  if (existsSync(target)) throw new PortabilityError(`${target} already exists; restore only into a new file`);

  const man = pyLoads(readText(path.join(a, 'manifest.json'))) as Record<string, any>;
  const v = verify(a);
  if (!v.ok) return { ok: false, stage: 'verify', problems: v.problems };

  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const conn = new Database(target);
  let inserted: Record<string, number> = {};
  let fkCount = 0;
  let restored: Record<string, unknown>;
  try {
    conn.exec(readText(path.join(a, 'schema.sql')));
    // foreign keys off during the load: JSONL has no dependency order
    conn.pragma('foreign_keys = OFF');
    inserted = {};
    for (const t of Object.keys(man.tables)) {
      const f = path.join(a, 'tables', `${t}.jsonl`);
      const rows = pySplitlines(readText(f))
        .filter((ln) => pyStrip(ln))
        .map((ln) => pyLoads(ln) as Record<string, unknown>);
      let n = 0;
      for (const r of rows) {
        const cols = Object.keys(r);
        const vals = cols.map((c) => {
          const x = r[c] as any;
          if (x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof PyFloat) && '__bytes_b64__' in x) {
            return Buffer.from(String(x.__bytes_b64__), 'base64');
          }
          return x;
        });
        const ph = cols.map(() => '?').join(',');
        const names = cols.map((c) => `"${c}"`).join(',');
        conn.prepare(`INSERT OR REPLACE INTO "${t}" (${names}) VALUES (${ph})`).run(...(db.bindParams(vals) as unknown[]));
        n++;
      }
      inserted[t] = n;
    }
    conn.pragma('foreign_keys = ON');
    fkCount = (conn.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    restored = totalsWith((sql, dflt) => {
      try {
        const r = conn.prepare(sql).raw(true).get() as unknown[] | undefined;
        return r === undefined || r[0] === null || r[0] === undefined ? dflt : r[0];
      } catch {
        return dflt;
      }
    });
  } finally {
    conn.close();
  }

  const expected = man.totals as Record<string, unknown>;
  const mismatches: Record<string, unknown> = {};
  for (const k of Object.keys(expected)) {
    if (numericOrSame(restored[k]) !== numericOrSame(expected[k])) mismatches[k] = { expected: expected[k], restored: restored[k] ?? null };
  }
  return {
    ok: !Object.keys(mismatches).length && !fkCount,
    restored_to: target,
    rows_inserted: inserted,
    totals_expected: expected,
    totals_restored: restored,
    mismatches,
    foreign_key_violations: fkCount,
    note: 'sessions are intentionally not carried across, so everyone signs in again after a move',
  };
}

/** Python compares 12 and 12.0 as equal; so does this. */
function numericOrSame(v: unknown): unknown {
  if (v instanceof PyFloat) return v.v;
  return v;
}

// ── the readiness report ──────────────────────────────────────────────────────

/** Could this installation be moved right now, and what would break? Blockers, not a score. */
export function readiness(): Record<string, unknown> {
  const blockers: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];

  const unportable = db.unportableRows();
  if (unportable.length) {
    blockers.push({
      what: `${unportable.length} database row(s) record an absolute file path`,
      why: 'they resolve to nothing on a different host',
      fix: 'restart the backend; the path migration runs on every start',
      rows: unportable.slice(0, 10),
    });
  }
  const env = envReport();
  if (env.warning) warnings.push({ what: 'AWS identifiers are still built-in defaults', why: env.warning, fix: 'set them explicitly in the new account' });
  if (env.deployment === 'unnamed-dev') {
    warnings.push({
      what: 'this deployment has no name',
      why: "two installations that both call themselves 'unnamed-dev' are indistinguishable in an archive manifest",
      fix: 'set VS_DEPLOYMENT',
    });
  }
  const st = storage.status();
  if (st.backend !== 'cloudflare-r2') {
    warnings.push({
      what: 'finished videos are on local disk, not R2',
      why:
        'R2 is outside AWS, so with it switched on the videos do not ' +
        'move at all when the AWS account changes. On local disk they ' +
        'have to be copied by hand',
      fix: 'set VS_R2_ENABLED=1 once the credentials are in place',
    });
  }
  const missingTables = TABLES.filter((t) => !db.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [t]));
  if (missingTables.length) {
    blockers.push({
      what: `tables missing from this database: ${missingTables.join(', ')}`,
      why: 'the archive would be incomplete',
      fix: 'restart the backend so init_db() creates them',
    });
  }
  if (!existsSync(path.join(SQL_DIR, 'postgres_schema.sql'))) {
    blockers.push({
      what: 'postgres_schema.sql is missing',
      why: 'the plan targets PostgreSQL on RDS in production',
      fix: 'it belongs in git beside schema.sql',
    });
  }
  return {
    movable: !blockers.length,
    blockers,
    warnings,
    schema_fingerprint: schemaFingerprint(),
    tables: TABLES.length,
    totals: totals(),
    what_moves: {
      'the database': 'this archive - accounts, jobs, transcripts, ledger, audit',
      'password hashes':
        'they are ours, in the users table. This is why ' +
        'Cognito was rejected: it cannot export password ' +
        'hashes, so a move would force every customer to ' +
        'reset their password',
      'the schema': 'sql/schema.sql and sql/postgres_schema.sql, in git',
      'the preset': 'the golden preset, in git, fingerprinted onto every job',
      'the videos': fileNote().action_required,
    },
    what_does_not_move: {
      sessions: 'everyone signs in again',
      secrets: 'the new account supplies its own: Razorpay keys, R2 credentials, the download-token secret',
      'download links': 'outstanding /dl/ tokens die with the old secret. They last 5 minutes, so this is not worth solving',
      'the GPU instance':
        'rebuilt in the new account from the same AMI, then ' +
        "verified against the handbook's pinned file sizes " +
        'and MD5s before any customer traffic',
    },
  };
}
