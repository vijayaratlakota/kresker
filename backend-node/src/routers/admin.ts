/**
 * The admin dashboard API (plan 10.2).
 *
 * Every route here re-checks the admin role server-side. This is the one deliberate
 * exception to the rule that scopes every query by the caller's own user id, so it is
 * kept behind its own prefix, and the money-moving actions demand the password again.
 */
import type { Request } from 'express';
import * as billing from '../billing';
import { DOWNLOAD_TOKEN_TTL_S, ENGINE_URL, GPU_INSTANCE_ID, OUTPUT_DIR, TRUSTED_PROXIES } from '../config';
import * as consent from '../consent';
import * as db from '../db';
import type { Row } from '../db';
import { clientIp, reauth, requireAdmin, requireCsrf } from '../deps';
import * as emails from '../emails';
import * as gpu from '../gpu';
import { ApiRouter, HTTPException, header } from '../http';
import * as notify from '../notify';
import * as portability from '../portability';
import * as P from '../preset';
import { addSeconds, excStr, fmtStamp, pyDumps, pyf, pyFixed, pyRepr, pyRound, pySlice, pySortedStr, pyStrip, truthy } from '../py';
import * as ratelimit from '../ratelimit';
import * as security from '../security';
import * as site from '../site';
import * as storage from '../storage';
import { Model, optional, required, t } from '../validate';

export const router = new ApiRouter('/api/admin', ['admin']);

// One fixed timezone, defined once. Otherwise "today" moves with whoever is looking and
// two people never agree (plan 10.2, trap 5). India has no daylight saving.
const IST_MS = (5 * 60 + 30) * 60 * 1000;

/** [start of today, start of this week (Monday)] in IST, as UTC stamps. */
function istBounds(): [string, string] {
  const wall = new Date(Date.now() + IST_MS); // IST wall-clock, read through getUTC*
  const day = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) - IST_MS;
  const weekday = (wall.getUTCDay() + 6) % 7; // Monday = 0, as Python's weekday()
  const week = day - weekday * 86_400_000;
  return [fmtStamp(new Date(day)), fmtStamp(new Date(week))];
}

/**
 * Cash collected, not recurring revenue. Refunds subtract (plan 10.2, trap 6). And it
 * INCLUDES GST: prices are tax-exclusive, so this overstates income by the tax rate, and
 * the note says so.
 */
function earnings(): Record<string, unknown> {
  const [day, week] = istBounds();
  const q = "SELECT COALESCE(SUM(amount_paise),0) FROM payments WHERE status IN ('captured','refunded')";
  const total = Number(db.scalar(q, [], 0));
  const today = Number(db.scalar(q + ' AND at>=?', [day], 0));
  const thisWeek = Number(db.scalar(q + ' AND at>=?', [week], 0));
  return {
    currency: 'INR',
    note: 'cash collected INCLUDING GST, refunds subtracted. Plan prices are tax-exclusive, so this is more than the plan fees earned and is not the same as recurring revenue.',
    timezone: 'Asia/Kolkata, week starts Monday',
    total_rupees: pyf(pyRound(total / 100, 2)),
    today_rupees: pyf(pyRound(today / 100, 2)),
    week_rupees: pyf(pyRound(thisWeek / 100, 2)),
  };
}

/**
 * The instance state as AWS reports it, not as our own table believes. A box that is
 * running while we think it is stopped is the bug that quietly bills.
 */
async function realInstanceState(): Promise<Record<string, unknown>> {
  const s = await gpu.state();
  s.engine_url = ENGINE_URL;
  return s;
}

/** A column that may not exist yet on this database. */
function col(row: Row, name: string): unknown {
  return name in row ? row[name] : null;
}

router.get('/overview', { name: 'overview' }, async (req) => {
  requireAdmin(req);
  const [day] = istBounds();
  return {
    earnings: earnings(),
    gpu: await realInstanceState(),
    users: db.scalar('SELECT COUNT(*) FROM users', [], 0),
    sessions_active: db.scalar('SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at>?', [db.now()], 0),
    jobs_today: db.scalar('SELECT COUNT(*) FROM jobs WHERE created_at>=?', [day], 0),
    jobs_running: db.scalar("SELECT COUNT(*) FROM jobs WHERE state NOT IN ('done','failed','cancelled','queued')", [], 0),
    jobs_queued: db.scalar("SELECT COUNT(*) FROM jobs WHERE state='queued'", [], 0),
    subscribers: db.scalar("SELECT COUNT(DISTINCT user_id) FROM subscriptions WHERE status='active' AND current_period_end>=?", [db.now()], 0),
  };
});

router.get('/users', { name: 'users', query: { q: optional(t.str(), '') } }, (req, _res, { q }) => {
  const admin = requireAdmin(req);
  const needle = pyStrip(q);
  const like = `%${needle.toLowerCase()}%`;
  const rows = db.query("SELECT * FROM users WHERE (?='' OR LOWER(email) LIKE ?) ORDER BY id DESC LIMIT 200", [needle, like]);
  const out: Array<Record<string, unknown>> = [];
  for (const u of rows) {
    const ent = db.entitlement(u.id);
    out.push({
      id: u.id,
      email: u.email,
      role: u.role,
      created_at: u.created_at,
      subscribed: !ent.is_free,
      plan: ent.plan_name,
      minutes_left: ent.minutes_left,
      minutes_used: ent.minutes_used,
      period_end: ent.period_end,
      auto_renew: ent.auto_renew,
      jobs: db.scalar('SELECT COUNT(*) FROM jobs WHERE user_id=?', [u.id], 0),
      // Good standing and origin, so the list answers both without a request per row.
      status: col(u, 'status') || 'active',
      signup_ip: col(u, 'signup_ip'),
      // WHETHER THEY MAY BUY: a different question from good standing.
      can_purchase: 'can_purchase' in u ? truthy(u.can_purchase) : true,
      // The non-expiring half of their allowance, shown apart because it behaves apart.
      minutes_topup: ent.minutes_topup_left,
    });
  }
  logRead(req, admin, 'admin.users', { rowsReturned: out.length, detail: needle ? `search=${pyRepr(needle)}` : 'full list' });
  return { users: out };
});

