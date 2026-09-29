/**
 * Payments.
 *
 * Four rules shape every line in here:
 *
 *   1. The browser is never believed about payment. Quota is granted by a verified
 *      webhook and by nothing else, so closing the tab mid-payment still upgrades you and
 *      forging a "success!" call to our API achieves nothing.
 *   2. The signature is verified BEFORE the body is parsed. A failure is recorded,
 *      because it is either a misconfiguration or somebody probing.
 *   3. Everything is idempotent on the provider's own ids. Providers retry webhooks; a
 *      retry must be free.
 *   4. Monthly is a mandate, annual is a one-off order — a regulatory consequence, not a
 *      preference. Annual does not renew itself, which is why the reminder sweep is part
 *      of the feature.
 *
 * Card and UPI details never reach this process: we create an order, hand back an opaque
 * id, and the provider's hosted checkout does the rest.
 *
 * Every signature, every stored row and every provider call is the Python backend's, so
 * a webhook signed for one verifies on the other and either can take over mid-billing.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  BILLING_GRACE_DAYS,
  DODO_API_LIVE,
  DODO_API_TEST,
  DODO_ENV_FILE,
  DODO_WEBHOOK_TOLERANCE_S,
  GST_RATE,
  MANDATE_NO_AFA_CEILING_PAISE,
  PUBLIC_BASE_URL,
  RAZORPAY_API,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  RENEWAL_REMINDER_DAYS,
  appSecret,
  readEnvFile,
  withTaxPaise,
} from './config';
import * as db from './db';
import type { Row } from './db';
import * as notify from './notify';
import {
  PyFloat,
  addSeconds,
  errText,
  fmtStamp,
  parseStamp,
  pyB64decode,
  pyDumps,
  pyFormatG,
  pyLoads,
  pyRepr,
  pyRound,
  pySlice,
  pyStr,
  pyStrip,
  sha256Hex,
  tokenHex,
  truthy,
} from './py';

export const FMT = '%Y-%m-%dT%H:%M:%SZ';

const fmt = fmtStamp;
const parse = parseStamp;

// ── the Dodo Payments credentials ─────────────────────────────────────────────
// Read from a file OUTSIDE the repository and cached; environment variables win, so a
// test run can point VS_DODO_ENV at a file that does not exist and get a bare install.

let dodo: Record<string, string> | null = null;

const DODO_KEYS = ['DODO_API_KEY', 'DODO_WEBHOOK_SECRET', 'DODO_MODE'];

/** Where the credentials are, resolved WHEN ASKED so VS_DODO_ENV works whenever set. */
export function dodoEnvFile(): string {
  return process.env.VS_DODO_ENV || DODO_ENV_FILE;
}

export function loadDodo(): Record<string, string> {
  if (dodo !== null) return dodo;
  const cfg = readEnvFile(dodoEnvFile());
  for (const k of DODO_KEYS) {
    const env = process.env['VS_' + k];
    if (env) cfg[k] = env;
  }
  dodo = cfg;
  return cfg;
}

/** Drop the cache (a credentials file changed). */
export function reloadDodo(): Record<string, string> {
  dodo = null;
  return loadDodo();
}

/**
 * Is Dodo the provider? True as soon as EITHER half is present: a webhook secret with no
 * API key must not silently fall back to Razorpay.
 */
export function dodoConfigured(): boolean {
  const c = loadDodo();
  return Boolean(c.DODO_API_KEY || c.DODO_WEBHOOK_SECRET);
}

/** Can we actually create a checkout at Dodo? Needs the API key. */
export function dodoLive(): boolean {
  return Boolean(loadDodo().DODO_API_KEY);
}

/** True unless the credentials say `live`. Guessing wrong this way refuses a charge. */
export function dodoTestMode(): boolean {
  return pyStrip(loadDodo().DODO_MODE || 'test').toLowerCase() !== 'live';
}

export function dodoApi(): string {
  return dodoTestMode() ? DODO_API_TEST : DODO_API_LIVE;
}

/** Dodo's id for one of our plans, from DODO_PRODUCT_<plan_code>. */
export function dodoProductId(planCode: string): string {
  return pyStrip(loadDodo()[`DODO_PRODUCT_${planCode}`] || '');
}

/**
 * Were the stored product ids created in the account we are now pointed at? No marker
 * is NOT ready: "we do not know" means "do not sell".
 */
export function productsMatchMode(): boolean {
  const marker = pyStrip(loadDodo().DODO_PRODUCTS_MODE || '').toLowerCase();
  return marker === (dodoTestMode() ? 'test' : 'live');
}

/** Product id back to our plan code (plan_changed names a product, not a plan). */
export function planCodeForProduct(productId: string | null | undefined): string | null {
  const want = pyStrip(productId || '');
  if (!want) return null;
  for (const [k, v] of Object.entries(loadDodo())) {
    if (k.startsWith('DODO_PRODUCT_') && pyStrip(v || '') === want) return k.slice('DODO_PRODUCT_'.length);
  }
  return null;
}

/**
 * Candidate HMAC keys for the webhook signature, best guess first: the Standard Webhooks
 * reading (whsec_ + base64, decoded), then the raw bytes, then the raw bytes without the
 * prefix — because a secret pasted in the wrong form otherwise rejects every webhook.
 */
function dodoSecretKeys(): Buffer[] {
  const raw = pyStrip(loadDodo().DODO_WEBHOOK_SECRET || '');
  if (!raw) {
    // nothing configured: derive one, so the whole path is still exercisable
    return [createHash('sha256').update(Buffer.concat([Buffer.from('dodo-webhook|'), appSecret()])).digest()];
  }
  const keys: Buffer[] = [];
  const body = raw.startsWith('whsec_') ? raw.slice(6) : raw;
  try {
    const decoded = pyB64decode(body + '='.repeat((4 - (body.length % 4)) % 4));
    if (decoded.length) keys.push(decoded);
  } catch {
    /* not base64 */
  }
  keys.push(Buffer.from(raw, 'utf8'));
  if (body !== raw) keys.push(Buffer.from(body, 'utf8'));
  return keys;
}

// ── which provider is actually in play ────────────────────────────────────────

/** `dodo` or `razorpay`; Dodo wins whenever it is configured. */
export function provider(): string {
  return dodoConfigured() ? 'dodo' : 'razorpay';
}

/** True only when real keys are present. (A Dodo TEST key counts: checkout works.) */
export function live(): boolean {
  if (provider() === 'dodo') return dodoLive();
  return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

export function providerName(): string {
  if (provider() === 'dodo') {
    if (!dodoLive()) return 'dodo-test';
    return !dodoTestMode() ? 'dodo' : 'dodo-sandbox';
  }
  return live() ? 'razorpay' : 'razorpay-test';
}

/** Could a charge here actually take somebody's money? (A sandbox key cannot.) */
export function realMoneyPossible(): boolean {
  if (provider() === 'dodo') return dodoLive() && !dodoTestMode();
  return live();
}

/**
 * May THIS account start a checkout right now?
 *
 * The per-account purchase block comes first, ahead of every other rule. With live
 * credentials, the products must exist in the account those credentials name. With
 * Dodo SANDBOX credentials only the operator may buy — otherwise anybody who found the
 * button would upgrade themselves for nothing with a test card. Razorpay's own test mode
 * is not narrowed: it grants nothing without a webhook signed by the local secret.
 */
export function purchasableBy(user: Row | null | undefined): boolean {
  try {
    if (user && 'can_purchase' in user && !Math.trunc(Number(user.can_purchase || 0))) return false;
  } catch {
    /* absent means allowed */
  }
  if (realMoneyPossible()) return productsMatchMode();
  if (provider() === 'dodo') {
    try {
      return Boolean(user) && user!.role === 'admin';
    } catch {
      return false;
    }
  }
  return true;
}

// ── talking to Dodo ───────────────────────────────────────────────────────────

/** httpx's json= body: compact, UTF-8, no ASCII escaping. */
function jsonBytes(v: unknown): string {
  return pyDumps(v, { separators: [',', ':'], ensureAscii: false, allowNan: false });
}

export interface ProviderResponse {
  status_code: number;
  text: string;
  /** r.json(); throws like Python when the body is not JSON */
  json(): any;
}

async function dodoCall(method: string, url: string, body: unknown | undefined, timeoutS: number): Promise<ProviderResponse> {
  const key = loadDodo().DODO_API_KEY || '';
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutS * 1000),
  };
  if (body !== undefined) init.body = jsonBytes(body);
  const r = await fetch(url, init);
  const text = await r.text();
  return { status_code: r.status, text, json: () => pyLoads(text) };
}

/**
 * Tell the provider to stop taking money. Returns a report; never throws. Our own row
 * is updated by the caller regardless, and a failure is recorded where the operator
 * looks, because this is the one failure where a customer keeps being charged.
 */
export async function cancelAtProvider(sub: Row): Promise<Record<string, unknown>> {
  if (provider() !== 'dodo' || !dodoLive()) return { ok: true, skipped: 'no provider-side mandate to cancel' };
  let sid: string | null = null;
  try {
    sid = sub.provider_subscription_id ?? null;
  } catch {
    /* none */
  }
  // an annual plan is a one-off payment: there is no mandate to stop
  if (!sid) return { ok: true, skipped: 'one-off payment, no mandate exists' };

  // A mandate from a DIFFERENT account cannot be cancelled from here, and asking the
  // live host about a sandbox id answers 404 and reads like a failure to stop money.
  let rowProvider: string | null = null;
  try {
    rowProvider = 'provider' in sub ? sub.provider : null;
  } catch {
    rowProvider = null;
  }
  if (rowProvider && rowProvider !== providerName()) {
    return {
      ok: true,
      skipped: 'this mandate belongs to a different payment account, so there is nothing here to stop',
      row_provider: rowProvider,
      now: providerName(),
      provider_subscription_id: sid,
    };
  }

  let last = '';
  for (const body of [{ cancel_at_next_billing_date: true }, { status: 'cancelled' }]) {
    try {
      const r = await dodoCall('PATCH', `${dodoApi()}/subscriptions/${sid}`, body, 30.0);
      if (r.status_code < 300) return { ok: true, how: Object.keys(body)[0], provider_subscription_id: sid };
      last = `${r.status_code} ${pySlice(r.text || '', 160)}`;
    } catch (e) {
      last = errText(e);
    }
  }
  // A DURABLE ROW, NOT A LOG LINE: it belongs where an operator already looks.
  try {
    recordReject(null, pySlice(`provider cancel FAILED for ${sid}: ${last}`, 180), Buffer.alloc(0));
  } catch {
    /* best effort */
  }
  return { ok: false, why: last, provider_subscription_id: sid };
}

// ── why a payment failed, in words a customer can act on ─────────────────────
// What matters to a customer is one of three things: fix something about the card, use
// a different method, or wait and retry. Their wording stays with the operator.
const FAILURE_TRY_ANOTHER_METHOD = new Set([
  'ORDER_CREATION_FAILED', 'ORDER_ALREADY_EXISTS', 'PROVIDER_UNSUPPORTED',
  'PAYMENT_METHOD_UNSUPPORTED', 'PAYMENT_METHOD_PROVIDER_DECLINED',
  'MANDATE_REQUIRED_SYSTEM', 'MANDATE_INVALID', 'REVOCATION_OF_AUTHORIZATION',
]);
const FAILURE_ASK_THE_BANK = new Set([
  'DO_NOT_HONOR', 'CARD_DECLINED', 'GENERIC_DECLINE', 'INSUFFICIENT_FUNDS',
  'LIMIT_EXCEEDED', 'TRANSACTION_NOT_ALLOWED', 'TRANSACTION_NOT_APPROVED',
  'CARD_VELOCITY_EXCEEDED', 'CARD_NOT_ACTIVATED', 'INVALID_ACCOUNT',
  'FRAUDULENT', 'LOST_CARD', 'STOLEN_CARD', 'PICKUP_CARD',
]);
const FAILURE_FIX_THE_DETAILS = new Set([
  'EXPIRED_CARD', 'INCORRECT_CVC', 'INVALID_CVC', 'INCORRECT_NUMBER',
  'INVALID_CARD_NUMBER', 'INVALID_CARD_OWNER', 'INVALID_EXPIRY_YEAR', 'INVALID_PIN',
  'INVALID_UPI_ID', 'AUTHENTICATION_FAILURE', 'AUTHENTICATION_REQUIRED',
  'AUTHENTICATION_TIMEOUT', 'LIVE_MODE_TEST_CARD',
]);

/** One failed payment, as a sentence and a suggestion. Unknown codes mean "try again". */
export function failureAdvice(code: string | null | undefined): { group: string; message: string; try_another_method: boolean } {
  const c = pyStrip(code || '').toUpperCase();
  if (FAILURE_TRY_ANOTHER_METHOD.has(c)) {
    return {
      group: 'another_method',
      message: 'That payment could not be completed. No money was taken. This one is not your card - please try a different payment method, such as UPI.',
      try_another_method: true,
    };
  }
  if (FAILURE_ASK_THE_BANK.has(c)) {
    return {
      group: 'ask_the_bank',
      message: 'Your bank declined the payment. No money was taken. Try a different card or payment method, or check with your bank.',
      try_another_method: true,
    };
  }
  if (FAILURE_FIX_THE_DETAILS.has(c)) {
    return {
      group: 'fix_details',
      message: 'Those payment details were not accepted. No money was taken. Check the number, expiry and security code and try again.',
      try_another_method: false,
    };
  }
  return { group: 'retry', message: 'That payment did not go through, and no money was taken. You can try again.', try_another_method: false };
}

