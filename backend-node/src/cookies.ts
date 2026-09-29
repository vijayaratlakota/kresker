/**
 * Cookies, written and read exactly the way the Python backend's framework (Starlette)
 * writes and reads them.
 *
 * Exactness matters here for one reason: the session cookie is shared across a switch
 * between the two backends. A cookie written by one must be read identically by the
 * other, and the attributes on a refreshed cookie must be the attributes it was set
 * with, or some browsers keep two copies and send the stale one.
 *
 * The Set-Cookie line is built the way Python's `http.cookies.Morsel` builds it:
 * `key=value` and then the attributes sorted by name — `HttpOnly; Max-Age=...; Path=/;
 * SameSite=lax; Secure`.
 */
import type { Request, Response } from 'express';
import { pyStrip } from './py';

// http.cookies._LegalChars: a value made only of these is written unquoted.
const LEGAL = /^[A-Za-z0-9!#$%&'*+\-.^_`|~:]+$/;
// http.cookies._UnescapedChars: the rest are written as \ooo inside quotes.
const UNESCAPED = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-.^_`|~: ()/<=>?@[]{}"]);

/** http.cookies._quote */
function quote(v: string): string {
  if (LEGAL.test(v)) return v;
  let out = '"';
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c < 256 && !UNESCAPED.has(ch)) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + '"';
}

/** http.cookies._unquote */
function unquote(v: string): string {
  if (v.length < 2 || v[0] !== '"' || v[v.length - 1] !== '"') return v;
  return v.slice(1, -1).replace(/\\(?:([0-3][0-7][0-7])|([\s\S]))/g, (_m, oct?: string, ch?: string) =>
    oct ? String.fromCharCode(parseInt(oct, 8)) : (ch as string),
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** http.cookies._getdate(future): "Wdy, DD Mon YYYY HH:MM:SS GMT". */
function getdate(futureS: number): string {
  const d = new Date(Date.now() + futureS * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${WEEKDAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).padStart(4, ' ')} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`
  );
}

export interface CookieOptions {
  maxAge?: number | null;
  /** Seconds from now (Python's int form) or a preformatted date string. */
  expires?: number | string | null;
  path?: string | null;
  domain?: string | null;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'lax' | 'strict' | 'none' | null;
}

/** The Set-Cookie header value Starlette's Response.set_cookie produces. */
export function formatCookie(key: string, value: string, o: CookieOptions = {}): string {
  const attrs: Array<[string, string | true]> = [];
  // Morsel attribute keys, which is what they are sorted by.
  if (o.domain != null && o.domain !== '') attrs.push(['domain', `Domain=${o.domain}`]);
  if (o.expires != null && o.expires !== '') {
    attrs.push(['expires', `expires=${typeof o.expires === 'number' ? getdate(o.expires) : o.expires}`]);
  }
  if (o.httpOnly) attrs.push(['httponly', 'HttpOnly']);
  if (o.maxAge != null) attrs.push(['max-age', `Max-Age=${Math.trunc(o.maxAge)}`]);
  const path = o.path === undefined ? '/' : o.path;
  if (path != null && path !== '') attrs.push(['path', `Path=${path}`]);
  const sameSite = o.sameSite === undefined ? 'lax' : o.sameSite;
  if (sameSite != null) attrs.push(['samesite', `SameSite=${sameSite}`]);
  if (o.secure) attrs.push(['secure', 'Secure']);
  attrs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [`${key}=${quote(value)}`, ...attrs.map((a) => a[1] as string)].join('; ');
}

/** Response.set_cookie */
export function setCookie(res: Response, key: string, value: string, o: CookieOptions = {}): void {
  res.append('Set-Cookie', formatCookie(key, value, o));
}

/** Response.delete_cookie: an empty value, Max-Age=0 and an expiry of "now". */
export function deleteCookie(
  res: Response,
  key: string,
  o: { path?: string; domain?: string | null; secure?: boolean; httpOnly?: boolean; sameSite?: 'lax' | 'strict' | 'none' | null } = {},
): void {
  setCookie(res, key, '', {
    maxAge: 0,
    expires: 0,
    path: o.path ?? '/',
    domain: o.domain ?? null,
    secure: o.secure ?? false,
    httpOnly: o.httpOnly ?? false,
    sameSite: o.sameSite === undefined ? 'lax' : o.sameSite,
  });
}

/** starlette.requests.cookie_parser: browser-tolerant, later duplicates win. */
export function parseCookieHeader(header: string, into: Record<string, string> = {}): Record<string, string> {
  for (const chunk of header.split(';')) {
    let key: string;
    let val: string;
    const i = chunk.indexOf('=');
    if (i >= 0) {
      key = chunk.slice(0, i);
      val = chunk.slice(i + 1);
    } else {
      key = '';
      val = chunk;
    }
    key = pyStrip(key);
    val = pyStrip(val);
    if (key || val) {
      Object.defineProperty(into, key, { value: unquote(val), enumerable: true, writable: true, configurable: true });
    }
  }
  return into;
}

const CACHE = Symbol('cookies');

/** request.cookies: every Cookie header, parsed and merged, cached on the request. */
export function requestCookies(req: Request): Record<string, string> {
  const r = req as unknown as Record<symbol, Record<string, string> | undefined>;
  const cached = r[CACHE];
  if (cached) return cached;
  const out: Record<string, string> = Object.create(null);
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'cookie') parseCookieHeader(raw[i + 1], out);
  }
  r[CACHE] = out;
  return out;
}
