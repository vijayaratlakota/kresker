/**
 * The public site surface: settings, maintenance mode, robots.txt and the sitemap.
 *
 * Everything here answers a request that is NOT part of the product — a crawler asking
 * what it may index, a visitor arriving during a migration, somebody following a dead
 * link. They decide whether the site looks maintained.
 *
 * The page list is declared once: `PUBLIC_PAGES` is the source for the sitemap, and the
 * frontend router (and its "last updated" dates) must agree with it.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, PUBLIC_BASE_URL } from './config';
import * as db from './db';

// ── which build of the dashboard is being served ─────────────────────────────
// A tab left open across a deploy keeps running the old JavaScript; the app is told
// which build the server has so it can offer a reload. The id is the entry chunk's
// content hash, read out of index.html, so it cannot drift.
const DIST_DIR = process.env.VS_FRONTEND_DIST || path.join(path.dirname(BASE_DIR), 'frontend', 'dist');
const ENTRY_RX = /assets\/(index-[A-Za-z0-9_-]+)\.js/;

// cached against the file's mtime, so a dist-only deploy is noticed without a restart
let build: [number, string | null] | null = null;

/** The dashboard build this server is serving, or null if unknown. */
export function buildId(): string | null {
  const p = path.join(DIST_DIR, 'index.html');
  let mtime: number;
  try {
    mtime = statSync(p).mtimeMs;
  } catch {
    return null;
  }
  if (build !== null && build[0] === mtime) return build[1];
  let m: RegExpExecArray | null;
  try {
    m = ENTRY_RX.exec(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  // just the hash: there is no reason to publish our asset naming
  const found = m ? m[1].slice(m[1].indexOf('-') + 1) : null;
  build = [mtime, found];
  return found;
}

export const MAINTENANCE_KEY = 'maintenance';
export const MAINTENANCE_NOTE_KEY = 'maintenance_note';

export const DEFAULT_MAINTENANCE_NOTE =
  'We are making some changes and will be back shortly. Your videos and your ' + 'minutes are safe — nothing is being deleted.';

export function ensureTables(): void {
  db.execute(
    'CREATE TABLE IF NOT EXISTS app_settings (' +
      ' key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL,' +
      ' updated_by INTEGER REFERENCES users(id))',
  );
}

export function get(key: string, dflt: string | null = null): string | null {
  const row = db.one('SELECT value FROM app_settings WHERE key=?', [key]);
  return row ? row.value : dflt;
}

/** Upsert. `updated_by` is recorded because turning the site off needs a name. */
export function put(key: string, value: string | null, adminUserId: number | null = null): void {
  db.execute(
    'INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)' +
      ' ON CONFLICT(key) DO UPDATE SET value=excluded.value,' +
      ' updated_at=excluded.updated_at, updated_by=excluded.updated_by',
    [key, value, db.now(), adminUserId],
  );
}

// What a crawler is told to wait: long enough that Google backs off, short enough that
// a short window does not cost a day of freshness.
export const MAINTENANCE_RETRY_AFTER_S = parseInt(process.env.VS_MAINTENANCE_RETRY_AFTER_S || '600', 10);

export interface Maintenance {
  on: boolean;
  note: string;
  since: string | null;
  by: string | null;
  retry_after_s: number;
}

/**
 * Is the site in maintenance mode, and what does the public page say? Read from the
 * database on every call: a cache would make an admin wait to get the site back.
 */
export function maintenance(): Maintenance {
  let on: boolean;
  let note: string;
  let row: db.Row | null;
  try {
    on = (get(MAINTENANCE_KEY) || '0') === '1';
    note = get(MAINTENANCE_NOTE_KEY) || DEFAULT_MAINTENANCE_NOTE;
    row = db.one(
      'SELECT s.updated_at, s.updated_by, u.email FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key=?',
      [MAINTENANCE_KEY],
    );
  } catch {
    // a database that cannot be read is not a reason to lock everybody out
    return { on: false, note: DEFAULT_MAINTENANCE_NOTE, since: null, by: null, retry_after_s: MAINTENANCE_RETRY_AFTER_S };
  }
  return {
    on,
    note,
    since: row ? row.updated_at : null,
    by: on ? (row && 'email' in row ? row.email : null) : null,
    retry_after_s: MAINTENANCE_RETRY_AFTER_S,
  };
}

// Maintenance blocks the PUBLIC, never the operator: anything an admin needs to turn it
// back off keeps working, and a 503 on robots.txt would make Google drop the site.
export const MAINTENANCE_ALLOW_PREFIXES = [
  '/api/health',
  '/api/auth',
  '/api/admin',
  '/api/site',
  '/robots.txt',
  '/sitemap.xml',
  '/favicon.ico',
  '/static/',
  '/db',
  '/docs',
  '/openapi.json',
];

export function allowedDuringMaintenance(p: string): boolean {
  return MAINTENANCE_ALLOW_PREFIXES.some((x) => p === x || p.startsWith(x));
}

// ── the sitemap ───────────────────────────────────────────────────────────────
// Only pages a stranger can reach and would want in a search result. The date is when
// the page's CONTENT last really changed — hand-set on purpose, and it must match
// ROUTES[].updated in frontend/src/lib/seo.ts (the SEO suite checks the two agree).
export const PUBLIC_PAGES: ReadonlyArray<readonly [string, string]> = [
  ['/', '2026-09-02'],
  ['/pricing', '2026-09-02'],
  ['/languages', '2026-09-02'],
  ['/about', '2026-09-02'],
  ['/contact', '2026-09-02'],
  ['/privacy', '2026-09-02'],
  ['/terms', '2026-09-02'],
  ['/disclaimer', '2026-09-02'],
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function baseUrl(): string {
  return (PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

export function sitemapUrls(): string[] {
  const b = baseUrl();
  return PUBLIC_PAGES.map(([p]) => (p !== '/' ? `${b}${p}` : `${b}/`));
}

export function pageLastmod(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, stamp] of PUBLIC_PAGES) out[p] = stamp;
  return out;
}

/** xml.sax.saxutils.escape */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;');
}

/** A sitemap with real per-page dates; a date in the future is dropped, not emitted. */
export function sitemapXml(): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  const b = baseUrl();
  for (const [p, stamp] of PUBLIC_PAGES) {
    const url = p === '/' ? `${b}/` : `${b}${p}`;
    let row = `  <url><loc>${xmlEscape(url)}</loc>`;
    if (ISO_DATE.test(stamp) && stamp <= today) row += `<lastmod>${stamp}</lastmod>`;
    lines.push(row + '</url>');
  }
  lines.push('</urlset>');
  return lines.join('\n') + '\n';
}

/**
 * What a crawler may touch, and where the sitemap is. The sitemap line is absolute; a
 * non-https origin (localhost, a misconfigured deploy) serves `Disallow: /`.
 */
export function robotsTxt(): string {
  const b = baseUrl();
  if (!b.startsWith('https://')) {
    return (
      '# Not a production origin (PUBLIC_BASE_URL is not https), so nothing\n' +
      '# here should be indexed. Set VS_PUBLIC_BASE_URL to the real origin.\n' +
      'User-agent: *\n' +
      'Disallow: /\n'
    );
  }
  return (
    'User-agent: *\n' +
    'Allow: /\n' +
    '\n' +
    '# The dashboard needs a session, so a crawler only ever gets a redirect.\n' +
    'Disallow: /app\n' +
    'Disallow: /app/\n' +
    '# Sign-in forms in search results are noise.\n' +
    'Disallow: /login\n' +
    'Disallow: /signup\n' +
    'Disallow: /reset\n' +
    '# Signed download links. Short-lived, single-object, and not content.\n' +
    'Disallow: /dl/\n' +
    "# The API and the operator's tools.\n" +
    'Disallow: /api/\n' +
    'Disallow: /db\n' +
    'Disallow: /docs\n' +
    '\n' +
    `Sitemap: ${b}/sitemap.xml\n`
  );
}
