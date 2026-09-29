/**
 * Turns the SPA build into seven real HTML files.
 *
 * Run automatically as the last step of `npm run build`. Reads:
 *
 *     dist/index.html            the shell Vite just produced, with hashed asset URLs
 *     dist-ssr/entry-server.js   the same components, compiled for Node
 *
 * and writes:
 *
 *     dist/index.html            rewritten: homepage head + prerendered body
 *     dist/pricing/index.html    …and one directory per route
 *     dist/about/index.html
 *     dist/contact/index.html
 *     dist/privacy/index.html
 *     dist/terms/index.html
 *     dist/disclaimer/index.html
 *     dist/llms.txt              generated from the same route + plan data
 *     dist/_seo-manifest.json    what was written, for the deploy and the tests
 *
 * ── WHY NO SERVER CHANGE IS NEEDED ───────────────────────────────────────────
 *
 * The live nginx vhost already ends its static location with:
 *
 *     try_files $uri $uri/ /index.html;
 *
 * `$uri/` is the part that matters. A request for `/pricing` becomes a probe for the
 * directory `/pricing/`, and nginx serves `index.html` from inside it. So the moment
 * these files exist on disk they are served, with no config edit, no restart and
 * nothing to roll back beyond replacing `dist` — which `_ship_dist.ps1` already keeps
 * as `dist.old`.
 *
 * ── WHAT IS DELIBERATELY NOT DONE HERE ──────────────────────────────────────
 *
 * The `<div id="root">` content is prerendered but NOT hydrated: `main.tsx` still
 * calls `createRoot`, so React clears the container and renders fresh. That is a
 * choice, explained at length in `src/entry-server.tsx`. The consequence for this
 * script is that the markup it writes does not have to match the client tree, which
 * is why it can safely omit the consent banner and the toast container.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'dist');
const SSR = join(ROOT, 'dist-ssr', 'entry-server.js');

const ok = (s) => process.stdout.write(`  ${s}\n`);

// ── the shell Vite produced ──────────────────────────────────────────────────
//
// Read rather than templated, because it carries the hashed asset filenames
// (`/assets/index-B7xK2p.js`) that change on every build. Rebuilding it by hand here
// would mean this script had to know Vite's manifest format, and would break the
// first time the chunking changed.
const shellPath = join(DIST, 'index.html');
let shell;
try {
  shell = readFileSync(shellPath, 'utf8');
} catch {
  console.error('prerender: dist/index.html is missing. Run `vite build` first.');
  process.exit(1);
}

const {
  renderAll,
  render404,
  ORIGIN_FOR_TOOLS,
  LLMS_TXT,
  SEO_ROUTES,
  SHELL_PATHS,
  DEMO_BASE,
  INDEXNOW_KEY,
} = await import(`file://${SSR.replace(/\\/g, '/')}`).catch((err) => {
  console.error(
    'prerender: could not load dist-ssr/entry-server.js.\n' +
      '           Run `vite build --ssr src/entry-server.tsx --outDir dist-ssr` first.\n' +
      `           ${err?.message ?? err}`,
  );
  process.exit(1);
});

/**
 * Strip the shell's own head tags that we are about to replace.
 *
 * WHY STRIPPING IS REQUIRED AND NOT MERELY TIDY: a document with two
 * `<meta name="description">` tags has undefined precedence, and the one that wins is
 * whichever the parser saw first — which would be the shell's homepage copy on every
 * page. Same for `og:*`. So the old ones come out rather than the new ones going in
 * after them.
 *
 * The tags NOT touched here are the ones that are genuinely identical on every page
 * and already correct: charset, viewport, theme-color, the Apple web-app trio, every
 * icon link, and the manifest. Those stay exactly where they are, comments included.
 */