/** The customer's most recent failed purchase in the last hour, with advice. */
export function lastFailedAttempt(userId: number): Record<string, unknown> | null {
  ensureTables();
  const row = db.one(
    'SELECT plan_code, failure_code, failure_message, completed_at, mode FROM checkout_sessions' +
      " WHERE user_id=? AND status='failed' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
    [userId],
  );
  if (!row || !row.completed_at) return null;
  let age: number;
  try {
    age = (Date.now() - parse(row.completed_at).getTime()) / 1000;
  } catch {
    return null;
  }
  if (age > 3600) return null;
  const advice = failureAdvice(row.failure_code);
  // their code is NOT in here: this goes to the browser
  return { at: row.completed_at, what: row.plan_code, kind: row.mode, message: advice.message, try_another_method: advice.try_another_method };
}

/** Who receives payment data — the DPDP recipient disclosure, derived, never hand-written. */
export function paymentRecipient(): Record<string, string> {
  if (provider() === 'dodo') {
    return {
      who: 'Dodo Payments',
      what: 'your name, billing address and country, the amount, the plan, and your account id — never card details',
      why: 'selling and taking payment as merchant of record; card, UPI and bank details are entered on their page and never reach us',
    };
  }
  return {
    who: 'Razorpay',
    what: 'the amount, the plan, and your account id — never card details',
    why: 'taking payment; card and UPI details go to them directly, never through us',
  };
}

/** The Razorpay webhook secret; in test mode derived from the installation secret. */
export function webhookSecret(): Buffer {
  if (RAZORPAY_WEBHOOK_SECRET) return Buffer.from(RAZORPAY_WEBHOOK_SECRET, 'utf8');
  return Buffer.from(createHash('sha256').update(Buffer.concat([Buffer.from('razorpay-webhook|'), appSecret()])).digest('hex'), 'ascii');
}

/** The operator's view. Reports whether each credential is PRESENT, never what it is. */
export function status(): Record<string, unknown> {
  if (provider() === 'dodo') {
    const missing = db
      .query("SELECT code FROM plans WHERE active=1 AND interval IN ('month','year')")
      .map((p) => p.code as string)
      .filter((code) => !dodoProductId(code));
    return {
      provider: providerName(),
      live: live(),
      real_money_possible: realMoneyPossible(),
      mode: dodoTestMode() ? 'test' : 'live',
      api_host: dodoApi(),
      api_key_present: dodoLive(),
      webhook_secret_set: Boolean(loadDodo().DODO_WEBHOOK_SECRET),
      env_file: dodoEnvFile(),
      products_provisioned_for: pyStrip(loadDodo().DODO_PRODUCTS_MODE || '').toLowerCase() || null,
      products_match_mode: productsMatchMode(),
      selling_open: realMoneyPossible() && productsMatchMode(),
      plans_without_a_product: missing,
      topups_without_a_product: TOPUP_PACKS.filter((p) => !dodoProductId(p.code)).map((p) => p.code),
      webhook_tolerance_s: DODO_WEBHOOK_TOLERANCE_S,
      mandate_ceiling_rupees: new PyFloat(MANDATE_NO_AFA_CEILING_PAISE / 100),
      grace_days: new PyFloat(BILLING_GRACE_DAYS),
      reminder_days: RENEWAL_REMINDER_DAYS,
      note: !realMoneyPossible() ? 'sandbox credentials: checkout works end to end and no money can move' : 'live credentials; real charges are possible',
    };
  }
  return {
    provider: providerName(),
    live: live(),
    real_money_possible: realMoneyPossible(),
    key_id_public: RAZORPAY_KEY_ID || null,
    webhook_secret_set: Boolean(RAZORPAY_WEBHOOK_SECRET),
    mandate_ceiling_rupees: new PyFloat(MANDATE_NO_AFA_CEILING_PAISE / 100),
    grace_days: new PyFloat(BILLING_GRACE_DAYS),
    reminder_days: RENEWAL_REMINDER_DAYS,
    note: !live()
      ? 'test mode mints its own order ids and signs its own webhooks with the local secret, so the flow is exercisable without a live account. No money can move in this mode.'
      : 'live keys present; real charges are possible',
  };
}

// ── schema this module owns ───────────────────────────────────────────────────

