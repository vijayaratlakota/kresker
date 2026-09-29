/**
 * A read-only database browser for the admin.
 *
 * The tunnel and a GUI are the real tool for looking at the database (section 10.1).
 * This exists for the times you just want to see what is in there without leaving the
 * browser, and it is deliberately incapable of changing anything:
 *
 *   * every query runs in its own short-lived process on a connection opened READ-ONLY,
 *     so the SQLite driver itself refuses writes - not merely a check in our code
 *   * that connection carries SQLite's authorizer, which turns every read of a credential
 *     column into NULL however the query spells it (see dbquery.ts for why that needs
 *     its own process)
 *   * only a single SELECT or a PRAGMA table_info is accepted
 *   * anything with a second statement, or a write keyword, is rejected
 *   * results are capped
 *
 * Admin only, and a non-admin gets 404 rather than 403 so the panel's existence is not
 * confirmed.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../config';
import { requireAdmin, requireCsrf } from '../deps';
import { ApiRouter, HTTPException } from '../http';
import * as procs from '../procs';
import { KEY_ORDER, PyFloat, pyKeys, pyLen, pySlice, pyStrip, pyRstrip } from '../py';
import { Model, optional, required, t } from '../validate';
import { logRead } from './admin';

export const router = new ApiRouter('/api/admin/db', ['admin-db']);

const MAX_ROWS = 500;

// Python's \b(...)\b, spelled out. Its \b is a Unicode word boundary (JavaScript's is
// ASCII-only), and the trailing one means different things per alternative: after a word
// that ends in a letter or `_` the next character must NOT be a word character, but
// `pragma\s+` ends in whitespace, so there the next character MUST be one. (Which is also
// why `pragma_table_info(...)` passes, exactly as it does in the Python backend.)
const W = '[\\p{L}\\p{N}_]';
// Python's \s (str.isspace()), which is not quite JavaScript's: it has U+001C-U+001F and
// U+0085, and lacks U+FEFF.
const S = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const FORBIDDEN = new RegExp(
  `(?<!${W})(?:(?:insert|update|delete|drop|alter|create|replace|truncate|attach|detach|` +
    `vacuum|reindex|begin|commit|rollback|pragma_|savepoint)(?!${W})|pragma${S}+(?!table_info)(?=${W}))`,
  'iu',
);

/** Python's str.strip().rstrip(";").strip(), then the one-statement, read-only rules. */
function guard(sql: string): string {
  const s = pyStrip(pyRstrip(pyStrip(sql || ''), ';'));
  if (!s) throw new HTTPException(400, 'empty query');
  if (s.includes(';')) throw new HTTPException(400, 'one statement at a time, and no semicolons');
  const low = s.toLowerCase();
  if (!(low.startsWith('select') || low.startsWith('with') || low.startsWith('pragma table_info'))) {
    throw new HTTPException(400, 'only SELECT, WITH or PRAGMA table_info are allowed here');
  }
  if (FORBIDDEN.test(s)) throw new HTTPException(400, 'that statement contains a write keyword');
  return s;
}

// ── the child process ────────────────────────────────────────────────────────

type Tagged = null | string | { i: string } | { f: number | string } | { b: string };

/** One tagged value back into what Python's sqlite3 would have returned. */
function untag(v: Tagged): unknown {
  if (v === null || typeof v === 'string') return v;
  if ('i' in v) {
    const b = BigInt(v.i);
    return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
  }
  if ('f' in v) return new PyFloat(v.f === 'inf' ? Infinity : v.f === '-inf' ? -Infinity : v.f === '-0' ? -0 : Number(v.f));
  return Buffer.from(v.b, 'base64');
}

const RUNNER = path.join(__dirname, '..', 'dbquery.js');

/** Run one operation in the read-only child. Failures other than SQL errors are a 500. */
async function runChild(req: Record<string, unknown>): Promise<Record<string, any>> {
  let r: procs.RunResult;
  try {
    r = await procs.run([process.execPath, '--no-warnings', RUNNER], {
      input: JSON.stringify({ db: DB_PATH, ...req }),
      timeoutMs: 120_000,
    });
  } catch (e) {
    if (e instanceof procs.TimeoutExpired) throw new HTTPException(400, 'SQLite: interrupted');
    throw e;
  }
  let out: Record<string, any>;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`the database browser's query runner failed: ${pySlice(r.stderr || r.stdout, 300)}`);
  }
  if (!out.ok && out.kind === 'unsupported') {
    // Fail CLOSED: never fall back to a connection without the authorizer.
    throw new HTTPException(503, 'the database browser needs Node.js 24.10 or newer on this server');
  }
  return out;
}

/**
 * dict(sqlite3.Row): one key per column name in order, each holding the FIRST column
 * whose name matches it case-insensitively — which is how Row's lookup behaves.
 */
function rowDict(names: string[], row: Tagged[]): Record<string, unknown> {
  const vals = row.map(untag);
  const out: Record<string, unknown> = {};
  const order: string[] = [];
  for (const k of names) {
    const lk = k.toLowerCase();
    const idx = names.findIndex((n) => n.length === k.length && n.toLowerCase() === lk);
    if (!Object.hasOwn(out, k)) order.push(k);
    Object.defineProperty(out, k, { value: vals[idx], enumerable: true, writable: true, configurable: true });
  }
  // A column called "1" would otherwise jump to the front of the JSON object.
  (out as Record<symbol, unknown>)[KEY_ORDER] = order;
  return out;
}