router.get('/users/{user_id}/jobs', { name: 'user_jobs', path: { user_id: t.int() } }, (req, _res, { user_id }) => {
  // The screen for answering "my credits were taken but the dub was bad".
  const admin = requireAdmin(req);
  const rows = db.query(
    'SELECT j.*, u.original_name FROM jobs j LEFT JOIN uploads u ON u.id = j.upload_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT 200',
    [user_id],
  );
  const out: Array<Record<string, unknown>> = [];
  for (const j of rows) {
    const refunded = Number(db.scalar("SELECT COALESCE(SUM(minutes_charged),0) FROM usage_ledger WHERE job_id=? AND kind='refund'", [j.id], 0.0));
    const charged = Number(db.scalar("SELECT COALESCE(SUM(minutes_charged),0) FROM usage_ledger WHERE job_id=? AND kind='charge'", [j.id], 0.0));
    out.push({
      job_id: j.id,
      video_name: j.original_name || '(unnamed)',
      target_lang: j.target_lang,
      state: j.state,
      failed: j.state === 'failed',
      error_code: j.error_code,
      created_at: j.created_at,
      minutes_charged: pyf(pyRound(charged, 3)),
      minutes_refunded: pyf(pyRound(Math.abs(refunded), 3)),
      already_refunded: Math.abs(refunded) > 1e-9,
      refundable: charged > 1e-9 && Math.abs(refunded) < 1e-9,
      origin: j.origin,
    });
  }
  logRead(req, admin, 'admin.user_jobs', { targetUserId: user_id, rowsReturned: out.length });
  return { user_id, jobs: out };
});

const Suspend = new Model('Suspend', { reason: required(t.str()), password: required(t.str()) });

router.post('/users/{user_id}/suspend', { name: 'suspend_user', path: { user_id: t.int() }, body: Suspend }, async (req, _res, { user_id, body }) => {
  // Stop an account using the product, without destroying it. Reversible, audited, and it
  // revokes the sessions — a suspension that leaves a live cookie behind stops nothing.
  requireCsrf(req);
  const admin = await reauth(req, body.password);
  if (!pyStrip(body.reason)) throw new HTTPException(400, 'a reason is required');
  const row = db.one('SELECT * FROM users WHERE id=?', [user_id]);
  if (!row) throw new HTTPException(404, 'no such user');

  // THE REFUSALS THAT KEEP THE OPERATOR IN THEIR OWN PRODUCT: requireAdmin goes through
  // requireUser, which refuses a suspended account.
  if (row.id === admin.id) throw new HTTPException(400, 'you cannot suspend your own account');
  if (row.role === 'admin') {
    throw new HTTPException(400, 'an admin account cannot be suspended - change the role first if that is really what you mean');
  }
  if (row.role === 'erased') throw new HTTPException(400, 'that account is already closed and erased');

  const before = col(row, 'status') || 'active';
  db.execute("UPDATE users SET status='suspended' WHERE id=?", [user_id]);
  const killed = security.revokeAllForUser(user_id);
  db.audit(admin.id, 'suspend_user', {
    targetUserId: user_id,
    before: pyDumps({ status: before }),
    after: pyDumps({ status: 'suspended', sessions_revoked: killed }),
    reason: pyStrip(body.reason),
    ip: clientIp(req),
  });
  return {
    ok: true,
    user_id,
    status: 'suspended',
    sessions_revoked: killed,
    note: 'they can still reach /api/contact and /api/privacy/request - statutory rights do not depend on good standing',
  };
});

router.post('/users/{user_id}/unsuspend', { name: 'unsuspend_user', path: { user_id: t.int() }, body: Suspend }, async (req, _res, { user_id, body }) => {
  // Put a suspended account back. Audited, because reinstating is a decision too.
  requireCsrf(req);
  const admin = await reauth(req, body.password);
  if (!pyStrip(body.reason)) throw new HTTPException(400, 'a reason is required');
  const row = db.one('SELECT * FROM users WHERE id=?', [user_id]);
  if (!row) throw new HTTPException(404, 'no such user');
  const before = col(row, 'status') || 'active';
  db.execute("UPDATE users SET status='active' WHERE id=?", [user_id]);
  db.audit(admin.id, 'unsuspend_user', {
    targetUserId: user_id,
    before: pyDumps({ status: before }),
    after: pyDumps({ status: 'active' }),
    reason: pyStrip(body.reason),
    ip: clientIp(req),
  });
  // Sessions are NOT restored: revocation is one-way.
  return { ok: true, user_id, status: 'active', note: 'they will need to sign in again' };
});

