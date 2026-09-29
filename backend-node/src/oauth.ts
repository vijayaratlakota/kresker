/**
 * Google sign-in: the parts that talk to Google, and the state that survives the trip.
 *
 * Authorization Code with PKCE. The browser is sent to Google, comes back with a
 * one-time `code`, and THIS SERVER exchanges it for tokens over its own TLS connection,
 * using the client secret. The browser never holds a token, and the identity comes from
 * Google's userinfo endpoint over that same verified channel — so there is no JWT
 * signature to check and no crypto to hand-roll.
 *
 *   * `state` is CSRF protection for the callback: minted here, sealed into a cookie an
 *     attacker cannot write, compared on the way back.
 *   * PKCE binds the code to THIS attempt: an intercepted code is useless without the
 *     verifier, which never leaves this server's cookie.
 *
 * The sealed cookie is HMAC'd with the shared `secret.key`, in the Python backend's
 * exact format, so a sign-in started on one backend can finish on the other.
 */
import { createHash, createHmac } from 'node:crypto';
import { GOOGLE_ENV_FILE, GOOGLE_REDIRECT_URI, appSecret, readEnvFile } from './config';
import { urlencode } from './http';
import { epochSeconds, pyDumps, pyRpartition, pySlice, pyStrip, safeEqual, tokenUrlsafe } from './py';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

// Only what identifies the person. No refresh token: nothing here ever acts as them later.
const SCOPES = 'openid email profile';

export const STATE_COOKIE = 'vs_oauth';
export const STATE_TTL_S = 600;

let cfg: Record<string, string> | null = null;

function fileCfg(): Record<string, string> {
  if (cfg === null) cfg = readEnvFile(GOOGLE_ENV_FILE);
  return cfg;
}

export function clientId(): string {
  return pyStrip(process.env.VS_GOOGLE_CLIENT_ID || fileCfg().GOOGLE_CLIENT_ID || '');
}

export function clientSecret(): string {
  return pyStrip(process.env.VS_GOOGLE_CLIENT_SECRET || fileCfg().GOOGLE_CLIENT_SECRET || '');
}

/** Both halves present. Anything less and the feature stays invisible. */
export function configured(): boolean {
  return Boolean(clientId() && clientSecret());
}

/** For the admin panel. Never the secret, only whether there is one. */
export function status(): Record<string, unknown> {
  return {
    configured: configured(),
    client_id: clientId() || null,
    secret_present: Boolean(clientSecret()),
    redirect_uri: GOOGLE_REDIRECT_URI,
    env_file: GOOGLE_ENV_FILE,
    note: 'this redirect URI has to be registered in the Google Cloud console character for character, or Google answers redirect_uri_mismatch',
  };
}

// ── the sealed state cookie ───────────────────────────────────────────────────

function b64(raw: Buffer): string {
  return raw.toString('base64url');
}

function sign(body: string): string {
  return b64(createHmac('sha256', appSecret()).update(Buffer.from(body, 'ascii')).digest());
}

export interface Attempt {
  s: string;
  v: string;
  n: string;
  e: number;
  [k: string]: unknown;
}

/** Start a sign-in. Returns [state, verifier, sealed cookie value]. */
export function newAttempt(nextPath: string): [string, string, string] {
  const state = tokenUrlsafe(24);
  const verifier = tokenUrlsafe(64); // 86 chars, inside PKCE's 43-128
  const payload = { s: state, v: verifier, n: nextPath, e: epochSeconds() + STATE_TTL_S };
  const body = b64(Buffer.from(pyDumps(payload, { separators: [',', ':'] }), 'utf8'));
  return [state, verifier, `${body}.${sign(body)}`];
}

/** Unseal the cookie, or null if it is missing, forged or stale. Fails closed on everything. */
export function openAttempt(cookie: string | null | undefined): Attempt | null {
  if (!cookie || !cookie.includes('.')) return null;
  const [body, , sig] = pyRpartition(cookie, '.');
  if (!/^[\x00-\x7f]*$/.test(body)) return null;
  if (!safeEqual(sig, sign(body))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Attempt;
  if (Math.trunc(Number(p.e || 0)) < epochSeconds()) return null;
  return p;
}

/** The S256 PKCE challenge: base64url(sha256(verifier)), unpadded. */
export function challengeFor(verifier: string): string {
  return b64(createHash('sha256').update(Buffer.from(verifier, 'ascii')).digest());
}

export function authorizeUrl(state: string, verifier: string): string {
  return (
    AUTH_ENDPOINT +
    '?' +
    urlencode({
      client_id: clientId(),
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      state,
      code_challenge: challengeFor(verifier),
      code_challenge_method: 'S256',
      // so a person with two Google accounts is asked which one
      prompt: 'select_account',
    })
  );
}

// ── the two calls to Google ───────────────────────────────────────────────────

export class OAuthError extends Error {
  override name = 'RuntimeError';
}

/** Swap the one-time code for tokens. Throws on anything that is not a 200. */
export async function exchangeCode(code: string, verifier: string): Promise<Record<string, any>> {
  const r = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: urlencode({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  // The body names the cause: redirect_uri_mismatch and invalid_client happen in practice.
  if (r.status !== 200) throw new OAuthError(`google token exchange ${r.status}: ${pySlice(text, 300)}`);
  return JSON.parse(text);
}

/** Who Google says this is: sub, email, email_verified, name, picture. */
export async function identity(accessToken: string): Promise<Record<string, any>> {
  const r = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (r.status !== 200) throw new OAuthError(`google userinfo ${r.status}: ${pySlice(text, 300)}`);
  return JSON.parse(text);
}