// Columns that must never be displayed, even to an admin. `reset_token_sha256` is a live
// credential (FINDING-3).
const HIDE = ['password_hash', 'token_sha256', 'csrf', 'reset_token_sha256'];
// `emails.body` holds the password-reset URL, raw token included; `inbox_messages.body`
// is the message a person deliberately sent us, so it stays visible there.
const HIDE_BY_TABLE: Record<string, string[]> = { emails: ['body', 'html'] };
// The free-form SELECT does not know which table a column came from: err towards hiding.
const HIDE_WHEN_TABLE_UNKNOWN = ['body', 'html'];

/** Bytes become text exactly as FastAPI's encoder does it: strict UTF-8, or a failure. */
function jsonableBytes(v: unknown): unknown {
  if (!Buffer.isBuffer(v)) return v;
  return new TextDecoder('utf-8', { fatal: true }).decode(v);
}

function scrub(tableName: string | null, row: Record<string, unknown>): Record<string, unknown> {
  const hide = new Set([...HIDE, ...(tableName === null ? HIDE_WHEN_TABLE_UNKNOWN : HIDE_BY_TABLE[tableName] || [])]);
  const out: Record<string, unknown> = {};
  const order = pyKeys(row);
  for (const k of order) {
    const v = row[k];
    let x: unknown;
    if (hide.has(k)) x = '<hidden>';
    else if (typeof v === 'string' && pyLen(v) > 400) x = pySlice(v, 400) + `... [${pyLen(v)} chars]`;
    else x = jsonableBytes(v);
    Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
  }
  (out as Record<symbol, unknown>)[KEY_ORDER] = order;
  return out;
}

// ── the routes ───────────────────────────────────────────────────────────────

router.get('', { name: 'overview' }, async (req) => {
  // Where the database is, and what is in it.
  requireAdmin(req);
  const r = await runChild({ op: 'overview' });
  if (!r.ok) throw new Error(`SQLite: ${r.message}`);
  const tables = (r.tables as Array<{ table: string; rows: Tagged; columns: string[] }>).map((x) => ({
    table: x.table,
    rows: untag(x.rows),
    columns: x.columns,
  }));
  return {
    database_file: DB_PATH,
    size_bytes: existsSync(DB_PATH) ? statSync(DB_PATH).size : 0,
    engine: 'SQLite (local development). Postgres in production - see the note in app/schema.sql about the one queue difference.',
    open_with: ['this browser: http://127.0.0.1:8099/db', `DB Browser for SQLite, or: sqlite3 "${DB_PATH}"`],
    read_only: true,
    tables,
  };
});

router.get(
  '/table/{name}',
  {
    name: 'table',
    path: { name: t.str() },
    query: { limit: optional(t.int(), 100), offset: optional(t.int(), 0), order_desc: optional(t.bool(), true) },
  },
  async (req, _res, { name, limit, offset, order_desc }) => {
    // Page through one table, newest first where there is something to sort on.
    const admin = requireAdmin(req);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '')) throw new HTTPException(400, 'bad table name');
    const lim = Math.max(1, Math.min(MAX_ROWS, limit));
    const r = await runChild({ op: 'table', name, limit: lim, offset, orderDesc: order_desc });
    if (!r.ok) {
      if (r.kind === 'no_such_table') throw new HTTPException(404, 'no such table');
      throw new Error(`SQLite: ${r.message}`);
    }
    const rows = (r.rows as Tagged[][]).map((row) => rowDict(r.names as string[], row));
    logRead(req, admin, 'db.table', { rowsReturned: rows.length, detail: `${name} limit=${lim} offset=${offset}` });
    return {
      table: name,
      columns: r.columns,
      total: untag(r.total as Tagged),
      limit: lim,
      offset,
      rows: rows.map((row) => scrub(name, row)),
    };
  },
);

const Q = new Model('Q', { sql: required(t.str()) });

// A lone surrogate cannot be encoded as UTF-8; Python's sqlite3 fails on it before SQLite
// sees the statement, and so does this.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

router.post('/query', { name: 'query', body: Q }, async (req, _res, { body }) => {
  // Run one SELECT. The connection is read-only at the driver level. CSRF like every other
  // admin POST: it still writes an access-log row.
  requireCsrf(req);
  const admin = requireAdmin(req);
  const sql = guard(body.sql);
  if (LONE_SURROGATE.test(sql)) throw new Error("'utf-8' codec can't encode a surrogate: surrogates not allowed");
  if (sql.includes('\u0000')) throw new HTTPException(400, 'SQLite: the query contains a null character');
  const r = await runChild({ op: 'query', sql, max: MAX_ROWS });
  if (!r.ok) {
    if (r.kind === 'sqlite') throw new HTTPException(400, `SQLite: ${r.message}`);
    throw new Error(`SQLite: ${r.message}`);
  }
  const cols = r.columns as string[];
  const rows = (r.rows as Tagged[][]).map((row) => rowDict(cols, row));
  // The SQL itself is the detail worth keeping: the only record of what it reached.
  logRead(req, admin, 'db.query', { rowsReturned: rows.length, detail: pySlice(sql, 2000) });
  return {
    sql,
    columns: cols,
    rows: rows.map((row) => scrub(null, row)),
    row_count: rows.length,
    truncated: rows.length >= MAX_ROWS,
  };
});
