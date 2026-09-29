/**
 * Consent, data-rights requests, and the contact inbox — everything DPDP-specific that is
 * not a page, in one module, so "what did this account agree to" has one implementation.
 *
 * Three decisions, each because the obvious alternative loses information:
 *
 *   * Consent is a LEDGER, not a flag. Withdrawal appends a row with granted=0; it never
 *     updates the row that granted it. Current state is the newest row per purpose.
 *   * Purposes are separate and none is bundled (DPDP s.6(1)).
 *   * Necessary processing is not asked for as consent. It is recorded as terms
 *     acceptance and marked `required`, so the audit can tell the two apart.
 *
 * LEGAL REVIEW is due on every string a data principal will read.
 */
import { COOKIE_SECURE } from './config';
import * as db from './db';
import { addSeconds, fmtStamp, pyRepr, pySlice, pyStrip } from './py';

// Stamped onto every consent record. Bump it whenever the Privacy Notice changes in a
// way that affects what somebody agreed to.
export const NOTICE_VERSION = process.env.VS_NOTICE_VERSION ?? '2026-08-26.1-draft';

// DPDP s.13(1): the grievance contact must be published. Empty defaults are loud.
const GRIEVANCE_NAME = process.env.VS_GRIEVANCE_NAME ?? '';
const GRIEVANCE_EMAIL = process.env.VS_GRIEVANCE_EMAIL ?? '';
const GRIEVANCE_ADDRESS = process.env.VS_GRIEVANCE_ADDRESS ?? '';

// Working default for the rights-response window. LEGAL REVIEW: confirm against the Rules.
export const RIGHTS_RESPONSE_DAYS = parseFloat(process.env.VS_RIGHTS_RESPONSE_DAYS || '30');

/** The grievance contact, and whether it has actually been configured. */
export function grievance(): Record<string, unknown> {
  const ok = Boolean(GRIEVANCE_NAME && GRIEVANCE_EMAIL);
  return {
    name: GRIEVANCE_NAME || 'NOT CONFIGURED',
    email: GRIEVANCE_EMAIL || 'NOT CONFIGURED',
    address: GRIEVANCE_ADDRESS || '',
    configured: ok,
    note: ok
      ? null
      : 'Set VS_GRIEVANCE_NAME and VS_GRIEVANCE_EMAIL before this site serves ' +
        'real users. DPDP s.13(1) requires the grievance contact to be published.',
  };
}

export interface Purpose {
  required: boolean;
  label: string;
  description: string;
  where: 'signup' | 'upload' | 'settings' | 'banner';
}

// `required` means "necessary to provide the service the user asked for". The labels read
// as statements, because the privacy page renders them as a record of what was agreed.
export const PURPOSES: Record<string, Purpose> = {
  service_terms: {
    required: true,
    label: 'Your account, sign-in and payment',
    description:
      'Accepted when you created the account. Covers running it, keeping you ' +
      'signed in, and taking payment for a plan you choose.',
    where: 'signup',
  },
  process_video: {
    required: true,
    label: 'Dubbing the videos you upload',
    // Names what happens to their video, not what it runs on.
    description:
      'Your video is processed to transcribe the speech, translate it and ' +
      're-voice it, and the finished file is returned to you. The transcript is ' +
      'sent to a third-party translation service and short audio clips are sent ' +
      'to a third-party transcription service. Without this there is no service ' +
      'to provide.',
    where: 'upload',
  },
  voice_clone: {
    // Its own line: the uploader is often not the only speaker in their own video.
    required: true,
    label: "Cloning the speakers' voices in your video",
    description:
      'Short clips of each speaker are cut from your video to copy how they ' +
      'sound, and those clips are sent to a third-party transcription service. ' +
      'By uploading you confirm you have the right to submit every voice in ' +
      'the file, including anyone other than yourself.',
    where: 'upload',
  },
  product_email: {
    required: false,
    // asked for nowhere but the account's own privacy page
    where: 'settings',
    label: 'Email me about new features and improvements',
    description:
      'Occasional product news. Nothing to do with your dubs — you are told ' +
      'about those either way. Off unless you turn it on, and you can withdraw ' +
      'it at any time and keep using the service exactly as before.',
  },
  analytics: {
    // recorded now so the gate exists before anything needs gating
    required: false,
    label: 'Allow anonymous usage analytics',
    description:
      'We do not currently use any analytics or tracking service. This ' +
      'preference is recorded so that if we ever add one, it starts switched ' +
      'off for you.',
    where: 'banner',
  },
};

