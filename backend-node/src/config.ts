/**
 * Configuration. Everything comes from the environment, with local-development defaults.
 *
 * Every variable name, default and meaning is the same as the Python backend's
 * `app/config.py`, because both read the SAME environment file on the server
 * (`/opt/voicestudio/voicestudio.env`). A name that drifted here would be a setting that
 * silently stops applying the day this backend takes over.
 *
 * Nothing here talks to the dubbing engine. `engine.ts` is deliberately the only module
 * that knows the engine exists.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pyRound } from './py';

const env = process.env;

/** This package's own root: backend-node/. */
export const NODE_ROOT = path.resolve(__dirname, '..');

/**
 * The directory the DATA defaults are relative to.
 *
 * Deliberately the PYTHON backend's directory, `backend/`, rather than this package's.
 * During development and in the test harness both runtimes must read and write the same
 * `backend/data` — the same database, the same `secret.key`, the same mail outbox the
 * test suites read confirmation links out of. Production sets VS_DATA_DIR explicitly, so
 * there this only decides nothing.
 */
export const BASE_DIR = path.resolve(env.VS_BACKEND_DIR || path.join(NODE_ROOT, '..', 'backend'));

/** The repository root, for the frontend build the site reads its build stamp from. */
export const REPO_ROOT = path.resolve(BASE_DIR, '..');

