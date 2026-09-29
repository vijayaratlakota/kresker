'use strict';
/*
  Shared helpers for the local browser check of the kresker.com frontend.

  SAFETY, in three layers, because the whole run must stay on this laptop:
    1. The browser is launched with a dead HTTP proxy (127.0.0.1:9) for every host
       except loopback, and a host-resolver rule that makes every hostname other
       than localhost unresolvable. Nothing can leave the machine even if a page
       asks for it.
    2. Every browser context routes all requests through `guard`, which lets only
       127.0.0.1 / localhost / data: / blob: through and ABORTS (and records)
       everything else, so a blocked request is visible in the results.
    3. `api()` refuses to build a request for anything that is not the local Vite
       origin.
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('C:/paid video player/node_modules/playwright');

const ROOT = __dirname;
const BASE = 'http://127.0.0.1:5174';
const BACKEND = 'http://127.0.0.1:8096';
const MAIL_DIR = 'c:\\video translator\\backend\\data\\mail';
const DATA_DIR = 'c:\\video translator\\backend\\data';
const VIDEO = 'c:\\video translator\\backend\\_realtest_30s.mp4';
const FFPROBE =
  'C:\\Users\\vijay\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffprobe.exe';
const CHROMIUM_EXE = path.join(
  process.env.LOCALAPPDATA || '',
  'ms-playwright',
  'chromium-1234',
  'chrome-win64',
  'chrome.exe',
);
const SHOTS = path.join(ROOT, 'shots');
const ART = path.join(ROOT, '_artifacts');
const RESULTS = path.join(ROOT, 'results.json');
const EVENTS = path.join(ROOT, 'events.json');
const STATE = path.join(ROOT, '_state.json');

for (const d of [SHOTS, ART, path.join(ART, 'downloads')]) fs.mkdirSync(d, { recursive: true });

// ── results ───────────────────────────────────────────────────────────────────

const results = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : [];
const events = []; // every console / network / page event, tagged with the step it happened in
const blocked = []; // every non-local request the guard refused
let currentStep = 'boot';
// continue the numbering across runs so screenshots sort in the order they were taken
let shotNo = fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).length;

function saveAll() {
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  let prev = [];
  try {
    prev = JSON.parse(fs.readFileSync(EVENTS, 'utf8'));
  } catch {
    prev = [];
  }
  // events.json is append-by-run: keep earlier runs' events
  fs.writeFileSync(EVENTS, JSON.stringify(prev.concat(events.splice(0)), null, 1));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

function record(area, item, status, note, extra = {}) {
  const row = { area, item, status, note: String(note || '').slice(0, 900), at: new Date().toISOString(), ...extra };
  results.push(row);
  console.log(`[${status}] ${area} | ${item} | ${row.note}`);
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  return row;
}

// ── event classification ────────────────────────────────────────────────────

/** Always-expected noise: a signed-out /api/auth/me is a 401 by design. */
const GLOBAL_ALLOW = [
  { kind: 'response', status: 401, url: /\/api\/auth\/me(\?|$)/ },
  { kind: 'console', text: /status of 401/, url: /\/api\/auth\/me(\?|$)/ },
  // Vite / React dev chatter that is not an error in the product
  { kind: 'console', text: /\[vite\]|Download the React DevTools/ },
];

function matches(ev, rule) {
  if (rule.kind && rule.kind !== ev.kind) return false;
  if (rule.status && rule.status !== ev.status) return false;
  if (rule.method && rule.method !== ev.method) return false;
  if (rule.url && !rule.url.test(ev.url || '')) return false;
  if (rule.text && !rule.text.test(ev.text || '')) return false;
  if (rule.type && rule.type !== ev.type) return false;
  return true;
}

/**
 * Split a step's events into expected / env (caused by the test's own network guard)
 * / unexpected. Console WARNINGS are kept but never fail a step.
 */
function classify(evs, allow = []) {
  const out = { expected: [], env: [], unexpected: [], warnings: [] };
  for (const ev of evs) {
    if (ev.kind === 'console' && ev.type === 'warning') {
      out.warnings.push(ev);
      continue;
    }
    // A confirm()/alert() the product raised on purpose is information, not an error.
    if (ev.kind === 'dialog') {
      out.expected.push(ev);
      continue;
    }
    if (GLOBAL_ALLOW.concat(allow).some((r) => matches(ev, r))) {
      out.expected.push(ev);
      continue;
    }
    const u = ev.url || '';
    const nonLocal = u && !isLocal(u);
    if (
      nonLocal ||
      ev.kind === 'blocked' ||
      /ERR_BLOCKED_BY_CLIENT|ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/.test(ev.text || ev.failure || '')
    ) {
      out.env.push(ev);
      continue;
    }
    // A request the browser itself cancelled because the page moved on is not a failure.
    if (ev.kind === 'requestfailed' && /ERR_ABORTED/.test(ev.failure || '')) {
      out.expected.push(ev);
      continue;
    }
    out.unexpected.push(ev);
  }
  return out;
}

