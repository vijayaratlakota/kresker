/**
 * Public DPDP endpoints: contact, data rights, consent, and the notice metadata.
 *
 * Deliberately public where the law requires it. A data principal must be able to
 * exercise s.11-13 rights and reach the grievance officer, and tying either to a login
 * would mean somebody locked out of their account cannot ask for their data.
 *
 * So these are unauthenticated write endpoints: they are rate limited, and they never
 * confirm whether an email is registered. An anonymous erasure request is logged for a
 * human to verify, never executed; a signed-in user gets the immediate path instead.
 */
import { existsSync, unlinkSync } from 'node:fs';
import * as billing from '../billing';
import { FREE_RETENTION_HOURS, PAID_RETENTION_DAYS, SESSION_TTL_DAYS } from '../config';
import * as consent from '../consent';
import * as db from '../db';
import type { Row } from '../db';
import { clientIp, current, requireCsrf, requireUser } from '../deps';
import { ApiRouter, HTTPException, header } from '../http';
import * as media from '../media';
import * as notify from '../notify';
import * as paths from '../paths';
import { pyf, pySortedStr } from '../py';
import * as ratelimit from '../ratelimit';
import * as security from '../security';
import * as storage from '../storage';
import { Model, optional, required, t } from '../validate';

export const router = new ApiRouter('/api', ['privacy']);

/** [{"key": k, **v} for k, v in PURPOSES.items()] */
function allPurposes(): Array<Record<string, unknown>> {
  return Object.entries(consent.PURPOSES).map(([k, v]) => ({ key: k, ...v }));
}

// ── what the notice says, as data ────────────────────────────────────────────

router.get('/privacy/notice', { name: 'notice' }, () => {
  // Served from the implementation, so the published notice cannot silently stop being
  // true: a retention period in prose and one in config drift apart.
  return {
    notice_version: consent.NOTICE_VERSION,
    grievance: consent.grievance(),
    rights_response_days: pyf(consent.RIGHTS_RESPONSE_DAYS),
    purposes: allPurposes(),
    retention: {
      dubbed_output_free_hours: FREE_RETENTION_HOURS,
      dubbed_output_paid_days: PAID_RETENTION_DAYS,
      session_days: SESSION_TTL_DAYS,
      // The same constants worker.sweepSourceUploads deletes by, so the sentence cannot
      // drift from what actually happens. It used to read "kept until you delete it or
      // close your account", which was true and was the gap.
      source_upload:
        `Kept as long as the dubs made from it: until ${FREE_RETENTION_HOURS} hours after the last one ` +
        `finishes on the free plan, or ${PAID_RETENTION_DAYS} days on a paid plan, then deleted ` +
        'automatically. A video you never dub is deleted that long after it was uploaded. ' +
        'Closing your account deletes it at once.',
      source_upload_free_hours: FREE_RETENTION_HOURS,
      source_upload_paid_days: PAID_RETENTION_DAYS,
      transcripts: 'kept with the job record until you delete the job',
    },
    // LEGAL REVIEW: a disclosure of recipients under s.5(1)(ii). The processor names stay
    // deliberately — naming who else receives personal data is the substance of it.
    recipients: [
      {
        who: 'Amazon Web Services',
        what: 'your uploaded video and its transcript, while it is being dubbed',
        why: 'hosting the processing that produces your dub',
      },
      {
        who: 'A third-party large-language-model translation service',
        what: 'the transcript text and its timings',
        why: 'translating each line so it still fits its original slot',
      },
      {
        who: 'A third-party speech-to-text service',
        what: 'audio from your video, including short per-speaker clips',
        why: 'transcribing speech and matching each clip to its words',
      },
      // Derived, never hand-written: see billing.paymentRecipient.
      billing.paymentRecipient(),
      {
        who: 'Cloudflare',
        what: 'the finished dubbed video',
        why: 'storing it and delivering it to you',
      },
    ],
    cookies: [{ name: 'vs_session', essential: true, why: 'keeps you signed in', life: `${SESSION_TTL_DAYS} days` }],
    // Declared for the same reason as the cookie: an undisclosed store is undisclosed.
    browser_storage: [
      {
        name: 'vs_privacy_ack',
        kind: 'localStorage',
        essential: true,
        why: 'remembers that you have seen the privacy banner, and your analytics choice, so it is not asked again',
        life: 'until you clear site data',
      },
    ],
    // Honest, and checkable: no analytics vendor, no pixel, no third-party CDN.
    trackers: [],
  };
});