/** Created here rather than in schema.sql, so an existing database picks them up. */
export function ensureTables(): void {
  db.execute(
    'CREATE TABLE IF NOT EXISTS webhook_events (' +
      ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      ' provider TEXT NOT NULL,' +
      ' event_id TEXT NOT NULL UNIQUE,' +
      ' event_type TEXT,' +
      ' at TEXT NOT NULL,' +
      ' signature_ok INTEGER NOT NULL,' +
      ' handled INTEGER NOT NULL DEFAULT 0,' +
      ' result TEXT,' +
      ' payload TEXT)',
  );
  db.execute(
    'CREATE TABLE IF NOT EXISTS checkout_sessions (' +
      ' id TEXT PRIMARY KEY,' +
      ' user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      ' plan_code TEXT NOT NULL,' +
      ' provider TEXT NOT NULL,' +
      ' mode TEXT NOT NULL,' +
      ' provider_order_id TEXT,' +
      ' provider_subscription_id TEXT,' +
      ' amount_paise INTEGER NOT NULL,' +
      ' status TEXT NOT NULL,' +
      ' created_at TEXT NOT NULL,' +
      ' completed_at TEXT)',
  );
  db.execute('CREATE INDEX IF NOT EXISTS ix_checkout_user ON checkout_sessions(user_id)');
  // signature failures are worth seeing on their own
  db.execute('CREATE TABLE IF NOT EXISTS webhook_rejects ( id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ip TEXT, why TEXT, bytes INTEGER, head TEXT)');
  // chargebacks: a lifecycle of their own, keyed on the provider's dispute id
  db.execute(
    'CREATE TABLE IF NOT EXISTS payment_disputes (' +
      ' dispute_id TEXT PRIMARY KEY,' +
      ' provider_payment_id TEXT,' +
      ' user_id INTEGER,' +
      ' amount_paise INTEGER NOT NULL DEFAULT 0,' +
      ' currency TEXT,' +
      ' status TEXT NOT NULL,' +
      ' stage TEXT,' +
      ' resolved_by_rdr INTEGER NOT NULL DEFAULT 0,' +
      ' plan_code TEXT,' +
      ' opened_at TEXT,' +
      ' settled_at TEXT,' +
      ' outcome TEXT,' +
      ' updated_at TEXT NOT NULL)',
  );
  db.execute('CREATE INDEX IF NOT EXISTS ix_disputes_user ON payment_disputes(user_id)');
  db.execute('CREATE INDEX IF NOT EXISTS ix_disputes_payment ON payment_disputes(provider_payment_id)');
  const columns: Array<[string, string, string]> = [
    ['payments', 'plan_code', 'TEXT'],
    ['payments', 'provider_order_id', 'TEXT'],
    ['payments', 'provider_subscription_id', 'TEXT'],
    ['subscriptions', 'provider_order_id', 'TEXT'],
    ['subscriptions', 'reminded_json', 'TEXT'],
    // a downgrade waits for the renewal; the customer's decision is remembered, not applied
    ['subscriptions', 'scheduled_plan_code', 'TEXT'],
    ['subscriptions', 'scheduled_at', 'TEXT'],
    // what the pending change waits for: a DATE (downgrade) or MONEY (upgrade)
    ['subscriptions', 'scheduled_kind', 'TEXT'],
    // the page the customer still has to pay on, so a closed tab is not a dead end
    ['subscriptions', 'scheduled_link', 'TEXT'],
  ];
  for (const [table, column, decl] of columns) {
    try {
      const cols = db.tableColumns(table);
      if (cols.size && !cols.has(column)) db.execute(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${decl}`);
    } catch {
      /* same tolerance as Python */
    }
  }
}

// ── the catalogue ─────────────────────────────────────────────────────────────

/** Monthly is a mandate; annual is a one-off order. */
export function modeFor(plan: Row): string {
  return plan.interval === 'month' ? 'subscription' : 'order';
}

/**
 * Whether a recurring debit for this amount could complete unattended — measured against
 * what is actually DEBITED (price plus GST), not the net price.
 */
export function mandateEligible(plan: Row): boolean {
  return plan.interval === 'month' && withTaxPaise(Math.trunc(Number(plan.price_paise))) <= MANDATE_NO_AFA_CEILING_PAISE;
}

/** round(GST_RATE * 100) in f"{...:g}" — "18". */
function gstWord(): string {
  return pyFormatG(pyRound(GST_RATE * 100));
}

export function catalogue(): Array<Record<string, unknown>> {
  const rows = db.query('SELECT * FROM plans WHERE active=1 ORDER BY price_paise');
  const out: Array<Record<string, unknown>> = [];
  for (const p of rows) {
    const interval = p.interval as string;
    const mode = modeFor(p);
    const paise = Math.trunc(Number(p.price_paise));
    const buyable = interval === 'month' || interval === 'year';
    const item: Record<string, unknown> = {
      code: p.code,
      name: p.name,
      interval,
      price_paise: paise,
      price_rupees: new PyFloat(pyRound(paise / 100, 2)),
      minutes_per_period: new PyFloat(Number(p.minutes_per_period)),
      max_video_seconds: Math.trunc(Number(p.max_video_seconds)),
      output_retention_days: new PyFloat(Number(p.output_retention_days)),
      purchasable: buyable,
      checkout_mode: buyable ? mode : null,
      mandate_eligible: mandateEligible(p),
      auto_renews: interval === 'month',
    };
    // Prices are NET of GST, which the provider adds at the payment page, so every
    // client must say so — and says it with these words, sent from one place.
    if (buyable) {
      item.price_excludes_tax = true;
      item.tax_percent = new PyFloat(pyRound(GST_RATE * 100, 2));
      item.price_with_tax_paise = withTaxPaise(paise);
      item.tax_note = `plus ${gstWord()}% GST. The exact tax is worked out at the payment page from your billing details.`;
    } else {
      item.price_excludes_tax = false;
      item.tax_percent = new PyFloat(0.0);
      item.price_with_tax_paise = 0;
      item.tax_note = '';
    }
    if (interval === 'year') {
      item.renewal_note =
        'one-time payment. It does not renew itself: we email you at 14 ' +
        'days, 3 days and on the day, and access continues for ' +
        `${pyFormatG(BILLING_GRACE_DAYS)} days past the end date`;
    } else if (interval === 'month') {
      item.renewal_note = 'renews automatically until you cancel';
    } else {
      item.renewal_note = 'lifetime free allowance, nothing to buy';
    }
    out.push(item);
  }
  return out;
}

// ── top-up minute packs ───────────────────────────────────────────────────────
// A one-time purchase that never touches the mandate, so it cannot leave a plan change
// pending at the provider. NOT rows in `plans`: a top-up is not a subscription. Priced so
// no pack is beaten by combining smaller ones and none undercuts moving up a plan.

export interface TopupPack {
  code: string;
  minutes: number;
  price_paise: number;
}

export const TOPUP_PACKS: ReadonlyArray<TopupPack> = [
  { code: 'topup_10', minutes: 10.0, price_paise: 24900 },
  { code: 'topup_20', minutes: 20.0, price_paise: 47900 },
  { code: 'topup_30', minutes: 30.0, price_paise: 69900 },
  { code: 'topup_40', minutes: 40.0, price_paise: 89900 },
  { code: 'topup_50', minutes: 50.0, price_paise: 109900 },
  { code: 'topup_60', minutes: 60.0, price_paise: 127900 },
];

// The most unspent, non-expiring, paid-for minutes one account may hold: a ceiling on
// what a disputed card could accumulate, far above any honest need.
export const TOPUP_BALANCE_CAP_MINUTES = 200.0;

/** A ValueError: answered 400 by the routes. */
export class BillingValueError extends Error {
  override name = 'ValueError';
}

/** Refused because of the account's situation (402 by default), not a bad request. */
export class TopupNotAvailable extends Error {
  override name = 'TopupNotAvailable';
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.code = opts.code ?? 'needs_plan';
    this.status = opts.status ?? 402;
  }
}

/** One pack by code, or null: the only way a client's string becomes minutes. */
export function topupPack(code: string | null | undefined): TopupPack | null {
  const want = pyStrip(code || '');
  const p = TOPUP_PACKS.find((x) => x.code === want);
  return p ? { ...p } : null;
}

/** The packs, priced, with tax said out loud exactly as `catalogue` does it. */
export function topupCatalogue(): Array<Record<string, unknown>> {
  return TOPUP_PACKS.map((p) => {
    const paise = Math.trunc(p.price_paise);
    return {
      code: p.code,
      minutes: new PyFloat(p.minutes),
      name: `${pyFormatG(p.minutes)} minutes`,
      price_paise: paise,
      price_rupees: new PyFloat(pyRound(paise / 100, 2)),
      price_excludes_tax: true,
      tax_percent: new PyFloat(pyRound(GST_RATE * 100, 2)),
      price_with_tax_paise: withTaxPaise(paise),
      tax_note: `plus ${gstWord()}% GST. The exact tax is worked out at the payment page from your billing details.`,
      per_minute_rupees: new PyFloat(pyRound(paise / 100 / p.minutes, 2)),
      one_time: true,
      auto_renews: false,
    };
  });
}

/**
 * May this account buy a top-up right now, and why not if not? Subscribers only: the
 * minutes are written off when the plan ends, so selling them without one sells nothing.
 */
export function topupAvailableTo(userId: number): Record<string, any> {
  const sub = db.activeSubscription(userId);
  if (!sub) {
    return {
      available: false,
      code: 'needs_plan',
      message: 'Extra minutes are for people on a monthly or annual plan. Choose a plan first and you can top up any time after.',
    };
  }
  const balance = db.topupBalance(userId, true);
  const room = pyRound(Math.max(0.0, TOPUP_BALANCE_CAP_MINUTES - balance), 3);
  if (room <= 0.0) {
    return {
      available: false,
      code: 'balance_full',
      balance_minutes: new PyFloat(balance),
      cap_minutes: new PyFloat(TOPUP_BALANCE_CAP_MINUTES),
      message: `You already have ${pyFormatG(balance)} extra minutes waiting. Use some of those and you can add more.`,
    };
  }
  return {
    available: true,
    balance_minutes: new PyFloat(balance),
    cap_minutes: new PyFloat(TOPUP_BALANCE_CAP_MINUTES),
    room_minutes: new PyFloat(room),
    plan_name: sub.plan_name,
  };
}

/**
 * Sell one pack of minutes: a one-time payment that never touches the mandate. Nothing
 * is granted here — the minutes arrive with `payment.succeeded`, through grantTopup.
 */
export async function createTopupCheckout(userId: number, packCode: string): Promise<Record<string, unknown>> {
  ensureTables();
  const pack = topupPack(packCode);
  if (!pack) throw new BillingValueError('no such minute pack');

  const gate = topupAvailableTo(userId);
  if (!gate.available) throw new TopupNotAvailable(gate.message, { code: gate.code });
  const room = Number(gate.room_minutes);
  if (pack.minutes > room + 1e-9) {
    throw new TopupNotAvailable(
      `that pack would take you past ${pyFormatG(TOPUP_BALANCE_CAP_MINUTES)} unused extra minutes. You have room for ${pyFormatG(room)} more right now.`,
      { code: 'balance_full' },
    );
  }

  const amount = Math.trunc(pack.price_paise);
  const sid = 'cs_' + tokenHex(8);
  let orderId: string | null = null;
  let checkoutUrl: string | null = null;

  if (provider() === 'dodo') {
    if (dodoLive()) {
      const out = await dodoPost('/checkouts', dodoTopupBody(userId, pack, sid));
      checkoutUrl = out.checkout_url || null;
      if (!checkoutUrl) throw new RuntimeError('no checkout url was returned');
      orderId = pyStr(out.session_id || '');
    } else {
      // sandbox with a webhook secret and no API key: a local id, so everything else runs for real
      orderId = 'dodo_TEST' + tokenHex(7);
    }
  } else if (live()) {
    const o = await razorpayPost('/orders', {
      amount,
      currency: 'INR',
      receipt: sid,
      notes: { purchase: 'topup', topup_code: pack.code, user_id: String(userId), checkout_session: sid },
    });
    orderId = o.id ?? null;
  } else {
    orderId = 'order_TEST' + tokenHex(7);
  }

  // mode='topup' is the marker the webhook reads, written before the customer pays
  db.execute(
    'INSERT INTO checkout_sessions (id, user_id, plan_code, provider, mode,' +
      ' provider_order_id, provider_subscription_id, amount_paise, status,' +
      " created_at) VALUES (?,?,?,?,'topup',?,NULL,?, 'created', ?)",
    [sid, userId, pack.code, providerName(), orderId, amount, db.now()],
  );

  return {
    checkout_session: sid,
    live: live(),
    checkout_url: checkoutUrl,
    mode: 'topup',
    key_id: RAZORPAY_KEY_ID || null,
    order_id: orderId,
    subscription_id: null,
    amount_paise: amount,
    amount_rupees: new PyFloat(pyRound(amount / 100, 2)),
    currency: 'INR',
    topup_code: pack.code,
    minutes: new PyFloat(pack.minutes),
    plan_code: pack.code,
    plan_name: `${pyFormatG(pack.minutes)} extra minutes`,
    auto_renews: false,
    note: 'nothing is charged until the payment provider confirms it. These minutes are added on top of your plan and do not expire while it runs.',
  };
}

/** The checkout request for one pack, built from the plan one so every fix applies to both. */
export function dodoTopupBody(userId: number, pack: TopupPack, sid: string): Record<string, unknown> {
  const body = dodoCheckoutBody(userId, pack.code, { name: `${pyFormatG(pack.minutes)} extra minutes`, price_paise: Math.trunc(pack.price_paise) }, sid);
  body.metadata = {
    purchase: 'topup',
    topup_code: pack.code,
    minutes: pyStr(new PyFloat(pack.minutes)),
    plan_code: pack.code,
    user_id: String(userId),
    checkout_session: sid,
  };
  return body;
}

/** Add a pack's minutes. Idempotent on the payment id; the unique index is the guarantee. */
export function grantTopup(userId: number, pack: TopupPack, providerPaymentId: string | null): Record<string, unknown> {
  if (providerPaymentId) {
    const existing = db.one('SELECT id, minutes FROM minute_topups WHERE provider_payment_id=?', [providerPaymentId]);
    if (existing) return { action: 'already_granted', topup_id: existing.id, minutes: new PyFloat(Number(existing.minutes)) };
  }
  let cur: db.ExecResult;
  try {
    cur = db.execute(
      'INSERT INTO minute_topups (user_id, pack_code, minutes, amount_paise, provider, provider_payment_id, at) VALUES (?,?,?,?,?,?,?)',
      [userId, pack.code, new PyFloat(pack.minutes), Math.trunc(pack.price_paise), providerName(), providerPaymentId || null, db.now()],
    );
  } catch (e) {
    // lost the race to a concurrent delivery, which granted it
    const row = db.one('SELECT id, minutes FROM minute_topups WHERE provider_payment_id=?', [providerPaymentId]);
    if (row) return { action: 'already_granted', topup_id: row.id, minutes: new PyFloat(Number(row.minutes)) };
    throw e;
  }
  return { action: 'topup_granted', topup_id: cur.lastrowid, minutes: new PyFloat(pack.minutes), balance_minutes: new PyFloat(db.topupBalance(userId)) };
}

// ── talking to the providers ──────────────────────────────────────────────────

/** httpx.HTTPStatusError, raised by raise_for_status(); carries the response. */
export class HTTPStatusError extends Error {
  override name = 'HTTPStatusError';
  constructor(
    message: string,
    readonly response: ProviderResponse,
  ) {
    super(message);
  }
}

/** A RuntimeError, named as in Python so logs and error codes read the same. */
export class RuntimeError extends Error {
  override name = 'RuntimeError';
}

function raiseForStatus(r: ProviderResponse, url: string, reason: string): void {
  if (r.status_code < 400) return;
  const cls = Math.floor(r.status_code / 100);
  const type = cls === 4 ? 'Client error' : cls === 5 ? 'Server error' : 'Invalid status code';
  throw new HTTPStatusError(
    `${type} '${r.status_code} ${reason}' for url '${url}'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${r.status_code}`,
    r,
  );
}

async function send(method: string, url: string, headers: Record<string, string>, body: unknown | undefined, timeoutS: number): Promise<[ProviderResponse, string]> {
  const init: RequestInit = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutS * 1000) };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = jsonBytes(body);
  }
  const r = await fetch(url, init);
  const text = await r.text();
  return [{ status_code: r.status, text, json: () => pyLoads(text) }, r.statusText];
}

async function razorpayPost(p: string, body: unknown): Promise<Record<string, any>> {
  const url = `${RAZORPAY_API}${p}`;
  const auth = 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`, 'utf8').toString('base64');
  const [r, reason] = await send('POST', url, { Authorization: auth }, body, 30.0);
  raiseForStatus(r, url, reason);
  return r.json();
}

/** One call to Dodo. Failures are NOT swallowed: a customer who pressed Buy must be told. */
export async function dodoPost(p: string, body: unknown, timeoutS = 30.0): Promise<Record<string, any>> {
  const url = `${dodoApi()}${p}`;
  const [r, reason] = await send('POST', url, { Authorization: `Bearer ${loadDodo().DODO_API_KEY || ''}` }, body, timeoutS);
  raiseForStatus(r, url, reason);
  return r.json();
}

export async function dodoGet(p: string, timeoutS = 30.0): Promise<Record<string, any>> {
  const url = `${dodoApi()}${p}`;
  const [r, reason] = await send('GET', url, { Authorization: `Bearer ${loadDodo().DODO_API_KEY || ''}` }, undefined, timeoutS);
  raiseForStatus(r, url, reason);
  return r.json();
}

/** A raw call whose status the caller inspects itself (httpx without raise_for_status). */
export async function dodoRaw(method: string, p: string, body?: unknown, timeoutS = 30.0): Promise<ProviderResponse> {
  const [r] = await send(method, `${dodoApi()}${p}`, { Authorization: `Bearer ${loadDodo().DODO_API_KEY || ''}` }, body, timeoutS);
  return r;
}

/**
 * Everything we ask the provider for, as a plain object, so it can be tested. The
 * metadata is our own attribution (the fallback when a session row cannot be found);
 * the currency is pinned to INR because every price here is in paise.
 */
export function dodoCheckoutBody(userId: number, planCode: string, plan: { name: string; price_paise?: number } | Row, sid: string): Record<string, any> {
  const product = dodoProductId(planCode);
  // a plan nobody mapped to a product: an error an operator can act on
  if (!product) throw new BillingValueError(`${plan.name} is not available for purchase yet`);

  // We already know who this is; do not make them type their email again.
  const row = db.one('SELECT email FROM users WHERE id=?', [Math.trunc(userId)]);
  const customer = row && row.email ? { email: row.email } : null;
  const base = PUBLIC_BASE_URL.replace(/\/+$/, '');

  const body: Record<string, any> = {
    product_cart: [{ product_id: product, quantity: 1 }],
    billing_currency: 'INR',
    metadata: { plan_code: planCode, user_id: String(userId), checkout_session: sid },
    return_url: base + '/app/billing?from=checkout',
    cancel_url: base + '/app/billing',
    // only what tax law needs: the country, and a postcode where GST/VAT is worked out
    minimal_address: true,
    // OFF: the saved-card tab collected no CVV and every such payment failed
    show_saved_payment_methods: false,
    customization: {
      // pinned, so the payment page looks like part of the same purchase for everybody
      theme: 'light',
      show_order_details: true,
    },
    feature_flags: {
      // every price on our site is in rupees
      allow_currency_selection: false,
      // we do not issue discount codes
      allow_discount_code: false,
      allow_phone_number_collection: true,
      // otherwise the provider holds the customer on its own order-summary page
      redirect_immediately: true,
    },
  };
  if (customer) body.customer = customer;
  return body;
}

/** Create the hosted checkout at Dodo. Returns [session_id, checkout_url]. */
async function dodoCheckout(userId: number, planCode: string, plan: Row, sid: string): Promise<[string, string]> {
  const out = await dodoPost('/checkouts', dodoCheckoutBody(userId, planCode, plan, sid));
  const url = out.checkout_url;
  if (!url) throw new RuntimeError('no checkout url was returned');
  return [pyStr(out.session_id || ''), pyStr(url)];
}

/** Create the order or subscription and return ONLY opaque ids — never a secret. */
export async function createCheckout(userId: number, planCode: string): Promise<Record<string, unknown>> {
  ensureTables();
  const plan = db.one('SELECT * FROM plans WHERE code=? AND active=1', [planCode]);
  if (!plan) throw new BillingValueError('no such plan');
  if (plan.interval === 'lifetime') throw new BillingValueError('the free plan is not something you buy');

  const mode = modeFor(plan);
  const amount = Math.trunc(Number(plan.price_paise));
  if (mode === 'subscription' && !mandateEligible(plan)) {
    // refuse rather than sell a mandate that will fail unattended later
    throw new BillingValueError(`${plan.name} is priced above the recurring-payment threshold; it must be sold as a one-time payment`);
  }

  const sid = 'cs_' + tokenHex(8);
  let orderId: string | null = null;
  let subId: string | null = null;
  let checkoutUrl: string | null = null;

  if (provider() === 'dodo') {
    // One call for both kinds: the product itself is recurring or not. The session id is
    // the handle the payment webhook arrives carrying.
    if (dodoLive()) [orderId, checkoutUrl] = await dodoCheckout(userId, planCode, plan, sid);
    else orderId = 'dodo_TEST' + tokenHex(7);
  } else if (live()) {
    if (mode === 'order') {
      const o = await razorpayPost('/orders', { amount, currency: 'INR', receipt: sid, notes: { plan_code: planCode, user_id: String(userId), checkout_session: sid } });
      orderId = o.id ?? null;
    } else {
      const s = await razorpayPost('/subscriptions', { plan_id: planCode, total_count: 120, notes: { plan_code: planCode, user_id: String(userId), checkout_session: sid } });
      subId = s.id ?? null;
    }
  } else {
    // test mode: ids shaped like Razorpay's, so nothing downstream has to care
    orderId = mode === 'order' ? 'order_TEST' + tokenHex(7) : null;
    subId = mode === 'subscription' ? 'sub_TEST' + tokenHex(7) : null;
  }

  db.execute(
    'INSERT INTO checkout_sessions (id, user_id, plan_code, provider, mode,' +
      ' provider_order_id, provider_subscription_id, amount_paise, status,' +
      " created_at) VALUES (?,?,?,?,?,?,?,?, 'created', ?)",
    [sid, userId, planCode, providerName(), mode, orderId, subId, amount, db.now()],
  );

  return {
    checkout_session: sid,
    live: live(),
    checkout_url: checkoutUrl,
    mode,
    key_id: RAZORPAY_KEY_ID || null,
    order_id: orderId,
    subscription_id: subId,
    amount_paise: amount,
    amount_rupees: new PyFloat(pyRound(amount / 100, 2)),
    currency: 'INR',
    plan_code: planCode,
    plan_name: plan.name,
    auto_renews: mode === 'subscription',
    note: 'nothing is charged until the payment provider confirms it, and your plan changes only after that.',
  };
}

// ── changing plan ─────────────────────────────────────────────────────────────
// MOVING AN EXISTING SUBSCRIPTION, NEVER SELLING A SECOND ONE: every plan change once
// went through checkout, and one customer ended up holding four live mandates.

/** Refused because of a state the customer is already in: answered 409. */
export class PlanChangePending extends Error {
  override name = 'PlanChangePending';
}

/** The provider said no for a reason a customer can act on. */
export class ProviderRefused extends Error {
  override name = 'ProviderRefused';
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.code = opts.code ?? '';
    this.status = opts.status ?? 409;
  }
}

// Their code -> our sentence, matched as a substring.
const REFUSAL_SENTENCES: ReadonlyArray<readonly [string, string]> = [
  ['SCHEDULED_CANCELLATION', 'your plan is already set to end, so it cannot be changed. Resume it first and then choose a different plan.'],
  ['PENDING_PLAN_CHANGE', 'your last plan change is still waiting on its payment. if it was only just started, give it a minute.'],
  ['PLAN_CHANGE_ALREADY', 'a plan change is already being confirmed. Give it a moment, or cancel it and start again.'],
  ['PENDING', 'a plan change is already being confirmed. Give it a moment, or cancel it and start again.'],
  ['INSUFFICIENT', 'your payment method declined the amount. Try a different one, or contact your bank.'],
  ['PAYMENT_METHOD', 'we could not use the payment method on file. Please update it and try again.'],
];

/**
 * What is ACTUALLY holding this subscription up: a payment still moving (wait), or one
 * that failed and left the change stuck at the provider (which only a person can clear).
 */
export async function pendingChangeSentence(sid: string): Promise<string> {
  let st = '';
  let ageMin = 0.0;
  try {
    const out = await dodoGet('/payments?page_size=20');
    const items = (out.items || out.data || []) as Array<Record<string, any>>;
    const mine = items.filter((p) => pyStr(p.subscription_id || '') === String(sid));
    if (mine.length) {
      st = pyStr(mine[0].status || '').toLowerCase();
      const born = pyStr(mine[0].created_at || '');
      if (born) {
        const started = Date.parse(born);
        if (Number.isNaN(started)) throw new Error('bad date');
        ageMin = (Date.now() - started) / 60000;
      }
    }
  } catch {
    st = '';
  }
  if (st === 'processing' || st === 'requires_customer_action') {
    // how old it is changes what is true: "a few minutes" is false after half a day
    if (ageMin > 30) {
      return (
        'this payment has been waiting far longer than it should. nothing has ' +
        'been charged twice and your current plan is unaffected - stop waiting ' +
        'to keep the plan you are on, then try the change again.'
      );
    }
    return 'your last plan change is still being confirmed. that can take a few minutes, and your new allowance appears here on its own as soon as it clears.';
  }
  if (st === 'failed' || st === 'cancelled' || st === 'requires_payment_method') {
    return (
      "that payment did not go through, and it has left the change stuck on our payment provider's side - which we cannot clear from here. nothing has " +
      'been charged and your current plan is unaffected. contact us and we will move your plan across by hand.'
    );
  }
  return 'your last plan change is still waiting on its payment. if it was only just started, give it a minute.';
}

/**
 * Turn a provider 4xx into something worth showing, or null to keep it a 502. A 5xx at
 * their end genuinely is "could not be reached".
 */
export function refusalFromResponse(resp: ProviderResponse | null | undefined): ProviderRefused | null {
  const st = resp?.status_code || 0;
  if (!(st >= 400 && st < 500)) return null;
  let body = '';
  try {
    body = pySlice(resp!.text || '', 400);
  } catch {
    /* none */
  }
  let code = '';
  try {
    const j = resp!.json();
    code = pyStr((j && typeof j === 'object' ? j.code : null) || '');
  } catch {
    code = '';
  }
  const hay = (code || body).toUpperCase();
  for (const [needle, sentence] of REFUSAL_SENTENCES) {
    if (hay.includes(needle)) return new ProviderRefused(sentence, { code, status: 409 });
  }
  // a 4xx with no sentence: still not an outage, and their text is not repeated
  return new ProviderRefused('that change could not be made just now. Nothing has been charged.', { code, status: 409 });
}

/** The same, for an exception raised by raise_for_status. */
function refusal(exc: unknown): ProviderRefused | null {
  return refusalFromResponse((exc as { response?: ProviderResponse })?.response);
}

/** Was this refusal "collecting by payment link is switched off" (a configuration state)? */
export function linkDisabledResponse(resp: ProviderResponse | null | undefined): boolean {
  if ((resp?.status_code || 0) !== 422) return false;
  let code = '';
  try {
    const j = resp!.json();
    code = pyStr((j && typeof j === 'object' ? j.code : null) || '');
  } catch {
    code = '';
  }
  if (code.toUpperCase().includes('PAYMENT_LINK_DISABLED')) return true;
  return (resp!.text || '').toUpperCase().includes('PAYMENT_LINK_DISABLED');
}

export function isLinkDisabled(exc: unknown): boolean {
  return linkDisabledResponse((exc as { response?: ProviderResponse })?.response);
}

/** The active subscription whose plan could be changed (one with a mandate), or null. */
export function currentMandate(userId: number): Row | null {
  ensureTables();
  return db.one(
    "SELECT * FROM subscriptions WHERE user_id=? AND status='active' AND provider_subscription_id IS NOT NULL ORDER BY id DESC LIMIT 1",
    [Math.trunc(userId)],
  );
}

/** `upgrade`, `downgrade`, `same`, or `interval` (monthly <-> annual is a purchase). */
export function planChangeKind(curPlan: Row, newPlan: Row): string {
  if (curPlan.code === newPlan.code) return 'same';
  if (curPlan.interval !== newPlan.interval) return 'interval';
  return Math.trunc(Number(newPlan.price_paise)) > Math.trunc(Number(curPlan.price_paise)) ? 'upgrade' : 'downgrade';
}

/** Everything that can be refused before the provider is involved. */
function changePrecheck(userId: number, planCode: string): [Row, Row, Row, string] {
  ensureTables();
  const newPlan = db.one('SELECT * FROM plans WHERE code=? AND active=1', [planCode]);
  if (!newPlan) throw new BillingValueError('no such plan');
  if (newPlan.interval === 'lifetime') throw new BillingValueError('the free plan is not something you switch to; cancel instead');

  const sub = currentMandate(userId);
  if (!sub) throw new BillingValueError('you do not have a monthly plan to change yet');
  const curPlan = db.one('SELECT * FROM plans WHERE code=?', [sub.plan_code]);
  if (!curPlan) throw new BillingValueError('your current plan is not one we can change automatically');

  // the two states the provider refuses, caught from OUR OWN ROW first
  if (sub.scheduled_plan_code) {
    const p = db.one('SELECT name FROM plans WHERE code=?', [sub.scheduled_plan_code]);
    const nm = p ? p.name : sub.scheduled_plan_code;
    // legacy only: a mid-upgrade row from before plan changes became renewal-only
    if (sub.scheduled_link) {
      throw new PlanChangePending(`your move to ${nm} is waiting for its payment. Finish that payment to complete it, or cancel the change if you have changed your mind.`);
    }
    throw new PlanChangePending(`you are already switching to ${nm} at the end of this period. Cancel that first if you want a different plan.`);
  }
  if (!sub.auto_renew || sub.cancel_at) {
    throw new PlanChangePending('your plan is set to end, so it cannot be changed yet. Choose \u201ckeep my plan\u201d first, then pick the plan you want.');
  }

  const kind = planChangeKind(curPlan, newPlan);
  if (kind === 'same') throw new BillingValueError(`you are already on ${newPlan.name}`);
  if (kind === 'interval') {
    throw new BillingValueError(`${newPlan.name} is billed yearly, so it is a separate purchase rather than a change to your monthly plan`);
  }
  if (kind === 'upgrade' && !mandateEligible(newPlan)) {
    // the renewal debits the NEW price on the existing mandate
    throw new BillingValueError(`${newPlan.name} is priced above the recurring-payment threshold; it must be bought as a one-time payment`);
  }
  return [sub, curPlan, newPlan, kind];
}

/**
 * The change-plan request. One mode in both directions: nothing charged today, the new
 * plan starts at the renewal — an immediate charge could leave a change stuck PENDING at
 * the provider forever.
 */
export function dodoChangeBody(planCode: string, kind: string, userId: number): Record<string, unknown> {
  const product = dodoProductId(planCode);
  if (!product) throw new BillingValueError('that plan is not available for purchase yet');
  return {
    product_id: product,
    quantity: 1,
    // our own attribution, on the payment this creates
    metadata: { plan_code: planCode, user_id: String(userId), plan_change: kind },
    // a second change supersedes a queued one instead of colliding with it
    cancel_scheduled_change_plan: true,
    // the pair is forced: next_billing_date only accepts full_immediately
    proration_billing_mode: 'full_immediately',
    effective_at: 'next_billing_date',
  };
}

/** What the customer is agreeing to, before they agree to it. Always free, at the renewal. */
export function previewPlanChange(userId: number, planCode: string): Record<string, unknown> {
  const [sub, curPlan, newPlan, kind] = changePrecheck(userId, planCode);
  return {
    kind,
    from_plan: curPlan.code,
    to_plan: newPlan.code,
    plan_name: newPlan.name,
    amount_paise: 0,
    currency: 'INR',
    amount_rupees: new PyFloat(0.0),
    exact: true,
    charge_now: false,
    effective_at: sub.current_period_end,
    minutes_after: new PyFloat(Number(newPlan.minutes_per_period)),
    minutes_used: new PyFloat(db.minutesUsed(Math.trunc(userId), sub.current_period_start)),
    note:
      'nothing is charged today. your current plan runs to the end of the period you have paid for, and ' +
      (kind === 'downgrade'
        ? 'the new price starts then.'
        : `${newPlan.name} starts then. if you need more minutes before that, add extra minutes to the plan you are on.`),
  };
}

/** Ask the provider to move this mandate. Records what was asked for; payment applies it. */
export async function startPlanChange(userId: number, planCode: string): Promise<Record<string, unknown>> {
  const [sub, curPlan, newPlan, kind] = changePrecheck(userId, planCode);
  const sid = sub.provider_subscription_id as string;

  if (dodoLive()) {
    try {
      await dodoPost(`/subscriptions/${sid}/change-plan`, dodoChangeBody(planCode, kind, userId));
    } catch (e) {
      // a 4xx carries a reason worth showing; the marker is not written either way
      const refused = refusal(e);
      if (refused !== null) {
        if ((refused.code || '').toUpperCase().includes('PENDING')) refused.message = await pendingChangeSentence(sid);
        throw refused;
      }
      throw e;
    }
  }

  // their date, not ours; our period end is the fallback
  let when: string | null = null;
  if (dodoLive()) {
    try {
      const s = await dodoGet(`/subscriptions/${sid}`);
      const eff = (s.scheduled_change || {}).effective_at;
      if (eff) {
        const t = Date.parse(pyStr(eff));
        if (Number.isNaN(t)) throw new Error('bad date');
        when = fmt(new Date(t));
      }
    } catch {
      when = null;
    }
  }
  when = when || sub.current_period_end;

  db.execute('UPDATE subscriptions SET scheduled_plan_code=?, scheduled_at=?, scheduled_kind=?, scheduled_link=NULL WHERE id=?', [newPlan.code, when, kind, sub.id]);

  let note = `${newPlan.name} starts when your current period ends. nothing is charged today and you keep your present plan until then.`;
  if (kind === 'upgrade') note += ' if you need more minutes before then, add extra minutes to the plan you are on now.';
  return {
    kind,
    from_plan: curPlan.code,
    to_plan: newPlan.code,
    plan_name: newPlan.name,
    effective_at: when,
    pending: true,
    payment_link: null,
    charge_now: false,
    note,
  };
}

/** Abandon a plan change, queued or in flight: the way out of a stuck upgrade. */
export async function cancelScheduledPlanChange(userId: number): Promise<Record<string, unknown>> {
  ensureTables();
  const sub = currentMandate(userId);
  if (!sub || !sub.scheduled_plan_code) throw new BillingValueError('you have no scheduled plan change');
  const was = sub.scheduled_plan_code;
  const kind = sub.scheduled_kind || 'downgrade';
  const inFlight = Boolean(sub.scheduled_link);
  if (dodoLive()) {
    const sid = sub.provider_subscription_id;
    let r: ProviderResponse;
    try {
      r = await dodoRaw('DELETE', `/subscriptions/${sid}/change-plan/scheduled`);
    } catch (e) {
      throw new RuntimeError(errText(e));
    }
    // 404: nothing scheduled at their end, which is the state we want
    if (r.status_code >= 300 && r.status_code !== 404) throw new RuntimeError(`${r.status_code} ${pySlice(r.text || '', 160)}`);
  }
  db.execute('UPDATE subscriptions SET scheduled_plan_code=NULL, scheduled_at=NULL, scheduled_kind=NULL, scheduled_link=NULL WHERE id=?', [sub.id]);
  const plan = db.one('SELECT name FROM plans WHERE code=?', [sub.plan_code]);
  return {
    cancelled: was,
    staying_on: sub.plan_code,
    kind,
    plan_name: plan ? plan.name : sub.plan_code,
    note: !inFlight
      ? 'your plan is unchanged and will renew as usual.'
      : 'we have stopped waiting for that payment. If it does go through after all, the new plan is applied and nothing is charged twice.',
  };
}

/** A one-time link to the provider's own hosted billing area (invoices, card on file). */
export async function customerPortalLink(userId: number): Promise<Record<string, unknown>> {
  ensureTables();
  const sub = db.one('SELECT provider_subscription_id FROM subscriptions WHERE user_id=? AND provider_subscription_id IS NOT NULL ORDER BY id DESC LIMIT 1', [
    Math.trunc(userId),
  ]);
  if (!sub) throw new BillingValueError('there is no billing history to show yet');
  if (!dodoLive()) throw new RuntimeError('the billing area is not available on this installation');
  const s = await dodoGet(`/subscriptions/${sub.provider_subscription_id}`);
  const cid = (s.customer || {}).customer_id;
  if (!cid) throw new RuntimeError('could not identify the billing account');
  const out = await dodoPost(`/customers/${cid}/customer-portal/session`, {});
  const link = (out || {}).link;
  if (!link) throw new RuntimeError('no billing area link was returned');
  // not stored: these expire
  return { url: pyStr(link) };
}

/** Undo a cancellation, so the plan renews again. Takes no new money, so never gated. */
export async function resumeSubscription(userId: number): Promise<Record<string, unknown>> {
  ensureTables();
  const sub = currentMandate(userId);
  if (!sub) throw new BillingValueError('you do not have a monthly plan to resume');
  if (sub.auto_renew && !sub.cancel_at) return { ok: true, already: 'this plan already renews', plan_code: sub.plan_code };

  if (dodoLive()) {
    const sid = sub.provider_subscription_id;
    let r: ProviderResponse;
    try {
      r = await dodoRaw('PATCH', `/subscriptions/${sid}`, { cancel_at_next_billing_date: false });
    } catch (e) {
      throw new RuntimeError(errText(e));
    }
    if (r.status_code >= 300) {
      // our row is NOT touched on failure: "your plan will renew" must not be a lie
      const refused = refusalFromResponse(r);
      throw refused || new RuntimeError(`${r.status_code} ${pySlice(r.text || '', 160)}`);
    }
  }
  db.execute('UPDATE subscriptions SET auto_renew=1, cancel_at=NULL, reminded_json=NULL WHERE id=?', [sub.id]);
  const plan = db.one('SELECT name FROM plans WHERE code=?', [sub.plan_code]);
  return {
    ok: true,
    plan_code: sub.plan_code,
    plan_name: plan ? plan.name : sub.plan_code,
    renews_on: sub.current_period_end,
    note: 'your plan will renew as usual. You can change or cancel it any time.',
  };
}

/**
 * Put the subscription on `plan` and clear the pending marker. The period start is left
 * alone on purpose: minutes are derived from it, so an upgrade with 5 of 10 spent yields
 * the new allowance less 5 — and a ladder of changes cannot mint extra allowances.
 */
function applyPlanChange(sub: Row, plan: Row): Record<string, unknown> {
  db.execute(
    'UPDATE subscriptions SET plan_code=?, scheduled_plan_code=NULL, scheduled_at=NULL, scheduled_kind=NULL, scheduled_link=NULL WHERE id=?',
    [plan.code, sub.id],
  );
  // keep every layer of the renewal resolver telling one story
  const sid = sub.provider_subscription_id;
  if (sid) {
    db.execute('UPDATE checkout_sessions SET plan_code=?, amount_paise=? WHERE provider_subscription_id=?', [plan.code, Math.trunc(Number(plan.price_paise)), sid]);
  }
  return { subscription_id: sub.id, plan_code: plan.code };
}

/** Apply a pending change this payment has just paid for. Returns [kind, plan, immediate] or null. */
function settlePlanChange(subscriptionId: string): [string, Row, boolean] | null {
  const sub = db.one(
    "SELECT * FROM subscriptions WHERE provider_subscription_id=? AND status='active' AND scheduled_plan_code IS NOT NULL ORDER BY id DESC LIMIT 1",
    [subscriptionId],
  );
  if (!sub) return null;
  const now = new Date();
  const kind = sub.scheduled_kind || 'downgrade';
  // legacy: only an old immediate upgrade carries a link
  const immediate = Boolean(sub.scheduled_link);
  if (immediate) {
    // an upgrade marker must not outlive its payment
    let asked: Date | null;
    try {
      asked = parse(sub.scheduled_at);
    } catch {
      asked = null;
    }
    if (asked && now.getTime() - asked.getTime() > BILLING_GRACE_DAYS * 86400_000) {
      db.execute('UPDATE subscriptions SET scheduled_plan_code=NULL, scheduled_at=NULL, scheduled_kind=NULL, scheduled_link=NULL WHERE id=?', [sub.id]);
      return null;
    }
  } else if ((sub.scheduled_at || '') > fmt(now)) {
    // queued for a renewal that has not arrived: this payment is something else
    return null;
  }
  const plan = db.one('SELECT * FROM plans WHERE code=?', [sub.scheduled_plan_code]);
  if (!plan) return null;
  applyPlanChange(sub, plan);
  return [kind, plan, immediate];
}

/**
 * Switch anybody whose queued DOWNGRADE has come due. Only downgrades: a clock is not
 * evidence of money, and an upgrade applied on a timer would be a plan nobody paid for.
 */
export function applyDuePlanChanges(): Record<string, unknown> {
  ensureTables();
  const nowS = fmt(new Date());
  const rows = db.query(
    "SELECT * FROM subscriptions WHERE status='active' AND scheduled_kind='downgrade' AND scheduled_plan_code IS NOT NULL AND scheduled_at IS NOT NULL AND scheduled_at<=?",
    [nowS],
  );
  const done: Array<Record<string, unknown>> = [];
  for (const sub of rows) {
    const plan = db.one('SELECT * FROM plans WHERE code=?', [sub.scheduled_plan_code]);
    if (!plan) {
      // a plan retired out from under a queued change: drop the marker
      db.execute('UPDATE subscriptions SET scheduled_plan_code=NULL, scheduled_at=NULL, scheduled_kind=NULL, scheduled_link=NULL WHERE id=?', [sub.id]);
      continue;
    }
    applyPlanChange(sub, plan);
    done.push({ user_id: sub.user_id, plan_code: plan.code });
  }
  return { applied: done.length, changes: done };
}

/** Cancel any mandate a fresh purchase has replaced: the double-mandate backstop. */
async function stopSupersededMandates(_userId: number, keep: string | null, prior: Array<string | null>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const sid of new Set(prior.filter((p): p is string => Boolean(p) && p !== keep))) {
    const rep = await cancelAtProvider({ provider_subscription_id: sid });
    out.push({ provider_subscription_id: sid, ok: Boolean(rep.ok) });
  }
  return out;
}