function short(ev) {
  if (ev.kind === 'response') return `${ev.status} ${ev.method} ${trimUrl(ev.url)}`;
  if (ev.kind === 'requestfailed') return `FAILED ${ev.method} ${trimUrl(ev.url)} (${ev.failure})`;
  if (ev.kind === 'pageerror') return `PAGEERROR ${ev.text}`;
  if (ev.kind === 'blocked') return `BLOCKED ${ev.url}`;
  if (ev.kind === 'dialog') return `dialog.${ev.type}: ${String(ev.text).slice(0, 160)}`;
  return `console.${ev.type}: ${String(ev.text).slice(0, 200)}${ev.url ? ` @ ${trimUrl(ev.url)}` : ''}`;
}
function trimUrl(u) {
  return String(u || '').replace(BASE, '').replace(BACKEND, '[8096]').slice(0, 140);
}

/**
 * Run one checklist item. `fn` returns a note string, or {note, status}, or throws.
 * Unexpected console errors, page errors and failed/4xx/5xx requests seen while it
 * ran turn a PASS into a FAIL unless `opts.allow` lists them.
 */
async function step(area, item, fn, opts = {}) {
  currentStep = `${area} | ${item}`;
  const mark = events.length;
  let status = 'PASS';
  let note = '';
  let extra = {};
  try {
    const r = await fn();
    if (typeof r === 'string') note = r;
    else if (r && typeof r === 'object') {
      note = r.note || '';
      if (r.status) status = r.status;
      if (r.extra) extra = r.extra;
    }
  } catch (e) {
    status = 'FAIL';
    note = String((e && e.message) || e).split('\n').slice(0, 3).join(' / ');
  }
  // let late console lines land
  await sleep(opts.settleMs ?? 300);
  const evs = events.slice(mark);
  const c = classify(evs, opts.allow || []);
  if (c.unexpected.length && status === 'PASS' && !opts.noiseOk) {
    status = 'FAIL';
    note += ` | unexpected: ${c.unexpected.slice(0, 4).map(short).join(' ; ')}`;
  } else if (c.unexpected.length) {
    note += ` | noise: ${c.unexpected.slice(0, 4).map(short).join(' ; ')}`;
  }
  if (c.env.length) note += ` | env-blocked: ${[...new Set(c.env.map(short))].slice(0, 3).join(' ; ')}`;
  return record(area, item, status, note, {
    ...extra,
    unexpected: c.unexpected.map(short),
    env: [...new Set(c.env.map(short))],
    warnings: c.warnings.length,
  });
}

// ── browser ───────────────────────────────────────────────────────────────────

function isLocal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const LAUNCH_GUARD = {
  headless: true,
  proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost,[::1]' },
  args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1'],
};

async function launch(extra = {}) {
  try {
    return await chromium.launch({ ...LAUNCH_GUARD, ...extra });
  } catch (e) {
    if (extra.channel) throw e;
    console.log('default launch failed, retrying with the cached chrome.exe:', String(e.message).split('\n')[0]);
    return chromium.launch({ ...LAUNCH_GUARD, executablePath: CHROMIUM_EXE, ...extra });
  }
}

const dialogPolicy = new WeakMap(); // page -> 'accept' | 'dismiss'

function attach(page, ctxName) {
  const push = (ev) => events.push({ at: Date.now(), step: currentStep, ctx: ctxName, page: safeUrl(page), ...ev });
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const loc = m.location() || {};
    push({ kind: 'console', type: m.type(), text: m.text(), url: loc.url || '' });
  });
  page.on('pageerror', (e) => push({ kind: 'pageerror', text: `${e.name}: ${e.message}`, stack: String(e.stack || '').slice(0, 800) }));
  page.on('requestfailed', (r) => push({ kind: 'requestfailed', url: r.url(), method: r.method(), failure: (r.failure() || {}).errorText }));
  page.on('response', (r) => {
    if (r.status() >= 400) push({ kind: 'response', url: r.url(), method: r.request().method(), status: r.status() });
  });
  page.on('dialog', async (d) => {
    const pol = dialogPolicy.get(page) || 'dismiss';
    push({ kind: 'dialog', type: d.type(), text: d.message(), policy: pol });
    try {
      if (pol === 'accept') await d.accept();
      else await d.dismiss();
    } catch {
      /* already handled */
    }
  });
}
function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return '';
  }
}

