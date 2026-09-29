/**
 * The web server: Express, with the app's own router mounted as one middleware.
 *
 * Local development runs the API and the worker in one process so a single command gives
 * a working system. No state lives in either object, only in the database.
 *
 *   node dist/main.js [--host 127.0.0.1] [--port 8099]
 *
 * THE ORDER OF THE LAYERS IS THE CONTRACT, so here it is, outermost first. It is the
 * order the Python backend's middleware stack produced, and each position is visible
 * from outside:
 *
 *   scope            proxy headers (uvicorn's rules), the decoded path, request.state
 *   maintenance      a 503 for the public; this answer carries none of the headers below
 *   refresh cookie   re-sends the session cookie when the session slid
 *   security headers CSP and friends, set only where a route did not set its own
 *   the app          routing, validation, the handlers, the 404/405/422/400 answers
 *   the 500          last; its answer carries neither the cookie nor the headers
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as billing from './billing';
import {
  ENGINE_MODE,
  ENGINE_URL,
  HOST,
  NODE_ROOT,
  PORT,
  PUBLIC_BASE_URL,
  PUBLIC_BASE_URL_EXPLICIT,
  SESSION_COOKIE,
  TRUSTED_PROXIES,
} from './config';
import { requestCookies } from './cookies';
import * as db from './db';
import { requireAdmin } from './deps';
import { getEngine } from './engine';
import * as errorpages from './errorpages';
import * as gpu from './gpu';
import {
  App,
  HTMLResponse,
  HTTPException,
  JSONResponse,
  PlainTextResponse,
  RawResponse,
  RequestValidationError,
  STATUS_PHRASES,
  clearHeaders,
  onHeaders,
  pyQuote,
  scopeMiddleware,
  staticFiles,
  validationErrorResponse,
  wantsHtml,
} from './http';
import * as notify from './notify';
import * as oauth from './oauth';
import * as preset from './preset';
import { PyFloat, excStr, pySlice } from './py';
import * as ratelimit from './ratelimit';
import * as adminRoutes from './routers/admin';
import * as authRoutes from './routers/auth';
import * as billingRoutes from './routers/billing';
import * as dbbrowseRoutes from './routers/dbbrowse';
import * as deliveryRoutes from './routers/delivery';
import * as jobsRoutes from './routers/jobs';
import * as privacyRoutes from './routers/privacy';
import * as security from './security';
import * as site from './site';
import * as storage from './storage';
import * as worker from './worker';

// ── is this a production process? ────────────────────────────────────────────
//
// One flag, consulted by the things that must behave differently once strangers can
// reach the port. Default is DEVELOPMENT: forgetting it loses only convenience, while
// the reverse default hands the interactive docs to whoever finds the URL.
const PRODUCTION = process.env.VS_PRODUCTION === '1';

// ── security headers ─────────────────────────────────────────────────────────
//
// This app serves HTML from the SAME ORIGIN as the session cookie (/, /db, the error
// pages), which is what makes framing protection and a CSP non-optional.
// 'unsafe-inline' for styles is needed by the two static pages; scripts get no such
// exemption.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "media-src 'self' blob:; " +
  // WIDER THAN 'self' ON PURPOSE: downloads 307 to a presigned storage URL, and uploads
  // PUT from the browser straight at storage. Refusing either fails as a network error.
  "connect-src 'self' https:; " +
  "font-src 'self' data:; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'";

// The two hand-written operator pages (static/index.html and db.html) are built from
// inline <script> and on*= handlers, which `script-src 'self'` would silently refuse to
// run. Those two responses carry this looser policy; set-if-absent below is what lets a
// route's own header win.
const CSP_LEGACY_PAGE =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['content-security-policy', CSP],
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()'],
  ['cross-origin-opener-policy', 'same-origin'],
];

const STATIC_DIR = path.join(NODE_ROOT, 'static');

/** An HTMLResponse carrying the relaxed CSP. See CSP_LEGACY_PAGE. */
function operatorPage(html: string, status = 200): HTMLResponse {
  return new HTMLResponse(html, status, { 'content-security-policy': CSP_LEGACY_PAGE });
}

