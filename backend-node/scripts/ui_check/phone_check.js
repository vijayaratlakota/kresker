'use strict';
/*
  Phone check for the fixes of 2026-09-27: the three iPhone screenshots, plus the eight
  reported problems, against a LOCAL backend (8096, fake engine) and Vite (5174).

  WebKit - the engine inside iPhone Safari - with Playwright's "iPhone 13" profile
  (390x844, touch, coarse pointer), then Chromium with the same profile for comparison.
  Nothing leaves this machine: the same request guard as the rest of ui_check aborts
  every non-local request, and the backend runs the fake engine with AWS unreachable.

  Usage:  node phone_check.js <stamp>
  Output: shots_phone/<engine>_NN_name.png and phone_results.json
*/
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { webkit, chromium, devices } = require('C:/paid video player/node_modules/playwright');

const OUT = path.join(__dirname, 'shots_phone');
fs.mkdirSync(OUT, { recursive: true });
const STAMP = process.argv[2] || String(Date.now()).slice(-9);
const results = [];
let engine = 'webkit';
let n = 0;

function rec(name, ok, note) {
  results.push({ engine, name, ok, note: String(note || '').slice(0, 700) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${engine} | ${name} | ${note}`);
}

async function shot(page, name, fullPage = false) {
  n += 1;
  const f = path.join(OUT, `${engine}_${String(n).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: f, fullPage });
  return path.relative(__dirname, f).replace(/\\/g, '/');
}

async function step(name, fn) {
  try {
    const note = await fn();
    rec(name, true, note);
  } catch (e) {
    rec(name, false, String(e && e.message ? e.message : e).split('\n')[0]);
  }
}

const GUARD = { proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost,[::1]' } };

/** The banner slides in after the page mounts, so wait briefly for it before answering. */
async function dismissBannerWhenShown(page) {
  const b = page.locator('[data-consent-banner="true"]');
  await b.waitFor({ state: 'visible', timeout: 4000 }).catch(() => undefined);
  await L.dismissBanner(page);
}

// A step that fails must not leave a pending wait behind to crash the run later.
process.on('unhandledRejection', (e) => console.log('  (ignored a late rejection:', String(e && e.message ? e.message : e).split('\n')[0], ')'));

async function run(browserType, label, admin, user) {
  engine = label;
  n = 0;
  const browser = await browserType.launch({ headless: true, ...GUARD });
  const phone = devices['iPhone 13'];
  const ctx = await L.newContext(browser, `${label}-admin`, { ...phone });
  const page = await ctx.newPage();
  let batch = [];

  try {
    // ── sign in ───────────────────────────────────────────────────────────────
    await step('sign in on a phone', async () => {
      // The account is made through the API (the first account on a fresh database is
      // the admin, confirmed); what is tested here is the phone sign-in form. A 409 just
      // means an earlier run already made it.
      await L.api(ctx, 'POST', '/api/auth/register', { json: { email: admin.email, password: admin.password }, csrf: false });
      await ctx.clearCookies();
      await L.goto(page, '/login');
      await L.h1(page, 30000);
      // On a phone the consent banner covers the form until it is answered, as it would
      // for a first-time visitor.
      await dismissBannerWhenShown(page);
      await page.locator('#f-email').fill(admin.email);
      await page.locator('#f-password').fill(admin.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL(/\/app\/?$/, { timeout: 30000 });
      await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
      await L.dismissBanner(page);
      const me = await L.api(ctx, 'GET', '/api/auth/me');
      admin.id = me.body.id;
      if (me.body.role !== 'admin') throw new Error(`role ${me.body.role}`);
      // Whether this engine reports a finger, which is what the touch-only CSS keys on.
      const media = await page.evaluate(() => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        hover: matchMedia('(hover: hover)').matches,
        width: innerWidth,
      }));
      return `admin #${admin.id}; pointer coarse=${media.coarse}, hover=${media.hover}, width ${media.width}px`;
    });

    // ── upload, then the language picker (screenshot 1) ───────────────────────
    await step('upload a video', async () => {
      const [resp] = await Promise.all([
        page.waitForResponse((x) => /\/api\/uploads$/.test(x.url()) && x.request().method() === 'POST', { timeout: 120000 }),
        page.locator('input[type="file"]').setInputFiles(L.VIDEO),
      ]);
      await page.getByText('Left after this').waitFor({ timeout: 30000 });
      return `POST /api/uploads -> ${resp.status()}`;
    });

    await step('pick Hindi and English', async () => {
      for (const lang of ['Hindi', 'English']) {
        await page.getByText(/Select languages — \d+ available|\d of 8 selected/).click();
        await page.getByLabel('Search languages').fill(lang);
        await page.getByRole('option', { name: new RegExp(`^${lang}`) }).first().click();
        await page.keyboard.press('Escape');
        await L.sleep(300);
      }
      const t = await page.getByText(/\d of 8 selected/).innerText();
      return t;
    });

    await step('picker open: no blank band, group label never on top of a row', async () => {
      await page.getByText(/\d of 8 selected/).click();
      const list = page.getByRole('listbox');
      await list.waitFor({ timeout: 10000 });
      // Scroll so the boundary between the two groups sits near the top of the list,
      // which is where the screenshot caught "MORE LANGUAGES" printed over "Polish".
      await page.evaluate(() => {
        const lb = document.querySelector('[role="listbox"]');
        const label = [...lb.querySelectorAll('*')].find(
          (e) => e.childElementCount === 0 && /^more languages$/i.test((e.textContent || '').trim()),
        );
        if (label) lb.scrollTop += label.getBoundingClientRect().top - lb.getBoundingClientRect().top - 18;
      });
      await L.sleep(400);
      const geo = await page.evaluate(() => {
        const lb = document.querySelector('[role="listbox"]');
        const lr = lb.getBoundingClientRect();
        const vis = (r) => r.bottom > lr.top + 1 && r.top < lr.bottom - 1;
        const labels = [...lb.querySelectorAll('*')]
          .filter((e) => e.childElementCount === 0 && /languages$/i.test((e.textContent || '').trim()))
          .map((e) => e.getBoundingClientRect())
          .filter(vis);
        const rows = [...lb.querySelectorAll('[role="option"]')].map((e) => e.getBoundingClientRect()).filter(vis);
        let overlaps = 0;
        for (const a of labels)
          for (const b of rows) {
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (w > 1 && h > 1) overlaps++;
          }
        // The "No language matches" element: a sibling of the list inside the popup.
        const empty = [...lb.parentElement.querySelectorAll(':scope > [role="status"][aria-live="polite"]')].map((e) => e.getBoundingClientRect().height);
        return { labels: labels.length, rows: rows.length, overlaps, emptyHeights: empty };
      });
      const s = await shot(page, 'picker_open');
      if (geo.overlaps) throw new Error(`${geo.overlaps} label/row overlap(s) (${s})`);
      if (geo.emptyHeights.some((h) => h > 1)) throw new Error(`empty-state band still ${geo.emptyHeights.join('/')}px tall (${s})`);
      return `${geo.rows} rows and ${geo.labels} group label(s) visible, 0 overlaps, empty band 0px (${s})`;
    });

    await step('chips: both fully visible, nothing on top of them', async () => {
      await page.keyboard.press('Escape');
      await L.sleep(400);
      // Measured where a person sees them: in the viewport (elementFromPoint only
      // answers for points inside it).
      await page.locator('button[aria-label^="Remove "]').first().scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 120));
      await L.sleep(300);
      const chips = await page.evaluate(() =>
        [...document.querySelectorAll('li')]
          .filter((li) => li.querySelector('button[aria-label^="Remove "]'))
          .map((li) => {
            const r = li.getBoundingClientRect();
            const ys = r.top + r.height / 2;
            const xs = [r.left + 6, r.left + r.width * 0.35, r.left + r.width * 0.65, r.right - 6];
            const covered = xs.filter((x) => {
              const el = document.elementFromPoint(x, ys);
              return !el || !li.contains(el);
            }).length;
            return { text: li.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), covered, inView: r.left >= 0 && r.right <= innerWidth };
          }),
      );
      const s = await shot(page, 'chips');
      const bad = chips.filter((c) => c.covered || !c.inView || c.width < 40);
      if (chips.length !== 2) throw new Error(`${chips.length} chips (${s})`);
      if (bad.length) throw new Error(`covered or clipped: ${JSON.stringify(bad)} (${s})`);
      return chips.map((c) => `"${c.text}" ${c.width}px`).join(', ') + ` (${s})`;
    });

    // ── start the batch; the toast (screenshot 3, bottom) ─────────────────────
    await step('toast after "Dub into 2 languages": close button on screen, solid', async () => {
      const [r] = await Promise.all([
        page.waitForResponse((x) => x.url().endsWith('/api/jobs') && x.request().method() === 'POST'),
        page.getByRole('button', { name: 'Dub into 2 languages' }).click(),
      ]);
      batch = (await r.json()).jobs.map((j) => j.job_id);
      const toastEl = page.locator('[data-sonner-toast]').first();
      await toastEl.waitFor({ timeout: 10000 });
      await L.sleep(700); // let the entry animation settle
      const x = await page.locator('[data-sonner-toast] [data-close-button]').first().boundingBox();
      const t = await toastEl.boundingBox();
      const bg = await toastEl.evaluate((e) => getComputedStyle(e).backgroundColor);
      const s = await shot(page, 'toast');
      if (!x || x.x < 0 || x.width > 30) throw new Error(`close button at x=${x && x.x} w=${x && x.width} (${s})`);
      if (t.x < 4 || t.x + t.width > 390 - 4) throw new Error(`toast spills off screen: ${JSON.stringify(t)} (${s})`);
      return `close ✕ at x=${Math.round(x.x)} ${Math.round(x.width)}px; toast ${Math.round(t.x)}..${Math.round(t.x + t.width)}; background ${bg} (${s})`;
    });

    // ── the batch rows (screenshot 3): hold the jobs at the screenshot's stages ─
    // The fake engine finishes in seconds, so the list endpoint is rewritten on the way
    // back: job 1 separating speech at 2%, job 2 waiting - and, for the table below, a
    // few more dubs in the states the second screenshot showed.
    const fake = (base, id, lang, state, pct, extra = {}) => ({
      ...base,
      job_id: id,
      target_lang: lang,
      state,
      percent: pct,
      can_download: false,
      can_cancel: false,
      error_code: null,
      ...extra,
    });
    await page.route('**/api/jobs', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const resp = await route.fetch();
      const json = await resp.json();
      const base = json.jobs[0] || {};
      const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 19) + 'Z';
      const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 19) + 'Z';
      json.jobs = [
        // 'preparing' is the stage labelled "Separating speech from background"
        fake(base, batch[0], 'hi', 'preparing', 2),
        fake(base, batch[1], 'en', 'queued', 0),
        fake(base, 'aaaaaaaaaaa1', 'te', 'done', 100, { expires_at: past }),
        fake(base, 'aaaaaaaaaaa2', 'en', 'done', 100, { expires_at: soon, can_download: true }),
        fake(base, 'aaaaaaaaaaa3', 'hi', 'failed', 0, { error_code: 'ENGINE_ERROR' }),
        fake(base, 'aaaaaaaaaaa4', 'ta', 'rendering', 64),
      ];
      return route.fulfill({ response: resp, json });
    });

    await step('batch rows: language name visible, stage text not squeezed, no overlap', async () => {
      // Poll the rows themselves rather than one piece of text, and say what they show
      // if the expected stage never arrives.
      let texts = [];
      for (let i = 0; i < 30; i++) {
        texts = await page.locator('li.row-in').allInnerTexts();
        if (texts.length === 2 && /Separating speech from background/.test(texts[0])) break;
        await L.sleep(500);
      }
      await page.locator('li.row-in').first().scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -140));
      await L.sleep(500);
      if (!(texts.length === 2 && /Separating speech from background/.test(texts[0]))) {
        const s = await shot(page, 'batch_rows_unexpected');
        throw new Error(`rows show ${JSON.stringify(texts.map((t) => t.replace(/\s+/g, ' ')))} (${s})`);
      }
      const rows = await page.evaluate(() => {
        const lis = [...document.querySelectorAll('li.row-in')];
        return lis.map((li) => {
          const link = li.querySelector('a[href^="/app/jobs/"]');
          const stage = li.querySelector('p');
          const pill = [...li.querySelectorAll('span')].find((s) => s.className.includes('rounded-full') && s.className.includes('border') && s.offsetParent !== null);
          const lr = link.getBoundingClientRect();
          const sr = stage.getBoundingClientRect();
          const pr = pill ? pill.getBoundingClientRect() : null;
          const lineH = parseFloat(getComputedStyle(stage).lineHeight) || 16;
          const overlap = pr && Math.min(pr.right, sr.right) - Math.max(pr.left, sr.left) > 1 && Math.min(pr.bottom, sr.bottom) - Math.max(pr.top, sr.top) > 1;
          return { name: link.textContent, nameWidth: Math.round(lr.width), stageLines: Math.round(sr.height / lineH), stage: stage.textContent, pill: pill ? pill.textContent : null, overlap: !!overlap };
        });
      });
      const s = await shot(page, 'batch_rows');
      const bad = rows.filter((r) => r.nameWidth < 25 || r.stageLines > 2 || r.overlap);
      if (rows.length !== 2) throw new Error(`${rows.length} rows (${s})`);
      if (bad.length) throw new Error(`${JSON.stringify(bad)} (${s})`);
      return rows.map((r) => `${r.name} (${r.nameWidth}px) "${r.stage}" pill=${r.pill ?? 'none'}`).join(' | ') + ` (${s})`;
    });

    // ── Recent dubs (screenshot 2) ────────────────────────────────────────────
    await step('Recent dubs on a phone: no sideways scroll, nothing covered, Open is a button', async () => {
      await page.getByRole('button', { name: 'Refresh' }).first().click();
      await L.sleep(800);
      const card = page.locator('h2', { hasText: 'Recent dubs' }).locator('xpath=ancestor::div[contains(@class,"rounded-")][1]');
      await card.scrollIntoViewIfNeeded();
      await L.sleep(300);
      const geo = await card.evaluate((el) => {
        const lis = [...el.querySelectorAll('ul > li')].filter((li) => li.offsetParent !== null);
        const opens = [...el.querySelectorAll('a')].filter((a) => a.textContent.trim() === 'Open' && a.offsetParent !== null);
        const cs = opens[0] ? getComputedStyle(opens[0]) : null;
        const rows = lis.map((li) => {
          const r = li.getBoundingClientRect();
          const kids = [...li.querySelectorAll('*')].map((k) => k.getBoundingClientRect()).filter((k) => k.width > 0);
          const spill = kids.some((k) => k.right > r.right + 1 || k.left < r.left - 1);
          return { text: li.textContent.replace(/\s+/g, ' ').trim().slice(0, 60), spill };
        });
        return {
          rows,
          tableShown: [...el.querySelectorAll('table')].some((t) => t.offsetParent !== null),
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
          openCount: opens.length,
          openBg: cs && cs.backgroundColor,
          openBorder: cs && cs.borderTopWidth,
          openHeight: opens[0] ? Math.round(opens[0].getBoundingClientRect().height) : 0,
        };
      });
      const s = await shot(page, 'recent_dubs');
      const spill = geo.rows.filter((r) => r.spill);
      if (geo.tableShown) throw new Error(`the wide table is still shown on a phone (${s})`);
      if (geo.pageOverflow > 0) throw new Error(`page scrolls sideways by ${geo.pageOverflow}px (${s})`);
      if (spill.length) throw new Error(`content spills out of a row: ${JSON.stringify(spill)} (${s})`);
      if (!geo.openCount || /rgba\(0, 0, 0, 0\)|transparent/.test(geo.openBg) || parseFloat(geo.openBorder) < 1) {
        throw new Error(`"Open" does not look like a button: bg=${geo.openBg} border=${geo.openBorder} (${s})`);
      }
      return `${geo.rows.length} stacked rows, no spill, no sideways scroll; ${geo.openCount} "Open" buttons (bg ${geo.openBg}, border ${geo.openBorder}, ${geo.openHeight}px tall) (${s})`;
    });
    await page.unroute('**/api/jobs');

    // ── the rest only needs doing once, and it changes data ───────────────────
    if (label !== 'webkit') return;

    await step('ghost buttons ("Refresh", "Dub another video") are outlined on touch', async () => {
      const b = page.getByRole('button', { name: 'Refresh' }).first();
      const st = await b.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, ring: getComputedStyle(e).boxShadow }));
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(st.bg) && (!st.ring || st.ring === 'none')) throw new Error(JSON.stringify(st));
      return `Refresh: bg ${st.bg}, ring ${String(st.ring).slice(0, 60)}`;
    });

    await step('the real jobs finish; the "ready" email links to the job page', async () => {
      const t0 = Date.now() - 60000;
      await page.getByText(/All 2 dubs are ready|\d of 2 ready/).waitFor({ timeout: 240000 });
      const mail = await L.waitMail(admin.email, 'job_done', { after: t0, timeout: 30000 });
      const links = mail.text.match(/https?:\/\/\S+/g) || [];
      const hit = links.find((u) => /\/app\/jobs\/[0-9a-f]+$/.test(u));
      if (!hit) throw new Error(`links in the mail: ${links.join(' ')}`);
      if (links.some((u) => u.includes('?job='))) throw new Error('old /?job= link still present');
      await L.goto(page, hit.replace(/^https?:\/\/[^/]+/, ''));
      await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 20000 });
      const h = await L.h1(page);
      const s = await shot(page, 'job_page_from_email');
      if (/There is nothing here/.test(await L.text(page))) throw new Error(`404 (${s})`);
      return `${hit.replace(/^https?:\/\/[^/]+/, '')} opens "${h}" (${s})`;
    });

    await step('/db "Run SELECT" works (CSRF token sent)', async () => {
      const db = await ctx.newPage();
      await L.goto(db, '/db');
      await db.locator('#sql').fill('SELECT id, email, role FROM users ORDER BY id');
      await db.getByRole('button', { name: 'Run SELECT' }).click();
      await db.locator('#out table').waitFor({ timeout: 15000 });
      const title = await db.locator('#title').innerText();
      const err = await db.locator('#err').innerText();
      const s = await shot(db, 'db_run_select');
      await db.close();
      if (err.trim()) throw new Error(`error shown: ${err} (${s})`);
      return `"${title}" (${s})`;
    });

    await step('Force stop: refused in demo mode, and the button is off', async () => {
      const r = await L.api(ctx, 'POST', '/api/admin/gpu/stop?force=true');
      await L.goto(page, '/app/admin/gpu');
      const btn = page.getByRole('button', { name: 'Force stop' });
      await btn.waitFor({ timeout: 20000 });
      const disabled = await btn.isDisabled();
      const s = await shot(page, 'gpu_page');
      if (r.status !== 409) throw new Error(`force stop -> ${r.status} ${JSON.stringify(r.body)} (${s})`);
      if (!disabled) throw new Error(`button enabled (${s})`);
      return `API 409 "${String(r.body.detail).slice(0, 80)}"; button disabled (${s})`;
    });

    // a second account, for suspend and for the erasure
    await step('a customer account, confirmed through the emailed link', async () => {
      const c2 = await L.newContext(browser, 'customer');
      user.ctx = c2;
      const t0 = Date.now() - 1000;
      const r = await L.api(c2, 'POST', '/api/auth/register', { json: { email: user.email, password: user.password }, csrf: false });
      if (r.status !== 200) throw new Error(`register ${r.status} ${JSON.stringify(r.body)}`);
      const mail = await L.waitMail(user.email, 'verify_email', { after: t0 });
      const link = L.linkIn(mail.text, '/verify').hit;
      const tok = new URL(link).searchParams.get('token');
      const v = await L.api(c2, 'POST', '/api/auth/verify', { json: { token: tok }, csrf: false });
      if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
      const me = await L.api(c2, 'GET', '/api/auth/me');
      user.id = me.body.id;
      return `#${user.id} confirmed and signed in`;
    });

    await step('People: Suspend, then Reinstate, from the row buttons', async () => {
      await L.goto(page, '/app/admin/people');
      await page.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 20000 });
      const row = page.getByRole('row').filter({ hasText: user.email });
      await row.getByRole('button', { name: 'Suspend' }).click();
      await page.getByLabel('Reason').fill('phone check');
      await page.getByLabel('Your password').fill(admin.password);
      await page.getByRole('button', { name: 'Suspend', exact: true }).last().click();
      await L.toast(page, /is suspended/);
      const s1 = await shot(page, 'people_suspended');
      const st1 = (await L.api(ctx, 'GET', `/api/admin/users?q=${encodeURIComponent(user.email)}`)).body.users[0].status;
      const me = await L.api(user.ctx, 'GET', '/api/auth/me');
      await row.getByRole('button', { name: 'Reinstate' }).click();
      await page.getByLabel('Reason').fill('phone check done');
      await page.getByLabel('Your password').fill(admin.password);
      await page.getByRole('button', { name: 'Reinstate', exact: true }).last().click();
      await L.toast(page, /is reinstated/);
      const st2 = (await L.api(ctx, 'GET', `/api/admin/users?q=${encodeURIComponent(user.email)}`)).body.users[0].status;
      if (st1 !== 'suspended' || st2 !== 'active') throw new Error(`status ${st1} -> ${st2}`);
      if (me.status !== 401) throw new Error(`the suspended session still works: /me ${me.status}`);
      return `suspended (their session ended: /me ${me.status}), then active again (${s1})`;
    });

    await step('People: "Dubs & consent" lists the dubs and refunds one', async () => {
      const row = page.getByRole('row').filter({ hasText: admin.email });
      await row.getByRole('button', { name: 'Dubs & consent' }).click();
      const dlg = page.getByRole('dialog');
      await dlg.getByText('Consent', { exact: true }).waitFor({ timeout: 15000 });
      await dlg.getByRole('button', { name: 'Refund' }).first().click();
      await dlg.getByLabel('Reason').fill('phone check refund');
      await dlg.getByLabel('Your password').fill(admin.password);
      await dlg.getByRole('button', { name: 'Refund the minutes' }).click();
      const t = await L.toast(page, /refunded/);
      const s = await shot(page, 'user_detail_refund');
      const left = (await dlg.getByRole('button', { name: 'Refund' }).count());
      await dlg.getByRole('button', { name: 'Close' }).click();
      return `toast "${t.slice(0, 70)}"; ${left} refundable left (${s})`;
    });

    await step('People: signups report and access log load on request', async () => {
      await page.getByRole('heading', { name: 'Signups from one address' }).scrollIntoViewIfNeeded();
      const cardS = page.locator('h2', { hasText: 'Signups from one address' }).locator('xpath=ancestor::div[contains(@class,"rounded-")][1]');
      await cardS.getByRole('button', { name: 'Show' }).click();
      await cardS.getByText(/accounts ·|No shared addresses/).first().waitFor({ timeout: 15000 });
      const cardA = page.locator('h2', { hasText: 'Personal data access log' }).locator('xpath=ancestor::div[contains(@class,"rounded-")][1]');
      await cardA.getByRole('button', { name: 'Show' }).click();
      await cardA.getByText('admin.').first().waitFor({ timeout: 15000 });
      const s = await shot(page, 'people_reports', true);
      return `both cards filled (${s})`;
    });

    await step('Payments page renders', async () => {
      await L.goto(page, '/app/admin/billing');
      await page.getByRole('heading', { level: 1, name: 'Billing' }).waitFor({ timeout: 20000 });
      await page.getByRole('heading', { name: 'Payment provider' }).waitFor({ timeout: 15000 });
      const s = await shot(page, 'payments_page', true);
      return `provider card + tables (${s})`;
    });

    await step('homepage on a phone: no sideways scroll (for a look at the buttons)', async () => {
      const anon = await L.newContext(browser, 'anon0', { ...phone });
      const p = await anon.newPage();
      await L.goto(p, '/');
      await L.h1(p, 30000);
      await L.sleep(800);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const s = await shot(p, 'homepage');
      await anon.close();
      if (over > 0) throw new Error(`scrolls sideways by ${over}px (${s})`);
      return `(${s})`;
    });

    await step('Contact page: no "NOT CONFIGURED" mailto', async () => {
      const anon = await L.newContext(browser, 'anon', { ...phone });
      const p = await anon.newPage();
      await L.goto(p, '/contact');
      await L.h1(p, 30000);
      await L.sleep(1500);
      const body = await L.text(p);
      const bad = await p.locator('a[href="mailto:NOT CONFIGURED"]').count();
      const s = await shot(p, 'contact');
      await anon.close();
      if (bad) throw new Error(`mailto:NOT CONFIGURED is still rendered (${s})`);
      if (/Write to NOT CONFIGURED/.test(body)) throw new Error(`text still says NOT CONFIGURED (${s})`);
      return `no placeholder address shown (${s})`;
    });

    await step('Maintenance page renders for a visitor (it was blank)', async () => {
      const on = await L.api(ctx, 'POST', '/api/admin/maintenance', { json: { on: true, note: 'Phone check: back in a minute.' } });
      if (on.status !== 200) throw new Error(`maintenance on -> ${on.status} ${JSON.stringify(on.body)}`);
      const anon = await L.newContext(browser, 'anon2', { ...phone });
      const p = await anon.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      try {
        await L.goto(p, '/pricing');
        await p.locator('[data-maintenance="true"]').waitFor({ timeout: 20000 });
        const h = await p.getByRole('heading', { level: 1 }).innerText();
        const mail = await p.getByRole('link', { name: 'Email us' }).getAttribute('href');
        const s = await shot(p, 'maintenance');
        if (errors.length) throw new Error(`page errors: ${errors.join(' | ')} (${s})`);
        return `"${h}", Email us -> ${mail} (${s})`;
      } finally {
        await anon.close();
        await L.api(ctx, 'POST', '/api/admin/maintenance', { json: { on: false, note: '' } });
      }
    });

    await step('Close account for a customer WITH a dub: works, and removes the files', async () => {
      const c2 = user.ctx;
      // The suspension above ended their sessions for good, so sign in again first.
      const li = await L.api(c2, 'POST', '/api/auth/login', { json: { email: user.email, password: user.password }, csrf: false });
      if (li.status !== 200) throw new Error(`sign-in after reinstating -> ${li.status} ${JSON.stringify(li.body)}`);
      const me = await L.api(c2, 'GET', '/api/auth/me');
      const buf = fs.readFileSync(L.VIDEO);
      const up = await c2.request.post(L.BASE + '/api/uploads', {
        multipart: { file: { name: 'erase_test.mp4', mimeType: 'video/mp4', buffer: buf } },
        headers: { 'X-CSRF-Token': me.body.csrf },
        failOnStatusCode: false,
      });
      if (up.status() !== 200) throw new Error(`upload ${up.status()} ${await up.text()}`);
      const uploadId = (await up.json()).upload_id;
      const job = await L.api(c2, 'POST', '/api/jobs', { json: { upload_id: uploadId, target_langs: ['hi'] } });
      if (job.status !== 200) throw new Error(`job ${job.status} ${JSON.stringify(job.body)}`);
      const jobId = job.body.job_id;
      for (let i = 0; i < 120; i++) {
        const j = await L.api(c2, 'GET', `/api/jobs/${jobId}`);
        if (['done', 'failed', 'cancelled'].includes(j.body.state)) break;
        await L.sleep(1500);
      }
      const q = await L.api(ctx, 'POST', '/api/admin/db/query', { json: { sql: `SELECT u.stored_path, j.output_path FROM uploads u JOIN jobs j ON j.upload_id=u.id WHERE j.id='${jobId}'` } });
      const row = q.body.rows[0];
      const src = path.join(L.DATA_DIR, ...String(row.stored_path).split('/'));
      const out = row.output_path ? path.join(L.DATA_DIR, ...String(row.output_path).split('/')) : null;
      const before = [fs.existsSync(src), out ? fs.existsSync(out) : null];
      const r = await L.api(c2, 'POST', '/api/privacy/erase', { json: { password: user.password, confirm: 'DELETE' } });
      const after = [fs.existsSync(src), out ? fs.existsSync(out) : null];
      if (r.status !== 200) throw new Error(`erase -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      if (after[0] || after[1]) throw new Error(`files still on disk after erase: source ${after[0]}, output ${after[1]}`);
      const gone = await L.api(c2, 'GET', '/api/auth/me');
      return `erase 200 (deleted ${JSON.stringify(r.body.deleted)}); source+output on disk before ${before.join('/')} -> after ${after.join('/')}; /me now ${gone.status}`;
    });
  } finally {
    await browser.close();
  }
}

(async () => {
  const admin = { email: `phone-admin-${STAMP}@example.com`, password: `Phone-Admin-${STAMP}-pw` };
  const user = { email: `phone-user-${STAMP}@example.com`, password: `Phone-User-${STAMP}-pw` };
  await run(webkit, 'webkit', admin, user);
  await run(chromium, 'chromium', admin, user);
  fs.writeFileSync(path.join(__dirname, 'phone_results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