router.get(
  '/signups',
  { name: 'signups_by_ip', query: { hours: optional(t.int(), 168), min_accounts: optional(t.int(), 2) } },
  (req, _res, { hours, min_accounts }) => {
    // Accounts grouped by the address they were created from. A REPORT, not enforcement:
    // a shared address is a weak signal. Access-logged: it returns other people's addresses.
    const admin = requireAdmin(req);
    const hrs = Math.max(1, Math.min(24 * 90, hours));
    const since = fmtStamp(new Date(Date.now() - hrs * 3_600_000));
    const minAccounts = Math.max(1, Math.min(1000, min_accounts));

    const rows = db.query(
      'SELECT signup_ip AS ip, COUNT(*) AS accounts,' +
        '       MIN(created_at) AS first_at, MAX(created_at) AS last_at,' +
        '       SUM(CASE WHEN email_verified_at IS NOT NULL THEN 1 ELSE 0 END)' +
        '         AS confirmed,' +
        "       SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) AS suspended" +
        '  FROM users' +
        " WHERE signup_ip IS NOT NULL AND created_at>=? AND role<>'erased'" +
        ' GROUP BY signup_ip HAVING COUNT(*)>=?' +
        ' ORDER BY COUNT(*) DESC, MAX(created_at) DESC LIMIT 200',
      [since, minAccounts],
    );

    const clusters = rows.map((r) => {
      const who = db.query(
        "SELECT id, email, created_at, status, email_verified_at FROM users WHERE signup_ip=? AND created_at>=? AND role<>'erased' ORDER BY created_at DESC LIMIT 50",
        [r.ip, since],
      );
      return {
        ip: r.ip,
        accounts: r.accounts,
        confirmed: r.confirmed,
        suspended: r.suspended,
        first_at: r.first_at,
        last_at: r.last_at,
        users: who.map((u) => ({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          status: u.status || 'active',
          confirmed: truthy(u.email_verified_at),
        })),
      };
    });

    // Accounts with no address at all, as a number, so an empty cluster view is not
    // mistaken for "no abuse" when it is really "no data yet".
    const unattributed = db.scalar("SELECT COUNT(*) FROM users WHERE signup_ip IS NULL AND role<>'erased'", [], 0);

    logRead(req, admin, 'admin.signups', { rowsReturned: clusters.length, detail: `window=${hrs}h, min_accounts=${minAccounts}` });
    return {
      window_hours: hrs,
      min_accounts: minAccounts,
      clusters,
      accounts_without_signup_ip: unattributed,
      ceiling: { per_ip_per_hour: ratelimit.SIGNUP_PER_IP_HOUR, per_ip_per_day: ratelimit.SIGNUP_PER_IP_DAY },
      note: 'a shared address is a weak signal - offices, universities and mobile carriers all put many real people behind one. Read this as a reason to look, not as evidence.',
    };
  },
);

const Grant = new Model('Grant', {
  plan_code: required(t.str()),
  months: optional(t.int(), 1),
  reason: required(t.str()),
  password: required(t.str()),
});

router.post('/users/{user_id}/grant', { name: 'grant', path: { user_id: t.int() }, body: Grant }, async (req, _res, { user_id, body }) => {
  // Give a user a subscription. Writes ONLY a subscriptions row: touching `payments`
  // would inflate the earnings figure on the same dashboard (plan 10.2, trap 2).
  requireCsrf(req);
  const admin = await reauth(req, body.password);
  if (!db.one('SELECT 1 FROM users WHERE id=?', [user_id])) throw new HTTPException(404, 'no such user');
  const plan = db.one('SELECT * FROM plans WHERE code=? AND active=1', [body.plan_code]);
  if (!plan) throw new HTTPException(400, 'no such plan');
  if (!pyStrip(body.reason)) throw new HTTPException(400, 'a reason is required');
  const months = Math.max(1, Math.min(36, body.months));
  const start = new Date();
  const end = addSeconds(start, 30 * months * 86400);

  db.execute("UPDATE subscriptions SET status='cancelled' WHERE user_id=? AND status='active'", [user_id]);
  const cur = db.execute(
    'INSERT INTO subscriptions (user_id, plan_code, provider,' +
      ' provider_subscription_id, status, current_period_start, current_period_end,' +
      ' grace_until, auto_renew, created_at)' +
      " VALUES (?,?,'manual',NULL,'active',?,?,?,0,?)",
    [user_id, body.plan_code, fmtStamp(start), fmtStamp(end), fmtStamp(addSeconds(end, 7 * 86400)), db.now()],
  );
  db.audit(admin.id, 'grant_subscription', {
    targetUserId: user_id,
    after: pyDumps({ plan: body.plan_code, months, period_end: fmtStamp(end), provider: 'manual' }),
    reason: pyStrip(body.reason),
    ip: clientIp(req),
  });
  return { ok: true, subscription_id: cur.lastrowid, plan: body.plan_code, period_end: fmtStamp(end), note: 'recorded as a manual grant; payments table untouched' };
});

const Revoke = new Model('Revoke', { reason: required(t.str()), password: required(t.str()) });

// `Revoke` plus the one decision an operator has to make. False (the default) stops the
// renewal and leaves the paid period alone; true ends it now.
const CancelSub = new Model('CancelSub', {
  reason: required(t.str()),
  password: required(t.str()),
  immediate: optional(t.bool(), false),
});

/**
 * Stop a subscription on somebody else's behalf. Shared by both routes below.
 *
 * THE PROVIDER FIRST, AND THE ROW WHATEVER HAPPENS — the rule `/api/billing/cancel`
 * follows: stopping the money is what was asked for; our row is only the record of it.
 */
