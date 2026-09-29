/**
 * Register, sign in, sign out, confirm an address, reset a password, Google sign-in,
 * and "who am I".
 *
 * Every message, status code and cookie here is the one the Python backend produced;
 * the dashboard branches on the `code` fields of the structured refusals and on nothing
 * else.
 */
import type { Request, Response } from 'express';
import { COOKIE_SECURE, FIRST_USER_IS_ADMIN, PUBLIC_BASE_URL, PUBLIC_BASE_URL_EXPLICIT, SESSION_COOKIE } from '../config';
import * as consent from '../consent';
import { deleteCookie, requestCookies, setCookie } from '../cookies';
import * as db from '../db';
import type { Row } from '../db';
import { clientIp, current, requireCsrf, requireUser } from '../deps';
import * as emails from '../emails';
import { ApiRouter, HTTPException, RedirectResponse, baseUrl, header, pyQuote } from '../http';
import * as notify from '../notify';
import * as oauth from '../oauth';
import * as passwords from '../passwords';
import { addSeconds, fmtStamp, pySlice, pyStr, pyStrip, safeEqual, tokenUrlsafe } from '../py';
import * as ratelimit from '../ratelimit';
import * as security from '../security';
import { Model, optional, required, t } from '../validate';

// How long a confirmation link is good for: generous, so the next morning still works.
export const VERIFY_TTL_HOURS = 24;

// Whether a missing consent tick REFUSES the registration. Off by default so internal
// scripts keep working; the DPDP readiness report flags it until it is on.
const REQUIRE_SIGNUP_CONSENT = process.env.VS_REQUIRE_SIGNUP_CONSENT === '1';

export const router = new ApiRouter('/api/auth', ['auth']);

// The alias refusal carries a CODE: it is a 409 like a duplicate, but means "that address
// reaches an inbox that already has an account", and the UI needs different words. It
// never names the address it collided with.
const SAME_INBOX = {
  code: 'inbox_already_registered',
  message: 'that address reaches an inbox that already has an account - sign in instead, or use the password reset link',
};

const Credentials = new Model('Credentials', {
  email: required(t.email()),
  password: required(t.str({ minLength: 8, maxLength: 200 })),
});

// Registration carries the consent collected on the form; separate from Credentials so
// signing in consents to nothing.
const Registration = new Model('Registration', {
  email: required(t.email()),
  password: required(t.str({ minLength: 8, maxLength: 200 })),
  consent: optional(t.nullable(t.dict(t.bool())), null),
});

const VerifyConfirm = new Model('VerifyConfirm', { token: required(t.str()) });
const VerifyRequest = new Model('VerifyRequest', { email: required(t.email()) });
const ResetRequest = new Model('ResetRequest', { email: required(t.email()) });
const ResetConfirm = new Model('ResetConfirm', {
  token: required(t.str()),
  password: required(t.str({ minLength: 8, maxLength: 200 })),
});

/**
 * The origin emailed links are built from. VS_PUBLIC_BASE_URL wins whenever it is set:
 * behind nginx the request's own base URL is the loopback address, and a confirmation
 * link to 127.0.0.1 is one nobody can act on.
 */
export function emailBase(req: Request): string {
  if (PUBLIC_BASE_URL_EXPLICIT) return PUBLIC_BASE_URL.replace(/\/+$/, '');
  return baseUrl(req).replace(/\/+$/, '');
}

/** Mint a fresh confirmation token, store only its hash, mail the raw one. */
async function issueVerification(userId: number, email: string, base: string): Promise<void> {
  const raw = tokenUrlsafe(32);
  const expires = fmtStamp(addSeconds(new Date(), VERIFY_TTL_HOURS * 3600));
  db.execute('UPDATE users SET verify_token_sha256=?, verify_expires_at=? WHERE id=?', [security.sha256(raw), expires, userId]);
  await notify.verifyEmail(email, userId, raw, base);
}

/** Python's `x.lower().strip()` on an address. */
function lowerStrip(s: string): string {
  return pyStrip(s.toLowerCase());
}

function ua(req: Request): string | null {
  return header(req, 'user-agent');
}

