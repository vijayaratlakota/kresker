import { useEffect } from 'react';

/**
 * The three things an open overlay owes the page, and none of them were being done.
 *
 * The marketing nav sheet and the dashboard sidebar were both built correctly as far
 * as the ANIMATION goes — clip-path on one, a composited transform on the other — and
 * both were missing the same three behaviours. All three are invisible on a desktop,
 * where you close a menu by clicking somewhere else without thinking about it.
 *
 * 1. SCROLL LOCK. With the sheet open the page still scrolled underneath it. On the
 *    marketing site that is worse than untidy: the header is `position: fixed`, so
 *    scrolling moved the whole page out from under a menu that stayed put, and the
 *    links ended up floating over the middle of some unrelated section.
 *
 *    Locked by setting `overflow: hidden` on <body> AND compensating for the
 *    scrollbar's width. Without the compensation the page jumps sideways by 10px the
 *    instant the menu opens, on every desktop browser that reserves gutter space —
 *    which is the classic version of this bug, and is why the padding is applied
 *    rather than just the overflow.
 *
 *    `position: fixed` on the body is the other common recipe and it is worse: it
 *    scrolls the page to the top, so closing the menu loses the reader's place.
 *
 * 2. ESCAPE. An overlay that traps focus-adjacent attention with no keyboard exit is
 *    a dead end. One listener, removed on close.
 *
 * 3. CLOSE ON NAVIGATION is already handled by both callers via the pathname effect,
 *    so it is deliberately NOT duplicated here.
 *
 * What this does NOT do is trap focus. That needs an inert/focus-scope treatment of
 * the rest of the tree to be done properly, and a half-implementation — cycling Tab
 * inside the panel while the page behind stays reachable by screen reader — is worse
 * than none because it looks finished. Both drawers keep their real `<button>`
 * trigger with `aria-expanded`, so the state is announced correctly; that is the
 * honest current position and it is written down rather than left implied.
 */
export function useDrawer(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;

    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;

    // The gutter the scrollbar was occupying. 0 on mobile and on any browser using
    // overlay scrollbars, which is why it is measured rather than assumed.
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gutter > 0) body.style.paddingRight = `${gutter}px`;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
}