// ── the contact form ─────────────────────────────────────────────────────────

const ContactIn = new Model('ContactIn', {
  email: required(t.email()),
  body: required(t.str({ minLength: 10, maxLength: 5000 })),
  name: optional(t.nullable(t.str({ maxLength: 120 })), null),
  subject: optional(t.nullable(t.str({ maxLength: 200 })), null),
});

router.post('/contact', { name: 'contact', body: ContactIn }, async (req, _res, { body }) => {
  // A message from anybody. Lands in the admin inbox. Rate limited per IP: the only
  // handle there is on an anonymous caller.
  ratelimit.check('contact', clientIp(req));
  const [, user] = current(req);
  const rec = consent.submit({
    kind: 'contact',
    email: body.email,
    name: body.name,
    subject: body.subject,
    body: body.body,
    userId: user ? user.id : null,
    ip: clientIp(req),
    userAgent: header(req, 'user-agent'),
  });
  // Acknowledged by email; a mail failure must not lose the message, already committed.
  try {
    await notify.contactAck(body.email, rec.id);
  } catch {
    /* the message is stored either way */
  }
  return { ok: true, id: rec.id, note: 'we have it, and you will get a reply by email' };
});

// ── data rights ──────────────────────────────────────────────────────────────

const RightIn = new Model('RightIn', {
  // 'access' | 'correction' | 'erasure' | 'withdraw' | 'grievance'
  kind: required(t.str()),
  email: required(t.email()),
  body: optional(t.str({ minLength: 0, maxLength: 5000 }), ''),
});

router.post('/privacy/request', { name: 'request_right', body: RightIn }, async (req, _res, { body }) => {
  // File a s.11-13 request. Starts the statutory clock. A REQUEST, not an action: the
  // endpoint is unauthenticated, so acting on it would let anyone who knows an address
  // destroy that person's data. A human verifies identity first.
  if (!consent.RIGHTS_KINDS.includes(body.kind)) {
    throw new HTTPException(400, `kind must be one of ${consent.RIGHTS_KINDS.join(', ')}`);
  }
  ratelimit.check('privacy_request', clientIp(req));
  const [, user] = current(req);
  const rec = consent.submit({
    kind: body.kind,
    email: body.email,
    subject: `${body.kind} request`,
    body: body.body || `(no details given; ${body.kind} request)`,
    userId: user ? user.id : null,
    ip: clientIp(req),
    userAgent: header(req, 'user-agent'),
  });
  try {
    await notify.rightsAck(body.email, rec.id, body.kind, rec.due_at);
  } catch {
    /* logged either way */
  }
  return {
    ok: true,
    id: rec.id,
    due_at: rec.due_at,
    note: 'logged and acknowledged by email. We verify who you are before acting on it, so signing in makes this immediate.',
  };
});

// ── consent, for a signed-in user ────────────────────────────────────────────

router.get('/privacy/consent', { name: 'my_consent' }, (req) => {
  // What this account has agreed to, and the full history behind it.
  const user = requireUser(req);
  return {
    notice_version: consent.NOTICE_VERSION,
    purposes: allPurposes(),
    current: consent.currentFor(user.id),
    history: consent.historyFor(user.id),
  };
});

const ConsentIn = new Model('ConsentIn', {
  // purpose -> granted
  granted: required(t.dict(t.bool())),
  // HOW it was collected, validated against consent.METHODS so a client cannot invent a
  // stronger-sounding label than the control it actually used.
  method: optional(t.str(), 'settings'),
});

