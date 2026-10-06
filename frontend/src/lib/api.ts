/**
 * The only module that talks to the backend.
 *
 * Types here were captured from real responses (backend/_api_shapes.json), not
 * from the OpenAPI document — the backend declares no response models, so the
 * spec says nothing about what comes back. Anything marked optional is optional
 * because a live response actually omitted or nulled it.
 *
 * Two backend behaviours the client has to respect:
 *
 *  1. Auth is a session COOKIE plus an `X-CSRF-Token` header on every mutating
 *     request. The token arrives from /api/auth/register and /api/auth/me. A
 *     mutation without it is refused with 403, deliberately.
 *  2. Errors are NOT one shape. FastAPI validation failures return
 *     `detail: [{loc, msg, ...}]` while everything else returns `detail: string`.
 *     `ApiError.message` normalises both, so callers never have to branch.
 */

export type Role = 'user' | 'admin';

/**
 * What plan this account is on. Every account has one, including admins — an
 * admin bypasses quota checks server-side but still reports the plan they hold,
 * so somebody who bought Pro can see Pro.
 */
export interface Entitlement {
  plan_code: string;
  plan_name: string;
  is_free: boolean;
  minutes_allowance: number;
  minutes_used: number;
  /**
   * WHAT THEY CAN ACTUALLY SPEND: the plan's remaining minutes plus any bought on top.
   *
   * The sum rather than the plan's own figure, because every caller — both quota gates on
   * the server and every counter in this app — is asking "can this video be dubbed", and
   * splitting that question across two fields is how one of them ends up forgetting the
   * second. The halves are below for the places that need to explain the number.
   */
  minutes_left: number;
  /** The part that comes from this month's allowance, and expires with it. */
  minutes_plan_left: number;
  /**
   * The part bought as extra minutes. Does not expire while the plan runs, is spent only
   * after the plan's own minutes are gone, and is written off if the plan lapses. Zero for
   * a free account and for anyone who has never bought a pack.
   */
  minutes_topup_left: number;
  max_video_seconds: number;
  retention_days: number;
  period_end: string | null;
  auto_renew: boolean;
}

export interface Me {
  id: number;
  email: string;
  role: Role;
  csrf: string;
  /**
   * Whether the address has been confirmed.
   *
   * Signing in now REQUIRES this, so for a session that exists it is effectively
   * always true. It stays on the payload because the operator's first account is
   * stamped confirmed at creation without any email, and because a banner that has to
   * explain a refusal is better off reading the fact than inferring it.
   */
  email_verified: boolean;
  entitlement: Entitlement;
}

/**
 * What signing IN returns. A session always exists by then, so `csrf` is required.
 *
 * Split from `RegisterResult` when registering stopped issuing a session. They were one
 * type because the two responses happened to match; they no longer match, and sharing a
 * type with an optional `csrf` would have forced every caller of `login` to handle an
 * absence that cannot occur.
 */
export interface LoginResult {
  id: number;
  email: string;
  role: Role;
  csrf: string;
}

export interface RegisterResult {
  id: number;
  email: string;
  role: Role;
  /**
   * ABSENT ON THE NORMAL PATH, because registering no longer signs you in.
   *
   * A registration ends with an unconfirmed address and no session, so there is no CSRF
   * token to hand out — `verification_required` is true and the next step is the emailed
   * link. The one exception is the operator's first account on a fresh database, which
   * is confirmed on creation and does get a session.
   *
   * Optional rather than `string` so that the compiler, not a runtime `undefined`, is
   * what catches code still assuming a session comes back.
   */
  csrf?: string;
  verification_required?: boolean;
  note?: string;
}

export interface SiteStatus {
  maintenance: boolean;
  /** What the maintenance page says. Null when the site is up. */
  note: string | null;
  since: string | null;
  retry_after_s: number;
  /** The paths in the sitemap, so the verifier can assert they all serve. */
  public_pages: string[];
  /**
   * Whether "Continue with Google" should be drawn.
   *
   * Optional so an older backend still renders — and false is the safe reading, since
   * the Google endpoints answer 404 when they are not configured and a button that
   * leads to a 404 is worse than no button.
   */
  google_auth?: boolean;
  /**
   * Which build of the dashboard the server is currently serving.
   *
   * The app records whatever it sees first and compares later probes against it. A
   * change means this tab has been left behind by a deploy and is running code the
   * server has replaced — see `useBuild`.
   *
   * Optional, and null on an install that does not serve the app from disk. Absent is
   * treated as "cannot tell", never as "out of date".
   */
  build?: string | null;
}

/**
 * `/api/health`, which now answers in two shapes.
 *
 * The endpoint is unauthenticated by necessity — a load balancer has no session, and
 * the app needs it before sign-in to tell "down for maintenance" apart from "API
 * unreachable". But the full payload was an infrastructure map for anyone who curled
 * it: internal engine URL, raw engine error text, the absolute path of the R2
 * credentials file, and live job counts.
 *
 * So everything below `maintenance` is ADMIN-ONLY and therefore optional here. The
 * four fields the shell renders before sign-in are the required ones.
 */
export interface Health {
  ok: boolean;
  /**
   * Readiness, in words about the service rather than about its parts.
   *
   * Present for a signed-in customer; absent for a stranger. It replaced
   * `engine_state` ('asleep' | 'starting' | 'connected'), which was served to anyone who
   * asked and announced that a machine exists, is normally off, and is coming up now.
   */
  service_state?: 'ready' | 'starting' | 'idle' | 'demo';
  /** Admin only from here down. A customer's payload carries none of these. */
  engine_mode?: 'fake' | 'real';
  engine_reachable?: boolean;
  /** Admin only. The operational vocabulary, kept behind an admin session. */
  engine_state?: 'demo' | 'connected' | 'starting' | 'asleep';
  /** Admin only. */
  engine_url?: string;
  /** Admin only. */
  engine_info?: Record<string, unknown> | null;
  /** Present for everyone: the app renders a maintenance screen from it. */
  maintenance?: boolean;
  /** Admin only. */
  preset_version?: string;
  /** Admin only. */
  preset_sha256?: string;
  /** Admin only. */
  storage?: StorageStatus;
  /** Admin only. */
  gpu_auto?: boolean;
  /** Admin only. */
  jobs?: { queued: number; running: number; done: number; failed: number };
}

export interface StorageStatus {
  backend: 'local-disk' | 'aws-s3' | 'cloudflare-r2';
  /** Storage credentials are in place, for whichever provider (the name predates S3). */
  r2_configured: boolean;
  r2_enabled_flag: boolean;
  bucket: string | null;
  region?: string | null;
  prefix: string;
  env_file: string;
  note: string;
  local_output_dir?: string;
  jobs_on_r2?: number;
  jobs_local_only?: number;
  download_token_ttl_s?: number;
}

export type JobState =
  | 'queued'
  | 'claimed'
  | 'preparing'
  | 'transcribing'
  | 'translating'
  | 'rendering'
  | 'exporting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JobSummary {
  job_id: string;
  state: JobState;
  percent: number;
  target_lang: string;
  minutes_quoted: number | null;
  created_at: string;
  finished_at: string | null;
  error_code: string | null;
  /** Admin only. The backend omits it for a customer — see _job_view. */
  error_detail?: string | null;
  preset_version: string | null;
  preset_sha256: string | null;
  output_bytes: number | null;
  expires_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  download_count: number;
  can_download: boolean;
  can_cancel: boolean;
  origin?: string;
}

