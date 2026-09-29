/**
 * The HTTP layer: routing, request validation, responses and errors.
 *
 * Express provides the server and the middleware chain. On top of it this module keeps
 * the exact REST contract the Python backend (FastAPI on Starlette) established, because
 * the dashboard, the nginx configuration and the test suites all depend on details of it:
 *
 *   * errors are `{"detail": ...}`; an invalid body is a 422 listing every problem;
 *   * an unknown path is a 404, a known path with the wrong method a 405 with `Allow`,
 *     and a path that only differs by a trailing slash a 307 to the right one;
 *   * a body is read as JSON only when it says it is JSON;
 *   * JSON responses are compact, UTF-8, and `application/json` with no charset.
 *
 * Routes are declared the Express way — `router.post('/register', spec, handler)` — with
 * a small `spec` saying what the path, query string and body must contain. The same spec
 * drives validation and the OpenAPI document served at /openapi.json in development.
 */
import busboy from 'busboy';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fsp, unlinkSync, type Stats } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { JSONDecodeError, PyFloat, pyDumps, pyFloatRepr, pyLoadsBytes, pyRstrip, pyStrip } from './py';
import { INVALID, Model, RequestValidationError, titleOf, type ErrorItem, type FieldDef, type Schema, type Type } from './validate';

export { RequestValidationError } from './validate';

// ── what every request carries ───────────────────────────────────────────────

/** What uvicorn and Starlette would have computed for this request. */
export interface RequestScope {
  /** The client address, after the proxy-header rules below. null if unknown. */
  client: string | null;
  scheme: 'http' | 'https';
  /** The percent-DECODED path: what routes match against. */
  path: string;
  rawPath: string;
  queryString: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      vs: RequestScope;
      /** request.state: per-request notes between the layers (the refresh cookie). */
      state: Record<string, any>;
    }
  }
}

/** The FIRST value of a header, as Starlette's request.headers.get() returns. */
export function header(req: Request, name: string): string | null {
  const want = name.toLowerCase();
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === want) return raw[i + 1];
  return null;
}

/** Every value of a header, in order. */
export function headerAll(req: Request, name: string): string[] {
  const want = name.toLowerCase();
  const out: string[] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === want) out.push(raw[i + 1]);
  return out;
}

/** The LAST value of a header — what `dict(scope["headers"])` keeps. */
function headerLast(req: Request, name: string): string | null {
  const all = headerAll(req, name);
  return all.length ? all[all.length - 1] : null;
}

/** urllib.parse.unquote: %XX sequences as UTF-8, invalid bytes as U+FFFD. */
export function pyUnquote(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = Buffer.from(run.replace(/%/g, ''), 'hex');
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  });
}

const ALWAYS_SAFE = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~']);