// ── the webhook ───────────────────────────────────────────────────────────────

/** Constant-time HMAC-SHA256 over the RAW body, checked before anything is parsed. */
export function verifySignature(raw: Buffer, headerSig: string | null | undefined): boolean {
  if (!headerSig) return false;
  const expected = createHmac('sha256', webhookSecret()).update(raw).digest('hex');
  const got = Buffer.from(pyStrip(headerSig), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A signature our verifier accepts — for the tests and test mode, never a bypass. */
export function signForTest(raw: Buffer): string {
  return createHmac('sha256', webhookSecret()).update(raw).digest('hex');
}

export function recordReject(ip: string | null, why: string, raw: Buffer | null): void {
  ensureTables();
  const b = raw || Buffer.alloc(0);
  db.execute('INSERT INTO webhook_rejects (at, ip, why, bytes, head) VALUES (?,?,?,?,?)', [
    db.now(),
    ip,
    why,
    b.length,
    new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 200)),
  ]);
}

/** int(x) as Python does it for the values a payload can carry; throws otherwise. */
function pyInt(x: unknown): number {
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (x instanceof PyFloat) {
    if (!Number.isFinite(x.v)) throw new Error('cannot convert float to integer');
    return Math.trunc(x.v);
  }
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new Error('cannot convert float to integer');
    return Math.trunc(x);
  }
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'string') {
    const t = pyStrip(x);
    if (!/^[+-]?\d+(_\d+)*$/.test(t)) throw new Error(`invalid literal for int() with base 10: ${pyRepr(x)}`);
    return Number(t.replace(/_/g, ''));
  }
  throw new TypeError('int() argument must be a string, a bytes-like object or a real number');
}