export interface Segment {
  seg_id: string;
  ordinal: number;
  start: number | null;
  end: number | null;
  speaker: string | null;
  source_text: string | null;
  translated_text: string | null;
}

export interface JobEvent {
  id?: number;
  at: string;
  state: string | null;
  percent: number | null;
  detail: string | null;
}

export interface JobDetail extends JobSummary {
  segments: Segment[];
  events: JobEvent[];
}

export interface EventsPage {
  state: JobState;
  percent: number;
  events: Required<JobEvent>[];
  last_id: number;
}

/**
 * The formats a finished dub can be handed over as.
 *
 * `video` is the file as rendered. The three audio formats are cut out of it on
 * request, for YouTube's multi-language audio feature — it attaches one track per
 * language to a single video, so the dubs share the original's URL and view count,
 * and its uploader wants an audio-only file.
 *
 * `audio` is the name the API shipped with before there was more than one; the
 * server still accepts it as an alias for `m4a`.
 */
export type DownloadFormat = 'video' | 'm4a' | 'mp3' | 'wav' | 'audio';

export interface FormatOption {
  format: Exclude<DownloadFormat, 'audio'>;
  ext: string;
  mime: string;
  kind: 'video' | 'audio';
  label: string;
  /** The trade-off, in the customer's words. Rendered under the label. */
  note: string;
  lossless: boolean;
}

export interface FormatsResponse {
  job_id: string;
  can_download: boolean;
  target_lang: string;
  formats: FormatOption[];
  default: string;
}

export interface UploadResult {
  upload_id: string;
  duration_s: number;
  minutes: number;
  bytes: number;
  entitlement: Entitlement;
  /**
   * Which road the file took. `direct` means the browser sent it straight to storage;
   * absent means it came through the API as multipart.
   *
   * Diagnostic only — nothing in the UI branches on it, and it is never shown.
   */
  via?: string;
}

/** A one-shot permission to send exactly one video, to exactly one address. */
export interface PresignResult {
  upload_id: string;
  key: string;
  url: string;
  expires_in_s: number;
}

/** One entry per language in a batch. */
export interface CreatedJobEntry {
  job_id: string;
  target_lang: string;
  minutes_charged: number;
}

export interface CreatedJob {
  /** The first job in the batch. Kept so single-language callers are unchanged. */
  job_id: string;
  /** Every job created, in the order the languages were picked. */
  jobs: CreatedJobEntry[];
  state: JobState;
  /** The total for the whole batch. Per-language figures are on `jobs`. */
  minutes_charged: number;
  billable: boolean;
}

export interface Plan {
  code: string;
  name: string;
  interval: 'month' | 'year' | 'lifetime';
  price_paise: number;
  price_rupees: number;
  minutes_per_period: number;
  max_video_seconds: number;
  output_retention_days: number;
  purchasable: boolean;
  checkout_mode: 'order' | 'subscription' | null;
  mandate_eligible: boolean;
  /**
   * Whether `price_paise` is NET of tax — true for every paid plan.
   *
   * The products are tax-exclusive at the provider: the plan price is what we receive and
   * GST is added at the payment page. So the headline number is not what the customer is
   * charged, and anything that renders a price has to say so or it quotes one figure and
   * collects another.
   */
  price_excludes_tax: boolean;
  tax_percent: number;
  /**
   * The price with tax added. INDICATIVE ONLY, and never presented as a quote: the
   * provider works the real tax out from the customer's billing details, and the total
   * drifts slightly because the charge round-trips through the settlement currency.
   */
  price_with_tax_paise: number;
  /** One sentence, written server-side so every surface words it identically. */
  tax_note: string;
  auto_renews: boolean;
  renewal_note: string;
}

export interface PlansResponse {
  currency: string;
  plans: Plan[];
  /**
   * Whether the payment provider is configured at all.
   *
   * NOT the field to gate a Buy button on — see `open`. `provider` used to be here too
   * and is gone: this endpoint is public, so returning it told anyone who fetched the
   * price list which provider we use and whether we had finished wiring it up.
   */
  live: boolean;
  /**
   * Whether THIS visitor may actually start a checkout.
   *
   * Narrower than `live` on purpose. While the provider is in its sandbox the checkout
   * works end to end and cannot take money, so it is open to the operator for testing
   * and shut to everyone else. A button drawn from `live` alone would let a customer
   * reach a payment page they must not reach.
   */
  open: boolean;
  warning?: string;
  current?: Entitlement;
}

export interface Payment {
  provider_payment_id: string;
  amount_paise: number;
  currency: string;
  method: string | null;
  status: string;
  at: string;
  plan_code: string | null;
}

/**
 * The customer's own view of their subscription.
 *
 * DELIBERATELY NARROWER THAN THE DATABASE ROW. The server sends an explicit column list, so
 * `provider` ("razorpay-test", "dodo-sandbox") and the provider's own subscription and order
 * ids are not here — naming the payment provider to a customer is the same disclosure
 * `/api/billing/plans` already refuses to make. Nothing rendered them.
 */
export interface Subscription {
  id: number;
  plan_code: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  grace_until: string | null;
  auto_renew: number;
  cancel_at: string | null;
}

/** A plan change the customer has asked for and not yet received. */
export interface ScheduledChange {
  /**
   * Which direction. BOTH now wait for the same thing — the next renewal — so this is only
   * ever used for wording. Mid-period upgrades are gone: they charged the difference
   * immediately, and a failed charge left the provider holding a plan change it would never
   * release, which refused every later change with 409 for good.
   */
  kind: 'upgrade' | 'downgrade';
  plan_code: string;
  plan_name: string;
  /** When it takes effect: the end of the period already paid for. */
  effective_at: string | null;
  /** Whether this change can be called off. True for both kinds. */
  can_undo: boolean;
  /**
   * LEGACY. The page a customer still has to pay on, for a change started before plan
   * changes became renewal-only. Always null for anything scheduled since.
   *
   * Still returned so a closed tab is recoverable: while such a link is unpaid the provider
   * refuses every further change, so without a way back to it the only option would be to
   * abandon the change.
   */
  payment_link: string | null;
}

/**
 * Why the customer's last purchase attempt failed, if one did in the past hour.
 *
 * WHY THIS IS NOT ONE FIXED SENTENCE. The page used to say "no money was taken, you can try
 * again" for every failure, because `?status=` on the return url says a payment failed but not
 * which failure it was. That is correct advice for a declined card and actively costly for a
 * failure on the provider's own side, where retrying the same card repeats it — and a few
 * rounds of that hits the rate limiter and locks the customer out of paying at all.
 *
 * The provider's own error code is deliberately NOT in this payload. It is operator detail and
 * lives on the admin billing view.
 */
export interface LastFailure {
  at: string;
  /** The plan or pack that was being bought. */
  what: string;
  /** `topup` | `subscription` | `order`, so the wording can say what it was. */
  kind: string;
  /** Fit to show as-is. */
  message: string;
  /** True when the same method will fail again and something else should be offered. */
  try_another_method: boolean;
}