/** urllib.parse.quote(s, safe=...) */
export function pyQuote(s: string, safe = '/'): string {
  const ok = new Set([...ALWAYS_SAFE, ...safe]);
  let out = '';
  for (const ch of s) {
    if (ok.has(ch)) out += ch;
    else for (const b of Buffer.from(ch, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** urllib.parse.quote_plus: like quote, but a space becomes '+' and '/' is not safe. */
export function pyQuotePlus(s: string, safe = ''): string {
  return pyQuote(s, safe + ' ').replace(/ /g, '+');
}

/** urllib.parse.urlencode over ordered pairs (or an object, in its key order). */
export function urlencode(pairs: Record<string, unknown> | Array<[string, unknown]>): string {
  const items = Array.isArray(pairs) ? pairs : Object.entries(pairs);
  return items.map(([k, v]) => `${pyQuotePlus(String(k))}=${pyQuotePlus(pyStr(v))}`).join('&');
}

/** str(v) for the primitives that end up in a query string. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/**
 * uvicorn's proxy-header handling, which the Python backend ran with by default.
 *
 * A request arriving FROM a trusted address (FORWARDED_ALLOW_IPS, default 127.0.0.1 —
 * i.e. nginx on the same machine) takes its scheme from X-Forwarded-Proto and its client
 * address from X-Forwarded-For. `deps.clientIp` then applies this app's own rules on
 * top. Both layers are reproduced, so every per-address rate limit sees the same address
 * it saw before.
 */
class TrustedHosts {
  private readonly always: boolean;
  private readonly hosts = new Set<string>();
  private readonly nets = new BlockList();
  private hasNets = false;

  constructor(spec: string) {
    const items = spec.split(',').map((x) => x.trim()).filter(Boolean);
    this.always = items.includes('*');
    for (const it of items) {
      if (it === '*') continue;
      const slash = it.indexOf('/');
      if (slash > 0 && isIP(it.slice(0, slash))) {
        const fam = isIP(it.slice(0, slash)) === 6 ? 'ipv6' : 'ipv4';
        try {
          this.nets.addSubnet(it.slice(0, slash), parseInt(it.slice(slash + 1), 10), fam);
          this.hasNets = true;
          continue;
        } catch {
          /* fall through to a literal */
        }
      }
      this.hosts.add(it);
    }
  }

  has(host: string | null): boolean {
    if (this.always) return true;
    if (!host) return false;
    if (this.hosts.has(host)) return true;
    const fam = isIP(host);
    if (fam && this.hasNets) return this.nets.check(host, fam === 6 ? 'ipv6' : 'ipv4');
    return false;
  }

  /** The first untrusted host, reading the chain from the right. */
  clientFrom(xff: string): string {
    const hosts = xff.split(',').map((h) => h.trim());
    if (this.always) return hosts[0];
    for (let i = hosts.length - 1; i >= 0; i--) if (!this.has(hosts[i])) return hosts[i];
    return hosts[0];
  }
}

const FORWARDED = new TrustedHosts(process.env.FORWARDED_ALLOW_IPS || '127.0.0.1');

function peerAddress(req: Request): string | null {
  let a = req.socket?.remoteAddress ?? null;
  if (a && a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  return a;
}

/** The first middleware: works out the request's scope, and gives it a `state`. */
export function scopeMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const url = req.url || '/';
    const q = url.indexOf('?');
    let rawPath = q < 0 ? url : url.slice(0, q);
    const queryString = q < 0 ? '' : url.slice(q + 1).split('#')[0];
    // An absolute-form target ("http://host/path") still routes on its path.
    const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(rawPath);
    if (abs) rawPath = rawPath.slice(abs[0].length) || '/';

    let client = peerAddress(req);
    let scheme: 'http' | 'https' = 'http';
    if (FORWARDED.has(client)) {
      const proto = headerLast(req, 'x-forwarded-proto');
      if (proto !== null) {
        const p = proto.trim();
        if (p === 'http' || p === 'https') scheme = p;
      }
      const xff = headerLast(req, 'x-forwarded-for');
      if (xff !== null) {
        const host = FORWARDED.clientFrom(xff);
        if (host) client = host;
      }
    }
    req.vs = { client, scheme, path: pyUnquote(rawPath), rawPath, queryString };
    req.state = {};
    next();
  };
}

/** request.url, as a string. */
export function requestUrl(req: Request, pathOverride?: string): string {
  const host = header(req, 'host');
  const p = pathOverride ?? req.vs.path;
  let url: string;
  if (host !== null) {
    url = `${req.vs.scheme}://${host}${p}`;
  } else {
    const addr = req.socket.localAddress || '127.0.0.1';
    const port = req.socket.localPort;
    const dflt = req.vs.scheme === 'https' ? 443 : 80;
    url = port === dflt ? `${req.vs.scheme}://${addr}${p}` : `${req.vs.scheme}://${addr}:${port}${p}`;
  }
  if (req.vs.queryString) url += '?' + req.vs.queryString;
  return url;
}

/** request.base_url: scheme, host and a trailing slash. */
export function baseUrl(req: Request): string {
  const u = requestUrl(req, '/');
  const q = u.indexOf('?');
  return q < 0 ? u : u.slice(0, q);
}

/** request.query_params: the LAST value of each key wins, as in Starlette. */
export function queryParams(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(req.vs.queryString)) out.set(k, v);
  return out;
}

/** A browser typing a URL, or a fetch from the dashboard? Decided on Accept. */
export function wantsHtml(req: Request): boolean {
  const accept = header(req, 'accept') || '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

// ── errors ───────────────────────────────────────────────────────────────────

/** http.HTTPStatus(code).phrase, as Python 3.14 spells them. */
export const STATUS_PHRASES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted',
  203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized',
  402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Content Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable',
  417: 'Expectation Failed', 418: "I'm a Teapot", 421: 'Misdirected Request', 422: 'Unprocessable Content',
  423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required',
  428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error', 501: 'Not Implemented',
  502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported', 507: 'Insufficient Storage', 511: 'Network Authentication Required',
};

/**
 * An error whose status and `detail` are meant for the caller — FastAPI's HTTPException.
 * With no detail, the status phrase ("Not Found") is the detail.
 */
export class HTTPException extends Error {
  override name = 'HTTPException';
  readonly detail: unknown;
  constructor(
    readonly status: number,
    detail?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    const d = detail === undefined || detail === null ? STATUS_PHRASES[status] ?? '' : detail;
    super(typeof d === 'string' ? d : JSON.stringify(d));
    this.detail = d;
  }
}

// ── responses ────────────────────────────────────────────────────────────────

/** Render JSON exactly as Starlette's JSONResponse does. */
export function renderJson(content: unknown): Buffer {
  return Buffer.from(pyDumps(content, { separators: [',', ':'], ensureAscii: false, allowNan: false }), 'utf8');
}

function bodyAllowed(status: number): boolean {
  return !(status < 200 || status === 204 || status === 304);
}

/** Anything a handler can return instead of plain data. */
export abstract class HttpResponse {
  status: number;
  /** Extra headers, applied before the ones the response computes itself. */
  headers: Record<string, string>;
  constructor(status: number, headers?: Record<string, string>) {
    this.status = status;
    this.headers = { ...(headers ?? {}) };
  }
  abstract send(req: Request, res: Response): Promise<void> | void;

  protected applyHeaders(res: Response): void {
    for (const [k, v] of Object.entries(this.headers)) {
      if (k.toLowerCase() === 'set-cookie') res.append('Set-Cookie', v);
      else res.setHeader(k.toLowerCase(), v);
    }
  }
}

/** Starlette's plain Response: bytes or text, with a media type. */
export class RawResponse extends HttpResponse {
  readonly body: Buffer;
  constructor(
    content: string | Buffer | null,
    opts: { status?: number; headers?: Record<string, string>; mediaType?: string | null } = {},
  ) {
    super(opts.status ?? 200, opts.headers);
    this.body = content === null ? Buffer.alloc(0) : typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    this.mediaType = opts.mediaType ?? null;
  }
  mediaType: string | null;

  send(_req: Request, res: Response): void {
    res.statusCode = this.status;
    this.applyHeaders(res);
    const lower = Object.keys(this.headers).map((k) => k.toLowerCase());
    if (!lower.includes('content-length') && bodyAllowed(this.status)) {
      res.setHeader('content-length', String(this.body.length));
    }
    if (this.mediaType && !lower.includes('content-type')) {
      let ct = this.mediaType;
      if (ct.startsWith('text/') && !ct.toLowerCase().includes('charset=')) ct += '; charset=utf-8';
      res.setHeader('content-type', ct);
    }
    res.end(this.body);
  }
}

export class JSONResponse extends RawResponse {
  constructor(content: unknown, status = 200, headers?: Record<string, string>) {
    super(renderJson(content), { status, headers, mediaType: 'application/json' });
  }
}

export class HTMLResponse extends RawResponse {
  constructor(content: string, status = 200, headers?: Record<string, string>) {
    super(content, { status, headers, mediaType: 'text/html' });
  }
}

export class PlainTextResponse extends RawResponse {
  constructor(content: string, status = 200, headers?: Record<string, string>) {
    super(content, { status, headers, mediaType: 'text/plain' });
  }
}

/** A redirect; 307 by default, which keeps the method, as Starlette's does. */
export class RedirectResponse extends RawResponse {
  constructor(url: string, status = 307, headers?: Record<string, string>) {
    super(null, { status, headers });
    this.headers.location = pyQuote(url, ":/%#?=@[]!$&'()*+,;");
  }
}

/** A body produced piece by piece. */
export class StreamingResponse extends HttpResponse {
  constructor(
    private readonly content: AsyncIterable<Buffer | string>,
    opts: { status?: number; headers?: Record<string, string>; mediaType?: string | null } = {},
  ) {
    super(opts.status ?? 200, opts.headers);
    this.mediaType = opts.mediaType ?? null;
  }
  mediaType: string | null;

  async send(_req: Request, res: Response): Promise<void> {
    res.statusCode = this.status;
    this.applyHeaders(res);
    if (this.mediaType && !Object.keys(this.headers).some((k) => k.toLowerCase() === 'content-type')) {
      let ct = this.mediaType;
      if (ct.startsWith('text/') && !ct.toLowerCase().includes('charset=')) ct += '; charset=utf-8';
      res.setHeader('content-type', ct);
    }
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const it = this.content[Symbol.asyncIterator]();
    try {
      while (!closed) {
        const { value, done } = await it.next();
        if (done) break;
        if (!res.write(value)) await new Promise<void>((r) => res.once('drain', r).once('close', r));
      }
    } finally {
      if (closed && typeof it.return === 'function') await it.return(undefined);
    }
    if (!closed) res.end();
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/vnd.microsoft.icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/x-wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt', '.zip': 'application/zip', '.pdf': 'application/pdf', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

/** mimetypes.guess_type(name)[0] for the types this app serves. */
export function guessType(name: string): string | null {
  return MIME[path.extname(name).toLowerCase()] ?? null;
}

/** email.utils.formatdate(t, usegmt=True) */
export function httpDate(epochS: number): string {
  return new Date(Math.floor(epochS) * 1000).toUTCString();
}

/** os.stat_result.st_mtime, computed the way CPython computes it from nanoseconds. */
function pyMtime(ns: bigint): number {
  const sec = ns / 1_000_000_000n;
  const nsec = ns % 1_000_000_000n;
  return Number(sec) + Number(nsec) * 1e-9;
}

class MalformedRange extends Error {}
class RangeNotSatisfiable extends Error {
  constructor(readonly size: number) {
    super('range not satisfiable');
  }
}

/** Starlette FileResponse._parse_range_header */
function parseRangeHeader(httpRange: string, size: number): Array<[number, number]> {
  const eq = httpRange.indexOf('=');
  if (eq < 0) throw new MalformedRange('Malformed range header.');
  const units = pyStrip(httpRange.slice(0, eq)).toLowerCase();
  const range = httpRange.slice(eq + 1);
  if (units !== 'bytes') throw new MalformedRange('Only support bytes range');
  if (range.split(',').length > 100) return [];
  const ranges: Array<[number, number]> = [];
  const pyIntStr = (s: string): number => {
    if (!/^[+-]?\d+(_\d+)*$/.test(s)) throw new Error('ValueError');
    return Number(s.replace(/_/g, ''));
  };
  for (let part of range.split(',')) {
    part = pyStrip(part);
    if (!part || part === '-' || !part.includes('-')) continue;
    const d = part.indexOf('-');
    const s0 = pyStrip(part.slice(0, d));
    const e0 = pyStrip(part.slice(d + 1));
    try {
      const start = s0 ? pyIntStr(s0) : Math.max(size - pyIntStr(e0), 0);
      const end = s0 && e0 && pyIntStr(e0) < size ? pyIntStr(e0) + 1 : size;
      ranges.push([start, end]);
    } catch {
      continue;
    }
  }
  if (!ranges.length) throw new MalformedRange('Range header: range must be requested');
  if (ranges.some(([s]) => !(s >= 0 && s < size))) throw new RangeNotSatisfiable(size);
  if (ranges.some(([s, e]) => s >= e)) throw new MalformedRange('Range header: start must be less than end');
  if (ranges.length === 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [ranges[0]];
  for (const [s, e] of ranges.slice(1)) {
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * A file from disk, with ranges — Starlette's FileResponse. A <video> element seeks by
 * asking for byte ranges, so this is what makes a finished dub scrub properly.
 */
export class FileResponse extends HttpResponse {
  readonly filePath: string;
  readonly mediaType: string;
  constructor(
    filePath: string,
    opts: {
      status?: number;
      headers?: Record<string, string>;
      mediaType?: string | null;
      filename?: string | null;
      contentDispositionType?: string;
      stat?: Stats | null;
    } = {},
  ) {
    super(opts.status ?? 200, opts.headers);
    this.filePath = filePath;
    this.mediaType = opts.mediaType ?? guessType(opts.filename || filePath) ?? 'application/octet-stream';
    const lower = new Set(Object.keys(this.headers).map((k) => k.toLowerCase()));
    if (!lower.has('accept-ranges')) this.headers['accept-ranges'] = 'bytes';
    if (opts.filename != null) {
      const q = pyQuote(opts.filename);
      const type = opts.contentDispositionType ?? 'attachment';
      const cd = q !== opts.filename ? `${type}; filename*=utf-8''${q}` : `${type}; filename="${opts.filename}"`;
      if (!lower.has('content-disposition')) this.headers['content-disposition'] = cd;
    }
  }

  async send(req: Request, res: Response): Promise<void> {
    let st: import('node:fs').BigIntStats;
    try {
      st = await fsp.stat(this.filePath, { bigint: true });
    } catch {
      throw new Error(`File at path ${this.filePath} does not exist.`);
    }
    if (!st.isFile()) throw new Error(`File at path ${this.filePath} is not a file.`);
    const size = Number(st.size);
    const mtime = pyMtime(st.mtimeNs);
    const etag = '"' + createHash('md5').update(`${pyFloatRepr(mtime)}-${size}`).digest('hex') + '"';
    const lastModified = httpDate(mtime);

    const has = (k: string) => Object.keys(this.headers).some((h) => h.toLowerCase() === k);
    const base: Record<string, string> = { ...this.headers };
    if (!has('content-length')) base['content-length'] = String(size);
    if (!has('content-type')) {
      let ct = this.mediaType;
      if (ct.startsWith('text/') && !ct.toLowerCase().includes('charset=')) ct += '; charset=utf-8';
      base['content-type'] = ct;
    }
    if (!has('last-modified')) base['last-modified'] = lastModified;
    if (!has('etag')) base.etag = etag;
    const headOnly = req.method.toUpperCase() === 'HEAD';

    const range = header(req, 'range');
    const ifRange = header(req, 'if-range');
    const simple = range === null || (ifRange !== null && ifRange !== base['last-modified'] && ifRange !== base.etag);
    if (simple) return this.stream(res, this.status, base, headOnly, 0, size);

    let ranges: Array<[number, number]>;
    try {
      ranges = parseRangeHeader(range!, size);
    } catch (e) {
      if (e instanceof MalformedRange) return new PlainTextResponse(e.message, 400).send(req, res);
      if (e instanceof RangeNotSatisfiable) {
        return new RawResponse('', { status: 416, headers: { 'Content-Range': `bytes */${e.size}` }, mediaType: 'text/plain' }).send(req, res);
      }
      throw e;
    }
    if (ranges.length === 0) return this.stream(res, this.status, base, headOnly, 0, size);
    if (ranges.length === 1) {
      const [s, e] = ranges[0];
      return this.stream(res, 206, { ...base, 'content-range': `bytes ${s}-${e - 1}/${size}`, 'content-length': String(e - s) }, headOnly, s, e);
    }
    // multipart/byteranges
    const boundary = randomBytes(13).toString('hex');
    const ctype = base['content-type'];
    const part = (s: number, e: number) =>
      Buffer.from(`--${boundary}\r\nContent-Type: ${ctype}\r\nContent-Range: bytes ${s}-${e - 1}/${size}\r\n\r\n`, 'latin1');
    const staticLen = 49 + boundary.length + ctype.length + String(size).length;
    const total =
      ranges.reduce((acc, [s, e]) => acc + String(s).length + String(e - 1).length + staticLen + (e - s), 0) + 4 + boundary.length;
    res.statusCode = 206;
    for (const [k, v] of Object.entries({ ...base, 'content-type': `multipart/byteranges; boundary=${boundary}`, 'content-length': String(total) })) {
      res.setHeader(k.toLowerCase(), v);
    }
    if (headOnly) return void res.end();
    for (const [s, e] of ranges) {
      res.write(part(s, e));
      await this.pipeRange(res, s, e);
      res.write('\r\n');
    }
    res.end(`--${boundary}--`);
  }

  private async stream(res: Response, status: number, headers: Record<string, string>, headOnly: boolean, s: number, e: number): Promise<void> {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k.toLowerCase(), v);
    if (headOnly || e <= s) return void res.end();
    await this.pipeRange(res, s, e);
    res.end();
  }

  private pipeRange(res: Response, s: number, e: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const rs = createReadStream(this.filePath, { start: s, end: e - 1, highWaterMark: 64 * 1024 });
      const onClose = () => {
        rs.destroy();
        resolve();
      };
      res.once('close', onClose);
      rs.on('error', (err) => {
        res.off('close', onClose);
        reject(err);
      });
      rs.on('end', () => {
        res.off('close', onClose);
        resolve();
      });
      rs.pipe(res, { end: false });
    });
  }
}

// ── running code just before the headers go out ─────────────────────────────

const HOOKS = Symbol('headerHooks');

/**
 * Run `fn` immediately before the response's headers are written, whichever way they
 * are written. This is how "add this header unless the route already set it" works in
 * Express: at that moment the route's own headers are all there to be seen.
 */
export function onHeaders(res: Response, fn: () => void): void {
  const r = res as unknown as { [HOOKS]?: Array<() => void>; writeHead: (...a: any[]) => any };
  if (!r[HOOKS]) {
    const hooks: Array<() => void> = [];
    r[HOOKS] = hooks;
    const original = r.writeHead;
    r.writeHead = function (this: Response, ...args: any[]) {
      // writeHead(status, [message], [headers]): fold a headers argument in first, so
      // the hooks see it too.
      const last = args[args.length - 1];
      if (args.length > 1 && last && typeof last === 'object' && !Array.isArray(last)) {
        for (const [k, v] of Object.entries(last)) this.setHeader(k, v as string);
        args = args.slice(0, -1);
      }
      if (typeof args[0] === 'number') this.statusCode = args[0];
      while (hooks.length) hooks.shift()!();
      return original.apply(this, args);
    };
  }
  r[HOOKS]!.push(fn);
}

/** Headers-only reset, used when a handler fails after starting to build its response. */
export function clearHeaders(res: Response): void {
  for (const h of res.getHeaderNames()) res.removeHeader(h);
}

// ── routing ──────────────────────────────────────────────────────────────────

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSpec {
  /** Python's function name: the OpenAPI summary and operationId come from it. */
  name?: string;
  /** Path parameters and their types, in declaration order. */
  path?: Record<string, Type>;
  /** Query parameters, in declaration order. */
  query?: Record<string, FieldDef>;
  /** The JSON body model. */
  body?: Model;
  /** `body: Model | None = None`: a missing body is allowed. */
  bodyOptional?: boolean;
  description?: string;
  /** Left out of the OpenAPI document. */
  hidden?: boolean;
  /** Tags for the OpenAPI document; defaults to the router's. */
  tags?: string[];
  /** The status of a plain-data response. Default 200. */
  status?: number;
  /**
   * A required file part in a multipart form (FastAPI's `File(...)`), spooled to disk in
   * `dir` before the handler runs, exactly as FastAPI reads the whole form first. The
   * handler gets it as `a.<field>`; the spooled copy is removed after the request unless
   * the handler has moved it.
   */
  upload?: { field: string; dir: string; maxBytes: number };
}

/** A file part received by an `upload` route. */
export interface UploadedFile {
  /** The part's filename, as the browser sent it ("" if empty). */
  filename: string;
  contentType: string | null;
  /** Where the bytes were spooled. Move it, or it is deleted after the request. */
  path: string;
  /** Bytes received. Past `maxBytes` nothing more is written, and `tooLarge` is set. */
  size: number;
  tooLarge: boolean;
}

export type Handler = (req: Request, res: Response, a: any) => unknown;

export type MountHandler = (req: Request, res: Response, subPath: string) => Promise<void> | void;

interface RouteDef {
  kind: 'route' | 'mount';
  methods: string[];
  path: string;
  regex: RegExp;
  params: string[];
  spec: RouteSpec;
  handler?: Handler;
  mount?: MountHandler;
  tags: string[];
}

/** Starlette's compile_path: {name} matches one segment, {name:path} the rest. */
function compilePath(p: string): { regex: RegExp; params: string[] } {
  const params: string[] = [];
  let re = '^';
  let idx = 0;
  const token = /\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([a-zA-Z_][a-zA-Z0-9_]*))?\}/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(p))) {
    re += p.slice(idx, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const conv = m[2] || 'str';
    const pattern = conv === 'path' ? '.*' : conv === 'int' ? '[0-9]+' : '[^/]+';
    re += `(?<${m[1]}>${pattern})`;
    params.push(m[1]);
    idx = m.index + m[0].length;
  }
  re += p.slice(idx).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  return { regex: new RegExp(re, 's'), params };
}

/** A group of routes under one prefix: FastAPI's APIRouter. */
export class ApiRouter {
  readonly routes: RouteDef[] = [];
  constructor(
    readonly prefix = '',
    readonly tags: string[] = [],
  ) {}

  add(methods: Method[], p: string, spec: RouteSpec, handler: Handler): this {
    const full = this.prefix + p;
    const { regex, params } = compilePath(full);
    this.routes.push({ kind: 'route', methods, path: full, regex, params, spec, handler, tags: spec.tags ?? this.tags });
    return this;
  }
  get(p: string, spec: RouteSpec, handler: Handler): this {
    return this.add(['GET'], p, spec, handler);
  }
  post(p: string, spec: RouteSpec, handler: Handler): this {
    return this.add(['POST'], p, spec, handler);
  }
  put(p: string, spec: RouteSpec, handler: Handler): this {
    return this.add(['PUT'], p, spec, handler);
  }
  patch(p: string, spec: RouteSpec, handler: Handler): this {
    return this.add(['PATCH'], p, spec, handler);
  }
  delete(p: string, spec: RouteSpec, handler: Handler): this {
    return this.add(['DELETE'], p, spec, handler);
  }
}

export type ExceptionHandler = (req: Request, exc: any) => HttpResponse | Promise<HttpResponse>;

/** The largest JSON body read into memory. Every real one is a few hundred bytes. */
const MAX_JSON_BODY = 16 * 1024 * 1024;

/** Read the whole body. Refuses anything over `limit` with a 413. */
export function readBody(req: Request, limit = MAX_JSON_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      n += c.length;
      if (n > limit) {
        failed = true;
        reject(new HTTPException(413, 'request body too large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!failed) {
        failed = true;
        reject(e);
      }
    });
  });
}

