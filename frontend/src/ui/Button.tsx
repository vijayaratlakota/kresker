/**
 * Button.
 *
 * The primary action is WHITE on dark, which is the reference's own treatment and
 * has a practical advantage on a monochrome page: it is the highest-contrast thing
 * available, so it reads as the primary action without spending a colour on it.
 * Colour is then free to mean state — the only hues in this product are green,
 * amber and red, and each one always means something.
 *
 * `font-family: inherit` comes from the base layer. Form controls do not inherit
 * it on their own: the user agent substitutes its own UI font, so a button renders
 * in a different typeface from the paragraph beside it unless told otherwise.
 * `font-medium` here is a weight choice on top of the inherited family.
 *
 * The press animation is the recipe from the `animate` skill: scale(0.97) over
 * 160ms with the strong ease-out. `scale` rather than a background change because
 * it scales the children too, which is what makes it read as a physical press.
 * `:active` is a real press on touch, so it needs no hover gating; hover styling
 * is gated separately.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import clsx from 'clsx';
import { forwardRef } from 'react';

const button = cva(
  [
    // `group/btn` is named so a trailing <Chevron /> can react to the button's
    // hover without colliding with any other `group` the button sits inside.
    'group/btn relative inline-flex items-center justify-center gap-2 select-none',
    'font-medium whitespace-nowrap rounded-full',
    'transition-[transform,background-color,border-color,color,opacity]',
    'duration-[160ms] ease-[var(--ease-out-strong)]',
    'active:scale-[0.97]',
    'disabled:pointer-events-none disabled:opacity-45',
    // never `transition: all` — name the properties (animate skill, Never Ship)
  ],
  {
    variants: {
      variant: {
        /** The one primary action on a screen. */
        primary:
          'bg-accent text-accent-ink hover:bg-white/88 active:bg-white/82',
        /**
         * Iris. Reserved for the single highest-intent action on a page — "get
         * started", "dub your first video". Use it once per viewport; a second
         * one turns it from "this one" into decoration.
         */
        iris: 'bg-iris text-white hover:bg-iris-hover active:bg-iris-press',
        /**
         * Everything alongside it.
         *
         * The border is 2px, not 1px. At 1px against #16191e on #08090b the edge
         * was doing almost nothing — the button read as a slightly lighter smudge
         * rather than as an object with a boundary. 2px is the difference between
         * "there might be a button here" and "this is a button".
         *
         * Fixed heights plus border-box mean the extra pixel comes out of the
         * inner padding, so nothing moves or resizes.
         */
        secondary:
          'border-2 border-ink-600 bg-ink-800 text-fg hover:border-ink-500 hover:bg-ink-750',
        /**
         * Tertiary: no chrome until you touch it - WITH A MOUSE.
         *
         * On a phone there is no hover, so "no chrome until you touch it" meant no chrome
         * ever: "Refresh", "Cancel" and "Dub another video" read as plain grey words, and
         * people could not tell they were buttons. A coarse pointer gets a faint fill and
         * a 1px ring - drawn with box-shadow, so nothing moves or resizes.
         */
        ghost: clsx(
          'bg-transparent text-fg-muted hover:bg-ink-850 hover:text-fg',
          'pointer-coarse:bg-ink-800/70 pointer-coarse:ring-1 pointer-coarse:ring-inset pointer-coarse:ring-ink-600',
        ),
        /**
         * A real white outline. Previously `border-ink-600`, a mid grey that only
         * looked white next to nothing else — the point of this variant is a
         * visible ring, so it is drawn in white at a readable opacity.
         */
        outline:
          'border-2 border-white/40 bg-transparent text-fg hover:border-white/70 hover:bg-white/[0.06]',
        /** Destructive. Red is a state, so it is allowed a hue. */
        danger: 'border-2 border-bad/45 bg-bad/12 text-bad hover:border-bad/70 hover:bg-bad/20',
      },
      /*
        These are the FINE-POINTER heights. On a coarse pointer every one of them is
        floored at 44px by a `@media (pointer: coarse)` rule in styles.css, so `sm`
        (32px) and `icon` (36px) — both comfortable with a cursor and a miss with a
        thumb — grow on a phone without being inflated on a desktop.

        The floor lives in CSS rather than as a `pointer-coarse:min-h-11` class here
        for one reason: it then covers every hand-rolled control in the app too, not
        just the ones that happen to use this component. There were a dozen of those.
      */
      size: {
        sm: 'h-8 px-3.5 text-small',
        md: 'h-10 px-5 text-body',
        lg: 'h-12 px-7 text-body',
        icon: 'h-9 w-9 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  loading?: boolean;
}

/**
 * The button's classes, for an element that NAVIGATES rather than acts.
 *
 * A link that looks like a button must still be a link - `<Link><Button/></Link>` puts a
 * <button> inside an <a>, which is invalid HTML, announces as two controls to a screen
 * reader, and on iOS the inner button can swallow the tap. So a navigation styled as a
 * button is an <a> (or a router <Link>) carrying these classes instead.
 */
export function buttonClass(opts: VariantProps<typeof button> = {}, className?: string): string {
  return clsx(button(opts), className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx(button({ variant, size }), className)}
      disabled={disabled || loading}
      // Announce the busy state instead of only showing a spinner, or a screen
      // reader user has no idea the click landed.
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

/**
 * The trailing chevron for a call to action.
 *
 * It slides 2px right on hover. Frequency tier is "occasional" and the purpose is
 * feedback, so it earns motion — but only `transform`, only 160ms, gated to fine
 * pointers because a tap on a touchscreen fires a hover that would leave the arrow
 * parked in its moved position.
 *
 * `-mr-0.5` pulls the optical right edge back in: a chevron is mostly empty space
 * on its right, so without it the button looks lopsided against its own padding.
 */
export function Chevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={clsx(
        '-mr-0.5 size-4 shrink-0',
        'transition-transform duration-[160ms] ease-[var(--ease-out-strong)]',
        'pointer-fine:group-hover/btn:translate-x-0.5',
        'motion-reduce:transition-none',
        className,
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/**
 * The spinner is a CSS animation, not JS: it has to keep turning smoothly while
 * the main thread is busy doing the thing it is announcing. A
 * requestAnimationFrame spinner stutters exactly when it matters most.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={clsx('size-4 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
