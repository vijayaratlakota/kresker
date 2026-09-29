'use strict';
/* AREA E2 — the remaining clickables on the dashboard, with the admin account. */
const L = require('./lib');

const E = 'E extras';

async function run(browser, S) {
  const ctx = await L.newContext(browser, 'admin', { storageState: S.adminState });
  const page = await L.newPage(ctx);
  const dropzone = () => page.getByText(/Drag a video in, or choose a file|Drop it here/).first();

  await L.goto(page, '/app');
  await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
  await L.dismissBanner(page);

  const upload = async () => {
    const r = page.waitForResponse((x) => /\/api\/uploads$/.test(x.url()) && x.request().method() === 'POST', { timeout: 120000 });
    await page.locator('input[type="file"]').setInputFiles(L.VIDEO);
    await r;
    await page.getByText('Left after this').waitFor({ timeout: 20000 });
  };
  const presign = [
    { kind: 'response', status: 503, url: /\/api\/uploads\/presign$/ },
    { kind: 'console', text: /status of 503/, url: /\/api\/uploads\/presign$/ },
  ];

  await L.step(E, 'Dubbing: "Remove this file" after an upload returns to the drop zone', async () => {
    await upload();
    await page.getByRole('button', { name: 'Remove this file' }).click();
    await dropzone().waitFor({ timeout: 5000 });
    return 'ok';
  }, { allow: presign });
  await L.step(E, 'Dubbing: "Cancel" after an upload returns to the drop zone', async () => {
    await upload();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dropzone().waitFor({ timeout: 5000 });
    return 'ok';
  }, { allow: presign });
  await L.step(E, 'Dubbing: two languages in one batch (Hindi + Telugu) -> "All 2 dubs are ready"', async () => {
    await upload();
    for (const lang of ['Hindi', 'Telugu']) {
      await page.getByText(/Select languages — \d+ available|\d of 8 selected/).click();
      await page.getByLabel('Search languages').fill(lang);
      await page.getByRole('option', { name: new RegExp(`^${lang}`) }).click();
      await page.keyboard.press('Escape');
    }
    const facts = ((await page.locator('main').textContent()) || '').replace(/\s+/g, ' ');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/jobs') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Dub into 2 languages' }).click();
    const j = await (await created).json();
    S.adminBatch = j.jobs.map((x) => x.job_id);
    const t = await L.toast(page, /2 dubs are running/);
    await page.getByText('Dubbing into 2 languages').waitFor({ timeout: 10000 });
    const s1 = await L.shot(page, 'E2_batch_running');
    await page.getByText('All 2 dubs are ready').waitFor({ timeout: 240000 });
    const s2 = await L.shot(page, 'E2_batch_ready');
    const rows = await page.getByRole('link', { name: /^(Hindi|Telugu)$/ }).count();
    return `"Will use" hint: "${(facts.match(/Will use\s*\S+\s*[^L]*/) || [''])[0].trim().slice(0, 40)}"; jobs ${S.adminBatch.join(', ')}; toast "${t.slice(0, 50)}"; per-language rows with links: ${rows} (${s1}, ${s2})`;
  }, { allow: presign });
  await L.step(E, 'Batch row language link opens that job; "Dub another video" resets', async () => {
    await page.getByRole('link', { name: 'Telugu', exact: true }).first().click();
    await page.waitForURL(/\/app\/jobs\/[0-9a-f]+$/, { timeout: 10000 });
    await page.getByRole('heading', { level: 1, name: 'Dub into Telugu' }).waitFor({ timeout: 20000 });
    await page.goBack();
    await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 20000 });
    const again = page.getByRole('button', { name: 'Dub another video' });
    const present = await again.isVisible().catch(() => false);
    if (present) {
      await again.click();
      await dropzone().waitFor({ timeout: 5000 });
    }
    return `language link -> job page; after Back the batch panel is ${present ? 'still there and "Dub another video" resets to the drop zone' : 'gone (page state reset on navigation), drop zone shown'}`;
  });
  await L.step(E, 'Recent dubs: job id link -> job page; back link "Dubbing" -> /app', async () => {
    const id = S.adminBatch[0];
    await page.getByRole('link', { name: id }).first().click();
    await page.waitForURL(new RegExp(`/app/jobs/${id}$`), { timeout: 10000 });
    await page.getByRole('heading', { level: 1, name: /Dub into/ }).waitFor({ timeout: 20000 });
    await page.locator('main').getByRole('link', { name: 'Dubbing' }).click();
    await page.waitForURL(/\/app\/?$/, { timeout: 10000 });
    return 'ok';
  });
  await L.step(E, 'Dubbing aside plan card button -> /app/billing', async () => {
    const b = page.getByRole('button', { name: /^(See plans|Manage plan)$/ });
    const label = (await b.innerText()).trim();
    await b.click();
    await page.waitForURL(/\/app\/billing$/, { timeout: 10000 });
    return `"${label}" -> /app/billing`;
  });
  await L.step(E, 'Sidebar brand "Kresker" -> homepage, whose nav then offers "Open dashboard"', async () => {
    await page.locator('aside').getByRole('link', { name: 'Kresker' }).first().click();
    await page.waitForURL(L.BASE + '/', { timeout: 10000 });
    await L.h1(page, 30000);
    await page.locator('header').getByRole('button', { name: 'Open dashboard' }).click();
    await page.waitForURL(/\/app\/?$/, { timeout: 10000 });
    return 'ok';
  });
  await L.step(E, 'Auth page footer links: signup "Sign in", verify "Sign in", reset-with-token "Need a new link?"', async () => {
    const anon = await L.newContext(browser, 'anon-e2');
    const p = await L.newPage(anon);
    try {
      await L.goto(p, '/signup');
      await L.h1(p, 30000);
      await p.getByRole('link', { name: 'Sign in', exact: true }).click();
      await p.waitForURL(/\/login$/, { timeout: 10000 });
      await L.goto(p, '/verify');
      await L.h1(p);
      await p.getByRole('link', { name: 'Sign in', exact: true }).click();
      await p.waitForURL(/\/login$/, { timeout: 10000 });
      await L.goto(p, '/reset?token=not-a-real-token');
      await p.getByRole('heading', { level: 1, name: 'Choose a new password' }).waitFor({ timeout: 15000 });
      await p.getByRole('link', { name: 'Need a new link?' }).click();
      await p.waitForURL(/\/reset$/, { timeout: 10000 });
      return 'all three work';
    } finally {
      await anon.close();
    }
  });
  await L.step(
    E,
    'Reset form with an invalid token shows the expired-link message',
    async () => {
      const anon = await L.newContext(browser, 'anon-e2b');
      const p = await L.newPage(anon);
      try {
        await L.goto(p, '/reset?token=not-a-real-token');
        await p.getByRole('heading', { level: 1, name: 'Choose a new password' }).waitFor({ timeout: 15000 });
        await p.locator('#f-new-password').fill('Valid-password-123');
        await p.locator('#f-new-password-again').fill('Valid-password-123');
        await p.getByRole('button', { name: 'Change password' }).click();
        const t = await p.getByRole('alert').innerText({ timeout: 10000 });
        return `"${t.trim()}"`;
      } finally {
        await anon.close();
      }
    },
    { allow: [{ kind: 'response', status: 400, url: /\/api\/auth\/reset\/confirm$/ }, { kind: 'console', text: /status of 400/, url: /\/api\/auth\/reset\/confirm$/ }] },
  );

  await ctx.storageState({ path: S.adminState });
  await ctx.close();
}

module.exports = { run };
