/**
 * Public pricing.
 *
 * Reads the same /api/billing/plans the dashboard does, so the marketing page can
 * never quote a price the product does not charge.
 */
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Plan, type PlansResponse } from '../lib/api';
import { rupees } from '../lib/format';
import { GST_PERCENT, LANG_COUNT, PLANS, ROUTES, withTaxPaise } from '../lib/seo';
import { Button } from '../ui/Button';
import { Badge, Card, ErrorNote, InfoNote, Reveal, Shell } from '../ui/primitives';
// The accessible <table> the privacy notice already uses: real <caption>, real
// scope="col" headers, and the min-width clamp that stops a narrow table forcing the
// whole page to scroll sideways on a phone. Reusing it rather than writing a second
// table means the comparison below cannot drift from the ones a regulator reads.
import { DataTable } from '../legal/LegalPage';
import { Footer } from './Footer';
import { Nav } from './Nav';

/**
 * ── WHY THERE IS A FALLBACK PRICE LIST AT ALL ────────────────────────────────
 *
 * This page still reads `/api/billing/plans`, and the live answer still wins the
 * moment it arrives — that guarantee has not changed. What changed is what is on
 * screen BEFORE it arrives.
 *
 * It used to be four grey skeletons. Fine for a human waiting 200ms; useless for the
 * two readers that never wait:
 *
 *   * The prerenderer (`src/entry-server.tsx`) renders this component to a string at
 *     build time. `useEffect` never runs there, so `data` stayed null and every build
 *     wrote a `/pricing` page whose entire content was four empty boxes. A prerendered
 *     pricing page with no prices in it is worse than no prerendering, because every
 *     check passes while the page says nothing.
 *   * Anything reading the served HTML without executing JavaScript, which is every
 *     AI crawler.
 *
 * So the render starts from a static snapshot and is corrected by the API. The
 * snapshot lives in `lib/seo.ts` next to the schema that also needs it, and
 * `backend/_test_seo.py` fails the build if it drifts from `db.DEFAULT_PLANS`.
 *
 * WHAT THE SNAPSHOT DELIBERATELY DOES NOT CLAIM: `purchasable` and `checkout_mode`.
 * Whether buying is open depends on live provider configuration that no build-time
 * constant can know, so the fallback marks every plan purchasable for DISPLAY and
 * the buttons here only ever link to `/signup` — they never start a checkout. The
 * real gate stays server-side on `open`.
 */
const FALLBACK: PlansResponse = {
  currency: 'INR',
  live: false,
  open: false,
  plans: PLANS.map<Plan>((p) => {
    const taxed = p.interval === 'lifetime' ? 0 : withTaxPaise(p.pricePaise);
    return {
      code: p.code,
      name: p.name,
      interval: p.interval,
      price_paise: p.pricePaise,
      price_rupees: p.pricePaise / 100,
      minutes_per_period: p.minutes,
      max_video_seconds: p.maxVideoSeconds,
      output_retention_days: p.retentionDays,
      purchasable: p.pricePaise > 0,
      checkout_mode: null,
      mandate_eligible: false,
      price_excludes_tax: p.pricePaise > 0,
      tax_percent: p.pricePaise > 0 ? GST_PERCENT : 0,
      price_with_tax_paise: taxed,
      tax_note:
        p.pricePaise > 0
          ? `plus ${GST_PERCENT}% GST. The exact tax is worked out at the payment page ` +
            'from your billing details.'
          : '',
      auto_renews: p.interval === 'month',
      renewal_note: '',
    };
  }),
};