/** email.message.Message content-type parsing: [maintype, subtype], or text/plain. */
function contentType(value: string): [string, string] {
  const i = value.indexOf(';');
  const ctype = pyStrip(i < 0 ? value : value.slice(0, i)).toLowerCase();
  const parts = ctype.split('/');
  if (parts.length !== 2) return ['text', 'plain'];
  return [parts[0], parts[1]];
}

const NO_BODY = Symbol('no body');

/**
 * The application: every route in order, plus the exception handlers — FastAPI's app
 * object, as far as routing and errors go.
 */
export class App {
  readonly routes: RouteDef[] = [];
  private readonly handlers: Array<[new (...a: any[]) => Error, ExceptionHandler]> = [];

  constructor(
    readonly info: { title: string; version: string; description: string },
    readonly docs: boolean,
  ) {
    if (docs) this.addDocsRoutes();
  }

  include(router: ApiRouter): this {
    this.routes.push(...router.routes);
    return this;
  }

  add(methods: Method[], p: string, spec: RouteSpec, handler: Handler): this {
    const { regex, params } = compilePath(p);
    this.routes.push({ kind: 'route', methods, path: p, regex, params, spec, handler, tags: spec.tags ?? [] });
    return this;
  }
  get(p: string, spec: RouteSpec, handler: Handler): this {
    return this.add(['GET'], p, spec, handler);
  }

