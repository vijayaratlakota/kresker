/**
 * A real modal, built because an inline panel lost a customer their upgrade.
 *
 * THE BUG THIS EXISTS FOR. The plan-change confirmation used to render inline near the
 * top of the billing page. Somebody scrolled down to the plan cards, pressed "Upgrade to
 * Pro", and saw nothing happen — the panel had appeared correctly, above the viewport,
 * off screen. The request had already succeeded. They pressed it five more times, each
 * one refused by the payment provider because a change was already in flight, and every
 * refusal was reported as a server error. Then the rate limit locked them out for an
 * hour. All of it downstream of a panel they could not see.
 *
 * Focusing the confirm button was supposed to bring it into view. `HTMLElement.focus()`
 * scrolls on desktop browsers and does NOT on iOS Safari, which is where this happened.
 *
 * So: a portal to <body>, fixed positioning, centred in the viewport. It cannot be off
 * screen, cannot be clipped by an ancestor's `overflow: hidden`, and does not care where
 * the page is scrolled to.
 *
 * WHAT IT OWES THE PAGE, all four of them:
 *
 *  1. SCROLL LOCK and ESCAPE — delegated to `useDrawer`, which already does both
 *     correctly including the scrollbar-gutter compensation. Not reimplemented here.
 *  2. FOCUS TRAP — implemented, unlike the drawers. `useDrawer` deliberately does not
 *     trap, and says so: for a nav sheet, tabbing into the page behind is untidy. For a
 *     dialog whose primary button takes money it is not acceptable, so Tab and Shift+Tab
 *     cycle within the dialog.
 *  3. FOCUS RESTORE — the element that opened it gets focus back on close, so a keyboard
 *     user is not dumped at the top of the document.
 *  4. ANNOUNCEMENT — `role="dialog"`, `aria-modal`, and the title wired through
 *     `aria-labelledby` so a screen reader says what this is about.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useDrawer } from '../lib/useDrawer';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  labelClose = 'Close',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Optional line under the title. Also announced, via aria-describedby. */
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  labelClose?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const close = useCallback(() => onClose(), [onClose]);
  useDrawer(open, close);

  // Remember who opened it, move focus in, and give focus back on the way out.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;

    // The first focusable inside the dialog, or the dialog itself if it has none.
    // Deliberately not the close button: the primary action should be under the
    // customer's thumb, and it is first in the DOM order of the footer.
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();

    return () => {
      // Guard the restore: the trigger may have unmounted while the dialog was open,
      // and focusing a detached node silently sends focus to <body>.
      const el = restoreTo.current;
      if (el && document.contains(el)) el.focus();
    };
  }, [open]);

  // The trap. Only Tab is intercepted; Escape belongs to useDrawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panel.current) return;
      const items = Array.from(
        panel.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Wrap at both ends, and pull focus back in if it has escaped the dialog
      // entirely — which happens when the browser moves it to <body> mid-render.
      if (e.shiftKey && (active === first || !panel.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-5"
      // The backdrop is the click target, and the check for `currentTarget` is what
      // stops a click that started inside the panel from closing it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        aria-hidden="true"
        className="modal-veil absolute inset-0 bg-ink-950/80 backdrop-blur-sm"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={clsx(
          'modal-panel relative w-full max-w-lg outline-none',
          // Bottom sheet on a phone, centred card above `sm`. A dialog pinned to the
          // middle of a small screen puts its buttons under the browser chrome on
          // shorter devices; along the bottom edge they are where the thumb already is.
          'rounded-t-[var(--radius-card)] sm:rounded-[var(--radius-card)]',
          // `material-raised` supplies the surface AND the depth, so the old
          // `bg-ink-850 shadow-2xl` pair is gone: it is blurred harder and tinted
          // lighter than the sidebar on purpose, because a small surface that is
          // thicker than a large one is what makes it read as being in front
          // rather than as the same glass at a different brightness.
          'material-raised border border-ink-700',
          // Never taller than the viewport, and scrollable inside if the content is
          // long. `max-h-[90dvh]` rather than `vh` so mobile browser chrome counts.
          'max-h-[90dvh] overflow-y-auto',
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <h2 id={titleId} className="text-h5">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-small text-fg-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={labelClose}
            className={clsx(
              'shrink-0 rounded-lg p-1.5 text-fg-subtle',
              'transition-colors duration-[160ms] ease-[var(--ease-out-strong)]',
              'hover:bg-ink-800 hover:text-fg',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
            )}
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 sm:px-6">{children}</div>

        {footer && (
          <div
            className={clsx(
              'flex flex-wrap gap-3 border-t border-ink-700 px-5 py-4 sm:px-6',
              // The safe-area inset matters here: as a bottom sheet on a phone with a
              // home bar, the primary button would otherwise sit under it.
              'pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4',
            )}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
