/**
 * Dashboard frame: fixed sidebar, scrolling content.
 *
 * The sidebar has no entrance animation. It is on screen every time you use the
 * product, which puts it in the "tens of times a day" tier where the animate skill
 * allows near-imperceptible motion or none — and a nav that slides in every
 * navigation is exactly the thing that gets tiring by week two.
 *
 * The one piece of motion here is the active-item indicator, which slides between
 * items so you can see where you came from.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, type Health } from '../lib/api';
import { isAdmin, useSession } from '../lib/session';
import { useDrawer } from '../lib/useDrawer';
import { Badge } from '../ui/primitives';
import { Button } from '../ui/Button';
import { Logo } from '../ui/Logo';

/**
 * A hue per destination, so the sidebar is scannable rather than seven identical
 * grey rows. The colour is wayfinding: it is stable per destination forever, which
 * is what lets somebody learn "the green one is billing" and stop reading labels.
 *
 * The classes are written out in full rather than interpolated. Tailwind scans
 * source text, so `text-${x}` produces nothing at all — a real trap here, because
 * it fails silently and just renders grey.
 */
interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
  /** Icon colour when this item is the current page. */
  tint: string;
  /** Same colour on hover, gated to fine pointers so a tap does not stick. */
  hover: string;
  /** The active marker down the left edge. */
  bar: string;
}

/** A count on a nav row. `urgent` turns it red; see NavBadge. */
interface NavCount {
  n: number;
  urgent: boolean;
}

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const MAIN: NavItem[] = [
  {
    to: '/app', label: 'Dubbing', end: true,
    tint: 'text-iris', hover: 'pointer-fine:group-hover:text-iris', bar: 'bg-iris',
    icon: icon('M12 3v10m0 0a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3ZM5 11a7 7 0 0 0 14 0M12 18v3'),
  },
  {
    to: '/app/library', label: 'Library',
    tint: 'text-cyan', hover: 'pointer-fine:group-hover:text-cyan', bar: 'bg-cyan',
    icon: icon('M4 6h16M4 12h16M4 18h10'),
  },
  {
    to: '/app/billing', label: 'Plan & billing',
    tint: 'text-good', hover: 'pointer-fine:group-hover:text-good', bar: 'bg-good',
    icon: icon('M3 10h18M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'),
  },
  {
    // In the main nav, not buried in a settings submenu. Exercising a data right
    // should take the same number of clicks as checking your bill.
    to: '/app/privacy', label: 'Your data',
    tint: 'text-sky', hover: 'pointer-fine:group-hover:text-sky', bar: 'bg-sky',
    icon: icon('M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z'),
  },
];

const ADMIN: NavItem[] = [
  {
    to: '/app/admin', label: 'Overview', end: true,
    tint: 'text-violet', hover: 'pointer-fine:group-hover:text-violet', bar: 'bg-violet',
    icon: icon('M3 12h4l3 8 4-16 3 8h4'),
  },
  {
    // Amber on purpose: this is the page for the thing that bills by the hour.
    //
    // Labelled 'Capacity' rather than 'GPU box'. The route is admin-only, but this nav
    // array lives in the shell chunk that EVERY signed-in browser downloads, so the
    // label itself shipped to customers even though the page never rendered for them.
    // The page behind it still says exactly what it is - it loads for admins only.
    to: '/app/admin/gpu', label: 'Capacity',
    tint: 'text-warn', hover: 'pointer-fine:group-hover:text-warn', bar: 'bg-warn',
    icon: icon('M6 6h12v12H6zM9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3'),
  },
  {
    to: '/app/admin/people', label: 'People',
    tint: 'text-pink', hover: 'pointer-fine:group-hover:text-pink', bar: 'bg-pink',
    icon: icon('M16 19v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'),
  },
  {
    // Contact messages and data-rights requests. Teal so it does not read as
    // another money page — and it carries a count badge, which the others do not,
    // because an unanswered rights request has a statutory deadline attached.
    to: '/app/admin/inbox', label: 'Inbox',
    tint: 'text-cyan', hover: 'pointer-fine:group-hover:text-cyan', bar: 'bg-cyan',
    icon: icon('M3 8l9 6 9-6M3 6h18v12H3V6Z'),
  },
  {
    // Every payment, subscription, webhook and chargeback. 'Payments' rather than
    // 'Billing' because the customer's own Billing page sits in the list above.
    to: '/app/admin/billing', label: 'Payments',
    tint: 'text-good', hover: 'pointer-fine:group-hover:text-good', bar: 'bg-good',
    icon: icon('M3 6h18v12H3V6Zm0 4h18M7 15h4'),
  },
  {
    to: '/app/admin/system', label: 'System',
    tint: 'text-sky', hover: 'pointer-fine:group-hover:text-sky', bar: 'bg-sky',
    icon: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 10a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'),
  },
];