/** The purposes collected at one point, in a stable order, in the Python key order. */
export function purposesFor(where: string): Array<Record<string, unknown>> {
  return Object.entries(PURPOSES)
    .filter(([, v]) => v.where === where)
    .map(([k, v]) => {
      // {"key": k, **v}: key first, then the purpose's own fields in declaration order
      const out: Record<string, unknown> = { key: k };
      for (const [f, x] of Object.entries(v)) out[f] = x;
      return out;
    });
}

// How a consent record was collected: an allowlist, so the evidence cannot be overstated.
export const METHODS = ['terms_acceptance', 'settings', 'banner', 'checkbox', 'api', 'admin'] as const;

/** A ValueError-equivalent, so callers can tell a bad purpose/kind from a bug. */
export class ConsentValueError extends Error {
  override name = 'ValueError';
}

interface RecordArgs {
  userId: number | null;
  email: string | null;
  purpose: string;
  granted: boolean;
  ip: string | null;
  userAgent: string | null | undefined;
  /** The weakest honest label is the default, so a forgetful caller never overstates. */
  method?: string;
}

/** Append one consent record. Never updates; withdrawal is a new row. */
export function record(a: RecordArgs): void {
  if (!Object.prototype.hasOwnProperty.call(PURPOSES, a.purpose)) {
    throw new ConsentValueError(`unknown consent purpose: ${pyRepr(a.purpose)}`);
  }
  db.execute(
    'INSERT INTO consent_records (user_id, email, purpose, granted,' +
      ' notice_version, method, at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?)',
    [
      a.userId,
      pyStrip((a.email || '').toLowerCase()) || null,
      a.purpose,
      a.granted ? 1 : 0,
      NOTICE_VERSION,
      a.method ?? 'terms_acceptance',
      db.now(),
      a.ip,
      pySlice(a.userAgent || '', 300) || null,
    ],
  );
}

/** Append several at once. Returns the purposes actually written. */
export function recordMany(a: Omit<RecordArgs, 'purpose' | 'granted'> & { granted: Record<string, boolean> }): string[] {
  const written: string[] = [];
  for (const [purpose, ok] of Object.entries(a.granted)) {
    if (Object.prototype.hasOwnProperty.call(PURPOSES, purpose)) {
      record({ ...a, purpose, granted: ok });
      written.push(purpose);
    }
  }
  return written;
}

/** The live state per purpose: the newest row (by id, not by second-precision time) wins. */
export function currentFor(userId: number): Record<string, { granted: boolean; notice_version: string; at: string; method: string }> {
  const rows = db.query(
    'SELECT c.purpose, c.granted, c.notice_version, c.at, c.method' +
      '  FROM consent_records c' +
      '  JOIN (SELECT purpose, MAX(id) AS mid FROM consent_records' +
      '         WHERE user_id=? GROUP BY purpose) latest' +
      '    ON latest.mid = c.id',
    [userId],
  );
  const out: Record<string, { granted: boolean; notice_version: string; at: string; method: string }> = {};
  for (const r of rows) {
    out[r.purpose] = { granted: Boolean(r.granted), notice_version: r.notice_version, at: r.at, method: r.method };
  }
  return out;
}

/** Everything, oldest first — what an access request has to be able to show. */
export function historyFor(userId: number): db.Row[] {
  return db.query(
    'SELECT purpose, granted, notice_version, method, at, ip, user_agent FROM consent_records WHERE user_id=? ORDER BY id',
    [userId],
  );
}

// ── the inbox ─────────────────────────────────────────────────────────────────

