/**
 * Branded HTML for the three responses a visitor should never see raw:
 *
 *   404  the URL does not exist
 *   500  we broke
 *   503  maintenance mode
 *
 * Server-rendered rather than React, because the React app cannot help with any of them:
 * a 500 is often the API being unreachable, a 503 is the API deliberately refusing, and a
 * 404 must carry its status before any JavaScript runs or a crawler records the page as
 * live. Each is one self-contained string with inline CSS and no requests of its own.
 *
 * Byte-for-byte the pages the Python backend served.
 */

interface PageParts {
  title: string;
  code: string;
  heading: string;
  body: string;
  brand: string;
  accent?: string;
  actions?: string;
  note?: string;
  robots?: string;
}

function page(p: PageParts): string {
  const accent = p.accent ?? '#5b5bf0';
  const actions = p.actions ?? '';
  const note = p.note ?? '';
  const robots = p.robots ?? 'noindex';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title}</title>
<meta name="robots" content="${robots}">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    padding: 2rem 1.25rem; background: #08090b; color: #f4f6f8;
    font-family: 'Space Grotesk', ui-sans-serif, system-ui, -apple-system,
      'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card { width: 100%; max-width: 30rem; text-align: center; }
  .code {
    font-size: .6875rem; letter-spacing: .16em; text-transform: uppercase;
    color: #6c757f; margin: 0 0 .875rem;
  }
  h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 .75rem;
        letter-spacing: -.02em; }
  p { font-size: .9375rem; line-height: 1.65; color: #9ba5b0; margin: 0 0 1rem; }
  .row { display: flex; gap: .625rem; justify-content: center; flex-wrap: wrap;
          margin-top: 1.5rem; }
  a.btn {
    display: inline-flex; align-items: center; height: 2.5rem; padding: 0 1.25rem;
    border-radius: 9999px; font-size: .9375rem; font-weight: 500;
    text-decoration: none; transition: background-color .16s, border-color .16s;
  }
  a.primary { background: #fff; color: #0a0b0d; }
  a.primary:hover { background: rgba(255,255,255,.88); }
  a.ghost { border: 2px solid #363c45; color: #f4f6f8; }
  a.ghost:hover { border-color: #464e59; background: rgba(255,255,255,.04); }
  .mark { display: inline-flex; align-items: center; gap: .5rem;
           margin-bottom: 1.75rem; color: #f4f6f8; text-decoration: none; }
  .mark span { font-size: 1rem; font-weight: 500; letter-spacing: -.01em; }
  .dot { width: .5rem; height: .5rem; border-radius: 9999px; background: ${accent}; }
  .note { margin-top: 1.75rem; font-size: .75rem; color: #6c757f; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: .8125rem; color: #9ba5b0; }
</style>
</head><body>
  <main class="card">
    <a class="mark" href="/"><i class="dot"></i><span>${p.brand}</span></a>
    <p class="code">${p.code}</p>
    <h1>${p.heading}</h1>
    ${p.body}
    ${actions}
    ${note}
  </main>
</body></html>
`;
}

export function notFound(brand = 'Kresker'): string {
  return page({
    title: `Page not found · ${brand}`,
    code: 'Error 404',
    heading: 'That page is not here',
    // A way onward rather than an accusation.
    body: '<p>The link may be old, or the page may have moved. Everything else is still where it was.</p>',
    brand,
    actions:
      '<div class="row">' +
      '<a class="btn primary" href="/">Go to the homepage</a>' +
      '<a class="btn ghost" href="/contact">Tell us about it</a>' +
      '</div>',
  });
}

export function serverError(brand = 'Kresker', requestId: string | null = null): string {
  return page({
    title: `Something went wrong · ${brand}`,
    code: 'Error 500',
    heading: 'Something broke on our side',
    // Whose fault it is, and whether their dub survived.
    body:
      '<p>This is our error, not yours. Any dub already running is unaffected ' +
      '— the work happens on our servers and every stage is written down as it ' +
      'finishes, so it will still be there when you come back.</p>',
    brand,
    accent: '#ff6b6b',
    actions:
      '<div class="row">' +
      '<a class="btn primary" href="/">Back to the homepage</a>' +
      '<a class="btn ghost" href="/contact">Report it</a>' +
      '</div>',
    note: requestId ? `<p class="note">Reference <code>${requestId}</code> — quote this and we can find it in the logs.</p>` : '',
  });
}

export function maintenance(brand = 'Kresker', note = '', since: string | null = null): string {
  return page({
    title: `Back shortly · ${brand}`,
    code: 'Maintenance',
    heading: 'We are making some changes',
    body: note ? `<p>${note}</p>` : '',
    brand,
    accent: '#f5c451',
    // No refresh button: Retry-After tells the browser when to come back.
    actions: '',
    note: since ? `<p class="note">Since ${since} UTC.</p>` : '',
  });
}