/** Path.read_text(encoding="utf-8"): strict UTF-8, and universal newlines. */
function readTextPy(file: string): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
  return text.replace(/\r\n?/g, '\n');
}

/** A response that must leave exactly as built: no refresh cookie, no default headers. */
function bare(res: Response): void {
  res.locals.vsBare = true;
}

// ── the application: every route, in the order the Python backend declared them ──

const fastapi = new App(
  { title: 'VoiceStudio dubbing backend', version: '0.1.0', description: 'Drives the existing VoiceStudio engine. Never modifies it.' },
  // The interactive docs publish the whole route map. Off in production, which removes
  // the routes entirely: /docs, /redoc and /openapi.json all 404.
  !PRODUCTION,
);

/** What of an HTTPException's detail is safe to send back. Anything unvetted is not. */
function safeDetail(detail: unknown): unknown {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && !Buffer.isBuffer(detail) && !(detail instanceof PyFloat)) {
    const ok = Object.values(detail as Record<string, unknown>).every(
      (v) => v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' || v instanceof PyFloat,
    );
    if (ok) return detail;
  }
  return 'request failed';
}

// 404 and friends: a page for a browser, JSON for everything else. Covers the router's
// own 404 for an unknown path, which is what a stranger following a dead link hits.
fastapi.exceptionHandler(HTTPException, (req, exc) => {
  if (exc.status === 404 && wantsHtml(req)) return new HTMLResponse(errorpages.notFound(), 404);
  return new JSONResponse({ detail: safeDetail(exc.detail) }, exc.status, exc.headers);
});

// FastAPI's default answer to an invalid request: 422, listing every problem.
fastapi.exceptionHandler(RequestValidationError, (_req, exc) => validationErrorResponse(exc));

// The one error whose text is meant for the caller. Registered on the specific class:
// anything else falls through to the 500, which discloses a reference only.
fastapi.exceptionHandler(preset.ClientOverrideError, (_req, exc) => new JSONResponse({ detail: excStr(exc) }, 400));

fastapi.include(authRoutes.router);
fastapi.include(jobsRoutes.router);
fastapi.include(adminRoutes.router);
fastapi.include(dbbrowseRoutes.router);
fastapi.include(deliveryRoutes.router);
fastapi.include(privacyRoutes.router);
fastapi.include(billingRoutes.router);
fastapi.include(billingRoutes.adminRouter);

/** The database browser shell. Admin only, and the PAGE says so too (404 otherwise). */
function dbBrowserPage(req: Request): HTMLResponse {
  requireAdmin(req);
  const f = path.join(STATIC_DIR, 'db.html');
  if (existsSync(f)) return operatorPage(readTextPy(f));
  return new HTMLResponse('<h1>db.html missing</h1>', 404);
}

fastapi.get('/db', { name: 'db_browser' }, (req) => dbBrowserPage(req));

// Generated, not a static file: the Sitemap line must be an absolute URL, and a
// non-https origin serves `Disallow: /`.
fastapi.get('/robots.txt', { name: 'robots' }, () => new PlainTextResponse(site.robotsTxt(), 200, { 'cache-control': 'public, max-age=3600' }));

fastapi.get(
  '/sitemap.xml',
  { name: 'sitemap' },
  () => new RawResponse(site.sitemapXml(), { mediaType: 'application/xml', headers: { 'cache-control': 'public, max-age=3600' } }),
);

fastapi.get('/api/site', { name: 'site_status' }, () => {
  // What the frontend needs before it renders anything. Reachable during maintenance: it
  // is how the app tells "down for changes" apart from "the API is unreachable".
  const m = site.maintenance();
  return {
    maintenance: m.on,
    note: m.on ? m.note : null,
    since: m.on ? m.since : null,
    retry_after_s: m.retry_after_s,
    public_pages: site.PUBLIC_PAGES.map(([p]) => p),
    // Whether to draw "Continue with Google". A flag only: the browser never talks to
    // Google directly.
    google_auth: oauth.configured(),
    // Which build of the dashboard this server is serving, so a tab left behind by a
    // deploy can offer a reload.
    build: site.buildId(),
  };
});

