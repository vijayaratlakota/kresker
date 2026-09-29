'use strict';
/*
  AREA B re-checks: three steps whose first run failed because of the TEST SCRIPT
  (checked a lazy page before its chunk arrived; compared CSS-uppercased text; counted
  the product's own confirm() dialog as an error). Same account, same database.
*/
const L = require('./lib');

const B = 'B admin';

async function run(browser, S) {
  const ctx = await L.newContext(browser, 'admin', { storageState: S.adminState });
  const page = await L.newPage(ctx);

  await L.step(B, 'Admin signup through the UI (first account) lands on the dashboard (re-check)', async () => {
    await L.goto(page, '/app');
    await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
    await L.dismissBanner(page);
    const missing = [];
    for (const n of ['Dubbing', 'Library', 'Plan & billing', 'Your data', 'Overview', 'Capacity', 'People', /^Inbox/, 'System'])
      if (!(await page.getByRole('link', { name: n }).first().isVisible())) missing.push(String(n));
    const side = ((await page.locator('body').textContent()) || '').replace(/\s+/g, ' ');
    const s = await L.shot(page, 'B_admin_dashboard');
    if (missing.length) throw new Error(`nav items missing: ${missing.join(', ')}`);
    return `first signup (register 200, role=admin, auto-confirmed) went straight to /app; dashboard h1 "Dubbing", customer + admin nav all present; sidebar "${(side.match(/\d+\.\d\d of \d+ min left/) || [''])[0]}" (${s})`;
  });

  await L.step(B, 'Overview page (/app/admin) (re-check)', async () => {
    await page.getByRole('link', { name: 'Overview' }).click();
    await page.waitForURL(/\/app\/admin$/, { timeout: 10000 });
    await page.getByText('The GPU box').waitFor({ timeout: 20000 });
    await L.sleep(1000);
    const body = ((await page.locator('body').textContent()) || '').replace(/\s+/g, ' ');
    const labels = ['Collected, all time', 'Today', 'This week', 'Subscribers', 'Accounts', 'Signed in now', 'Jobs today', 'In flight'];
    const missing = labels.filter((l) => !body.toLowerCase().includes(l.toLowerCase()));
    const s = await L.shot(page, 'B_overview_recheck', true);
    if (missing.length) throw new Error(`missing stat cards: ${missing.join(', ')}`);
    return `all 8 stat cards present; GPU card "${(body.match(/AWS says \S+/) || [''])[0]}" (aws CLI unavailable to the backend by design of this run) (${s})`;
  });

  await L.goto(page, '/app/admin/gpu');
  await L.h1(page, 20000);
  await page.getByRole('button', { name: 'Force stop' }).waitFor({ timeout: 20000 });

  await L.step(B, 'GPU "Force stop" — cancelling the confirm sends nothing (re-check)', async () => {
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
    return 'confirm() shown ("Force stop ignores every safety condition…"), dismissed, no request sent';
  });

  await L.step(B, 'GPU "Force stop" — accepted (re-check)', async () => {
    L.dialogPolicy.set(page, 'accept');
    const resp = page.waitForResponse((r) => r.url().includes('/api/admin/gpu/stop?force=true'));
    await page.getByRole('button', { name: 'Force stop' }).click();
    const r = await resp;
    const j = await r.json();
    L.dialogPolicy.set(page, 'dismiss');
    const t = await L.toast(page, /Force stopped/);
    // The UI reports success whatever rc says, and in the environment the task specified
    // (aws on PATH) this request runs `aws ec2 stop-instances` against the real GPU box.
    return {
      status: 'FAIL',
      note: `POST /api/admin/gpu/stop?force=true -> ${r.status()} ${JSON.stringify(j)}; toast "${t.slice(0, 60)}" although rc=${j.rc} (nothing stopped). The handler calls the AWS CLI unconditionally (fake engine, VS_GPU_AUTO=0) - it could not reach AWS only because this run hid the aws CLI from the backend`,
    };
  });

  await ctx.storageState({ path: S.adminState });
  await ctx.close();
}

module.exports = { run };
