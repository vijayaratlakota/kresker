/**
 * Passwords, sessions and CSRF.
 *
 * Passwords are hashed with scrypt, which is memory-hard and built into Node's crypto
 * module (it is OpenSSL's implementation — the same code Python's hashlib.scrypt calls).
 * Only the SHA-256 of a session token is ever stored, so a database leak yields no
 * usable sessions.
 *
 * ── COMPATIBILITY ─────────────────────────────────────────────────────────────
 *
 * Every format here is the Python backend's, byte for byte:
 *
 *   * a password hash is `scrypt$16384$8$1$<salt hex>$<key hex>`, so a password set on
 *     either backend signs in on the other;
 *   * a session cookie is `<session id>.<raw token>` and the row stores SHA-256(raw);
 *   * the Set-Cookie line is the one Starlette writes, attribute for attribute.
 *
 * ── WHY THE HASHING IS ASYNCHRONOUS HERE ──────────────────────────────────────
 *
 * One scrypt call at these parameters takes tens of milliseconds and 16 MB. Python ran it
 * on a request thread. Node has one thread for every request, so a synchronous hash
 * would stall the whole site during every sign-in. `crypto.scrypt` runs on libuv's
 * worker pool instead; the result is identical.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Response } from 'express';
import {
  COOKIE_SECURE,
  SESSION_COOKIE,
  SESSION_MAX_DAYS,
  SESSION_RENEW_AFTER_HOURS,
  SESSION_TTL_DAYS,
} from './config';
import * as db from './db';
import type { Row } from './db';
import { addSeconds, fmtStamp, parseStamp, pyPartition, pySlice, safeEqual, sha256Hex, tokenUrlsafe } from './py';
import { setCookie } from './cookies';

// scrypt's memory cost is roughly 128 * N * r bytes. N = 2**14 with r = 8 is about 16 MB,
// the parameter set the scrypt paper recommends for interactive logins. maxmem is passed
// explicitly rather than left to a default that differs between builds.
const SCRYPT_N = 2 ** 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DKLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

function scrypt(password: Buffer, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** A lone UTF-16 surrogate cannot be encoded as UTF-8; Python's .encode() raises on it. */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function utf8Strict(s: string): Buffer {
  if (hasLoneSurrogate(s)) {
    throw new Error("UnicodeEncodeError: 'utf-8' codec can't encode character: surrogates not allowed");
  }
  return Buffer.from(s, 'utf8');
}

/**
 * bytes.fromhex(): pairs of hex digits, with ASCII whitespace allowed BETWEEN pairs.
 * Throws on anything else, the way Python raises ValueError.
 */
function fromHex(s: string): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\x0b' || c === '\x0c') {
      i++;
      continue;
    }
    const pair = s.slice(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) throw new Error('non-hexadecimal number found in fromhex() arg');
    out.push(parseInt(pair, 16));
    i += 2;
  }
  return Buffer.from(out);
}