export interface BillingMe {
  entitlement: Entitlement;
  subscription: Subscription | null;
  scheduled_change: ScheduledChange | null;
  /** Null unless a purchase failed in the last hour. */
  last_failure: LastFailure | null;
  /**
   * Whether a plan change would actually be accepted right now.
   *
   * ASK, DO NOT INFER. The page used to draw an Upgrade button whenever the customer held
   * a monthly plan, and two states make the server refuse regardless — a change already in
   * flight, and a plan set to end. Both were reachable in one sitting, and a button the
   * server refuses is worse than no button.
   */
  can_change_plan: boolean;
  /** Why not, in words fit to show as-is. Null when a change is possible. */
  change_blocked_reason: string | null;
  /** A cancellation that can be taken back. The exit from "set to end". */
  can_resume: boolean;
  what_happens_next: string | null;
  payments: Payment[];
  note: string;
}

/**
 * What switching plans would do, and when.
 *
 * IT NO LONGER COSTS ANYTHING, in either direction. The money fields are kept because the
 * server still sends them and a client reading a missing key as undefined could branch the
 * wrong way — but `amount_paise` is always 0 and `charge_now` is always false. More minutes
 * before the renewal is a top-up, not a plan change.
 */
export interface PlanChangePreview {
  kind: 'upgrade' | 'downgrade';
  from_plan: string;
  to_plan: string;
  plan_name: string;
  /** Always 0. A plan change takes effect at the renewal and charges nothing today. */
  amount_paise: number;
  currency: string;
  amount_rupees?: number;
  /** Always true now — zero is not an estimate. */
  exact?: boolean;
  /** Always false. */
  charge_now: boolean;
  /** The end of the period already paid for. */
  effective_at: string | null;
  /** Minutes they will have when it starts: the whole new allowance, in a fresh period. */
  minutes_after: number;
  minutes_used?: number;
  note: string;
}

export interface PlanChangeStarted {
  kind: 'upgrade' | 'downgrade';
  from_plan: string;
  to_plan: string;
  plan_name: string;
  /** When it takes effect: the end of the period already paid for. Never null now. */
  effective_at: string | null;
  pending: boolean;
  /** Always null. Nothing is charged, so there is no page to pay on. */
  payment_link: string | null;
  /** Always false. */
  charge_now?: boolean;
  note: string;
}

export interface Checkout {
  checkout_session: string;
  /** No `provider` field: see {@link Subscription}. The server does not send one. */
  live: boolean;
  /**
   * Where to send the browser to pay. Null when there is nowhere to go — a provider
   * that hands off through its own client-side SDK instead, or a sandbox with no API
   * key behind it.
   *
   * Card details never touch our pages, which is what keeps the whole service out of
   * PCI scope. That is the reason this is a redirect and not a form.
   */
  checkout_url: string | null;
  mode: 'order' | 'subscription';
  key_id: string | null;
  order_id: string | null;
  subscription_id: string | null;
  amount_paise: number;
  amount_rupees: number;
  currency: string;
  plan_code: string;
  plan_name: string;
  auto_renews: boolean;
  note: string;
}

export interface GpuState {
  enabled: boolean;
  engine_mode: string;
  instance_id: string;
  actual_state: string;
  desired_state: string;
  diverged: boolean;
  public_ip: string | null;
  tunnel_up: boolean;
  engine_answers: boolean;
  idle_minutes: number;
  upload_grace_minutes: number;
  last_seen_running_at: string | null;
  last_work_finished_at: string | null;
  hold_reason: string | null;
  last_watchdog_note: string | null;
  engine_url?: string;
}

export interface AdminOverview {
  earnings: {
    currency: string;
    note: string;
    timezone: string;
    total_rupees: number;
    today_rupees: number;
    week_rupees: number;
  };
  gpu: GpuState;
  users: number;
  sessions_active: number;
  jobs_today: number;
  jobs_running: number;
  jobs_queued: number;
  subscribers: number;
}

export interface AdminUser {
  id: number;
  email: string;
  role: Role;
  created_at: string;
  subscribed: boolean;
  plan: string;
  minutes_left: number;
  minutes_used: number;
  /** The non-expiring half, bought on top of the plan. Zero for most accounts. */
  minutes_topup: number;
  period_end: string | null;
  auto_renew: boolean;
  jobs: number;
  /** `active` | `suspended`. Whether the account may use the product at all. */
  status: string;
  /**
   * Whether they may start a checkout. A NARROWER lever than `status`: it stops the money
   * and nothing else, which is what a disputed charge wants and a suspension does not.
   */
  can_purchase: boolean;
  signup_ip: string | null;
}

/** One pack of extra minutes, for a customer who is already on a plan. */
export interface TopupPack {
  code: string;
  minutes: number;
  name: string;
  price_paise: number;
  price_rupees: number;
  price_excludes_tax: boolean;
  tax_percent: number;
  price_with_tax_paise: number;
  tax_note: string;
  /** Sent by the server so the pricing page and the dashboard cannot round it differently. */
  per_minute_rupees: number;
  one_time: boolean;
  auto_renews: boolean;
}

export interface TopupsResponse {
  currency: string;
  packs: TopupPack[];
  /** Whether buying works at all on this installation, for this account. */
  open: boolean;
  /** Whether THIS account is in a position to top up. Different question from `open`. */
  available: boolean;
  /** `needs_plan` | `balance_full`, or null when it is available. */
  reason: string | null;
  /** Why not, in words fit to show as-is. */
  message: string | null;
  balance_minutes: number;
  plan_minutes_left: number;
  minutes_left: number;
  cap_minutes: number;
  note: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  admin_user_id: number;
  admin_email: string | null;
  action: string;
  target_user_id: number | null;
  target_job_id: string | null;
  reason: string | null;
  ip: string | null;
}

export interface MailRow {
  id: number;
  at: string;
  to_email: string;
  kind: string;
  subject: string | null;
  backend: string | null;
  ok: number | null;
  error: string | null;
  user_id: number | null;
  job_id: string | null;
}

/**
 * `/api/admin/mail` — the outbox, plus enough configuration to spot the one failure
 * that is otherwise invisible.
 *
 * With `backend: 'resend'` and no API key, every signup still succeeds and no
 * confirmation email is ever sent. From the outside that looks exactly like users
 * ignoring their inbox, so `resend_key_present` is surfaced rather than inferred.
 * It is a boolean; the key itself never leaves the server.
 */
export interface MailStatus {
  backend: string;
  outbox_dir: string;
  note: string;
  from?: string;
  resend_key_present?: boolean | null;
  resend_key_file?: string | null;
  failed_recently?: number;
  emails: MailRow[];
}

export interface Portability {
  movable: boolean;
  blockers: { what: string; why: string; fix: string }[];
  warnings: { what: string; why: string; fix: string }[];
  schema_fingerprint: string;
  tables: number;
  totals: Record<string, number>;
  what_moves: Record<string, string>;
  what_does_not_move: Record<string, string>;
}

export interface DbOverview {
  database_file: string;
  size_bytes: number;
  engine: string;
  open_with: string[];
  read_only: boolean;
  tables: { table: string; rows: number; columns: string[] }[];
}

/* ── DPDP: notice, consent, rights, inbox ────────────────────────────────── */

/**
 * One thing a person can be asked to agree to. `required` means "necessary to
 * provide the service", which the UI renders as terms acceptance rather than as a
 * withdrawable preference — the two are different under DPDP s.6 and showing them
 * the same way would misrepresent both.
 */
export interface ConsentPurpose {
  key: string;
  required: boolean;
  label: string;
  description: string;
  /**
   * Where the decision is made. `signup` and `upload` are terms acceptance for the
   * purposes the service cannot run without; `settings` and `banner` are the only
   * places an optional purpose is ever granted, and they are deliberately nowhere
   * near a necessary one.
   */
  where: 'signup' | 'upload' | 'settings' | 'banner';
}