function stripReplacedHead(html) {
  return html
    .replace(/\n?\s*<title>[\s\S]*?<\/title>/i, '')
    .replace(/\n?\s*<meta\s+name="description"[\s\S]*?\/?>/i, '')
    .replace(/\n?\s*<meta\s+property="og:[^"]*"[\s\S]*?\/?>/gi, '')
    .replace(/\n?\s*<meta\s+name="twitter:[^"]*"[\s\S]*?\/?>/gi, '')
    .replace(/\n?\s*<link\s+rel="canonical"[\s\S]*?\/?>/gi, '');
}

/**
 * Speculation Rules.
 *
 * Tells the browser to start fetching a page while the pointer is still moving
 * towards the link, so the next navigation paints from memory. `moderate` eagerness
 * is roughly "hovered for ~200ms", which is late enough not to prefetch things
 * nobody wanted and early enough to remove the wait.
 *
 * `prerender` for /pricing and /signup because those are the two next steps from
 * every page; `prefetch` for the rest, which fetches the document without executing
 * it. Prerendering everything would run seven copies of the app in the background.
 *
 * NOT `eagerness: "immediate"`. That would prefetch on page load for every visitor
 * including the ones who bounce, and this site is paying for egress.
 */
const SPECULATION_RULES = {
  prerender: [
    {
      urls: ['/pricing', '/signup'],
      eagerness: 'moderate',
    },
  ],
  prefetch: [
    {
      // Everything same-origin EXCEPT the things that must never be fetched
      // speculatively. `/app` and `/dl/` touch the session cookie and signed
      // download tokens; `/api/` mutates state. A prefetch is a real request as far
      // as the server is concerned, so this exclusion list is a correctness
      // requirement, not an optimisation.
      where: {
        and: [
          { href_matches: '/*' },
          { not: { href_matches: '/app*' } },
          { not: { href_matches: '/api/*' } },
          { not: { href_matches: '/dl/*' } },
          { not: { href_matches: '/logout*' } },
        ],
      },
      eagerness: 'moderate',
    },
  ],
};

/**
 * `<link rel="preload">` for the hero poster.
 *
 * The poster is the LCP element on the homepage — measured: a VIDEO whose poster is
 * 76,907 px². It lives on a different origin, so the browser has to do a DNS lookup
 * and a TLS handshake before the first byte, and nothing in the document told it the
 * file mattered. `preload_check.py` scored 50/100 with
 * `preload_lcp_candidate: false, fetchpriority_high: 0`.
 *
 * Homepage only. Preloading it on /terms would download 47 KB nobody is going to look
 * at, which is the classic way a preload hint makes a site slower.
 */
function heroPreload(demoBase) {
  const hints = [];

  // THE POSTER IS SAME-ORIGIN, always. See the long note on `DEMO.poster` in
  // LanguageSwitcher.tsx: it used to come from the R2 bucket, which put a DNS lookup
  // and a TLS handshake in front of the single image Google times. 47 KB ships with
  // the bundle instead.
  //
  // `fetchpriority="high"` is the part that actually moves the needle. Without it the
  // browser finds this image in normal document order, after the CSS and the entry
  // chunk; with it the request goes out with the first batch.
  hints.push(
    '<link rel="preload" as="image" fetchpriority="high" href="/demo/poster.webp">',
  );

  // The six reel videos DO still live on `demoBase`. `preload="metadata"` on the
  // <video> means the browser fetches each moov atom, so the handshake to that origin
  // still happens on load — just no longer on the LCP path. A preconnect removes it
  // from the critical path for the reel without pulling any bytes.
  //
  // Skipped when the media is same-origin (a checkout with the files in public/demo),
  // because preconnecting to yourself is a wasted hint.
  if (demoBase.startsWith('http')) {
    hints.push(`<link rel="preconnect" href="${new URL(demoBase).origin}" crossorigin>`);
  }

  return hints.join('\n    ');
}

// ── write the pages ─────────────────────────────────────────────────────────
const pages = renderAll();
const manifest = { origin: ORIGIN_FOR_TOOLS, generated: new Date().toISOString(), pages: [] };

