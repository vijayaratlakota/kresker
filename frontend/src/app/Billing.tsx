/**
 * Plans, current subscription, payment history.
 *
 * Two things this page refuses to be vague about, because the backend is not
 * vague about them either:
 *
 *  1. **Annual plans do not renew themselves.** They are a one-off payment, for a
 *     regulatory reason (recurring debits above ₹15,000 need the customer to
 *     authenticate again, which an unattended renewal cannot do). Hiding that
 *     would make a lapsed subscription look like our bug.
 *  2. **Test mode.** With no payment keys configured nothing can be charged. A
 *     checkout button that looks live but cannot take money is worse than a
 *     disabled one.
 */
import { Select } from '@base-ui/react/select';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  api,
  ApiError,
  type BillingMe,
  type Plan,
  type PlanChangePreview,
  type PlansResponse,
  type TopupsResponse,
} from '../lib/api';
import { goToPaymentPage } from '../lib/dodoCheckout';
import { onDay, rupees, when } from '../lib/format';
import { useSession } from '../lib/session';
import { reloadForNewBuild, useBuild } from '../lib/useBuild';
import { Button } from '../ui/Button';
import { Celebrate, type CelebrateTone } from '../ui/Celebrate';
import { Modal } from '../ui/Modal';
import { Badge, Card, EmptyState, ErrorNote, InfoNote, Skeleton } from '../ui/primitives';

/**
 * What the provider told us, in the URL, when it sent the browser back here.
 *
 * WHY THIS IS READ RATHER THAN ASSUMED. The return is now immediate, so this page is the
 * FIRST thing a customer sees after a payment — including one that failed. Previously the
 * provider parked them on its own summary page, which at least printed "Failed" before
 * they ever reached us, so the old code could get away with treating everybody arriving
 * from a checkout as somebody who had paid. It cannot now.
 */
type Arrival =
  /** Not a return from a payment at all — somebody just opened the billing page. */
  | { kind: 'none' }
  /** They went through with it. Whether the money landed is the poll's problem. */
  | { kind: 'confirming' }
  /** The provider says no money moved. */
  | { kind: 'nopay' };

function readArrival(): Arrival {
  // The provider appends its own parameters to a `return_url` that already carries one.
  // Turning every `?` after the first into `&` makes this parse identically whether it
  // joins with `&` or with a second `?`, rather than the whole arrival being misread over
  // a punctuation detail on somebody else's server that we do not control and cannot fix.
  const raw = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
  const q = new URLSearchParams(raw);
  if (q.get('from') !== 'checkout') return { kind: 'none' };

  // `succeeded` is the only good word. `failed`, `cancelled`, `requires_payment_method`
  // and `requires_customer_action` all mean the same thing to the person reading this
  // page — no money moved — so they collapse into one case. The distinctions are real but
  // none of them changes what the customer can do about it, which is to try again.
  //
  // An ABSENT status stays `confirming`, which is what it meant before any of this
  // existed. A missing parameter must not turn a successful purchase into a failure
  // notice.
  const status = (q.get('status') ?? '').toLowerCase();
  if (status && status !== 'succeeded') return { kind: 'nopay' };
  return { kind: 'confirming' };
}