  /** Everything under `prefix/` goes to `handler`, whatever the method. */
  mount(prefix: string, handler: MountHandler): this {
    const p = pyRstrip(prefix, '/');
    this.routes.push({
      kind: 'mount',
      methods: [],
      path: p,
      regex: new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(?<path>.*)$', 's'),
      params: ['path'],
      spec: { hidden: true },
      mount: handler,
      tags: [],
    });
    return this;
  }

  /** @app.exception_handler(cls) */
  exceptionHandler<E extends Error>(cls: new (...a: any[]) => E, fn: (req: Request, exc: E) => HttpResponse | Promise<HttpResponse>): this {
    this.handlers.push([cls, fn as ExceptionHandler]);
    return this;
  }

  private findHandler(e: unknown): ExceptionHandler | null {
    // The most specific registered class wins, as Starlette looks handlers up by MRO.
    let proto = e && typeof e === 'object' ? Object.getPrototypeOf(e) : null;
    while (proto) {
      for (const [cls, fn] of this.handlers) if (cls.prototype === proto) return fn;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  /** The Express middleware that routes, validates, runs and answers. */
  handler(): (req: Request, res: Response, next: NextFunction) => Promise<void> {
    return async (req, res, next) => {
      try {
        await this.dispatch(req, res);
      } catch (e) {
        if (res.headersSent) {
          // Half a response is already on the wire; all that is left is to stop.
          console.error('  [error after the response started]', e);
          res.destroy();
          return;
        }
        const fn = this.findHandler(e);
        if (!fn) return next(e);
        try {
          clearHeaders(res);
          const r = await fn(req, e);
          await r.send(req, res);
        } catch (e2) {
          next(e2);
        }
      }
    };
  }

  private async dispatch(req: Request, res: Response): Promise<void> {
    const p = req.vs.path;
    const method = req.method.toUpperCase();
    let partial: RouteDef | null = null;
    for (const r of this.routes) {
      const m = r.regex.exec(p);
      if (!m) continue;
      if (r.kind === 'mount') {
        await r.mount!(req, res, m.groups?.path ?? '');
        return;
      }
      if (r.methods.includes(method)) {
        await this.run(r, (m.groups ?? {}) as Record<string, string>, req, res);
        return;
      }
      if (!partial) partial = r;
    }
    if (partial) throw new HTTPException(405, undefined, { Allow: partial.methods.join(', ') });

    if (p !== '/') {
      const alt = p.endsWith('/') ? pyRstrip(p, '/') : p + '/';
      if (this.routes.some((r) => r.regex.test(alt))) {
        await new RedirectResponse(requestUrl(req, alt)).send(req, res);
        return;
      }
    }
    throw new HTTPException(404);
  }

  private async run(r: RouteDef, pathParams: Record<string, string>, req: Request, res: Response): Promise<void> {
    if (r.spec.upload) {
      let spooled: UploadedFile | null = null;
      try {
        spooled = await readMultipartFile(req, r.spec.upload);
        await this.runValidated(r, pathParams, req, res, spooled);
      } finally {
        if (spooled && existsSync(spooled.path)) {
          try {
            unlinkSync(spooled.path);
          } catch {
            /* best effort */
          }
        }
      }
      return;
    }
    await this.runValidated(r, pathParams, req, res, null);
  }

  private async runValidated(r: RouteDef, pathParams: Record<string, string>, req: Request, res: Response, spooled: UploadedFile | null): Promise<void> {
    const spec = r.spec;

    // 1. The body is read and parsed first: a JSON syntax error is reported on its own.
    let body: unknown = NO_BODY;
    if (spec.body) {
      body = null;
      const raw = await readBody(req);
      if (raw.length) {
        const ct = header(req, 'content-type');
        let parsed: unknown = NO_BODY;
        if (ct) {
          const [maintype, subtype] = contentType(ct);
          if (maintype === 'application' && (subtype === 'json' || subtype.endsWith('+json'))) {
            try {
              parsed = pyLoadsBytes(raw);
            } catch (e) {
              if (e instanceof JSONDecodeError) {
                throw new RequestValidationError([
                  { type: 'json_invalid', loc: ['body', e.pos], msg: 'JSON decode error', input: {}, ctx: { error: e.msg } },
                ]);
              }
              throw new HTTPException(400, 'There was an error parsing the body');
            }
          }
        }
        // Not declared as JSON: handed to validation as bytes, which a model refuses.
        body = parsed !== NO_BODY ? parsed : raw;
      }
    }

    // 2. Path, then query, then body — every problem, in FastAPI's order.
    const errs: ErrorItem[] = [];
    const a: Record<string, unknown> = {};
    for (const [name, type] of Object.entries(spec.path ?? {})) {
      const v = type.check(pathParams[name], ['path', name], errs);
      if (v !== INVALID) a[name] = v;
    }
    if (spec.query) {
      const qp = queryParams(req);
      for (const [name, f] of Object.entries(spec.query)) {
        const raw = qp.get(name);
        if (raw === undefined) {
          if (f.required) errs.push({ type: 'missing', loc: ['query', name], msg: 'Field required', input: null });
          else a[name] = f.default === undefined ? null : structuredCloneSafe(f.default);
          continue;
        }
        const v = f.type.check(raw, ['query', name], errs);
        if (v !== INVALID) a[name] = v;
      }
    }
    if (spec.upload) {
      if (spooled) a[spec.upload.field] = spooled;
      else errs.push({ type: 'missing', loc: ['body', spec.upload.field], msg: 'Field required', input: null });
    }
    if (spec.body) {
      if (body === null) {
        if (spec.bodyOptional) a.body = null;
        else errs.push({ type: 'missing', loc: ['body'], msg: 'Field required', input: null });
      } else {
        // Bytes (a body not declared as JSON) are refused by the model as a string.
        const input = Buffer.isBuffer(body) ? body.toString('utf8') : body;
        const v = spec.body.check(input, ['body'], errs);
        if (v !== INVALID) a.body = v;
      }
    }
    if (errs.length) throw new RequestValidationError(errs);

    // 3. The handler.
    const out = await r.handler!(req, res, a);
    if (out instanceof HttpResponse) {
      await out.send(req, res);
      return;
    }
    if (res.headersSent || res.writableEnded) return;
    const buf = renderJson(out === undefined ? null : out);
    res.statusCode = spec.status ?? 200;
    res.setHeader('content-length', String(buf.length));
    res.setHeader('content-type', 'application/json');
    res.end(buf);
  }

  // ── the OpenAPI document and the interactive docs ────────────────────────

  openapi(): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    const schemas: Record<string, Schema> = {};
    const addModel = (m: Model): void => {
      if (schemas[m.name]) return;
      schemas[m.name] = m.componentSchema();
      m.nested().forEach(addModel);
    };
    let anyValidation = false;
    for (const r of this.routes) {
      if (r.kind !== 'route' || r.spec.hidden) continue;
      const spec = r.spec;
      for (const method of r.methods) {
        const fname = spec.name ?? 'endpoint';
        const opId = `${fname}${r.path}_${method.toLowerCase()}`.replace(/\W/g, '_');
        const op: Record<string, unknown> = {};
        if (r.tags.length) op.tags = r.tags;
        op.summary = titleOf(fname);
        if (spec.description) op.description = spec.description;
        op.operationId = opId;
        const params: unknown[] = [];
        for (const [name, type] of Object.entries(spec.path ?? {})) {
          params.push({ name, in: 'path', required: true, schema: { ...type.schema(), title: titleOf(name) } });
        }
        for (const [name, f] of Object.entries(spec.query ?? {})) {
          const s: Schema = { ...f.type.schema(), title: titleOf(name) };
          if (!f.required) s.default = f.default ?? null;
          params.push({ name, in: 'query', required: f.required, schema: s });
        }
        if (params.length) op.parameters = params;
        if (spec.body) {
          addModel(spec.body);
          const ref = { $ref: `#/components/schemas/${spec.body.name}` };
          op.requestBody = {
            content: { 'application/json': { schema: spec.bodyOptional ? { anyOf: [ref, { type: 'null' }], title: 'Body' } : ref } },
            required: !spec.bodyOptional,
          };
        }
        const responses: Record<string, unknown> = {
          [String(spec.status ?? 200)]: { description: 'Successful Response', content: { 'application/json': { schema: {} } } },
        };
        if (params.length || spec.body) {
          anyValidation = true;
          responses['422'] = {
            description: 'Validation Error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HTTPValidationError' } } },
          };
        }
        op.responses = responses;
        (paths[r.path] ??= {})[method.toLowerCase()] = op;
      }
    }
    if (anyValidation) {
      schemas.HTTPValidationError = {
        properties: { detail: { items: { $ref: '#/components/schemas/ValidationError' }, type: 'array', title: 'Detail' } },
        type: 'object',
        title: 'HTTPValidationError',
      };
      schemas.ValidationError = {
        properties: {
          loc: { items: { anyOf: [{ type: 'string' }, { type: 'integer' }] }, type: 'array', title: 'Location' },
          msg: { type: 'string', title: 'Message' },
          type: { type: 'string', title: 'Error Type' },
          input: { title: 'Input' },
          ctx: { type: 'object', title: 'Context' },
        },
        type: 'object',
        required: ['loc', 'msg', 'type'],
        title: 'ValidationError',
      };
    }
    const sorted: Record<string, Schema> = {};
    for (const k of Object.keys(schemas).sort()) sorted[k] = schemas[k];
    const doc: Record<string, unknown> = { openapi: '3.1.0', info: this.info, paths };
    if (Object.keys(sorted).length) doc.components = { schemas: sorted };
    return doc;
  }

  // These four are plain Starlette routes in FastAPI, which answer HEAD as well as GET;
  // the API routes are FastAPI's own, which do not (HEAD there is a 405).
  private addDocsRoutes(): void {
    const title = this.info.title;
    const safe = (v: unknown) =>
      JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    this.add(['GET', 'HEAD'], '/openapi.json', { hidden: true }, () => new JSONResponse(this.openapi()));
    this.add(['GET', 'HEAD'], '/docs', { hidden: true }, () => {
      const params: Record<string, unknown> = {
        dom_id: '#swagger-ui', layout: 'BaseLayout', deepLinking: true, showExtensions: true, showCommonExtensions: true,
      };
      let html = `
    <!DOCTYPE html>
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link type="text/css" rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
    <link rel="shortcut icon" href="https://fastapi.tiangolo.com/img/favicon.png">
    <title>${title} - Swagger UI</title>
    </head>
    <body>
    <div id="swagger-ui">
    </div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <!-- \`SwaggerUIBundle\` is now available on the page -->
    <script>
    const ui = SwaggerUIBundle({
        url: '/openapi.json',
    `;
      for (const [k, v] of Object.entries(params)) html += `${safe(k)}: ${safe(v)},\n`;
      html += `oauth2RedirectUrl: window.location.origin + '/docs/oauth2-redirect',`;
      html += `
    presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
    })
    </script>
    </body>
    </html>
    `;
      return new HTMLResponse(html);
    });
    this.add(['GET', 'HEAD'], '/docs/oauth2-redirect', { hidden: true }, () =>
      new HTMLResponse(
        '<!doctype html>\n<html lang="en-US">\n<head>\n    <title>Swagger UI: OAuth2 Redirect</title>\n</head>\n<body>\n' +
          '<script>\n    \'use strict\';\n    function run () {\n        var oauth2 = window.opener.swaggerUIRedirectOauth2;\n' +
          '        if (oauth2 && oauth2.callback) { oauth2.callback({ auth: oauth2.auth, redirectUrl: window.location.href }); }\n' +
          '        window.close();\n    }\n    window.addEventListener(\'DOMContentLoaded\', run);\n</script>\n</body>\n</html>\n',
      ),
    );
    this.add(['GET', 'HEAD'], '/redoc', { hidden: true }, () =>
      new HTMLResponse(`
    <!DOCTYPE html>
    <html>
    <head>
    <title>${title} - ReDoc</title>
    <!-- needed for adaptive design -->
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    
    <link rel="shortcut icon" href="https://fastapi.tiangolo.com/img/favicon.png">
    <!--
    ReDoc doesn't change outer page styles
    -->
    <style>
      body {
        margin: 0;
        padding: 0;
      }
    </style>
    </head>
    <body>
    <noscript>
        ReDoc requires Javascript to function. Please enable it to browse the documentation.
    </noscript>
    <redoc spec-url="/openapi.json"></redoc>
    <script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"> </script>
    </body>
    </html>
    `),
    );
  }
}

