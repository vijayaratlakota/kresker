'use strict';
/*
  AREA PROD — the two front-end failures re-tried against a PRODUCTION build of the same
  source (`vite build` into ./_prod_dist, served by `vite preview` on 127.0.0.1:5175 with
  the same /api proxy), to tell dev-server-only behaviour from real bugs.
*/
const L = require('./lib');

const P = 'P prod build';
const PROD = 'http://127.0.0.1:5175';

async function run(browser, S) {
  S.prod = S.prod || { email: `ui-prod-${S.stamp}@example.com`, password: `Ui-Prod-${S.stamp}-pw` };
  const ctx = await L.newContext(browser, 'prod-user');
  const page = await L.newPage(ctx);
  const admin = await L.newContext(browser, 'admin-side', { storageState: S.adminState });

  if (S.prodDone) {
    // re-check with a fresh account: wait for the DASHBOARD, not just the URL change
    const email = `ui-prod2-${S.stamp}@example.com`;
    await L.step(P, 'Production build: confirmation link lands in /app (re-check)', async () => {
      const t0 = Date.now() - 1500;
      await L.goto(page, PROD + '/signup');
      await L.h1(page, 30000);
      await L.dismissBanner(page);
      await page.locator('#f-email').fill(email);
      await page.locator('#f-password').fill(S.prod.password);
      await page.getByRole('button', { name: 'Sign up', exact: true }).click();
      await page.getByRole('heading', { level: 1, name: 'Check your inbox' }).waitFor({ timeout: 15000 });
      const mail = await L.waitMail(email, 'verify_email', { after: t0 });
      const link = L.linkIn(mail.text, '/verify').hit.replace(L.BASE, PROD);
      const tClick = Date.now();
      await L.goto(page, link);
      await page.waitForURL(/\/app\/?$/, { timeout: 15000 });
      await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 20000 });
      const secs = ((Date.now() - tClick) / 1000).toFixed(1);
      const s = await L.shot(page, 'P_verify_prod_dashboard');
      return `production build: confirmation link -> dashboard "Dubbing" in ${secs}s, signed in (${s})`;
    });
    await admin.close();
    await ctx.close();
    return;
  }
  S.prodDone = true;

  await L.step(P, 'Production build: confirmation link lands in /app', async () => {
    const t0 = Date.now() - 1500;
    await L.goto(page, PROD + '/signup');
    await L.h1(page, 30000);
    await L.dismissBanner(page);
    await page.locator('#f-email').fill(S.prod.email);
    await page.locator('#f-password').fill(S.prod.password);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Check your inbox' }).waitFor({ timeout: 15000 });
    const mail = await L.waitMail(S.prod.email, 'verify_email', { after: t0 });
    const link = L.linkIn(mail.text, '/verify').hit.replace(L.BASE, PROD);
    await L.goto(page, link);
    const landed = await page
      .waitForURL(/\/app\/?$/, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    const h = await L.h1(page).catch(() => '(no h1)');
    const s = await L.shot(page, 'P_verify_prod');
    if (!landed) return { status: 'FAIL', note: `production build also stuck: "${h}" on ${page.url()} (${s})` };
    return `production build: link confirmed and landed on /app ("${h}") - the hang in the dev server comes from React StrictMode's double effect run (${s})`;
  });
  await L.step(
    P,
    'Production build: bogus confirmation token shows "That link did not work"',
    async () => {
      const c2 = await L.newContext(browser, 'prod-anon');
      const p2 = await L.newPage(c2);
      try {
        await L.goto(p2, `${PROD}/verify?token=bogus3-${S.stamp}`);
        const ok = await p2
          .getByText('That link did not work')
          .waitFor({ timeout: 12000 })
          .then(() => true)
          .catch(() => false);
        const s = await L.shot(p2, 'P_verify_bogus_prod');
        return { status: ok ? 'PASS' : 'FAIL', note: `${ok ? 'failure screen shown' : 'still "Checking that link…"'} (${s})` };
      } finally {
        await c2.close();
      }
    },
    { allow: [{ kind: 'response', status: 400, url: /\/api\/auth\/verify$/ }, { kind: 'console', text: /status of 400/, url: /\/api\/auth\/verify$/ }] },
  );
  await L.step(
    P,
    'Production build: signed-out visitor during maintenance',
    async () => {
      const on = await L.api(admin, 'POST', '/api/admin/maintenance', { json: { on: true, note: `UI check prod maintenance ${S.stamp}` } });
      const c3 = await L.newContext(browser, 'prod-anon-maint');
      const p3 = await L.newPage(c3);
      let note;
      try {
        await L.goto(p3, PROD + '/');
        await L.sleep(6000);
        const len = await p3.evaluate(() => document.getElementById('root')?.innerHTML.length ?? -1);
        const h = await p3.locator('h1').first().innerText({ timeout: 2000 }).catch(() => '(no h1)');
        const s = await L.shot(p3, 'P_maint_prod');
        note = { len, h, s };
      } finally {
        await c3.close();
        const off = await L.api(admin, 'POST', '/api/admin/maintenance', { json: { on: false, note: '' } });
        note.off = off.status;
      }
      const shown = /We are making some changes/.test(note.h);
      return {
        status: shown ? 'PASS' : 'FAIL',
        note: `maintenance on -> ${on.status}; production build page: h1 "${note.h}", #root innerHTML length ${note.len} (${note.s}); maintenance off -> ${note.off}`,
      };
    },
    { allow: [{ kind: 'response', status: 503 }, { kind: 'console', text: /status of 503/ }] },
  );

  await admin.close();
  await ctx.close();
}

module.exports = { run };
