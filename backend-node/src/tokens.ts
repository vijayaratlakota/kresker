/**
 * Short-lived, signed download tokens.
 *
 * The storage bucket is private and has no public URL. Our API makes the access decision
 * and hands out a token that names ONE object and expires in about five minutes. The
 * thing that serves the bytes never decides anything; it only verifies a decision the
 * API already made.
 *
 * HMAC-SHA256 over the payload with the installation secret, so it cannot be forged or
 * edited, and it carries no secret itself.
 *
 * THE BYTES ARE THE PYTHON BACKEND'S. Compact, key-sorted, ASCII-escaped JSON, base64url
 * without padding, signed with the same `secret.key`. A link minted by either backend
 * opens on the other, which is what makes switching between them invisible to somebody
 * halfway through a download.
 */
import { createHmac } from 'node:crypto';
import { DOWNLOAD_TOKEN_TTL_S, appSecret } from './config';
import { epochSeconds, pyDumps, pyRpartition, safeEqual } from './py';

function b64e(raw: Buffer): string {
  return raw.toString('base64url');
}

function sign(body: string): string {
  return b64e(createHmac('sha256', appSecret()).update(Buffer.from(body, 'ascii')).digest());
}

export class TokenError extends Error {
  override name = 'TokenError';
}

export interface TokenPayload {
  j: string;
  k: string;
  u: number;
  e: number;
  v?: string;
  d?: string;
  [k: string]: unknown;
}

/**
 * A token naming exactly one object, in one format, for one user, briefly.
 *
 * `variant` says WHICH rendition ('video', or 'm4a' / 'mp3' / 'wav'); `inline` says the
 * browser should play it rather than save it. Both are inside the signed payload, so a
 * player URL cannot be edited into a download of a different format.
 */
export function mint(
  jobId: string,
  objectKey: string,
  userId: number,
  ttlS?: number | null,
  variant = 'video',
  inline = false,
): string {
  const payload: Record<string, unknown> = {
    j: jobId,
    k: objectKey,
    u: Math.trunc(Number(userId)),
    e: epochSeconds() + Math.trunc(Number(ttlS || DOWNLOAD_TOKEN_TTL_S)),
  };
  // Only written when not the default, so every older token still verifies byte for byte.
  if (variant && variant !== 'video') payload.v = variant;
  if (inline) payload.d = 'inline';
  const body = b64e(Buffer.from(pyDumps(payload, { separators: [',', ':'], sortKeys: true }), 'utf8'));
  return `${body}.${sign(body)}`;
}

/** The payload, or throws. The signature is checked before anything is parsed. */
export function verify(token: string | null | undefined): TokenPayload {
  if (!token || !token.includes('.')) throw new TokenError('malformed token');
  const [body, , sig] = pyRpartition(token, '.');
  // Constant time, so a wrong signature cannot be probed byte by byte.
  if (!safeEqual(sig, sign(body))) throw new TokenError('bad signature');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('unreadable payload');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('e' in payload)) {
    throw new TokenError('incomplete payload');
  }
  const p = payload as TokenPayload;
  if (Math.trunc(Number(p.e)) < epochSeconds()) throw new TokenError('token expired');
  return p;
}
