/**
 * Outbound email.
 *
 * Locally every message is written to data/mail/ as a file and logged, so the whole flow
 * can be exercised and read back without a mail account or a real inbox. The test suites
 * read confirmation links out of those files, so their names and contents are exactly
 * the ones the Python backend wrote. Set VS_MAIL_BACKEND=resend (or ses) to send for
 * real — the call sites do not change.
 *
 * Every message is also recorded in the database, so "did we tell them?" is a query
 * rather than a guess.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PUBLIC_BASE_URL, readEnvFile } from './config';
import * as db from './db';
import * as media from './media';
import * as procs from './procs';
import { errText, fmtStamp, pyDumps, pySlice, pyStrip, pyTitle } from './py';

export const MAIL_DIR = path.join(DATA_DIR, 'mail');
mkdirSync(MAIL_DIR, { recursive: true });

const env = process.env;
export const BACKEND = (env.VS_MAIL_BACKEND || 'file').toLowerCase(); // file | resend | ses
const AWS_PROFILE = env.VS_AWS_PROFILE || 'videotrans';
const AWS_REGION = env.VS_AWS_REGION || 'ap-south-1';

// Who the mail is FROM. The address need not be a mailbox: SPF/DKIM on the domain are
// what make it legitimate, and a reply to no-reply@ simply bounces.
export const MAIL_FROM = env.VS_MAIL_FROM || env.VS_SES_FROM || 'no-reply@kresker.com';
const SES_FROM = MAIL_FROM;
export const MAIL_FROM_NAME = env.VS_MAIL_FROM_NAME ?? 'Kresker';

const RESEND_API = env.VS_RESEND_API || 'https://api.resend.com/emails';

// Read from a file OUTSIDE the repository, like the storage credentials.
export const RESEND_ENV_FILE = env.VS_RESEND_ENV || path.join(env.USERPROFILE || '~', '.secrets', 'resend.env');

let resendCfg: Record<string, string> | null = null;

/** The Resend API key: the environment wins, then the secrets file (read once). */
function resendKey(): string {
  const direct = env.VS_RESEND_API_KEY;
  if (direct) return pyStrip(direct);
  if (resendCfg === null) resendCfg = readEnvFile(RESEND_ENV_FILE);
  return extractKey(resendCfg.RESEND_API_KEY || '');
}

const KEY_RE = /re_[A-Za-z0-9_-]{16,}/;

/**
 * Pull the key out of whatever was actually pasted: a leftover placeholder, a stray
 * quote or label, a trailing comma. A value with no key-shaped token is "no key".
 */
function extractKey(value: string): string {
  let val = pyStrip(value || '');
  val = val.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
  if (!val) return '';
  val = val.split('re_PASTE_YOUR_KEY_HERE').join('');
  const m = KEY_RE.exec(val);
  return m ? m[0] : '';
}

function fromHeader(): string {
  return MAIL_FROM_NAME ? `${MAIL_FROM_NAME} <${MAIL_FROM}>` : MAIL_FROM;
}

// Where a customer's reply goes. People DO reply to confirmation emails, usually because
// something went wrong; this address receives.
const MAIL_REPLY_TO = env.VS_MAIL_REPLY_TO ?? 'support@kresker.com';

// The brand mark, a PNG on the public bucket (mail clients refuse SVG). Empty means the
// header falls back to the wordmark alone.
const MAIL_LOGO_URL = env.VS_MAIL_LOGO_URL ?? 'https://pub-ecadf7ff6f844029a4030f2afadfb990.r2.dev/v1/brand/kresker-mark.png';

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

type Block = string | [string, string[]];

/**
 * The branded HTML shell. Tables and inline styles, because Outlook renders with Word's
 * engine and Gmail strips <style> blocks; light background, because clients invert dark
 * mail unpredictably. Blocks are paragraphs or [title, items] lists; `cta` is
 * [label, url].
 */
