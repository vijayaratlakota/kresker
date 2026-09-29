/**
 * The build-time renderer. Never shipped to a browser.
 *
 * ── WHAT PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 *
 * Measured on the live site with claude-seo, before this existed:
 *
 *     what the server sends:            6,013 bytes,     8 words, 0 H1, 0 links
 *     what a browser shows after JS:  114,640 bytes, 1,418 words, 1 H1, 29 links
 *
 * Eight words, on all seven pages. The words were only ever created by React inside
 * the visitor's browser, so the file leaving the server had none of them.
 *
 * Google can run JavaScript, so it would probably have got there eventually — via a
 * render queue that delays indexing and can quietly fail. **AI crawlers do not run
 * JavaScript at all.** GPTBot, ClaudeBot, PerplexityBot and friends download the
 * file and read what is in it. They were reading eight words, which is why nothing
 * could recommend this product: there was nothing there to recommend.
 *
 * This module renders each public route to a string at build time.
 * `scripts/prerender.mjs` writes the result to `dist/<route>/index.html`, and nginx
 * serves it because `try_files $uri $uri/ …` finds the file. No server change.
 *
 * ── WHY renderToString AND NOT A HEADLESS BROWSER ────────────────────────────
 *
 * A browser was tried first and rejected. Chrome removed `--dump-dom` (confirmed
 * against Chrome 152 on this machine: it exits 0 and prints nothing), so the browser
 * route now means either driving CDP over a websocket by hand or adding Playwright
 * and a ~150 MB Chromium download to the frontend's devDependencies.
 *
 * `renderToString` needs neither, is deterministic, and runs in about a second. It
 * works here because the one component that would have broken it already guards for
 * it — see `Reveal` in `ui/primitives.tsx`, which resolves to *shown* when
 * `typeof window === 'undefined'`, precisely so a non-browser renderer cannot
 * produce a page of invisible text. That was written for screenshot tools; it pays
 * off again here.
 *
 * ── WHY THE IMPORTS BELOW ARE EAGER WHEN App.tsx MAKES THEM LAZY ─────────────
 *
 * `renderToString` does not wait for anything. A `React.lazy` component suspends,
 * and the renderer emits the `<Suspense>` fallback — so importing these the way
 * `App.tsx` does would prerender seven copies of a loading spinner, which is worse
 * than prerendering nothing because it looks like it worked.
 *
 * Eager here costs nothing: this bundle never reaches a browser, so its size is
 * irrelevant. The client keeps every `lazy()` boundary it had.
 *
 * ── WHY THIS IS PRERENDERING, NOT SSR-WITH-HYDRATION ─────────────────────────
 *
 * `main.tsx` still calls `createRoot().render()`, not `hydrateRoot()`. React clears
 * the container and renders fresh, inside the same commit, so there is no visible
 * flash and — importantly — no hydration-mismatch class of bug to maintain. The
 * prerendered markup exists for crawlers and for the first paint; it is explicitly
 * not required to match the client tree node for node.
 *
 * That is a deliberate trade. Real hydration would make the page interactive
 * marginally sooner, at the cost of every future edit having to keep two render
 * paths byte-identical — including the consent banner, the toast container and the
 * session-dependent nav, all three of which legitimately differ between a build
 * machine and a signed-in visitor.
 */
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import { Landing } from './marketing/Landing';
import { Languages } from './marketing/Languages';
import { NotFound } from './marketing/NotFound';
import { Pricing } from './marketing/Pricing';
import { About } from './legal/About';
import { Contact } from './legal/Contact';
import { Disclaimer } from './legal/Disclaimer';
import { Privacy } from './legal/Privacy';
import { Terms } from './legal/Terms';
import { LANGUAGES } from './lib/format';
import {
  BRAND,
  GST_PERCENT,
  INDIAN_LANG_COUNT,
  LANG_COUNT,
  ORIGIN,
  PLANS,
  ROUTES,
  SHELL_ONLY_PATHS,
  SHELL_ONLY_PREFIXES,
  SUPPORT_EMAIL,
  headFor,
  withTaxPaise,
} from './lib/seo';

/**
 * Path to component.
 *
 * Keyed by the same strings as `ROUTES` in `lib/seo.ts`, and `renderAll` below
 * fails loudly if the two ever disagree — a route with metadata but no component
 * would otherwise be silently skipped, leaving one page still shipping eight words
 * while every check on the others passed.
 */
const PAGES: Record<string, ComponentType> = {
  '/': Landing,
  '/pricing': Pricing,
  '/languages': Languages,
  '/about': About,
  '/contact': Contact,
  '/privacy': Privacy,
  '/terms': Terms,
  '/disclaimer': Disclaimer,
};

export type Prerendered = {
  path: string;
  /** Inner HTML for `<div id="root">`. */
  body: string;
  /** Everything that belongs in `<head>`, already serialised. */
  head: string;
  /** For the sitemap and the visible "updated" line. */
  updated?: string;
};

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The head as a string.
 *
 * Built from the same `headFor()` the browser uses, so the tags a crawler reads and
 * the tags a client-side navigation sets cannot drift. One declaration, two
 * serialisers.
 */