/** What to record as paid: zero is legitimate, negative is not (the price is the fallback). */
export function saneAmount(reported: unknown, expectedPaise: number): number {
  let value: number;
  try {
    value = pyInt(reported);
  } catch {
    return Math.trunc(expectedPaise);
  }
  return value >= 0 ? value : Math.trunc(expectedPaise);
}

function periodFor(plan: Row, start: Date): [Date, Date] {
  const days = plan.interval === 'year' ? 365 : 30;
  return [start, addSeconds(start, days * 86400)];
}

/**
 * Put the user on the plan, or extend it if they are already on it. A renewal of the
 * same mandate rolls the window forward from where it ended, so month two never hands
 * the minutes back early.
 */
export function grantPeriod(
  userId: number,
  plan: Row,
  o: { providerSubscriptionId: string | null; providerOrderId: string | null; autoRenew: boolean },
): Record<string, unknown> {
  const now = new Date();
  const existing = db.one("SELECT * FROM subscriptions WHERE user_id=? AND status='active' AND plan_code=? ORDER BY id DESC LIMIT 1", [userId, plan.code]);

  if (existing && o.providerSubscriptionId && existing.provider_subscription_id === o.providerSubscriptionId) {
    const prevEnd = parse(existing.current_period_end);
    const start = prevEnd > now ? prevEnd : now;
    const [, end] = periodFor(plan, start);
    db.execute("UPDATE subscriptions SET current_period_start=?, current_period_end=?, grace_until=?, status='active', reminded_json=NULL WHERE id=?", [
      fmt(start),
      fmt(end),
      fmt(addSeconds(end, BILLING_GRACE_DAYS * 86400)),
      existing.id,
    ]);
    return { subscription_id: existing.id, action: 'renewed', period_end: fmt(end) };
  }

  // a new purchase, or a change of plan: close whatever was active first
  db.execute("UPDATE subscriptions SET status='cancelled' WHERE user_id=? AND status='active'", [userId]);
  const [start, end] = periodFor(plan, now);
  const cur = db.execute(
    'INSERT INTO subscriptions (user_id, plan_code, provider,' +
      ' provider_subscription_id, provider_order_id, status,' +
      ' current_period_start, current_period_end, grace_until, auto_renew,' +
      " created_at) VALUES (?,?,?,?,?, 'active', ?,?,?,?,?)",
    [
      userId,
      plan.code,
      providerName(),
      o.providerSubscriptionId,
      o.providerOrderId,
      fmt(start),
      fmt(end),
      fmt(addSeconds(end, BILLING_GRACE_DAYS * 86400)),
      o.autoRenew ? 1 : 0,
      db.now(),
    ],
  );
  return { subscription_id: cur.lastrowid, action: 'started', period_end: fmt(end) };
}

