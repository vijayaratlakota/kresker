/**
 * Rate limiting, in two halves that fail differently on purpose.
 *
 * 1. An in-process sliding window (`check`). Fast, no I/O, and it counts ATTEMPTS —
 *    including refused ones. It forgets on restart, which is acceptable for password
 *    guessing: the passwords are no weaker afterwards.
 *
 * 2. A durable ceiling on account creation (`signupCeiling`), counted from
 *    `users.signup_ip`. It survives restarts and counts accounts that EXIST, because for
 *    account farming a limiter that forgets is no limiter: the accounts made before the
 *    restart are still there.
 */
import * as db from './db';
import { HTTPException } from './http';
import { fmtStamp } from './py';

const hits = new Map<string, number[]>();

/** name -> [max hits, window seconds]. Same buckets and numbers as the Python backend. */
export const LIMITS: Record<string, [number, number]> = {
  login: [10, 300.0],
  // Loose, because it counts refused attempts too and one address can be a whole
  // office. The real account-farming control is signupCeiling below.
  register: [60, 3600.0],
  reset_request: [5, 3600.0],
  download: [60, 3600.0],
  upload: [20, 3600.0],
  admin_write: [60, 300.0],
  // each checkout creates a real object at the payment provider
  checkout: [20, 3600.0],
  // looking at a price is not buying: previews get their own, generous bucket
  plan_preview: [120, 3600.0],
  // applying a change can create a payment at the provider
  plan_change: [10, 3600.0],
  // the unauthenticated DPDP endpoints: an IP bucket is the only handle there is
  contact: [5, 3600.0],
  privacy_request: [5, 3600.0],
  // the provider cannot hold a session, and every rejected delivery writes a row
  webhook: [120, 300.0],
  reset_confirm: [20, 3600.0],
  verify_confirm: [20, 3600.0],
  verify_resend: [5, 3600.0],
  verify_request: [5, 3600.0],
  // each Google callback makes two outbound calls
  oauth: [30, 900.0],
  // password-gated, so each attempt runs scrypt
  erase: [5, 3600.0],
};

/** A wait a person can act on, always rounded UP. */
export function inWords(seconds: number): string {
  if (seconds < 90) return 'a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}

/** Throw a 429 when the caller has had their share of this window. */
export function check(bucket: string, key: string, cost = 1): void {
  const [limit, window] = LIMITS[bucket] ?? [60, 300.0];
  const now = Date.now() / 1000;
  const ident = `${bucket}:${key}`;
  let q = hits.get(ident);
  if (!q) {
    q = [];
    hits.set(ident, q);
  }
  const cutoff = now - window;
  while (q.length && q[0] < cutoff) q.shift();
  if (q.length + cost > limit) {
    const retry = q.length ? Math.max(1, Math.trunc(window - (now - q[0]))) : Math.trunc(window);
    throw new HTTPException(429, `too many attempts; try again in ${inWords(retry)}`, { 'Retry-After': String(retry) });
  }
  for (let i = 0; i < cost; i++) q.push(now);
}

// ── the durable half: how many ACCOUNTS one address may create ────────────────
// Two windows on purpose: an hourly cap alone permits a slow trickle forever, a daily
// cap alone permits a burst of thirty in a minute.
export const SIGNUP_PER_IP_HOUR = parseInt(process.env.VS_SIGNUP_PER_IP_HOUR || '10', 10);
export const SIGNUP_PER_IP_DAY = parseInt(process.env.VS_SIGNUP_PER_IP_DAY || '30', 10);

/** [accounts from this address in the last hour, in the last day] */
export function signupCounts(ip: string): [number, number] {
  const now = Date.now();
  const hour = fmtStamp(new Date(now - 3600_000));
  const day = fmtStamp(new Date(now - 86400_000));
  const q = "SELECT COUNT(*) FROM users WHERE signup_ip=? AND created_at>=? AND role<>'erased'";
  return [Number(db.scalar(q, [ip, hour], 0) || 0), Number(db.scalar(q, [ip, day], 0) || 0)];
}

/**
 * Throw a 429 when this address has already created its share of accounts. Called after
 * the duplicate checks, so a refused registration never uses any of the allowance. An
 * unknown address ('?') is not counted against anybody.
 */
export function signupCeiling(ip: string | null | undefined): void {
  if (!ip || ip === '?') return;
  const [perHour, perDay] = signupCounts(ip);
  if (perHour >= SIGNUP_PER_IP_HOUR) {
    throw new HTTPException(
      429,
      'too many accounts have been created from this network in the last hour; try again later or contact us',
      { 'Retry-After': '3600' },
    );
  }
  if (perDay >= SIGNUP_PER_IP_DAY) {
    throw new HTTPException(
      429,
      'too many accounts have been created from this network today; try again tomorrow or contact us',
      { 'Retry-After': '86400' },
    );
  }
}

export function peek(bucket: string, key: string): { bucket: string; used: number; limit: number; window_s: number } {
  const [limit, window] = LIMITS[bucket] ?? [60, 300.0];
  const now = Date.now() / 1000;
  const q = hits.get(`${bucket}:${key}`) ?? [];
  return { bucket, used: q.filter((t) => t >= now - window).length, limit, window_s: window };
}

/** Forget everything, or one bucket. */
export function reset(bucket?: string | null): void {
  if (bucket == null) {
    hits.clear();
    return;
  }
  for (const k of [...hits.keys()]) if (k.startsWith(bucket + ':')) hits.delete(k);
}