export interface Grievance {
  name: string;
  email: string;
  address: string;
  /** False means nobody has been named yet. The page must say so, visibly. */
  configured: boolean;
  note: string | null;
}

export interface PrivacyNotice {
  notice_version: string;
  grievance: Grievance;
  rights_response_days: number;
  purposes: ConsentPurpose[];
  retention: {
    dubbed_output_free_hours: number;
    dubbed_output_paid_days: number;
    session_days: number;
    /** The sentence the notice shows; built server-side from the numbers below. */
    source_upload: string;
    /** Optional: an older backend (the Python rollback) does not send these. */
    source_upload_free_hours?: number;
    source_upload_paid_days?: number;
    transcripts: string;
  };
  recipients: { who: string; what: string; why: string }[];
  cookies: { name: string; essential: boolean; why: string; life: string }[];
  browser_storage: {
    name: string;
    kind: string;
    essential: boolean;
    why: string;
    life: string;
  }[];
  /** Empty in this build, and the audit is what says so. */
  trackers: { name: string; why: string }[];
}

export interface ConsentState {
  granted: boolean;
  notice_version: string;
  at: string;
  method: string;
}

export interface ConsentRecord {
  purpose: string;
  granted: number;
  notice_version: string;
  method: string;
  at: string;
  ip: string | null;
  user_agent: string | null;
}

export type RightsKind = 'access' | 'correction' | 'erasure' | 'withdraw' | 'grievance';
export type InboxKind = 'contact' | RightsKind;
export type InboxStatus = 'new' | 'in_progress' | 'resolved' | 'rejected';

export interface InboxMessage {
  id: number;
  kind: InboxKind;
  user_id: number | null;
  email: string;
  name: string | null;
  subject: string | null;
  body: string;
  status: InboxStatus;
  /** Null for a general enquiry; set for anything with a statutory deadline. */
  due_at: string | null;
  at: string;
  ip: string | null;
  handled_at: string | null;
  handled_by: number | null;
  handled_note: string | null;
  overdue: boolean;
}

export interface InboxPage {
  messages: InboxMessage[];
  counts: { new: number; overdue: number };
  rights_response_days: number;
}

export interface DpdpReadiness {
  notice_version: string;
  grievance: Grievance;
  rights_response_days: number;
  open_messages: number;
  overdue_rights_requests: number;
  checks: { item: string; ok: boolean; fix: string }[];
  ready: boolean;
}

export interface MaintenanceState {
  on: boolean;
  /** What the public page says while it is on. */
  note: string;
  /** When it was last switched, and by whom. `by` is null when the site is up. */
  since: string | null;
  by: string | null;
  retry_after_s: number;
}

export interface SeoStatus {
  public_base_url: string;
  /** False on a non-https origin, where robots.txt serves `Disallow: /`. */
  indexable: boolean;
  why_not: string | null;
  sitemap_url: string;
  pages: string[];
  robots_txt: string;
}

export interface AccessLogEntry {
  id: number;
  at: string;
  admin_user_id: number;
  admin_email: string | null;
  surface: string;
  target_user_id: number | null;
  rows_returned: number | null;
  detail: string | null;
  ip: string | null;
}

/** One dub as the admin's per-account view describes it (GET /api/admin/users/{id}/jobs). */
export interface AdminUserJob {
  job_id: string;
  video_name: string;
  target_lang: string;
  state: string;
  failed: boolean;
  error_code: string | null;
  created_at: string;
  minutes_charged: number;
  minutes_refunded: number;
  already_refunded: boolean;
  /** Charged, and not refunded yet. */
  refundable: boolean;
  origin: string;
}

/** Accounts created from one address inside the window. A reason to look, not proof. */
export interface SignupCluster {
  ip: string;
  accounts: number;
  confirmed: number;
  suspended: number;
  first_at: string;
  last_at: string;
  users: { id: number; email: string; created_at: string; status: string; confirmed: boolean }[];
}

export interface SignupReport {
  window_hours: number;
  min_accounts: number;
  clusters: SignupCluster[];
  accounts_without_signup_ip: number;
  ceiling: { per_ip_per_hour: number; per_ip_per_day: number };
  note: string;
}

/** GET /api/admin/billing. Rows are whole database rows, so they stay loosely typed. */
export interface AdminBilling {
  provider: Record<string, unknown>;
  subscriptions: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  checkout_sessions: Record<string, unknown>[];
  webhook_events: Record<string, unknown>[];
  webhook_rejects: Record<string, unknown>[];
  disputes?: Record<string, unknown>[];
}

/* ── errors ──────────────────────────────────────────────────────────────── */

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  /**
   * A machine-readable reason, when the backend sent one.
   *
   * Most endpoints answer with `detail: "some prose"`, and prose is all the UI needs.
   * A few refusals have to be BRANCHED on rather than printed: the sign-in gate for an
   * unconfirmed address is a 403, but so is a CSRF failure, and they need completely
   * different words and completely different next steps. Those send
   * `detail: {code, message, ...}` and this is the code.
   *
   * Branch on this, never on the message — the prose is meant to be rewritten.
   */
  readonly code?: string;
  /** The whole `detail` object, for the rare case that carries an extra field. */
  readonly detail?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    retryAfterSeconds?: number,
    code?: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.code = code;
    this.detail = detail;
  }

  /** The address has not been confirmed, so signing in is refused until it is. */
  get isEmailUnconfirmed() {
    return this.code === 'email_not_confirmed';
  }

  /**
   * Registration refused because the address reaches an inbox that already has an
   * account — `john+1@gmail.com` when `john@gmail.com` is taken, or the same address
   * with Gmail's insignificant dots moved around.
   *
   * A 409 like a plain duplicate, but it needs different words: somebody who has never
   * typed this exact spelling before will not believe "that email already has an
   * account", and they are not wrong.
   */
  get isSameInbox() {
    return this.code === 'inbox_already_registered';
  }

  /**
   * The account has been suspended by an operator. A 403, like the unconfirmed gate
   * and like a CSRF failure, so the status alone cannot tell them apart.
   */
  get isSuspended() {
    return this.code === 'account_suspended';
  }

  /** 401 means "sign in", which callers handle differently from a real failure. */
  get isUnauthenticated() {
    return this.status === 401;
  }
  /** The backend answers 404 (not 403) for admin routes, so a stranger cannot
   *  learn that they exist. Treated as "not for you" rather than "missing". */
  get isForbiddenOrMissing() {
    return this.status === 403 || this.status === 404;
  }
  get isRateLimited() {
    return this.status === 429;
  }
  /**
   * 503 — the site is deliberately off for maintenance, not broken.
   *
   * Worth its own accessor because the two need completely different words on screen.
   * "Something went wrong, try again" is wrong when the answer is "we turned it off on
   * purpose and it will be back", and retrying a 503 in a loop is exactly what
   * Retry-After exists to prevent.
   */
  get isMaintenance() {
    return this.status === 503;
  }
}

interface FieldIssue {
  loc?: (string | number)[];
  msg?: string;
}

/**
 * The structured half of an error body, when there is one.
 *
 * A `detail` that is an OBJECT rather than a string or a validation array is how the
 * backend says "branch on this". Without this reader such a body fell through every
 * branch of `readErrorMessage` and surfaced as "Request failed (403)." — technically
 * true and completely useless.
 */