router.post('/register', { name: 'register', body: Registration }, async (req, res, { body }) => {
  ratelimit.check('register', clientIp(req));
  const email = lowerStrip(body.email);
  // One value per real INBOX, not per string.
  const canonical = emails.normalise(email);

  // DPDP s.6(1): the box has to gate something. Checked before anything is created.
  const given: Record<string, boolean> = body.consent || {};
  if (REQUIRE_SIGNUP_CONSENT) {
    const missing = Object.entries(consent.PURPOSES).filter(([p, v]) => v.where === 'signup' && v.required && !given[p]);
    if (missing.length) throw new HTTPException(400, 'you have to accept the Terms and the Privacy Notice to create an account');
  }

  // A throwaway inbox defeats the confirmation gate at zero cost.
  if (emails.ENFORCE_DISPOSABLE && emails.isDisposable(email)) {
    throw new HTTPException(
      400,
      'that looks like a temporary email service. Please sign up with an address you can receive mail at - you will need it to confirm your account.',
    );
  }
  if (db.one('SELECT 1 FROM users WHERE email=?', [email])) throw new HTTPException(409, 'that email is already registered');
  if (canonical !== email && db.one('SELECT 1 FROM users WHERE email_normalised=?', [canonical])) throw new HTTPException(409, SAME_INBOX);

  // checked before the row is written, so a refused password leaves nothing behind
  try {
    await passwords.check(body.password);
  } catch (e) {
    if (e instanceof passwords.WeakPassword) throw new HTTPException(400, e.message);
    throw e;
  }

  // LAST of the refusals: this ceiling counts accounts actually created.
  const ip = clientIp(req);
  ratelimit.signupCeiling(ip);

  const isFirst = db.scalar('SELECT COUNT(*) FROM users', [], 0) === 0;
  const role = isFirst && FIRST_USER_IS_ADMIN ? 'admin' : 'user';
  // the operator's first account is trusted immediately: nobody to confirm it to
  const verifiedAt = isFirst && FIRST_USER_IS_ADMIN ? db.now() : null;
  const passwordHash = await security.hashPassword(body.password);
  let userId: number;
  try {
    const cur = db.execute(
      'INSERT INTO users (email, password_hash, role, created_at, email_verified_at, email_normalised, signup_ip, signup_user_agent, status) VALUES (?,?,?,?,?,?,?,?,\'active\')',
      [email, passwordHash, role, db.now(), verifiedAt, canonical, ip, pySlice(ua(req) || '', 300) || null],
    );
    userId = cur.lastrowid;
  } catch (e) {
    // the UNIQUE index, not the check above: two registrations of one inbox raced
    if (db.isIntegrityError(e)) throw new HTTPException(409, SAME_INBOX);
    throw e;
  }

  // best-effort: a mail failure must not cost somebody the account they just created
  if (verifiedAt === null) {
    try {
      await issueVerification(userId, email, emailBase(req));
    } catch {
      /* /verify/resend exists for this */
    }
  }

  // Pressing the button is the affirmative action: 'terms_acceptance', never overstated.
  if (Object.keys(given).length) {
    try {
      consent.recordMany({ userId, email, granted: given, ip: clientIp(req), userAgent: ua(req), method: 'terms_acceptance' });
    } catch {
      /* best effort */
    }
  }

  // REGISTERING DOES NOT SIGN YOU IN: sign-in requires a confirmed address, so handing
  // out a session here would make that gate decorative.
  if (verifiedAt === null) {
    return {
      id: userId,
      email,
      role,
      verification_required: true,
      note: `check your inbox for a confirmation link, then sign in - the link is good for ${VERIFY_TTL_HOURS} hours`,
    };
  }
  const [token, csrf] = security.createSession(userId, clientIp(req), ua(req));
  security.setSessionCookie(res, token);
  return { id: userId, email, role, csrf, verification_required: false, note: role === 'admin' ? 'first account, so it is the admin' : null };
});

router.post('/login', { name: 'login', body: Credentials }, async (req, res, { body }) => {
  // per IP AND per account: either alone can be worked around
  ratelimit.check('login', clientIp(req));
  ratelimit.check('login', lowerStrip(body.email));
  const email = lowerStrip(body.email);
  const user = db.one('SELECT * FROM users WHERE email=?', [email]);
  // the same message either way, so it cannot enumerate accounts
  if (!user || !(await security.verifyPassword(body.password, user.password_hash))) throw new HTTPException(401, 'wrong email or password');

  // Both refusals below come AFTER the password is proven, so they reveal nothing to
  // somebody not already holding the credentials. Suspension first: it is the stronger
  // fact, and the one reading email cannot fix.
  if ('status' in user && user.status === 'suspended') {
    throw new HTTPException(403, {
      code: 'account_suspended',
      message: 'this account has been suspended. Use the contact form and we will look into it.',
      email: user.email,
    });
  }
  const verified = 'email_verified_at' in user ? user.email_verified_at : null;
  if (!verified) {
    throw new HTTPException(403, {
      code: 'email_not_confirmed',
      message: 'confirm your email address before signing in - we sent a link when you registered, and you can ask for another',
      email: user.email,
    });
  }
  const [token, csrf] = security.createSession(user.id, clientIp(req), ua(req));
  security.setSessionCookie(res, token);
  return { id: user.id, email: user.email, role: user.role, csrf };
});