function htmlShell(heading: string, blocks: Block[], cta: [string, string] | null = null, closing: string | null = null): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (Array.isArray(b)) {
      const [title, items] = b;
      parts.push(`<p style="margin:26px 0 8px;font:600 13px/1.4 ${FONT};color:#0a0b0d;letter-spacing:.02em;">` + title + '</p>');
      const lis = items.map((i) => '<li style="margin:0 0 6px;">' + i + '</li>').join('');
      parts.push(`<ul style="margin:0;padding-left:20px;font:400 14px/1.65 ${FONT};color:#41464e;">` + lis + '</ul>');
    } else {
      parts.push(`<p style="margin:0 0 14px;font:400 15px/1.65 ${FONT};color:#41464e;">` + b + '</p>');
    }
  }

  let button = '';
  if (cta) {
    const [label, url] = cta;
    // A table-wrapped anchor: Outlook ignores padding on inline elements.
    button =
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"' +
      ' style="margin:26px 0 8px;"><tr><td align="center"' +
      ' style="border-radius:10px;background:#0a0b0d;">' +
      `<a href="${url}" style="display:inline-block;padding:13px 26px;` +
      `font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:10px;">` +
      `${label}</a></td></tr></table>`;
  }

  let tail = '';
  if (closing) {
    tail =
      '<p style="margin:26px 0 0;padding-top:18px;' +
      `border-top:1px solid #e8eaed;font:400 13px/1.6 ${FONT};color:#767c86;">` +
      closing +
      '</p>';
  }

  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + heading + '</title></head>' +
    '<body style="margin:0;padding:0;background:#f4f5f7;">' +
    // the grey preheader an inbox shows next to the subject
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + heading + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"' +
    ' border="0" style="background:#f4f5f7;"><tr><td align="center"' +
    ' style="padding:32px 16px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"' +
    ' border="0" style="max-width:560px;background:#ffffff;border-radius:14px;' +
    'border:1px solid #e8eaed;">' +
    // header: the mark beside the wordmark; the wordmark is text and always renders
    '<tr><td style="padding:26px 30px 0;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    (MAIL_LOGO_URL
      ? '<td style="padding-right:10px;vertical-align:middle;">' +
        `<img src="${MAIL_LOGO_URL}" width="32" height="32" alt="Kresker"` +
        ' style="display:block;border:0;width:32px;height:32px;border-radius:9px;">' +
        '</td>'
      : '') +
    '<td style="vertical-align:middle;">' +
    `<span style="font:700 19px/1 ${FONT};color:#0a0b0d;letter-spacing:-.01em;">Kresker</span>` +
    '</td></tr></table></td></tr>' +
    // body
    '<tr><td style="padding:22px 30px 30px;">' +
    `<h1 style="margin:0 0 14px;font:600 21px/1.3 ${FONT};color:#0a0b0d;">` + heading + '</h1>' +
    parts.join('') + button + tail +
    '</td></tr></table>' +
    // footer outside the card
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"' +
    ' border="0" style="max-width:560px;"><tr><td align="center"' +
    ` style="padding:18px 10px 0;font:400 12px/1.6 ${FONT};color:#9aa0a8;">` +
    'Kresker &middot; <a href="https://kresker.com" style="color:#9aa0a8;">' +
    'kresker.com</a><br>' +
    'You received this because someone used this address to sign up.' +
    '</td></tr></table>' +
    '</td></tr></table></body></html>'
  );
}

/** POST one message to Resend. Never throws: the outcome is recorded either way. */
async function sendResend(to: string, subject: string, body: string, html: string | null): Promise<[boolean, string | null]> {
  const key = resendKey();
  if (!key) {
    return [false, `no Resend API key: set VS_RESEND_API_KEY or put RESEND_API_KEY=... in ${RESEND_ENV_FILE}`];
  }
  try {
    const payload: Record<string, unknown> = { from: fromHeader(), to: [to], subject, text: body };
    if (html) payload.html = html;
    if (MAIL_REPLY_TO) payload.reply_to = MAIL_REPLY_TO;
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      // httpx's json= encoding: compact, UTF-8, no ASCII escaping
      body: pyDumps(payload, { separators: [',', ':'], ensureAscii: false, allowNan: false }),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 200 || r.status === 201) return [true, null];
    // Resend's own message is the useful part: an unverified domain says so.
    return [false, `resend ${r.status}: ${pySlice(await r.text(), 250)}`];
  } catch (e) {
    return [false, errText(e)];
  }
}

/** What the admin panel shows about mail. Never includes the key itself. */
export function status(): Record<string, unknown> {
  return {
    backend: BACKEND,
    from: fromHeader(),
    resend_key_present: BACKEND === 'resend' ? Boolean(resendKey()) : null,
    resend_key_file: BACKEND === 'resend' ? RESEND_ENV_FILE : null,
    outbox_dir: MAIL_DIR,
    note: BACKEND === 'file' ? 'writing to disk; nothing is actually emailed' : 'sending for real - a failed send is recorded in the emails table',
  };
}