/** Our own checkout session over anything in the payload: we wrote it. */
function resolvePlanAndUser(entity: Record<string, any>, sessionRow: Row | null): [Row | null, number | null, Row | null] {
  if (sessionRow) {
    const plan = db.one('SELECT * FROM plans WHERE code=?', [sessionRow.plan_code]);
    return [plan, sessionRow.user_id, sessionRow];
  }
  const notes = entity.notes || {};
  const code = notes.plan_code;
  const uid = notes.user_id;
  const plan = code ? db.one('SELECT * FROM plans WHERE code=?', [code]) : null;
  return [plan, uid ? pyInt(uid) : null, null];
}

/** Python's `or {}` for a nested payload object. */
function dictOf(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PyFloat) ? (v as Record<string, any>) : {};
}

/**
 * Apply one verified Razorpay event. Safe to call twice with the same event_id. A one-off
 * order lands as payment.captured, a mandate as subscription.charged.
 */
export function handleEvent(event: Record<string, any>, eventId: string): Record<string, any> {
  ensureTables();
  const etype = pyStr(event.event || '');
  const payload = dictOf(event.payload);
  const pay = dictOf(dictOf(payload.payment).entity);
  const sub = dictOf(dictOf(payload.subscription).entity);

  if (!['payment.captured', 'subscription.charged', 'payment.failed', 'refund.processed'].includes(etype)) {
    return { ignored: etype || '(no event type)' };
  }

  if (etype === 'payment.failed') {
    const oid = pay.order_id ?? null;
    if (truthy(oid)) db.execute("UPDATE checkout_sessions SET status='failed', completed_at=? WHERE provider_order_id=?", [db.now(), oid]);
    return { recorded: 'payment.failed', order_id: oid };
  }

  if (etype === 'refund.processed') {
    // a refund is a compensating payments row, never an edit of the original
    const pid = pay.id || '';
    const orig = db.one('SELECT * FROM payments WHERE provider_payment_id=?', [pid]);
    if (!orig) return { ignored: 'refund for a payment we never recorded' };
    const rid = `${pyStr(pid)}:refund`;
    if (db.one('SELECT 1 FROM payments WHERE provider_payment_id=?', [rid])) return { idempotent: true, already: 'refund recorded' };
    db.execute(
      "INSERT INTO payments (user_id, provider_payment_id, amount_paise, currency, method, status, at, plan_code, provider_order_id) VALUES (?,?,?,?,?, 'refunded', ?,?,?)",
      [orig.user_id, rid, -Math.abs(Math.trunc(Number(orig.amount_paise))), orig.currency, orig.method, db.now(), orig.plan_code, orig.provider_order_id],
    );
    return { refund_recorded: rid };
  }

  const paymentId = pay.id || `${eventId}:nopayment`;
  // THE idempotency point: a replayed webhook finds the row already there
  if (db.one('SELECT 1 FROM payments WHERE provider_payment_id=?', [paymentId])) {
    return { idempotent: true, already: 'payment recorded', provider_payment_id: paymentId };
  }

  const orderId = pay.order_id ?? null;
  const subId = sub.id || pay.subscription_id || null;
  let sessionRow: Row | null = null;
  if (truthy(orderId)) sessionRow = db.one('SELECT * FROM checkout_sessions WHERE provider_order_id=?', [orderId]);
  if (sessionRow === null && truthy(subId)) sessionRow = db.one('SELECT * FROM checkout_sessions WHERE provider_subscription_id=?', [subId]);

  // notes can arrive on either entity
  const hints = { notes: { ...dictOf(sub.notes), ...dictOf(pay.notes) } };

  // a pack of extra minutes, before the plan machinery
  const topup = resolveTopup(hints.notes, orderId);
  if (topup) {
    return applyTopupPayment(topup, {
      paymentId,
      amount: saneAmount(pay.amount, topup[0].price_paise),
      currency: pay.currency || 'INR',
      method: pay.method ?? null,
      orderId,
    });
  }

  const [plan, userId, sessionRow2] = resolvePlanAndUser(hints, sessionRow);
  if (!plan || !userId) return { error: 'could not tell which user or plan this payment is for', order_id: orderId, subscription_id: subId };

  const amount = saneAmount(pay.amount, plan.price_paise);
  db.execute(
    "INSERT INTO payments (user_id, provider_payment_id, amount_paise, currency, method, status, at, plan_code, provider_order_id, provider_subscription_id) VALUES (?,?,?,?,?, 'captured', ?,?,?,?)",
    [userId, paymentId, amount, pay.currency || 'INR', pay.method ?? null, db.now(), plan.code, orderId, subId],
  );

  const isMandate = etype === 'subscription.charged';
  const out = grantPeriod(userId, plan, { providerSubscriptionId: isMandate ? subId : null, providerOrderId: orderId, autoRenew: isMandate });
  if (sessionRow2) db.execute("UPDATE checkout_sessions SET status='paid', completed_at=? WHERE id=?", [db.now(), sessionRow2.id]);
  Object.assign(out, { user_id: userId, plan_code: plan.code, provider_payment_id: paymentId, amount_paise: amount, auto_renew: isMandate });
  return out;
}

/** handle_event finished but did not apply the payment: the transaction must roll back. */
class Unapplied extends Error {
  override name = '_Unapplied';
  constructor(readonly result: Record<string, any>) {
    super(pyStr(result.error || result));
  }
}

export interface IngestResult {
  ok: boolean;
  status: number;
  detail?: string;
  duplicate?: boolean;
  event_id?: string;
  result?: unknown;
}

/** json.dumps(result, ensure_ascii=False)[:4000] */
function resultText(result: unknown): string {
  return pySlice(pyDumps(result, { ensureAscii: false }), 4000);
}

function decodeUtf8Strict(raw: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
}

/**
 * The whole Razorpay webhook path: verify, then apply exactly once, atomically. The
 * idempotency row and the work commit together or not at all, and nothing that was not
 * applied answers 200 — so the provider retries instead of the payment being lost.
 */
export function ingest(raw: Buffer, headerSig: string | null, ip: string | null): IngestResult {
  ensureTables();
  if (!verifySignature(raw, headerSig)) {
    recordReject(ip, 'bad or missing signature', raw);
    return { ok: false, status: 400, detail: 'signature check failed' };
  }
  let event: Record<string, any>;
  try {
    event = pyLoads(decodeUtf8Strict(raw)) as Record<string, any>;
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('not an object');
  } catch {
    recordReject(ip, 'signature valid but body was not JSON', raw);
    return { ok: false, status: 400, detail: 'body was not JSON' };
  }
  // Razorpay sends an event id; a hash of the body is the fallback
  const eventId = pyStr(event.id || '') || 'sha:' + sha256Hex(raw).slice(0, 32);

  const seen = db.one('SELECT * FROM webhook_events WHERE event_id=?', [eventId]);
  if (seen) return { ok: true, status: 200, duplicate: true, event_id: eventId, result: seen.result };

  let applied: Record<string, any> = {};
  try {
    db.transaction(() => {
      db.execute('INSERT INTO webhook_events (provider, event_id, event_type, at, signature_ok, handled, payload) VALUES (?,?,?,?,1,0,?)', [
        providerName(),
        eventId,
        event.event ?? null,
        db.now(),
        new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(0, 200000)),
      ]);
      const result = handleEvent(event, eventId);
      // a soft error is still a failure to apply; `ignored` and `idempotent` are not
      if (result && result.error) throw new Unapplied(result);
      db.execute('UPDATE webhook_events SET handled=1, result=? WHERE event_id=?', [resultText(result), eventId]);
      applied = result;
    });
  } catch (e) {
    if (e instanceof Unapplied) {
      // recorded AFTER the rollback, so the audit trail survives
      recordReject(ip, `not applied: ${pySlice(e.message, 160)}`, raw);
      // 503: retrying can genuinely succeed (the webhook overtook its own session write)
      return { ok: false, status: 503, detail: 'event could not be applied yet; please retry', event_id: eventId, result: e.result };
    }
    recordReject(ip, pySlice(`handler raised: ${errText(e)}`, 200), raw);
    return { ok: false, status: 500, detail: 'internal error applying the event; please retry', event_id: eventId };
  }
  return { ok: true, status: 200, event_id: eventId, result: applied };
}

// ── the Dodo webhook ──────────────────────────────────────────────────────────
// A separate path from Razorpay's: three headers, base64, a signed message that includes
// an id and a timestamp, and different event names. What is shared is everything after
// "this message is genuine and we have not seen it".

/** Standard Webhooks verification. Returns [ok, why-not]. The timestamp window bounds replay. */
export function verifyDodoSignature(raw: Buffer, webhookId: string | null, timestamp: string | null, signature: string | null): [boolean, string] {
  if (!signature) return [false, 'no webhook-signature header'];
  if (!webhookId) return [false, 'no webhook-id header'];
  if (!timestamp) return [false, 'no webhook-timestamp header'];
  let sent: number;
  try {
    sent = pyInt(pyStrip(String(timestamp)));
  } catch {
    return [false, 'webhook-timestamp was not a unix time'];
  }
  const drift = Math.abs(Math.floor(Date.now() / 1000) - sent);
  if (drift > DODO_WEBHOOK_TOLERANCE_S) return [false, `webhook-timestamp is ${drift}s out of step`];

  const signed = Buffer.concat([Buffer.from(`${webhookId}.${sent}.`, 'utf8'), raw]);
  // one or more space-separated signatures, each tagged with its version (key rotation)
  const offered = String(signature)
    .split(/\s+/)
    .map((s) => pyStrip(s))
    .filter(Boolean);
  for (const key of dodoSecretKeys()) {
    const expected = Buffer.from(createHmac('sha256', key).update(signed).digest('base64'), 'utf8');
    for (const one of offered) {
      const candidate = Buffer.from(one.includes(',') ? one.slice(one.indexOf(',') + 1) : one, 'utf8');
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return [true, ''];
    }
  }
  return [false, 'signature did not match'];
}

/** A signature our own verifier accepts (first candidate key), so tests drive the real path. */
export function signDodoForTest(raw: Buffer, webhookId: string, timestamp: number): string {
  const signed = Buffer.concat([Buffer.from(`${webhookId}.${Math.trunc(timestamp)}.`, 'utf8'), raw]);
  return 'v1,' + createHmac('sha256', dodoSecretKeys()[0]).update(signed).digest('base64');
}

/** What was charged, in minor units, and in which currency — `currency`, never settlement's. */
function dodoAmount(entity: Record<string, any>, plan: Record<string, any>): [number, string] {
  const cur = pyStr(entity.currency || 'INR').toUpperCase() || 'INR';
  const reported = entity.total_amount;
  if (cur === 'INR' && reported !== null && reported !== undefined) return [saneAmount(reported, Number(plan.price_paise)), 'INR'];
  return [Math.trunc(Number(plan.price_paise)), cur];
}

/**
 * Which account and plan a Dodo payment belongs to, in order of trust: our checkout
 * session (by session id, then subscription id), OUR subscription row (renewals a year
 * later), then the metadata we set at checkout.
 */
function resolveDodo(entity: Record<string, any>, sessionId: string | null, subscriptionId: string | null): [Row | null, number | null, Row | null] {
  let sessionRow: Row | null = null;
  if (sessionId) sessionRow = db.one('SELECT * FROM checkout_sessions WHERE provider_order_id=?', [sessionId]);
  if (sessionRow === null && subscriptionId) sessionRow = db.one('SELECT * FROM checkout_sessions WHERE provider_subscription_id=?', [subscriptionId]);
  if (sessionRow !== null) {
    const plan = db.one('SELECT * FROM plans WHERE code=?', [sessionRow.plan_code]);
    return [plan, sessionRow.user_id, sessionRow];
  }
  if (subscriptionId) {
    const sub = db.one('SELECT * FROM subscriptions WHERE provider_subscription_id=? ORDER BY id DESC LIMIT 1', [subscriptionId]);
    if (sub) {
      const plan = db.one('SELECT * FROM plans WHERE code=?', [sub.plan_code]);
      return [plan, sub.user_id, null];
    }
  }
  const meta = dictOf(entity.metadata);
  const code = meta.plan_code;
  const uid = meta.user_id;
  const plan = truthy(code) ? db.one('SELECT * FROM plans WHERE code=?', [code]) : null;
  let uidI: number | null = null;
  try {
    uidI = truthy(uid) ? pyInt(uid) : null;
  } catch {
    uidI = null;
  }
  return [plan, uidI, null];
}

type Topup = [TopupPack, number, Row | null];

/**
 * Is this payment for a pack of minutes? Our own row first (mode='topup'), their
 * metadata second; null rather than guessing when either disagrees with reality.
 */