fastapi.get('/api/health', { name: 'health' }, async (req) => {
  // Is the backend up, and can it see the engine? Strangers get what a health check and
  // the maintenance screen need; a signed-in customer gets readiness in words about the
  // service; the operator gets everything.
  const eng = getEngine();
  let engineOk = true;
  let engineInfo: unknown = null;
  try {
    engineInfo = await eng.sysinfo();
  } catch (e) {
    engineOk = false;
    engineInfo = pySlice(excStr(e), 300);
  }

  const anonymous = { ok: true, maintenance: site.maintenance().on };

  const [, user] = security.loadSession(requestCookies(req)[SESSION_COOKIE]);
  if (user === null) return anonymous;

  const signedIn = { ...anonymous, service_state: gpu.publicServiceState(engineOk) };
  if (user.role !== 'admin') return signedIn;

  return {
    ...signedIn,
    engine_mode: ENGINE_MODE,
    engine_reachable: engineOk,
    engine_state: gpu.publicEngineState(engineOk),
    engine_url: ENGINE_URL,
    engine_info: engineInfo,
    preset_version: preset.PRESET_VERSION,
    preset_sha256: preset.presetOnlyFingerprint(),
    storage: storage.status(),
    gpu_auto: gpu.enabled(),
    jobs: {
      queued: db.scalar("SELECT COUNT(*) FROM jobs WHERE state='queued'", [], 0),
      running: db.scalar("SELECT COUNT(*) FROM jobs WHERE state NOT IN ('queued','done','failed','cancelled')", [], 0),
      done: db.scalar("SELECT COUNT(*) FROM jobs WHERE state='done'", [], 0),
      failed: db.scalar("SELECT COUNT(*) FROM jobs WHERE state='failed'", [], 0),
    },
  };
});

// BEFORE the mount below: routes match in order, and the mount would otherwise serve
// this file straight off disk, handing out the admin page /db refuses.
fastapi.get('/static/db.html', { name: '_db_html_direct' }, (req) => dbBrowserPage(req));

if (existsSync(STATIC_DIR)) fastapi.mount('/static', staticFiles(STATIC_DIR));

fastapi.get('/', { name: 'index' }, () => {
  const f = path.join(STATIC_DIR, 'index.html');
  if (existsSync(f)) return operatorPage(readTextPy(f));
  return new HTMLResponse('<h1>backend is running</h1><p>See /docs</p>');
});

// ── the layers ───────────────────────────────────────────────────────────────

/**
 * Maintenance mode. Blocks the PUBLIC, never the operator: allowed paths (health, auth,
 * the admin API, robots.txt, the sitemap) pass, an ADMIN session passes, and so does
 * everything while it is off. The 503 carries Retry-After so a crawler comes back later.
 */
function maintenanceGate(req: Request, res: Response, next: NextFunction): void {
  if (site.allowedDuringMaintenance(req.vs.path)) return next();

  const state = site.maintenance();
  if (!state.on) return next();

  // An admin passes straight through. A failure to identify the caller means "not an
  // admin", never a 500.
  try {
    const [, user] = security.loadSession(requestCookies(req)[SESSION_COOKIE]);
    if (user !== null && user.role === 'admin') return next();
  } catch {
    /* not an admin */
  }

  const headers = { 'retry-after': String(state.retry_after_s) };
  const r = wantsHtml(req)
    ? new HTMLResponse(errorpages.maintenance(undefined, state.note, state.since), 503, headers)
    : new JSONResponse({ detail: state.note, maintenance: true, retry_after_s: state.retry_after_s }, 503, headers);
  bare(res);
  void Promise.resolve(r.send(req, res)).catch(next);
}

/**
 * The refresh cookie, then the security headers — applied as the headers go out, when
 * the route's own are all there to be seen.
 */