/** Called at startup, so the table exists before the first message. */
export function ensureTables(): void {
  ensureTable();
}

function ensureTable(): void {
  db.execute(
    'CREATE TABLE IF NOT EXISTS emails (' +
      ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      ' at TEXT NOT NULL, to_email TEXT NOT NULL, kind TEXT NOT NULL,' +
      ' subject TEXT, body TEXT, backend TEXT, ok INTEGER, error TEXT,' +
      ' user_id INTEGER, job_id TEXT)',
  );
}

export interface SendResult {
  ok: boolean;
  backend: string;
  error: string | null;
  message_id: number;
}

/** Python's Path.write_text in text mode: '\n' becomes the platform's line ending. */
function writeText(file: string, text: string): void {
  writeFileSync(file, process.platform === 'win32' ? text.replace(/\n/g, '\r\n') : text, 'utf8');
}

/**
 * Send one message and record it. The TEXT version is what the `emails` table keeps:
 * "what did we say to this person" is answered far better by it than by table markup.
 */
export async function send(
  toEmail: string,
  kind: string,
  subject: string,
  body: string,
  userId: number | null = null,
  jobId: string | null = null,
  html: string | null = null,
): Promise<SendResult> {
  ensureTable();
  let ok = true;
  let err: string | null = null;

  // The row first, so its id can name the file: two messages to one address in the
  // same second must not overwrite each other.
  const cur = db.execute(
    'INSERT INTO emails (at, to_email, kind, subject, body, backend, ok, error,' +
      ' user_id, job_id) VALUES (?,?,?,?,?,?,NULL,NULL,?,?)',
    [db.now(), toEmail, kind, subject, pySlice(body, 4000), BACKEND, userId, jobId],
  );
  const rowId = cur.lastrowid;

  if (BACKEND === 'resend') {
    [ok, err] = await sendResend(toEmail, subject, body, html);
    // Logged either way: a confirmation that silently failed looks like a user ignoring it.
    console.log(`  [mail:${kind}] to ${toEmail}: ${subject}${ok ? '' : '  SEND FAILED: ' + pySlice(String(err), 120)}`);
  } else if (BACKEND === 'ses') {
    const cmd = [
      'aws', 'ses', 'send-email',
      '--from', SES_FROM,
      '--destination', `ToAddresses=${toEmail}`,
      '--message', `Subject={Data=${subject}},Body={Text={Data=${body}}}`,
      '--profile', AWS_PROFILE, '--region', AWS_REGION,
    ];
    try {
      const p = await procs.run(cmd, { timeoutMs: 60_000 });
      ok = p.code === 0;
      err = ok ? null : pySlice(p.stderr || '', 300);
    } catch (e) {
      ok = false;
      err = errText(e);
    }
  } else {
    const stamp = fmtStamp(new Date()).replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
    const name = `${stamp}_${String(rowId).padStart(6, '0')}_${kind}_${toEmail.replace(/[^A-Za-z0-9._@-]/g, '_')}.txt`;
    try {
      writeText(path.join(MAIL_DIR, name), `To: ${toEmail}\nSubject: ${subject}\nMessage: ${rowId}\n\n${body}\n`);
    } catch (e) {
      ok = false;
      err = pySlice(String((e as Error).message ?? e), 300);
    }
    console.log(`  [mail:${kind}] to ${toEmail}: ${subject}`);
  }

  db.execute('UPDATE emails SET ok=?, error=? WHERE id=?', [ok ? 1 : 0, err, rowId]);
  return { ok, backend: BACKEND, error: err, message_id: rowId };
}

/**
 * How the messages below reach `send`: through a property, so a check can capture them
 * instead of delivering them. It is the seam the Python backend's tests use when they
 * replace `notify.send`, which only works there because Python looks the name up at
 * call time.
 */
export const transport: { send: typeof send } = { send };

// ── the messages ──────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-08-29T19:04:22Z' -> '29 August 2026 at 7:04 pm UTC'. */
export function friendlyDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(iso.split('Z').join(''));
  if (!m) return iso;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || h > 23 || mi > 59 || s > 61) return iso;
  const hour = h % 12 || 12;
  const part = h < 12 ? 'am' : 'pm';
  return `${d} ${MONTHS[mo - 1]} ${y} at ${hour}:${String(mi).padStart(2, '0')} ${part} UTC`;
}