export function Billing() {
  const setEntitlement = useSession((s) => s.setEntitlement);
  const [plans, setPlans] = useState<PlansResponse | null>(null);
  const [mine, setMine] = useState<BillingMe | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');

  /**
   * The subscription moment. Set once, by whichever of the two polls below sees the
   * plan actually become active — the one that runs when the customer comes back from
   * paying, and the one that runs when a queued upgrade finally clears.
   *
   * It is driven off the SAME condition as the toast rather than off the click, which
   * matters: a click means a payment page opened, and celebrating that would be
   * celebrating a payment that has not happened yet. This only fires on the server
   * confirming an entitlement.
   */
  const [party, setParty] = useState<{
    tone: CelebrateTone;
    title: string;
    detail: string;
  } | null>(null);



  /**
   * Extra minutes, and whether this account may buy any.
   *
   * FETCHED WITH THE REST RATHER THAN WHEN THE SECTION OPENS. It is one small request, the
   * balance it reports has to be right the moment the page paints (it is part of "how many
   * minutes do I have"), and loading it lazily would mean the section appears a beat after
   * everything else — which on this page reads as a layout glitch rather than as loading.
   *
   * Its own state, not folded into `mine`, because a failure to load the pack list must not
   * take the whole billing page down with it. See the catch below.
   */
  const [topups, setTopups] = useState<TopupsResponse | null>(null);

  const load = useCallback(async (): Promise<BillingMe | null> => {
    try {
      const [p, m] = await Promise.all([api.billing.plans(), api.billing.me()]);
      setPlans(p);
      setMine(m);
      setEntitlement(m.entitlement);
      // AFTER the two that matter, and allowed to fail on its own. A customer who cannot
      // see the top-up packs has lost a convenience; one who cannot see their plan or their
      // minutes has lost the page.
      try {
        setTopups(await api.billing.topups());
      } catch {
        setTopups(null);
      }
      return m;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load billing.');
      return null;
    }
  }, [setEntitlement]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Coming back from the payment page, wait for the plan to actually change.
   *
   * THE RACE IS REAL AND IT LOOKS LIKE A FAILED PAYMENT. The provider redirects the
   * browser here the moment it has taken the money, and tells our server separately.
   * Those two arrive independently, so a customer who has genuinely just paid can load
   * this page and see themselves still on the free plan — which reads as "it took my
   * money and did nothing".
   *
   * So when we know we have just come back from a payment, poll for a short while. Every
   * two seconds for thirty, stopping the moment the plan is no longer free. Thirty
   * seconds is far longer than the notification normally takes and short enough that a
   * genuinely failed payment does not leave a spinner running.
   *
   * The `waiting` banner is what the customer reads meanwhile. Nothing here claims the
   * payment succeeded — only that we are checking, which is all we honestly know.
   */
  const [arrived] = useState(readArrival);
  const [waiting, setWaiting] = useState(() => arrived.kind === 'confirming');

  /**
   * The one thing we can say about the payment just attempted, when there is something to
   * say. Two tones, because "no money was taken" and "we have not heard yet" are
   * different facts and colouring them the same would make one of them a lie.
   */
  const [payNote, setPayNote] = useState<{ tone: 'bad' | 'info'; text: string } | null>(
    () =>
      arrived.kind === 'nopay'
        ? {
            tone: 'bad',
            // Deliberately does not guess WHY. The provider's reason codes are written for
            // us, not for the customer, and "your card was declined" when it was actually
            // an abandoned 3DS prompt is worse than saying nothing about the cause.
            text: 'That payment did not go through, and no money was taken. You can try again below.',
          }
        : null,
  );

  /**
   * Take the payment parameters out of the address bar once they have been read.
   *
   * Without this a refresh re-runs the whole arrival: the poll starts again and, now that
   * there is one, the celebration plays again. A page you cannot reload without being
   * congratulated a second time feels broken rather than celebratory.
   *
   * `replaceState` rather than a navigation, so there is no new history entry and the
   * router is untouched — the path does not change, only the query.
   */
  useEffect(() => {
    if (arrived.kind === 'none') return;
    window.history.replaceState({}, '', window.location.pathname);
    // THE POPUP IS NOT FIRED HERE ANY MORE, and the delay is the point.
    //
    // It used to announce "No money was taken. You can try again." the instant the page
    // loaded. That is correct advice for a declined card and wrong for a failure on the
    // provider's own side, where the same card does the same thing — and following it costs
    // the customer attempts until the rate limiter stops them paying us at all.
    //
    // The reason lives on `mine.last_failure`, which arrives with the first `load()` a moment
    // later. So the announcement waits for it: see the effect below. The red note above the
    // page is already showing meanwhile, so nothing is silent in the gap.
  }, [arrived]);

  /**
   * Say what actually went wrong, once we know.
   *
   * Fires at most once per visit. `mine.last_failure` is the server's classification of the
   * provider's error code — "not your card, try another method" reads very differently from
   * "your bank declined it", and both read differently from "try again". If it is absent (an
   * old failure, or a webhook that has not landed yet) the generic sentence is still the
   * honest fallback.
   */
  const failureShown = useRef(false);
  useEffect(() => {
    if (arrived.kind !== 'nopay' || !mine || failureShown.current) return;
    failureShown.current = true;
    const f = mine.last_failure;
    setParty({
      tone: 'bad',
      title: 'Payment failed',
      detail: f?.message ?? 'No money was taken. You can try again.',
    });
    if (f) {
      setPayNote({ tone: 'bad', text: f.message });
    }
  }, [arrived, mine]);

  /**
   * THE BACKSTOP THAT MAKES THE CELEBRATION UNCONDITIONAL.
   *
   * Everything else that triggers it depends on the customer still being on this page when
   * the webhook lands — the poll after a checkout, the poll after an upgrade. That is a fair
   * assumption right up until the provider takes them somewhere we do not control, which is
   * exactly what went wrong: they paid, the plan moved, and the moment was spent on an
   * empty room.
   *
   * So the plan they last saw is remembered in this browser, and if it has gone UP by the
   * time they next open this page, they get the moment then. It does not matter how they got
   * back — a redirect, the back button, a bookmark the next morning. The upgrade is
   * acknowledged on our own site, once.
   *
   * ALLOWANCE, NOT PRICE, is what decides whether this was an upgrade. It is on the
   * entitlement we already hold, so there is no dependency on the plan list having loaded
   * or on a code still being purchasable — and a queued downgrade applying at renewal
   * lowers it, which correctly says nothing.
   */
  /**
   * At most once per visit, from whichever of the three triggers gets there first: the poll
   * after a first purchase, the poll after an upgrade, or the backstop below. They can all
   * be describing the SAME change, and firing twice would restart the animation halfway
   * through — which looks like a glitch rather than a flourish.
   */
  const celebrated = useRef(false);
  const celebrate = useCallback((title: string, detail: string) => {
    if (celebrated.current) return;
    celebrated.current = true;
    setParty({ tone: 'good', title, detail });
  }, []);

  /*
    THE FAILURE ANNOUNCER IS GONE, because only one thing raised failures from a poll and
    that poll no longer exists. A plan change cannot fail now - it charges nothing - and a
    failed checkout arrives back here with `?status=`, handled in the arrival effect above,
    which calls `setParty` directly.
  */

  useEffect(() => {
    if (!mine) return;
    const ent = mine.entitlement;
    const now = { code: ent.plan_code ?? '', allowance: ent.minutes_allowance };
    if (!now.code) return;

    let seen: { code?: string; allowance?: number } | null = null;
    try {
      const raw = window.localStorage.getItem('vs.plan.seen');
      seen = raw ? (JSON.parse(raw) as { code?: string; allowance?: number }) : null;
      window.localStorage.setItem('vs.plan.seen', JSON.stringify(now));
    } catch {
      // Private mode, or storage full. The polls still cover the common case; this is the
      // safety net, and a safety net that throws is worse than one that is absent.
      return;
    }

    // No record means this browser has never seen the account, which is not an upgrade —
    // it is the first look. Nothing to celebrate, and the line above has now recorded it.
    if (!seen?.code || seen.code === now.code) return;
    if (typeof seen.allowance !== 'number' || now.allowance <= seen.allowance) return;

    celebrate(
      `You have upgraded to ${ent.plan_name}`,
      `${ent.minutes_left.toFixed(2)} minutes ready to use.`,
    );
  }, [mine, celebrate]);

  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    let tries = 0;
    const tick = async () => {
      if (stop) return;
      tries += 1;
      const m = await load();
      if (stop) return;
      // A paid plan is the signal. Nothing else can flip is_free from a webhook.
      if (m && !m.entitlement.is_free) {
        setWaiting(false);
        toast.success('Your plan is active', {
          description: `You are on ${m.entitlement.plan_name}.`,
        });
        celebrate(
          `You are on ${m.entitlement.plan_name}`,
          `${m.entitlement.minutes_left.toFixed(2)} minutes ready to use.`,
        );
        return;
      }
      if (tries >= 15) {
        setWaiting(false);
        // THE BANNER USED TO SIMPLY VANISH HERE. Thirty seconds of "confirming", then an
        // empty page and a plan that still said free, with nothing to read and nothing to
        // do. Whatever else is true, the customer is owed a sentence.
        //
        // It does not claim the payment failed, because we do not know that: the far more
        // likely cause is a notification still in flight. It says what is true and what
        // happens next.
        setPayNote({
          tone: 'info',
          text:
            'We have not had confirmation of your payment yet. If it went through, your ' +
            'plan will update here on its own — refreshing is safe.',
        });
        return;
      }
      window.setTimeout(() => void tick(), 2000);
    };
    window.setTimeout(() => void tick(), 1000);
    return () => {
      stop = true;
    };
    // Runs once, when we arrive from a payment. `load` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  async function buy(code: string) {
    // THE ONE PLACE A STALE TAB IS NOT MERELY UNTIDY, and the reason the version check
    // exists at all. This exact page, running code the server had replaced, took a
    // customer's click, asked the server for a payment page, and threw the link away
    // because the version it was running had no redirect in it. No error, no payment, no
    // way for anyone to tell what had happened.
    //
    // So a payment does not start on code we know to be superseded. Checked here rather
    // than trusting the bar at the bottom of the screen, because that bar can be
    // dismissed and dismissing a notice must not make it safe to lose a sale.
    if (useBuild.getState().stale) {
      toast.message('Please refresh before paying', {
        description:
          'This page has been open a while and we have since made some improvements. ' +
          'Refresh and choose your plan again.',
        duration: 10_000,
        action: { label: 'Refresh', onClick: reloadForNewBuild },
      });
      return;
    }
    setBusy(code);
    setError(null);
    try {
      const res = await api.billing.checkout(code);
      if (res.checkout_url) {
        // THE PROVIDER'S OWN PAGE, SHOWN OVER THIS ONE. Card, UPI and bank details are
        // entered inside their iframe and never touch anything of ours, so this keeps the
        // whole service out of PCI scope exactly as the redirect did.
        //
        // A first purchase DOES have a working return url, so unlike the upgrade this one
        // was not broken. It moves to the overlay anyway for a plainer reason: a customer
        // who never leaves cannot be lost on the way back, and the celebration lands on
        // the page they are already looking at instead of after a round trip.
        // `busy` is deliberately left set: the navigation is already under way, and
        // clearing it would flash the button back to life for the instant before the page
        // goes away. The return trip is handled by `readArrival` on the way back in.
        toast.message('Taking you to the payment page', {
          description: 'Your plan changes once the payment is confirmed.',
        });
        goToPaymentPage(res.checkout_url);
        return;
      }
      if (res.live) {
        // Configured, but with no page to send anyone to. Reachable on a provider that
        // expects a client-side SDK handoff instead of a redirect.
        toast.success('Payment started', {
          description: 'Continue in the payment window to finish.',
        });
      } else {
        // WHAT THIS NO LONGER SAYS: "no payment keys are configured. Your plan changes
        // only when the provider's signed webhook arrives." That named our integration
        // state and the mechanism behind it, neither of which a customer can do anything
        // with. They need to know they have not been charged and nothing has changed.
        toast.message('Paid plans are not open yet', {
          description:
            'Nothing was charged and your plan has not changed. We will announce it here as soon as they are available.',
          duration: 8000,
        });
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Checkout failed.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * CHANGING PLAN IS NOT BUYING A PLAN, and this page has to keep them apart.
   *
   * Someone who already pays monthly does not go back to a payment page to move up a
   * tier: the subscription they have is moved, and the card already on file is charged
   * for the difference. Sending them through checkout instead is what produced four
   * simultaneous mandates on one account in testing — four monthly debits, one customer.
   *
   * Which one applies is decided by whether they hold a monthly subscription, not by
   * which button looks nicer.
   */
  // THE SERVER DECIDES THIS, not the page.
  //
  // This used to be worked out here: monthly plan, active, not free. It missed the two
  // states that make the server refuse anyway — a change already in flight, and a plan set
  // to end — so the button was drawn, the request was refused, and the refusal arrived as
  // a server error. `can_change_plan` and `change_blocked_reason` come from /api/billing/me
  // where all three conditions live together and cannot drift apart from the code that
  // enforces them.
  const canChange = mine?.can_change_plan === true;
  const blockedWhy = mine?.change_blocked_reason ?? null;

  const [change, setChange] = useState<{ plan: Plan; preview: PlanChangePreview } | null>(
    null,
  );

  // Focus is the Modal's job now, not this page's. It moves focus to the first control
  // in the dialog on open and gives it back to the trigger on close — see ui/Modal.tsx.

  /**
   * Ask what it would cost, and show that before anything is charged.
   *
   * The figure has to come from the provider. Our own subtraction gets ₹500.00 where the
   * real charge is ₹500.27, because the amount round-trips through the settlement
   * currency — and a customer who is quoted one number and charged another is right to
   * dispute it.
   */
  async function askChange(plan: Plan) {
    if (useBuild.getState().stale) {
      toast.message('Please refresh first', {
        description:
          'This page has been open a while and we have since made some improvements. ' +
          'Refresh and choose again.',
        duration: 10_000,
        action: { label: 'Refresh', onClick: reloadForNewBuild },
      });
      return;
    }
    setBusy(plan.code);
    setError(null);
    try {
      setChange({ plan, preview: await api.billing.previewChange(plan.code) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not work that out.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Schedule a plan change for the renewal. Charges nothing, so there is nothing to open.
   *
   * WHAT USED TO BE HERE, AND WHY NONE OF IT IS ANY MORE. An upgrade used to be paid for
   * immediately, on a provider page that carries no return url — so this function claimed a
   * blank tab on the click (the only moment a popup is permitted), wrote a holding message
   * into it, pointed it at the payment link once the request came back, closed it again on
   * every path that turned out not to have a link, and started a poll so that whichever tab
   * the customer came back to would show the outcome. All of that existed to work around one
   * thing: a payment mid-period.
   *
   * There is no payment mid-period now. Both directions take effect at the renewal, nothing
   * is charged today, and the response says so — so the honest version of this function is a
   * request, a sentence, and a reload. Wanting more minutes before the renewal is a top-up,
   * which is an ordinary checkout with a real return url.
   */
  async function confirmChange() {
    if (!change) return;
    const { plan } = change;
    setBusy('confirm-change');
    try {
      const res = await api.billing.change(plan.code);
      setChange(null);
      toast.success(`${plan.name} from ${onDay(res.effective_at ?? '')}`, {
        description:
          res.kind === 'upgrade'
            ? 'Nothing was charged today. Need minutes before then? Add extra minutes to your current plan.'
            : 'Nothing was charged today, and your current plan continues until then.',
      });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change your plan.');
    } finally {
      setBusy(null);
    }
  }

  async function undoChange() {
    setBusy('undo-change');
    try {
      const res = await api.billing.cancelChange();
      toast.success(`Staying on ${res.plan_name}`, { description: res.note });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not undo that.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Take a cancellation back, so the plan renews again.
   *
   * Without this, pressing "Stop auto-renew" is a one-way door: the provider refuses every
   * plan change on a subscription that is set to end, so the customer can neither change
   * plan nor undo the cancellation, and the only exit is to let it lapse and buy again.
   */
  async function resume() {
    setBusy('resume');
    try {
      const res = await api.billing.resume();
      toast.success(res.already ? 'Your plan already renews' : 'Your plan will renew', {
        description:
          res.note ?? 'You can change or cancel it any time.',
      });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not restart that.');
    } finally {
      setBusy(null);
    }
  }

  /*
    THE UPGRADE-CONFIRMATION POLL IS GONE, along with the thing it was waiting for.

    It ran for thirty seconds after a plan change, watching for the plan code to move, and
    it existed because an upgrade took money mid-period on a page with no return url — so
    the customer might never come back here and the page had to work the outcome out for
    itself. It also had to handle the charge failing, and the charge neither clearing nor
    failing, which is the state an off-session debit sits in while it waits for the
    cardholder to authenticate.

    A plan change now takes effect at the renewal and charges nothing, so there is no
    outcome to wait for: the answer is on screen the moment the request returns. Buying a
    plan and buying extra minutes both come back through `?from=checkout`, which the
    `waiting` banner above already handles and which does have a return url.
  */

  /**
   * Open the hosted billing area: invoices, receipts, and the card on file.
   *
   * A fresh link per click because they expire. Navigates in this tab rather than opening
   * a new one — a popup blocker eats a `window.open` that happens after an await, which
   * would look exactly like the button doing nothing, and that failure mode has already
   * cost enough on this page.
   */
  async function openPortal() {
    setBusy('portal');
    try {
      const res = await api.billing.portal();
      window.location.assign(res.url);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not open your billing history.',
      );
      setBusy(null);
    }
  }

  /**
   * Buy a pack of extra minutes. An ordinary one-time checkout with a real return url.
   *
   * The same page a first purchase uses, and the same build check in front of it: a stale
   * tab asking for a payment page it does not know how to open is how a sale gets lost
   * silently, and that has already happened once on this page.
   */
  async function buyTopup(code: string) {
    if (useBuild.getState().stale) {
      toast.message('Please refresh before paying', {
        description:
          'This page has been open a while and we have since made some improvements. ' +
          'Refresh and choose again.',
        duration: 10_000,
        action: { label: 'Refresh', onClick: reloadForNewBuild },
      });
      return;
    }
    setBusy(code);
    setError(null);
    try {
      const res = await api.billing.topup(code);
      if (res.checkout_url) {
        toast.message('Taking you to the payment page', {
          description: `${res.minutes} extra minutes are added once the payment is confirmed.`,
        });
        // `busy` is left set on purpose: the navigation is under way, and clearing it would
        // flash the button back to life for the instant before the page goes.
        goToPaymentPage(res.checkout_url);
        return;
      }
      // No url means the provider is in a mode that mints local ids and has nowhere to send
      // anybody — the operator's own testing state. Say what is true rather than nothing.
      toast.message('Nothing to pay just now', { description: res.note });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start that purchase.');
    } finally {
      setBusy(null);
    }
  }

  /** Set by the Cancel subscription button; cleared by the modal. */
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function cancel() {
    setBusy('cancel');
    try {
      const res = await api.billing.cancel();
      setConfirmCancel(false);
      // "No more payments" rather than "auto-renew is off" — the customer's question is
      // whether money will leave their account again, and that is now genuinely answered:
      // the request goes to the provider first and the mandate is stopped there.
      toast.success('No further payments will be taken', {
        description:
          res.note ??
          `Your access continues until ${res.keeps_access_until ?? res.ends ?? 'the period ends'}.`,
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel.');
    } finally {
      setBusy(null);
    }
  }

  if (error && !plans) {
    return (
      <div className="px-5 py-8 sm:px-8 lg:px-10">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }

  if (!plans || !mine) {
    return (
      <div className="space-y-4 px-5 py-8 sm:px-8 lg:px-10">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-28" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  const shown = plans.plans.filter((p) => p.interval === interval && p.purchasable);
  const ent = mine.entitlement;

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      {/* Portals to <body>, so it is rendered here only to keep it next to the state
          that drives it. It cannot be clipped by anything on this page. */}
      <Celebrate
        open={party !== null}
        tone={party?.tone ?? 'good'}
        title={party?.title ?? ''}
        detail={party?.detail}
        onDone={() => setParty(null)}
      />

      <header className="mb-7">
        <h1 className="text-h3">Plan &amp; billing</h1>
        <p className="mt-1.5 text-body text-fg-muted">
          Every minute you use is accounted for, so a refund is always explainable.
        </p>
      </header>

      {/*
        THE SERVER'S OWN SENTENCE, WITH NOTHING ADDED. This used to be prefixed with
        "Payments are in test mode." — which tells a customer about the state of our
        integration rather than about them, and is precisely the kind of internal detail
        that has been taken out of everything else they read. The message already says
        the useful part: nothing can be bought yet and nothing has been charged.
      */}
      {/*
        Shown only while we are still waiting to hear that a payment went through, and it
        deliberately does not claim it did. "Confirming" is the whole of what we know.
      */}
      {waiting && (
        <div className="mb-6">
          <InfoNote>
            Confirming your payment. This usually takes a few seconds and this page will
            update on its own.
          </InfoNote>
        </div>
      )}

      {/*
        The outcome of the payment we have just come back from. This is the half of the
        redirect fix that is easy to miss: sending the customer back here on FAILURE as
        well as on success means this page has to be able to say so, or a declined card
        just looks like a page that forgot what it was doing.
      */}
      {payNote && (
        <div className="mb-6">
          {payNote.tone === 'bad' ? (
            <ErrorNote>{payNote.text}</ErrorNote>
          ) : (
            <InfoNote>{payNote.text}</InfoNote>
          )}
        </div>
      )}

      {/*
        A STATUS, NOT A FAILURE, and it used to be drawn as one.

        This sentence says paid plans have not opened yet. That is a standing fact about
        where the product is, true for weeks at a time and true on a page where nothing has
        gone wrong — so an `ErrorNote` was the wrong container for it. In red it reads as
        "something just broke", and directly beneath the genuine red notice about a payment
        that failed it read as part of that failure. It was reported as an error, which is
        exactly what the styling claimed it was.

        Ordered after the payment note on purpose: when both are on screen, the thing that
        just happened should be the first thing read.
      */}
      {plans.warning && (
        <div className="mb-6">
          <InfoNote>{plans.warning}</InfoNote>
        </div>
      )}

      {/* current plan */}
      <Card className="mb-7 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-h5">{ent.plan_name}</h2>
              {ent.is_free ? <Badge tone="neutral">Free</Badge> : <Badge tone="brand">Active</Badge>}
              {!ent.is_free && !ent.auto_renew && <Badge tone="warn">Does not renew</Badge>}
            </div>
            <p className="mt-2 text-small text-fg-muted">
              {/*
                The plan's own minutes, with any bought on top named separately. `minutes_left`
                is the sum of both now, and "30.00 of 10 minutes left" reads as a bug — see the
                same note in AppShell.tsx.
              */}
              {ent.minutes_plan_left.toFixed(2)} of {ent.minutes_allowance} minutes left
              {ent.minutes_topup_left > 0 &&
                ` + ${ent.minutes_topup_left.toFixed(2)} extra`}{' '}
              · longest video {Math.floor(ent.max_video_seconds / 60) || 1} min · videos kept{' '}
              {ent.retention_days < 1
                ? `${ent.retention_days * 24} hours`
                : `${ent.retention_days} days`}
            </p>
            {mine.what_happens_next && (
              <p className="mt-2 text-small text-fg-subtle">{mine.what_happens_next}</p>
            )}
          </div>

          {/*
            One button or the other, never both. `can_resume` is true exactly when the
            plan is monthly and set to end — the state in which the provider refuses every
            plan change, so offering the way back matters more here than anywhere else on
            the page.
          */}
          {mine.can_resume ? (
            <Button onClick={resume} loading={busy === 'resume'}>
              Keep my plan
            </Button>
          ) : (
            ent.auto_renew && (
              /*
                IRIS, WHICH BREAKS THE HOUSE RULE FOR IT ON PURPOSE.

                The rule in ui/Button.tsx reserves iris for the single highest-intent action
                on a page. This is not that — it is a customer leaving. It is iris anyway
                because it was asked for as the filled blue button, and because the previous
                version had the opposite problem: "Stop auto-renew" in `secondary` was a grey
                outline that read as chrome, so people could not find how to cancel and wrote
                in to ask. A cancel button nobody can find is not a kindness.

                It does not collide: the plan cards on this page use `primary`, so iris is
                still used once here.

                The words changed too. "Stop auto-renew" describes a setting; "Cancel
                subscription" describes what the person came to do.
              */
              <Button variant="iris" onClick={() => setConfirmCancel(true)}>
                Cancel subscription
              </Button>
            )
          )}
        </div>

        {/*
          Why a plan change is not on offer, when it is not. Shown rather than left to be
          discovered by pressing a button that answers an error — which is what happened,
          six times, before the rate limit stopped it.

          Skipped for the ordinary "only monthly plans can be changed" case: an annual
          customer has not asked to change anything, and the annual note below already
          explains how those work.
        */}
        {blockedWhy && !mine.scheduled_change && mine.can_resume && (
          <p className="mt-4 border-t border-ink-700 pt-4 text-small text-warn">
            Your plan is set to end on {onDay(ent.period_end ?? mine.subscription?.current_period_end ?? '')},
            so it cannot be changed yet. Choose <span className="font-medium">Keep my plan</span> first.
          </p>
        )}

        {/*
          A CHANGE THEY HAVE ASKED FOR AND NOT YET RECEIVED.

          Both kinds are shown, and they are not the same promise. A downgrade has a date
          and can be called off. An upgrade is a payment already authorised, so it says
          only that we are confirming it — offering an Undo would be a promise we cannot
          keep, which is why `can_undo` comes from the server rather than being inferred
          from the kind here.
        */}
        {mine.scheduled_change && (
          <div className="mt-5 border-t border-ink-700 pt-4" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-small text-fg-muted">
                {/*
                  ONE SENTENCE FOR BOTH DIRECTIONS, because both are now the same thing: a
                  change queued for the renewal that charges nothing today. There used to be
                  three branches here — a queued downgrade, an upgrade waiting on a payment
                  page, and an upgrade being confirmed off-session — and the last two only
                  existed because an upgrade took money mid-period. It does not any more.

                  `payment_link` can still be non-null for a subscription that was mid-upgrade
                  when this shipped, which is what the Finish payment button below is for.
                */}
                <span className="font-medium text-fg">
                  Changing to {mine.scheduled_change.plan_name}
                </span>{' '}
                on {onDay(mine.scheduled_change.effective_at ?? '')}. Nothing is charged
                until then and your current plan continues.
                {mine.scheduled_change.kind === 'upgrade' && (
                  <> Need more minutes before then? Add extra minutes below.</>
                )}
              </p>
              {/*
                THE WAY BACK TO AN UNPAID PAGE, for a change started before this became
                renewal-only. Nothing creates one now. Without it a customer left mid-upgrade
                is stuck: the provider refuses every other change while that link is unpaid,
                so their only option would be to abandon the change entirely.
              */}
              {mine.scheduled_change.payment_link && (
                <Button
                  onClick={() => {
                    const url = mine.scheduled_change?.payment_link;
                    if (!url) return;
                    goToPaymentPage(url);
                  }}
                >
                  Finish payment
                </Button>
              )}
              {mine.scheduled_change.can_undo && (
                <Button
                  variant="secondary"
                  onClick={undoChange}
                  loading={busy === 'undo-change'}
                >
                  {/*
                    "Stop waiting" survives only for the legacy case, where there really is a
                    payment we cannot recall and "Keep Starter" would imply we had cancelled
                    the charge. A queued change has no payment behind it, so calling it off
                    genuinely does mean nothing happens.
                  */}
                  {mine.scheduled_change.payment_link
                    ? 'Stop waiting'
                    : `Keep ${ent.plan_name}`}
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>

      {/*
        EXTRA MINUTES — the thing that replaced upgrading mid-month.

        WHY IT IS HERE AND NOT ON THE PLAN CARDS. Somebody who has run out of minutes on the
        18th does not want a different plan, they want to finish the video they are working
        on. Moving plan used to be the only way to ask for that, and it charged the difference
        immediately — which is the payment that could get stuck and lock every later change
        out. This is the same request with none of that: a one-time purchase that never
        touches the renewal.

        SHOWN ONLY TO SUBSCRIBERS, and the server decides. `available` is false with a reason
        for a free account, so the section renders the reason instead of a row of buttons
        nobody may press. Hidden entirely when the pack list could not be loaded.
      */}
      {topups && (
        <Card className="mb-7 p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-h5">Topup Extra minutes</h2>
            {topups.balance_minutes > 0 && (
              <p className="text-small text-fg-muted">
                <span className="font-medium tabular-nums text-fg">
                  {topups.balance_minutes.toFixed(2)}
                </span>{' '}
                extra minutes waiting
              </p>
            )}
          </div>
          <p className="mt-1.5 text-small leading-relaxed text-fg-muted">{topups.note}</p>

          {!topups.available ? (
            <div className="mt-4">
              {/*
                The server's own sentence, shown as-is. It knows which of the two reasons
                applies — no plan yet, or a balance already at the cap — and inventing a
                third wording here is how the two get confused.
              */}
              <InfoNote>{topups.message ?? 'Extra minutes are not available just now.'}</InfoNote>
            </div>
          ) : !topups.open ? (
            <div className="mt-4">
              <InfoNote>
                Paid plans are not open yet. You will be able to add minutes here when they
                are.
              </InfoNote>
            </div>
          ) : (
            <TopupPicker
              topups={topups}
              busy={busy}
              onBuy={(code) => void buyTopup(code)}
            />
          )}
        </Card>
      )}

      {/*
        LEAVING. A confirm step, because there is no undo that gets the month back — and a
        modal rather than `window.confirm`, which is what this was.

        The browser dialog was wrong for it twice over: it is unstyled and looks like the
        page has been hijacked at the exact moment somebody is deciding whether to trust us
        with another month, and on iOS it can be suppressed entirely, in which case the
        cancel button silently did nothing.
      */}
      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel your subscription?"
        footer={
          <>
            <Button variant="danger" onClick={cancel} loading={busy === 'cancel'}>
              Yes, cancel it
            </Button>
            <Button variant="secondary" onClick={() => setConfirmCancel(false)}>
              Keep my plan
            </Button>
          </>
        }
      >
        <p className="mt-3 text-small leading-relaxed text-fg-muted">
          <span className="font-medium text-fg">No further payments will be taken.</span> You
          keep {ent.plan_name} and your{' '}
          <span className="tabular-nums">{ent.minutes_left.toFixed(2)}</span> remaining minutes
          until{' '}
          {onDay(ent.period_end ?? mine.subscription?.current_period_end ?? '')} — you have
          paid for that time and it stays yours.
        </p>
        <p className="mt-2 text-small leading-relaxed text-fg-muted">
          After that date your account drops to the free plan.
          {ent.minutes_topup_left > 0 && (
            <>
              {' '}
              The{' '}
              <span className="tabular-nums">{ent.minutes_topup_left.toFixed(2)}</span> extra
              minutes you bought are part of this plan, so they end with it too.
            </>
          )}
        </p>
        <p className="mt-2 text-tiny text-fg-subtle">
          You can change your mind any time before that date — the button turns into “Keep my
          plan”.
        </p>
      </Modal>

      {/*
        THE CONFIRM STEP, AND THE ONLY PLACE A PRICE FOR A CHANGE IS SHOWN.

        A MODAL, AND THE REASON IS A REAL FAILURE. This was an inline card here, on the
        grounds that a dialog needs focus trapping and aria wiring that the app had no
        primitive for. What that missed is that this page is long: somebody scrolled down
        to the plan cards pressed "Upgrade to Pro", the card rendered up here off screen,
        and it looked as though the button did nothing. It had not done nothing — the
        request had already succeeded — so they pressed it five more times, and every
        retry was refused by the provider because a change was already in flight.

        Focusing the confirm button was meant to scroll it into view. `focus()` does that
        on desktop and not on iOS Safari, which is where it happened.

        So the primitive got written. See ui/Modal.tsx: portal to <body>, fixed and
        centred, focus trapped, Escape and backdrop close, focus restored on the way out.
        It cannot be off screen no matter where the page is scrolled.
      */}
      <Modal
        open={!!change}
        onClose={() => setChange(null)}
        title={
          change
            ? `${change.preview.kind === 'upgrade' ? 'Move up to' : 'Change to'} ${change.preview.plan_name}`
            : ''
        }
        footer={
          change ? (
            <>
              <Button onClick={confirmChange} loading={busy === 'confirm-change'}>
                {/*
                  Always the date, never a price. A plan change charges nothing now, in
                  either direction, so "Pay ₹700" is a button that no longer exists.
                */}
                Switch on {onDay(change.preview.effective_at ?? '')}
              </Button>
              <Button variant="secondary" onClick={() => setChange(null)}>
                Cancel
              </Button>
            </>
          ) : null
        }
      >
        {/*
          ONE BRANCH, because a plan change now costs nothing whichever way it goes. There
          used to be a second one showing the difference between the two plans as an amount
          due immediately, with an "approximately" caveat for when the provider could not be
          asked for the exact figure. All of that went with the mid-period charge.

          The upgrade case gains one extra line: somebody moving UP wants the minutes now,
          and the honest answer is that the plan change is not how to get them.
        */}
        {change && (
          <>
            <p className="mt-3 text-small text-fg-muted">
              <span className="font-medium text-fg">Nothing is charged today.</span> You stay
              on {ent.plan_name} with your {ent.minutes_left.toFixed(2)} remaining minutes
              until{' '}
              {onDay(change.preview.effective_at ?? mine.subscription?.current_period_end ?? '')}
              , and {change.preview.plan_name} starts then at{' '}
              {rupees(change.plan.price_paise)}
              {change.plan.price_excludes_tax ? ' plus GST' : ''} a month
              {change.preview.minutes_after > 0
                ? ` with ${change.preview.minutes_after.toFixed(0)} minutes`
                : ''}
              .
            </p>
            {change.preview.kind === 'upgrade' && (
              <p className="mt-2 text-small text-fg-muted">
                Need more minutes before that date? Add extra minutes to the plan you are on
                instead — they are used after your monthly minutes run out and do not expire
                while your plan is running.
              </p>
            )}
            <p className="mt-2 text-tiny text-fg-subtle">
              You can change your mind any time before that date.
            </p>
          </>
        )}
      </Modal>

      {/* interval switch */}
      <div className="mb-5 flex items-center gap-3">
        <div className="flex gap-1 rounded-full border-2 border-ink-600 bg-ink-900 p-1">
          {(['month', 'year'] as const).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setInterval(i)}
              aria-pressed={interval === i}
              className={clsx(
                'rounded-full px-4 py-1.5 text-tiny transition-[background-color,color] duration-[160ms] ease-[var(--ease-out-strong)]',
                interval === i ? 'bg-ink-800 font-medium text-fg' : 'text-fg-muted hover:text-fg',
              )}
            >
              {i === 'month' ? 'Monthly' : 'Annual'}
            </button>
          ))}
        </div>
        {interval === 'year' && <Badge tone="good">Save 20%</Badge>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {shown.map((p) => {
          const current = p.code === ent.plan_code;
          const currentPlan = plans.plans.find((x) => x.code === ent.plan_code);
          const switching = canChange && !current && p.interval === 'month';
          const dearer = !!currentPlan && p.price_paise > currentPlan.price_paise;
          // A monthly customer whose change the server would refuse. Distinct from
          // "annual, so not changeable at all", which is not a blocked state — those
          // customers are buying, not switching.
          const blocked =
            !current &&
            p.interval === 'month' &&
            !!currentPlan &&
            currentPlan.interval === 'month' &&
            !canChange;
          return (
            <Card
              key={p.code}
              className={clsx(
                'flex flex-col p-6 transition-[border-color] duration-[250ms] ease-[var(--ease-out-strong)]',
                current ? 'border-ink-600' : 'hover:border-ink-750',
              )}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-h5">{p.name}</h3>
                {current && <Badge tone="brand">Your plan</Badge>}
              </div>

              <p className="mt-4 flex items-baseline gap-1.5">
                <span className="text-h3 tabular-nums leading-none">
                  {rupees(p.price_paise)}
                </span>
                <span className="text-small text-fg-subtle">
                  /{p.interval === 'month' ? 'month' : 'year'}
                </span>
              </p>
              {/*
                Same reason as the marketing pricing page: the figure above is net of GST,
                so the customer would otherwise be quoted one number here and charged
                about a fifth more at the payment page.
              */}
              {p.price_excludes_tax && (
                <p className="mt-1 text-tiny text-fg-subtle">
                  + {p.tax_percent}% GST · about{' '}
                  <span className="tabular-nums">{rupees(p.price_with_tax_paise)}</span>{' '}
                  total
                </p>
              )}

              <ul className="mt-5 flex-1 space-y-2.5 text-small text-fg-muted">
                <Line>{p.minutes_per_period} minutes {p.interval === 'month' ? 'a month' : 'a year'}</Line>
                <Line>Videos up to {Math.floor(p.max_video_seconds / 60)} minutes</Line>
                <Line>Kept for {p.output_retention_days} days</Line>
                <Line>Unlimited downloads while kept</Line>
                <Line>Speaker voice cloning</Line>
              </ul>

              <p
                className={clsx(
                  'mt-4 text-tiny leading-relaxed',
                  p.auto_renews ? 'text-fg-subtle' : 'text-warn',
                )}
              >
                {p.renewal_note}
              </p>

              {/*
                DISABLED WHEN BUYING IS NOT OPEN TO THIS VISITOR, which is a narrower
                question than whether payments are configured — see PlansResponse.open.
                A live-looking button that answers 403 is worse than one that plainly
                is not ready yet, and the notice at the top of the page already says
                why. The server refuses it either way; this is so nobody has to find
                that out by clicking.
              */}
              {/*
                A CHANGE, NOT A PURCHASE, whenever there is a subscription to change.
                `switching` is true only for a monthly customer looking at another
                monthly plan; everything else — free accounts, annual plans, moving
                between intervals — is still a purchase, because there is no mandate to
                move in those cases.
              */}
              {/*
                DISABLED WHEN THE SERVER WOULD REFUSE IT. `blocked` is true when this
                customer holds a monthly plan but a change cannot be made right now — a
                change already in flight, or a plan set to end. Both used to draw a live
                button that answered an error, and the error read as an outage.
              */}
              <Button
                className="mt-5 w-full"
                variant={current ? 'secondary' : 'primary'}
                disabled={current || !plans.open || blocked}
                loading={busy === p.code}
                onClick={() => (switching ? askChange(p) : buy(p.code))}
                title={blocked && blockedWhy ? blockedWhy : undefined}
              >
                {current
                  ? 'Current plan'
                  : !plans.open
                    ? 'Not open yet'
                    : blocked
                      ? mine.scheduled_change
                        ? 'Change in progress'
                        : 'Plan is ending'
                      : switching
                        ? dearer
                          ? `Upgrade to ${p.name}`
                          : `Switch to ${p.name}`
                        : `Choose ${p.name}`}
              </Button>
            </Card>
          );
        })}
      </div>

      {interval === 'year' && (
        <div className="mt-5">
          <InfoNote>
            <span className="font-medium">Why annual is a one-off payment. </span>
            Recurring debits above ₹15,000 need the customer to authenticate again on
            every charge, and nobody is there to do that on a renewal — so the charge
            would quietly fail and the subscription would lapse without anyone deciding
            to cancel. A one-off payment is not affected by that rule, so we use one and
            email you at 14 days, 3 days and on the day. Your access continues for 7 days
            past the end date.
          </InfoNote>
        </div>
      )}

      {/* payments */}
      <Card className="mt-7 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-small font-medium">Payments</h2>
            <p className="mt-0.5 text-tiny text-fg-subtle">
              Real money only. A refund is shown as its own entry rather than changing the
              original, so your history always adds up.
            </p>
          </div>
          {/*
            Invoices, receipts and changing the card on file all live on the payment
            provider's own hosted page. Offered rather than rebuilt: it also clears a
            subscription put on hold by a failed payment, which is otherwise a support
            email every time. Only shown once there is something to look at.
          */}
          {mine.payments.length > 0 && (
            <Button variant="ghost" onClick={openPortal} loading={busy === 'portal'}>
              Invoices &amp; payment method
            </Button>
          )}
        </div>
        {mine.payments.length === 0 ? (
          <EmptyState title="No payments yet" body="You are on the free plan." />
        ) : (
          /*
            THIS TABLE WAS UNREADABLE AND UNREACHABLE ON A PHONE, which is a worse
            combination than either alone.

            Five columns at `px-5` spend 200px on horizontal padding before a single
            character of content. At 360px, minus the page's own padding, that left
            ~120px for five cells — so the browser crushed the columns rather than
            scrolling. And because the Card around it is `overflow-hidden`, whatever
            could not be crushed was CLIPPED: not scrolled off, gone. The amount
            column, which is the only reason to look at a payments table, was the one
            that went.

            Two fixes, the same pair JobsTable.tsx documents:

              1. `overflow-x-auto` here, INSIDE the Card's overflow-hidden, so the
                 table gets its own scroll context and dragging works.
              2. Columns drop out narrow, cheapest information first. Plan and Method
                 are context; when, status and amount are the point. Padding tightens
                 to px-4 below sm as well, which buys back 40px on its own.
          */
          <div className="overflow-x-auto">
            <table className="w-full text-left text-small">
              <thead>
                <tr className="border-b border-ink-700 text-eyebrow uppercase text-fg-subtle">
                  <th className="px-4 py-2.5 font-medium sm:px-5">When</th>
                  <th className="hidden px-4 py-2.5 font-medium sm:table-cell sm:px-5">
                    Plan
                  </th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell md:px-5">
                    Method
                  </th>
                  <th className="px-4 py-2.5 font-medium sm:px-5">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium sm:px-5">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700">
                {mine.payments.map((p) => (
                  <tr key={p.provider_payment_id}>
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted sm:px-5">
                      {when(p.at)}
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell sm:px-5">
                      {p.plan_code ?? '—'}
                    </td>
                    <td className="hidden px-4 py-3 text-fg-muted md:table-cell md:px-5">
                      {p.method ?? '—'}
                    </td>
                    <td className="px-4 py-3 sm:px-5">
                      <Badge tone={p.amount_paise < 0 ? 'warn' : 'good'}>{p.status}</Badge>
                    </td>
                    <td
                      className={clsx(
                        'whitespace-nowrap px-4 py-3 text-right tabular-nums sm:px-5',
                        p.amount_paise < 0 && 'text-warn',
                      )}
                    >
                      {rupees(p.amount_paise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {mine.subscription && (
        <p className="mt-5 text-tiny text-fg-subtle">
          Period {onDay(mine.subscription.current_period_start)} –{' '}
          {onDay(mine.subscription.current_period_end)}
          {mine.subscription.grace_until && (
            <> · access continues until {onDay(mine.subscription.grace_until)}</>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Choose a pack, then confirm it.
 *
 * WHY A DROPDOWN AND NOT SIX CARDS. Six cards each carrying their own Add button is six
 * primary actions on one row, and the grid gave the sixty-minute pack exactly the same visual
 * weight as the ten — so the only way to compare them was to read all six. A closed control
 * says "there is one decision here", the list makes the ladder readable top to bottom, and
 * the price of the thing about to be bought is stated once, next to the button that buys it.
 *
 * TWO STEPS ON PURPOSE. Picking is reversible and costs nothing; paying is neither. The old
 * grid put a live Add button under the pointer for every pack, so a misplaced click was a
 * payment page. Now the confirm button is the only thing that starts one, it names the
 * amount, and it is inert until something is chosen.
 *
 * The panel is `.material-raised` — the same glass the dialogs and toasts use, which is the
 * class the house style reserves for surfaces floating ABOVE the page rather than sitting on
 * it. It scales out of `--transform-origin`, which Base UI sets to the trigger, so it reads
 * as having come out of the control that was pressed instead of appearing from nowhere.
 */
function TopupPicker({
  topups,
  busy,
  onBuy,
}: {
  topups: TopupsResponse;
  busy: string | null;
  onBuy: (code: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const room = topups.cap_minutes - topups.balance_minutes;
  const chosen = topups.packs.find((p) => p.code === picked) ?? null;
  const smallest = Math.min(...topups.packs.map((p) => p.minutes));

  /*
    A DEAD END THE SERVER CANNOT SEE. It reports `available: false` only when there is NO room
    at all; with, say, five minutes of room every pack is still refusable but buying is
    technically open. The picker would then offer six greyed rows under a button that never
    lights up, which reads as broken rather than as full.
  */
  if (room < smallest) {
    return (
      <div className="mt-4">
        <InfoNote>
          You are holding {topups.balance_minutes.toFixed(2)} unused extra minutes, and the
          smallest pack is {smallest}. Use some of those and you can add more — the ceiling is{' '}
          {topups.cap_minutes} unused minutes at a time.
        </InfoNote>
      </div>
    );
  }
  // A pack already chosen and then rendered unaffordable — the balance moved under it, which
  // happens after a purchase completes and the page reloads. Treated as nothing chosen rather
  // than left selected under a disabled button, which would read as the button being broken.
  const tooBig = !!chosen && chosen.minutes > room;

  return (
    <>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        {/*
          NO `items` PROP. It exists so `Select.Value` can look a label up from a map, and it
          is dead the moment `Select.Value` is given a render function — which it is below,
          because the placeholder needs its own colour and a map cannot carry styling. Passing
          both would leave a future reader with two plausible sources for the trigger's text
          and one of them silently ignored.
        */}
        <Select.Root
          value={picked}
          onValueChange={(v) => setPicked((v as string | null) ?? null)}
        >
          <Select.Trigger
            className={clsx(
              'group/sel flex h-12 w-full items-center justify-between gap-3 sm:max-w-sm',
              'rounded-full border border-ink-600 bg-ink-800 px-5 text-body text-fg',
              'transition-[border-color,background-color,transform] duration-[160ms]',
              'ease-[var(--ease-out-strong)]',
              'hover:border-ink-500 hover:bg-ink-750',
              // Feedback on the PRESS, not on release. §1 of the apple-design skill: the
              // moment this waits for `click` the control stops feeling direct.
              'active:scale-[0.99]',
              'focus-visible:border-fg-subtle focus-visible:outline-none',
              'data-[popup-open]:border-ink-500',
              'motion-reduce:transition-none motion-reduce:active:scale-100',
            )}
            aria-label="Choose how many extra minutes to add"
          >
            <Select.Value>
              {(value: unknown) =>
                value ? (
                  <span className="tabular-nums">
                    {topups.packs.find((p) => p.code === value)?.minutes} minutes
                  </span>
                ) : (
                  <span className="text-fg-subtle">Choose how many minutes</span>
                )
              }
            </Select.Value>
            <Select.Icon
              className="shrink-0 text-fg-subtle transition-transform duration-[200ms] ease-[var(--ease-out-strong)] group-data-[popup-open]/sel:rotate-180 motion-reduce:transition-none"
              render={
                <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
                  <path
                    d="m6 9 6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              }
            />
          </Select.Trigger>

          <Select.Portal>
            <Select.Positioner
              sideOffset={8}
              /*
                ANCHORED TO THE TRIGGER, NOT TO THE SELECTED ITEM. Base UI's default lines the
                chosen row up over the closed control, which is the native macOS behaviour —
                but it means the panel jumps to a different place depending on what is already
                selected, and on a short viewport it can cover the confirm button it is meant
                to feed.
              */
              alignItemWithTrigger={false}
              className="z-50 w-[min(24rem,calc(100vw-2rem))]"
            >
              <Select.Popup
                className={clsx(
                  // The glass. Same material as the dialogs, for the same reason: this floats
                  // above the page rather than sitting on it. `.material-raised` brings the
                  // blur, the translucent fill, the bright top edge and the depth shadow —
                  // and, importantly, the `prefers-reduced-transparency` and
                  // `prefers-contrast` fallbacks that make it solid when asked.
                  'material-raised overflow-hidden rounded-[var(--radius-card)] p-1.5',
                  // The border is the dialogs' own, for the same reason they have one: on a
                  // near-black page the shadow alone does not define an edge.
                  'border border-ink-700',
                  'origin-[var(--transform-origin)]',
                  // Blur and scale together on the way in, so it reads as a material arriving
                  // rather than an opacity fade — §12, "materialize, don't just fade".
                  'transition-[opacity,transform] duration-[200ms] ease-[var(--ease-out-strong)]',
                  'data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0',
                  'data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0',
                  'motion-reduce:transition-none',
                )}
              >
                <Select.List>
                  {topups.packs.map((p) => {
                    const over = p.minutes > room;
                    return (
                      <Select.Item
                        key={p.code}
                        value={p.code}
                        disabled={over}
                        className={clsx(
                          'flex cursor-default items-center justify-between gap-4 rounded-xl',
                          'px-3.5 py-2.5 text-small outline-none',
                          'transition-colors duration-[120ms] ease-[var(--ease-out-strong)]',
                          'data-[highlighted]:bg-white/[0.07]',
                          'data-[disabled]:opacity-40',
                          'motion-reduce:transition-none',
                        )}
                      >
                        <span className="flex items-center gap-2.5">
                          {/*
                            The tick occupies its width whether or not it is shown, so choosing
                            a different row does not shift every label sideways.
                          */}
                          <span className="grid size-4 shrink-0 place-items-center">
                            <Select.ItemIndicator
                              render={
                                <svg
                                  viewBox="0 0 24 24"
                                  className="size-4 text-iris"
                                  fill="none"
                                  aria-hidden="true"
                                >
                                  <path
                                    d="m5 13 4 4L19 7"
                                    stroke="currentColor"
                                    strokeWidth="2.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              }
                            />
                          </span>
                          <Select.ItemText className="font-medium tabular-nums text-fg">
                            {p.minutes} minutes
                          </Select.ItemText>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block tabular-nums text-fg-muted">
                            {rupees(p.price_paise)}
                            {p.price_excludes_tax ? ' + GST' : ''}
                          </span>
                          {/*
                            The per-minute rate, sent by the server so the pricing page and
                            this list cannot round it two different ways. It is what makes the
                            ladder legible — the bigger packs are cheaper per minute, and
                            without it the customer has to do the division themselves.
                          */}
                          <span className="block text-tiny tabular-nums text-fg-subtle">
                            {over
                              ? `over your ${topups.cap_minutes} min cap`
                              : `₹${p.per_minute_rupees.toFixed(2)} a minute`}
                          </span>
                        </span>
                      </Select.Item>
                    );
                  })}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>

        {/*
          IRIS, AND THE ONE ON THIS CARD. It is the highest-intent action in this section and
          the only thing here that spends money, which is exactly what the variant is for.

          Inert until a pack is chosen. A live buy button with nothing selected has to invent
          a default, and a default next to a payment is a trap.
        */}
        <Button
          variant="iris"
          size="lg"
          className="w-full sm:w-auto"
          disabled={!chosen || tooBig}
          loading={!!chosen && busy === chosen.code}
          onClick={() => chosen && onBuy(chosen.code)}
        >
          {chosen && !tooBig
            ? `Add ${chosen.minutes} minutes · ${rupees(chosen.price_paise)}`
            : 'Add minutes'}
        </Button>
      </div>

      {/*
        WHAT THE CHOSEN PACK ACTUALLY COSTS, said once and next to the button that charges it.
        The big number on the button is net of GST because every price in this product is;
        leaving the customer to discover the rest at the payment page is the small lie that
        earns a chargeback.

        `aria-live` because this line changes as a result of choosing, and somebody using a
        screen reader has otherwise no way to know the total moved.
      */}
      <p className="mt-3 min-h-[1.25rem] text-small text-fg-muted" aria-live="polite">
        {chosen && !tooBig ? (
          <>
            <span className="tabular-nums">{rupees(chosen.price_paise)}</span> plus{' '}
            {chosen.tax_percent}% GST — about{' '}
            <span className="font-medium tabular-nums text-fg">
              {rupees(chosen.price_with_tax_paise)}
            </span>{' '}
            in total. The exact tax is worked out at the payment page from your billing
            details.
          </>
        ) : tooBig ? (
          <>
            That pack would take you past {topups.cap_minutes} unused extra minutes. You have
            room for <span className="tabular-nums">{room.toFixed(0)}</span> more right now.
          </>
        ) : (
          <>Bigger packs cost less per minute.</>
        )}
      </p>

      <p className="mt-4 text-tiny leading-relaxed text-fg-subtle">
        One-time payments — these do not renew. Your plan's own minutes are used first, so
        extra minutes are only spent once the month's allowance is gone. They stay until you
        use them while your plan is running.
      </p>
    </>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <svg viewBox="0 0 24 24" className="mt-0.5 size-3.5 shrink-0 text-good" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {children}
    </li>
  );
}
