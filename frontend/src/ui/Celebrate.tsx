/**
 * The one flourish in the product: the moment a subscription becomes active.
 *
 * WHY THIS IS ALLOWED TO EXIST when the dashboard around it is deliberately still.
 * Motion here is rationed by how often a surface is seen — the sidebar has no
 * entrance animation, the library has no row animations, and the nav is a 160ms
 * colour change and nothing else, all because those are seen tens of times a day and
 * a flourish you meet forty times a session becomes a wait. Somebody subscribes
 * once. That is the rare tier, and it is the only place in the product where
 * spending the delight budget does not tax the person using it.
 *
 * WHAT IT IS NOT: confetti. Delight is meant to be what happens when the rest of the
 * craft is right, not a particle effect stapled over the top of it. So this is the
 * success mark — a halo that expands and dissipates, a check that draws itself, then
 * the two facts that matter.
 *
 * THREE THINGS MAKE IT SAFE, and they matter more than how it looks:
 *
 *  1. `pointer-events-none` on the root. It covers the viewport, so if it could take
 *     a click at all then a mis-timed render would leave a paid customer unable to
 *     press anything. It cannot take one even while fully opaque.
 *  2. ONE CLOCK, and every element self-terminates on it. The animation is 2600ms
 *     and finishes whether or not React renders again; the timer below only unmounts
 *     an element that is already invisible. The failure mode being avoided is a
 *     full-screen overlay stuck on top of an account somebody has just paid for.
 *  3. `aria-hidden`. The toast that fires alongside this is the accessible
 *     announcement, and announcing the same fact twice is worse than not announcing
 *     it here at all.
 */
import clsx from 'clsx';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Matches the total length of the keyframes in styles.css. If one changes the other
 * has to: shorter here truncates the exit mid-fade, longer leaves an invisible
 * element mounted over the page.
 */
const RUN_MS = 2600;

/**
 * Which outcome this is announcing.
 *
 * BOTH ENDINGS GET A MOMENT, and the reason is the same frequency argument that justified
 * the first one. A failed payment is every bit as rare as a successful one and it matters
 * more to the person it happens to: they have just tried to give us money and something
 * went wrong, and a red line of text at the top of a long page is easy to miss entirely.
 *
 * The two are deliberately the SAME shape — same timing, same panel, same choreography —
 * because that is what makes the colour and the mark do the talking. Giving failure its own
 * different treatment would read as a different kind of event rather than the other result
 * of the one the customer just asked for.
 */
export type CelebrateTone = 'good' | 'bad';

export function Celebrate({
  open,
  tone = 'good',
  title,
  detail,
  onDone,
}: {
  open: boolean;
  /** `bad` swaps the palette and draws a cross. Everything else is identical. */
  tone?: CelebrateTone;
  /** The headline fact. "You are on Creator", or "Payment failed". */
  title: string;
  /** The consequence, in the customer's terms — minutes, not plan internals. */
  detail?: string;
  /** Unmount. Called once the run has finished and the element is already invisible. */
  onDone: () => void;
}) {
  const bad = tone === 'bad';
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(onDone, RUN_MS);
    return () => window.clearTimeout(t);
  }, [open, onDone]);

  if (!open) return null;

  return createPortal(
    <div
      aria-hidden="true"
      // Above the dialog at z-100, below sonner's toaster, which sits far higher and
      // should stay readable over this.
      className="pointer-events-none fixed inset-0 z-[110] grid place-items-center p-6"
    >
      {/*
        A dim, and deliberately no blur. A full-viewport `backdrop-filter` costs a
        compositor pass over the whole page for 2.6 seconds to produce an effect that
        is barely visible at the radius it would need — and unlike the panels, this
        one is not carrying any text that needs separating from what is behind it.
      */}
      <div className="celebrate-wash absolute inset-0 bg-ink-950/55" />

      <div
        className={
          'celebrate-card material-raised relative flex flex-col items-center gap-5 ' +
          'rounded-[var(--radius-card)] border border-ink-700 px-9 py-10 text-center'
        }
      >
        <div className="relative grid size-16 place-items-center">
          {/* The bloom sits outside the disc and is scaled past it, so the light
              looks like it comes from the mark rather than being drawn around it. */}
          <span
            className={clsx(
              'absolute inset-0 scale-[2.2] rounded-full',
              bad ? 'celebrate-halo-bad' : 'celebrate-halo',
            )}
          />
          {/* One ring, expanding once and gone — not a pulse. A loop would turn a
              finished event into something that looks still in progress, which is
              wrong for a success and actively misleading for a failure. */}
          <span
            className={clsx(
              'celebrate-ring absolute inset-0 rounded-full border-2',
              bad ? 'border-bad/50' : 'border-good/50',
            )}
          />
          <span
            className={clsx(
              'relative grid size-16 place-items-center rounded-full border',
              bad ? 'border-bad/30 bg-bad/12' : 'border-good/30 bg-good/12',
            )}
          >
            <svg
              viewBox="0 0 32 32"
              className={clsx('size-8', bad ? 'text-bad' : 'text-good')}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/*
                `pathLength={1}` normalises the geometry to a unit length, so the dash
                maths in CSS is `1 → 0` and does not have to know how long the path
                actually is. Edit either `d` freely; the draw still works.

                The cross is one path with two strokes rather than two paths, so the
                single dash sweep draws one arm and then the other — which reads as a
                mark being made, where two simultaneous strokes read as an icon
                appearing.
              */}
              <path
                className="celebrate-mark"
                pathLength={1}
                d={bad ? 'M11 11 21 21M21 11 11 21' : 'M8 16.5 13.5 22 24 11'}
              />
            </svg>
          </span>
        </div>

        <div>
          <p className="celebrate-line text-h5">{title}</p>
          {detail && <p className="celebrate-line mt-1.5 text-small text-fg-muted">{detail}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