async function cancelSubscription(
  userId: number,
  admin: Row,
  o: { reason: string; immediate: boolean; ip: string | null; action: string },
): Promise<Record<string, unknown>> {
  const sub = db.activeSubscription(userId);
  if (!sub) throw new HTTPException(404, 'that user has no active subscription');

  const stopped = await billing.cancelAtProvider(sub);
  let voided = 0.0;
  if (o.immediate) {
    // ENDS NOW: activeSubscription will no longer find a row.
    db.execute("UPDATE subscriptions SET status='cancelled', auto_renew=0, cancel_at=? WHERE id=?", [db.now(), sub.id]);
    // The top-up balance goes with it, written off with a reason rather than deleted.
    voided = db.voidTopups(userId, `subscription cancelled by an operator: ${o.reason}`);
  } else {
    // Stops the renewal and nothing else: the promise the customer's own button makes.
    db.execute('UPDATE subscriptions SET auto_renew=0, cancel_at=? WHERE id=?', [sub.current_period_end, sub.id]);
  }

  db.audit(admin.id, o.action, {
    targetUserId: userId,
    before: pyDumps({ plan: sub.plan_code, id: sub.id, auto_renew: truthy(sub.auto_renew) }),
    after: pyDumps({ immediate: o.immediate, provider_stopped: truthy(stopped.ok), topup_minutes_voided: pyf(voided) }),
    reason: o.reason,
    ip: o.ip,
  });

  const out: Record<string, unknown> = {
    ok: true,
    user_id: userId,
    plan_code: sub.plan_code,
    immediate: o.immediate,
    keeps_access_until: o.immediate ? null : sub.current_period_end,
    topup_minutes_voided: pyf(voided),
  };
  if (!truthy(stopped.ok)) {
    // NAMED AS AN OPERATOR PROBLEM, because only an operator reads this response.
    out.needs_operator = true;
    out.note = 'our record is updated but the payment provider did not confirm the cancellation. Check the billing view and stop it by hand.';
  }
  return out;
}

router.post(
  '/users/{user_id}/cancel-subscription',
  { name: 'cancel_subscription', path: { user_id: t.int() }, body: CancelSub },
  async (req, _res, { user_id, body }) => {
    // THE FASTEST LEVER for a payment that should not be happening. Suspension stops
    // somebody using the product; it does not stop their card being charged.
    requireCsrf(req);
    const admin = await reauth(req, body.password);
    if (!pyStrip(body.reason)) throw new HTTPException(400, 'a reason is required');
    if (!db.one('SELECT 1 FROM users WHERE id=?', [user_id])) throw new HTTPException(404, 'no such user');
    return cancelSubscription(user_id, admin, { reason: pyStrip(body.reason), immediate: body.immediate, ip: clientIp(req), action: 'cancel_subscription' });
  },
);

router.post('/users/{user_id}/revoke', { name: 'revoke', path: { user_id: t.int() }, body: Revoke }, async (req, _res, { user_id, body }) => {
  // Take a subscription away now: the older name for an immediate cancellation. Goes
  // through the same path, which stops the money first.
  requireCsrf(req);
  const admin = await reauth(req, body.password);
  return cancelSubscription(user_id, admin, { reason: pyStrip(body.reason), immediate: true, ip: clientIp(req), action: 'revoke_subscription' });
});

router.post(
  '/users/{user_id}/block-purchases',
  { name: 'block_purchases', path: { user_id: t.int() }, body: Suspend },
  async (req, _res, { user_id, body }) => {
    // Stop this account buying anything, and leave everything else working. Read through
    // billing.purchasableBy, the one gate every buying path passes. Does NOT touch an
    // existing subscription: that is /cancel-subscription, a separate decision.
    requireCsrf(req);
    const admin = await reauth(req, body.password);
    if (!pyStrip(body.reason)) throw new HTTPException(400, 'a reason is required');
    const row = db.one('SELECT * FROM users WHERE id=?', [user_id]);
    if (!row) throw new HTTPException(404, 'no such user');
    // THE SELF-LOCKOUT REFUSAL, same as suspend_user.
    if (row.id === admin.id) throw new HTTPException(400, 'you cannot block your own account from buying');
    const before = 'can_purchase' in row ? Math.trunc(Number(row.can_purchase)) : 1;
    db.execute('UPDATE users SET can_purchase=0 WHERE id=?', [user_id]);
    db.audit(admin.id, 'block_purchases', {
      targetUserId: user_id,
      before: pyDumps({ can_purchase: before }),
      after: pyDumps({ can_purchase: 0 }),
      reason: pyStrip(body.reason),
      ip: clientIp(req),
    });
    return {
      ok: true,
      user_id,
      can_purchase: false,
      note: 'they keep their plan, their minutes and their finished dubs. Only new purchases are refused. Any subscription they have still renews - cancel it separately if that is what you meant.',
    };
  },
);

router.post(
  '/users/{user_id}/allow-purchases',
  { name: 'allow_purchases', path: { user_id: t.int() }, body: Suspend },
  async (req, _res, { user_id, body }) => {
    // Let them buy again. Audited, because reinstating is a decision too.
    requireCsrf(req);
    const admin = await reauth(req, body.password);
    if (!pyStrip(body.reason)) throw new HTTPException(400, 'a reason is required');
    const row = db.one('SELECT * FROM users WHERE id=?', [user_id]);
    if (!row) throw new HTTPException(404, 'no such user');
    const before = 'can_purchase' in row ? Math.trunc(Number(row.can_purchase)) : 1;
    db.execute('UPDATE users SET can_purchase=1 WHERE id=?', [user_id]);
    db.audit(admin.id, 'allow_purchases', {
      targetUserId: user_id,
      before: pyDumps({ can_purchase: before }),
      after: pyDumps({ can_purchase: 1 }),
      reason: pyStrip(body.reason),
      ip: clientIp(req),
    });
    return { ok: true, user_id, can_purchase: true };
  },
);

