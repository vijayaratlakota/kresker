/**
 * The admin database browser's query runner: a short-lived CHILD PROCESS, one per request.
 *
 * WHY A SEPARATE PROCESS, AND WHY NODE'S OWN SQLITE HERE.
 *
 * The browser's safety rests on SQLite's authorizer: a callback SQLite consults while it
 * prepares a statement, against the REAL table and column, that turns every read of a
 * credential column into NULL - however the query spells it (`SELECT password_hash AS h`,
 * `WHERE password_hash LIKE ...`, a sub-select, `main.users`). A check on result-column
 * names cannot do that; renaming the column defeats it.
 *
 * better-sqlite3, which the rest of the backend uses, does not expose the authorizer.
 * Node's built-in `node:sqlite` does (DatabaseSync.setAuthorizer, Node 24.10+). But it is a
 * SECOND COPY of the SQLite library, and two copies in one process must never open the
 * same database file: POSIX drops every lock a process holds on a file when ANY descriptor
 * for it is closed, so one copy closing its connection silently releases the other copy's
 * locks (https://www.sqlite.org/howtocorrupt.html, section 2.2.1). In its own process
 * there is only one copy, and cross-process locking works as designed.
 *
 * Read-only twice over, as before: the file is opened read-only, so the SQLite driver
 * itself refuses writes, and the parent only sends a single guarded SELECT.
 *
 * Protocol: one JSON request on stdin, one JSON reply on stdout. Values are tagged so the
 * parent can tell an INTEGER from a REAL exactly as Python's sqlite3 does:
 *   null | string | {i: "<decimal>"} | {f: <number> | "inf" | "-inf"} | {b: "<base64>"}
 */

interface Request {
  db: string;
  op: 'overview' | 'table' | 'query';
  name?: string;
  limit?: number;
  offset?: number;
  orderDesc?: boolean;
  sql?: string;
  max?: number;
}

type Tagged = null | string | { i: string } | { f: number | string } | { b: string };

interface Stmt {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
  columns(): Array<{ name: string }>;
  setReadBigInts(on: boolean): void;
  setReturnArrays(on: boolean): void;
}

interface Conn {
  prepare(sql: string): Stmt;
  close(): void;
  setAuthorizer?: (fn: ((action: number, a1: string | null, a2: string | null, db: string | null, trig: string | null) => number) | null) => void;
}

// Columns the DATABASE ITSELF will not hand over, whatever the query says.
// `inbox_messages.body` is deliberately NOT here: it is a message somebody sent us on
// purpose and the inbox screen is meant to show it.
const NEVER_READ = new Set([
  'users\u0000password_hash',
  'users\u0000reset_token_sha256',
  'sessions\u0000token_sha256',
  'sessions\u0000csrf',
  'emails\u0000body',
  'emails\u0000html',
]);

function tag(v: unknown): Tagged {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return { i: v.toString() };
  if (typeof v === 'number') {
    if (v === Infinity) return { f: 'inf' };
    if (v === -Infinity) return { f: '-inf' };
    // JSON has no negative zero; Python's sqlite3 would hand back -0.0.
    if (Object.is(v, -0)) return { f: '-0' };
    return { f: v };
  }
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return { b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  return String(v);
}

function reply(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

function main(input: string): void {
  let req: Request;
  try {
    req = JSON.parse(input) as Request;
  } catch {
    reply({ ok: false, kind: 'error', message: 'bad request to the query runner' });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite = require('node:sqlite') as {
    DatabaseSync: new (p: string, o: Record<string, unknown>) => Conn;
    constants: Record<string, number>;
  };
  let conn: Conn;
  try {
    conn = new sqlite.DatabaseSync(req.db, {
      readOnly: true,
      timeout: 15_000,
      // Python's sqlite3 runs SQLite with its default of accepting "double-quoted"
      // strings as literals where no column matches; an admin's pasted query must mean
      // the same thing here.
      enableDoubleQuotedStringLiterals: true,
    });
  } catch (e) {
    reply({ ok: false, kind: 'open', message: (e as Error).message });
    return;
  }
  try {
    if (typeof conn.setAuthorizer !== 'function') {
      // Fail CLOSED: without the authorizer this would hand credentials to anyone
      // holding an admin session.
      reply({ ok: false, kind: 'unsupported', message: `node ${process.version} has no SQLite authorizer (needs 24.10 or newer)` });
      return;
    }
    const { SQLITE_READ, SQLITE_IGNORE, SQLITE_OK } = sqlite.constants;
    conn.setAuthorizer((action, a1, a2) =>
      action === SQLITE_READ && NEVER_READ.has(`${a1}\u0000${a2}`) ? SQLITE_IGNORE : SQLITE_OK,
    );

    const prep = (sql: string): Stmt => {
      const s = conn.prepare(sql);
      s.setReadBigInts(true);
      s.setReturnArrays(true);
      return s;
    };
    const names = (sql: string): string[] => (prep(sql).all() as unknown[][]).map((r) => String(r[1]));
    const scalar = (sql: string): Tagged => tag(((prep(sql).get() as unknown[]) ?? [null])[0]);

    if (req.op === 'overview') {
      const tables = (prep("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown[][]).map((r) =>
        String(r[0]),
      );
      const out: Array<{ table: string; rows: Tagged; columns: string[] }> = [];
      for (const t of tables) {
        let n: Tagged;
        try {
          n = scalar(`SELECT COUNT(*) FROM "${t}"`);
        } catch {
          n = null;
        }
        out.push({ table: t, rows: n, columns: names(`PRAGMA table_info("${t}")`) });
      }
      reply({ ok: true, tables: out });
      return;
    }

    if (req.op === 'table') {
      const name = String(req.name);
      const cols = names(`PRAGMA table_info("${name}")`);
      if (!cols.length) {
        reply({ ok: false, kind: 'no_such_table' });
        return;
      }
      // sort by whatever looks like a natural recency key
      let order = '';
      for (const cand of ['id', 'at', 'created_at']) {
        if (cols.includes(cand)) {
          order = ` ORDER BY "${cand}" ${req.orderDesc ? 'DESC' : 'ASC'}`;
          break;
        }
      }
      const total = scalar(`SELECT COUNT(*) FROM "${name}"`);
      const st = prep(`SELECT * FROM "${name}"${order} LIMIT ? OFFSET ?`);
      const rows = (st.all(BigInt(req.limit ?? 100), BigInt(req.offset ?? 0)) as unknown[][]).map((r) => r.map(tag));
      reply({ ok: true, columns: cols, total, names: st.columns().map((c) => c.name), rows });
      return;
    }

    if (req.op === 'query') {
      let st: Stmt;
      const rows: Tagged[][] = [];
      try {
        st = prep(String(req.sql));
        const max = req.max ?? 500;
        if (max > 0) {
          for (const r of st.iterate()) {
            rows.push((r as unknown[]).map(tag));
            if (rows.length >= max) break;
          }
        }
      } catch (e) {
        reply({ ok: false, kind: 'sqlite', message: (e as Error).message });
        return;
      }
      reply({ ok: true, columns: st.columns().map((c) => c.name), rows });
      return;
    }

    reply({ ok: false, kind: 'error', message: `unknown op ${String(req.op)}` });
  } catch (e) {
    reply({ ok: false, kind: 'error', message: (e as Error).message });
  } finally {
    try {
      conn.close();
    } catch {
      /* closing a read-only connection cannot lose anything */
    }
  }
}

const chunks: Buffer[] = [];
process.stdin.on('data', (b: Buffer) => chunks.push(b));
process.stdin.on('end', () => main(Buffer.concat(chunks).toString('utf8')));
