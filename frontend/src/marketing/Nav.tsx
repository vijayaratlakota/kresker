/**
 * Marketing nav.
 *
 * It gains a border and a blur once you scroll past the hero, so the bar reads as
 * floating over content rather than being permanently heavy at the top. The
 * scroll listener is passive and only flips a boolean — it does not write a style
 * per frame.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../ui/Button';
import { useSession } from '../lib/session';
import { useDrawer } from '../lib/useDrawer';
import { Logo } from '../ui/Logo';

// `/languages` is a real page now, not the homepage anchor. An anchor cannot rank for
// "what languages does it dub into" — it has no URL, title or description of its own —
// and the list is the second-most-asked question about this product. The nav is also
// the strongest internal link on the site, so pointing it at the page rather than at a
// scroll position is most of what makes the page findable at all.
const LINKS = [
  { to: '/#how', label: 'How it works' },
  { to: '/languages', label: 'Languages' },
  { to: '/pricing', label: 'Pricing' },
];

export function Nav() {
  const [lifted, setLifted] = useState(false);
  const [open, setOpen] = useState(false);
  const me = useSession((s) => s.me);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => setLifted(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A route change should not leave the mobile menu hanging open.
  useEffect(() => setOpen(false), [pathname]);

  // Scroll lock and Escape. See useDrawer for why the page scrolling behind a fixed
  // header is worse here than it sounds.
  useDrawer(open, useCallback(() => setOpen(false), []));

  return (
    <header
      className={clsx(
        /*
          THE HEADER MUST BE EXACTLY AS TALL AS ITS BAR. Two separate things broke
          that, and both showed up as the same complaint: "the header gets big when
          I scroll".

          1. THE SHEET WAS IN THIS ELEMENT'S NORMAL FLOW. It is hidden with
             `clip-path` and `opacity-0`, and neither of those removes layout — so a
             closed menu still contributed its ~200px to the header's height. The
             header was ~264px tall at all times. Invisible at rest, because the
             header is transparent until you scroll 12px; the instant the opaque
             background faded in, a quarter of the screen turned into an empty dark
             panel with the content hidden behind it. The sheet is now
             `absolute top-full`, so it overlays the page instead of growing the bar.

          2. `pt-safe` WAS ON THE <nav>, which is `h-16` — a fixed 64px. With
             `box-sizing: border-box` a ~47px `env(safe-area-inset-top)` left 17px of
             content box and pushed the logo and hamburger out of the bar. It belongs
             here, on the element with no height of its own, so the inset moves the
             whole bar down and the nav stays exactly 64px.

          The rule behind both: safe-area padding goes on an element that is allowed
          to grow, and anything hidden inside a fixed-position bar has to be taken out
          of flow, not merely made invisible.

          ── A MATERIAL WITH NO EDGE, NOT A PANEL ───────────────────────────────────

          Scrolled, this bar used to be `bg-ink-950/80` with a `border-b`. Two problems,
          and the second is the one that actually looked wrong.

          80% opaque is a wall: everything under it disappeared, including the
          status-bar strip, so the top of the screen read as dead space even though the
          page was painting there. On iOS the bar is a translucent MATERIAL instead —
          the list scrolls up and stays visible behind it, right through the status bar.
          A track title sits behind the clock in Apple Music, a chat row behind it in
          WhatsApp. What stays fully opaque is the bar's CONTENTS, never its background.

          So the background is a GRADIENT on a child element, filled from the very first
          pixel and fading to nothing at the bar's bottom edge (`.nav-scrim`). There is no
          border. Nothing marks where the bar ends, so the page runs up behind the logo
          rather than stopping under it — and the top edge is fully covered rather than
          leaving a strip of unfilled transparency.

          The scrim is a child with its opacity animated, not a background on this
          element: `background-image` cannot be interpolated, so a gradient set here
          would snap rather than fade. Opacity is also the cheaper of the two to animate.

          A FULL-BLEED BAR AND A SEE-THROUGH STATUS STRIP ARE MUTUALLY EXCLUSIVE, and
          that is worth recording because it was worked around and then reverted.
          dododisk.com and bluorng.com avoid it by giving the header no background at all
          and putting the surface on a rounded pill inside, inset from the edges — so the
          page shows through everywhere except the pill. That was implemented here and
          backed out: it changes the header from a full-width bar to a floating pill at
          every width, which is a different design. Kept as a bar deliberately.

          `translateZ(0)` keeps the bar on its own compositing layer. That is what
          stopped iOS repainting a fixed element at a stale offset mid-scroll, which was
          the "header appears in the middle of the page" report. `backdrop-filter` is
          also deliberately absent from the transition list: interpolating it makes
          Safari re-rasterise a viewport-wide backdrop every frame.
        */
        'pt-safe fixed inset-x-0 top-0 z-50 [transform:translateZ(0)]',
      )}
    >
      {/*
        The scrim. Absolutely positioned so it covers the safe-area strip as well as the
        bar, which is the point: the clock has to stay readable over whatever scrolls
        past underneath it.
      */}
      <div
        aria-hidden="true"
        className={clsx(
          'nav-scrim pointer-events-none absolute inset-0',
          'transition-opacity duration-[250ms] ease-[var(--ease-out-strong)]',
          'motion-reduce:transition-none',
          lifted ? 'opacity-100' : 'opacity-0',
        )}
      />
      {/*
        Three-column grid, not a flex row with `ml-auto`.

        The links have to be centred on the VIEWPORT, and with flex they would be
        centred on whatever space the logo and the buttons left over — so they
        would drift sideways as soon as the right-hand side changed from "Log in /
        Start free" to "Open dashboard". A grid with equal outer columns pins the
        middle regardless.
      */}
      {/*
        `gap-3` below md, `gap-6` above. The centre column is `hidden md:flex`, so on a
        phone both 24px gutters were separating the logo from an empty cell and the
        empty cell from the hamburger — 48px of the 320px available spent on nothing.

        Height comes from `--nav-h`: 56px on a phone, 64px from `sm` up. It is a
        variable rather than a literal because the hero's top padding and the mobile
        sheet's max-height both have to agree with it, and as three separate numbers
        they drifted — the headline ended up 17px from the bar while the status-bar
        inset above it read as wasted space.

        The safe-area inset is still handled by the <header> above rather than here;
        this element has a fixed height and padding on it would push the contents out.
      */}
      {/* `relative` so the bar's contents paint ABOVE the scrim. The scrim is a
          positioned element earlier in the DOM, and a positioned box paints over
          non-positioned in-flow content regardless of source order — without this the
          logo and hamburger would sit behind the gradient. */}
      <nav className="relative mx-auto grid h-[var(--nav-h)] w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-5 sm:gap-6 sm:px-8">
        {/*
          `data-touch-target` opts this into the 44px coarse-pointer floor in
          styles.css. It was 31px tall on a phone — the logo is `size-7` (28px) and the
          wordmark sets the line box — which made the one control that gets you back to
          the homepage the smallest tap target in the header.

          It was missed because the blanket rule covers `button` and `[role=button]`
          but deliberately NOT every `<a>`: body copy is full of inline links, and
          giving those a 44px minimum would space paragraph lines apart like a list. A
          standalone control that happens to be an anchor has to opt in, and this one
          had not. The nav bar is 56px on a phone, so 44px fits with room to spare.
        */}
        <Link
          to="/"
          data-touch-target
          className="flex items-center gap-2.5"
          aria-label="Kresker home"
        >
          <Logo className="size-7" />
          <span className="text-h4 tracking-tight">Kresker</span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.to}
              href={l.to}
              className={clsx(
                'rounded-full px-3.5 py-2 text-small text-fg-muted',
                'transition-[color,background-color] duration-[160ms]',
                'ease-[var(--ease-out-strong)] hover:bg-ink-850 hover:text-fg',
              )}
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center justify-end gap-2 md:flex">
          {me ? (
            <Link to="/app">
              <Button size="sm">Open dashboard</Button>
            </Link>
          ) : (
            <>
              <Link to="/login">
                <Button variant="ghost" size="sm">
                  Log in
                </Button>
              </Link>
              <Link to="/signup">
                <Button size="sm">Start free</Button>
              </Link>
            </>
          )}
        </div>

        {/* col-start-3 so it lands in the right-hand grid column on mobile, where
            the centre and right cells above are hidden. */}
        <button
          type="button"
          className="col-start-3 ml-auto grid size-9 place-items-center rounded-lg text-fg-muted md:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </nav>

      {/*
        The mobile sheet reveals with clip-path rather than animating height or
        grid-template-rows. Both of those cost a layout recalculation on every
        frame; clip-path is composited and, like a row-template, needs no JS
        measurement of the content. The `height` exception in the animation rules
        exists for accordions because they have no transform equivalent — a sheet
        anchored to the top of the viewport does.
      */}
      <div
        className={clsx(
          /*
            `absolute top-full`, NOT in flow. This is the fix for the oversized
            header described at the top of this file: `clip-path` and `opacity` hide
            a box without removing it, so while this sat in the header's flow the bar
            was ~264px tall with a closed menu. Out of flow, the header is its bar and
            nothing else, and the sheet hangs below it over the page — which is what a
            dropdown should do anyway.

            The header is `fixed`, so it is already a positioned ancestor and
            `top-full` lands exactly on the bottom edge of the bar.
          */
          'absolute inset-x-0 top-full',
          'overflow-hidden border-ink-700 bg-ink-950/95 backdrop-blur-xl md:hidden',
          'transition-[clip-path,opacity] duration-[250ms]',
          'ease-[var(--ease-out-strong)] motion-reduce:transition-none',
          open
            ? '[clip-path:inset(0_0_0_0)] border-b opacity-100'
            : 'pointer-events-none [clip-path:inset(0_0_100%_0)] opacity-0',
        )}
      >
        {/*
          Scrollable, and bounded to the viewport below the 64px header.

          Without this the sheet was as tall as its content with no scroll of its own —
          fine in portrait with three links, but in landscape on a phone the header plus
          the links plus the two buttons exceed the screen height and the CTAs were
          simply unreachable. `max-h` + `overflow-y-auto` is the whole fix; the base
          layer's `overscroll-behavior: contain` stops the scroll chaining to the
          locked page behind it.
        */}
        <div className="sheet-max min-h-0 overflow-y-auto">
          <div className="pb-safe flex flex-col gap-1 px-5 pt-2">
            {LINKS.map((l) => (
              <a
                key={l.to}
                href={l.to}
                data-touch-target
                className="flex items-center rounded-lg px-3 py-2.5 text-body text-fg-muted hover:bg-ink-850 hover:text-fg"
              >
                {l.label}
              </a>
            ))}
            <div className="mt-2 flex gap-2">
              {me ? (
                <Link to="/app" className="flex-1">
                  <Button className="w-full">Open dashboard</Button>
                </Link>
              ) : (
                <>
                  <Link to="/login" className="flex-1">
                    <Button variant="secondary" className="w-full">
                      Log in
                    </Button>
                  </Link>
                  <Link to="/signup" className="flex-1">
                    <Button className="w-full">Start free</Button>
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
