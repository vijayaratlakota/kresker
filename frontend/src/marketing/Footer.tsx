import { Link } from 'react-router-dom';

import { Logo } from '../ui/Logo';
import { LANG_COUNT } from '../lib/seo';
import { Shell } from '../ui/primitives';

const COLUMNS = [
  {
    heading: 'Product',
    links: [
      { label: 'How it works', href: '/#how' },
      // The page, not the homepage anchor. See the note on LINKS in Nav.tsx.
      //
      // The count is READ OFF THE CATALOGUE, not typed. A hand-written "43" in a footer
      // is wrong the day a language is added, and it is the last place anyone would
      // think to update.
      { label: `All ${LANG_COUNT} languages`, href: '/languages' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'FAQ', href: '/#faq' },
    ],
  },
  {
    heading: 'Account',
    links: [
      { label: 'Log in', href: '/login' },
      { label: 'Create an account', href: '/signup' },
      { label: 'Reset password', href: '/reset' },
      { label: 'Dashboard', href: '/app' },
    ],
  },
  {
    // DPDP s.5 and s.13(1): the notice and the grievance route have to be findable
    // from anywhere, so they get a column of their own rather than a line of small
    // print under the copyright.
    heading: 'Company & legal',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Contact us', href: '/contact' },
      { label: 'Privacy Notice', href: '/privacy' },
      { label: 'Terms of Service', href: '/terms' },
      { label: 'Disclaimer', href: '/disclaimer' },
      { label: 'Your data rights', href: '/contact?kind=access' },
    ],
  },
];

export function Footer() {
  // No `useGrievance()` any more: nothing here renders the officer, so the footer no
  // longer waits on the notice to load before it can draw itself.
  return (
    <footer className="border-t border-ink-700 bg-ink-900/40 py-14">
      <Shell>
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            {/* Same 31px-on-a-phone problem as the nav's wordmark, and the same fix:
                the link column below already carries `data-touch-target`, this one did
                not. See the note in Nav.tsx for why anchors opt in rather than being
                covered by the blanket rule. */}
            <Link to="/" data-touch-target className="flex items-center gap-2.5">
              <Logo className="size-7" />
              <span className="text-h4 tracking-tight">Kresker</span>
            </Link>
            <p className="mt-4 max-w-xs text-small leading-relaxed text-fg-subtle">
              One-click dubbing that keeps the speaker’s voice. Tuned by us, end to end,
              rather than resold from somebody else.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <p className="text-tiny font-medium uppercase tracking-[0.14em] text-fg-subtle">
                {col.heading}
              </p>
              {/*
                THE DENSEST CLUSTER OF UNTAPPABLE TARGETS ON THE SITE, before this.

                Twelve links with no padding at all: each one was a ~21px text line
                box, and `space-y-2.5` put the next one 10px away. On a phone that is
                twelve 21px targets separated by less than half a fingertip — you do
                not miss the link, you hit the wrong one.

                `-mx-3 px-3 py-1.5` on the anchor and `space-y-1` on the list: the
                padding grows the hit area to ~33px and the negative margin pulls the
                text back to its original left edge, so the column still lines up under
                its heading. Total vertical space is almost unchanged, because the
                gap between items shrank by as much as each item grew.

                `data-touch-target` takes them to the 44px floor on a coarse pointer.
                `flex` so the whole padded box is the link rather than just the text.
              */}
              <ul className="mt-4 space-y-1">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      data-touch-target
                      className="-mx-3 flex items-center rounded-lg px-3 py-1.5 text-small text-fg-muted transition-colors duration-[160ms] ease-[var(--ease-out-strong)] hover:text-fg"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/*
          THE GRIEVANCE BLOCK IS NOT HERE ANY MORE.

          It printed the officer's name, address and the thirty-day response line at the
          bottom of every marketing page, directly above the copyright — three lines of
          statutory small print in the most-seen part of the site, repeated on a page that
          already links to the two places it belongs.

          DPDP s.13(1) requires the contact to be PUBLISHED and reachable, not to be in a
          footer. It is on About under "Who we are", on the Privacy Notice, and on the
          Contact page beside the rights form — all three linked from the column above,
          one click from anywhere.
        */}
        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-ink-700 pt-6 sm:flex-row sm:items-center">
          <p className="text-tiny text-fg-subtle">
            © {new Date().getFullYear()} Kresker. All rights reserved.
          </p>
          <p className="text-tiny text-fg-subtle">
            One cookie, no trackers. Videos are deleted automatically.
          </p>
        </div>
      </Shell>
    </footer>
  );
}