function readErrorDetail(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || !('detail' in body)) return undefined;
  const detail = (body as { detail: unknown }).detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  return detail as Record<string, unknown>;
}

/**
 * Copy for the failures that never reach our backend at all.
 *
 * THIS IS THE 524 BUG. Cloudflare gives up on a slow origin after 100 seconds and
 * answers with a full HTML error page. `readErrorMessage` used to `return body` for any
 * string, so that entire document became `ApiError.message` and got rendered into the
 * error box on the dubbing page — a wall of markup where a sentence should be. React
 * escaped it, so nobody's browser was at risk; it just told the customer nothing.
 *
 * Anything with an HTML shell is by definition not from us: every error this API raises
 * is JSON. So the body is thrown away and the status gets a sentence a person can act on.
 */
function proxyErrorMessage(status: number): string | null {
  if (status === 413) return 'That file is too large to upload.';
  if (status === 504 || status === 524) {
    return (
      'The upload timed out on the way to our server. This is almost always a slow ' +
      'connection — try again on Wi-Fi, or trim the video down first.'
    );
  }
  if (status === 502 || status === 503 || status === 520 || status === 521 || status === 522) {
    return 'Our server could not be reached just then. Please try again in a moment.';
  }
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return null;
}

function looksLikeHtml(s: string): boolean {
  const head = s.trimStart().slice(0, 400).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<head');
}

function readErrorMessage(status: number, body: unknown): string {
  if (typeof body === 'string' && body.trim()) {
    const text = body.trim();
    // An HTML page, or anything far too long to be one of our messages, came from a
    // proxy rather than from us. Never show it.
    if (looksLikeHtml(text) || text.length > 400) {
      return proxyErrorMessage(status) ?? `Request failed (${status}).`;
    }
    return text;
  }

  const structured = readErrorDetail(body);
  if (structured && typeof structured.message === 'string' && structured.message) {
    return structured.message;
  }

  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      // FastAPI validation shape. Name the field, because "value is not a valid
      // email" without the field is a support ticket.
      const parts = (detail as FieldIssue[]).map((issue) => {
        const field = (issue.loc ?? [])
          .filter((p) => p !== 'body')
          .join('.');
        return field ? `${field}: ${issue.msg ?? 'invalid'}` : (issue.msg ?? 'invalid');
      });
      if (parts.length) return parts.join('; ');
    }
  }
  if (status === 401) return 'Please sign in.';
  if (status === 403) return 'That action was refused.';
  if (status === 404) return 'Not found.';
  return proxyErrorMessage(status) ?? `Request failed (${status}).`;
}

/* ── the client ──────────────────────────────────────────────────────────── */

let csrfToken: string | null = null;

export function setCsrf(token: string | null) {
  csrfToken = token;
}
export function getCsrf() {
  return csrfToken;
}

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';

interface CallOptions {
  method?: Method;
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  /** Skip the CSRF header. Only the webhook has any business doing this. */
  noCsrf?: boolean;
}

async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && !opts.noCsrf && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const res = await fetch(path, {
    method,
    headers,
    // The session cookie is the whole auth story; without this nothing works.
    credentials: 'same-origin',
    body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
    signal: opts.signal,
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const retry = res.headers.get('Retry-After');
    const structured = readErrorDetail(body);
    throw new ApiError(
      res.status,
      readErrorMessage(res.status, body),
      retry ? Number(retry) : undefined,
      typeof structured?.code === 'string' ? structured.code : undefined,
      structured,
    );
  }
  return body as T;
}

/* ── sending a video straight to storage ─────────────────────────────────── */

/**
 * PUT one file at a pre-authorised storage address.
 *
 * NOT `call()`, and deliberately nothing like it. This request does not go to our API:
 * it carries no cookies, no CSRF header and no credentials, because the signature in the
 * URL *is* the authorisation and sending our session to somebody else's host would be a
 * leak for no benefit. `withCredentials` stays false so the browser's preflight stays
 * simple and storage does not have to allow credentialed origins.
 *
 * XHR rather than fetch for the same reason as the multipart upload: fetch cannot report
 * how far a request body has got, and a video with no moving progress bar reads as a
 * frozen page.
 *
 * ONE HEADER, AND ONLY ONE. Every header sent here has to match what was signed and be
 * allowed by the bucket's CORS rules; each extra one is another chance at a 403 that
 * looks like a network fault. Content-Type is deliberately excluded from the signature
 * server-side so a browser that adjusts it cannot invalidate the request.
 */
function putToStorage(
  url: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    // EVERY failure here is reported as one code, and storage's own status is not
    // reused as ours. That is not laziness — 403 from storage means an expired or
    // malformed signature, which is precisely a case that SHOULD retry through the API,
    // while 403 from our API means "not for you" and must not. Mapping them onto the
    // same number would make the retry rule read one as the other.
    const failed = () =>
      reject(
        new ApiError(0, 'The upload could not be delivered.', undefined, 'storage_put_failed'),
      );
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : failed());
    xhr.onerror = failed;
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.', undefined, 'aborted'));
    xhr.send(file);
  });
}

/**
 * Is this worth a second attempt through the API?
 *
 * Yes for anything that means "the fast road is shut": storage unconfigured, a signature
 * the bucket would not take, the network dropping mid-PUT. No for a refusal the server
 * made about the VIDEO — too long, out of minutes, too large, signed out, rate limited.
 * Those verdicts do not change because the bytes travelled a different way, and retrying
 * would make the customer wait through a whole slow upload to be told the same thing.
 */
function worthFallback(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  // The customer stopped it. Retrying would be the opposite of what they asked.
  if (err.code === 'aborted') return false;
  // The transfer to storage itself failed, whatever storage called it. Always worth
  // the slow road.
  if (err.code === 'storage_put_failed') return true;
  if (err.status === 401 || err.status === 403 || err.status === 413) return false;
  if (err.status === 429) return false;
  if (err.code === 'video_too_long' || err.code === 'not_enough_minutes') return false;
  return true;
}

/**
 * Ask for permission to send one video straight to storage.
 *
 * Cheap and instant, but not free of consequence: this is where the plan is checked and
 * where the GPU starts warming, so it is the same gate as the upload itself.
 */
function presignUpload(file: File): Promise<PresignResult> {
  return call<PresignResult>('/api/uploads/presign', {
    method: 'POST',
    json: {
      filename: file.name,
      content_type: file.type || 'video/mp4',
      bytes: file.size,
    },
  });
}

/** Tell the API the transfer finished, so it can import and probe the video. */
function completeUpload(presigned: PresignResult, file: File): Promise<UploadResult> {
  return call<UploadResult>('/api/uploads/complete', {
    method: 'POST',
    json: {
      upload_id: presigned.upload_id,
      key: presigned.key,
      filename: file.name,
      content_type: file.type || 'video/mp4',
    },
  });
}

/**
 * The whole file, streamed through the API as multipart.
 *
 * STILL HERE ON PURPOSE, as the fallback behind `sendVideo`. It needs no object storage,
 * so it is the only path that works on a bare install, and it covers a bucket outage or a
 * signature the browser could not use.
 */