function resolveTopup(meta: Record<string, any>, sessionId: string | null): Topup | null {
  let row: Row | null = null;
  if (sessionId) row = db.one("SELECT * FROM checkout_sessions WHERE provider_order_id=? AND mode='topup' ORDER BY rowid DESC LIMIT 1", [sessionId]);
  const m = meta || {};
  if (!row) {
    const ourSid = m.checkout_session;
    if (truthy(ourSid)) row = db.one("SELECT * FROM checkout_sessions WHERE id=? AND mode='topup'", [ourSid]);
  }
  if (row) {
    const pack = topupPack(row.plan_code);
    // a top-up session whose pack no longer exists: refuse, never fall through to plans
    return pack ? [pack, Math.trunc(Number(row.user_id)), row] : null;
  }
  if (pyStrip(pyStr(m.purchase || '')) !== 'topup') return null;
  const pack = topupPack(pyStr(m.topup_code || m.plan_code || ''));
  if (!pack) return null;
  let uid: number;
  try {
    uid = pyInt(m.user_id || 0);
  } catch {
    return null;
  }
  if (!uid || !db.one('SELECT 1 FROM users WHERE id=?', [uid])) return null;
  return [pack, uid, null];
}

/** Record the money and add the minutes. One implementation for both providers. */
function applyTopupPayment(
  topup: Topup,
  o: { paymentId: string; amount: number; currency: string; method: string | null; orderId: string | null },
): Record<string, any> {
  const [pack, uid, sessionRow] = topup;
  db.execute(
    "INSERT INTO payments (user_id, provider_payment_id, amount_paise, currency, method, status, at, plan_code, provider_order_id, provider_subscription_id) VALUES (?,?,?,?,?, 'captured', ?,?,?,NULL)",
    [uid, o.paymentId, o.amount, o.currency, o.method, db.now(), pack.code, o.orderId],
  );
  const out = grantTopup(uid, pack, o.paymentId);
  if (sessionRow) db.execute("UPDATE checkout_sessions SET status='paid', completed_at=? WHERE id=? AND status!='paid'", [db.now(), sessionRow.id]);
  Object.assign(out, {
    user_id: uid,
    topup_code: pack.code,
    plan_code: pack.code,
    provider_payment_id: o.paymentId,
    amount_paise: o.amount,
    currency: o.currency,
    auto_renew: false,
  });
  return out;
}

// ── chargebacks ───────────────────────────────────────────────────────────────
// The three outcomes are not the seven events: only some stages mean money has moved.
const DISPUTE_MONEY_GONE = new Set(['dispute.lost', 'dispute.accepted']);
const DISPUTE_MONEY_KEPT = new Set(['dispute.won', 'dispute.cancelled']);
// `expired` "typically" resolves against us — typically is no basis for taking minutes
const DISPUTE_IN_FLIGHT = new Set(['dispute.opened', 'dispute.challenged', 'dispute.expired']);
const DISPUTE_EVENTS = new Set([...DISPUTE_MONEY_GONE, ...DISPUTE_MONEY_KEPT, ...DISPUTE_IN_FLIGHT]);

/** The disputed amount in paise: our own recorded figure first (theirs is an ambiguous string). */
function disputePaise(data: Record<string, any>, orig: Row | null): number {
  if (orig !== null) {
    try {
      return Math.abs(pyInt(orig.amount_paise));
    } catch {
      /* fall through */
    }
  }
  const raw = pyStrip(pyStr(data.amount || ''));
  if (!raw) return 0;
  try {
    if (raw.includes('.')) {
      const f = Number(raw);
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(f)) throw new Error('bad float');
      return Math.abs(Math.trunc(pyRound(f * 100)));
    }
    return Math.abs(pyInt(raw));
  } catch {
    return 0;
  }
}

/** Work that has to wait until the transaction has committed (a call to the provider). */
type Deferred = () => Promise<void>;

/**
 * Record one stage of a chargeback, and act only when the money has actually moved.
 * Opened: stop further buying, nothing else. Money gone: a compensating payment row, the
 * purchased minutes taken back, the mandate stopped. Money kept: buying restored.
 * Idempotent on the dispute id.
 */
function applyDispute(etype: string, data: Record<string, any>, deferred: Deferred[]): Record<string, any> {
  ensureTables();
  const did = pyStr(data.dispute_id || '');
  if (!did) return { error: 'dispute event carried no dispute_id', type: etype };

  const pid = pyStr(data.payment_id || '');
  const orig = pid ? db.one("SELECT * FROM payments WHERE provider_payment_id=? AND status='captured'", [pid]) : null;
  const amount = disputePaise(data, orig);
  const uid = orig !== null ? Math.trunc(Number(orig.user_id)) : null;
  const planCode = orig !== null ? orig.plan_code : null;
  const st = pyStr(data.dispute_status || etype.slice(etype.indexOf('.') + 1));
  const stage = pyStr(data.dispute_stage || '');
  const rdr = truthy(data.is_resolved_by_rdr) ? 1 : 0;
  const now = db.now();
  const outcome = DISPUTE_MONEY_GONE.has(etype) ? 'lost' : DISPUTE_MONEY_KEPT.has(etype) ? 'kept' : null;

  const existing = db.one('SELECT * FROM payment_disputes WHERE dispute_id=?', [did]);
  if (existing === null) {
    db.execute(
      'INSERT INTO payment_disputes (dispute_id, provider_payment_id, user_id, amount_paise, currency, status, stage, resolved_by_rdr, plan_code, opened_at, settled_at, outcome, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [did, pid || null, uid, amount, pyStr(data.currency || 'INR'), st, stage || null, rdr, planCode, data.created_at || now, outcome ? now : null, outcome, now],
    );
  } else {
    // outcome and settled_at are written once: a late retry must not reopen a settled dispute
    db.execute(
      'UPDATE payment_disputes SET status=?, stage=?, resolved_by_rdr=?, outcome=COALESCE(outcome, ?), settled_at=COALESCE(settled_at, ?), updated_at=? WHERE dispute_id=?',
      [st, stage || null, rdr, outcome, outcome ? now : null, now, did],
    );
  }

  const out: Record<string, any> = { dispute: did, status: st, stage: stage || null, payment_id: pid || null, user_id: uid, amount_paise: amount, outcome };
  if (orig === null) {
    out.note = 'no captured payment of ours matches this dispute';
    return out;
  }

  // stop the money, at every stage of an open dispute
  if (DISPUTE_IN_FLIGHT.has(etype) || DISPUTE_MONEY_GONE.has(etype)) {
    db.execute('UPDATE users SET can_purchase=0 WHERE id=?', [uid]);
    out.purchases_blocked = true;
  }
  if (DISPUTE_MONEY_KEPT.has(etype)) {
    db.execute('UPDATE users SET can_purchase=1 WHERE id=?', [uid]);
    out.purchases_restored = true;
    return out;
  }
  if (!DISPUTE_MONEY_GONE.has(etype)) return out;

  // ── the funds are gone ───────────────────────────────────────────────────
  const rid = `${did}:chargeback`;
  if (db.one('SELECT 1 FROM payments WHERE provider_payment_id=?', [rid])) {
    out.idempotent = 'this chargeback was already applied';
    return out;
  }
  db.execute(
    "INSERT INTO payments (user_id, provider_payment_id, amount_paise, currency, method, status, at, plan_code, provider_order_id, provider_subscription_id) VALUES (?,?,?,?,?, 'disputed', ?,?,?,?)",
    [uid, rid, -Math.abs(amount), orig.currency, orig.method, now, orig.plan_code, orig.provider_order_id, orig.provider_subscription_id],
  );
  out.chargeback_recorded = rid;

  const pack = topupPack(pyStr(orig.plan_code || ''));
  if (pack) {
    // A compensating ledger charge against the top-up half — NOT voided_at on the pack,
    // which would move the write-off boundary for every pack and raise the balance.
    db.execute("INSERT INTO usage_ledger (user_id, job_id, minutes_charged, kind, note, at, topup_minutes) VALUES (?,NULL,?,'dispute',?,?,?)", [
      uid,
      new PyFloat(pack.minutes),
      `chargeback ${did} on ${pack.code}`,
      now,
      new PyFloat(pack.minutes),
    ]);
    out.minutes_clawed_back = new PyFloat(pack.minutes);
  } else {
    // A plan: the period is no longer paid for, so it ends now and the mandate stops.
    const sub = db.one("SELECT * FROM subscriptions WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1", [uid]);
    if (sub !== null) {
      db.execute("UPDATE subscriptions SET status='cancelled', auto_renew=0, cancel_at=? WHERE id=?", [now, sub.id]);
      out.subscription_cancelled = sub.id;
      // the provider call cannot run inside the transaction; it runs right after commit
      deferred.push(async () => {
        const stopped = await cancelAtProvider(sub);
        if (!stopped.ok) out.needs_operator = true;
      });
      const wroteOff = db.voidTopups(uid!, `chargeback ${did} on ${sub.plan_code}`);
      if (wroteOff) out.topup_minutes_written_off = new PyFloat(wroteOff);
    }
  }
  return out;
}

// Everything Dodo can send that we act on. Anything else is recorded as ignored.
const DODO_HANDLED = new Set([
  'payment.succeeded', 'payment.failed', 'refund.succeeded',
  'subscription.active', 'subscription.renewed', 'subscription.on_hold',
  'subscription.cancelled', 'subscription.expired', 'subscription.failed',
  'subscription.plan_changed',
  ...DISPUTE_EVENTS,
]);

/**
 * Apply one verified Dodo event. Safe to call twice with the same event id.
 *
 * Quota is granted by `payment.succeeded` AND BY NOTHING ELSE: it is the only event with
 * a real payment id, so the only one that can be made idempotent. The subscription events
 * keep our record of the mandate in step. Calls to the provider are pushed onto
 * `deferred` and made after the transaction commits.
 */
