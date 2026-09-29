/**
 * Everything a crawler reads, declared once.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `index.html` is a single shell, and the title, description and Open Graph tags in
 * it were STATIC. So all seven public pages served one title — "Kresker — dub any
 * video into any language" — and one description, and `og:url` pointed at the
 * homepage from every one of them. Measured with claude-seo before the change:
 *
 *     7 pages share title:       "Kresker — dub any video into any language"
 *     7 pages share description: "Kresker dubs your video into another language…"
 *     canonical:                 None, on all 7
 *     JSON-LD blocks:            0, on all 7
 *
 * The consequences, in order of how much they cost:
 *
 *   * Google could not tell the pricing page was about pricing. A title is the
 *     strongest on-page statement of what a page is for, and ours said the same
 *     thing seven times.
 *   * `/pricing`, `/pricing/`, `/PRICING` and `/pricing?x=1` all return 200 with
 *     identical bytes, and with no canonical tag there was nothing telling Google
 *     which of them is the real one. Ranking signals split across duplicates.
 *   * Sharing the pricing page in a WhatsApp group produced the homepage's preview
 *     card, and platforms that follow `og:url` sent the click to `/` instead.
 *
 * ── WHY IT IS ONE MODULE AND NOT A TAG PER PAGE ──────────────────────────────
 *
 * Three consumers have to agree, and only one of them is a browser:
 *
 *   1. `app/Seo.tsx` — updates `document.head` on client-side navigation, because
 *      after the first load React Router changes the URL without a request and
 *      nothing else would touch the title.
 *   2. `../../scripts/prerender.mjs` — bakes these values into the HTML on disk at
 *      build time. THIS is the copy that matters: AI crawlers do not execute
 *      JavaScript at all, so anything only React knows is invisible to them.
 *   3. `backend/_test_seo.py` — parses this file and asserts the plan prices below
 *      still match `db.DEFAULT_PLANS`.
 *
 * Three readers, one declaration. The alternative — a `<title>` inside each page
 * component — cannot serve the prerenderer, because the prerenderer needs the head
 * before it has rendered the body.
 *
 * ── WHAT MUST NEVER APPEAR HERE ──────────────────────────────────────────────
 *
 * Lip-sync, subtitle or caption export, and a public API. None of the three ship.
 * A description is a promise made in a search result, and a promise the product
 * cannot keep is worse than a page that ranks lower.
 */
import { LANGUAGES } from './format';

/**
 * The canonical origin. One host, no `www`, no trailing slash.
 *
 * `www.kresker.com` 301s to the apex and `http://` 301s to `https://`, so this is
 * the single address every canonical and every `og:url` points at. Overridable for
 * a staging origin, but it defaults to production rather than to localhost: a
 * canonical tag that says `http://localhost:5173` is worse than none at all, and a
 * missing env var should not be able to produce one.
 */
export const ORIGIN = (
  (import.meta.env?.VITE_PUBLIC_ORIGIN as string | undefined) ?? 'https://kresker.com'
).replace(/\/$/, '');

export const BRAND = 'Kresker';
export const SUPPORT_EMAIL = 'support@kresker.com';

/** The share card. 1200×630, already in `public/`. */
export const OG_IMAGE = `${ORIGIN}/og.png`;

/** Read off the catalogue, never typed. A hand-written count is wrong the day a
 *  language is added, and a marketing page that undercounts the product is a
 *  strange thing to maintain by hand. */
export const LANG_COUNT = LANGUAGES.length;
export const INDIAN_LANG_COUNT = LANGUAGES.filter((l) => l.group === 'india').length;

/**
 * Where each language is mainly spoken.
 *
 * ── WHY THIS IS HERE AND NOT IN `format.ts` ─────────────────────────────────
 *
 * It belongs to the marketing surface, not to the product: the picker, the job rows
 * and the download filenames have no use for it. But the real reason it is a separate
 * map is mechanical — `backend/_test_langs.py` parses `LANGUAGES` with a regex that
 * expects exactly `{ code, label, native, group }`, so adding a fifth field to those
 * rows would make that suite stop finding the catalogue at all. A parallel map keyed
 * by the same codes costs nothing and breaks nothing.
 *
 * `_test_seo.py` asserts every code in `LANGUAGES` has an entry here, so a language
 * added to the catalogue cannot appear on the languages page with a blank cell.
 *
 * These are the places a viewer of a dubbed video is most likely to be, which is not
 * the same as a complete list of countries where the language has official status.
 * Kept short on purpose: a cell listing nine countries is unreadable in a table.
 */
