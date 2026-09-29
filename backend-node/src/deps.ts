/**
 * Request-scoped helpers: who is calling, and may they.
 *
 * Every query that touches user data is scoped by the session's own user id, inside the
 * query itself. Admin routes are the single deliberate exception, and they carry an
 * explicit role check.
 */
import type { Request } from 'express';
import { CSRF_HEADER, SESSION_COOKIE, TRUSTED_PROXIES } from './config';
import { requestCookies } from './cookies';
import * as db from './db';
import type { Row } from './db';
import { HTTPException, header } from './http';
import * as security from './security';

/**
 * The caller's address, believed only when it is not the caller who said so.
 *
 * X-Forwarded-For is a request header: anyone can send it. It is honoured only when the
 * connecting peer is a proxy listed in VS_TRUSTED_PROXIES; otherwise the socket address
 * is used, which cannot be spoofed over TCP.
 */
export function clientIp(req: Request): string {
  const peer = req.vs.client ?? '?';
  if (TRUSTED_PROXIES.has(peer)) {
    const fwd = header(req, 'x-forwarded-for');
    if (fwd) {
      // Left-most entry is the original client; the rest are proxy hops.
      const first = fwd.split(',')[0].trim();
      if (first) return first;
    }
  }
  return peer;
}

/**
 * The session and user behind this request, or [null, null].
 *
 * Also slides an active session's expiry. The browser's copy of the cookie has to be
 * re-sent to match, and only the response can do that, so the decision is noted on
 * `req.state` and the refresh-cookie middleware acts on it.
 */
export function current(req: Request): [Row, Row] | [null, null] {
  const raw = requestCookies(req)[SESSION_COOKIE];
  const [sess, user] = security.loadSession(raw);
  if (sess !== null && raw) {
    try {
      if (security.slideSession(sess)) req.state.vs_refresh_cookie = raw;
    } catch {
      // Never let keeping somebody signed in be the thing that fails their request.
    }
  }
  return [sess, user] as [Row, Row] | [null, null];
}

/**
 * The signed-in account, and it must be in good standing. Every authenticated route goes
 * through here, so a suspension holds on routes nobody remembered to list.
 */
export function requireUser(req: Request): Row {
  const [, user] = current(req);
  if (!user) throw new HTTPException(401, 'not signed in');
  if ('status' in user && user.status === 'suspended') {
    throw new HTTPException(403, {
      code: 'account_suspended',
      message:
        'this account has been suspended. Reply to your signup ' +
        'confirmation or use the contact form and we will look ' +
        'into it.',
    });
  }
  return user;
}

/** Two independent defences, because SameSite behaviour varies by browser. */
export function requireCsrf(req: Request): void {
  const [sess] = current(req);
  if (!sess) throw new HTTPException(401, 'not signed in');
  const sent = header(req, CSRF_HEADER);
  if (!sent || sent !== sess.csrf) throw new HTTPException(403, 'bad or missing CSRF token');
}

export function requireAdmin(req: Request): Row {
  const user = requireUser(req);
  // 404 rather than 403, so the panel's existence is not confirmed to a non-admin
  if (user.role !== 'admin') throw new HTTPException(404, 'not found');
  return user;
}

/**
 * Money-moving admin actions ask for the password again, so a stolen session cannot
 * silently grant subscriptions or issue refunds.
 */
export async function reauth(req: Request, password: string | null | undefined): Promise<Row> {
  const admin = requireAdmin(req);
  if (!password || !(await security.verifyPassword(password, admin.password_hash))) {
    throw new HTTPException(403, 'this action needs your password again');
  }
  return admin;
}

/** Someone else's job id is a 404, never a 403 — a 403 would confirm the row exists. */
export function ownedJob(user: Row, jobId: string): Row {
  const row = db.one('SELECT * FROM jobs WHERE id=? AND user_id=?', [jobId, user.id]);
  if (!row) throw new HTTPException(404, 'not found');
  return row;
}