const Refund = new Model('Refund', { reason: required(t.str()), password: required(t.str()) });

router.post('/jobs/{job_id}/refund', { name: 'refund', path: { job_id: t.str() }, body: Refund }, async (req, _res, { job_id, body }) => {
  // Refund a job's minutes. A NEW compensating ledger row: the original charge is never
  // edited or deleted, because a balance you cannot explain is worse than a wrong one.
  requireCsrf(req);
  const admin = await reauth(req, body.password);
  if (!pyStrip(body.reason)) throw new HTTPException(400, 'a reason is required');
  const job = db.one('SELECT * FROM jobs WHERE id=?', [job_id]);
  if (!job) throw new HTTPException(404, 'no such job');
  const split = db.jobLedgerSplit(job_id);
  const charged = split.charged;
  const already = Math.abs(Number(db.scalar("SELECT COALESCE(SUM(minutes_charged),0) FROM usage_ledger WHERE job_id=? AND kind='refund'", [job_id], 0.0)));
  if (charged <= 1e-9) throw new HTTPException(400, 'nothing was charged for that job');
  if (already > 1e-9) throw new HTTPException(409, 'that job was already refunded');
  db.execute(
    // `topup_minutes` mirrors the charge's own split, so the minutes go back to the
    // pocket they came out of.
    'INSERT INTO usage_ledger (user_id, job_id, minutes_charged, kind, admin_user_id, note, at, topup_minutes)' + " VALUES (?,?,?,'refund',?,?,?,?)",
    [job.user_id, job_id, pyf(-charged), admin.id, pyStrip(body.reason), db.now(), pyf(-split.outstanding_topup)],
  );
  db.audit(admin.id, 'refund_minutes', {
    targetUserId: job.user_id,
    targetJobId: job_id,
    after: pyDumps({ minutes_refunded: pyf(charged) }),
    reason: pyStrip(body.reason),
    ip: clientIp(req),
  });
  return { ok: true, minutes_refunded: pyf(pyRound(charged, 3)), method: 'compensating ledger row; the original charge is untouched' };
});

router.get('/sessions', { name: 'sessions' }, (req) => {
  // Who is signed in. Only token hashes are stored, so nothing replayable leaks — but it
  // returns every user's email, IP and User-Agent, which is why it is access-logged.
  const admin = requireAdmin(req);
  const rows = db.query(
    'SELECT s.id, s.user_id, u.email, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent FROM sessions s' +
      ' JOIN users u ON u.id=s.user_id WHERE s.revoked_at IS NULL AND s.expires_at>? ORDER BY s.last_seen_at DESC',
    [db.now()],
  );
  const out = rows.map((r) => ({ ...r }));
  logRead(req, admin, 'admin.sessions', { rowsReturned: out.length, detail: "every signed-in user's email, IP and user agent" });
  return { sessions: out };
});

router.delete('/sessions/{session_id}', { name: 'kill_session', path: { session_id: t.str() } }, (req, _res, { session_id }) => {
  requireCsrf(req);
  const admin = requireAdmin(req);
  const row = db.one('SELECT * FROM sessions WHERE id=?', [session_id]);
  if (!row) throw new HTTPException(404, 'no such session');
  security.revokeSession(session_id);
  db.audit(admin.id, 'revoke_session', { targetUserId: row.user_id, reason: 'admin signed this session out', ip: clientIp(req) });
  return { ok: true };
});

router.get('/gpu', { name: 'gpu_status' }, async (req) => {
  requireAdmin(req);
  return realInstanceState();
});

router.post('/gpu/stop', { name: 'gpu_stop', query: { force: optional(t.bool(), false) } }, async (req, _res, { force }) => {
  // The safety valve. Without force it obeys every condition the watchdog obeys, so it
  // cannot kill a render in flight. With force it stops regardless, so it is audited.
  requireCsrf(req);
  const admin = requireAdmin(req);
  if (force) {
    // ONLY WHERE THIS BACKEND ACTUALLY RUNS THE BOX. With the demo engine or VS_GPU_AUTO=0
    // the panel tells the admin "nothing here will start or stop a real machine" - and
    // this used to call `aws ec2 stop-instances` anyway, so a laptop with AWS credentials
    // could stop the production GPU from a development copy of the site.
    if (!gpu.enabled()) {
      throw new HTTPException(
        409,
        'the GPU lifecycle is off on this server (demo engine, or VS_GPU_AUTO=0), so there is no machine here to stop',
      );
    }
    const hold = gpu.holdReason();
    await gpu.shutdownTunnel();
    const [rc, , err] = await gpu.aws(['ec2', 'stop-instances', '--instance-ids', GPU_INSTANCE_ID, '--output', 'text']);
    db.audit(admin.id, 'gpu_force_stop', {
      reason: `forced while: ${hold || 'idle'}${rc === 0 ? '' : ` - AWS REFUSED THE STOP (exit ${rc})`}`,
      ip: clientIp(req),
    });
    // THE ANSWER HAS TO BE TRUE. This used to return 200 with the exit code buried in the
    // body, so the panel said "Force stopped" while the box - billing by the hour - kept
    // running. A refused stop is an error, and says what AWS said.
    if (rc !== 0) {
      throw new HTTPException(
        502,
        `AWS did not accept the stop (exit ${rc}): ${pySlice(err || 'no error text', 240)}. The box may still be running - check its state on this page.`,
      );
    }
    return { forced: true, was_holding: hold, rc };
  }
  const out = await gpu.maybeStop();
  db.audit(admin.id, 'gpu_stop_requested', { reason: (out.why as string | undefined) ?? null, ip: clientIp(req) });
  return out;
});