export const LANG_REGIONS: Record<string, string> = {
  // ── India and neighbours ───────────────────────────────────────────────────
  te: 'Andhra Pradesh, Telangana',
  hi: 'North and central India',
  ta: 'Tamil Nadu, Sri Lanka, Singapore',
  kn: 'Karnataka',
  ml: 'Kerala',
  bn: 'West Bengal, Bangladesh',
  mr: 'Maharashtra',
  gu: 'Gujarat',
  pa: 'Punjab (India and Pakistan)',
  ur: 'Pakistan, north India',
  or: 'Odisha',
  as: 'Assam',
  ne: 'Nepal, Sikkim, Darjeeling',
  si: 'Sri Lanka',
  // ── everywhere else ────────────────────────────────────────────────────────
  en: 'Worldwide',
  es: 'Spain, Latin America, USA',
  fr: 'France, Canada, West Africa',
  de: 'Germany, Austria, Switzerland',
  it: 'Italy',
  pt: 'Brazil, Portugal',
  nl: 'Netherlands, Belgium',
  sv: 'Sweden',
  da: 'Denmark',
  no: 'Norway',
  fi: 'Finland',
  pl: 'Poland',
  cs: 'Czechia',
  hu: 'Hungary',
  ro: 'Romania, Moldova',
  el: 'Greece, Cyprus',
  ru: 'Russia, Central Asia',
  uk: 'Ukraine',
  tr: 'Türkiye',
  ar: 'Middle East, North Africa',
  fa: 'Iran, Afghanistan',
  he: 'Israel',
  zh: 'China, Taiwan, Singapore',
  ja: 'Japan',
  ko: 'South Korea',
  vi: 'Vietnam',
  th: 'Thailand',
  id: 'Indonesia',
  ms: 'Malaysia, Brunei, Singapore',
};

/**
 * ── THE PLAN SNAPSHOT, AND WHY A SNAPSHOT IS ACCEPTABLE HERE ─────────────────
 *
 * `Pricing.tsx` reads `/api/billing/plans` at runtime, so the visible price is
 * always the charged price. Structured data cannot do that: JSON-LD has to be in
 * the HTML the server sends, before any fetch has happened, or crawlers that do
 * not run JavaScript never see it — and Google's December 2025 JavaScript guidance
 * says schema injected by JS is processed late or not at all.
 *
 * So these numbers are duplicated from `backend/app/db.py DEFAULT_PLANS`, and the
 * duplication is made safe the same way the language catalogue is:
 * `backend/_test_seo.py` parses this array and fails if it drifts from the Python.
 * That is the existing convention in this repo — see `backend/_test_langs.py`,
 * which parses `LANGUAGES` out of `format.ts` for exactly this reason.
 *
 * PRICES ARE NET OF GST, because that is what `price_paise` means in the database
 * and what the payment provider is configured for (tax-exclusive products). The
 * schema below therefore carries `priceSpecification.valueAddedTaxIncluded: false`,
 * which is the only honest way to publish a tax-exclusive price as structured data.
 */
export type PlanSeo = {
  code: string;
  name: string;
  interval: 'lifetime' | 'month' | 'year';
  pricePaise: number;
  minutes: number;
  maxVideoSeconds: number;
  retentionDays: number;
};

