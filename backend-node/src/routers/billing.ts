/**
 * Plans, checkout and the webhook.
 *
 * The one endpoint here that matters is the webhook, and the thing that makes it
 * trustworthy is what it does NOT do: it does not read a session, it does not trust a
 * query string, and it does not parse the body until the signature has been checked.
 *
 * There is no "payment succeeded, please upgrade me" endpoint for the browser to call,
 * by design. If one existed, it would be the whole security model.
 */
import type { Request } from 'express';
import * as billing from '../billing';
import * as db from '../db';
import type { Row } from '../db';
import { clientIp, current, requireAdmin, requireCsrf, requireUser } from '../deps';
import { ApiRouter, HTTPException, header, readBody } from '../http';
import { excStr, pyStr, truthy } from '../py';
import * as ratelimit from '../ratelimit';
import { Model, optional, required, t } from '../validate';

export const router = new ApiRouter('/api/billing', ['billing']);

const CHECKOUT_CLOSED = {
  code: 'checkout_closed',
  message: 'Paid plans are not open yet. Nothing was charged and your plan has not changed.',
};

/** Python's `except ValueError`: every error class named ValueError, whatever module. */
function isValueError(e: unknown): e is Error {
  return e instanceof Error && e.name === 'ValueError';
}

/** Every header's first value, lower-cased: what Starlette's `request.headers.get` sees. */
function firstHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    if (!(k in out)) out[k] = raw[i + 1];
  }
  return out;
}

// ── the price list ───────────────────────────────────────────────────────────

router.get('/plans', { name: 'plans' }, (req) => {
  // The public price list. Says out loud which plans renew themselves and which do not.
  const [, user] = current(req);
  const out: Record<string, unknown> = {
    currency: 'INR',
    plans: billing.catalogue(),
    // WHETHER BUYING IS OPEN, which is not the same as whether the provider is configured:
    // a sandbox checkout is open to the operator for testing and shut to everyone else.
    open: billing.purchasableBy(user),
    // `provider` is deliberately absent: this endpoint is public.
    live: billing.live(),
  };
  if (!billing.realMoneyPossible()) {
    // Names neither the provider nor the reason.
    out.warning = 'Paid plans are not open yet. You can use the free plan in the meantime — we will announce it here when they are.';
  }
  if (user) out.current = db.entitlement(user.id);
  return out;
});

const Checkout = new Model('Checkout', { plan_code: required(t.str()) });

// Shared by `/cancel`, `/resume` and `/change-plan/cancel`.
const Cancel = new Model('Cancel', { confirm: optional(t.bool(), false) });

router.post('/checkout', { name: 'checkout', body: Checkout }, async (req, _res, { body }) => {
  // Create the order or mandate and hand back opaque ids only.
  const user = requireUser(req);
  requireCsrf(req);
  ratelimit.check('checkout', String(user.id));

  // SANDBOX CHECKOUT IS FOR THE OPERATOR ONLY. A sandbox checkout completes with a test
  // card and a genuinely signed webhook, so any customer who found the button would
  // upgrade themselves for nothing. 403 rather than a quiet no-op.
  if (!billing.purchasableBy(user)) throw new HTTPException(403, CHECKOUT_CLOSED);
  try {
    return await billing.createCheckout(user.id, body.plan_code);
  } catch (e) {
    if (isValueError(e)) throw new HTTPException(400, excStr(e));
    throw new HTTPException(502, `payment provider error: ${excStr(e)}`);
  }
});

// ── top-ups ──────────────────────────────────────────────────────────────────

router.get('/topups', { name: 'topups' }, (req) => {
  // Extra minutes, for people who are already on a plan. A read: no CSRF, no rate limit.
  const user = requireUser(req);
  const gate = billing.topupAvailableTo(user.id);
  const ent = db.entitlement(user.id);
  return {
    currency: 'INR',
    packs: billing.topupCatalogue(),
    // `open`: does buying work at all here; `available`: is this account in a position to.
    open: billing.purchasableBy(user),
    available: gate.available,
    reason: gate.code ?? null,
    message: gate.message ?? null,
    balance_minutes: ent.minutes_topup_left,
    plan_minutes_left: ent.minutes_plan_left,
    minutes_left: ent.minutes_left,
    cap_minutes: billing.TOPUP_BALANCE_CAP_MINUTES,
    note: "extra minutes are used only after your plan's own minutes for the month are gone, and they do not expire while your plan is running.",
  };
});

