/**
 * The small shared pieces: card, input, badge, stat, progress, skeleton, reveal.
 *
 * Each one carries its own motion decision, and each one is deliberately cheap —
 * CSS transitions, no motion library — because none of them needs springs,
 * layout animation or gestures. The library is reserved for the places that do.
 */
import clsx from 'clsx';
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/* ── card ────────────────────────────────────────────────────────────────── */

export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        // `surface-lift` is the opaque member of the material scale: a 1px inner
        // top highlight, a faint wash off that edge, and a real shadow. Cards are
        // deliberately NOT translucent — they hold dense text and sit on the page
        // rather than floating over it, and layering translucency on translucency
        // is the one move that reliably destroys legibility.
        'surface-lift rounded-[var(--radius-card)] border border-ink-700 bg-ink-850',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
      <div className="min-w-0">
        <h3 className="text-body font-medium text-fg">{title}</h3>
        {subtitle && <p className="mt-0.5 text-small text-fg-subtle">{subtitle}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

/* ── input ───────────────────────────────────────────────────────────────── */

export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const inputId = id ?? `f-${label.toLowerCase().replace(/\W+/g, '-')}`;
  const describedBy = error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="w-full">
      <label htmlFor={inputId} className="mb-1.5 block text-small font-medium text-fg-muted">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={clsx(
          'h-11 w-full rounded-xl border bg-ink-900 px-3.5 text-body text-fg',
          'placeholder:text-fg-subtle',
          'transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-out-strong)]',
          error
            ? 'border-bad/60 focus:border-bad'
            : 'border-ink-700 hover:border-ink-750 focus:border-fg-subtle',
          'focus:outline-none focus:ring-0',
          className,
        )}
        {...rest}
      />
      {/*
        The message occupies its own line and the field does not resize, so an
        error appearing does not shove the rest of the form down mid-typing.
      */}
      <div className="mt-1.5 min-h-[18px]">
        {error ? (
          <p id={`${inputId}-err`} role="alert" className="text-tiny text-bad">
            {error}
          </p>
        ) : hint ? (
          <p id={`${inputId}-hint`} className="text-tiny text-fg-subtle">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
});

/* ── badge ───────────────────────────────────────────────────────────────── */

/**
 * The five stage tones exist so a badge, a progress bar and a dot describing the
 * same stage are the same colour. Named after the stage, not the hue, so changing
 * the palette does not mean renaming every usage.
 */
const TONES = {
  neutral: 'bg-ink-800 text-fg-muted border-ink-700',
  good: 'bg-good/10 text-good border-good/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  bad: 'bg-bad/10 text-bad border-bad/30',
  brand: 'bg-ink-750 text-fg border-ink-600',
  iris: 'bg-iris/12 text-iris border-iris/35',
  prepare: 'bg-stage-prepare/12 text-stage-prepare border-stage-prepare/30',
  listen: 'bg-stage-listen/12 text-stage-listen border-stage-listen/30',
  translate: 'bg-stage-translate/12 text-stage-translate border-stage-translate/30',
  speak: 'bg-stage-speak/12 text-stage-speak border-stage-speak/30',
  deliver: 'bg-stage-deliver/12 text-stage-deliver border-stage-deliver/30',
} as const;

export function Badge({
  tone = 'neutral',
  children,
  className,
  dot,
  pulse,
  truncate,
  title,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  /** Pulse the dot. For "this is happening right now", not for decoration. */
  pulse?: boolean;
  /**
   * Shrink to fit and end in an ellipsis. Off by default: a badge normally keeps its
   * full width, and `nowrap` is what stops "Waiting to start" breaking over two lines.
   * On for places where a long label must not push the text next to it off the row.
   */
  truncate?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-tiny font-medium whitespace-nowrap',
        truncate && 'min-w-0 max-w-full',
        TONES[tone],
        className,
      )}
    >
      {dot && (
        <span
          className={clsx(
            'size-1.5 shrink-0 rounded-full bg-current',
            pulse && 'animate-pulse motion-reduce:animate-none',
          )}
        />
      )}
      {truncate ? <span className="min-w-0 truncate">{children}</span> : children}
    </span>
  );
}

/* ── progress ────────────────────────────────────────────────────────────── */

/**
 * A determinate bar when we know the percentage, and a shimmer when we do not.
 *
 * `linear` easing on the fill, because progress is a measurement and easing a
 * measurement makes it lie. The `sheen` class is the indeterminate case: some
 * engine stages genuinely cannot report a number, and a bar frozen at 40% looks
 * broken while a moving shimmer reads as "still working".
 */