/** Sent when a dub finishes, so the customer can close the tab and walk away. */
export async function jobDone(
  userEmail: string,
  userId: number,
  jobId: string,
  targetLang: string,
  expiresAt: string | null,
  baseUrl: string,
): Promise<SendResult> {
  const lang = pyTitle(media.languageName(targetLang));
  const when = friendlyDate(expiresAt);
  // The job's own page in the dashboard, which is where the player and the downloads
  // are. It used to be `/?job=<id>` - the marketing homepage, which ignores the query
  // string, so "Open my dub" left the customer looking for it.
  const link = `${baseUrl}/app/jobs/${encodeURIComponent(jobId)}`;

  const kept = when
    ? `It stays available until <strong>${when}</strong>, after which it is deleted automatically for your privacy.`
    : 'It stays available for a limited time, then is deleted automatically.';

  const html = htmlShell(
    `Your ${lang} dub is ready`,
    [
      `Your video has been dubbed into <strong>${lang}</strong>, keeping the ` +
        'original speaker&rsquo;s voice. It is waiting on your dashboard.',
      ['WHILE IT IS THERE', [
        'Download it as many times as you like',
        'Play it in the browser before you download',
        'Get the dubbed audio on its own, if that is what you need',
      ]],
    ],
    ['Open my dub', link],
    `${kept} You can also delete it yourself at any time from your dashboard. Any questions, just reply to this message.`,
  );

  const body =
    `Your ${lang} dub is ready.\n\n` +
    `Your video has been dubbed into ${lang}, keeping the original speaker's ` +
    'voice. It is waiting on your dashboard:\n\n' +
    `${link}\n\n` +
    'WHILE IT IS THERE\n' +
    '  - Download it as many times as you like\n' +
    '  - Play it in the browser before you download\n' +
    '  - Get the dubbed audio on its own, if that is what you need\n\n' +
    (when
      ? `It stays available until ${when}, after which it is deleted automatically for your privacy.\n\n`
      : 'It stays available for a limited time, then is deleted automatically.\n\n') +
    'You can also delete it yourself at any time from your dashboard.\n' +
    'Any questions, just reply to this message.\n\n' +
    'Kresker - kresker.com\n';

  return transport.send(userEmail, 'job_done', `Your ${lang} dub is ready`, body, userId, jobId, html);
}

/**
 * Sent when a dub fails. `reason` is NOT shown: it is our diagnostic, recorded against
 * the job. What the customer can act on is that it failed and they were not charged.
 */
export async function jobFailed(userEmail: string, userId: number, jobId: string, _reason: string): Promise<SendResult> {
  const html = htmlShell(
    'Your dub could not be completed',
    [
      'Something went wrong while dubbing your video, and it did not finish.',
      '<strong>You have not been charged.</strong> The minutes are back on your ' +
        'plan, so you can try again straight away.',
      ['IF IT HAPPENS AGAIN', [
        'Check the video has clear, audible speech',
        'Try a shorter section, or a different file',
        'Reply to this message and we will look into it for you',
      ]],
    ],
    // Called from the worker, which has no request to derive a base from. `/app` is the
    // dubbing page itself - this used to be `/app/dubbing`, a route that never existed,
    // so "Try again" opened the 404 page.
    ['Try again', `${PUBLIC_BASE_URL}/app`],
    'We would rather tell you plainly than leave you guessing. Sorry for the trouble.',
  );
  const body =
    'Your dub could not be completed.\n\n' +
    'Something went wrong while dubbing your video, and it did not finish.\n\n' +
    'You have not been charged. The minutes are back on your plan, so you can ' +
    'try again straight away:\n\n' +
    `${PUBLIC_BASE_URL}/app\n\n` +
    'IF IT HAPPENS AGAIN\n' +
    '  - Check the video has clear, audible speech\n' +
    '  - Try a shorter section, or a different file\n' +
    '  - Reply to this message and we will look into it for you\n\n' +
    'Sorry for the trouble.\n\n' +
    'Kresker - kresker.com\n';
  return transport.send(userEmail, 'job_failed', 'Your dub did not complete', body, userId, jobId, html);
}