router.post('/gpu/start', { name: 'gpu_start' }, async (req) => {
  // Warm the box by hand. Normally an upload does this; useful before a demo.
  requireCsrf(req);
  const admin = requireAdmin(req);
  // Stamp the idle clock BEFORE the boot, or a watchdog tick during the six minutes it
  // takes to come up would stop the very box you just asked for.
  gpu.noteWorkFinished();
  await gpu.ensureRunning('admin asked', false);
  db.audit(admin.id, 'gpu_start_requested', { ip: clientIp(req) });
  return {
    starting: true,
    note: `warming up in the background; poll /api/admin/gpu. Held for ${pyFixed(gpu.GPU_IDLE_MINUTES, 0)} min from now unless work arrives`,
  };
});

router.get('/storage', { name: 'storage_status' }, (req) => {
  // Where finished videos are kept, and whether R2 is actually on (credentials in a file
  // and a switch being flipped are two different states).
  requireAdmin(req);
  const st = storage.status();
  st.local_output_dir = OUTPUT_DIR;
  st.jobs_on_r2 = db.scalar('SELECT COUNT(*) FROM jobs WHERE output_r2_key IS NOT NULL', [], 0);
  st.jobs_local_only = db.scalar('SELECT COUNT(*) FROM jobs WHERE output_path IS NOT NULL AND output_r2_key IS NULL AND output_deleted_at IS NULL', [], 0);
  st.download_token_ttl_s = DOWNLOAD_TOKEN_TTL_S;
  return st;
});

router.get('/mail', { name: 'mail_log', query: { limit: optional(t.int(), 100) } }, (req, _res, { limit }) => {
  // Every message we sent, so "did we tell them?" is a query, not a guess.
  const admin = requireAdmin(req);
  notify.ensureTables();
  const rows = db.query(
    'SELECT id, at, to_email, kind, subject, backend, ok, error, user_id, job_id FROM emails ORDER BY id DESC LIMIT ?',
    [Math.max(1, Math.min(1000, limit))],
  );
  logRead(req, admin, 'admin.mail', { rowsReturned: rows.length });
  const st = notify.status();
  // `resend_key_present` is a boolean, never the key.
  return {
    backend: notify.BACKEND,
    outbox_dir: notify.MAIL_DIR,
    from: st.from,
    resend_key_present: st.resend_key_present,
    resend_key_file: st.resend_key_file,
    note: st.note,
    failed_recently: db.scalar('SELECT COUNT(*) FROM emails WHERE ok=0', [], 0),
    emails: rows.map((r) => ({ ...r })),
  };
});

router.get('/limits', { name: 'rate_limits' }, (req) => {
  // What the rate limiter is enforcing: "was that lockout us?"
  requireAdmin(req);
  const buckets: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ratelimit.LIMITS)) buckets[k] = { max_hits: v[0], window_s: pyf(v[1]) };
  return {
    buckets,
    scope: 'per process, per key (IP or user id or email)',
    note: 'moves behind the CDN in production; call sites do not change',
    // The durable half: it counts rows in `users`, not hits in memory, and survives a restart.
    signup_ceiling: {
      per_ip_per_hour: ratelimit.SIGNUP_PER_IP_HOUR,
      per_ip_per_day: ratelimit.SIGNUP_PER_IP_DAY,
      counted_from: 'users.signup_ip',
      scope: 'durable, shared by every worker',
      note: 'counts accounts actually created, so a refused registration costs the caller nothing',
    },
    email_identity: emails.describe(),
    // THE ONE PIECE OF CONFIGURATION THAT SILENTLY BREAKS EVERYTHING ABOVE.
    client_ip: clientIpHealth(req),
  };
});

router.get('/portability', { name: 'portability_report' }, (req) => {
  // Could this installation be moved to another AWS account right now? Blockers and
  // warnings rather than a percentage.
  requireAdmin(req);
  return portability.readiness();
});

router.post('/export', { name: 'export_archive', query: { name: optional(t.nullable(t.str()), null) } }, (req, _res, { name }) => {
  // Write a migration archive. No secret enters it: recorded by name, never by value.
  requireCsrf(req);
  const admin = requireAdmin(req);
  // A NAME, not a destination path.
  let man: Record<string, any>;
  try {
    man = portability.exportArchive(name);
  } catch (e) {
    // Refused because the name tried to leave the export directory.
    if (e instanceof Error && e.name === 'ValueError') throw new HTTPException(400, excStr(e));
    throw e;
  }
  db.audit(admin.id, 'export_archive', {
    after: pyDumps({ totals: man.totals, schema: pySlice(String(man.schema_fingerprint), 12) }),
    reason: 'migration archive',
    ip: clientIp(req),
  });
  return {
    ok: true,
    archive: man.archive_dir,
    manifest: man,
    next: 'verify it with portability.verify(<dir>), then restore into an EMPTY database with portability.restore(<dir>, <new .db>)',
  };
});

router.get('/audit', { name: 'audit_log', query: { limit: optional(t.int(), 200) } }, (req, _res, { limit }) => {
  requireAdmin(req);
  const rows = db.query(
    'SELECT a.*, u.email AS admin_email FROM admin_audit a LEFT JOIN users u ON u.id=a.admin_user_id ORDER BY a.id DESC LIMIT ?',
    [Math.max(1, Math.min(1000, limit))],
  );
  return { audit: rows.map((r) => ({ ...r })) };
});