function uploadViaApi(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.withCredentials = true;
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    // fetch() cannot report upload progress; XHR can, and a multi-hundred-MB
    // video with no progress bar reads as a hung page.
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as UploadResult);
      } else {
        // The structured half was being dropped here, unlike in `call()`. That
        // matters now: `video_too_long` carries the plan's limit, and the page
        // needs it to open the trim editor rather than just print a refusal.
        const structured = readErrorDetail(body);
        reject(
          new ApiError(
            xhr.status,
            readErrorMessage(xhr.status, body),
            undefined,
            typeof structured?.code === 'string' ? structured.code : undefined,
            structured,
          ),
        );
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'The upload could not reach the server.'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));
    xhr.send(form);
  });
}

/**
 * Send a video, by whichever road is open. THIS IS WHAT THE UI CALLS.
 *
 * Storage first, because it is measured at three to four times the speed: the same bytes
 * that crawl through the proxy in front of us at 7.9 Mbps go straight to storage at 29.6,
 * and an eighty-megabyte video drops from about 81 seconds to about 22. Our own server was
 * never the slow part — it handles 129 MB/s through nginx and TLS, and spends 0.16s on a
 * 20 MB upload. Three quarters of every upload's wait was the relay. That relay is also
 * where long uploads used to die at a hundred seconds and return an error page instead of
 * a dub.
 *
 * Then, if anything about that road is shut, the whole file goes through the API instead.
 * Slower, but it is the difference between a slow dub and no dub, and it is the only path
 * that exists on an install with no bucket configured at all.
 *
 * THE FALLBACK IS NOT UNCONDITIONAL — see `worthFallback`. A refusal about the video
 * itself is final, and re-sending it the slow way to hear the same answer would be the
 * worst of both.
 *
 * The progress bar follows the storage transfer and nothing else. The import that follows
 * is about three seconds even for a large file, so a second phase would flicker past
 * having said nothing.
 */
async function sendVideo(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  let presigned: PresignResult;
  try {
    presigned = await presignUpload(file);
  } catch (err) {
    if (!worthFallback(err)) throw err;
    return uploadViaApi(file, onProgress);
  }

  try {
    await putToStorage(presigned.url, file, onProgress);
    return await completeUpload(presigned, file);
  } catch (err) {
    if (!worthFallback(err)) throw err;
    // Start the bar over rather than let it jump backwards from wherever the failed
    // attempt happened to reach.
    if (onProgress) onProgress(0);
    return uploadViaApi(file, onProgress);
  }
}

/* ── endpoints, grouped the way the UI uses them ─────────────────────────── */