/** Sent when somebody signs up with Google: nothing to verify, so a welcome instead. */
export async function welcomeGoogle(userEmail: string, userId: number, baseUrl: string): Promise<SendResult> {
  const html = htmlShell(
    'Welcome to Kresker',
    [
      'Your account is ready — you signed in with Google, so there is nothing to ' +
        'confirm. You can start dubbing straight away.',
      ['WHAT YOU GET STRAIGHT AWAY', [
        'One free minute of dubbing, no card required',
        'Your video in another language, keeping the speaker&rsquo;s own voice',
        'Videos up to 60 seconds on the free plan',
      ]],
      ['WORTH KNOWING', [
        'Nothing renews on its own — you choose if and when to upgrade',
        'Finished videos are kept 24 hours on free, 7 days on paid plans',
        'Only upload video you hold the rights to',
      ]],
    ],
    // `/app` is the dubbing page; `/app/dubbing` was never a route.
    ['Dub my first video', `${baseUrl}/app`],
    'Use the same Google button to sign in next time. Any questions, just reply to this message.',
  );
  const body =
    'Welcome to Kresker\n\n' +
    'Your account is ready. You signed in with Google, so there is nothing to ' +
    'confirm and you can start dubbing straight away:\n\n' +
    `${baseUrl}/app\n\n` +
    'WHAT YOU GET STRAIGHT AWAY\n' +
    '  - One free minute of dubbing, no card required\n' +
    "  - Your video in another language, keeping the speaker's own voice\n" +
    '  - Videos up to 60 seconds on the free plan\n\n' +
    'WORTH KNOWING\n' +
    '  - Nothing renews on its own; you choose if and when to upgrade\n' +
    '  - Finished videos are kept 24 hours on free, 7 days on paid plans\n' +
    '  - Only upload video you hold the rights to\n\n' +
    'Use the same Google button to sign in next time.\n' +
    'Any questions, just reply to this message.\n\n' +
    'Kresker - kresker.com\n';
  return transport.send(userEmail, 'welcome_google', 'Welcome to Kresker', body, userId, null, html);
}

/**
 * Confirm the address belongs to whoever signed up. This gates sign-in: registering
 * hands out no session, and this link is the only way in.
 */
export async function verifyEmail(userEmail: string, userId: number, token: string, baseUrl: string): Promise<SendResult> {
  const link = `${baseUrl}/verify?token=${token}`;
  const html = htmlShell(
    'Welcome to Kresker',
    [
      'Thanks for signing up. One quick step and your account is ready — ' +
        'confirm that this email address is yours.',
      ['WHAT YOU GET STRAIGHT AWAY', [
        'One free minute of dubbing, no card required',
        'Your video in another language, keeping the speaker&rsquo;s own voice',
        'Videos up to 60 seconds on the free plan',
      ]],
      ['WORTH KNOWING', [
        'Nothing renews on its own — you choose if and when to upgrade',
        'Finished videos are kept 24 hours on free, 7 days on paid plans',
        'Only upload video you hold the rights to',
      ]],
    ],
    ['Confirm my email address', link],
    'This link works once and expires in 24 hours. If the button does not ' +
      `work, paste this into your browser:<br><a href="${link}" ` +
      `style="color:#41464e;word-break:break-all;">${link}</a>` +
      '<br><br>Didn&rsquo;t sign up? Ignore this email — the account stays ' +
      'unusable without confirmation. Any questions, just reply to this ' +
      'message.',
  );
  const body =
    'Welcome to Kresker\n\n' +
    'Thanks for signing up. One quick step and your account is ready:\n' +
    'confirm that this email address is yours.\n\n' +
    'Confirm here (works once, expires in 24 hours):\n' +
    `${link}\n\n` +
    'WHAT YOU GET STRAIGHT AWAY\n' +
    '  - One free minute of dubbing, no card required\n' +
    "  - Your video in another language, keeping the speaker's own voice\n" +
    '  - Videos up to 60 seconds on the free plan\n\n' +
    'WORTH KNOWING\n' +
    '  - Nothing renews on its own; you choose if and when to upgrade\n' +
    '  - Finished videos are kept 24 hours on free, 7 days on paid plans\n' +
    '  - Only upload video you hold the rights to\n\n' +
    "Didn't sign up? Ignore this email and the account stays unusable.\n" +
    'Any questions, just reply to this message.\n\n' +
    'Kresker - kresker.com\n';
  return transport.send(userEmail, 'verify_email', 'Confirm your email to start using Kresker', body, userId, null, html);
}