router.post('/privacy/consent', { name: 'set_consent', body: ConsentIn }, (req, _res, { body }) => {
  // Grant or withdraw a purpose. Appends; never edits. Granting a required purpose is
  // ordinary; WITHDRAWING one is account closure, which has its own endpoint.
  const user = requireUser(req);
  requireCsrf(req);
  if (!(consent.METHODS as readonly string[]).includes(body.method)) {
    throw new HTTPException(400, `method must be one of ${pySortedStr(consent.METHODS).join(', ')}`);
  }
  const granted = body.granted as Record<string, boolean>;
  const bad = Object.keys(granted).filter((p) => !Object.hasOwn(consent.PURPOSES, p));
  if (bad.length) throw new HTTPException(400, `unknown purpose(s): ${pySortedStr(bad).join(', ')}`);
  const withdrawingRequired = Object.entries(granted)
    .filter(([p, ok]) => consent.PURPOSES[p].required && !ok)
    .map(([p]) => p);
  if (withdrawingRequired.length) {
    throw new HTTPException(
      400,
      `${pySortedStr(withdrawingRequired).join(', ')} is necessary to provide the service and cannot be withdrawn separately. To stop all processing, close your account.`,
    );
  }
  const written = consent.recordMany({
    userId: user.id,
    email: user.email,
    granted,
    ip: clientIp(req),
    userAgent: header(req, 'user-agent'),
    method: body.method,
  });
  return { ok: true, recorded: written, current: consent.currentFor(user.id) };
});

// ── the fast path for somebody who is signed in ──────────────────────────────

/** A column that may not exist yet on this database: None rather than a KeyError. */
function col(row: Row, name: string): unknown {
  return name in row ? row[name] : null;
}

router.get('/privacy/export', { name: 'export_my_data' }, (req) => {
  // Everything we hold about the signed-in user, as JSON (s.11 access). Deliberately
  // omits the password hash and the session/reset token hashes: credentials, of no use
  // to the person, and a new place for them to leak from.
  const user = requireUser(req);
  const uid = user.id;
  const rows = (sql: string): Row[] => db.query(sql, [uid]).map((r) => ({ ...r }));

  return {
    generated_at: db.now(),
    notice_version: consent.NOTICE_VERSION,
    note: 'Password and token hashes are deliberately excluded — they are credentials, not information about you.',
    account: {
      id: user.id,
      email: user.email,
      role: user.role,
      created_at: user.created_at,
      free_trial_used_at: user.free_trial_used_at,
      // s.11 covers everything held about the person, so the signup signals are shown.
      signup_ip: col(user, 'signup_ip'),
      signup_user_agent: col(user, 'signup_user_agent'),
      status: col(user, 'status') || 'active',
    },
    consent: consent.historyFor(uid),
    sessions: rows('SELECT id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at FROM sessions WHERE user_id=? ORDER BY id'),
    subscriptions: rows(
      'SELECT plan_code, status, current_period_start, current_period_end, auto_renew, created_at FROM subscriptions WHERE user_id=? ORDER BY id',
    ),
    payments: rows('SELECT provider_payment_id, amount_paise, currency, method, status, at, plan_code FROM payments WHERE user_id=? ORDER BY id'),
    usage_ledger: rows('SELECT job_id, minutes_charged, kind, note, at FROM usage_ledger WHERE user_id=? ORDER BY id'),
    // `status` says whether the file itself still exists ('deleted' once the retention
    // sweep has removed it), which is part of the answer to "what do you hold".
    uploads: rows('SELECT id, original_name, bytes, content_type, probed_duration_s, status, created_at FROM uploads WHERE user_id=? ORDER BY created_at'),
    jobs: rows(
      'SELECT id, target_lang, source_lang, state, minutes_quoted, created_at, finished_at, output_expires_at, output_deleted_at, output_deleted_by, download_count FROM jobs WHERE user_id=? ORDER BY created_at',
    ),
    transcripts: rows(
      'SELECT s.job_id, s.ordinal, s.speaker_label, s.source_text, s.translated_text FROM job_segments s JOIN jobs j ON j.id = s.job_id WHERE j.user_id=? ORDER BY s.job_id, s.ordinal',
    ),
    messages_to_us: rows('SELECT kind, subject, body, status, at FROM inbox_messages WHERE user_id=? ORDER BY id'),
    // Subject and kind only: `emails.body` contains live password-reset URLs.
    emails_we_sent: rows('SELECT at, kind, subject, ok FROM emails WHERE user_id=? ORDER BY id'),
  };
});

// ── erasure (s.12(3)) ────────────────────────────────────────────────────────

const EraseIn = new Model('EraseIn', {
  // Re-authentication: a stolen session must not be enough to delete an account.
  // OPTIONAL, because a Google-only account has no password to re-enter.
  password: optional(t.nullable(t.str({ minLength: 1, maxLength: 200 })), null),
  confirm: required(t.str(), 'must be the literal string DELETE'),
});