export function handleDodoEvent(event: Record<string, any>, _eventId: string, deferred: Deferred[] = []): Record<string, any> {
  ensureTables();
  const etype = pyStr(event.type || '');
  const data = dictOf(event.data);
  if (!DODO_HANDLED.has(etype)) return { ignored: etype || '(no event type)' };

  const subId: string | null = data.subscription_id || null;
  const sessionId: string | null = data.checkout_session_id || null;

  // ── the mandate's own lifecycle ───────────────────────────────────────────
  if (etype === 'subscription.active') {
    // the mandate exists now: write its id onto the rows a renewal will need
    if (subId) {
      if (sessionId) {
        db.execute('UPDATE checkout_sessions SET provider_subscription_id=? WHERE provider_order_id=? AND provider_subscription_id IS NULL', [subId, sessionId]);
      }
      const meta = dictOf(data.metadata);
      const ourSid = meta.checkout_session;
      if (truthy(ourSid)) {
        db.execute('UPDATE checkout_sessions SET provider_subscription_id=? WHERE id=? AND provider_subscription_id IS NULL', [subId, ourSid]);
        const row = db.one('SELECT user_id FROM checkout_sessions WHERE id=?', [ourSid]);
        if (row) {
          db.execute("UPDATE subscriptions SET provider_subscription_id=?, auto_renew=1 WHERE user_id=? AND status='active' AND provider_subscription_id IS NULL", [
            subId,
            row.user_id,
          ]);
        }
      }
    }
    return { recorded: etype, subscription_id: subId };
  }

  if (etype === 'subscription.cancelled' || etype === 'subscription.on_hold') {
    // access is NOT taken away here: only renewal stops (and the reminders start)
    if (subId) {
      for (const r of db.query("SELECT id, current_period_end FROM subscriptions WHERE provider_subscription_id=? AND status='active'", [subId])) {
        db.execute('UPDATE subscriptions SET auto_renew=0, cancel_at=?, reminded_json=NULL WHERE id=?', [r.current_period_end, r.id]);
      }
    }
    return { recorded: etype, subscription_id: subId, auto_renew: false };
  }

  if (etype === 'subscription.plan_changed') {
    // a reconciler, not a second way to grant: the provider only moves the product once paid
    const code = planCodeForProduct(pyStr(data.product_id || ''));
    if (!code || !subId) return { recorded: etype, subscription_id: subId, note: 'no plan of ours matches that product' };
    const row = db.one("SELECT * FROM subscriptions WHERE provider_subscription_id=? AND status='active' ORDER BY id DESC LIMIT 1", [subId]);
    if (!row) return { recorded: etype, subscription_id: subId, note: 'no active subscription of ours on that mandate' };
    if (row.plan_code === code) {
      // already in step; a stale marker would refuse every further change
      if (row.scheduled_plan_code) {
        db.execute('UPDATE subscriptions SET scheduled_plan_code=NULL, scheduled_at=NULL, scheduled_kind=NULL, scheduled_link=NULL WHERE id=?', [row.id]);
      }
      return { recorded: etype, subscription_id: subId, plan_code: code, already: 'in step' };
    }
    const plan = db.one('SELECT * FROM plans WHERE code=?', [code]);
    if (!plan) return { recorded: etype, subscription_id: subId, note: 'that product maps to a plan we no longer sell' };
    applyPlanChange(row, plan);
    return { recorded: etype, subscription_id: subId, action: 'reconciled', from_plan: row.plan_code, plan_code: code };
  }

  if (etype === 'subscription.expired') {
    // their side says it is over; ours still honours the grace window
    if (subId) db.execute("UPDATE subscriptions SET auto_renew=0 WHERE provider_subscription_id=? AND status='active'", [subId]);
    return { recorded: etype, subscription_id: subId };
  }

  if (etype === 'subscription.renewed') {
    // recorded, deliberately NOT acted on: no payment id, settlement currency, and also
    // sent at activation — acting on it once granted two months for one payment
    return { recorded: etype, subscription_id: subId, note: 'renewals are granted by payment.succeeded, not by this' };
  }

  if (etype === 'subscription.failed') {
    const ourSid = dictOf(data.metadata).checkout_session;
    if (truthy(ourSid)) db.execute("UPDATE checkout_sessions SET status='failed', completed_at=? WHERE id=?", [db.now(), ourSid]);
    return { recorded: etype, subscription_id: subId };
  }

  // ── a payment that did not go through ─────────────────────────────────────
  if (etype === 'payment.failed') {
    // only a LEGACY immediate upgrade is dropped; a queued change must survive
    if (subId) {
      db.execute(
        "UPDATE subscriptions SET scheduled_plan_code=NULL, scheduled_at=NULL, scheduled_kind=NULL, scheduled_link=NULL WHERE provider_subscription_id=? AND status='active' AND scheduled_link IS NOT NULL",
        [subId],
      );
    }
    const ourSid = dictOf(data.metadata).checkout_session;
    // the reason is kept, so the dashboard can say what to do next
    const code = pySlice(pyStr(data.error_code || ''), 64) || null;
    const msg = pySlice(pyStr(data.error_message || ''), 300) || null;
    if (sessionId) {
      db.execute("UPDATE checkout_sessions SET status='failed', completed_at=?, failure_code=?, failure_message=? WHERE provider_order_id=?", [db.now(), code, msg, sessionId]);
    } else if (truthy(ourSid)) {
      db.execute("UPDATE checkout_sessions SET status='failed', completed_at=?, failure_code=?, failure_message=? WHERE id=?", [db.now(), code, msg, ourSid]);
    }
    return { recorded: 'payment.failed', checkout_session_id: sessionId, error_code: code };
  }

  // ── a refund ──────────────────────────────────────────────────────────────
  if (etype === 'refund.succeeded') {
    const pid = pyStr(data.payment_id || '');
    const orig = db.one('SELECT * FROM payments WHERE provider_payment_id=?', [pid]);
    if (!orig) return { ignored: 'refund for a payment we never recorded', payment_id: pid };
    const rid = pyStr(data.refund_id || `${pid}:refund`);
    if (db.one('SELECT 1 FROM payments WHERE provider_payment_id=?', [rid])) return { idempotent: true, already: 'refund recorded' };
    const amt = data.amount;
    let back: number;
    try {
      back = amt !== null && amt !== undefined ? Math.abs(pyInt(amt)) : Math.abs(Math.trunc(Number(orig.amount_paise)));
    } catch {
      back = Math.abs(Math.trunc(Number(orig.amount_paise)));
    }
    db.execute(
      "INSERT INTO payments (user_id, provider_payment_id, amount_paise, currency, method, status, at, plan_code, provider_order_id, provider_subscription_id) VALUES (?,?,?,?,?, 'refunded', ?,?,?,?)",
      [orig.user_id, rid, -back, orig.currency, orig.method, db.now(), orig.plan_code, orig.provider_order_id, orig.provider_subscription_id],
    );
    return { refund_recorded: rid, amount_paise: -back };
  }

  // ── a chargeback ─────────────────────────────────────────────────────────
  if (etype.startsWith('dispute.')) return applyDispute(etype, data, deferred);

  // ── the one event that grants anything ───────────────────────────────────
  // Asserted, not assumed: a future addition that forgets its branch is inert.
  if (etype !== 'payment.succeeded') return { ignored: etype, why: 'only payment.succeeded may grant a period' };

  const paymentId = pyStr(data.payment_id || '');
  if (!paymentId) return { error: 'payment.succeeded carried no payment_id', checkout_session_id: sessionId, subscription_id: subId };
  if (db.one('SELECT 1 FROM payments WHERE provider_payment_id=?', [paymentId])) {
    return { idempotent: true, already: 'payment recorded', provider_payment_id: paymentId };
  }

  // a pack of extra minutes: returned before the plan machinery is touched
  const topup = resolveTopup(dictOf(data.metadata), sessionId);
  if (topup) {
    const [amount, currency] = dodoAmount(data, topup[0]);
    return applyTopupPayment(topup, { paymentId, amount, currency, method: data.payment_method || data.payment_method_type || null, orderId: sessionId });
  }

  // does this payment settle a plan change? BEFORE the plan is resolved
  const settled = subId ? settlePlanChange(subId) : null;

  const [plan, userId, sessionRow] = resolveDodo(data, sessionId, subId);
  if (!plan || !userId) return { error: 'could not tell which user or plan this payment is for', checkout_session_id: sessionId, subscription_id: subId };

  const [amount, currency] = dodoAmount(data, plan);
  const isMandate = Boolean(subId) && plan.interval === 'month';
  db.execute(
    "INSERT INTO payments (user_id, provider_payment_id, amount_paise, currency, method, status, at, plan_code, provider_order_id, provider_subscription_id) VALUES (?,?,?,?,?, 'captured', ?,?,?,?)",
    [userId, paymentId, amount, currency, data.payment_method || data.payment_method_type || null, db.now(), plan.code, sessionId, subId],
  );

  if (settled && settled[2]) {
    // a legacy immediate upgrade must not extend the period
    const row = db.one("SELECT id, current_period_end FROM subscriptions WHERE provider_subscription_id=? AND status='active' ORDER BY id DESC LIMIT 1", [subId]);
    if (sessionRow) db.execute("UPDATE checkout_sessions SET status='paid', completed_at=? WHERE id=? AND status!='paid'", [db.now(), sessionRow.id]);
    return {
      subscription_id: row ? row.id : null,
      action: 'upgraded',
      user_id: userId,
      plan_code: plan.code,
      period_end: row ? row.current_period_end : null,
      provider_payment_id: paymentId,
      amount_paise: amount,
      currency,
      auto_renew: true,
    };
  }

  // which mandates this purchase replaces, read before the grant closes their rows
  const prior = db
    .query("SELECT provider_subscription_id FROM subscriptions WHERE user_id=? AND status='active' AND provider_subscription_id IS NOT NULL", [userId])
    .map((r) => r.provider_subscription_id as string);

  const out = grantPeriod(userId, plan, { providerSubscriptionId: isMandate ? subId : null, providerOrderId: sessionId, autoRenew: isMandate });

  if (out.action === 'started') {
    const candidates = [...new Set(prior.filter((p) => p && p !== subId))];
    if (candidates.length) {
      // stopping the old mandates is a provider call: after commit, reported on the result
      out.superseded_mandates = candidates.map((sid) => ({ provider_subscription_id: sid, ok: true }));
      deferred.push(async () => {
        out.superseded_mandates = await stopSupersededMandates(userId, subId, prior);
      });
    }
  }

  if (sessionRow) {
    db.execute("UPDATE checkout_sessions SET status='paid', completed_at=?, provider_subscription_id=COALESCE(provider_subscription_id, ?) WHERE id=?", [
      db.now(),
      subId,
      sessionRow.id,
    ]);
  }
  Object.assign(out, { user_id: userId, plan_code: plan.code, provider_payment_id: paymentId, amount_paise: amount, currency, auto_renew: isMandate });
  return out;
}

/** A header's first value, whichever way it was passed in. */
function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

/**
 * The whole Dodo webhook path: verify, then apply exactly once, atomically, under the
 * same two rules as Razorpay's. The event id comes from the signed `webhook-id` header.
 */
export async function ingestDodo(raw: Buffer, headers: Record<string, string | string[] | undefined>, ip: string | null): Promise<IngestResult> {
  ensureTables();
  const wid = headerOf(headers, 'webhook-id');
  const wts = headerOf(headers, 'webhook-timestamp');
  const wsig = headerOf(headers, 'webhook-signature');

  const [ok, why] = verifyDodoSignature(raw, wid, wts, wsig);
  if (!ok) {
    recordReject(ip, why, raw);
    return { ok: false, status: 400, detail: 'signature check failed' };
  }
  let event: Record<string, any>;
  try {
    event = pyLoads(decodeUtf8Strict(raw)) as Record<string, any>;
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('not an object');
  } catch {
    recordReject(ip, 'signature valid but body was not JSON', raw);
    return { ok: false, status: 400, detail: 'body was not JSON' };
  }
  const eventId = pyStr(wid || '') || 'sha:' + sha256Hex(raw).slice(0, 32);

  const seen = db.one('SELECT * FROM webhook_events WHERE event_id=?', [eventId]);
  if (seen) return { ok: true, status: 200, duplicate: true, event_id: eventId, result: seen.result };

  let applied: Record<string, any> = {};
  const deferred: Deferred[] = [];
  try {
    db.transaction(() => {
      db.execute('INSERT INTO webhook_events (provider, event_id, event_type, at, signature_ok, handled, payload) VALUES (?,?,?,?,1,0,?)', [
        providerName(),
        eventId,
        event.type ?? null,
        db.now(),
        new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(0, 200000)),
      ]);
      const result = handleDodoEvent(event, eventId, deferred);
      if (result && result.error) throw new Unapplied(result);
      db.execute('UPDATE webhook_events SET handled=1, result=? WHERE event_id=?', [resultText(result), eventId]);
      applied = result;
    });
  } catch (e) {
    if (e instanceof Unapplied) {
      recordReject(ip, `not applied: ${pySlice(e.message, 160)}`, raw);
      return { ok: false, status: 503, detail: 'event could not be applied yet; please retry', event_id: eventId, result: e.result };
    }
    recordReject(ip, pySlice(`handler raised: ${errText(e)}`, 200), raw);
    return { ok: false, status: 500, detail: 'internal error applying the event; please retry', event_id: eventId };
  }

  // The provider calls the event asked for, now that the grant itself is durable. Their
  // outcome goes onto the recorded result, so the webhook log tells the whole story.
  if (deferred.length) {
    for (const task of deferred) {
      try {
        await task();
      } catch (e) {
        recordReject(ip, pySlice(`after-commit step failed: ${errText(e)}`, 200), raw);
      }
    }
    db.execute('UPDATE webhook_events SET result=? WHERE event_id=?', [resultText(applied), eventId]);
  }
  return { ok: true, status: 200, event_id: eventId, result: applied };
}

// ── the sweep: reminders and expiry ───────────────────────────────────────────

function reminded(row: Row): Set<string> {
  try {
    const v = pyLoads(row.reminded_json || '[]');
    return new Set((Array.isArray(v) ? v : []).map((x) => pyStr(x)));
  } catch {
    return new Set();
  }
}

/**
 * Email annual customers before their access lapses (14, 3 and 0 days). Nothing charges
 * them when the year ends, so these are the only thing between a customer and a lapse.
 */
export async function sendDueReminders(): Promise<Record<string, unknown>> {
  ensureTables();
  const now = new Date();
  const sent: Array<Record<string, unknown>> = [];
  const rows = db.query("SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.code=s.plan_code WHERE s.status='active' AND s.auto_renew=0");
  for (const s of rows) {
    let end: Date;
    try {
      end = parse(s.current_period_end);
    } catch {
      continue;
    }
    const daysLeft = (end.getTime() - now.getTime()) / 1000 / 86400.0;
    const already = reminded(s);
    for (const mark of RENEWAL_REMINDER_DAYS) {
      if (already.has(String(mark))) continue;
      // fire once the window is reached, so a process that was asleep skips nothing
      if (daysLeft <= mark) {
        const u = db.one('SELECT email FROM users WHERE id=?', [s.user_id]);
        if (u) await notify.renewalReminder(u.email, s.user_id, Math.max(0, Math.trunc(pyRound(daysLeft))), s.plan_name, s.current_period_end, PUBLIC_BASE_URL);
        already.add(String(mark));
        sent.push({ user_id: s.user_id, at_days: mark, days_left: new PyFloat(pyRound(daysLeft, 2)) });
        break; // one message per sweep per subscription
      }
    }
    const before = reminded(s);
    const same = before.size === already.size && [...already].every((x) => before.has(x));
    if (!same) {
      const sorted = [...already].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      db.execute('UPDATE subscriptions SET reminded_json=? WHERE id=?', [pyDumps(sorted), s.id]);
    }
  }
  return { sent };
}

/** Drop to free once the grace period has passed, and not a moment before. */
export function expireLapsed(): Record<string, unknown> {
  ensureTables();
  const nowS = db.now();
  const rows = db.query("SELECT id, user_id, plan_code FROM subscriptions WHERE status='active' AND COALESCE(grace_until, current_period_end) < ?", [nowS]);
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    db.execute("UPDATE subscriptions SET status='expired' WHERE id=?", [r.id]);
    // top-up minutes do not survive the plan they were bought for — and the write-off
    // is RECORDED, so "where did my minutes go" has an answer
    const row: Record<string, unknown> = { ...r };
    row.topup_minutes_voided = new PyFloat(db.voidTopups(r.user_id, `subscription ${r.plan_code} lapsed`));
    out.push(row);
  }
  return { expired: out };
}

export async function sweep(): Promise<Record<string, unknown>> {
  return { reminders: await sendDueReminders(), expiries: expireLapsed(), plan_changes: applyDuePlanChanges() };
}
