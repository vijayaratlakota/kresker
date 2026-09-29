/**
 * "A new version is available." One bar, at the bottom, dismissible.
 *
 * DELIBERATELY NOT A MODAL AND NOT AN AUTOMATIC RELOAD. Reloading underneath somebody
 * would throw away whatever they were in the middle of — a half-filled form, a language
 * selection, a job they were watching. The old code being out of date is a mild problem
 * almost all of the time; interrupting someone is not. So this asks.
 *
 * The one place it is NOT merely advisory is starting a payment, and that is enforced in
 * Billing.tsx rather than here: dismissing this notice hides the bar and does not make it
 * safe to run a checkout on code the server has replaced.
 *
 * WORDED FOR A CUSTOMER. No build hashes, no version numbers, nothing about deploys.
 * "We have made some improvements" is true, is all they need, and says nothing about how
 * the thing is built.
 */
import { useBuild, reloadForNewBuild } from '../lib/useBuild';
import { Button } from '../ui/Button';

export function NewVersionBar() {
  const stale = useBuild((s) => s.stale);
  const dismissed = useBuild((s) => s.dismissed);
  const dismiss = useBuild((s) => s.dismiss);

  if (!stale || dismissed) return null;

  return (
    <div
      // `polite` rather than `assertive`: this is worth mentioning, not worth cutting
      // across whatever a screen reader is currently saying.
      role="status"
      aria-live="polite"
      // Solid for the same reason as the consent banner: it covers page text, and at 95%
      // that text read faintly through its own.
      className="fixed inset-x-0 bottom-0 z-50 border-t-2 border-ink-600 bg-ink-900 px-4 py-3 sm:px-6"
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
        <p className="text-small text-fg-muted">
          <span className="font-medium text-fg">We have made some improvements. </span>
          Refresh to get the latest version.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={dismiss}>
            Not now
          </Button>
          <Button size="sm" onClick={reloadForNewBuild}>
            Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}