router.post('/privacy/erase', { name: 'erase_my_account', body: EraseIn }, async (req, _res, { body }) => {
  // Close the account and erase the personal data. Irreversible.
  //
  // Financial records have to survive the customer (kept under a different obligation),
  // so erasure destroys every piece of personal data and ANONYMISES the financial spine:
  // the users row survives as a tombstone, which keeps every foreign key valid and the
  // money auditable without a person attached. The response says exactly what was kept.
  // LEGAL REVIEW: confirm the retention basis for payment records and the period.
  const user = requireUser(req);
  requireCsrf(req);

  if (body.confirm !== 'DELETE') throw new HTTPException(400, 'type DELETE to confirm; nothing was changed');

  // RE-AUTHENTICATION, EXCEPT FOR AN ACCOUNT THAT HAS NO PASSWORD TO RE-ENTER. A
  // Google-only account stores a deliberately unusable hash; demanding a password would
  // make a statutory right impossible to exercise. The session, the CSRF header and the
  // typed DELETE still protect it. A real password must still be produced.
  const hasPassword = String(user.password_hash || '').startsWith('scrypt$');
  if (hasPassword) {
    if (!body.password) throw new HTTPException(400, 'your password is needed to confirm this');
    if (!(await security.verifyPassword(body.password, user.password_hash))) {
      throw new HTTPException(403, 'that password is not right');
    }
  }

  const uid: number = user.id;
  const email: string = user.email;
  const deleted: Record<string, number> = {};

  // 1 ── WHICH files, read now; DELETED only after the rows are gone.
  //
  // This used to delete the files first ("a row deleted before its file leaves an
  // orphan on disk"), and that order is what turned a database error into data loss:
  // the transaction below failed for every account that had ever dubbed a video (see
  // the order of the deletes), so the request answered 500, the account stayed open -
  // and the customer's source videos and dubs were already gone. An orphaned file that
  // a later unlink can still remove is the lesser failure; a half-erased account is not.
  // A dub the worker is in the middle of cannot be erased cleanly: its rows would vanish
  // under it and whatever it writes next - the finished video included - would land on
  // disk with nothing left pointing at it, so no sweep would ever remove it. A queued one
  // is fine: nothing has touched it yet, and it simply never starts.
  const busy = db.scalar(
    "SELECT COUNT(*) FROM jobs WHERE user_id=? AND state IN ('claimed','preparing','transcribing','translating','rendering','exporting')",
    [uid],
    0,
  );
  if (busy > 0) {
    throw new HTTPException(
      409,
      'one of your dubs is being made right now. Wait for it to finish (usually a few minutes), then close your account - nothing was changed.',
    );
  }

  const outputs = db.query('SELECT output_path, output_r2_key FROM jobs WHERE user_id=?', [uid]);
  const sources = db.query('SELECT stored_path FROM uploads WHERE user_id=?', [uid]);

  // 2 ── the rows. Counted before deleting, because a count afterwards is zero.
  const wipe = (table: string, sql: string, params: unknown[]): void => {
    const where = sql.split(' WHERE ').slice(1).join(' WHERE ');
    deleted[table] = db.scalar(`SELECT COUNT(*) FROM ${table} WHERE ` + where, params, 0);
    db.execute(sql, params);
  };

  db.transaction(() => {
    // Job children go by cascade, but are deleted explicitly so the count is reportable.
    for (const child of ['job_segments', 'job_artifacts', 'job_events']) {
      deleted[child] = db.scalar(`SELECT COUNT(*) FROM ${child} WHERE job_id IN (SELECT id FROM jobs WHERE user_id=?)`, [uid], 0);
      db.execute(`DELETE FROM ${child} WHERE job_id IN (SELECT id FROM jobs WHERE user_id=?)`, [uid]);
    }

    // THE ORDER IS THE FIX. `jobs.upload_id` references `uploads(id)` with no ON DELETE,
    // and SQLite checks it at the end of each statement - so the uploads must outlive the
    // jobs that point at them. It used to be the other way round, which failed with
    // "FOREIGN KEY constraint failed" for anyone who had dubbed anything.
    //
    // `usage_ledger.job_id` references `jobs(id)` the same way, so it is cleared first.
    // Matched by job as well as by owner, so a row written against one of these jobs by
    // anybody (a refund is written with the customer's id, but nothing enforces that)
    // cannot block the delete.
    db.execute('UPDATE usage_ledger SET job_id=NULL WHERE user_id=? OR job_id IN (SELECT id FROM jobs WHERE user_id=?)', [uid, uid]);
    wipe('jobs', 'DELETE FROM jobs WHERE user_id=?', [uid]);
    // Defensive: a job of ANOTHER account pointing at one of these uploads. Creating a
    // job checks the upload's owner, so this should match nothing - but if it ever did,
    // the delete below would fail and take the whole erasure with it.
    db.execute('UPDATE jobs SET upload_id=NULL WHERE user_id<>? AND upload_id IN (SELECT id FROM uploads WHERE user_id=?)', [uid, uid]);
    wipe('uploads', 'DELETE FROM uploads WHERE user_id=?', [uid]);

    wipe('sessions', 'DELETE FROM sessions WHERE user_id=?', [uid]);
    wipe('checkout_sessions', 'DELETE FROM checkout_sessions WHERE user_id=?', [uid]);
    // The email log: `body` holds live password-reset URLs, so it is a credential store.
    wipe('emails', 'DELETE FROM emails WHERE user_id=? OR to_email=?', [uid, email]);
    wipe('inbox_messages', 'DELETE FROM inbox_messages WHERE user_id=? OR email=?', [uid, email]);
    wipe('consent_records', 'DELETE FROM consent_records WHERE user_id=? OR email=?', [uid, email]);

    // 3 ── anonymise the financial spine rather than deleting it. The provider ids are
    // handles on a named person at the payment provider, so they go.
    db.execute(
      "UPDATE subscriptions SET provider_subscription_id=NULL, provider_order_id=NULL, reminded_json=NULL, status='cancelled' WHERE user_id=?",
      [uid],
    );
    db.execute("UPDATE usage_ledger SET note='erased' WHERE user_id=?", [uid]);

    // 4 ── the tombstone. Keeps every FK valid with no person attached. `google_sub` and
    // `email_normalised` are personal identifiers (and lookup keys), the verify columns a
    // live credential, the signup signals personal data: all go.
    const tomb = `erased-${uid}@invalid`;
    db.execute(
      "UPDATE users SET email=?, password_hash='erased', role='erased', reset_token_sha256=NULL, reset_expires_at=NULL, verify_token_sha256=NULL, verify_expires_at=NULL, google_sub=NULL, email_normalised=?, signup_ip=NULL, signup_user_agent=NULL WHERE id=?",
      [tomb, tomb, uid],
    );
  });

  // 5 ── the files, now that the account is committed as erased. Best effort each, so
  // one stuck file cannot leave the rest behind; a failure is logged for the operator.
  let files = 0;
  const unlinkCounted = (stored: string | null | undefined, withRenditions: boolean): void => {
    if (!stored) return;
    try {
      const p = paths.resolve(stored);
      if (p && existsSync(p)) {
        if (withRenditions) files += media.deleteRenditions(p);
        unlinkSync(p);
        files += 1;
      }
    } catch (e) {
      console.error(`  erase: could not delete a file of user ${uid}: ${(e as Error).message}`);
    }
  };
  for (const r of outputs) {
    unlinkCounted(r.output_path, true);
    if (r.output_r2_key) {
      try {
        if (await storage.del(r.output_r2_key)) files += 1;
      } catch (e) {
        console.error(`  erase: could not delete a stored object of user ${uid}: ${(e as Error).message}`);
      }
    }
  }
  // The source uploads too: whatever the retention sweep has not already removed.
  for (const r of sources) unlinkCounted(r.stored_path, false);
  deleted.files = files;

  const retained = [
    'Payment records (amount, date, method type, provider payment id) — kept for statutory financial record-keeping. No longer linked to a name or email address.',
    "Minute-usage totals, with the note replaced by 'erased' — kept so our financial records still add up.",
  ];
  const summary = { deleted, retained };
  try {
    await notify.accountErased(email, summary);
  } catch {
    /* the erasure stands either way */
  }

  // The session that made this call no longer belongs to anybody.
  return {
    ok: true,
    erased_at: db.now(),
    ...summary,
    note: 'Your account is closed. Payment records are retained in anonymised form; everything else is gone.',
  };
});