router.get('/preset', { name: 'show_preset' }, (req) => {
  // What the pipeline is actually being sent. Read-only on purpose.
  requireAdmin(req);
  return {
    version: P.PRESET_VERSION,
    preset_sha256: P.presetOnlyFingerprint(),
    generate: P.GENERATE_BASE,
    translate: P.TRANSLATE_BASE,
    download: P.DOWNLOAD_QUERY_BASE,
    source: "read off the engine's own UI on 2026-08-25 and confirmed by the owner",
    unconfirmed: [],
    deliberate_divergence: {
      default_track:
        "set per request to the target language, NOT 'Original' as the UI " +
        'showed. The UI setting suits reviewing a dub beside its source; ' +
        'delivery requires the dubbed track to be the default. Plan 2.4 ' +
        "records that leaving this at 'original' has already shipped a file " +
        'byte-identical to the source while every artifact looked clean.',
    },
    inert_fields: {
      slot_fit: 'ignored by the engine whenever timing_strategy is set',
      fit_options: 'engine applies these to smart_fit only, not strict_slot',
      condense: 'only attaches a suggestion for a human to apply; this product has no editing step so nothing consumes it',
    },
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// DPDP: the inbox, the consent record, and read-access logging
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Whether per-IP limiting can actually see individual callers. The dangerous
 * combination: a proxy IS in front of us and VS_TRUSTED_PROXIES does not list it, so
 * every caller collapses into one rate-limit key and one signup-ceiling bucket.
 */
function clientIpHealth(req: Request): Record<string, unknown> {
  const peer = req.vs.client ?? null;
  const fwd = header(req, 'x-forwarded-for');
  const trusted = pySortedStr(TRUSTED_PROXIES);
  const peerTrusted = Boolean(peer && TRUSTED_PROXIES.has(peer));
  const resolved = clientIp(req);

  let state: string;
  let advice: string;
  if (fwd && !peerTrusted) {
    state = 'collapsing';
    advice =
      `a proxy at ${peer ?? 'None'} is forwarding X-Forwarded-For but is not trusted, so ` +
      `every caller is being counted as ${resolved}. Set ` +
      `VS_TRUSTED_PROXIES=${peer ?? 'None'} and restart.`;
  } else if (fwd && peerTrusted) {
    state = 'ok';
    advice = 'the proxy is trusted and the real client address is used';
  } else if (trusted.length && !peerTrusted) {
    state = 'direct';
    advice = 'no proxy header on this request; the socket address is used, which cannot be spoofed';
  } else {
    state = 'direct';
    advice = 'no proxy in front of this request. Set VS_TRUSTED_PROXIES before putting one there, or per-IP limits will see only the proxy';
  }
  return {
    state,
    peer,
    resolved,
    x_forwarded_for_present: Boolean(fwd),
    peer_is_trusted: peerTrusted,
    trusted_proxies: trusted,
    advice,
  };
}

/**
 * Record that an admin LOOKED at personal data (FINDING-6). `db.audit` covers every admin
 * write and no admin read; DPDP s.8(5) needs access accounted for too. Best-effort: a
 * failure to log must not lock an admin out of investigating an incident.
 */
export function logRead(
  req: Request,
  adminRow: Row,
  surface: string,
  o: { targetUserId?: number | null; rowsReturned?: number | null; detail?: string | null } = {},
): void {
  try {
    db.execute('INSERT INTO admin_access_log (at, admin_user_id, surface, target_user_id, rows_returned, detail, ip) VALUES (?,?,?,?,?,?,?)', [
      db.now(),
      adminRow.id,
      surface,
      o.targetUserId ?? null,
      o.rowsReturned ?? null,
      o.detail ?? null,
      clientIp(req),
    ]);
  } catch {
    /* best effort */
  }
}

router.get('/inbox', { name: 'inbox', query: { status: optional(t.str(), ''), kind: optional(t.str(), '') } }, (req, _res, { status, kind }) => {
  // Contact messages and data-rights requests, newest first, in ONE list: a rights request
  // that arrives through the contact form still runs against a deadline.
  const admin = requireAdmin(req);
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('status=?');
    params.push(status);
  }
  if (kind) {
    where.push('kind=?');
    params.push(kind);
  }
  let sql = 'SELECT id, kind, user_id, email, name, subject, body, status, due_at, at, ip, handled_at, handled_by, handled_note FROM inbox_messages';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += " ORDER BY (status='new') DESC, due_at IS NULL, due_at, at DESC LIMIT 500";
  const rows = db.query(sql, params);
  const now = db.now();
  const out = rows.map((r) => {
    const d: Record<string, unknown> = { ...r };
    // Computed per row: a deadline nobody notices is the same as no deadline.
    d.overdue = Boolean(d.due_at && (d.due_at as string) <= now && !['resolved', 'rejected'].includes(d.status as string));
    return d;
  });
  // These rows contain a member of the public's email, IP and free text.
  logRead(req, admin, 'admin.inbox', { rowsReturned: out.length, detail: `status=${status || 'any'} kind=${kind || 'any'}` });
  return {
    messages: out,
    counts: {
      new: db.scalar("SELECT COUNT(*) FROM inbox_messages WHERE status='new'", [], 0),
      overdue: consent.overdueCount(),
    },
    rights_response_days: pyf(consent.RIGHTS_RESPONSE_DAYS),
  };
});

const HandleMessage = new Model('HandleMessage', {
  // 'in_progress' | 'resolved' | 'rejected'
  status: required(t.str()),
  // what was actually done
  note: optional(t.str(), ''),
});

router.post('/inbox/{message_id}', { name: 'handle_message', path: { message_id: t.int() }, body: HandleMessage }, (req, _res, { message_id, body }) => {
  // Move a message along, recording WHAT was done rather than only that it was.
  requireCsrf(req);
  const admin = requireAdmin(req);
  ratelimit.check('admin_write', String(admin.id));
  if (!['new', 'in_progress', 'resolved', 'rejected'].includes(body.status)) throw new HTTPException(400, 'unknown status');
  const row = db.one('SELECT * FROM inbox_messages WHERE id=?', [message_id]);
  if (!row) throw new HTTPException(404, 'no such message');
  db.execute('UPDATE inbox_messages SET status=?, handled_at=?, handled_by=?, handled_note=? WHERE id=?', [
    body.status,
    db.now(),
    admin.id,
    body.note || null,
    message_id,
  ]);
  db.audit(admin.id, `inbox_${body.status}`, {
    targetUserId: row.user_id,
    before: pyDumps({ status: row.status }),
    after: pyDumps({ status: body.status }),
    reason: body.note || `marked ${body.status}`,
    ip: clientIp(req),
  });
  return { ok: true, id: message_id, status: body.status };
});

router.get('/users/{user_id}/consent', { name: 'user_consent', path: { user_id: t.int() } }, (req, _res, { user_id }) => {
  // What one account agreed to, and the whole history behind it.
  const admin = requireAdmin(req);
  if (!db.one('SELECT 1 FROM users WHERE id=?', [user_id])) throw new HTTPException(404, 'no such user');
  const hist = consent.historyFor(user_id);
  logRead(req, admin, 'admin.user_consent', { targetUserId: user_id, rowsReturned: hist.length });
  return { user_id, current: consent.currentFor(user_id), history: hist, notice_version: consent.NOTICE_VERSION };
});

router.get('/dpdp', { name: 'dpdp_readiness' }, (req) => {
  // Is the DPDP surface configured, and what is outstanding? Every failing check names the fix.
  requireAdmin(req);
  return consent.readiness();
});

router.get('/access-log', { name: 'access_log', query: { limit: optional(t.int(), 200) } }, (req, _res, { limit }) => {
  // Who looked at whose personal data. Reading it is itself an access, so it logs itself.
  const admin = requireAdmin(req);
  const rows = db.query(
    'SELECT a.id, a.at, a.admin_user_id, u.email AS admin_email, a.surface, a.target_user_id, a.rows_returned, a.detail, a.ip' +
      ' FROM admin_access_log a LEFT JOIN users u ON u.id=a.admin_user_id ORDER BY a.id DESC LIMIT ?',
    [Math.max(1, Math.min(1000, limit))],
  );
  const out = rows.map((r) => ({ ...r }));
  logRead(req, admin, 'admin.access_log', { rowsReturned: out.length });
  return { access_log: out };
});

// ══════════════════════════════════════════════════════════════════════════════
// Maintenance mode
// ══════════════════════════════════════════════════════════════════════════════

router.get('/maintenance', { name: 'maintenance_status' }, (req) => {
  // Is the site off, since when, and who turned it off.
  requireAdmin(req);
  return site.maintenance();
});

const MaintenanceIn = new Model('MaintenanceIn', {
  on: required(t.bool()),
  // What the public page says. Optional: an admin in a hurry should not compose a sentence.
  note: optional(t.str({ maxLength: 400 }), ''),
});

router.post('/maintenance', { name: 'set_maintenance', body: MaintenanceIn }, (req, _res, { body }) => {
  // Turn the public site off, or back on. CSRF, admin only, rate limited and audited;
  // deliberately NOT password re-authenticated: it is reversible by the same button.
  requireCsrf(req);
  const admin = requireAdmin(req);
  ratelimit.check('admin_write', String(admin.id));

  const before = site.maintenance();
  site.put(site.MAINTENANCE_KEY, body.on ? '1' : '0', admin.id);
  const note = pyStrip(body.note);
  if (note) site.put(site.MAINTENANCE_NOTE_KEY, note, admin.id);
  const after = site.maintenance();

  db.audit(admin.id, body.on ? 'maintenance_on' : 'maintenance_off', {
    before: pyDumps({ on: before.on }),
    after: pyDumps({ on: after.on, note: after.note }),
    reason: note || (body.on ? 'site taken offline' : 'site brought back online'),
    ip: clientIp(req),
  });
  return {
    ok: true,
    ...after,
    note_to_admin: body.on
      ? 'Everyone except an admin session now gets a 503 with Retry-After. You still see the real site, so you can check your changes.'
      : 'The site is public again.',
  };
});

router.get('/seo', { name: 'seo_status' }, (req) => {
  // What crawlers are being told. A misconfigured origin silently serves `Disallow: /`.
  requireAdmin(req);
  const base = site.baseUrl();
  const indexable = base.startsWith('https://');
  return {
    public_base_url: base,
    indexable,
    why_not: indexable
      ? null
      : 'PUBLIC_BASE_URL is not https, so robots.txt serves Disallow: / to keep a staging copy out of the index. Set VS_PUBLIC_BASE_URL to the real origin.',
    sitemap_url: `${base}/sitemap.xml`,
    pages: site.sitemapUrls(),
    robots_txt: site.robotsTxt(),
  };
});