function renderHead(path: string): string {
  const h = headFor(path);
  const lines: string[] = [];

  lines.push(`<title>${esc(h.title)}</title>`);

  // THE CANONICAL. Absent from every page before this. `/pricing`, `/pricing/`,
  // `/PRICING` and `/pricing?utm_source=x` all return 200 with identical bytes, and
  // with nothing to point at the real one those ranking signals were split four ways.
  lines.push(`<link rel="canonical" href="${esc(h.canonical)}">`);

  for (const tag of h.meta) {
    const attr = 'name' in tag ? `name="${esc(tag.name)}"` : `property="${esc(tag.property)}"`;
    lines.push(`<meta ${attr} content="${esc(tag.content)}">`);
  }

  /*
    JSON-LD, in the served HTML rather than injected by React.

    Google's December 2025 JavaScript guidance is explicit that structured data added
    by script is processed late or not at all, so a `<script>` written by a React
    effect is the one place schema must NOT live. This is the copy that counts.

    `</script>` inside a JSON string would end the block early, so the sequence is
    broken up. `<` is escaped rather than the whole string HTML-escaped, because the
    contents of a script element are not HTML-parsed and escaping them would corrupt
    the JSON.
  */
  const graph = JSON.stringify(h.jsonLd).replace(/</g, '\\u003c');
  lines.push(`<script type="application/ld+json" data-seo-graph>${graph}</script>`);

  return lines.join('\n    ');
}

export function renderRoute(path: string): Prerendered {
  const Page = PAGES[path];
  if (!Page) throw new Error(`prerender: no component registered for ${path}`);

  // No StrictMode. It double-invokes render to surface impure components, which is
  // worth paying for in development and pure waste in a build step that throws the
  // first result away.
  const body = renderToString(
    <StaticRouter location={path}>
      <Page />
    </StaticRouter>,
  );

  const route = ROUTES.find((r) => r.path === path);
  return { path, body, head: renderHead(path), updated: route?.updated };
}

// ── data the build script needs, re-exported so it loads one module ──────────
//
// `prerender.mjs` is plain JavaScript and cannot import a `.ts` file. Rather than
// give it a second compiled bundle, everything it needs comes out of this one.

export const ORIGIN_FOR_TOOLS = ORIGIN;

/**
 * Where the landing-page demo media lives, resolved at BUILD time.
 *
 * `prerender.mjs` needs this to emit the `<link rel="preload">` for the hero poster —
 * the measured LCP element — and it cannot read it from `process.env`, because the
 * value lives in `.env.local` and only Vite loads that. Exporting it from here means
 * Vite inlines the literal during the SSR compile, so the build script and the
 * browser bundle can never disagree about which origin the poster is on.
 *
 * Empty string is the meaningful default: it falls back to this origin
 * (`/demo/poster.webp` out of `public/`), in which case there is nothing to
 * preconnect to and `prerender.mjs` skips the hint rather than emitting a preload for
 * a cross-origin fetch that is not cross-origin.
 */