export function AppShell() {
  const me = useSession((s) => s.me);
  const signOut = useSession((s) => s.signOut);
  const [health, setHealth] = useState<Health | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();

  /**
   * Unanswered messages, shown as a count on the Inbox row.
   *
   * The other admin rows have no badge and do not need one. This one does, because a
   * data-rights request carries a statutory deadline: a message nobody has looked at
   * is not merely a backlog, it is a clock running down. `overdue` is tracked
   * separately from `new` so the badge can go red rather than just getting bigger.
   */
  const [inboxCounts, setInboxCounts] = useState<Record<string, NavCount>>({});

  useEffect(() => {
    let alive = true;
    const load = () => api.health().then((h) => alive && setHealth(h)).catch(() => undefined);
    load();
    // Slow poll. The one thing worth noticing is a real engine going unreachable
    // mid-render, and 30s is soon enough to matter without hammering the box.
    const t = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // Scroll lock and Escape while the sidebar drawer is open. The dashboard pages are
  // long, and scrolling one behind an open drawer loses your place in it.
  useDrawer(mobileOpen, useCallback(() => setMobileOpen(false), []));

  const admin = isAdmin(me);
  useEffect(() => {
    if (!admin) return;
    let alive = true;
    const load = () =>
      api.admin
        .dpdp()
        .then((d) => {
          if (!alive) return;
          setInboxCounts({
            '/app/admin/inbox': {
              n: d.open_messages,
              urgent: d.overdue_rights_requests > 0,
            },
          });
        })
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
    // Re-read on navigation too, so answering a message updates the badge without
    // waiting out the poll.
  }, [admin, pathname]);

  useEffect(() => setMobileOpen(false), [pathname]);

  const ent = me?.entitlement;
  /*
    How full the PLAN's allowance is, which is what the denominator beside it means.

    Was `minutes_used / minutes_allowance`, and `minutes_used` now counts minutes paid for out
    of a top-up pack — so buying extra minutes moved this bar towards red, which is the exact
    opposite of what had just happened to the account.
  */
  const usedFraction = ent?.minutes_allowance
    ? Math.min(1, Math.max(0, 1 - ent.minutes_plan_left / ent.minutes_allowance))
    : 0;
  // The colour asks a different question from the width: is this account actually short of
  // minutes? A full bar with a pack still in reserve is not, so it stays neutral.
  const shortOfMinutes = (ent?.minutes_topup_left ?? 0) <= 0;

  // `page-ambient` is two very low-contrast washes anchored off the top edge. It does
  // two jobs: it stops the page being a flat near-black slab, which is the thing that
  // makes a dark interface feel cheap, and it gives the translucent sidebar something
  // to actually blur. Against flat #08090b a backdrop filter has nothing to reveal and
  // the glass reads as a slightly wrong grey rather than as a material.
  return (
    <div className="page-ambient min-h-dvh bg-ink-950">
      {/* mobile bar */}
      {/* `min-h-14`, not `h-14`. This bar IS the sticky element, so the safe-area
          padding has to grow it rather than eat into a fixed height — with `h-14` the
          inset pushed the logo and the hamburger out of the bar. Same bug as the
          marketing header; see the note in Nav.tsx. */}
      {/* Translucent, for the same reason as the marketing header: at `bg-ink-950/90`
          this was a wall, and the dashboard's own content vanished under it instead of
          scrolling behind it. A little more tint than the marketing bar (65 against 55)
          because the content passing under here is dense tabular text rather than a
          hero, and it needs more separation to keep the bar's own labels readable. */}
      {/* `backdrop-blur-lg` (16px), down from `-2xl` (40px). This bar is sticky at the top
          of every dashboard page on a phone, so its blur is recomposited on every frame of
          every scroll — and 40px was double the radius the material guidance allows before
          it calls a blur expensive, "especially in Safari". At this tint the difference is
          not visible; the difference in what it costs to scroll is. */}
      {/* SOLID NOW, and this overrides both notes above. On an iPhone the blur is not
          reliably applied while scrolling, so the page's own text read straight through
          the bar - "0 ready · they run one after another" printed across the header,
          and "Recent dubs" behind the logo: text overlapping text, the reported glitch.
          92% was tried and headings still showed through. A header that is a wall is a
          style question; one you can read other text through is a bug. The blur went
          with the transparency - with nothing to see through it was cost for no effect. */}
      <div className="pt-safe sticky top-0 z-40 flex min-h-14 items-center gap-3 border-b border-ink-800/60 bg-ink-950 px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="grid size-9 place-items-center rounded-lg text-fg-muted"
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOpen}
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            {mobileOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
        <Link to="/app" className="flex items-center gap-2">
          <Logo className="size-6" animated={false} />
          <span className="text-body font-medium">Kresker</span>
        </Link>
      </div>

      <div className="lg:flex">
        {/* sidebar */}
        <aside
          className={clsx(
            // `min(248px, 82vw)`: 248 of a 360px screen is 69%, which leaves barely a
            // thumb's width of page visible to tap on to dismiss. The clamp only
            // engages below ~300px, so on every normal phone it is still 248.
            // `material-chrome` rather than `bg-ink-900`: the sidebar is structural
            // chrome that content passes behind, which is the heaviest tier of the
            // material scale. It owns the background outright — pairing it with a
            // `bg-*` utility would be two single-class selectors racing, decided by
            // emit order, which is the exact trap documented on `.drawer-safe-top`.
            //
            // The right border drops to /70 to suit it. A solid edge on a
            // translucent surface reads as a seam between two panels; a softer one
            // reads as the edge of the material itself.
            'material-chrome z-30 w-[min(248px,82vw)] shrink-0 border-r border-ink-700/70',
            // `drawer-safe-top` clears the sticky mobile bar. The drawer is
            // `inset-y-0`, so without it the panel starts at y=0 behind a bar that is
            // on a higher layer, and the first nav row was hidden underneath it
            // entirely — Dubbing invisible, Library half eaten.
            //
            // No `lg:pt-0` beside it: the class carries its own `max-width` bound, so
            // it simply does not exist at desktop. Pairing it with a Tailwind reset is
            // what broke the desktop sidebar — equal specificity, and Tailwind's
            // generated utilities are emitted BEFORE this file's custom ones, so the
            // reset always lost. See the note on the class in styles.css.
            'drawer-safe-top',
            'lg:sticky lg:top-0 lg:h-dvh lg:w-[248px] lg:translate-x-0',
            'fixed inset-y-0 left-0 transition-transform duration-[250ms]',
            'ease-[var(--ease-drawer)] motion-reduce:transition-none',
            mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          )}
        >
          <div className="flex h-full flex-col">
            <div className="hidden h-16 items-center gap-2.5 px-5 lg:flex">
              <Link to="/" className="flex items-center gap-2.5">
                <Logo className="size-7" />
                <span className="text-h5 tracking-tight">Kresker</span>
              </Link>
            </div>

            {/*
              `min-h-0` IS LOAD-BEARING, and its absence is why the list would not
              scroll back up.

              A flex item's default `min-height` is `auto`, which means it refuses to
              shrink below its own content. So on a short window this nav did not become
              a scroller — it grew past the column and pushed the plan card and the
              account row down over the top of it, leaving the last rows (Inbox, System)
              clipped with no way to reach them. `overflow-y-auto` was already here and
              was doing nothing, because there was no overflow to scroll: the box had
              simply expanded.

              `min-h-0` lets it shrink, at which point the overflow is real and the
              scroll works.
            */}
            <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-4 lg:pt-0">
              <SideGroup items={MAIN} />

              {isAdmin(me) && (
                <>
                  <p className="mb-2 mt-6 px-3 text-eyebrow uppercase text-fg-subtle">
                    Admin
                  </p>
                  <SideGroup items={ADMIN} counts={inboxCounts} />
                </>
              )}
            </nav>

            {/* Usage. */}
            {ent && (
              <div className="mx-3 mb-3 rounded-xl border border-ink-700 bg-ink-850 p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-tiny font-medium">{ent.plan_name}</span>
                  {ent.is_free && <Badge tone="neutral">Free</Badge>}
                </div>

                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ink-800">
                  <div
                    className={clsx(
                      'h-full w-full origin-left rounded-full transition-transform duration-500 ease-out',
                      shortOfMinutes && usedFraction > 0.9
                        ? 'bg-bad'
                        : shortOfMinutes && usedFraction > 0.7
                          ? 'bg-warn'
                          : 'bg-accent',
                    )}
                    style={{ transform: `scaleX(${usedFraction})` }}
                  />
                </div>
                {/*
                  THE PLAN'S OWN FIGURE, WITH ANY EXTRA MINUTES NAMED SEPARATELY.

                  This read `minutes_left of minutes_allowance`, and `minutes_left` now
                  includes minutes bought on top of the plan — so a Starter customer who
                  added a 20-minute pack was shown "30.00 of 10 min left", which reads as a
                  bug rather than as good news. The two numbers behave differently as well:
                  the allowance comes back at the renewal and the extra does not, so they
                  were never really one quantity.
                */}
                <p className="mt-2 text-tiny text-fg-subtle">
                  {ent.minutes_plan_left.toFixed(2)} of {ent.minutes_allowance} min left
                  {ent.minutes_topup_left > 0 &&
                    ` + ${ent.minutes_topup_left.toFixed(2)} extra`}
                </p>

                {ent.is_free && (
                  <Link to="/app/billing" className="mt-2.5 block">
                    <Button size="sm" className="w-full">
                      Upgrade
                    </Button>
                  </Link>
                )}
              </div>
            )}

            {/* engine + account. `pb-safe` because the drawer is `inset-y-0`, so on an
                iPhone this row and its sign-out sat under the home indicator. */}
            <div className="pb-safe border-t border-ink-700 px-3 pt-3">
              {health && <EngineNote health={health} />}
              <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent/15 text-tiny font-medium text-fg">
                  {me?.email.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-tiny text-fg-muted">
                  {me?.email}
                </span>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  title="Sign out"
                  aria-label="Sign out"
                  className="grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors duration-[160ms] hover:bg-ink-800 hover:text-fg"
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M15 17l5-5-5-5M20 12H9M12 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* dim behind the mobile drawer */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
          className={clsx(
            'fixed inset-0 z-20 bg-black/60 transition-opacity duration-[250ms] lg:hidden',
            mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * What the engine is doing, in one line.
 *
 * The GPU box is stopped whenever nothing is running, on purpose, to avoid paying for
 * an idle machine — so "asleep" is the intended resting state and is drawn in a
 * neutral colour rather than a warning one. Starting it takes a few minutes, and
 * saying so is what stops that wait reading as an abandoned page.
 *
 * THIS USED TO GUESS, AND THE GUESS WAS WRONG:
 *
 *     const waking = !health.engine_reachable && (running + queued) > 0;
 *
 * That is a different question. "There is unfinished work and the engine is not
 * answering" is true of a box that is booting AND of a box that is stopped with a
 * wedged job in front of it — and in the second case this said "Starting the GPU, a
 * few minutes" forever while nothing started. The counts were also global rather than
 * per-user, so a stranger's queue changed what your sidebar claimed.
 *
 * `health.engine_state` is now computed by the backend, which knows whether a start
 * was actually requested instead of inferring it. This component renders a word and
 * makes no decisions.
 */
// FOUR STATES, NAMING NOTHING. The old copy read "GPU engine connected", "GPU engine
// asleep, wakes on upload" and "Starting the GPU, a few minutes" — the same three
// situations, described by what we run them on.
//
// The distinction between starting and idle is back, because it is the difference between
// "your dub is about to begin" and "your dub has not been asked for yet", and somebody
// watching a first dub sit still wants to know which. The value now needs a session to
// read, and what it says — that we start capacity on demand — is already in the Terms.
const SERVICE_NOTE: Record<
  NonNullable<Health['service_state']>,
  { dot: string; text: string }
> = {
  demo: { dot: 'bg-fg-subtle', text: 'Demo mode' },
  ready: { dot: 'bg-good', text: 'Ready to dub' },
  starting: {
    dot: 'bg-warn animate-pulse motion-reduce:animate-none',
    text: 'Starting up, a few minutes',
  },
  // "when you dub", not "when you upload". Capacity now starts at the moment a dub is
  // asked for, so promising it starts on upload would set the wrong expectation about
  // when the wait happens — and the wait is the thing this line exists to explain.
  idle: { dot: 'bg-fg-subtle', text: 'Idle — starts when you dub' },
};

function EngineNote({ health }: { health: Health }) {
  // WHAT THIS DELIBERATELY NO LONGER SAYS.
  //
  // It used to read "GPU engine connected", "GPU engine asleep, wakes on upload" and
  // "Starting the GPU, a few minutes" - and the value behind it came from an endpoint
  // that answered anyone, signed in or not. Between them those sentences told the world
  // that the service runs a separate machine, that it is normally switched off, and the
  // moment it starts coming up.
  //
  // What a customer needs is whether their dub will start now or in a few minutes. That
  // is the whole of it, so that is all this says.
  //
  // No fallback to the old fields: they are gone from the payload for everybody except
  // an admin, and quietly reconstructing "asleep" from a missing `engine_reachable`
  // would put the disclosure straight back.
  const state = health.service_state;
  if (!state) return null;
  const { dot, text } = SERVICE_NOTE[state] ?? SERVICE_NOTE.idle;

  return (
    <div className="mb-2.5 flex items-center gap-2 px-2" data-service-state={state}>
      <span className={clsx('size-1.5 shrink-0 rounded-full', dot)} />
      <span className="truncate text-tiny text-fg-subtle" title={text}>
        {text}
      </span>
    </div>
  );
}

function SideGroup({
  items,
  counts,
}: {
  items: NavItem[];
  counts?: Record<string, NavCount>;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              clsx(
                'group relative flex items-center gap-2.5 rounded-lg px-3 py-2',
                'text-small transition-colors duration-[160ms]',
                'ease-[var(--ease-out-strong)]',
                isActive
                  ? 'bg-ink-800 font-medium text-fg'
                  : 'text-fg-muted hover:bg-ink-850 hover:text-fg',
              )
            }
          >
            {({ isActive }) => (
              <>
                {/* The active marker. 200ms opacity+scale, not a layout change. */}
                <span
                  className={clsx(
                    'absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r-full',
                    item.bar,
                    'transition-[opacity,transform] duration-[200ms] ease-[var(--ease-out-strong)]',
                    isActive ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0',
                  )}
                />
                {/*
                  Colour only — no scale, no bounce. This is core navigation, used
                  many times a day, which is the tier where the animate skill says
                  near-imperceptible or nothing. A 160ms tint is imperceptible as
                  motion and still tells you the row is live.
                */}
                <span
                  className={clsx(
                    'transition-colors duration-[160ms] ease-[var(--ease-out-strong)]',
                    isActive ? item.tint : clsx('text-fg-subtle', item.hover),
                  )}
                >
                  {item.icon}
                </span>
                {item.label}
                <NavBadge count={counts?.[item.to]} />
              </>
            )}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * The count on a nav row. Two states rather than one number, because "eleven
 * unanswered" and "one of them is past its legal deadline" need different urgency,
 * and a bigger number does not communicate the second.
 *
 * It does not pulse. A permanently animating badge in the sidebar is the thing
 * people learn to stop seeing.
 */
function NavBadge({ count }: { count?: NavCount }) {
  if (!count || count.n <= 0) return null;
  return (
    <span
      data-nav-badge="true"
      title={count.urgent ? 'Something here is past its deadline' : undefined}
      className={clsx(
        'ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5',
        'text-tiny font-medium tabular-nums',
        count.urgent ? 'bg-bad/20 text-bad' : 'bg-ink-750 text-fg-muted',
      )}
    >
      {count.n > 99 ? '99+' : count.n}
    </span>
  );
}