const Topup = new Model('Topup', { pack_code: required(t.str()) });

router.post('/topup', { name: 'topup', body: Topup }, async (req, _res, { body }) => {
  // Buy one pack of extra minutes. A one-time payment; the mandate is not touched.
  const user = requireUser(req);
  requireCsrf(req);
  ratelimit.check('checkout', String(user.id));
  if (!billing.purchasableBy(user)) throw new HTTPException(403, CHECKOUT_CLOSED);
  try {
    return await billing.createTopupCheckout(user.id, body.pack_code);
  } catch (e) {
    // 402, not 400: the request was fine; the account is not in a position to make it.
    if (e instanceof billing.TopupNotAvailable) throw new HTTPException(e.status, { code: e.code, message: e.message });
    if (isValueError(e)) throw new HTTPException(400, excStr(e));
    throw new HTTPException(502, `payment provider error: ${excStr(e)}`);
  }
});

// ── plan changes ─────────────────────────────────────────────────────────────

const PlanChange = new Model('PlanChange', { plan_code: required(t.str()) });

/**
 * Everything a plan change shares with a checkout, plus the right limit for each.
 * Previewing has its own generous bucket (it charges nothing); changing a tighter one.
 * Neither can exhaust the other, and neither can stop somebody buying a plan.
 */
function changeGate(req: Request, previewing = false): Row {
  const user = requireUser(req);
  requireCsrf(req);
  ratelimit.check(previewing ? 'plan_preview' : 'plan_change', String(user.id));
  if (!billing.purchasableBy(user)) throw new HTTPException(403, CHECKOUT_CLOSED);
  return user;
}

/**
 * One mapping from a plan-change failure to a status and a sentence, shared by all three
 * routes so they cannot disagree about what a refusal is.
 */
function raiseChangeError(e: unknown): never {
  if (isValueError(e)) throw new HTTPException(400, excStr(e));
  if (e instanceof billing.PlanChangePending) throw new HTTPException(409, excStr(e));
  // The provider's own code stays out of the response; it is on the admin billing view.
  if (e instanceof billing.ProviderRefused) throw new HTTPException(e.status, e.message);
  throw new HTTPException(502, 'we could not complete that just now. Nothing has been charged — please try again in a moment.');
}

router.post('/change-plan/preview', { name: 'change_plan_preview', body: PlanChange }, (req, _res, { body }) => {
  // What switching would cost and what they would end up with. Changes nothing.
  const user = changeGate(req, true);
  try {
    return billing.previewPlanChange(user.id, body.plan_code);
  } catch (e) {
    raiseChangeError(e);
  }
});

router.post('/change-plan', { name: 'change_plan', body: PlanChange }, async (req, _res, { body }) => {
  // Move an existing subscription. Never sells a second one.
  const user = changeGate(req);
  try {
    return await billing.startPlanChange(user.id, body.plan_code);
  } catch (e) {
    raiseChangeError(e);
  }
});

router.post('/change-plan/cancel', { name: 'change_plan_cancel', body: Cancel }, async (req, _res, { body }) => {
  // Undo a queued change. Not gated on purchasableBy: it takes nothing and charges nothing.
  const user = requireUser(req);
  requireCsrf(req);
  if (!body.confirm) throw new HTTPException(400, 'confirm must be true');
  try {
    return await billing.cancelScheduledPlanChange(user.id);
  } catch (e) {
    // "you have no scheduled plan change" conflicts with the current state: 409.
    if (isValueError(e)) throw new HTTPException(409, excStr(e));
    // Our record was deliberately NOT cleared when the provider could not be reached.
    throw new HTTPException(502, 'we could not undo that just now. Nothing has changed — please try again in a moment.');
  }
});

router.post('/portal', { name: 'portal' }, async (req) => {
  // A one-time link to the payment provider's own billing area. Minted per click.
  const user = requireUser(req);
  requireCsrf(req);
  ratelimit.check('plan_change', String(user.id));
  try {
    return await billing.customerPortalLink(user.id);
  } catch (e) {
    if (isValueError(e)) throw new HTTPException(404, excStr(e));
    throw new HTTPException(502, 'we could not open your billing history just now. Please try again in a moment.');
  }
});