async function newContext(browser, name, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    ...opts,
  });
  ctx.__name = name;
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (isLocal(url)) return route.continue();
    blocked.push({ ctx: name, url, step: currentStep });
    events.push({ at: Date.now(), step: currentStep, ctx: name, kind: 'blocked', url, method: route.request().method() });
    return route.abort('blockedbyclient');
  });
  ctx.on('page', (p) => attach(p, name));
  return ctx;
}

async function newPage(ctx) {
  const p = await ctx.newPage();
  // ctx.on('page') already attached it
  return p;
}

// ── page helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name, fullPage = false) {
  shotNo += 1;
  const file = path.join(SHOTS, `${String(shotNo).padStart(3, '0')}_${name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60)}.png`);
  try {
    await page.screenshot({ path: file, fullPage });
  } catch (e) {
    return `(screenshot failed: ${String(e.message).split('\n')[0]})`;
  }
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

async function goto(page, p, opts = {}) {
  const url = p.startsWith('http') ? p : BASE + p;
  if (!isLocal(url)) throw new Error(`refusing to navigate to non-local ${url}`);
  const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout || 45000 });
  return r;
}

async function h1(page, timeout = 20000) {
  const loc = page.locator('h1').first();
  await loc.waitFor({ state: 'visible', timeout });
  return (await loc.innerText()).trim();
}

/** Wait for a sonner toast whose text matches. Returns its text. */
async function toast(page, re, timeout = 10000) {
  const loc = page.locator('[data-sonner-toast]').filter({ hasText: re }).first();
  await loc.waitFor({ state: 'visible', timeout });
  return (await loc.innerText()).replace(/\s+/g, ' ').trim();
}

async function dismissBanner(page) {
  const b = page.locator('[data-consent-banner="true"]');
  if (await b.isVisible().catch(() => false)) {
    await b.getByRole('button', { name: 'No analytics' }).click();
    await b.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
  }
}

async function text(page, sel = 'body') {
  return (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ');
}

// ── API (through the Vite origin, sharing the context's cookies) ─────────────

async function api(ctx, method, url, { json, csrf = true, headers = {}, maxRedirects = 0 } = {}) {
  const full = url.startsWith('http') ? url : BASE + url;
  if (!isLocal(full)) throw new Error(`refusing non-local API call ${full}`);
  const h = { ...headers };
  if (method !== 'GET' && csrf) {
    const me = await ctx.request.get(BASE + '/api/auth/me', { failOnStatusCode: false });
    if (me.ok()) h['X-CSRF-Token'] = (await me.json()).csrf;
  }
  const r = await ctx.request.fetch(full, { method, data: json, headers: h, failOnStatusCode: false, maxRedirects });
  const t = await r.text();
  let body;
  try {
    body = t ? JSON.parse(t) : null;
  } catch {
    body = t;
  }
  return { status: r.status(), body, headers: r.headers() };
}

// ── mail outbox ──────────────────────────────────────────────────────────────

function mailFiles(address, kind) {
  const suffix = `_${kind}_${address.replace(/[^A-Za-z0-9._@-]/g, '_')}.txt`;
  return fs
    .readdirSync(MAIL_DIR)
    .filter((f) => f.endsWith(suffix))
    .map((f) => {
      const full = path.join(MAIL_DIR, f);
      return { f, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

async function waitMail(address, kind, { after = 0, timeout = 20000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const fresh = mailFiles(address, kind).filter((m) => m.mtime > after);
    if (fresh.length) {
      const m = fresh[fresh.length - 1];
      return { file: m.f, full: m.full, text: fs.readFileSync(m.full, 'utf8'), count: fresh.length };
    }
    if (Date.now() - t0 > timeout) throw new Error(`no ${kind} mail for ${address} within ${timeout} ms`);
    await sleep(500);
  }
}

function linkIn(textBody, pathname) {
  const all = textBody.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  const hit = all.find((u) => {
    try {
      return new URL(u).pathname === pathname;
    } catch {
      return false;
    }
  });
  return { hit, all };
}

// ── media ────────────────────────────────────────────────────────────────────

function ffprobe(file) {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels:stream_tags=language:format=format_name,duration', '-of', 'json', file],
      { encoding: 'utf8', timeout: 60000 },
    );
    return JSON.parse(out);
  } catch (e) {
    return { error: String(e.message).split('\n')[0] };
  }
}

module.exports = {
  ROOT,
  BASE,
  BACKEND,
  MAIL_DIR,
  DATA_DIR,
  VIDEO,
  FFPROBE,
  ART,
  SHOTS,
  results,
  events,
  blocked,
  record,
  step,
  classify,
  short,
  isLocal,
  launch,
  newContext,
  newPage,
  dialogPolicy,
  sleep,
  shot,
  goto,
  h1,
  toast,
  dismissBanner,
  text,
  api,
  mailFiles,
  waitMail,
  linkIn,
  ffprobe,
  loadState,
  saveState,
  saveAll,
  setStep: (s) => (currentStep = s),
};