export const PLANS: readonly PlanSeo[] = [
  // code            name                interval     paise  minutes  maxVid  keep
  { code: 'free', name: 'Free', interval: 'lifetime', pricePaise: 0, minutes: 1, maxVideoSeconds: 60, retentionDays: 1 },
  { code: 'starter', name: 'Starter', interval: 'month', pricePaise: 29900, minutes: 10, maxVideoSeconds: 600, retentionDays: 7 },
  { code: 'creator', name: 'Creator', interval: 'month', pricePaise: 99900, minutes: 50, maxVideoSeconds: 1800, retentionDays: 7 },
  { code: 'pro', name: 'Pro', interval: 'month', pricePaise: 149900, minutes: 120, maxVideoSeconds: 1800, retentionDays: 7 },
  { code: 'starter_year', name: 'Starter (annual)', interval: 'year', pricePaise: 287000, minutes: 120, maxVideoSeconds: 600, retentionDays: 7 },
  { code: 'creator_year', name: 'Creator (annual)', interval: 'year', pricePaise: 959000, minutes: 600, maxVideoSeconds: 1800, retentionDays: 7 },
  { code: 'pro_year', name: 'Pro (annual)', interval: 'year', pricePaise: 1439000, minutes: 1440, maxVideoSeconds: 1800, retentionDays: 7 },
] as const;

/** Matches `VS_GST_RATE` in `backend/app/config.py`, asserted by `_test_seo.py`. */
export const GST_PERCENT = 18;

/** Indicative gross price, the same arithmetic as `config.with_tax_paise`. */
export const withTaxPaise = (netPaise: number) =>
  Math.round(netPaise * (1 + GST_PERCENT / 100));

const PAID = PLANS.filter((p) => p.pricePaise > 0);
const CHEAPEST = PAID.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a));
const rupeesOf = (paise: number) => Math.round(paise / 100);

/**
 * ── ROUTE METADATA ───────────────────────────────────────────────────────────
 *
 * `title` is kept at or under 60 characters and `description` between 140 and 160.
 * Those are not superstitions: Google truncates a title around 580–600 CSS pixels
 * and a description around 155–160 characters, and a truncated description ends
 * mid-sentence in the one place a stranger decides whether to click.
 * `_test_seo.py` asserts both bounds, so a future edit cannot quietly overrun.
 *
 * `updated` is a real date, hand-set when the page's CONTENT changes — not a build
 * timestamp. It feeds `<time>` on the page and `lastmod` in the sitemap, and the
 * whole value of both is that they are only touched when something actually
 * changed. The sitemap previously emitted today's date for every URL on every
 * request, which teaches a crawler to ignore the field entirely.
 */
export type RouteSeo = {
  path: string;
  title: string;
  description: string;
  /** Shorter and punchier for a share card, where there is no query to match. */
  ogTitle?: string;
  /** ISO date, `YYYY-MM-DD`. Bump only when the page's content really changes. */
  updated: string;
  /** `false` for pages a search result should not send a stranger to. */
  indexable?: boolean;
};

export const ROUTES: readonly RouteSeo[] = [
  {
    path: '/',
    title: `${BRAND} — dub any video into any language`,
    ogTitle: `${BRAND} — dub any video into any language`,
    description:
      `Dub your video into ${LANG_COUNT} languages and keep the speaker's own voice. ` +
      `One free minute, no card. Get a file per language or a YouTube audio track.`,
    updated: '2026-09-02',
  },
  {
    path: '/pricing',
    title: `Pricing — pay for minutes, not seats | ${BRAND}`,
    ogTitle: 'Pay for minutes, not seats',
    description:
      `Plans from ₹${rupeesOf(CHEAPEST.pricePaise)} for ${CHEAPEST.minutes} minutes a month, ` +
      `plus a free minute to start. Every plan includes all ${LANG_COUNT} languages and ` +
      `voice cloning. Prices exclude ${GST_PERCENT}% GST.`,
    updated: '2026-09-02',
  },
  {
    // The first page on this site whose reason for existing is a search query rather
    // than the product. "What languages does <tool> support" is asked constantly, and
    // the answer used to live only inside a picker behind a login.
    path: '/languages',
    title: `All ${LANG_COUNT} dubbing languages | ${BRAND}`,
    ogTitle: `Every language ${BRAND} dubs into`,
    description:
      `${BRAND} dubs video into ${LANG_COUNT} languages, ${INDIAN_LANG_COUNT} of them ` +
      'Indian — including Odia, Assamese and Nepali. Full list with native scripts and ' +
      'where each one is spoken.',
    updated: '2026-09-02',
  },
  {
    path: '/about',
    title: `About ${BRAND} — who builds it and what it does`,
    ogTitle: `About ${BRAND}`,
    description:
      `${BRAND} is a video dubbing tool built for Indian and world languages. ` +
      'What it does, what it deliberately does not do, and how your files are handled.',
    updated: '2026-09-02',
  },
  {
    path: '/contact',
    title: `Contact ${BRAND} — support and enquiries`,
    ogTitle: `Contact ${BRAND}`,
    description:
      'Reach the Kresker team about your account, a dub that went wrong, billing, or a ' +
      `data request. Replies come from ${SUPPORT_EMAIL}, usually within a day.`,
    updated: '2026-09-02',
  },
  {
    path: '/privacy',
    title: `Privacy Notice | ${BRAND}`,
    description:
      'How Kresker collects, stores and deletes your videos and account data, how long ' +
      "files are kept on each plan, and your rights under India's DPDP Act.",
    updated: '2026-09-02',
  },
  {
    path: '/terms',
    title: `Terms of Service | ${BRAND}`,
    description:
      'The agreement between you and Kresker: what you may upload, how minutes and ' +
      'billing work, what happens to a failed dub, and how either side can end it.',
    updated: '2026-09-02',
  },
  {
    path: '/disclaimer',
    title: `Disclaimer | ${BRAND}`,
    description:
      'What Kresker does and does not guarantee about translation accuracy, cloned ' +
      'voice likeness, and your responsibility for the content you upload.',
    updated: '2026-09-02',
  },
] as const;

