/**
 * Keeps `document.head` in step with the route.
 *
 * ── WHY THIS IS NEEDED WHEN THE PAGES ARE ALREADY PRERENDERED ────────────────
 *
 * `scripts/prerender.mjs` writes the correct head into the HTML on disk, so the
 * FIRST load of any URL already has the right title, canonical and Open Graph tags
 * before a single byte of JavaScript runs. That is the copy crawlers read.
 *
 * But this is a single-page app. After the first load, clicking "Pricing" changes
 * the URL through the History API without a request, so nothing fetches
 * `/pricing/index.html` and nothing touches the head. Without this component the
 * browser tab would still say "Kresker — dub any video into any language" while the
 * pricing page is on screen, and the canonical tag would still point at `/`.
 *
 * Two things care about that:
 *
 *   * The person using the site. The tab title is how they find this tab again
 *     among twenty, and it is what gets saved when they bookmark the page.
 *   * Anything reading the live DOM rather than the served HTML — which includes
 *     the browser extensions people check SEO with, and our own audit tooling.
 *
 * ── WHY IT MUTATES THE DOM INSTEAD OF RENDERING TAGS ─────────────────────────
 *
 * React 18 can render `<title>` and `<meta>` from a component, but it appends them
 * rather than replacing what `index.html` already declared — so the document ends
 * up with two descriptions and two canonicals, and which one wins is undefined. A
 * head-management library (react-helmet and friends) exists to solve exactly that,
 * and this is roughly forty lines of the same idea without the dependency, the
 * provider, or the double render.
 *
 * The tags are UPDATED IN PLACE where they already exist, which is why the ones in
 * `index.html` keep their position in the document and why there is never a moment
 * with two of anything.
 *
 * Renders nothing.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { headFor, routeFor } from '../lib/seo';

/** Find an existing tag or create it, then set `content`. */
function setMeta(selector: string, attrs: Record<string, string>, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

export function Seo() {
  const { pathname } = useLocation();

  useEffect(() => {
    // A route with no entry — `/login`, `/app/library`, a 404 — deliberately keeps
    // whatever the shell declared. Those pages are either robots-disallowed or
    // behind a session, so there is no search result for a title to appear in, and
    // inventing one per dashboard screen is churn with no reader.
    //
    // The ONE thing still worth doing for them is dropping the canonical, because a
    // canonical inherited from the previous page is an active lie: it would tell a
    // crawler that /app/library is really /pricing.
    const known = routeFor(pathname);
    const link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');

    if (!known) {
      if (link) link.remove();
      return;
    }

    const head = headFor(pathname);

    document.title = head.title;

    for (const tag of head.meta) {
      if ('name' in tag) {
        setMeta(`meta[name="${tag.name}"]`, { name: tag.name }, tag.content);
      } else {
        setMeta(`meta[property="${tag.property}"]`, { property: tag.property }, tag.content);
      }
    }

    let canonical = link;
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', head.canonical);

    // The JSON-LD graph. Replaced wholesale rather than patched: it is one script
    // with one `@graph`, and diffing a graph is far more work than rewriting it.
    //
    // `data-seo-graph` marks OUR block so this can never overwrite a script some
    // other part of the app added.
    let ld = document.head.querySelector<HTMLScriptElement>(
      'script[type="application/ld+json"][data-seo-graph]',
    );
    if (!ld) {
      ld = document.createElement('script');
      ld.type = 'application/ld+json';
      ld.setAttribute('data-seo-graph', '');
      document.head.appendChild(ld);
    }
    ld.textContent = JSON.stringify(head.jsonLd);
  }, [pathname]);

  return null;
}
