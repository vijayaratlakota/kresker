'use strict';
/* AREA B — the admin account (first signup) and the whole admin panel. */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const B = 'B admin';

async function run(browser, S) {
  S.admin = S.admin || { email: `ui-admin-${S.stamp}@example.com`, password: `Ui-Admin-${S.stamp}-pw` };
  const ctx = await L.newContext(browser, 'admin');
  const page = await L.newPage(ctx);

  // ── B1: first signup becomes the admin ────────────────────────────────────
  await L.step(B, 'Admin signup through the UI (first account) lands on the dashboard', async () => {
    await L.goto(page, '/signup');
    await L.h1(page, 30000);
    await page.locator('#f-email').fill(S.admin.email);
    await page.locator('#f-password').fill(S.admin.password);
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/auth/register'));
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    const r = await resp;
    const j = await r.json();
    await page.waitForURL(/\/app\/?$/, { timeout: 20000 });
    // The route chunk is lazy: wait for the NEW page's heading, not whatever h1 is still up.
    await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
    const h = await L.h1(page, 20000);
    await L.dismissBanner(page);
    const me = await L.api(ctx, 'GET', '/api/auth/me');
    S.admin.id = me.body.id;
    const s = await L.shot(page, 'B_admin_landing');
    if (me.body.role !== 'admin') throw new Error(`role is ${me.body.role}`);
    if (!me.body.email_verified) throw new Error('first account not auto-confirmed');
    for (const n of ['Overview', 'Capacity', 'People', /^Inbox/, 'System'])
      if (!(await page.getByRole('link', { name: n }).first().isVisible())) throw new Error(`admin nav item "${n}" missing`);
    return `register ${r.status()} role=${j.role} note="${j.note}"; landed on ${page.url().replace(L.BASE, '')} h1 "${h}"; /me role=admin email_verified=true; admin nav present (${s})`;
  });

  await L.step(B, 'Admin sign out (sidebar "Sign out")', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/, { timeout: 15000 });
    const me = await L.api(ctx, 'GET', '/api/auth/me');
    if (me.status !== 401) throw new Error(`/api/auth/me after sign-out = ${me.status}`);
    return `-> ${page.url().replace(L.BASE, '')}; /api/auth/me now 401`;
  });

  await L.step(B, 'Admin sign in again', async () => {
    await page.locator('#f-email').fill(S.admin.email);
    await page.locator('#f-password').fill(S.admin.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/app\/?$/, { timeout: 20000 });
    await L.h1(page);
    const me = await L.api(ctx, 'GET', '/api/auth/me');
    if (me.status !== 200) throw new Error(`/me ${me.status}`);
    S.adminState = path.join(L.ART, 'admin_state.json');
    await ctx.storageState({ path: S.adminState });
    return `signed in, back on ${page.url().replace(L.BASE, '')}`;
  });

  // ── B2: overview ──────────────────────────────────────────────────────────
  await L.step(B, 'Overview page (/app/admin)', async () => {
    await page.getByRole('link', { name: 'Overview' }).click();
    await page.waitForURL(/\/app\/admin$/, { timeout: 10000 });
    const h = await L.h1(page);
    await page.getByText('Collected, all time').waitFor({ timeout: 20000 });
    await page.getByText('The GPU box').waitFor({ timeout: 20000 });
    await L.sleep(1000);
    // textContent, not innerText: the stat labels are uppercased by CSS only
    const body = ((await page.locator('body').textContent()) || '').replace(/\s+/g, ' ');
    const labels = ['Collected, all time', 'Today', 'This week', 'Subscribers', 'Accounts', 'Signed in now', 'Jobs today', 'In flight'];
    const missing = labels.filter((l) => !body.toLowerCase().includes(l.toLowerCase()));
    const aws = (body.match(/AWS says \S+/) || [''])[0];
    const s = await L.shot(page, 'B_overview', true);
    if (missing.length) throw new Error(`missing stat cards: ${missing.join(', ')}`);
    return `h1 "${h}"; all 8 stat cards; GPU card "${aws}" (aws CLI deliberately unavailable to the backend in this run) (${s})`;
  });
  await L.step(B, 'Overview "Manage →" link -> /app/admin/gpu', async () => {
    await page.getByRole('link', { name: /Manage/ }).click();
    await page.waitForURL(/\/app\/admin\/gpu$/, { timeout: 10000 });
    return 'ok';
  });

  // ── B3: GPU page (fake engine) ────────────────────────────────────────────
  await L.step(B, 'GPU page (/app/admin/gpu, nav "Capacity") renders', async () => {
    await L.goto(page, '/app/admin/gpu');
    const h = await L.h1(page, 20000);
    await page.getByText(/Automatic lifecycle is off/).waitFor({ timeout: 20000 });
    const body = await L.text(page, 'main');
    const s = await L.shot(page, 'B_gpu', true);
    return `h1 "${h}"; notice "Automatic lifecycle is off" shown; ${(body.match(/AWS says \S+/) || [''])[0]}; ${
      (body.match(/Engine URL\s*\S+/) || [''])[0]
    } (${s})`;
  });
  await L.step(B, 'GPU "Warm it up" (fake: harmless)', async () => {
    const resp = page.waitForResponse((r) => r.url().includes('/api/admin/gpu/start'));
    await page.getByRole('button', { name: 'Warm it up' }).click();
    const r = await resp;
    const j = await r.json();
    const t = await L.toast(page, /Warming up/);
    return `POST /api/admin/gpu/start -> ${r.status()} ${JSON.stringify(j).slice(0, 160)}; toast "${t.slice(0, 120)}"`;
  });
  await L.step(B, 'GPU "Stop if idle"', async () => {
    const resp = page.waitForResponse((r) => r.url().includes('/api/admin/gpu/stop?force=false'));
    await page.getByRole('button', { name: 'Stop if idle' }).click();
    const r = await resp;
    const j = await r.json();
    const t = await L.toast(page, /Stop requested/);
    return `-> ${r.status()} ${JSON.stringify(j)}; toast "${t.slice(0, 120)}"`;
  });
  await L.step(B, 'GPU "Force stop" — cancelling the confirm sends nothing', async () => {
    let sent = false;
    const onReq = (rq) => {
      if (rq.url().includes('/api/admin/gpu/stop?force=true')) sent = true;
    };
    page.on('request', onReq);
    L.dialogPolicy.set(page, 'dismiss');
    await page.getByRole('button', { name: 'Force stop' }).click();
    await L.sleep(1500);
    page.off('request', onReq);
    if (sent) throw new Error('request sent although the confirm was dismissed');
    return 'confirm dialog shown and dismissed; no request';
  });
  await L.step(B, 'GPU "Force stop" — accepted', async () => {
    L.dialogPolicy.set(page, 'accept');
    const resp = page.waitForResponse((r) => r.url().includes('/api/admin/gpu/stop?force=true'));
    await page.getByRole('button', { name: 'Force stop' }).click();
    const r = await resp;
    const j = await r.json();
    L.dialogPolicy.set(page, 'dismiss');
    const t = await L.toast(page, /Force stopped/);
    S.forceStop = j;
    return {
      note: `-> ${r.status()} ${JSON.stringify(j)}; toast "${t.slice(0, 80)}". NOTE: the handler ran "aws ec2 stop-instances" (rc=${j.rc}) - it only failed because this run removed the aws CLI from the backend's PATH`,
    };
  });

  // ── B4: people ────────────────────────────────────────────────────────────
  await L.step(B, 'People page: users table, audit, sessions', async () => {
    await page.getByRole('link', { name: 'People' }).click();
    await page.waitForURL(/\/app\/admin\/people$/, { timeout: 10000 });
    const h = await L.h1(page);
    await page.getByText(S.admin.email).first().waitFor({ timeout: 15000 });
    const heads = await page.locator('table thead th').allInnerTexts();
    const audit = await page.locator('h2', { hasText: 'Admin audit' }).locator('xpath=ancestor::div[contains(@class,"overflow-hidden")][1]').innerText();
    const sessions = await page.locator('h2', { hasText: 'Who is signed in' }).locator('xpath=ancestor::div[contains(@class,"overflow-hidden")][1]').innerText();
    const s = await L.shot(page, 'B_people', true);
    const row = await page.getByRole('row').filter({ hasText: S.admin.email }).innerText();
    if (!/admin/.test(row)) throw new Error('no admin badge on the admin row');
    return `h1 "${h}"; columns [${heads.map((x) => x.trim()).filter(Boolean).join(', ')}]; admin row "${row.replace(/\s+/g, ' ').slice(0, 120)}"; audit: "${audit
      .replace(/\s+/g, ' ')
      .slice(0, 220)}"; sessions: "${sessions.replace(/\s+/g, ' ').slice(0, 160)}" (${s})`;
  });
  await L.step(B, 'People: search by email', async () => {
    await page.getByLabel('Search accounts').fill('ui-admin');
    const resp = page.waitForResponse((r) => r.url().includes('/api/admin/users?q=ui-admin'));
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await resp;
    await L.sleep(500);
    const n1 = await page.locator('tbody tr').count();
    await page.getByLabel('Search accounts').fill('zz-no-such-person');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByText('No accounts match that').waitFor({ timeout: 10000 });
    await page.getByLabel('Search accounts').fill('');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByText(S.admin.email).first().waitFor({ timeout: 10000 });
    return `"ui-admin" -> ${n1} row(s); nonsense -> "No accounts match that"; cleared -> full list`;
  });

  // ── B5: inbox ─────────────────────────────────────────────────────────────
  await L.step(B, 'Inbox: contact message from area A is listed with DPDP readiness card', async () => {
    await page.getByRole('link', { name: /^Inbox/ }).click();
    await page.waitForURL(/\/app\/admin\/inbox$/, { timeout: 10000 });
    const h = await L.h1(page);
    await page.getByText(S.contactSubject).waitFor({ timeout: 15000 });
    const header = await L.text(page, 'main');
    const s = await L.shot(page, 'B_inbox', true);
    const badges = (header.match(/\d+ unanswered|All clear|\d+ past deadline/g) || []).join(', ');
    const dpdp = (header.match(/DPDP setup is incomplete.{0,90}/) || ['(no DPDP card)'])[0];
    return `h1 "${h}"; header badges: ${badges}; ${dpdp} (${s})`;
  });
  await L.step(B, 'Inbox: open the message, check "Reply by email", mark it "Resolved"', async () => {
    const card = page.getByRole('button', { name: new RegExp(S.contactSubject) });
    await card.click();
    await page.getByText('What was done').waitFor({ timeout: 5000 });
    const mailto = await page.getByRole('link', { name: 'Reply by email' }).getAttribute('href');
    const meta = await L.text(page, 'main');
    await page.locator(`#note-${S.contactId}`).fill('Answered by the UI check');
    const resp = page.waitForResponse((r) => r.url().includes(`/api/admin/inbox/${S.contactId}`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Resolved', exact: true }).click();
    const r = await resp;
    const t = await L.toast(page, /marked resolved/);
    await page.getByText('Nothing here').waitFor({ timeout: 10000 });
    const s = await L.shot(page, 'B_inbox_resolved');
    if (!mailto || !mailto.startsWith(`mailto:${encodeURIComponent(S.contactEmail)}`)) throw new Error(`reply href ${mailto}`);
    return `reply href ${mailto}; meta has "From IP": ${/From IP/.test(meta)}; POST -> ${r.status()}; toast "${t}"; list now "Nothing here" (${s})`;
  });
  await L.step(B, 'Inbox: filters "In progress", "Rights only", "Everything"', async () => {
    const out = [];
    for (const f of ['In progress', 'Rights only', 'Everything']) {
      await page.getByRole('button', { name: f, exact: true }).click();
      await L.sleep(1200);
      const pressed = await page.getByRole('button', { name: f, exact: true }).getAttribute('aria-pressed');
      const body = await L.text(page, 'main');
      out.push(`${f}: pressed=${pressed} ${body.includes(S.contactSubject) ? 'shows the message' : body.includes('Nothing here') ? '"Nothing here"' : '?'}`);
    }
    if (!out[2].includes('shows the message')) throw new Error(out.join('; '));
    return out.join('; ');
  });

  // ── B6: system ────────────────────────────────────────────────────────────
  await L.step(B, 'System page: maintenance + SEO cards and the six tabs', async () => {
    await page.getByRole('link', { name: 'System' }).click();
    await page.waitForURL(/\/app\/admin\/system$/, { timeout: 10000 });
    const h = await L.h1(page);
    await page.getByText('Maintenance mode').waitFor({ timeout: 15000 });
    const tabs = await page.getByRole('tab').allInnerTexts();
    const seo = await L.text(page, 'main');
    const s = await L.shot(page, 'B_system', true);
    return `h1 "${h}"; tabs [${tabs.join(', ')}]; SEO: ${(seo.match(/Search engines\s*(Indexable|Blocked)/) || ['?'])[0]}; ${
      (seo.match(/PUBLIC_BASE_URL is not https[^.]*\./) || [''])[0]
    } (${s})`;
  });
  const TABS = [
    ['Storage', /Delivering from (local disk|Cloudflare R2)/],
    ['Outbox', /Outbox/],
    ['Rate limits', /What the rate limiter enforces/],
    ['Preset', /The pinned pipeline preset/],
    ['Portability', /Could this move to another AWS account/],
    ['Database', /The database/],
  ];
  for (const [tab, re] of TABS) {
    await L.step(B, `System tab "${tab}"`, async () => {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const panel = page.getByRole('tabpanel');
      await panel.getByText(re).first().waitFor({ timeout: 10000 });
      const sel = await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected');
      const t = (await panel.innerText()).replace(/\s+/g, ' ');
      const s = await L.shot(page, `B_tab_${tab}`, true);
      let extra = '';
      if (tab === 'Outbox') {
        if (!t.includes(S.contactEmail)) throw new Error('contact_ack mail to the contact address not in the outbox table');
        extra = ` rows: ${(t.match(/contact_ack|verify_email|password_reset/g) || []).length}; backend badge ${(t.match(/Outbox\s*(\w+)/) || [])[1]}`;
      }
      if (tab === 'Rate limits') extra = ` e.g. ${(t.match(/login\s*\d+ per [^a-z]*\w+/) || [''])[0]}`;
      if (tab === 'Storage') extra = ` ${(t.match(/Switched on\s*\w+/) || [''])[0]}; ${(t.match(/Local output directory\s*\S+/) || [''])[0]}`;
      return `aria-selected=${sel};${extra} "${t.slice(0, 160)}" (${s})`;
    });
  }
  await L.step(B, 'Portability: "Write a migration archive"', async () => {
    await page.getByRole('tab', { name: 'Portability', exact: true }).click();
    const resp = page.waitForResponse((r) => r.url().includes('/api/admin/export') && r.request().method() === 'POST', { timeout: 60000 });
    await page.getByRole('button', { name: 'Write a migration archive' }).click();
    const r = await resp;
    const j = await r.json().catch(() => ({}));
    const t = await L.toast(page, /Archive written|Export failed|failed/i, 30000);
    const archive = j.archive || '';
    const inside = archive && fs.existsSync(archive) ? fs.readdirSync(archive) : [];
    S.exportArchive = archive;
    if (r.status() !== 200) throw new Error(`export ${r.status()} ${JSON.stringify(j).slice(0, 200)} toast "${t}"`);
    if (!archive.toLowerCase().startsWith(path.join(L.ART, 'export').toLowerCase())) throw new Error(`archive landed outside VS_EXPORT_ROOT: ${archive}`);
    return `-> ${r.status()}; toast "${t.slice(0, 140)}"; archive has [${inside.join(', ')}]`;
  });
  await L.step(B, 'SEO card: "robots.txt" and "sitemap.xml" buttons open the generated files', async () => {
    const out = [];
    for (const name of ['robots.txt', 'sitemap.xml']) {
      const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), page.getByRole('button', { name, exact: true }).click()]);
      await pop.waitForLoadState('domcontentloaded');
      const t = (await pop.content()).replace(/\s+/g, ' ');
      out.push(`${name}: ${pop.url().replace(L.BASE, '')} "${t.replace(/<[^>]+>/g, ' ').trim().slice(0, 80)}"`);
      await pop.close();
    }
    return out.join('; ');
  });

  // ── B7: maintenance mode ──────────────────────────────────────────────────
  S.maintNote = `UI check maintenance ${S.stamp}`;
  await L.step(B, 'Maintenance: "Take the site offline" -> note -> "Take it offline now"', async () => {
    await page.getByRole('button', { name: 'Take the site offline' }).click();
    await page.locator('#maint-note').fill(S.maintNote);
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/admin/maintenance') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Take it offline now' }).click();
    const r = await resp;
    const t = await L.toast(page, /maintenance mode/);
    await page.getByText('Site is off').waitFor({ timeout: 10000 });
    const s = await L.shot(page, 'B_maint_on');
    return `POST -> ${r.status()}; toast "${t.slice(0, 120)}"; badge "Site is off" (${s})`;
  });
  await L.step(B, 'Maintenance: the admin still sees the real site', async () => {
    const p2 = await ctx.newPage();
    try {
      await L.goto(p2, '/pricing');
      const h = await L.h1(p2, 30000);
      if (!/Pay for minutes/.test(h)) throw new Error(`admin sees "${h}"`);
      return `admin tab on /pricing shows "${h}"`;
    } finally {
      await p2.close();
    }
  });
  await L.step(
    B,
    'Maintenance: a separate signed-out browser sees the maintenance page',
    async () => {
      const anon = await L.newContext(browser, 'anon-maint');
      const p = await L.newPage(anon);
      try {
        const site = await L.api(anon, 'GET', '/api/site');
        const plans = await L.api(anon, 'GET', '/api/billing/plans');
        await L.goto(p, '/');
        await L.sleep(6000);
        const html = await p.evaluate(() => document.getElementById('root')?.innerHTML.length ?? -1);
        const h = await p.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '(no h1)');
        const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200);
        const s = await L.shot(p, 'B_maint_anon');
        const note = `/api/site maintenance=${site.body.maintenance} note="${site.body.note}"; /api/billing/plans -> ${plans.status} ${JSON.stringify(plans.body).slice(0, 120)}; page h1 "${h}", #root innerHTML length ${html}, body "${body}" (${s})`;
        if (!/We are making some changes/.test(h) || !body.includes(S.maintNote)) return { status: 'FAIL', note: `maintenance page NOT shown: ${note}` };
        return note;
      } finally {
        await anon.close();
      }
    },
    { allow: [{ kind: 'response', status: 503 }, { kind: 'console', text: /status of 503/ }] },
  );
  await L.step(B, 'Maintenance: "Bring the site back"', async () => {
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/admin/maintenance') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Bring the site back' }).click();
    const r = await resp;
    const t = await L.toast(page, /public again/);
    await page.getByText('Live', { exact: true }).waitFor({ timeout: 10000 });
    const anon = await L.newContext(browser, 'anon-after');
    const p = await L.newPage(anon);
    try {
      await L.goto(p, '/');
      const h = await L.h1(p, 30000);
      return `POST -> ${r.status()}; toast "${t}"; signed-out visitor sees "${h.replace(/\s+/g, ' ')}" again`;
    } finally {
      await anon.close();
    }
  });

  // ── B8: the database browser ──────────────────────────────────────────────
  let db = null;
  await L.step(B, 'Database tab "Open the browser" opens /db in a new tab', async () => {
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), page.getByRole('button', { name: 'Open the browser' }).click()]);
    db = pop;
    await db.waitForLoadState('domcontentloaded');
    await db.locator('#tables a').first().waitFor({ timeout: 15000 });
    const tables = await db.locator('#tables a span').allInnerTexts();
    const file = await db.locator('#dbfile').innerText();
    const s = await L.shot(db, 'B_db_home');
    return `${db.url().replace(L.BASE, '')}: ${tables.length} tables; file "${file.trim()}" (${s})`;
  });
  await L.step(B, '/db: open the users table — password hashes hidden', async () => {
    if (!db) throw new Error('no /db tab');
    await db.locator('#t_users').click();
    await db.locator('#out table').waitFor({ timeout: 10000 });
    const r = await db.evaluate(() => {
      const ths = [...document.querySelectorAll('#out th')].map((t) => t.textContent);
      const idx = ths.indexOf('password_hash');
      const vals = [...document.querySelectorAll('#out tbody tr')].map((tr) => tr.children[idx] && tr.children[idx].textContent);
      return { ths, idx, vals, title: document.getElementById('title').textContent };
    });
    const s = await L.shot(db, 'B_db_users');
    if (r.idx < 0) throw new Error(`no password_hash column (${r.ths.join(',')})`);
    if (!r.vals.every((v) => v === '<hidden>')) throw new Error(`password_hash values not hidden: ${JSON.stringify(r.vals)}`);
    return `"${r.title}"; password_hash shown as ${JSON.stringify([...new Set(r.vals)])} (${s})`;
  });
  await L.step(B, '/db: "next →" / "← prev" paging buttons', async () => {
    await db.getByRole('button', { name: /next/ }).click();
    await L.sleep(800);
    await db.getByRole('button', { name: /prev/ }).click();
    await L.sleep(800);
    const err = (await db.locator('#err').innerText()).trim();
    if (err) throw new Error(err);
    return `paging info "${(await db.locator('#pageinfo').innerText()).trim()}"`;
  });
  await L.step(
    B,
    '/db: type a SELECT and press "Run SELECT"',
    async () => {
      await db.locator('#sql').fill('SELECT id, email, role, password_hash FROM users');
      const resp = db.waitForResponse((r) => r.url().endsWith('/api/admin/db/query'));
      await db.getByRole('button', { name: 'Run SELECT' }).click();
      const r = await resp;
      await L.sleep(600);
      const err = (await db.locator('#err').innerText()).trim();
      const title = (await db.locator('#title').innerText()).trim();
      const s = await L.shot(db, 'B_db_query');
      if (r.status() !== 200 || err) return { status: 'FAIL', note: `POST /api/admin/db/query -> ${r.status()}; page shows error "${err}" (title "${title}") (${s})` };
      return `-> 200 "${title}" (${s})`;
    },
    { allow: [{ kind: 'response', status: 403, url: /\/api\/admin\/db\/query$/ }, { kind: 'console', text: /status of 403/, url: /\/api\/admin\/db\/query$/ }] },
  );
  await L.step(B, '/db query API with the CSRF header (what the page should send): SELECT works, hashes masked, writes refused', async () => {
    const q1 = await L.api(ctx, 'POST', '/api/admin/db/query', { json: { sql: 'SELECT id, email, role, password_hash FROM users' } });
    const q2 = await L.api(ctx, 'POST', '/api/admin/db/query', { json: { sql: 'SELECT password_hash AS h FROM users' } });
    const q3 = await L.api(ctx, 'POST', '/api/admin/db/query', { json: { sql: 'DELETE FROM sessions WHERE 1=0' } });
    const hashes = (q1.body.rows || []).map((r) => r.password_hash);
    const aliased = (q2.body.rows || []).map((r) => r.h);
    const ok =
      q1.status === 200 &&
      hashes.every((h) => h === '<hidden>' || h === null) &&
      aliased.every((h) => h === null || h === '<hidden>') &&
      q3.status >= 400;
    return {
      status: ok ? 'PASS' : 'FAIL',
      note: `SELECT -> ${q1.status}, password_hash ${JSON.stringify([...new Set(hashes)])}; aliased -> ${q2.status} ${JSON.stringify([...new Set(aliased)])}; DELETE -> ${q3.status} "${JSON.stringify(q3.body).slice(0, 100)}"`,
    };
  });
  await L.step(B, '/db: "back to the app" link', async () => {
    await db.getByRole('link', { name: 'back to the app' }).click();
    await db.waitForURL(L.BASE + '/', { timeout: 10000 });
    await L.h1(db, 30000);
    await db.close();
    return '-> / (the public homepage, not the dashboard)';
  });

  // ── B9: admin features the API has but the admin UI does not ─────────────
  const noUi = [
    ['Signups by address', 'GET', '/api/admin/signups?hours=168&min_accounts=1'],
    ['Access log', 'GET', '/api/admin/access-log?limit=50'],
    ['User consent record', 'GET', `/api/admin/users/${S.admin.id}/consent`],
    ["A user's jobs", 'GET', `/api/admin/users/${S.admin.id}/jobs`],
    ['Billing admin', 'GET', '/api/admin/billing?limit=20'],
    ['Billing sweep', 'POST', '/api/admin/billing/sweep'],
  ];
  for (const [what, method, url] of noUi) {
    await L.step(B, `${what} — admin UI control`, async () => {
      const r = await L.api(ctx, method, url);
      const summary = JSON.stringify(r.body).slice(0, 200);
      return {
        status: 'FAIL',
        note: `No page or button in the React admin (/app/admin/*) reaches ${method} ${url.split('?')[0]}; API itself -> ${r.status} ${summary}`,
      };
    });
  }
  await L.step(B, 'DPDP readiness (Inbox card + /api/admin/dpdp)', async () => {
    const r = await L.api(ctx, 'GET', '/api/admin/dpdp');
    const failing = (r.body.checks || []).filter((c) => !c.ok).map((c) => c.item);
    return `-> ${r.status} ready=${r.body.ready}; failing: ${failing.join('; ')}`;
  });
  await L.step(B, 'Backend operator page (http://127.0.0.1:8096/) "Billing" view — only UI for billing admin', async () => {
    const p = await ctx.newPage();
    try {
      await p.goto(L.BACKEND + '/', { waitUntil: 'domcontentloaded' });
      await p.getByRole('button', { name: 'Billing', exact: true }).click();
      await L.sleep(2000);
      const t = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
      const s = await L.shot(p, 'B_operator_billing', true);
      return `operator console "${(await p.title()).trim()}" loads; after "Billing": ${/subscriptions|payments|provider/i.test(t) ? 'billing data rendered' : 'no billing data visible'} (${s})`;
    } finally {
      await p.close();
    }
  }, { noiseOk: true });

  await ctx.storageState({ path: S.adminState });
  await ctx.close();
}

module.exports = { run };