/**
 * Routes that exist, are reachable, and must NOT be prerendered or indexed.
 *
 * Two different reasons, and they need different handling:
 *
 *   * `/login`, `/signup`, `/reset`, `/verify` — robots.txt already disallows the
 *     first three, because a sign-in form in a search result is noise. They still
 *     have to serve the app shell with a 200, so nginx needs to know they are real.
 *   * `/app/**` and `/dashboard` — a crawler without a session only ever gets a
 *     redirect, so there is nothing to prerender.
 *
 * This list is what stops the nginx 404 rule from breaking a real page. It is
 * consumed by `scripts/prerender.mjs`, which writes it into the generated nginx
 * snippet so the two cannot disagree.
 */
export const SHELL_ONLY_PATHS: readonly string[] = [
  '/login',
  '/signup',
  '/reset',
  '/verify',
  '/dashboard',
] as const;

/** `/app` and everything under it. Prefix, not exact. */
export const SHELL_ONLY_PREFIXES: readonly string[] = ['/app'] as const;

export const routeFor = (pathname: string): RouteSeo | undefined => {
  // Trailing slash and case are both reachable and both serve the same page, so a
  // lookup has to normalise the way the canonical does. `/PRICING` returning no
  // route would leave that URL with the homepage's title.
  const p = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  return ROUTES.find((r) => r.path === p);
};

/**
 * The canonical URL for a path.
 *
 * Lowercased, trailing slash stripped, query and hash dropped. Query is dropped on
 * purpose: `/pricing?utm_source=x` is the same page, and letting a tracking
 * parameter into the canonical is how one page becomes a hundred in an index.
 */
export const canonicalFor = (pathname: string): string => {
  const p = pathname.toLowerCase().replace(/\/+$/, '');
  return p === '' ? `${ORIGIN}/` : `${ORIGIN}${p}`;
};

// ── structured data ──────────────────────────────────────────────────────────
//
// JSON-LD, because it is the format Google states it prefers and the only one that
// does not entangle markup with meaning.
//
// WHAT IS DELIBERATELY ABSENT, all three of which a 2025-era SEO guide would tell
// you to add:
//
//   * FAQPage — Google RETIRED FAQ rich results for every site on 7 May 2026. The
//     FAQ content on the landing page is still worth having and the question-shaped
//     headings still help AI search quote it, but the markup now earns nothing in a
//     Google result. Adding it would be cargo cult.
//   * HowTo — rich results removed September 2023. The "Four steps" section stays;
//     the markup has no payoff.
//   * WebSite + SearchAction — the sitelinks search box is gone, and we have no
//     site search to point it at anyway.
//
// `BreadcrumbList` is also absent, for a plainer reason: with seven flat pages
// there is no hierarchy to describe. It becomes worth adding with the first nested
// page.

type Json = Record<string, unknown>;

const ORG_ID = `${ORIGIN}/#organization`;
const SITE_ID = `${ORIGIN}/#website`;
const APP_ID = `${ORIGIN}/#software`;