function responseHeaders(req: Request, res: Response, next: NextFunction): void {
  // Keeping an active person signed in: deps.current slides the session and notes it on
  // req.state; the browser's copy of the cookie has to slide with it.
  onHeaders(res, () => {
    if (res.locals.vsBare) return;
    const token = req.state?.vs_refresh_cookie;
    if (token) security.setSessionCookie(res, token);
  });
  onHeaders(res, () => {
    if (res.locals.vsBare) return;
    for (const [k, v] of SECURITY_HEADERS) if (!res.hasHeader(k)) res.setHeader(k, v);
    // HSTS only over TLS and only in production: from a staging host it would pin that
    // host to https for a year.
    if (PRODUCTION && req.vs.scheme === 'https' && !res.hasHeader('strict-transport-security')) {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
  });
  next();
}

/** The 500. Logged in full, disclosed in outline: a reference the visitor can quote. */
function serverError(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const rid = randomUUID().replace(/-/g, '').slice(0, 12);
  console.log(`  [500 ${rid}] ${req.method} ${req.vs?.path ?? req.url}`);
  console.error(err instanceof Error ? err.stack || String(err) : err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  clearHeaders(res);
  bare(res);
  const r = wantsHtml(req)
    ? new HTMLResponse(errorpages.serverError(undefined, rid), 500)
    : new JSONResponse({ detail: 'Something went wrong on our side.', reference: rid }, 500);
  try {
    void Promise.resolve(r.send(req, res)).catch(() => res.destroy());
  } catch {
    res.destroy();
  }
}

/** uvicorn's access log line, which is what the service's journal has always shown. */
function accessLog(req: Request, res: Response, next: NextFunction): void {
  if (process.env.VS_ACCESS_LOG === '0') return next();
  res.on('close', () => {
    if (!res.headersSent) return;
    const peer = req.socket.remoteAddress || '';
    const fromProxy = req.vs && req.vs.client !== null && req.vs.client !== peer.replace(/^::ffff:/, '');
    const client = req.vs?.client ? `${req.vs.client}:${fromProxy ? 0 : req.socket.remotePort ?? 0}` : '-';
    const target = pyQuote(req.vs?.path ?? '/') + (req.vs?.queryString ? `?${req.vs.queryString}` : '');
    const phrase = STATUS_PHRASES[res.statusCode] ?? '';
    console.log(`INFO:     ${client} - "${req.method} ${target} HTTP/${req.httpVersion}" ${res.statusCode} ${phrase}`);
  });
  next();
}

export function buildServer(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(scopeMiddleware());
  app.use(accessLog);
  app.use(maintenanceGate);
  app.use(responseHeaders);
  app.use(fastapi.handler());
  app.use(serverError);
  return app;
}

/** The OpenAPI document, for tooling that wants it without a running server. */
export function openapi(): Record<string, unknown> {
  return fastapi.openapi();
}

// ── startup and shutdown ─────────────────────────────────────────────────────

/** node >= 24.10 has the SQLite authorizer the database browser depends on. */
function hasSqliteAuthorizer(): boolean {
  const [maj, min] = process.versions.node.split('.').map((x) => parseInt(x, 10));
  return maj > 24 || (maj === 24 && min >= 10);
}

async function startup(): Promise<void> {
  db.initDb();
  billing.ensureTables();
  notify.ensureTables();
  site.ensureTables();
  await worker.start();
  gpu.startWatchdog();
  console.log(`  engine mode : ${ENGINE_MODE}`);
  console.log(`  engine url  : ${ENGINE_URL}`);
  console.log(`  preset      : ${preset.PRESET_VERSION} (${preset.presetOnlyFingerprint().slice(0, 12)})`);
  console.log(`  payments    : ${billing.providerName()}${billing.live() ? '' : '  (TEST MODE - no money can move)'}`);
  // Printed because the failure is silent: on `resend` with no key, registration
  // succeeds and no confirmation email is ever sent.
  const mail = notify.status() as Record<string, any>;
  if (mail.backend === 'file') {
    console.log('  mail        : file  (written to data/mail, NOTHING is emailed)');
  } else if (mail.backend === 'resend' && !mail.resend_key_present) {
    console.log(`  mail        : resend but NO API KEY - confirmation emails will FAIL. See ${mail.resend_key_file}`);
  } else {
    console.log(`  mail        : ${mail.backend}, from ${mail.from}`);
  }

  // Really sending mail while every link in it points at this machine: the confirmation
  // arrives, looks right, and leads nowhere the recipient can reach.
  if (mail.backend !== 'file' && !PUBLIC_BASE_URL_EXPLICIT) {
    console.log(`  WARNING     : VS_PUBLIC_BASE_URL is not set, so emailed links will point at ${PUBLIC_BASE_URL} .`);
    console.log('                Set it to the real site, e.g. VS_PUBLIC_BASE_URL=https://kresker.com');
  }
  if (gpu.enabled()) {
    console.log(`  gpu auto    : ON  - starts when a dub is requested, stops ${Math.trunc(gpu.GPU_IDLE_MINUTES)} min after work ends`);
  } else {
    console.log('  gpu auto    : off (fake engine, nothing to start)');
  }
  console.log(
    `  signups     : max ${ratelimit.SIGNUP_PER_IP_HOUR}/hour and ${ratelimit.SIGNUP_PER_IP_DAY}/day per address, counted from the database`,
  );
  // Printed because it deletes customers' files: what it will and will not touch.
  const sweepSince = (process.env.VS_SOURCE_SWEEP_SINCE || '').trim();
  console.log(
    `  source clean: on - originals deleted with their dubs${sweepSince ? `; uploads before ${sweepSince} are left alone (VS_SOURCE_SWEEP_SINCE)` : ''}`,
  );

  // THE MISCONFIGURATION THAT TURNS EVERY PER-IP LIMIT INTO ONE SHARED BUCKET: behind a
  // proxy with this list empty, every caller resolves to the proxy's address.
  if (!TRUSTED_PROXIES.size && mail.backend !== 'file') {
    console.log('  WARNING     : VS_TRUSTED_PROXIES is empty. Behind a reverse proxy every caller');
    console.log('                counts as ONE address, so per-IP limits and the signup');
    console.log('                ceiling apply to the whole site at once. Set it to the proxy,');
    console.log('                e.g. VS_TRUSTED_PROXIES=127.0.0.1');
  }
  if (!hasSqliteAuthorizer()) {
    console.log(`  db browser  : OFF - node ${process.version} has no SQLite authorizer (needs 24.10+); it answers 503`);
  }

  // A backend that starts in maintenance mode looks exactly like a broken deploy.
  if (site.maintenance().on) console.log('  MAINTENANCE : ON - the public site is returning 503');
}

function parseArgs(argv: string[]): { host: string; port: number } {
  let host = HOST;
  let port = PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--host') host = value();
    else if (flag === '--port') port = parseInt(value(), 10);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
  return { host, port };
}

async function main(): Promise<void> {
  const { host, port } = parseArgs(process.argv.slice(2));

  // A background failure is logged, never fatal: in the Python backend a thread that
  // raised printed its traceback and the server carried on.
  process.on('unhandledRejection', (e) => console.error('  [unhandled rejection]', e));
  process.on('uncaughtException', (e) => console.error('  [uncaught exception]', e));

  await startup();

  const app = buildServer();
  const server: Server = app.listen(port, host);
  // An upload of a long video can take longer than Node's default five-minute request
  // limit; uvicorn had none. Idle keep-alive stays at five seconds, as uvicorn's was.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  server.on('listening', () => {
    const a = server.address();
    const shown = a && typeof a === 'object' ? `${a.address.includes(':') ? `[${a.address}]` : a.address}:${a.port}` : `${host}:${port}`;
    console.log(`INFO:     kresker backend (node ${process.version}) running on http://${shown} (Press CTRL+C to quit)`);
  });
  server.on('error', (e) => {
    console.error(`ERROR:    ${excStr(e)}`);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      // A second signal: stop waiting for open connections.
      process.exit(1);
    }
    stopping = true;
    console.log(`INFO:     ${signal}: shutting down`);
    const finish = async (): Promise<void> => {
      worker.stop();
      gpu.stopWatchdog();
      try {
        await gpu.shutdownTunnel();
      } catch {
        /* nothing to stop */
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
      console.log('INFO:     finished');
      process.exit(0);
    };
    server.close(() => void finish());
    server.closeIdleConnections();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
