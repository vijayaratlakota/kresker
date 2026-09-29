'use strict';
/* AREA E — everything else a person can click, plus re-checks. */
const L = require('./lib');

const E = 'E extras';

async function run(browser, S) {
  const anon = await L.newContext(browser, 'anon-e');
  const ap = await L.newPage(anon);
  const admin = await L.newContext(browser, 'admin', { storageState: S.adminState });
  const page = await L.newPage(admin);
  S.rights = S.rights || {};

  // ── data-rights requests from the contact page ────────────────────────────
  const rightsEmail = `ui-rights-${S.stamp}@example.com`;
  for (const [kind, label] of [
    ['access', 'Send me a copy of my data'],
    ['erasure', 'Delete my data and close my account'],
  ]) {
    await L.step(E, `Contact page "Data rights request" (${kind}) is filed with a deadline`, async () => {
      const t0 = Date.now() - 1000;
      await L.goto(ap, '/contact?kind=access');
      await L.h1(ap, 30000);
      await L.dismissBanner(ap);
      await ap.locator('#rights-kind').selectOption({ label });
      await ap.locator('#f-email').fill(rightsEmail);
      await ap.locator('#msg').fill(`UI check ${kind} request ${S.stamp}`);
      const resp = ap.waitForResponse((r) => r.url().endsWith('/api/privacy/request'));
      await ap.getByRole('button', { name: 'File the request' }).click();
      const r = await resp;
      const j = await r.json();
      S.rights[kind] = j.id;
      await ap.getByText('Got it.').waitFor({ timeout: 10000 });
      const t = (await L.text(ap, 'main')).match(/we will answer by [^.]+/);
      const s = await L.shot(ap, `E_rights_${kind}`);
      const mail = await L.waitMail(rightsEmail, 'rights_ack', { after: t0 });
      return `-> ${r.status()} id=${j.id} due ${j.due_at}; page "${t ? t[0] : '(no deadline text)'}"; mail ${mail.file} (${s})`;
    });
  }
  await L.step(E, 'Admin inbox: pick up the access request, refuse to resolve without a note, then resolve', async () => {
    await L.goto(page, '/app/admin/inbox');
    await page.getByRole('heading', { level: 1, name: 'Inbox' }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Rights only', exact: true }).click();
    const card = page.getByRole('button', { name: /Access request/ }).first();
    await card.waitFor({ timeout: 10000 });
    const head = (await card.innerText()).replace(/\s+/g, ' ');
    await card.click();
    await page.getByRole('button', { name: 'Picking this up' }).click();
    const t1 = await L.toast(page, /marked in progress/);
    await page.getByRole('button', { name: 'In progress', exact: true }).click();
    const again = page.getByRole('button', { name: /Access request/ }).first();
    await again.waitFor({ timeout: 10000 });
    if ((await again.getAttribute('aria-expanded')) !== 'true') await again.click();
    await page.getByRole('button', { name: 'Resolved', exact: true }).click();
    const t2 = await L.toast(page, /Say what was actually done/);
    await page.locator(`#note-${S.rights.access}`).fill('Export sent by the UI check');
    await page.getByRole('button', { name: 'Resolved', exact: true }).click();
    const t3 = await L.toast(page, /marked resolved/);
    const s = await L.shot(page, 'E_inbox_rights');
    return `row "${head.slice(0, 120)}"; "Picking this up" -> "${t1}"; Resolved w/o note -> "${t2.slice(0, 80)}"; with note -> "${t3}" (${s})`;
  });
  await L.step(E, 'Admin inbox: erasure request shows the identity warning; "Reject"', async () => {
    await page.getByRole('button', { name: 'Needs an answer', exact: true }).click();
    const card = page.getByRole('button', { name: /Erasure/ }).first();
    await card.waitFor({ timeout: 10000 });
    await card.click();
    const warn = await page.getByText(/Verify who this is before doing anything/).isVisible();
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    const t = await L.toast(page, /marked rejected/);
    return `identity warning shown=${warn}; "Reject" -> "${t}"`;
  });

  // ── signup edge cases ─────────────────────────────────────────────────────
  await L.step(
    E,
    'Signup with an address that already has an account',
    async () => {
      await L.goto(ap, '/signup');
      await L.h1(ap);
      await ap.locator('#f-email').fill(S.admin.email);
      await ap.locator('#f-password').fill('Some-new-password-1');
      await ap.getByRole('button', { name: 'Sign up', exact: true }).click();
      const t = await ap.getByRole('alert').innerText({ timeout: 10000 });
      return `"${t.trim()}"`;
    },
    { allow: [{ kind: 'response', status: 409, url: /\/api\/auth\/register$/ }, { kind: 'console', text: /status of 409/, url: /\/api\/auth\/register$/ }] },
  );
  await L.step(
    E,
    'Signup with a +tag of an existing inbox',
    async () => {
      await L.goto(ap, '/signup');
      await L.h1(ap);
      await ap.locator('#f-email').fill(S.admin.email.replace('@', '+tag@'));
      await ap.locator('#f-password').fill('Some-new-password-1');
      await ap.getByRole('button', { name: 'Sign up', exact: true }).click();
      const t = await ap.getByRole('alert').innerText({ timeout: 10000 });
      return `"${t.trim()}"`;
    },
    { allow: [{ kind: 'response', status: 409, url: /\/api\/auth\/register$/ }, { kind: 'console', text: /status of 409/, url: /\/api\/auth\/register$/ }] },
  );

  // ── the confirm page in this dev build ───────────────────────────────────
  await L.step(
    E,
    'Verify page with a bogus token (evidence for the confirm-page hang)',
    async () => {
      await L.goto(ap, `/verify?token=bogus2-${S.stamp}`);
      await L.h1(ap, 30000);
      const failed = await ap
        .getByText('That link did not work')
        .waitFor({ timeout: 12000 })
        .then(() => true)
        .catch(() => false);
      const h = await L.h1(ap);
      const s = await L.shot(ap, 'E_verify_bogus');
      if (failed) return `failure screen shown (${s})`;
      return { status: 'FAIL', note: `after 12 s the page still reads "${h}" / "Checking that link…" although POST /api/auth/verify already answered 400 (${s})` };
    },
    { allow: [{ kind: 'response', status: 400, url: /\/api\/auth\/verify$/ }, { kind: 'console', text: /status of 400/, url: /\/api\/auth\/verify$/ }] },
  );

  // ── links the product emails point at ─────────────────────────────────────
  await L.step(E, '"Try again" link in the job_failed email (/app)', async () => {
    // notify.ts now links to /app, the dubbing page; it used to build /app/dubbing,
    // which was never a route.
    await L.goto(page, '/app');
    await L.h1(page, 30000);
    const body = await L.text(page);
    const s = await L.shot(page, 'E_app_dubbing');
    if (/There is nothing here/.test(body)) return { status: 'FAIL', note: `signed-in visit to /app renders the 404 page "There is nothing here" (${s})` };
    return `renders "${(await L.h1(page)).trim()}"`;
  });

  // ── contact page e-mail line ──────────────────────────────────────────────
  await L.step(E, 'Contact page "Prefer email? Write to …" line (no grievance e-mail configured)', async () => {
    await L.goto(ap, '/contact');
    await L.h1(ap, 30000);
    await ap.getByText(/Prefer email\? Write to/).waitFor({ timeout: 10000 });
    const line = await ap.getByText(/Prefer email\? Write to/).innerText();
    const href = await ap.getByText(/Prefer email\? Write to/).locator('a').getAttribute('href');
    const s = await L.shot(ap, 'E_contact_email_line');
    if (/NOT CONFIGURED/.test(line)) return { status: 'FAIL', note: `renders "${line.trim()}" with a link to "${href}" (${s})` };
    return `"${line.trim()}"`;
  });

  // ── sessions for a customer, precisely ────────────────────────────────────
  await L.step(E, 'Your data: sessions list / sign out other sessions (re-check, inside the page body)', async () => {
    await L.goto(page, '/app/privacy');
    await page.getByRole('heading', { level: 1, name: 'Your data' }).waitFor({ timeout: 20000 });
    await page.getByText('Necessary to provide the service').waitFor({ timeout: 15000 });
    const main = page.locator('main');
    const heads = await main.locator('h1,h2,h3').allInnerTexts();
    const btns = await main.getByRole('button').allInnerTexts();
    const sessionUi = heads.some((h) => /session|device|signed in/i.test(h)) || btns.some((b) => /sign out|log out|end session|everywhere/i.test(b));
    return {
      status: sessionUi ? 'PASS' : 'FAIL',
      note: `headings [${heads.join(' | ')}]; buttons [${btns.map((b) => b.trim()).join(' | ')}] - ${sessionUi ? 'session controls found' : 'no sessions list or "sign out other sessions" control for customers (the only session control is the sidebar "Sign out" for this browser)'}`,
    };
  });

  // ── inside the app ────────────────────────────────────────────────────────
  await L.step(
    E,
    'Unknown job id -> "That job does not exist, or it is not yours." + "Back to dubbing"',
    async () => {
      await L.goto(page, '/app/jobs/000000000000');
      await page.getByText('That job does not exist, or it is not yours.').waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'Back to dubbing' }).click();
      await page.waitForURL(/\/app\/?$/, { timeout: 10000 });
      return 'message shown; button -> /app';
    },
    { allow: [{ kind: 'response', status: 404, url: /\/api\/jobs\/000000000000$/ }, { kind: 'console', text: /status of 404/, url: /\/api\/jobs\/000000000000$/ }] },
  );
  await L.step(E, 'Grant dialog "Cancel" and Escape close without granting', async () => {
    await L.goto(page, '/app/admin/people');
    await page.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 20000 });
    const row = page.getByRole('row').filter({ hasText: S.admin.email });
    await row.getByRole('button', { name: 'Grant plan' }).click();
    const dlg = page.getByRole('dialog', { name: 'Grant a subscription' });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await dlg.waitFor({ state: 'hidden', timeout: 5000 });
    await row.getByRole('button', { name: 'Grant plan' }).click();
    await dlg.waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'hidden', timeout: 5000 });
    return 'both close the dialog';
  });
  await L.step(E, 'Admin: "Block buying" on your own account is refused with a message', async () => {
    const row = page.getByRole('row').filter({ hasText: S.admin.email });
    await row.getByRole('button', { name: 'Block buying' }).click();
    const dlg = page.getByRole('dialog', { name: 'Block this account from buying' });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.getByLabel('Reason').fill('UI check self-block');
    await dlg.getByLabel('Your password').fill(S.admin.password);
    await dlg.getByRole('button', { name: 'Block buying' }).click();
    const err = await dlg.getByRole('alert').innerText({ timeout: 10000 });
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    return `refused inside the dialog: "${err.trim()}"`;
  }, { allow: [{ kind: 'response', status: 400, url: /block-purchases$/ }, { kind: 'console', text: /status of 400/, url: /block-purchases$/ }] });
  await L.step(E, 'Phone width (390px) dashboard: "Open navigation" drawer works', async () => {
    const phone = await L.newContext(browser, 'admin-phone', { storageState: S.adminState, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pp = await L.newPage(phone);
    try {
      await L.goto(pp, '/app');
      await pp.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
      await L.dismissBanner(pp);
      await pp.getByRole('button', { name: 'Open navigation' }).click();
      await pp.getByRole('button', { name: 'Close navigation' }).waitFor({ timeout: 5000 });
      const s = await L.shot(pp, 'E_phone_drawer');
      await pp.getByRole('link', { name: 'People' }).click();
      await pp.waitForURL(/\/app\/admin\/people$/, { timeout: 10000 });
      await pp.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 20000 });
      const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const s2 = await L.shot(pp, 'E_phone_people');
      return `drawer opens, "People" navigates; horizontal overflow on /app/admin/people = ${overflow}px (${s}, ${s2})`;
    } finally {
      await phone.close();
    }
  });
  await L.step(E, '/openapi.json and /docs through the site origin', async () => {
    const o = await L.api(admin, 'GET', '/openapi.json');
    const d = await L.newPage(admin);
    await d.goto(L.BASE + '/docs', { waitUntil: 'domcontentloaded' });
    await L.sleep(3000);
    const txt = (await d.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
    const s = await L.shot(d, 'E_docs');
    await d.close();
    const paths = o.body && o.body.paths ? Object.keys(o.body.paths).length : 0;
    return { note: `/openapi.json -> ${o.status} (${paths} paths); /docs body "${txt}" (Swagger UI assets come from a CDN, blocked here) (${s})` };
  }, { noiseOk: true });

  await admin.close();
  await anon.close();
}

module.exports = { run };