// Kinds that start the statutory clock. A general enquiry does not.
export const RIGHTS_KINDS = ['access', 'correction', 'erasure', 'withdraw', 'grievance'];
export const ALL_KINDS = ['contact', ...RIGHTS_KINDS];

function due(kind: string): string | null {
  if (!RIGHTS_KINDS.includes(kind)) return null;
  return fmtStamp(addSeconds(new Date(), RIGHTS_RESPONSE_DAYS * 86400));
}

/** File a contact message or a rights request. */
export function submit(a: {
  kind: string;
  email: string;
  body: string;
  name?: string | null;
  subject?: string | null;
  userId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}): { id: number; kind: string; due_at: string | null } {
  if (!ALL_KINDS.includes(a.kind)) throw new ConsentValueError(`unknown message kind: ${pyRepr(a.kind)}`);
  const d = due(a.kind);
  const cur = db.execute(
    'INSERT INTO inbox_messages (kind, user_id, email, name, subject, body,' +
      ' status, due_at, at, ip, user_agent)' +
      " VALUES (?,?,?,?,?,?,'new',?,?,?,?)",
    [
      a.kind,
      a.userId ?? null,
      pyStrip(a.email.toLowerCase()),
      a.name ?? null,
      a.subject ?? null,
      a.body,
      d,
      db.now(),
      a.ip ?? null,
      pySlice(a.userAgent || '', 300) || null,
    ],
  );
  return { id: cur.lastrowid, kind: a.kind, due_at: d };
}

/** Rights requests past their due date and not yet resolved. */
export function overdueCount(): number {
  return db.scalar(
    "SELECT COUNT(*) FROM inbox_messages WHERE due_at IS NOT NULL AND due_at <= ? AND status NOT IN ('resolved','rejected')",
    [db.now()],
    0,
  );
}

/** Is the DPDP surface actually configured? Each item names the thing to fix. */
export function readiness(): Record<string, unknown> {
  const g = grievance();
  const items = [
    { item: 'grievance contact published', ok: g.configured, fix: 'set VS_GRIEVANCE_NAME and VS_GRIEVANCE_EMAIL' },
    {
      item: 'notice version is not the draft default',
      ok: !NOTICE_VERSION.includes('draft'),
      fix: 'set VS_NOTICE_VERSION once the notice has been reviewed',
    },
    // The COMPUTED value, not an environment variable nothing reads.
    {
      item: 'session cookie is Secure',
      ok: Boolean(COOKIE_SECURE),
      fix: 'unset VS_COOKIE_INSECURE (it is only for http://127.0.0.1 development) and terminate TLS in front of the API',
    },
    {
      item: 'public base URL is https',
      ok: (process.env.VS_PUBLIC_BASE_URL ?? '').startsWith('https://'),
      fix: 'set VS_PUBLIC_BASE_URL to the real https origin',
    },
    {
      item: 'signup refuses registration without consent',
      ok: process.env.VS_REQUIRE_SIGNUP_CONSENT === '1',
      fix:
        'set VS_REQUIRE_SIGNUP_CONSENT=1 (the internal test scripts post ' +
        'email+password only, so turn it on for production, not for dev)',
    },
    // Evidence rather than configuration.
    {
      item: 'every account has a recorded consent decision',
      ok:
        db.scalar(
          "SELECT COUNT(*) FROM users WHERE role<>'erased' AND id NOT IN" +
            ' (SELECT user_id FROM consent_records WHERE user_id IS NOT NULL' +
            "   AND purpose='service_terms')",
          [],
          0,
        ) === 0,
      fix:
        'accounts created before this was added, or through a script, have ' +
        'no consent record; they need re-consent at next sign-in',
    },
  ];
  return {
    notice_version: NOTICE_VERSION,
    grievance: g,
    rights_response_days: RIGHTS_RESPONSE_DAYS,
    open_messages: db.scalar("SELECT COUNT(*) FROM inbox_messages WHERE status='new'", [], 0),
    overdue_rights_requests: overdueCount(),
    checks: items,
    ready: items.every((i) => i.ok),
  };
}