/**
 * The brand as an entity.
 *
 * `@id` is the load-bearing part. Every other node below references this one
 * instead of repeating the name and logo, which is what lets a crawler understand
 * that the publisher of the privacy notice and the maker of the software are the
 * same organisation rather than two things with the same name.
 *
 * `sameAs` is EMPTY and stays empty until the profiles exist. A `sameAs` pointing
 * at a LinkedIn page nobody has created is a claim a crawler can check and find
 * false, and entity confidence is precisely what the field is for.
 */
export const organizationLd = (): Json => ({
  '@type': 'Organization',
  '@id': ORG_ID,
  name: BRAND,
  url: `${ORIGIN}/`,
  logo: {
    '@type': 'ImageObject',
    url: `${ORIGIN}/favicon-96.png`,
    width: 96,
    height: 96,
  },
  image: OG_IMAGE,
  description:
    `${BRAND} dubs video into ${LANG_COUNT} languages, including ${INDIAN_LANG_COUNT} ` +
    "Indian languages, keeping each speaker's own cloned voice.",
  contactPoint: [
    {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: SUPPORT_EMAIL,
      url: `${ORIGIN}/contact`,
      availableLanguage: ['en'],
    },
  ],
});

export const webSiteLd = (): Json => ({
  '@type': 'WebSite',
  '@id': SITE_ID,
  name: BRAND,
  url: `${ORIGIN}/`,
  publisher: { '@id': ORG_ID },
  inLanguage: 'en',
});

/**
 * One `Offer` per purchasable plan.
 *
 * `valueAddedTaxIncluded: false` is the whole reason this uses a
 * `priceSpecification` rather than a bare `price`. Our prices are net: the provider
 * adds GST at the payment page, so ₹299 is presented as roughly ₹353. Publishing
 * ₹299 with no tax statement is the kind of mismatch between markup and checkout
 * that gets flagged, and more importantly it is the kind that ends in a chargeback.
 */
const offerLd = (p: PlanSeo): Json => ({
  '@type': 'Offer',
  '@id': `${ORIGIN}/pricing#${p.code}`,
  name: p.name,
  url: `${ORIGIN}/pricing`,
  category: p.interval === 'year' ? 'Annual' : 'Monthly',
  availability: 'https://schema.org/InStock',
  // Stated rather than implied. The minute allowance IS the product, so it belongs
  // in the offer a crawler reads, not only in the card a human reads.
  description:
    `${p.minutes} minutes of dubbing ${p.interval === 'year' ? 'a year' : 'a month'}, ` +
    `videos up to ${Math.round(p.maxVideoSeconds / 60)} minutes, ` +
    `finished files kept ${p.retentionDays} days.`,
  priceSpecification: {
    '@type': 'UnitPriceSpecification',
    price: (p.pricePaise / 100).toFixed(2),
    priceCurrency: 'INR',
    valueAddedTaxIncluded: false,
    // `referenceQuantity` with a UN/CEFACT unit code is the documented way to say
    // "per month" or "per year" — MON and ANN. A "lifetime" plan has no billing
    // period at all, which is why the free plan is not in this list.
    referenceQuantity: {
      '@type': 'QuantitativeValue',
      value: 1,
      unitCode: p.interval === 'year' ? 'ANN' : 'MON',
    },
  },
});

/**
 * The product itself.
 *
 * `SoftwareApplication` rather than `Product`, and `WebApplication` as the second
 * type: it runs in a browser, there is nothing to install, and `Product` would
 * invite review and rating properties we have no honest values for.
 *
 * NO `aggregateRating`. We have no reviews. Inventing one is the single most
 * commonly penalised piece of structured data on the web.
 */