/**
 * Tones. `brand` is a gradient rather than a flat fill for one practical reason:
 * a flat bar on a dark track reads as a single blob, whereas a gradient gives the
 * leading edge a distinct colour, so where the bar currently ends is obvious at a
 * glance. The rest are semantic and flat, because a failed bar should look like
 * one thing, not a decoration.
 */
const BAR = {
  brand: 'bg-[linear-gradient(90deg,var(--color-iris),var(--color-cyan))]',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  plain: 'bg-accent',
} as const;

export function Progress({
  value,
  indeterminate,
  className,
  tone = 'brand',
}: {
  value: number;
  indeterminate?: boolean;
  className?: string;
  tone?: keyof typeof BAR;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={clsx(
        // The track is ink-700, the card border's colour. It was ink-800, which on an
        // ink-850 card is invisible - so at 1% the bar read as a stray blue dot rather
        // than as a bar that has only just started.
        'relative h-1.5 w-full overflow-hidden rounded-full bg-ink-700',
        indeterminate && 'sheen',
        className,
      )}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {/*
        scaleX from the left edge, not `width`. Width triggers layout on every
        frame of a bar that updates every 1.5 seconds for the length of a render;
        a transform is composited. The rounded ends go very slightly elliptical
        when scaled, which at 6px tall is not visible.
      */}
      <div
        className={clsx(
          'h-full w-full origin-left rounded-full transition-transform duration-500 ease-linear',
          'motion-reduce:transition-none',
          BAR[tone],
        )}
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </div>
  );
}

/* ── skeleton ────────────────────────────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx('relative overflow-hidden rounded-lg bg-ink-800 sheen', className)}
      aria-hidden="true"
    />
  );
}

/* ── reveal on scroll ────────────────────────────────────────────────────── */

/**
 * Reveal on scroll. Fires once — re-animating on every scroll-by is an interface
 * fighting its reader. Marketing surfaces only, never around data.
 *
 * THE IMPORTANT PART IS THE FAILURE MODE, and the first version of this got it
 * wrong. It hid the content in CSS and only un-hid it when an IntersectionObserver
 * fired, which meant *anything* that stopped the observer firing left a blank
 * page: a full-page screenshot tool that never scrolls the real viewport, an
 * unusual root-margin interaction, a browser quirk. The site looked empty.
 *
 * So there are now two independent guarantees that content appears:
 *
 *   1. A **timeout**. If the observer has not fired within 1.4s the content is
 *      shown regardless. The animation is decoration; the words are the product.
 *   2. Reduced-motion and a missing observer both resolve to "shown" before the
 *      first paint, rather than being special-cased afterwards.
 *
 * A decoration must never be load-bearing for whether text is readable.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: 'div' | 'section' | 'li' | 'header';
}) {
  const ref = useRef<HTMLElement | null>(null);

  // Resolved before the first paint, so there is no flash of hidden content and
  // no frame where the page is blank for somebody who cannot see the animation.
  const [shown, setShown] = useState(() => {
    if (typeof window === 'undefined') return true;
    if (typeof IntersectionObserver === 'undefined') return true;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  });
  const done = useRef(false);

  useEffect(() => {
    if (done.current || shown) return;
    const el = ref.current;
    if (!el) return;

    const show = () => {
      if (done.current) return;
      done.current = true;
      setShown(true);
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        window.clearTimeout(safety);
        if (delay) window.setTimeout(show, delay);
        else show();
      },
      // No negative top margin: an element already on screen at load must fire
      // immediately, and -60px meant the hero's neighbour sometimes did not.
      { rootMargin: '0px 0px -8% 0px', threshold: 0 },
    );

    // The guarantee. Whatever happens to the observer, the words appear.
    const safety = window.setTimeout(() => {
      io.disconnect();
      show();
    }, 1400);

    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(safety);
    };
  }, [delay, shown]);

  return (
    <Tag
      ref={ref as never}
      data-visible={shown ? 'true' : 'false'}
      className={clsx('reveal', className)}
    >
      {children}
    </Tag>
  );
}

/* ── layout helpers ──────────────────────────────────────────────────────── */

export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('mx-auto w-full max-w-6xl px-5 sm:px-8', className)}>{children}</div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-fg-subtle">{icon}</div>}
      <p className="text-body font-medium text-fg">{title}</p>
      {body && <p className="mt-1 max-w-sm text-small text-fg-subtle">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-bad/35 bg-bad/10 px-4 py-3 text-small text-bad"
    >
      {children}
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-small text-fg-muted">
      {children}
    </div>
  );
}