for (const page of pages) {
  const isHome = page.path === '/';

  let html = stripReplacedHead(shell);

  const injected = [
    page.head,
    isHome ? heroPreload(DEMO_BASE) : '',
    `<script type="speculationrules">${JSON.stringify(SPECULATION_RULES)}</script>`,
  ]
    .filter(Boolean)
    .join('\n    ');

  html = html.replace('</head>', `    ${injected}\n  </head>`);

  // The prerendered markup goes INSIDE #root, replacing the empty div. React will
  // clear it on mount; until then it is the page.
  html = html.replace('<div id="root"></div>', `<div id="root">${page.body}</div>`);

  const outDir = isHome ? DIST : join(DIST, page.path.slice(1));
  const outFile = join(outDir, 'index.html');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, html, 'utf8');

  manifest.pages.push({
    path: page.path,
    file: outFile.slice(DIST.length + 1).replace(/\\/g, '/'),
    bytes: Buffer.byteLength(html),
    bodyBytes: Buffer.byteLength(page.body),
    updated: page.updated,
  });
  ok(
    `${page.path.padEnd(12)} -> ${String(Math.round(Buffer.byteLength(html) / 1024)).padStart(4)} KB` +
      `  (body ${String(Math.round(Buffer.byteLength(page.body) / 1024)).padStart(3)} KB)`,
  );
}

// ── the 404 page ─────────────────────────────────────────────────────────────
//
// A real file, because nginx's `error_page 404 /404.html` serves a file rather than
// running the app. Written last of the HTML so it inherits the same shell and the same
// hashed asset URLs as everything else.
{
  const nf = render404();
  let html = stripReplacedHead(shell);
  html = html.replace('</head>', `    ${nf.head}\n  </head>`);
  html = html.replace('<div id="root"></div>', `<div id="root">${nf.body}</div>`);
  writeFileSync(join(DIST, '404.html'), html, 'utf8');
  ok(`404.html     -> ${Math.round(Buffer.byteLength(html) / 1024)} KB  (noindex)`);
}

// ── llms.txt ─────────────────────────────────────────────────────────────────
//
// GENERATED, never hand-written. A hand-written one drifts the first time a price or
// a language changes, and then it is a file whose whole purpose is to state facts
// about the product while stating them wrongly.
//
// HONEST ABOUT ITS VALUE: Google's AI optimization guide (May 2026, clarified June
// 2026) states llms.txt is not needed for Google Search and neither helps nor hurts
// rankings. It is here for smaller AI tools that do read it, and because the file
// previously returned the SPA shell with `Content-Type: text/html` — which is worse
// than a 404, since a crawler asking for text got a page.
writeFileSync(join(DIST, 'llms.txt'), LLMS_TXT, 'utf8');
ok(`llms.txt     -> ${Math.round(Buffer.byteLength(LLMS_TXT) / 1024)} KB`);