export function Pricing() {
  // Seeded, not null. See the note on FALLBACK above.
  const [data, setData] = useState<PlansResponse>(FALLBACK);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');

  useEffect(() => {
    api.billing
      .plans()
      .then(setData)
      // The error note still shows, because a stale-but-plausible price list on screen
      // is exactly the situation where the reader deserves to be told we could not
      // reach the server. What it must not do is blank the page.
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load prices.'));
  }, []);

  const free = data.plans.find((p) => p.code === 'free');
  const paid = data.plans.filter((p) => p.interval === interval && p.purchasable);

  return (
    <div className="min-h-dvh bg-ink-950">
      <Nav />

      <section className="relative overflow-hidden pt-32 pb-16 sm:pt-40">
        <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_55%_45%_at_50%_0%,black,transparent)]" />
        <Shell className="relative">
          <div className="stagger mx-auto max-w-2xl text-center">
            <h1 className="text-gradient text-balance text-h1 sm:text-display">
              Pay for minutes, not seats
            </h1>
            <p className="mx-auto mt-5 max-w-lg text-h4 leading-relaxed text-fg-muted">
              Every plan includes voice cloning, all languages and unlimited downloads. The
              only thing that changes is how many minutes you get and how long we keep your
              videos.
            </p>
          </div>

          <div className="mt-10 flex items-center justify-center gap-3">
            <div className="flex gap-1 rounded-full border-2 border-ink-600 bg-ink-900 p-1">
              {(['month', 'year'] as const).map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setInterval(i)}
                  aria-pressed={interval === i}
                  className={clsx(
                    'rounded-full px-5 py-2 text-small transition-[background-color,color] duration-[160ms] ease-[var(--ease-out-strong)]',
                    interval === i ? 'bg-ink-800 font-medium text-fg' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {i === 'month' ? 'Monthly' : 'Annual'}
                </button>
              ))}
            </div>
            {interval === 'year' && <Badge tone="good">Save 20%</Badge>}
          </div>
        </Shell>
      </section>

      <section className="pb-20">
        <Shell>
          {error && <ErrorNote>{error}</ErrorNote>}

          {/*
            NO SKELETON BRANCH ANY MORE. There is always a price list to draw — see
            FALLBACK at the top of this file — so there is no loading state to
            represent. The four grey boxes that used to be here were what the
            prerenderer captured, which is how `/pricing` came to ship with no prices
            in its HTML.
          */}
          <div className="grid gap-4 lg:grid-cols-4">
              {free && (
                <Reveal>
                  {/*
                    `.lift` — 2px up and a brighter edge on hover. This is the one
                    surface in the product where it belongs: four cards side by side
                    that are a CHOICE, so the affordance is "this whole card is the
                    thing you are picking", not just the button at the bottom.

                    It does nothing on a phone. The class is disabled under a
                    coarse-pointer media query in styles.css, because a tap would
                    otherwise leave the card floating with no pointer to leave.
                  */}
                  <Card className="lift flex h-full flex-col p-6 hover:border-ink-600">
                    {/* The same reserved slot the paid cards have, so this card's name
                        lines up with theirs. Never visible here. */}
                    <div className="mb-3">
                      <Badge tone="brand" className="invisible" aria-hidden="true">
                        Most picked
                      </Badge>
                    </div>
                    <h2 className="text-h4">{free.name}</h2>
                    <p className="mt-4 text-h2 leading-none">₹0</p>
                    <p className="mt-1.5 text-tiny text-fg-subtle">Lifetime, not monthly</p>
                    <ul className="mt-5 flex-1 space-y-2.5 text-small text-fg-muted">
                      <Tick>{free.minutes_per_period} minute, once</Tick>
                      <Tick>Videos up to {free.max_video_seconds} seconds</Tick>
                      <Tick>Kept {free.output_retention_days * 24} hours</Tick>
                      <Tick>Speaker voice cloning</Tick>
                    </ul>
                    <Link to="/signup" className="mt-5">
                      <Button variant="secondary" className="w-full">
                        Start free
                      </Button>
                    </Link>
                  </Card>
                </Reveal>
              )}

              {paid.map((p, i) => {
                const featured = p.code.startsWith('creator');
                return (
                  <Reveal key={p.code} delay={(i + 1) * 60}>
                    <Card
                      className={clsx(
                        'lift relative flex h-full flex-col p-6 hover:border-ink-500',
                        featured && 'border-ink-600',
                      )}
                    >
                      {/*
                        INSIDE THE CARD, IN THE FLOW.

                        This was `absolute -top-2.5 left-6`, so the badge hung ten pixels
                        above the card's own top edge. It looked like a sticker on a
                        mock-up and like a bug on the site: an ancestor clips overflow, so
                        the top of the badge was sliced off and it read as a rendering
                        fault rather than a label.

                        Rendered on EVERY card, invisible where it does not apply, so the
                        badge reserves its own height and the plan names stay on one line
                        across all four. A conditional block would push the featured card's
                        content down by exactly the badge's height and misalign the row -
                        and a hard-coded `h-[22px]` placeholder would drift the moment the
                        badge's padding or type size changed.
                      */}
                      <div className="mb-3">
                        <Badge
                          tone="brand"
                          className={featured ? undefined : 'invisible'}
                          aria-hidden={featured ? undefined : true}
                        >
                          Most picked
                        </Badge>
                      </div>
                      <h2 className="text-h4">{p.name}</h2>
                      <p className="mt-4 flex items-baseline gap-1.5">
                        <span className="text-h2 tabular-nums leading-none">
                          {rupees(p.price_paise)}
                        </span>
                        <span className="text-small text-fg-subtle">
                          /{p.interval === 'month' ? 'mo' : 'yr'}
                        </span>
                      </p>
                      {/*
                        THE PRICE ABOVE IS NET OF GST, so this line is not optional. The
                        products are tax-exclusive at the payment provider: the plan fee is
                        ours and the tax is added at the payment page. Without this the
                        customer meets a number about a fifth larger than the one we
                        advertised, which is the sort of surprise that ends in a chargeback
                        rather than a subscription.

                        The total is shown as well as the percentage because "+18% GST"
                        still leaves the reader doing arithmetic on their own money.
                      */}
                      {p.price_excludes_tax && (
                        <p className="mt-1 text-tiny text-fg-subtle">
                          + {p.tax_percent}% GST · about{' '}
                          <span className="tabular-nums">
                            {rupees(p.price_with_tax_paise)}
                          </span>{' '}
                          total
                        </p>
                      )}
                      <p className="mt-1.5 text-tiny text-fg-subtle">
                        {p.auto_renews ? 'Renews automatically' : 'One-time payment'}
                      </p>

                      <ul className="mt-5 flex-1 space-y-2.5 text-small text-fg-muted">
                        <Tick>
                          {p.minutes_per_period} minutes {p.interval === 'month' ? 'a month' : 'a year'}
                        </Tick>
                        <Tick>Videos up to {Math.floor(p.max_video_seconds / 60)} minutes</Tick>
                        <Tick>Kept {p.output_retention_days} days</Tick>
                        <Tick>Unlimited downloads</Tick>
                        <Tick>All languages</Tick>
                      </ul>

                      <Link to="/signup" className="mt-5">
                        <Button variant={featured ? 'primary' : 'secondary'} className="w-full">
                          Choose {p.name}
                        </Button>
                      </Link>
                    </Card>
                  </Reveal>
                );
              })}
          </div>

          {interval === 'year' && (
            <div className="mt-8">
              <InfoNote>
                <span className="font-medium">Annual is a one-time payment, and it does not renew itself. </span>
                Recurring debits above ₹15,000 require the customer to authenticate again
                on every charge — which nobody is there to do on a renewal — so the charge
                would fail quietly and the plan would lapse without anyone choosing to
                cancel. A one-off payment is not affected by that rule, so we use one. We
                email you at 14 days, 3 days and on the day, and your access continues for
                7 days past the end date.
              </InfoNote>
            </div>
          )}

          <p className="mt-8 text-center text-tiny text-fg-subtle">
            A failed dub is never charged. Deleting a video early does not return the
            minutes, because the work was already done.
          </p>
        </Shell>
      </section>

      {/*
        ── EVERYTHING BELOW THIS LINE IS NEW, AND WHY ─────────────────────────

        This page was 252 words. It showed four cards and answered none of the
        questions somebody actually has before paying:

          * What is "a minute"? Video length, or processing time?
          * What happens when I run out mid-month?
          * Why is there no per-user price?
          * Is ₹299 what leaves my bank?
          * How long do you keep the file?

        Four of those five were answered somewhere in the product — in the dashboard,
        in an email, in the terms — and nowhere a stranger deciding whether to pay
        would look. A commercial page shorter than its own disclaimer is not a
        pricing page, it is a price list.

        THE TABLE IS DELIBERATE, not decoration. AI search systems quote tables
        readily — comparative data in rows is the shape they extract best — and this
        site had zero `<table>` elements anywhere. It is also simply the right control
        for "four plans, six attributes": the cards above are for choosing, the table
        is for comparing, and a card grid cannot do the second job at four columns.
      */}
      <section id="compare" className="border-t border-ink-700 py-20">
        <Shell>
          <Reveal>
            <h2 className="text-balance text-h2">Every plan, side by side</h2>
            <p className="mt-4 max-w-2xl text-body leading-relaxed text-fg-muted">
              Voice cloning, all {LANG_COUNT} languages and unlimited downloads are on
              every plan, including the free one. Only three things change: how many
              minutes you get, how long a single video may be, and how long we keep the
              finished file.
            </p>
          </Reveal>

          <Reveal className="mt-8" delay={60}>
            <DataTable
              caption={`Kresker plan comparison: price, minutes, maximum video length and file retention`}
              head={['Plan', 'Price', 'Minutes', 'Longest video', 'Files kept', 'Renews']}
              rows={[
                ...(free
                  ? [[
                      free.name,
                      '₹0',
                      `${free.minutes_per_period} minute, once (lifetime)`,
                      `${free.max_video_seconds} seconds`,
                      `${Math.round(free.output_retention_days * 24)} hours`,
                      'Never — nothing to cancel',
                    ]]
                  : []),
                ...paid.map((p) => [
                  p.name,
                  `${rupees(p.price_paise)} + ${p.tax_percent}% GST (about ${rupees(
                    p.price_with_tax_paise,
                  )})`,
                  `${p.minutes_per_period} ${p.interval === 'month' ? 'a month' : 'a year'}`,
                  `${Math.floor(p.max_video_seconds / 60)} minutes`,
                  `${p.output_retention_days} days`,
                  p.auto_renews ? 'Monthly, cancel any time' : 'One-time payment',
                ]),
              ]}
            />
          </Reveal>

          <p className="mt-3 text-tiny text-fg-subtle">
            Showing {interval === 'month' ? 'monthly' : 'annual'} plans. Use the toggle
            above to switch.
          </p>
        </Shell>
      </section>

      {/*
        The questions, as questions.

        Written as `<h3>` in question form rather than as a paragraph of prose,
        because that is the shape a search query has and the shape an AI answer
        quotes. Not marked up as FAQPage schema: Google retired FAQ rich results for
        every site on 7 May 2026, so the markup earns nothing in a result now. The
        question-shaped headings still do the work.

        Visible on load, not behind an accordion. Google treats content hidden in an
        expandable section as less likely to be the page's primary content, and every
        one of these is a reason somebody does or does not pay.
      */}
      <section id="questions" className="border-t border-ink-700 py-20">
        <Shell>
          <Reveal>
            <h2 className="text-balance text-h2">What the price actually means</h2>
          </Reveal>

          <div className="mt-10 grid gap-8 lg:grid-cols-2">
            {PRICING_QA.map((qa, i) => (
              <Reveal key={qa.q} delay={i * 50}>
                <h3 className="text-h5">{qa.q}</h3>
                <div className="mt-2 space-y-2 text-small leading-relaxed text-fg-muted">
                  {qa.a}
                </div>
              </Reveal>
            ))}
          </div>

          {/*
            A VISIBLE, REAL DATE. There was no date anywhere on this site — no <time>
            element on any page — and an undated commercial page is both less
            trustworthy to a reader and, per the claude-seo evidence, materially less
            likely to be cited in an AI answer (content under three months old is
            roughly 3x more likely; stale-looking content loses eligibility).

            It reads from ROUTES in lib/seo.ts, which is the same value the sitemap
            publishes as `lastmod` — backend/_test_seo.py fails if they drift. So this
            cannot become the kind of "last updated" line that is itself out of date.
          */}
          <p className="mt-12 text-tiny text-fg-subtle">
            Prices and limits last reviewed{' '}
            <time dateTime={PRICING_UPDATED}>{prettyDate(PRICING_UPDATED)}</time>. All
            prices are in Indian rupees and exclude {GST_PERCENT}% GST.
          </p>
        </Shell>
      </section>

      <Footer />
    </div>
  );
}

