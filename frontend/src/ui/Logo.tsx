import clsx from 'clsx';

/**
 * The mark: a waveform in a rounded square. Inline SVG so it inherits colour and
 * costs no request.
 *
 * Monochrome, like the rest of the product — a white tile with dark bars, which is
 * the same relationship as the primary button and means the logo needs no colour
 * of its own to hold its own on a dark page.
 *
 * The bars animate only on hover, only on a fine pointer, and only for somebody
 * who has not asked for reduced motion. A logo that moves on every page load is
 * decoration nobody asked for on an element that appears on every screen.
 */
export function Logo({ className, animated = true }: { className?: string; animated?: boolean }) {
  return (
    <span className={clsx('group relative inline-grid place-items-center', className)}>
      <svg viewBox="0 0 32 32" className="size-full" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--color-accent)" />
        {[
          { x: 9, h: 8 },
          { x: 13, h: 14 },
          { x: 17, h: 10 },
          { x: 21, h: 5 },
        ].map((bar, i) => (
          <rect
            key={bar.x}
            x={bar.x}
            y={16 - bar.h / 2}
            width="2.5"
            height={bar.h}
            rx="1.25"
            fill="var(--color-accent-ink)"
            className={clsx(
              animated && [
                'origin-center',
                'transition-transform duration-[260ms] ease-[var(--ease-out-strong)]',
                'motion-reduce:transition-none',
                // pointer-fine, not plain hover: on a touchscreen the bars would
                // stay stretched after a tap on the logo.
                i === 0 && 'pointer-fine:group-hover:scale-y-[1.45]',
                i === 1 && 'pointer-fine:group-hover:scale-y-[0.65]',
                i === 2 && 'pointer-fine:group-hover:scale-y-[1.3]',
                i === 3 && 'pointer-fine:group-hover:scale-y-[1.8]',
              ],
            )}
            style={{ transformBox: 'fill-box' }}
          />
        ))}
      </svg>
    </span>
  );
}