// ── the IndexNow key file ────────────────────────────────────────────────────
//
// `<key>.txt` at the web root, containing the key and nothing else. That is how Bing,
// Yandex, Naver and Seznam verify we own the host before accepting a submission.
//
// Written here rather than checked into `public/` so the key can differ between
// environments — a staging build must not be able to claim production's key — and so
// there is exactly one place it is spelled.
//
// Google does not support IndexNow, so an unset key costs nothing that matters.
if (/^[A-Za-z0-9-]{8,128}$/.test(INDEXNOW_KEY)) {
  writeFileSync(join(DIST, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY, 'utf8');
  manifest.indexnow = { keyFile: `${INDEXNOW_KEY}.txt` };
  ok(`${INDEXNOW_KEY}.txt -> IndexNow key file`);
} else if (INDEXNOW_KEY) {
  console.error(
    `prerender: VITE_INDEXNOW_KEY is set but invalid (${INDEXNOW_KEY.length} chars).\n` +
      "           The spec allows 8-128 characters of A-Za-z0-9 and '-'. Not written.",
  );
} else {
  ok('IndexNow      -> off (VITE_INDEXNOW_KEY unset; Google does not use it anyway)');
}

// ── the nginx location block, generated ─────────────────────────────────────
//
// WHY THIS IS GENERATED RATHER THAN HAND-WRITTEN ON THE SERVER.
//
// Making unknown URLs return a real 404 means nginx has to know which paths are real.
// Seven of them are files on disk, so `try_files $uri $uri/` finds them. The other
// five are SPA-only — `/login`, `/signup`, `/reset`, `/verify`, `/dashboard` — plus
// everything under `/app`. Those have no file and must still answer 200 with the
// shell, because they are real pages.
//
// That list therefore exists in two places: the React router, and nginx. Hand-maintain
// it and the failure mode is a real page starting to 404 after a deploy, which is the
// worst kind of regression — invisible to everyone who has the app already loaded, and
// total for anyone arriving from a link.
//
// So it is emitted here from `SHELL_ONLY_PATHS` in `lib/seo.ts`, and shipped with the
// bundle. `_ship_dist.ps1` installs it; if it is ever out of step with the router,
// it is out of step in one file that was written by the build rather than by hand.
const shellRe = SHELL_PATHS.exact.map((p) => p.replace(/^\//, '')).join('|');
const nginx = `# GENERATED by frontend/scripts/prerender.mjs — do not edit on the server.
# Built ${manifest.generated}
#
# Replaces:  try_files $uri $uri/ /index.html;
#
# The old rule answered 200 with the app shell for EVERY unmatched path, so
# /this-does-not-exist, /blog, /sitemap_index.xml and /llms.txt all returned a webpage.
# Google logs those as soft 404s and spends crawl budget on them, and an AI assistant
# that invents a URL gets it confirmed.
#
# Order matters: the most specific location wins, and the catch-all 404s.

# 1. Hashed build assets. Immutable — the hash changes when the bytes change.
location ^~ /assets/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
}

# 2. Routes that exist only inside the SPA: no file on disk, still real pages.
#    Generated from SHELL_ONLY_PATHS in frontend/src/lib/seo.ts.
location ~ ^/(${shellRe})/?$ {
    try_files /index.html =404;
}

# 3. The dashboard and everything under it. Prefix match, session-gated by the app.
location ^~ /app {
    try_files /index.html =404;
}

# 4. Everything else: a real file, a prerendered directory, or a 404.
#    $uri/  is what serves dist/pricing/index.html for a request to /pricing.
location / {
    try_files $uri $uri/ =404;
}

error_page 404 /404.html;
location = /404.html {
    internal;
}
`;
writeFileSync(join(DIST, '_nginx-routes.conf'), nginx, 'utf8');
ok(`_nginx-routes.conf -> ${SHELL_PATHS.exact.length} shell routes + ${pages.length} prerendered`);

// ── the manifest ────────────────────────────────────────────────────────────
//
// Consumed by `_verify_ui.py` and by the nginx snippet generator, so neither has to
// re-derive the route list. Also the quickest way to see, after a deploy, whether a
// page went out with an empty body.
manifest.routes = SEO_ROUTES;
writeFileSync(join(DIST, '_seo-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// ── the check that matters ──────────────────────────────────────────────────
//
// A prerender that silently produced empty bodies would leave every other assertion
// in the build passing. 4 KB is well below the smallest real page (/contact, the
// thinnest, renders ~30 KB) and well above anything a spinner could produce.
const thin = manifest.pages.filter((p) => p.bodyBytes < 4096);
if (thin.length) {
  console.error(
    `\nprerender FAILED: ${thin.map((p) => p.path).join(', ')} rendered almost nothing.\n` +
      '  A route that renders empty usually means a component suspended — check that\n' +
      '  entry-server.tsx imports it eagerly rather than through lazy().',
  );
  process.exit(1);
}

ok(`${pages.length} pages prerendered, none empty. llms.txt and _seo-manifest.json written.`);