/**
 * Read a multipart form, spooling the one file part a route declares to disk.
 *
 * Starlette's rules: only multipart/form-data is parsed as parts (anything else is an
 * empty form, so the file is "missing"); a part is a file when it carries a filename;
 * a repeated field keeps its last value; filenames are UTF-8. A malformed body is a 400.
 */
function readMultipartFile(req: Request, o: { field: string; dir: string; maxBytes: number }): Promise<UploadedFile | null> {
  const ct = header(req, 'content-type') || '';
  const [maintype, subtype] = contentType(ct);
  if (!(maintype === 'multipart' && subtype === 'form-data')) {
    // not a form Starlette would parse into parts: drain it, and report the file missing
    return readBody(req, Number.MAX_SAFE_INTEGER).then(() => null);
  }
  mkdirSync(o.dir, { recursive: true });
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fieldSize: 1024 * 1024, fields: 1000, files: 1000 } });
    } catch (e) {
      reject(new HTTPException(400, (e as Error).message));
      return;
    }
    let result: UploadedFile | null = null;
    const pending: Array<Promise<void>> = [];
    const spools: string[] = [];
    let failed = false;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      req.unpipe(bb);
      req.resume();
      // an interrupted upload leaves nothing behind
      for (const p of spools) {
        try {
          unlinkSync(p);
        } catch {
          /* not created yet, or already gone */
        }
      }
      reject(e instanceof HTTPException ? e : new HTTPException(400, (e as Error)?.message || 'There was an error parsing the body'));
    };
    bb.on('file', (name, stream, info) => {
      if (name !== o.field) {
        stream.resume();
        return;
      }
      const spoolPath = path.join(o.dir, `.incoming_${randomBytes(12).toString('hex')}`);
      spools.push(spoolPath);
      const file: UploadedFile = { filename: info.filename ?? '', contentType: info.mimeType || null, path: spoolPath, size: 0, tooLarge: false };
      const out = createWriteStream(spoolPath);
      pending.push(
        new Promise<void>((done, bad) => {
          stream.on('data', (chunk: Buffer) => {
            file.size += chunk.length;
            if (file.size > o.maxBytes) {
              file.tooLarge = true;
              return; // keep reading, stop writing
            }
            if (!out.write(chunk)) {
              stream.pause();
              out.once('drain', () => stream.resume());
            }
          });
          stream.on('end', () => out.end());
          stream.on('error', bad);
          out.on('error', bad);
          out.on('finish', () => {
            // the last part of that name wins; an earlier one is discarded
            if (result && result.path !== spoolPath) {
              try {
                unlinkSync(result.path);
              } catch {
                /* ignore */
              }
            }
            result = file;
            done();
          });
        }),
      );
    });
    bb.on('field', () => {
      /* other fields are not part of this route's signature */
    });
    bb.on('error', fail);
    bb.on('close', () => {
      if (failed) return;
      Promise.all(pending).then(
        () => resolve(result),
        (e) => fail(e),
      );
    });
    req.on('error', fail);
    req.pipe(bb);
  });
}