/** int(s) for the three cost parameters: optional whitespace and sign, digits, underscores. */
function pyInt(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return parseInt(t.replace(/_/g, ''), 10);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(utf8Strict(password), salt, DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

/**
 * Parameters are read back out of the stored string, so raising the cost later does not
 * invalidate existing passwords. Anything malformed is simply "wrong password" — which
 * is also what an `oauth-google$...` or `erased` marker must be.
 */
export async function verifyPassword(password: string | null | undefined, stored: string | null | undefined): Promise<boolean> {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [scheme, n, r, p, saltHex, dkHex] = parts;
    if (scheme !== 'scrypt') return false;
    const N = pyInt(n);
    const R = pyInt(r);
    const P = pyInt(p);
    const salt = fromHex(saltHex);
    const want = fromHex(dkHex);
    // Python's hashlib refuses a zero-length key. Node would happily derive zero bytes
    // and "match" them against zero bytes, so a hash with an empty key part would accept
    // every password. Refused here, explicitly.
    if (want.length < 1) return false;
    // hashlib's own argument checks: N must be a power of two above 1.
    if (!(N > 1) || (N & (N - 1)) !== 0 || R < 1 || P < 1) return false;
    const dk = await scrypt(utf8Strict(password), salt, want.length, { N, r: R, p: P, maxmem: MAXMEM });
    // constant time, so a wrong password cannot be distinguished by timing
    return dk.length === want.length && timingSafeEqual(dk, want);
  } catch {
    return false;
  }
}

/** hashlib.sha256(s.encode("utf-8")).hexdigest() */
export function sha256(s: string): string {
  return sha256Hex(utf8Strict(s));
}

/**
 * Returns [cookie value, csrf]. The raw token is handed to the browser once and never
 * stored; only its hash goes in the database.
 */
export function createSession(userId: number, ip: string | null, userAgent: string | null | undefined): [string, string] {
  const sid = tokenUrlsafe(16);
  const raw = tokenUrlsafe(32);
  const csrf = tokenUrlsafe(24);
  const expires = fmtStamp(addSeconds(new Date(), SESSION_TTL_DAYS * 86400));
  db.execute(
    'INSERT INTO sessions (id, user_id, token_sha256, csrf, created_at,' +
      ' last_seen_at, expires_at, ip, user_agent)' +
      ' VALUES (?,?,?,?,?,?,?,?,?)',
    [sid, userId, sha256(raw), csrf, db.now(), db.now(), expires, ip, pySlice(userAgent || '', 300)],
  );
  return [`${sid}.${raw}`, csrf];
}

/** Resolve a cookie to [session row, user row], or [null, null]. */
export function loadSession(cookieValue: string | null | undefined): [Row, Row] | [null, null] {
  if (!cookieValue || !cookieValue.includes('.')) return [null, null];
  const [sid, , raw] = pyPartition(cookieValue, '.');
  const row = db.one('SELECT * FROM sessions WHERE id=?', [sid]);
  if (!row) return [null, null];
  if (row.revoked_at) return [null, null];
  if (String(row.expires_at) < db.now()) return [null, null];
  if (!safeEqual(String(row.token_sha256), sha256(raw))) return [null, null];
  const user = db.one('SELECT * FROM users WHERE id=?', [row.user_id]);
  if (!user) return [null, null];
  db.execute('UPDATE sessions SET last_seen_at=? WHERE id=?', [db.now(), sid]);
  return [row, user];
}

/**
 * Push a live session's expiry back out. True if it moved.
 *
 * The database row and the browser's copy of the cookie expire independently, so the
 * caller pairs a `true` here with a fresh Set-Cookie. Bounded by created_at +
 * SESSION_MAX_DAYS, so a session used every day still ends. Writes nothing when the
 * expiry is already close to full, which is the common case.
 */
export function slideSession(row: Row): boolean {
  const nowD = new Date();
  let want = addSeconds(nowD, SESSION_TTL_DAYS * 86400);

  // The ceiling. A malformed created_at means "no ceiling reached" rather than signing
  // the person out.
  try {
    const created = parseStamp(row.created_at);
    const ceiling = addSeconds(created, SESSION_MAX_DAYS * 86400);
    if (want > ceiling) want = ceiling;
  } catch {
    /* no ceiling */
  }

  let currentExp: Date;
  try {
    currentExp = parseStamp(row.expires_at);
  } catch {
    currentExp = nowD;
  }

  // Never move it BACKWARDS, and do not rewrite it for a small drift.
  if (want.getTime() <= addSeconds(currentExp, SESSION_RENEW_AFTER_HOURS * 3600).getTime()) return false;

  db.execute('UPDATE sessions SET expires_at=? WHERE id=? AND revoked_at IS NULL', [fmtStamp(want), row.id]);
  return true;
}

/**
 * The ONE definition of the session cookie's attributes, used by sign-in and by the
 * middleware that slides an active session. No `Domain`: host-only on purpose.
 */
export function setSessionCookie(res: Response, token: string): void {
  setCookie(res, SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_DAYS * 86400,
    httpOnly: true, // JavaScript cannot read it, so XSS cannot steal it
    secure: COOKIE_SECURE, // off for http://127.0.0.1 dev, on behind TLS
    sameSite: 'lax',
    path: '/',
  });
}

export function revokeSession(sessionId: string): void {
  db.execute('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', [db.now(), sessionId]);
}

export function revokeAllForUser(userId: number): number {
  const cur = db.execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [
    db.now(),
    userId,
  ]);
  return cur.rowcount || 0;
}