/**
 * The date this page's commercial terms were last reviewed.
 *
 * Read from `ROUTES` rather than typed here, so the visible line and the sitemap's
 * `lastmod` are one value. `backend/_test_seo.py` asserts they agree.
 */
const PRICING_UPDATED = ROUTES.find((r) => r.path === '/pricing')?.updated ?? '';

/** "2 September 2026" — spelled out, because 02/09 and 09/02 are different dates. */
function prettyDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${d} ${months[m - 1]} ${y}`;
}

/**
 * The five questions this page did not answer.
 *
 * Kept as data rather than inline JSX so the section stays readable and so the order
 * is obvious: the two that decide whether somebody pays at all come first.
 *
 * Every number in here is derived or stated in prose that matches the database —
 * nothing is a rounded-off marketing figure.
 */
const PRICING_QA: { q: string; a: React.ReactNode }[] = [
  {
    q: 'What counts as a minute?',
    a: (
      <>
        <p>
          The length of your video, not how long we spend on it. A 90-second clip costs
          90 seconds of your allowance whether it takes us four minutes or forty, and it
          costs the same whether you dub it into one language or eight — each language is
          a separate dub of the same length, so eight languages of a 90-second clip is
          twelve minutes.
        </p>
        <p>
          We measure the file ourselves rather than trusting what it claims, and the cost
          is shown before anything runs.
        </p>
      </>
    ),
  },
  {
    q: 'What happens when I run out?',
    a: (
      <>
        <p>
          Nothing is charged automatically and nothing is cut off mid-job. A dub already
          running finishes. The next one is refused before it starts, with the shortfall
          stated, and you can either top up minutes or wait for the next period.
        </p>
        <p>
          There is no overage rate, because a surprise bill for a video you forgot you
          queued is the worst thing a tool like this can do to you.
        </p>
      </>
    ),
  },
  {
    q: `Is ₹299 what leaves my bank?`,
    a: (
      <>
        <p>
          No — {GST_PERCENT}% GST is added at the payment page, so the cheapest plan
          arrives at about ₹353. Our prices are quoted net of tax because the tax is not
          ours: it is collected on top and passed on.
        </p>
        <p>
          The exact figure is worked out by the payment provider from your billing
          details, and it can differ by a rupee or two from the estimate shown here
          because the charge is settled through another currency on the way.
        </p>
      </>
    ),
  },
  {
    q: 'Why is there no per-user price?',
    a: (
      <p>
        Because the cost of a dub is the video, not the person who uploaded it. Seat
        pricing exists for tools where the expensive part is the software licence; here
        the expensive part is the hardware that runs for the length of your footage.
        Charging by seat would mean a solo creator dubbing forty minutes pays the same as
        a team of four dubbing two, which is backwards.
      </p>
    ),
  },
  {
    q: 'How long do you keep my video?',
    a: (
      <>
        <p>
          Twenty-four hours on the free plan and seven days on every paid plan, then it
          is deleted automatically. You can delete it yourself sooner, and the dashboard
          shows the exact date rather than a countdown.
        </p>
        <p>
          Deleting early does not return the minutes, because the work was already done.
          Downloads are unlimited while the file exists.
        </p>
      </>
    ),
  },
];

function Tick({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <svg viewBox="0 0 24 24" className="mt-0.5 size-3.5 shrink-0 text-good" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {children}
    </li>
  );
}
