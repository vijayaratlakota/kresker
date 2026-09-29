'use strict';
/* AREA X — two findings made precise: CSRF on the delete-video route, and /docs. */
const L = require('./lib');

async function run(browser, S) {
  await L.step('C user', 'DELETE /api/jobs/{id}/video enforces CSRF like the other state-changing routes', async () => {
    const p = S.user && S.user.deleteCsrfProbe;
    if (!p) throw new Error('probe from area C1 missing');
    // Compare with a route that is CSRF-checked, from the same kind of session.
    const ctx = await L.newContext(browser, 'admin', { storageState: S.adminState });
    try {
      const checked = await L.api(ctx, 'POST', '/api/admin/maintenance', { json: { on: false, note: '' }, csrf: false });
      const ok = p.status === 403;
      return {
        status: ok ? 'PASS' : 'FAIL',
        note: `customer's DELETE /api/jobs/${S.user.jobId}/video with NO X-CSRF-Token -> ${p.status} ${JSON.stringify(p.body)} (the handler ran); for comparison POST /api/admin/maintenance without the header -> ${checked.status} "${checked.body && checked.body.detail}". SameSite=Lax limits the exposure, but this route is the odd one out`,
      };
    } finally {
      await ctx.close();
    }
  });

  await L.step(
    'E extras',
    '/docs (Swagger UI) renders through the site origin',
    async () => {
      const ctx = await L.newContext(browser, 'admin', { storageState: S.adminState });
      const page = await L.newPage(ctx);
      const csp = [];
      page.on('console', (m) => {
        if (/Content Security Policy/.test(m.text())) csp.push(m.text().slice(0, 140));
      });
      try {
        await page.goto(L.BASE + '/docs', { waitUntil: 'domcontentloaded' });
        await L.sleep(3000);
        const len = await page.evaluate(() => document.body.innerText.trim().length);
        const s = await L.shot(page, 'X_docs');
        return {
          status: len > 0 ? 'PASS' : 'FAIL',
          note: `body text length ${len}; ${csp.length} CSP refusals, e.g. "${csp[0] || ''}" — the page pulls Swagger UI from cdn.jsdelivr.net plus an inline script, and the backend's own CSP (script-src 'self') forbids both, so it cannot render even with network access (${s})`,
        };
      } finally {
        await ctx.close();
      }
    },
    { noiseOk: true },
  );
}

module.exports = { run };