export const softwareApplicationLd = (): Json => ({
  '@type': ['SoftwareApplication', 'WebApplication'],
  '@id': APP_ID,
  name: BRAND,
  url: `${ORIGIN}/`,
  applicationCategory: 'MultimediaApplication',
  applicationSubCategory: 'Video dubbing and translation',
  operatingSystem: 'Any (web browser)',
  browserRequirements: 'Requires JavaScript and a modern browser',
  publisher: { '@id': ORG_ID },
  image: OG_IMAGE,
  inLanguage: 'en',
  description:
    `Dub a video into ${LANG_COUNT} languages while keeping each speaker's own voice. ` +
    'Upload an MP4, pick the languages, and get one video per language plus the ' +
    'dubbed track on its own for YouTube multi-language audio.',
  featureList: [
    `Dubbing into ${LANG_COUNT} languages, ${INDIAN_LANG_COUNT} of them Indian`,
    "Speaker voice cloning from the video's own audio",
    'Each translated line fitted to the original line\'s time slot',
    'Separate .m4a track for YouTube multi-language audio',
    'Progress kept server-side, so closing the browser costs nothing',
  ],
  offers: {
    '@type': 'AggregateOffer',
    priceCurrency: 'INR',
    lowPrice: (CHEAPEST.pricePaise / 100).toFixed(2),
    highPrice: (
      Math.max(...PAID.map((p) => p.pricePaise)) / 100
    ).toFixed(2),
    offerCount: PAID.length,
    offers: PAID.map(offerLd),
  },
});

/**
 * The `@graph` for a given path.
 *
 * One `<script>` containing a graph rather than four separate scripts, so the
 * `@id` cross-references resolve inside a single document and a crawler does not
 * have to stitch four blocks together.
 */
export const jsonLdFor = (pathname: string): Json => {
  const route = routeFor(pathname);
  const url = canonicalFor(pathname);
  const nodes: Json[] = [organizationLd(), webSiteLd()];

  // `AboutPage` and `ContactPage` are the two page types schema.org defines that
  // Google actually uses to understand a site's shape. Everything else here is a
  // plain `WebPage`; there is no more specific type that is true.
  const pageType =
    pathname === '/about' ? 'AboutPage' : pathname === '/contact' ? 'ContactPage' : 'WebPage';

  nodes.push({
    '@type': pageType,
    '@id': `${url}#page`,
    url,
    name: route?.title ?? BRAND,
    description: route?.description,
    isPartOf: { '@id': SITE_ID },
    about: { '@id': ORG_ID },
    inLanguage: 'en',
    // Both, and both the same value. `dateModified` is what a freshness check reads;
    // `datePublished` stops a page looking undated, which costs citation eligibility
    // in AI answers. Neither is invented — see `updated` on the route.
    datePublished: route?.updated,
    dateModified: route?.updated,
    primaryImageOfPage: { '@type': 'ImageObject', url: OG_IMAGE },
  });

  // The software node belongs on the two pages that are ABOUT the software. Putting
  // it on the privacy notice would be describing the wrong thing.
  if (pathname === '/' || pathname === '/pricing') {
    nodes.push(softwareApplicationLd());
  }

  return { '@context': 'https://schema.org', '@graph': nodes };
};

// ── the head, as data ────────────────────────────────────────────────────────

export type MetaTag =
  | { name: string; content: string }
  | { property: string; content: string };

/**
 * Every head tag for a path, as data rather than as markup.
 *
 * Returned as a plain object so the same computation drives both consumers: the
 * prerenderer turns it into a string, and `Seo.tsx` walks it applying
 * `setAttribute`. A JSX version could only ever serve the browser.
 */
export const headFor = (pathname: string) => {
  const route = routeFor(pathname);
  const canonical = canonicalFor(pathname);
  const title = route?.title ?? `${BRAND} — dub any video into any language`;
  const description = route?.description ?? ROUTES[0].description;
  const ogTitle = route?.ogTitle ?? title;

  const meta: MetaTag[] = [
    { name: 'description', content: description },
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: BRAND },
    { property: 'og:url', content: canonical },
    { property: 'og:title', content: ogTitle },
    { property: 'og:description', content: description },
    { property: 'og:image', content: OG_IMAGE },
    { property: 'og:image:width', content: '1200' },
    { property: 'og:image:height', content: '630' },
    { property: 'og:image:alt', content: `${BRAND} — dub any video into any language` },
    { property: 'og:locale', content: 'en' },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: ogTitle },
    { name: 'twitter:description', content: description },
    { name: 'twitter:image', content: OG_IMAGE },
    { name: 'twitter:image:alt', content: `${BRAND} — dub any video into any language` },
  ];

  return { title, canonical, meta, jsonLd: jsonLdFor(pathname), updated: route?.updated };
};