export const DATA_DIR = path.resolve(env.VS_DATA_DIR || path.join(BASE_DIR, 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
export const DB_PATH = path.resolve(env.VS_DB_PATH || path.join(DATA_DIR, 'app.db'));

for (const d of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) mkdirSync(d, { recursive: true });

// ── the engine ───────────────────────────────────────────────────────────────
// Where the dubbing engine answers. Locally an SSH tunnel to the GPU box:
//   ssh -L 3900:localhost:3900 ubuntu@<box>
export const ENGINE_URL = (env.VS_ENGINE_URL || 'http://127.0.0.1:3900').replace(/\/+$/, '');

// "fake" runs a built-in stand-in so the whole flow can be exercised with no GPU and no
// cost. "real" drives the actual engine. Only engine.ts branches on this.
export const ENGINE_MODE = (env.VS_ENGINE_MODE || 'fake').toLowerCase();

// Per-read timeout on the transcribe stream. Per-read, not total: the clone-building tail
// of that stream goes quiet for minutes at a time, and a total timeout cannot tell
// "still working" from "wedged". 900 s is what the tuned driver settled on.
export const ENGINE_STREAM_READ_TIMEOUT_S = parseFloat(env.VS_STREAM_READ_TIMEOUT_S || '900');
export const ENGINE_CONNECT_TIMEOUT_S = parseFloat(env.VS_CONNECT_TIMEOUT_S || '30');
export const ENGINE_RENDER_TIMEOUT_S = parseFloat(env.VS_RENDER_TIMEOUT_S || '7200');

// ── web ──────────────────────────────────────────────────────────────────────
export const HOST = env.VS_HOST || '127.0.0.1';
export const PORT = parseInt(env.VS_PORT || '8080', 10);

// Used in outbound email, where there is no incoming request to read the host from.
export const PUBLIC_BASE_URL = env.VS_PUBLIC_BASE_URL || `http://127.0.0.1:${env.VS_PORT || '8099'}`;

// Whether the value above was SUPPLIED rather than defaulted. Behind a proxy the request's
// own base URL is the loopback address, so emailed links must come from this.
export const PUBLIC_BASE_URL_EXPLICIT = Boolean(env.VS_PUBLIC_BASE_URL);

// A name for THIS installation, recorded in every migration archive.
export const DEPLOYMENT = env.VS_DEPLOYMENT || 'unnamed-dev';

export const SESSION_COOKIE = 'vs_session';
export const CSRF_HEADER = 'X-CSRF-Token';

// ── how long somebody stays signed in ────────────────────────────────────────
// A SLIDING window with an ABSOLUTE CAP. TTL is how long a session survives with no
// activity; MAX is the ceiling from creation no matter how active it has been.
export const SESSION_TTL_DAYS = parseInt(env.VS_SESSION_TTL_DAYS || '30', 10);
export const SESSION_MAX_DAYS = parseInt(env.VS_SESSION_MAX_DAYS || '180', 10);

// Don't move the expiry and re-send the cookie on every request — only once it has
// drifted more than this far from full.
export const SESSION_RENEW_AFTER_HOURS = parseFloat(env.VS_SESSION_RENEW_AFTER_HOURS || '6');

// Secure by DEFAULT, with an explicit opt-out for http://127.0.0.1 development.
export const COOKIE_SECURE = (env.VS_COOKIE_INSECURE || '0') !== '1';

// ── whose X-Forwarded-For do we believe? ─────────────────────────────────────
// Nobody's by default. Behind a reverse proxy, list the proxy's address and the header
// is honoured from that peer alone:   VS_TRUSTED_PROXIES=127.0.0.1,10.0.0.5
export const TRUSTED_PROXIES: ReadonlySet<string> = new Set(
  (env.VS_TRUSTED_PROXIES || '').split(',').map((p) => p.trim()).filter(Boolean),
);

// ── retention ────────────────────────────────────────────────────────────────
export const FREE_RETENTION_HOURS = 24;
export const PAID_RETENTION_DAYS = 7;

// ── ffprobe, for measuring real video duration server-side ──────────────────
export const FFPROBE = env.VS_FFPROBE || 'ffprobe';

export const MAX_UPLOAD_BYTES = parseInt(env.VS_MAX_UPLOAD_BYTES || String(4 * 1024 * 1024 * 1024), 10);

// The first account registered becomes admin, so a fresh database has a way in without
// shipping a default password.
export const FIRST_USER_IS_ADMIN = (env.VS_FIRST_USER_IS_ADMIN || '1') === '1';

// ── the GPU instance, started and stopped automatically ─────────────────────
// Only active when ENGINE_MODE is "real". Uses the aws CLI rather than an SDK, because
// the CLI is already configured with the right profile.
export const GPU_AUTO = (env.VS_GPU_AUTO || '1') === '1';
export const GPU_INSTANCE_ID = env.VS_GPU_INSTANCE_ID || 'i-041b48c591cb86e19';
export const GPU_CONTAINER_ID = env.VS_GPU_CONTAINER_ID || '9276383fe31e';
export const AWS_PROFILE = env.VS_AWS_PROFILE || 'videotrans';
export const AWS_REGION = env.VS_AWS_REGION || 'ap-south-1';
export const SSH_EXE = env.VS_SSH_EXE || 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
export const SSH_KEY = env.VS_SSH_KEY || path.join(env.USERPROFILE || '~', '.ssh', 'videotrans-key.pem');
export const SSH_USER = env.VS_SSH_USER || 'ubuntu';
export const ENGINE_PORT = parseInt(env.VS_ENGINE_PORT || '3900', 10);

// Stop the box this long after the last piece of work finished. Ten rather than five,
// because a boot costs about six minutes of GPU time either way.
export const GPU_IDLE_MINUTES = parseFloat(env.VS_GPU_IDLE_MINUTES || '10');

// How long an accepted upload with no job yet still holds the box up. ZERO: nothing
// starts until the customer presses Dub, so a grace here only kept a box alive for a
// decision that might never come.
export const UPLOAD_GRACE_MINUTES = parseFloat(env.VS_UPLOAD_GRACE_MINUTES || '0');

export const GPU_BOOT_TIMEOUT_S = parseFloat(env.VS_GPU_BOOT_TIMEOUT_S || '600');
export const GPU_APP_TIMEOUT_S = parseFloat(env.VS_GPU_APP_TIMEOUT_S || '420');

// Reach the GPU box on its PRIVATE address. Only correct inside the same VPC, which is
// true on the web server and false on a laptop.
export const GPU_USE_PRIVATE_IP = ['1', 'true', 'yes'].includes((env.VS_GPU_USE_PRIVATE_IP || '').trim());

// How long a browser has to finish PUTting a video straight into storage. An int: it is
// signed into a URL as one and reported as one.
export const UPLOAD_URL_TTL_S = Math.trunc(parseFloat(env.VS_UPLOAD_URL_TTL_S || '900'));

// ── Cloudflare R2, for delivering finished videos ───────────────────────────
export const R2_ENV_FILE = env.VS_R2_ENV || path.join(env.USERPROFILE || '~', '.secrets', 'r2.env');
export const R2_ENABLED = (env.VS_R2_ENABLED || '0') === '1';
export const R2_PREFIX = env.VS_R2_PREFIX || 'dubs';

// ── Google sign-in ───────────────────────────────────────────────────────────
export const GOOGLE_ENV_FILE =
  env.VS_GOOGLE_ENV || path.join(env.USERPROFILE || '~', '.secrets', 'google.env');

// Where Google sends the browser back to. Must match the Google Cloud console character
// for character, so it cannot be derived from the incoming request.
export const GOOGLE_REDIRECT_URI =
  env.VS_GOOGLE_REDIRECT_URI || PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/auth/google/callback';

// Secret for signing download tokens. Generated and persisted on first run so a restart
// does not invalidate every outstanding link. SHARED with the Python backend.
export const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
export const DOWNLOAD_TOKEN_TTL_S = parseInt(env.VS_DOWNLOAD_TOKEN_TTL_S || '300', 10);

// Playback needs a longer window than a download, because a <video> element fetches a
// new range every time the viewer seeks.
export const STREAM_TOKEN_TTL_S = parseInt(env.VS_STREAM_TOKEN_TTL_S || '7200', 10);

// ── Razorpay ─────────────────────────────────────────────────────────────────
// With no keys set the provider runs in test mode: it mints its own order ids and signs
// its own webhooks with the local secret, so the whole flow is exercisable offline.
export const RAZORPAY_KEY_ID = env.VS_RAZORPAY_KEY_ID || '';
export const RAZORPAY_KEY_SECRET = env.VS_RAZORPAY_KEY_SECRET || '';
export const RAZORPAY_WEBHOOK_SECRET = env.VS_RAZORPAY_WEBHOOK_SECRET || '';
export const RAZORPAY_API = env.VS_RAZORPAY_API || 'https://api.razorpay.com/v1';

// ── Dodo Payments ────────────────────────────────────────────────────────────
// Credentials live in a file outside the repository. Path.home(), not USERPROFILE: on
// Linux USERPROFILE does not exist, and a quiet fallback here would silently switch the
// payment provider.
export const DODO_ENV_FILE = env.VS_DODO_ENV || path.join(homedir(), '.secrets', 'dodo.env');

// test | live. Chooses the API host.
export const DODO_MODE = env.VS_DODO_MODE || '';
export const DODO_API_TEST = env.VS_DODO_API_TEST || 'https://test.dodopayments.com';
export const DODO_API_LIVE = env.VS_DODO_API_LIVE || 'https://live.dodopayments.com';

// How far a webhook's own timestamp may be out of step before it is refused. Stops a
// captured signature being replayed indefinitely.
export const DODO_WEBHOOK_TOLERANCE_S = parseInt(env.VS_DODO_WEBHOOK_TOLERANCE_S || '300', 10);

// RBI's per-transaction ceiling for recurring debits taken without re-authentication.
export const MANDATE_NO_AFA_CEILING_PAISE = parseInt(
  env.VS_MANDATE_CEILING_PAISE || String(15000 * 100),
  10,
);

// GST as a fraction. EVERY price in `plans` is NET of this: the provider adds it on top.
export const GST_RATE = parseFloat(env.VS_GST_RATE || '0.18');

// ── IndexNow ─────────────────────────────────────────────────────────────────
// Not a secret: it is served publicly at https://<host>/<key>.txt.
export const INDEXNOW_KEY = (env.VS_INDEXNOW_KEY || '').trim();

/** A price with GST added, rounded to the paise. Indicative, not authoritative. */
export function withTaxPaise(netPaise: number): number {
  return Math.trunc(pyRound(Math.trunc(netPaise) * (1.0 + GST_RATE)));
}

// Access survives this long past the end of a paid period.
export const BILLING_GRACE_DAYS = parseFloat(env.VS_BILLING_GRACE_DAYS || '7');

// Annual plans do not renew themselves, so these reminders are load-bearing.
export const RENEWAL_REMINDER_DAYS = [14, 3, 0];

/**
 * Restrict a file to its owner, on whichever platform this is.
 *
 * chmod alone does almost nothing on Windows, so there `icacls` removes inherited access
 * and leaves one grant. Never throws: a backend that will not start because it could not
 * tighten a permission is worse than one that starts and says so.
 */
export function lockDown(file: string): string {
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  if (process.platform !== 'win32') return 'chmod 0600';
  const user = env.USERNAME || '';
  const domain = env.USERDOMAIN || '';
  const who = domain && user ? `${domain}\\${user}` : user;
  if (!who) return 'no ACL applied (could not determine the current user)';
  try {
    // Synchronous on purpose: this runs once, at startup, before the server listens.
    const p = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${who}:F`], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (p.status === 0) return `ACL restricted to ${who}`;
    return `icacls failed rc=${p.status}: ${(p.stderr || '').trim().slice(0, 120)}`;
  } catch (e) {
    return `icacls not applied: ${(e as Error).name}`;
  }
}

let secretCache: Buffer | null = null;

/**
 * The per-installation secret: 32 RAW bytes in DATA_DIR/secret.key.
 *
 * SHARED WITH THE PYTHON BACKEND, and read as a Buffer — never decoded, never trimmed.
 * Download links, the Google sign-in state cookie and the test-mode webhook secrets are
 * all HMAC'd with these bytes, so a Node server and a Python server on the same data
 * directory accept each other's tokens. That is what makes a rollback invisible.
 */
export function appSecret(): Buffer {
  if (secretCache) return secretCache;
  if (existsSync(SECRET_FILE)) {
    secretCache = readFileSync(SECRET_FILE);
    return secretCache;
  }
  const val = randomBytes(32);
  // Created empty and locked down BEFORE the bytes go in, so there is no window in which
  // the key exists on disk with inherited permissions.
  closeSync(openSync(SECRET_FILE, 'a'));
  const how = lockDown(SECRET_FILE);
  writeFileSync(SECRET_FILE, val);
  console.log(`  secret.key  : created; ${how}`);
  secretCache = val;
  return val;
}

/**
 * Read a KEY=VALUE credentials file the way every loader in this codebase does: blank
 * lines and `#` comments skipped, split at the first `=`, both sides stripped, then one
 * layer of double quotes and one of single quotes removed from the value.
 */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    if (!existsSync(file)) return out;
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  // Python's str.splitlines() splits on more than \n; these are the ones a text file
  // plausibly contains.
  for (const raw of text.split(/\r\n|\r|\n|\x0b|\x0c|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/)) {
    const line = pyStripSimple(raw);
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = pyStripSimple(line.slice(0, i));
    let v = pyStripSimple(line.slice(i + 1));
    v = stripChars(stripChars(v, '"'), "'");
    out[k] = v;
  }
  return out;
}

// Local, dependency-free versions: config.ts is imported by everything, including py.ts's
// own tests, so it avoids pulling more than it needs.
const WS = new Set([...'\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000']);
function pyStripSimple(s: string): string {
  const c = [...s];
  let a = 0;
  let b = c.length;
  while (a < b && WS.has(c[a])) a++;
  while (b > a && WS.has(c[b - 1])) b--;
  return c.slice(a, b).join('');
}
function stripChars(s: string, ch: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === ch) a++;
  while (b > a && s[b - 1] === ch) b--;
  return s.slice(a, b);
}
