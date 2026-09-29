/**
 * The shared shell for the legal and company pages: Privacy, Terms, Disclaimer,
 * About, Contact.
 *
 * One component rather than five copies of a header, because these pages will be
 * edited by a lawyer rather than by whoever wrote them, and a reviewer should be
 * able to see the words without navigating five different layouts.
 *
 * The `review` flag renders a visible banner. It is not decoration: every page that
 * carries it contains text that has NOT been through legal review, and a draft
 * privacy notice that looks finished is worse than an obviously unfinished one —
 * somebody will rely on it.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Footer } from '../marketing/Footer';
import { Nav } from '../marketing/Nav';
import { Shell } from '../ui/primitives';

export function LegalPage({
  title,
  lede,
  updated,
  review,
  children,
}: {
  title: string;
  lede?: ReactNode;
  /** Notice version or last-changed date. Shown so a reader can tell drift. */
  updated?: string;
  review?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-ink-950">
      <Nav />

      <header className="relative overflow-hidden pt-32 pb-10 sm:pt-40">
        <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_55%_45%_at_50%_0%,black,transparent)]" />
        <Shell className="relative">
          <div className="max-w-3xl">
            <h1 className="text-balance text-h1 sm:text-display">{title}</h1>
            {lede && (
              <p className="mt-5 max-w-2xl text-h4 leading-relaxed text-fg-muted">{lede}</p>
            )}
            {updated && (
              <p className="mt-5 text-tiny uppercase tracking-[0.14em] text-fg-subtle">
                {updated}
              </p>
            )}
          </div>
        </Shell>
      </header>

      <Shell className="relative pb-24">
        {review && (
          <div
            role="note"
            data-legal-review="true"
            className="mb-10 max-w-3xl rounded-xl border border-warn/40 bg-warn/10 px-4 py-3.5 text-small leading-relaxed text-warn"
          >
            <strong className="font-medium">LEGAL REVIEW PENDING.</strong> This text was
            drafted by the engineering team to describe what the software actually does. It
            has not been reviewed by a lawyer and is not legal advice. Treat it as an
            accurate technical description and a draft legal document.
          </div>
        )}
        <div className="max-w-3xl">{children}</div>
      </Shell>

      <Footer />
    </div>
  );
}

/* ── prose pieces ────────────────────────────────────────────────────────── */

/**
 * A numbered section with a stable anchor, so a reviewer or a support reply can
 * link to one clause rather than to the top of a long page.
 */
export function Clause({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-ink-700 py-9 first:border-t-0 first:pt-0">
      <h2 className="text-h3 tracking-tight">
        {n && <span className="mr-2.5 font-mono text-fg-subtle">{n}</span>}
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-body leading-relaxed text-fg-muted">{children}</div>
    </section>
  );
}

export function Bullets({ items, className }: { items: ReactNode[]; className?: string }) {
  return (
    <ul className={clsx('space-y-2.5', className)}>
      {items.map((it, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden="true" className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-fg-subtle" />
          <span className="min-w-0 flex-1">{it}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A two-column table for "what we collect / why" and "who gets it / what".
 *
 * Rendered as a real <table> rather than a grid of divs: this is tabular data, a
 * screen reader should be able to announce the column a cell belongs to, and a
 * regulator reading it will expect a table.
 */
export function DataTable({
  caption,
  head,
  rows,
}: {
  caption?: string;
  head: string[];
  rows: ReactNode[][];
}) {
  /*
    `min-w-` clamped against the viewport rather than left at a flat 34rem.

    A bare `min-w-[34rem]` is 544px, which is 184px wider than a 360px phone, so the
    table always overflowed and the page always scrolled sideways — even for a
    two-column table that would have fitted. Clamping to the viewport lets narrow
    tables fit and leaves the genuinely wide ones scrollable, which is the behaviour
    the `overflow-x-auto` was put here for in the first place.
  */
  return (
    <div className="overflow-x-auto rounded-xl border border-ink-700">
      <table className="w-full min-w-[min(34rem,100%)] border-collapse text-left text-small">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-ink-700 bg-ink-900">
            {head.map((h) => (
              <th key={h} scope="col" className="px-4 py-3 font-medium text-fg">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-ink-700 last:border-b-0">
              {r.map((c, j) => (
                <td key={j} className="px-4 py-3 align-top text-fg-muted">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