function structuredCloneSafe<T>(v: T): T {
  if (v === null || typeof v !== 'object' || v instanceof PyFloat) return v;
  return structuredClone(v);
}

/** FastAPI's default answer to a validation failure. */
export function validationErrorResponse(exc: RequestValidationError): JSONResponse {
  return new JSONResponse(
    {
      detail: exc.errors.map((e) => {
        const item: Record<string, unknown> = { type: e.type, loc: e.loc, msg: e.msg, input: jsonable(e.input) };
        if (e.ctx) item.ctx = e.ctx;
        return item;
      }),
    },
    422,
  );
}

/** fastapi.encoders.jsonable_encoder, for the values that can reach an error body. */
export function jsonable(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (v instanceof PyFloat) return v;
  if (Array.isArray(v)) return v.map(jsonable);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonable(x);
    return out;
  }
  return v;
}

// ── Starlette's StaticFiles, for backend/app/static ─────────────────────────

const NOT_MODIFIED_HEADERS = ['cache-control', 'content-location', 'date', 'etag', 'expires', 'vary'];

/** Serve files from one directory, the way the Python backend's /static mount did. */
export function staticFiles(dir: string): MountHandler {
  const root = path.resolve(dir);
  return async (req, res, subPath) => {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') throw new HTTPException(405);
    const rel = path.normalize(subPath.split('/').join(path.sep));
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) throw new HTTPException(404);
    let st: import('node:fs').BigIntStats;
    try {
      st = await fsp.stat(full, { bigint: true });
    } catch {
      throw new HTTPException(404);
    }
    if (!st.isFile()) throw new HTTPException(404);

    const fr = new FileResponse(full);
    const size = Number(st.size);
    const mtime = pyMtime(st.mtimeNs);
    const etag = '"' + createHash('md5').update(`${pyFloatRepr(mtime)}-${size}`).digest('hex') + '"';
    const lastModified = httpDate(mtime);

    // 304 when the browser already holds this exact file.
    const inm = header(req, 'if-none-match');
    let notModified = false;
    if (inm) {
      notModified = inm.split(',').map((t) => pyStrip(t, ' W/')).includes(etag);
    } else {
      const ims = header(req, 'if-modified-since');
      if (ims) {
        const a = Date.parse(ims);
        const b = Date.parse(lastModified);
        if (!Number.isNaN(a) && !Number.isNaN(b) && a >= b) notModified = true;
      }
    }
    if (notModified) {
      res.statusCode = 304;
      const all: Record<string, string> = { etag, 'accept-ranges': 'bytes', 'last-modified': lastModified };
      for (const [k, v] of Object.entries(all)) if (NOT_MODIFIED_HEADERS.includes(k)) res.setHeader(k, v);
      res.end();
      return;
    }
    await fr.send(req, res);
  };
}