/** The one email people receive when they are already slightly annoyed. */
export async function passwordReset(userEmail: string, userId: number, token: string, baseUrl: string): Promise<SendResult> {
  const link = `${baseUrl}/reset?token=${token}`;
  const html = htmlShell(
    'Reset your password',
    ['Someone asked to reset the password for this account. If that was you, use the button below and pick a new one.'],
    ['Choose a new password', link],
    'This link works once and expires in 30 minutes. If the button does not ' +
      `work, paste this into your browser:<br><a href="${link}" ` +
      `style="color:#41464e;word-break:break-all;">${link}</a>` +
      '<br><br>If it was not you, nothing has changed and you can ignore this ' +
      'message — your password still works.',
  );
  const body =
    'Reset your password\n\n' +
    'Someone asked to reset the password for this account. If that was you, ' +
    'open this link and pick a new one:\n\n' +
    `${link}\n\n` +
    'It works once and expires in 30 minutes.\n\n' +
    'If it was not you, nothing has changed and you can ignore this message.\n' +
    'Your password still works.\n\n' +
    'Kresker - kresker.com\n';
  return transport.send(userEmail, 'password_reset', 'Reset your password', body, userId, null, html);
}

/** Annual plans do not renew themselves, so these reminders keep a yearly customer. */
export async function renewalReminder(
  userEmail: string,
  userId: number,
  daysLeft: number,
  planName: string,
  periodEnd: string,
  baseUrl: string,
): Promise<SendResult> {
  const body =
    `Your ${planName} plan ends on ` +
    `${(periodEnd || '').split('T').join(' ').split('Z').join(' UTC')}` +
    ` - ${daysLeft} day(s) from now.\n\n` +
    'Annual plans are a one-time payment, so nothing is charged ' +
    'automatically. To keep going, renew here:\n' +
    // The billing page lives inside the dashboard; `/billing` on its own is a 404.
    `${baseUrl}/app/billing\n\n` +
    'You keep access for 7 days after the end date while you decide.\n';
  return transport.send(userEmail, 'renewal_reminder', `Your ${planName} plan ends in ${daysLeft} day(s)`, body, userId);
}

// ── DPDP acknowledgements ─────────────────────────────────────────────────────
// A record in the principal's own inbox, so the statutory clock is checkable by the
// person it protects.

export async function contactAck(toEmail: string, messageId: number): Promise<SendResult> {
  const body =
    'Thanks — we have your message.\n\n' +
    `Reference: #${messageId}\n\n` +
    'A person will read it and reply to this address. If it was about your ' +
    'personal data, it has been logged as a data-rights request and is ' +
    'tracked against a deadline.\n';
  return transport.send(toEmail, 'contact_ack', 'We have your message', body);
}

/** Acknowledge a rights request, and state the deadline back to them. */
export async function rightsAck(toEmail: string, messageId: number, kind: string, dueAt: string | null): Promise<SendResult> {
  const when = (dueAt || '').split('T').join(' ').split('Z').join(' UTC');
  const body =
    `We have logged your ${kind} request.\n\n` +
    `Reference: #${messageId}\n` +
    (when ? `We will respond by ${when}.\n\n` : '\n') +
    'Before we act on it we confirm who you are, so that nobody else can ' +
    'use this form to reach your data. If you can sign in, your data ' +
    'export and account deletion are available immediately from your ' +
    'account settings — no waiting.\n';
  return transport.send(toEmail, 'rights_ack', `Your ${kind} request (#${messageId})`, body);
}

/** Sent after an erasure: what went, and what had to stay and why. */
export async function accountErased(toEmail: string, summary: { deleted?: Record<string, number>; retained?: string[] }): Promise<SendResult> {
  const gone = Object.entries(summary.deleted || {})
    .map(([k, v]) => `${k} (${v})`)
    .join(', ');
  const kept = summary.retained || [];
  let body = 'Your account has been closed and your personal data erased.\n\n' + `Deleted: ${gone || 'nothing was left to delete'}\n\n`;
  if (kept.length) {
    body +=
      'Retained, and why:\n' +
      kept.map((k) => `  - ${k}`).join('\n') +
      '\n\nThese are kept because we are required to, not because we ' +
      'want to. They are not used for anything else.\n';
  }
  return transport.send(toEmail, 'account_erased', 'Your account has been erased', body);
}