export const DEMO_BASE: string =
  (import.meta.env?.VITE_DEMO_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

/**
 * The IndexNow verification key, or empty.
 *
 * `prerender.mjs` writes `dist/<key>.txt` containing exactly this string, because the
 * protocol proves host ownership by fetching that file from the web root — which nginx
 * serves and a backend route behind `/api/` could not.
 *
 * PUBLIC BY DESIGN. It is not a credential: possessing it only lets someone ask Bing to
 * re-crawl pages on a host they would already have to control. It lives in the
 * environment so a staging build cannot claim production's key, not for secrecy. Must
 * match `VS_INDEXNOW_KEY` on the server, which is what actually sends the submission.
 *
 * Empty means IndexNow is off, which is a valid state — Google does not support the
 * protocol at all, so nothing about Google's view of the site depends on it.
 */
export const INDEXNOW_KEY: string =
  (import.meta.env?.VITE_INDEXNOW_KEY as string | undefined)?.trim() ?? '';

/** Route paths plus their real `updated` dates, for the sitemap generator. */
export const SEO_ROUTES = ROUTES.map((r) => ({ path: r.path, updated: r.updated }));

/** Paths that must serve the app shell with a 200 but have nothing to prerender. */
export const SHELL_PATHS = { exact: [...SHELL_ONLY_PATHS], prefixes: [...SHELL_ONLY_PREFIXES] };

/**
 * `/llms.txt`, generated.
 *
 * ── WHY IT IS GENERATED AND WHY IT IS LOW PRIORITY ───────────────────────────
 *
 * Generated, because the alternative is a hand-written file that states prices and
 * language counts — the two things most likely to change — and goes stale silently.
 * A file whose entire purpose is to tell a machine facts about the product is worse
 * than absent when the facts are wrong.
 *
 * Low priority, because Google's AI optimization guide (published 2026-05-15,
 * clarified 2026-06-15) states plainly that `llms.txt` is not needed for Google
 * Search and neither helps nor hurts visibility or rankings. claude-seo assigns it
 * zero citation weight, citing Mueller, Illyes, an SE Ranking study across 300k
 * domains and an OtterlyAI server-log audit showing it is essentially never fetched.
 *
 * It is written anyway for two reasons that are not "Google might like it":
 *
 *   1. Smaller AI tools do read it, and the file costs nothing to produce.
 *   2. `/llms.txt` previously returned the SPA shell with `Content-Type: text/html`,
 *      because every unmatched path did. A crawler asking for text got a webpage —
 *      worse than a 404, which at least answers the question.
 */
const paid = PLANS.filter((p) => p.pricePaise > 0);
const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

export const LLMS_TXT = [
  `# ${BRAND}`,
  '',
  `> ${BRAND} dubs a video into another language and keeps the original speaker's own`,
  `> voice, cloned from the audio already in the file. ${LANG_COUNT} languages,`,
  `> ${INDIAN_LANG_COUNT} of them Indian. One free minute, no card required.`,
  '',
  '## What it does',
  '',
  '- Transcribes the speech in your video with its original timings.',
  "- Translates each line to fit the time slot it has to sit in, rather than translating",
  '  freely and then compressing it.',
  "- Clones each speaker's voice from their own audio in your file.",
  '- Generates the new speech and lays it back over the original video, keeping the',
  '  background audio.',
  '',
  '## What you get back',
  '',
  '- One MP4 per language, with the dubbed track as the default audio and tagged so',
  '  players label it correctly.',
  '- The dubbed track on its own as an .m4a, which is the file YouTube asks for when',
  '  you add a second audio language to a video you have already posted.',
  '',
  '## What it does NOT do',
  '',
  '- No lip-sync. The picture is never retimed or altered.',
  '- No subtitle or caption file export.',
  '- No public API.',
  '',
  '## Pages',
  '',
  ...ROUTES.map((r) => `- [${r.title}](${ORIGIN}${r.path}): ${r.description}`),
  '',
  '## Plans',
  '',
  `All prices are in Indian rupees and EXCLUDE ${GST_PERCENT}% GST, which is added at the`,
  'payment page. Annual plans are a one-time payment and do not renew themselves.',
  '',
  `- Free: ₹0 lifetime, ${PLANS[0].minutes} minute once, videos up to ` +
    `${PLANS[0].maxVideoSeconds} seconds, files kept ${PLANS[0].retentionDays * 24} hours.`,
  ...paid.map(
    (p) =>
      `- ${p.name}: ${rupees(p.pricePaise)} per ${p.interval} ` +
      `(about ${rupees(withTaxPaise(p.pricePaise))} with GST), ` +
      `${p.minutes} minutes, videos up to ${Math.round(p.maxVideoSeconds / 60)} minutes, ` +
      `files kept ${p.retentionDays} days.`,
  ),
  '',
  '## Languages',
  '',
  `Indian (${INDIAN_LANG_COUNT}): ` +
    LANGUAGES.filter((l) => l.group === 'india')
      .map((l) => l.label)
      .join(', ') +
    '.',
  '',
  `Rest of the world (${LANG_COUNT - INDIAN_LANG_COUNT}): ` +
    LANGUAGES.filter((l) => l.group === 'world')
      .map((l) => l.label)
      .join(', ') +
    '.',
  '',
  '## Contact',
  '',
  `- Support: ${SUPPORT_EMAIL}`,
  `- Contact form: ${ORIGIN}/contact`,
  '',
].join('\n');

/**
 * The 404 body, prerendered.
 *
 * NEEDED BECAUSE THE 404 IS NOW SERVED BY NGINX, NOT BY REACT. Unmatched paths return
 * a real 404 status, and Google does not execute JavaScript on non-200 responses — so
 * a React-rendered "there is nothing here" would be invisible to it, and a human with
 * JavaScript off or a slow chunk would get a blank page with a 404 status.
 *
 * `noindex` on this one, which is the one page on the site that gets it: a 404 body
 * that is indexable can end up in results as a real page.
 */
export function render404(): Prerendered {
  const body = renderToString(
    <StaticRouter location="/404">
      <NotFound />
    </StaticRouter>,
  );
  const head = [
    '<title>Page not found | Kresker</title>',
    '<meta name="robots" content="noindex, follow">',
    '<meta name="description" content="This page does not exist on kresker.com.">',
  ].join('\n    ');
  return { path: '/404.html', body, head };
}

/** Every public route, in sitemap order. */
export function renderAll(): Prerendered[] {
  const missing = ROUTES.filter((r) => !PAGES[r.path]).map((r) => r.path);
  if (missing.length) {
    throw new Error(
      `prerender: ROUTES declares ${missing.join(', ')} but entry-server.tsx has no ` +
        'component for them. Add the import, or the page ships without prerendered text.',
    );
  }
  const extra = Object.keys(PAGES).filter((p) => !ROUTES.some((r) => r.path === p));
  if (extra.length) {
    throw new Error(
      `prerender: entry-server.tsx registers ${extra.join(', ')} but lib/seo.ts has no ` +
        'metadata for them, so they would get the homepage title.',
    );
  }
  return ROUTES.map((r) => renderRoute(r.path));
}
