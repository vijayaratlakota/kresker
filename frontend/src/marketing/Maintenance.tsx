/**
 * Shown instead of the whole app while the site is in maintenance mode.
 *
 * RENDERED OUTSIDE THE ROUTER, and that is why this file must not use anything from
 * react-router. `App` returns this in place of `<BrowserRouter>` - it is the page for
 * every path while the site is off - so a router `<Link>` in here threw ("useHref() may
 * be used only in the context of a <Router>"), nothing caught it, React unmounted the
 * root, and every visitor got a blank screen instead of this page. Plain elements only.
 *
 * The one way to reach us is an email address, not the contact page: while the site is
 * off, /contact is this same page again and the API behind the contact form is closed.
 *
 * No auto-refresh loop. App's own /api/site probe already polls, and swaps the real site
 * back in by itself when an admin switches maintenance off.
 */
import { SUPPORT_EMAIL } from '../lib/seo';
import { buttonClass } from '../ui/Button';
import { Logo } from '../ui/Logo';

export function Maintenance({
  note,
  since,
}: {
  note?: string | null;
  since?: string | null;
}) {
  return (
    <div
      data-maintenance="true"
      className="relative grid min-h-dvh place-items-center overflow-hidden bg-ink-950 px-5 text-center"
    >
      <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_50%_40%_at_50%_40%,black,transparent)]" />
      <main className="stagger relative max-w-lg">
        <span className="mb-8 inline-flex items-center gap-2.5">
          <Logo className="size-8" />
          <span className="text-body font-medium tracking-tight">Kresker</span>
        </span>

        <p className="text-tiny uppercase tracking-[0.16em] text-warn">Maintenance</p>
        <h1 className="mt-3 text-balance text-h2">We are making some changes</h1>

        {note && (
          <p className="mx-auto mt-4 max-w-md text-body leading-relaxed text-fg-muted">
            {note}
          </p>
        )}

        {/* The three questions somebody actually has, answered. */}
        <ul className="mx-auto mt-7 max-w-sm space-y-2.5 text-left">
          {[
            'Your videos are not being deleted.',
            'Your minutes are not being spent.',
            'Any dub that was running will still be there.',
          ].map((t) => (
            <li key={t} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="mt-1 grid size-4 shrink-0 place-items-center rounded-full bg-good/15 text-good"
              >
                <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              </span>
              <span className="text-small leading-relaxed text-fg-muted">{t}</span>
            </li>
          ))}
        </ul>

        <div className="mt-8 flex justify-center gap-3">
          <a href={`mailto:${SUPPORT_EMAIL}`} className={buttonClass({ variant: 'secondary' })}>
            Email us
          </a>
        </div>
        <p className="mt-3 text-tiny text-fg-subtle">{SUPPORT_EMAIL}</p>

        {since && (
          <p className="mt-6 text-tiny text-fg-subtle">
            Since {since.replace('T', ' ').replace('Z', '')} UTC.
          </p>
        )}
      </main>
    </div>
  );
}