/** Revokes the session server-side, which is what makes it a real logout. CSRF-checked. */
router.post('/logout', { name: 'logout' }, (req, res) => {
  const [sess] = current(req);
  if (sess) {
    requireCsrf(req);
    security.revokeSession(sess.id);
  }
  // mirror the attributes the cookie was SET with, or some browsers keep the dead one
  deleteCookie(res, SESSION_COOKIE, { path: '/', httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax' });
  return { ok: true };
});

/**
 * Confirm an address, and sign the person in. The token is the credential — 32 random
 * bytes, hashed at rest, single use, 24 hours, delivered to their own inbox — so it is
 * the same proof a reset link carries, which is allowed to do strictly more.
 */
router.post('/verify', { name: 'verify_confirm', body: VerifyConfirm }, (req, res, { body }) => {
  ratelimit.check('verify_confirm', clientIp(req));
  const h = security.sha256(body.token);
  const user = db.one('SELECT * FROM users WHERE verify_token_sha256=? AND verify_expires_at>=?', [h, db.now()]);
  if (!user) throw new HTTPException(400, 'that confirmation link is invalid or has expired');

  // a suspended account must not be signed in by a stale link
  if ('status' in user && user.status === 'suspended') {
    throw new HTTPException(403, {
      code: 'account_suspended',
      message: 'this address is confirmed, but the account has been suspended. Use the contact form and we will look into it.',
      email: user.email,
    });
  }
  const already = Boolean(user.email_verified_at);
  if (already) {
    // clicking twice, or confirming through Google first, is normal
    db.execute('UPDATE users SET verify_token_sha256=NULL, verify_expires_at=NULL WHERE id=?', [user.id]);
  } else {
    db.execute('UPDATE users SET email_verified_at=?, verify_token_sha256=NULL, verify_expires_at=NULL WHERE id=?', [db.now(), user.id]);
  }
  const [token, csrf] = security.createSession(user.id, clientIp(req), ua(req));
  security.setSessionCookie(res, token);
  return {
    ok: true,
    already,
    email: user.email,
    id: user.id,
    role: user.role,
    csrf,
    signed_in: true,
    note: 'your address is confirmed and you are signed in',
  };
});

/** Another confirmation link, to the signed-in account's own address. */
router.post('/verify/resend', { name: 'verify_resend' }, async (req) => {
  const user = requireUser(req);
  requireCsrf(req);
  ratelimit.check('verify_resend', String(user.id));
  if (user.email_verified_at) return { ok: true, already: true, note: 'this address is already confirmed' };
  try {
    await issueVerification(user.id, user.email, emailBase(req));
  } catch {
    throw new HTTPException(502, 'could not send the confirmation email just now');
  }
  return { ok: true, sent_to: user.email, expires_in_hours: VERIFY_TTL_HOURS };
});

/**
 * Another confirmation link for somebody who cannot sign in to ask for one. Answers the
 * same way whether or not the address exists or is confirmed; limited per IP and per
 * address, because the cost lands in somebody else's inbox.
 */
router.post('/verify/request', { name: 'verify_request', body: VerifyRequest }, async (req, _res, { body }) => {
  ratelimit.check('verify_request', clientIp(req));
  const email = lowerStrip(body.email);
  ratelimit.check('verify_request', email);
  const user = db.one('SELECT * FROM users WHERE email=?', [email]);
  if (user && !user.email_verified_at) {
    try {
      await issueVerification(user.id, email, emailBase(req));
    } catch {
      /* must not tell the caller the address is real */
    }
  }
  return { ok: true, note: `if that address needs confirming, a new link is on its way; it is good for ${VERIFY_TTL_HOURS} hours` };
});

/** Ask for a reset link. Always the same answer, so it cannot find out who has an account. */
router.post('/reset/request', { name: 'reset_request', body: ResetRequest }, async (req, _res, { body }) => {
  ratelimit.check('reset_request', clientIp(req));
  const email = lowerStrip(body.email);
  ratelimit.check('reset_request', email);
  const user = db.one('SELECT * FROM users WHERE email=?', [email]);
  if (user) {
    const raw = tokenUrlsafe(32);
    const expires = fmtStamp(addSeconds(new Date(), 30 * 60));
    db.execute('UPDATE users SET reset_token_sha256=?, reset_expires_at=? WHERE id=?', [security.sha256(raw), expires, user.id]);
    await notify.passwordReset(email, user.id, raw, emailBase(req));
  }
  return { ok: true, note: 'if that address has an account, a reset link has been sent' };
});

/** Single use, and it signs every existing session out: a reset that leaves them alive is not one. */
router.post('/reset/confirm', { name: 'reset_confirm', body: ResetConfirm }, async (req, _res, { body }) => {
  ratelimit.check('reset_confirm', clientIp(req));
  // the same password policy as registration; a reset was the way around it otherwise
  try {
    await passwords.check(body.password);
  } catch (e) {
    if (e instanceof passwords.WeakPassword) throw new HTTPException(400, e.message);
    throw e;
  }
  const h = security.sha256(body.token);
  const user = db.one('SELECT * FROM users WHERE reset_token_sha256=? AND reset_expires_at>=?', [h, db.now()]);
  if (!user) throw new HTTPException(400, 'that reset link is invalid or has expired');
  const hash = await security.hashPassword(body.password);
  db.execute('UPDATE users SET password_hash=?, reset_token_sha256=NULL, reset_expires_at=NULL WHERE id=?', [hash, user.id]);
  const killed = security.revokeAllForUser(user.id);
  return { ok: true, sessions_revoked: killed };
});

// ── Google sign-in ────────────────────────────────────────────────────────────
// Both endpoints are browser navigations, so the callback cannot usefully return an
// error body: every failure redirects to /login with a short code instead.

/** Where to land after signing in — only a same-site absolute path, never `//elsewhere`. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/app';
  return raw;
}

/** 404, not 501: the feature exists or it does not, and nothing more is announced. */
function oauthUnavailable(): HTTPException {
  return new HTTPException(404, 'not found');
}

router.get('/google/start', { name: 'google_start', query: { next: optional(t.nullable(t.str()), null) } }, (req, res, { next }) => {
  if (!oauth.configured()) throw oauthUnavailable();
  ratelimit.check('oauth', clientIp(req));
  const [state, verifier, sealed] = oauth.newAttempt(safeNext(next));
  // LAX, not strict: the return from Google is a cross-site navigation
  setCookie(res, oauth.STATE_COOKIE, sealed, { maxAge: oauth.STATE_TTL_S, httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' });
  return new RedirectResponse(oauth.authorizeUrl(state, verifier), 307);
});

/** A Google identity we will not sign in, with the code that says why. */
export class OAuthRefused extends Error {
  override name = 'OAuthRefused';
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Google's answer, as a row in `users`: find by `sub`, link an existing account (Google
 * has proven the address, which also confirms it), or create one. Refuses an unverified
 * address, a tombstoned (erased) account, and two Google accounts claiming one mailbox.
 * Returns [user, wasCreated].
 */
export function googleUpsert(info: Record<string, any>, ip: string | null = null, userAgent: string | null = null): [Row, boolean] {
  const sub = pyStrip(pyStr(info.sub || ''));
  const email = pyStrip(pyStr(info.email || '').toLowerCase());
  if (!sub || !email) throw new OAuthRefused('google_failed');
  // Google must have verified the address itself: this is what makes linking safe
  if (!info.email_verified) throw new OAuthRefused('google_unverified');

  const canonical = emails.normalise(email);
  // by `sub`, never by address: a Google account's address can change
  const user = db.one('SELECT * FROM users WHERE google_sub=?', [sub]);
  if (user) return [user, false];

  let existing = db.one('SELECT * FROM users WHERE email=?', [email]);
  // same inbox, different spelling (safe here: the domain is Google-hosted)
  if (!existing && canonical !== email) {
    existing = db.one('SELECT * FROM users WHERE email_normalised=?', [canonical]);
    if (existing && existing.google_sub && existing.google_sub !== sub) throw new OAuthRefused('google_failed');
  }
  // an erased account is a tombstone; reviving it would undo a deletion
  if (existing && existing.role === 'erased') throw new OAuthRefused('account_closed');
  if (existing) {
    db.execute('UPDATE users SET google_sub=?, email_verified_at=COALESCE(email_verified_at, ?) WHERE id=?', [sub, db.now(), existing.id]);
    return [db.one('SELECT * FROM users WHERE id=?', [existing.id])!, false];
  }

  // a NEW account: the same ceiling /register obeys (this path never touches an inbox)
  ratelimit.signupCeiling(ip);
  const isFirst = db.scalar('SELECT COUNT(*) FROM users', [], 0) === 0;
  const role = isFirst && FIRST_USER_IS_ADMIN ? 'admin' : 'user';
  // deliberately NOT a valid scrypt string, so every password check fails closed on it
  const unusable = `oauth-google$${tokenUrlsafe(32)}`;
  let id: number;
  try {
    const cur = db.execute(
      "INSERT INTO users (email, password_hash, role, created_at, email_verified_at, google_sub, email_normalised, signup_ip, signup_user_agent, status) VALUES (?,?,?,?,?,?,?,?,?,'active')",
      [email, unusable, role, db.now(), db.now(), sub, canonical, ip, pySlice(userAgent || '', 300) || null],
    );
    id = cur.lastrowid;
  } catch (e) {
    if (!db.isIntegrityError(e)) throw e;
    // two callbacks for one mailbox raced: resolve to the winner's row
    const landed = db.one('SELECT * FROM users WHERE email_normalised=?', [canonical]);
    if (landed) return [landed, false];
    throw new OAuthRefused('google_failed');
  }
  return [db.one('SELECT * FROM users WHERE id=?', [id])!, true];
}

/** Back to sign-in with a code the app can turn into a sentence. */
function oauthFail(res: Response, reason: string): RedirectResponse {
  deleteCookie(res, oauth.STATE_COOKIE, { path: '/' });
  return new RedirectResponse(`/login?oauth_error=${pyQuote(reason)}`, 307);
}

router.get(
  '/google/callback',
  {
    name: 'google_callback',
    query: {
      code: optional(t.nullable(t.str()), null),
      state: optional(t.nullable(t.str()), null),
      error: optional(t.nullable(t.str()), null),
    },
  },
  async (req, res, { code, state, error }) => {
    if (!oauth.configured()) throw oauthUnavailable();
    ratelimit.check('oauth', clientIp(req));

    // the person pressed Cancel on Google's screen
    if (error) return oauthFail(res, 'cancelled');

    const attempt = oauth.openAttempt(requestCookies(req)[oauth.STATE_COOKIE]);
    // missing, forged or stale: almost always a stale tab, so "try again"
    if (!attempt) return oauthFail(res, 'expired');
    if (!code || !state || !safeEqual(state, pyStr(attempt.s ?? null))) return oauthFail(res, 'state_mismatch');

    const nextPath = safeNext(pyStr(attempt.n || '/app'));
    let info: Record<string, any>;
    try {
      const tokens = await oauth.exchangeCode(code, pyStr(attempt.v ?? null));
      info = await oauth.identity(tokens.access_token || '');
    } catch (e) {
      // logged, not shown: the text carries our client id and redirect URI
      console.log(`  google auth : ${(e as Error).message ?? e}`);
      return oauthFail(res, 'google_failed');
    }

    let user: Row;
    let created: boolean;
    try {
      [user, created] = googleUpsert(info, clientIp(req), ua(req));
    } catch (e) {
      if (e instanceof OAuthRefused) return oauthFail(res, e.code);
      throw e;
    }

    if (created) {
      // the same consent record a form signup writes, on creation only
      try {
        consent.recordMany({ userId: user.id, email: user.email, granted: { service_terms: true }, ip: clientIp(req), userAgent: ua(req), method: 'terms_acceptance' });
      } catch {
        /* best effort */
      }
      // no confirmation email to send, so a welcome instead
      try {
        await notify.welcomeGoogle(user.email, user.id, emailBase(req));
      } catch {
        /* best effort */
      }
    }

    // no CSRF in a redirect: the app reads it from /api/auth/me on its next boot
    const [token] = security.createSession(user.id, clientIp(req), ua(req));
    security.setSessionCookie(res, token);
    // one-shot: a replayed callback URL must not find a valid verifier
    deleteCookie(res, oauth.STATE_COOKIE, { path: '/' });
    return new RedirectResponse(nextPath, 307);
  },
);

router.get('/me', { name: 'me' }, (req) => {
  const [sess, user] = current(req);
  if (!user) throw new HTTPException(401, 'not signed in');
  const verifiedAt = 'email_verified_at' in user ? user.email_verified_at : null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    csrf: sess!.csrf,
    // so the dashboard can explain WHY uploading is refused
    email_verified: Boolean(verifiedAt),
    entitlement: db.entitlement(user.id),
  };
});
