/**
 * The privacy banner.
 *
 * It says what is true, which in this build is unusually little: one cookie that
 * keeps you signed in, and no trackers of any kind. That is decision D-1 — the
 * honest banner is short, and a long one listing "essential / performance /
 * marketing" categories for vendors we do not use would be a lie dressed as
 * diligence.
 *
 * What it still does:
 *
 *  - Offers the optional analytics choice, so the gate in `tracking.ts` has an
 *    answer to read. Default is refused, and refusing is one click, in the same
 *    visual weight as accepting. A dialog where "reject" is a grey link and "accept"
 *    is a bright button is a dark pattern.
 *  - Records the answer server-side for signed-in visitors, so the consent ledger
 *    holds it rather than only the browser.
 *  - Reappears when the notice version changes, because agreement to an old text is
 *    not agreement to a new one.
 *  - Never blocks the page. There is no scroll lock and no overlay: nothing here is
 *    consent for something already happening, so holding the site hostage would be
 *    pressure without purpose.
 *
 * It renders nothing at all until the notice has loaded, and nothing on the legal
 * pages themselves — a banner covering the privacy notice while you read it is
 * absurd.
 */
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Button } from '../ui/Button';
import { hasAcked, recordAck } from './tracking';
import { useNotice } from './useNotice';

const HIDE_ON = ['/privacy', '/terms', '/disclaimer'];

export function ConsentBanner() {
  const { notice } = useNotice();
  const me = useSession((s) => s.me);
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);

  // One frame before the slide-in, or the banner is already in place on first paint
  // and the transition never runs.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  if (!notice || dismissed) return null;
  if (HIDE_ON.includes(pathname)) return null;
  if (hasAcked(notice.notice_version)) return null;

  const analyticsPurpose = notice.purposes.find((p) => p.key === 'analytics');

  function answer(analytics: boolean) {
    recordAck(notice!.notice_version, analytics);
    setDismissed(true);
    // Signed-in visitors get it in the ledger too. Best-effort: the browser-side
    // record is what the gate reads, so a failed request must not block the answer.
    if (me && analyticsPurpose) {
      void api.privacy.setConsent({ analytics }, 'banner').catch(() => undefined);
    }
  }

  return (
    <div
      role="region"
      aria-label="Privacy"
      data-consent-banner="true"
      className={clsx(
        'fixed inset-x-0 bottom-0 z-40 px-4 pb-4 sm:px-6 sm:pb-6',
        'transition-[opacity,transform] duration-[250ms] ease-[var(--ease-out-strong)]',
        'motion-reduce:transition-none',
        mounted ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0',
      )}
    >
      {/* SOLID, with no blur. It was 95% with a blur, and on a phone it sits on top of
          forms: the "Sign up" button and the terms line under it read through it as
          faint text behind the banner's own text. It is a notice to be read, so nothing
          behind it should be. (The blur went with the transparency: with nothing to
          see through, it was cost with no effect.) */}
      <div className="mx-auto max-w-3xl rounded-2xl border border-ink-700 bg-ink-900 p-4 shadow-2xl sm:p-5">
        <p className="text-small leading-relaxed text-fg-muted">
          <span className="font-medium text-fg">
            We use one cookie, and it is the one that keeps you signed in.
          </span>{' '}
          No analytics, no advertising pixels, no third-party fonts or scripts. Our{' '}
          <Link to="/privacy" className="text-fg underline underline-offset-2">
            Privacy Notice
          </Link>{' '}
          lists exactly what we hold and who it goes to.
        </p>

        {analyticsPurpose && (
          <p className="mt-2.5 text-tiny leading-relaxed text-fg-subtle">
            If we ever add anonymous usage analytics, may we include you? It is off
            unless you say yes, and it changes nothing about the product either way.
          </p>
        )}

        {/*
          Same size, same shape, adjacent. The refusal is not a hidden link.
        */}
        <div className="mt-4 flex flex-wrap gap-2.5">
          <Button size="sm" variant="secondary" onClick={() => answer(false)}>
            No analytics
          </Button>
          <Button size="sm" onClick={() => answer(true)}>
            That&rsquo;s fine
          </Button>
        </div>
      </div>
    </div>
  );
}