router.post('/resume', { name: 'resume', body: Cancel }, async (req, _res, { body }) => {
  // Undo a cancellation, so the plan renews again. The exit from a dead end: never gated.
  const user = requireUser(req);
  requireCsrf(req);
  if (!body.confirm) throw new HTTPException(400, 'confirm must be true');
  try {
    return await billing.resumeSubscription(user.id);
  } catch (e) {
    if (isValueError(e)) throw new HTTPException(409, excStr(e));
    if (e instanceof billing.ProviderRefused) throw new HTTPException(e.status, e.message);
    throw new HTTPException(502, 'we could not restart that just now. Your plan is unchanged — please try again in a moment.');
  }
});

// ── the webhooks ─────────────────────────────────────────────────────────────

router.post('/webhook', { name: 'webhook' }, async (req) => {
  // Razorpay's own signed message: the only thing that grants quota. Reads the RAW body.
  // Unauthenticated on purpose, so the IP bucket is the only handle.
  ratelimit.check('webhook', clientIp(req));
  // ONLY THE CONFIGURED PROVIDER MAY GRANT ANYTHING. 404: the route does not exist here.
  if (billing.provider() !== 'razorpay') throw new HTTPException(404, 'not found');
  const raw = await readBody(req);
  const sig = header(req, 'X-Razorpay-Signature');
  const out = billing.ingest(raw, sig, clientIp(req));
  if (!out.ok) {
    // 4xx: not ours or malformed, retrying cannot help. 5xx: ours and not applied, so the
    // provider must retry — `ingest` has rolled back, so the retry is a real attempt.
    throw new HTTPException(out.status ?? 400, out.detail ?? 'rejected');
  }
  return out;
});

router.post('/webhook/dodo', { name: 'webhook_dodo' }, async (req) => {
  // The other provider's signed message. Its own path, so each verifier only ever sees
  // messages it was built for. Reads the RAW body.
  ratelimit.check('webhook', clientIp(req));
  if (billing.provider() !== 'dodo') throw new HTTPException(404, 'not found');
  const raw = await readBody(req);
  const out = await billing.ingestDodo(raw, firstHeaders(req), clientIp(req));
  if (!out.ok) throw new HTTPException(out.status ?? 400, out.detail ?? 'rejected');
  return out;
});

// ── the customer's own billing ───────────────────────────────────────────────

router.get('/me', { name: 'my_billing' }, (req) => {
  // What this customer is on, what they paid, and what happens next.
  const user = requireUser(req);
  const ent = db.entitlement(user.id);
  const sub = db.activeSubscription(user.id);
  const pays = db.query(
    'SELECT provider_payment_id, amount_paise, currency, method, status, at, plan_code FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 50',
    [user.id],
  );
  let nxt: string | null = null;
  if (sub) {
    nxt = truthy(sub.auto_renew)
      ? 'renews automatically on ' + sub.current_period_end
      : 'ends on ' + sub.current_period_end + ' and does not renew itself; access continues until ' + (sub.grace_until || sub.current_period_end);
  }

  // A CHANGE THEY HAVE ASKED FOR AND NOT YET RECEIVED, resolved to a plan name and a date.
  let pending: Record<string, unknown> | null = null;
  if (sub && sub.scheduled_plan_code) {
    const p = db.one('SELECT name FROM plans WHERE code=?', [sub.scheduled_plan_code]);
    const kind = sub.scheduled_kind || 'downgrade';
    pending = {
      kind,
      plan_code: sub.scheduled_plan_code,
      plan_name: p ? p.name : sub.scheduled_plan_code,
      // A date for both kinds: every change is queued for the renewal now.
      effective_at: sub.scheduled_at,
      can_undo: true,
      // LEGACY: an unpaid page from before plan changes became renewal-only.
      payment_link: sub.scheduled_link || null,
    };
    if (truthy(sub.auto_renew)) nxt = `changes to ${pyStr(pending.plan_name)} on ${pyStr(sub.scheduled_at)}`;
  }

  // WHAT THE DASHBOARD MAY OFFER, decided here rather than inferred there.
  const monthly = Boolean(sub) && Boolean(sub ? db.one("SELECT 1 FROM plans WHERE code=? AND interval='month'", [sub.plan_code]) : null);
  const ending = Boolean(sub) && (!truthy(sub!.auto_renew) || truthy(sub!.cancel_at));
  let blocked: string | null = null;
  if (!monthly) blocked = 'only monthly plans can be changed';
  else if (pending) blocked = 'a change is already scheduled for your renewal';
  else if (ending) blocked = 'the plan is set to end; resume it first';

  // AN EXPLICIT COLUMN LIST: the row also carries the provider's name and ids.
  let shown: Record<string, unknown> | null = null;
  if (sub) {
    shown = {};
    for (const k of ['id', 'plan_code', 'status', 'current_period_start', 'current_period_end', 'grace_until', 'auto_renew', 'cancel_at']) {
      shown[k] = sub[k];
    }
  }

  return {
    entitlement: ent,
    // WHY THE LAST ATTEMPT FAILED, if one did in the past hour, in words fit to show.
    last_failure: billing.lastFailedAttempt(user.id),
    subscription: shown,
    scheduled_change: pending,
    can_change_plan: Boolean(monthly && !pending && !ending),
    change_blocked_reason: blocked,
    can_resume: Boolean(monthly && ending),
    what_happens_next: nxt,
    payments: pays.map((p) => ({ ...p })),
    // The unit, so a client does not show a hundred-times-too-large price.
    note: 'amounts are in paise; 100 paise = 1 rupee',
  };
});