export const api = {
  health: () => call<Health>('/api/health'),

  /**
   * Asked once on boot, before anything renders.
   *
   * Reachable during maintenance on purpose — it is how the app tells "we are down
   * for changes" apart from "the API is unreachable". From the browser those look
   * identical and they need completely different pages.
   */
  site: () => call<SiteStatus>('/api/site'),

  auth: {
    me: () => call<Me>('/api/auth/me'),
    /**
     * `consent` is the purpose -> granted map from the signup form's checkboxes.
     * Sent on every registration from this client. The server can be configured to
     * refuse a registration without it (VS_REQUIRE_SIGNUP_CONSENT), and records
     * whatever arrives either way, so the ledger has an entry from the moment the
     * account exists rather than from the first time somebody visits a settings
     * page.
     */
    register: (email: string, password: string, consent?: Record<string, boolean>) =>
      call<RegisterResult>('/api/auth/register', {
        method: 'POST',
        json: { email, password, ...(consent ? { consent } : {}) },
      }),
    /**
     * Sign in. Refused with 403 `email_not_confirmed` until the address is confirmed —
     * see `ApiError.isEmailUnconfirmed`, and branch on that rather than on the status,
     * because a CSRF failure is also a 403.
     */
    login: (email: string, password: string) =>
      call<LoginResult>('/api/auth/login', {
        method: 'POST',
        json: { email, password },
      }),
    logout: () => call<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
    requestReset: (email: string) =>
      call<{ ok: boolean; note: string }>('/api/auth/reset/request', {
        method: 'POST',
        json: { email },
      }),
    confirmReset: (token: string, password: string) =>
      call<{ ok: boolean; sessions_revoked: number }>('/api/auth/reset/confirm', {
        method: 'POST',
        json: { token, password },
      }),

    /**
     * Spend a confirmation token from an emailed link.
     *
     * No session needed, deliberately: the link is opened from a mail client, which
     * may not be the browser holding the cookie. The token IS the proof. It does not
     * IT NOW SIGNS YOU IN. The token is single-use, expires in 24 hours and arrives in
     * the person's own inbox — the same proof a password-reset link carries, and a reset
     * link may change the password, which is strictly more powerful than opening a
     * session. So confirming and then demanding the password again proved nothing and
     * cost every new customer a step.
     *
     * `csrf` comes back on success. Callers should hand it to `setCsrf` and then refresh
     * the session, exactly as `signIn` does.
     */
    verify: (token: string) =>
      call<{
        ok: boolean;
        already?: boolean;
        email?: string;
        note?: string;
        id?: number;
        role?: string;
        csrf?: string;
        signed_in?: boolean;
      }>(
        '/api/auth/verify',
        { method: 'POST', json: { token } },
      ),

    /**
     * Ask for another confirmation link WITHOUT being signed in.
     *
     * This is the one that matters now that sign-in requires a confirmed address: the
     * person who needs a second link is precisely the one who cannot get a session.
     * Answers identically whether or not the address exists, so the response says
     * nothing about who has an account — don't write copy that implies it did.
     */
    requestVerify: (email: string) =>
      call<{ ok: boolean; note: string }>('/api/auth/verify/request', {
        method: 'POST',
        json: { email },
      }),

    /** The signed-in variant, for an account that is in but still unconfirmed. */
    resendVerify: () =>
      call<{ ok: boolean; already?: boolean; sent_to?: string }>(
        '/api/auth/verify/resend',
        { method: 'POST' },
      ),

    /**
     * Where to send the browser for Google sign-in.
     *
     * A URL rather than a call, because this cannot be a fetch: the browser has to
     * physically visit Google and be redirected back, so it is `window.location`
     * assignment or a plain link. The backend builds the Google URL — the client id,
     * the scopes and the PKCE challenge all stay server-side.
     */
    googleStart: (next?: string) =>
      `/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`,
  },

  jobs: {
    list: (signal?: AbortSignal) =>
      call<{ jobs: JobSummary[]; entitlement: Entitlement }>('/api/jobs', { signal }),
    get: (id: string) => call<JobDetail>(`/api/jobs/${id}`),
    events: (id: string, afterId = 0, signal?: AbortSignal) =>
      call<EventsPage>(`/api/jobs/${id}/events?after_id=${afterId}`, { signal }),
    /**
     * The upload is the one request that can take minutes, and it is also what
     * wakes the GPU box — the backend starts the instance before reading a byte,
     * so the boot happens underneath this call rather than after it.
     */
    // `warmup()` was here. It POSTed to /api/uploads/warmup the moment a file was
    // picked, to get the six-minute boot running underneath the transfer. Both the
    // method and the endpoint are gone: capacity now starts when a dub is requested,
    // because picking a file is not a decision to buy anything and an abandoned tab
    // should not run a machine that bills by the hour.

    presign: presignUpload,
    completeUpload: completeUpload,
    /**
     * Send a video. THIS IS THE ONE THE UI CALLS. See `sendVideo`.
     */
    upload: sendVideo,
    /** The slow road, kept as the fallback. See `uploadViaApi`. */
    uploadViaApi: uploadViaApi,
    /**
     * Queue one dub per language, in a single request.
     *
     * One request rather than one per language on purpose: the server checks the
     * minute quota against the total, and creates every job in one transaction.
     * Looping here instead would let a browser fire N requests that each pass
     * their own quota check while collectively going over, and would leave a
     * half-created batch behind on the first failure.
     */
    create: (uploadId: string, targetLangs: string[], sourceLang?: string) =>
      call<CreatedJob>('/api/jobs', {
        method: 'POST',
        json: {
          upload_id: uploadId,
          target_langs: targetLangs,
          ...(sourceLang ? { source_lang: sourceLang } : {}),
        },
      }),
    /** What this job can be downloaded as. Served, so the menu cannot offer a
     *  format the backend has no exporter for. */
    formats: (id: string) => call<FormatsResponse>(`/api/jobs/${id}/formats`),
    downloadToken: (id: string, format: DownloadFormat = 'video', inline = false) =>
      call<{
        token: string;
        url: string;
        format: DownloadFormat;
        inline: boolean;
        expires_in_s: number;
        note: string;
      }>(`/api/jobs/${id}/download-token?format=${format}&inline=${inline}`),
    /**
     * A URL the dashboard player can point a <video> or <audio> at.
     *
     * Minted rather than a plain path because the token IS the authorisation, which
     * is what lets a media element load it — media elements are inconsistent about
     * sending cookies, and this way it does not matter. Served inline with Range
     * support, so seeking works, and on a longer TTL than a download because a
     * scrub is another request and the token has to still be alive for it.
     */
    streamUrl: async (id: string, format: DownloadFormat = 'video') => {
      const res = await call<{ url: string; expires_in_s: number }>(
        `/api/jobs/${id}/download-token?format=${format}&inline=true`,
      );
      return res.url;
    },
    deleteVideo: (id: string) =>
      call<{ ok: boolean; already?: boolean }>(`/api/jobs/${id}/video`, {
        method: 'DELETE',
      }),
    /**
     * Plain navigation, so the browser owns the save dialog and the 307 hop.
     *
     * `format: 'audio'` returns the dubbed track on its own as .m4a, which is what
     * YouTube's multi-language audio uploader takes — it attaches one track per
     * language to a single video, so the dubs share the original's URL and view
     * count. Cut losslessly from the MP4 on request, not stored separately.
     */
    downloadHref: (id: string, format: DownloadFormat = 'video') =>
      `/api/jobs/${id}/download?format=${format}`,
  },

  billing: {
    plans: () => call<PlansResponse>('/api/billing/plans'),
    me: () => call<BillingMe>('/api/billing/me'),
    checkout: (planCode: string) =>
      call<Checkout>('/api/billing/checkout', {
        method: 'POST',
        json: { plan_code: planCode },
      }),
    cancel: () =>
      call<{
        ok: boolean;
        keeps_access_until?: string;
        ends?: string;
        already?: string;
        note?: string;
      }>('/api/billing/cancel', { method: 'POST', json: { confirm: true } }),

    /**
     * Extra minutes for somebody already on a plan.
     *
     * WHAT THESE REPLACED. Moving up a plan mid-month used to charge the difference on the
     * spot, and when that charge failed the provider held the plan change pending for ever
     * — every later change came back "wait for the current payment to complete" for a
     * payment that had already failed, with no way to clear it. A top-up is an ordinary
     * one-time checkout that never touches the renewal mandate, so that state cannot exist.
     *
     * `topups` is a read and needs no CSRF. `topup` creates a real payment, so it is gated
     * exactly like `checkout`.
     */
    topups: () => call<TopupsResponse>('/api/billing/topups'),
    topup: (packCode: string) =>
      call<Checkout & { topup_code: string; minutes: number }>('/api/billing/topup', {
        method: 'POST',
        json: { pack_code: packCode },
      }),

    /**
     * MOVES THE EXISTING SUBSCRIPTION — it does not sell another one, which is the
     * difference between changing plan and buying one. There is no redirect: the
     * provider charges the payment method already on file.
     */
    previewChange: (planCode: string) =>
      call<PlanChangePreview>('/api/billing/change-plan/preview', {
        method: 'POST',
        json: { plan_code: planCode },
      }),
    change: (planCode: string) =>
      call<PlanChangeStarted>('/api/billing/change-plan', {
        method: 'POST',
        json: { plan_code: planCode },
      }),
    cancelChange: () =>
      call<{
        cancelled: string;
        staying_on: string;
        kind: 'upgrade' | 'downgrade';
        plan_name: string;
        note: string;
      }>('/api/billing/change-plan/cancel', {
        method: 'POST',
        json: { confirm: true },
      }),

    /**
     * Undo a cancellation so the plan renews again.
     *
     * Needed because the provider refuses every plan change on a subscription that is set
     * to end, so cancelling used to be a one-way door: no change, and no way back.
     */
    resume: () =>
      call<{
        ok: boolean;
        already?: string;
        plan_code: string;
        plan_name?: string;
        renews_on?: string;
        note?: string;
      }>('/api/billing/resume', { method: 'POST', json: { confirm: true } }),

    /**
     * A one-time link to the hosted billing area: invoices, receipts, changing the card
     * on file, and clearing a subscription put on hold by a failed payment.
     *
     * None of that is built here, and all of it is otherwise a support email. The link
     * expires, so it is minted per click rather than cached.
     */
    portal: () => call<{ url: string }>('/api/billing/portal', { method: 'POST' }),
  },

  /**
   * The public DPDP surface. Unauthenticated by design: somebody locked out of
   * their account still has s.11-13 rights, and requiring a login to exercise them
   * would deny them at exactly the moment they matter.
   */
  privacy: {
    notice: () => call<PrivacyNotice>('/api/privacy/notice'),
    contact: (msg: { email: string; body: string; name?: string; subject?: string }) =>
      call<{ ok: boolean; id: number; note: string }>('/api/contact', {
        method: 'POST',
        json: msg,
      }),
    request: (kind: RightsKind, email: string, body = '') =>
      call<{ ok: boolean; id: number; due_at: string | null; note: string }>(
        '/api/privacy/request',
        { method: 'POST', json: { kind, email, body } },
      ),
    myConsent: () =>
      call<{
        notice_version: string;
        purposes: ConsentPurpose[];
        current: Record<string, ConsentState>;
        history: ConsentRecord[];
      }>('/api/privacy/consent'),
    /**
     * `how` records the control that was actually used. Not cosmetic: the audit
     * trail has to be able to tell "accepted the terms" from "ticked a box", and a
     * caller that overstates it makes the record worse than useless. The server
     * validates it against its own allowlist.
     */
    setConsent: (
      granted: Record<string, boolean>,
      how: 'terms_acceptance' | 'settings' | 'banner' = 'settings',
    ) =>
      call<{ ok: boolean; recorded: string[]; current: Record<string, ConsentState> }>(
        '/api/privacy/consent',
        { method: 'POST', json: { granted, method: how } },
      ),
    /** Plain navigation, so the browser owns the save dialog. */
    exportHref: '/api/privacy/export',
    erase: (password: string) =>
      call<{
        ok: boolean;
        erased_at: string;
        deleted: Record<string, number>;
        retained: string[];
        note: string;
      }>('/api/privacy/erase', {
        method: 'POST',
        json: { password, confirm: 'DELETE' },
      }),
  },

  admin: {
    overview: () => call<AdminOverview>('/api/admin/overview'),
    inbox: (status = '', kind = '') =>
      call<InboxPage>(
        `/api/admin/inbox?status=${encodeURIComponent(status)}&kind=${encodeURIComponent(kind)}`,
      ),
    handleMessage: (id: number, status: InboxStatus, note = '') =>
      call<{ ok: boolean; id: number; status: string }>(`/api/admin/inbox/${id}`, {
        method: 'POST',
        json: { status, note },
      }),
    dpdp: () => call<DpdpReadiness>('/api/admin/dpdp'),
    maintenance: () => call<MaintenanceState>('/api/admin/maintenance'),
    setMaintenance: (on: boolean, note = '') =>
      call<MaintenanceState & { ok: boolean; note_to_admin: string }>(
        '/api/admin/maintenance',
        { method: 'POST', json: { on, note } },
      ),
    seo: () => call<SeoStatus>('/api/admin/seo'),
    accessLog: (limit = 200) =>
      call<{ access_log: AccessLogEntry[] }>(`/api/admin/access-log?limit=${limit}`),
    userConsent: (id: number) =>
      call<{
        user_id: number;
        current: Record<string, ConsentState>;
        history: ConsentRecord[];
        notice_version: string;
      }>(`/api/admin/users/${id}/consent`),
    users: (q = '') =>
      call<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`),
    userJobs: (id: number) =>
      call<{ user_id: number; jobs: AdminUserJob[] }>(`/api/admin/users/${id}/jobs`),
    /**
     * Stop an account using the product. Reversible, audited, and it signs them out
     * everywhere. Asks for the admin password again, like every account-changing action.
     */
    suspend: (id: number, reason: string, password: string) =>
      call<{ ok: boolean; user_id: number; status: string; sessions_revoked: number; note: string }>(
        `/api/admin/users/${id}/suspend`,
        { method: 'POST', json: { reason, password } },
      ),
    unsuspend: (id: number, reason: string, password: string) =>
      call<{ ok: boolean; user_id: number; status: string; note: string }>(
        `/api/admin/users/${id}/unsuspend`,
        { method: 'POST', json: { reason, password } },
      ),
    signups: (hours = 168, minAccounts = 2) =>
      call<SignupReport>(`/api/admin/signups?hours=${hours}&min_accounts=${minAccounts}`),
    grant: (id: number, planCode: string, months: number, reason: string, password: string) =>
      call<{ ok: boolean; period_end: string }>(`/api/admin/users/${id}/grant`, {
        method: 'POST',
        json: { plan_code: planCode, months, reason, password },
      }),
    revoke: (id: number, reason: string, password: string) =>
      call<{ ok: boolean }>(`/api/admin/users/${id}/revoke`, {
        method: 'POST',
        json: { reason, password },
      }),

    /**
     * Stop a user's subscription at the payment provider as well as here.
     *
     * THE FASTEST LEVER FOR A PAYMENT THAT SHOULD NOT BE HAPPENING, which is why it exists
     * separately from suspending: suspension stops somebody using the product and does
     * nothing at all to their card.
     *
     * `immediate` false stops the renewal and leaves the period they paid for alone. True
     * ends it now and writes off any top-up balance, because those minutes are sold as an
     * adjustment to a plan and cannot outlive one.
     */
    cancelSubscription: (id: number, reason: string, password: string, immediate = false) =>
      call<{
        ok: boolean;
        plan_code: string;
        immediate: boolean;
        keeps_access_until: string | null;
        topup_minutes_voided: number;
        needs_operator?: boolean;
        note?: string;
      }>(`/api/admin/users/${id}/cancel-subscription`, {
        method: 'POST',
        json: { reason, password, immediate },
      }),

    /**
     * Stop, or restart, this account buying anything. Leaves everything else working.
     *
     * Deliberately does NOT touch a subscription that is already running — that is
     * `cancelSubscription`, a separate decision with its own audit entry. Bundling them
     * would mean an operator preventing the next purchase silently cancelled the current
     * plan too.
     */
    setPurchases: (id: number, allow: boolean, reason: string, password: string) =>
      call<{ ok: boolean; can_purchase: boolean; note?: string }>(
        `/api/admin/users/${id}/${allow ? 'allow' : 'block'}-purchases`,
        { method: 'POST', json: { reason, password } },
      ),
    refund: (jobId: string, reason: string, password: string) =>
      call<{ ok: boolean; minutes_refunded: number; method: string }>(
        `/api/admin/jobs/${encodeURIComponent(jobId)}/refund`,
        { method: 'POST', json: { reason, password } },
      ),
    sessions: () =>
      call<{
        sessions: {
          id: string;
          user_id: number;
          email: string;
          created_at: string;
          last_seen_at: string;
          expires_at: string;
          ip: string | null;
          user_agent: string | null;
        }[];
      }>('/api/admin/sessions'),
    killSession: (id: string) =>
      call<{ ok: boolean }>(`/api/admin/sessions/${id}`, { method: 'DELETE' }),
    gpu: () => call<GpuState>('/api/admin/gpu'),
    gpuStart: () => call<{ starting: boolean; note: string }>('/api/admin/gpu/start', {
      method: 'POST',
    }),
    /**
     * `force=false`: stop only if every safety condition allows it - `acted` says whether
     * it did, `why` says why not. `force=true`: stop regardless; a stop AWS refused comes
     * back as an error (502), never as a 200, so success here means AWS accepted it.
     */
    gpuStop: (force = false) =>
      call<{
        acted?: boolean;
        why?: string;
        forced?: boolean;
        was_holding?: string | null;
        rc?: number;
      }>(`/api/admin/gpu/stop?force=${force}`, { method: 'POST' }),
    storage: () => call<StorageStatus>('/api/admin/storage'),
    mail: (limit = 100) => call<MailStatus>(`/api/admin/mail?limit=${limit}`),
    limits: () =>
      call<{
        buckets: Record<string, { max_hits: number; window_s: number }>;
        scope: string;
        note: string;
      }>('/api/admin/limits'),
    billing: (limit = 100) => call<AdminBilling>(`/api/admin/billing?limit=${limit}`),
    /** The renewal-reminder, expiry and plan-change sweep the worker runs every five
     *  minutes, run now. Sends any reminder emails that are due - nothing extra. */
    billingSweep: () =>
      call<{
        reminders: Record<string, unknown>;
        expiries: Record<string, unknown>;
        plan_changes: Record<string, unknown>;
      }>('/api/admin/billing/sweep', { method: 'POST' }),
    preset: () => call<Record<string, unknown>>('/api/admin/preset'),
    audit: (limit = 200) =>
      call<{ audit: AuditEntry[] }>(`/api/admin/audit?limit=${limit}`),
    portability: () => call<Portability>('/api/admin/portability'),
    db: () => call<DbOverview>('/api/admin/db'),
    dbTable: (name: string, limit = 100, offset = 0) =>
      call<{ table: string; columns: string[]; rows: Record<string, unknown>[]; total: number }>(
        `/api/admin/db/table/${encodeURIComponent(name)}?limit=${limit}&offset=${offset}`,
      ),
    dbQuery: (sql: string) =>
      call<{ columns: string[]; rows: Record<string, unknown>[]; row_count: number }>(
        '/api/admin/db/query',
        { method: 'POST', json: { sql } },
      ),
    export: (dest?: string) =>
      call<{ ok: boolean; archive: string; manifest: Record<string, unknown> }>(
        `/api/admin/export${dest ? `?dest=${encodeURIComponent(dest)}` : ''}`,
        { method: 'POST' },
      ),
  },
};