router.post('/cancel', { name: 'cancel', body: Cancel }, async (req, _res, { body }) => {
  // Stop a monthly plan renewing. Access continues to the end of the period.
  const user = requireUser(req);
  requireCsrf(req);
  if (!body.confirm) throw new HTTPException(400, 'confirm must be true');
  const sub = db.activeSubscription(user.id);
  if (!sub) throw new HTTPException(409, 'no active subscription');
  if (!truthy(sub.auto_renew)) {
    return { ok: true, already: 'this plan does not renew anyway', ends: sub.current_period_end };
  }

  // THE PROVIDER FIRST: stopping the money is the part the customer actually asked for.
  const stopped = await billing.cancelAtProvider(sub);

  // Recorded either way: their wish is on file, and a failure reaches the operator.
  db.execute('UPDATE subscriptions SET auto_renew=0, cancel_at=? WHERE id=?', [sub.current_period_end, sub.id]);

  const out: Record<string, unknown> = {
    ok: true,
    auto_renew: false,
    keeps_access_until: sub.current_period_end,
    note: 'you keep the minutes you already paid for',
  };
  if (!stopped.ok) {
    // What is TRUE, without naming the provider or the mechanism.
    out.note = 'you keep the minutes you already paid for. We have recorded this and will confirm it by email.';
    out.needs_operator = true;
  }
  return out;
});

// ── admin views ──────────────────────────────────────────────────────────────

export const adminRouter = new ApiRouter('/api/admin/billing', ['admin']);

adminRouter.get('', { name: 'admin_billing', query: { limit: optional(t.int(), 100) } }, (req, _res, { limit }) => {
  // Everything that happened around money, including what was rejected.
  requireAdmin(req);
  billing.ensureTables();
  const lim = Math.max(1, Math.min(500, limit));
  const rows = (sql: string): Row[] => db.query(sql, [lim]).map((r) => ({ ...r }));
  return {
    provider: billing.status(),
    subscriptions: rows(
      'SELECT s.*, u.email, p.name AS plan_name FROM subscriptions s JOIN users u ON u.id=s.user_id JOIN plans p ON p.code=s.plan_code ORDER BY s.id DESC LIMIT ?',
    ),
    payments: rows('SELECT p.*, u.email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT ?'),
    checkout_sessions: rows('SELECT * FROM checkout_sessions ORDER BY rowid DESC LIMIT ?'),
    webhook_events: rows('SELECT id, provider, event_id, event_type, at, signature_ok, handled, result FROM webhook_events ORDER BY id DESC LIMIT ?'),
    webhook_rejects: rows('SELECT * FROM webhook_rejects ORDER BY id DESC LIMIT ?'),
    // CHARGEBACKS, open ones first: deciding whether to contest has a deadline.
    disputes: rows(
      'SELECT d.*, u.email FROM payment_disputes d LEFT JOIN users u ON u.id=d.user_id ORDER BY (d.outcome IS NOT NULL), d.updated_at DESC LIMIT ?',
    ),
  };
});

adminRouter.post('/sweep', { name: 'admin_sweep' }, async (req) => {
  // Run the reminder and expiry sweep now instead of waiting for the worker.
  requireCsrf(req);
  requireAdmin(req);
  return await billing.sweep();
});
