'use strict';
/*
  AREA D — back as admin: the customer's job in admin, refund, and a third throwaway
  account for grant / block / allow / stop plan / suspend / unsuspend / end session.
  Runs BEFORE the customer erases their account (area C2), so the job still exists.
*/
const path = require('path');
const L = require('./lib');

const D = 'D admin actions';

async function peopleRow(page, email) {
  await L.goto(page, '/app/admin/people');
  await page.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Search accounts').fill(email);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: email });
  await row.waitFor({ timeout: 10000 });
  await L.sleep(400);
  return row;
}

async function run(browser, S) {
  const U = S.user;
  S.third = S.third || { email: `ui-third-${S.stamp}@example.com`, password: `Ui-Third-${S.stamp}-pw` };
  const T = S.third;
  const ctx = await L.newContext(browser, 'admin', { storageState: S.adminState });
  const page = await L.newPage(ctx);
  const userCtx = await L.newContext(browser, 'user', { storageState: S.userState });

  // ── the customer's job, seen from admin ──────────────────────────────────
  await L.step(D, "Customer's account and dub show in admin People (Dubs, minutes)", async () => {
    const row = await peopleRow(page, U.email);
    const t = (await row.innerText()).replace(/\s+/g, ' ');
    const s = await L.shot(page, 'D_people_user');
    if (!/\b1\b/.test(t)) throw new Error(`row "${t}"`);
    return `row "${t.slice(0, 160)}" (${s})`;
  });
  await L.step(D, 'Overview "Jobs today" counts the dub', async () => {
    await L.goto(page, '/app/admin');
    await page.getByText('The GPU box').waitFor({ timeout: 20000 });
    await L.sleep(1500);
    const ov = await L.api(ctx, 'GET', '/api/admin/overview');
    if (!(ov.body.jobs_today >= 1)) throw new Error(`jobs_today=${ov.body.jobs_today}`);
    return `jobs_today=${ov.body.jobs_today}, users=${ov.body.users}`;
  });
  await L.step(D, "Customer's jobs list — admin UI control", async () => {
    const r = await L.api(ctx, 'GET', `/api/admin/users/${U.id}/jobs`);
    const j = (r.body.jobs || []).find((x) => x.job_id === U.jobId);
    return {
      status: 'FAIL',
      note: `No UI: nothing in /app/admin/* lists a user's jobs (api.admin.userJobs is never called). API -> ${r.status}: ${
        j ? `job ${j.job_id} state=${j.state} charged=${j.minutes_charged ?? j.charged} refundable=${j.refundable} video "${j.video_name}"` : 'job NOT listed'
      }`,
    };
  });
  await L.step(D, 'Refund button on the customer\'s job (password re-entry)', async () => {
    const b = await page.getByRole('button', { name: /refund/i }).count();
    return {
      status: 'FAIL',
      note: `No refund button anywhere in the admin UI (${b} matching buttons on the page; api.admin.refund has no caller). Tested the endpoint directly in the next row.`,
    };
  });
  await L.step(D, 'Refund via API: wrong password refused, right password refunds, second refund refused', async () => {
    const before = (await L.api(userCtx, 'GET', '/api/auth/me')).body.entitlement;
    const bad = await L.api(ctx, 'POST', `/api/admin/jobs/${U.jobId}/refund`, { json: { reason: 'UI check refund', password: 'wrong-password-x' } });
    const good = await L.api(ctx, 'POST', `/api/admin/jobs/${U.jobId}/refund`, { json: { reason: 'UI check refund', password: S.admin.password } });
    const again = await L.api(ctx, 'POST', `/api/admin/jobs/${U.jobId}/refund`, { json: { reason: 'UI check refund', password: S.admin.password } });
    const after = (await L.api(userCtx, 'GET', '/api/auth/me')).body.entitlement;
    const up = await L.newPage(userCtx);
    await L.goto(up, '/app');
    await up.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
    await L.sleep(800);
    const side = (((await up.locator('body').textContent()) || '').match(/\d+\.\d\d of \d+ min left/) || [''])[0];
    const s = await L.shot(up, 'D_user_after_refund');
    await up.close();
    const ok = bad.status === 403 && good.status === 200 && again.status === 409 && Math.abs(after.minutes_left - 1) < 0.01;
    return {
      status: ok ? 'PASS' : 'FAIL',
      note: `wrong pw -> ${bad.status} "${bad.body.detail}"; right pw -> ${good.status} ${JSON.stringify(good.body)}; again -> ${again.status} "${again.body.detail}"; customer minutes_left ${before.minutes_left.toFixed(3)} -> ${after.minutes_left.toFixed(3)}, their sidebar "${side}" (${s})`,
    };
  });

  // ── a third throwaway account ─────────────────────────────────────────────
  const tctx = await L.newContext(browser, 'third');
  const tp = await L.newPage(tctx);
  await L.step(D, 'Third throwaway account: sign up + confirm from the outbox', async () => {
    const t0 = Date.now() - 1500;
    await L.goto(tp, '/signup');
    await L.h1(tp, 30000);
    await L.dismissBanner(tp);
    await tp.locator('#f-email').fill(T.email);
    await tp.locator('#f-password').fill(T.password);
    const resp = tp.waitForResponse((r) => r.url().endsWith('/api/auth/register'));
    await tp.getByRole('button', { name: 'Sign up', exact: true }).click();
    T.id = (await (await resp).json()).id;
    await tp.getByRole('heading', { level: 1, name: 'Check your inbox' }).waitFor({ timeout: 15000 });
    const mail = await L.waitMail(T.email, 'verify_email', { after: t0 });
    const link = L.linkIn(mail.text, '/verify').hit;
    await L.goto(tp, link);
    const landed = await tp
      .waitForURL(/\/app\/?$/, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    const me = await L.api(tctx, 'GET', '/api/auth/me');
    if (me.status !== 200) throw new Error(`not signed in after the link (${me.status})`);
    if (!landed) await L.goto(tp, '/app');
    await tp.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
    return `user #${T.id} confirmed via ${mail.file}; ${landed ? 'landed in /app' : 'confirm page hung on "Checking that link…" again (see C) - opened /app by hand, session was valid'}`;
  });

  await L.step(D, 'Grant plan dialog: wrong password shows an error, right password grants Starter', async () => {
    const row = await peopleRow(page, T.email);
    await row.getByRole('button', { name: 'Grant plan' }).click();
    const dlg = page.getByRole('dialog', { name: 'Grant a subscription' });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.locator('select').selectOption('starter');
    await dlg.locator('input[type="number"]').fill('1');
    await dlg.getByLabel('Reason').fill('UI check grant');
    await dlg.getByLabel('Your password').fill('wrong-password-x');
    await dlg.getByRole('button', { name: 'Grant', exact: true }).click();
    const err = await dlg.getByRole('alert').innerText({ timeout: 10000 });
    const s1 = await L.shot(page, 'D_grant_wrong_pw');
    await dlg.getByLabel('Your password').fill(S.admin.password);
    const resp = page.waitForResponse((r) => r.url().endsWith(`/api/admin/users/${T.id}/grant`) && r.status() === 200);
    await dlg.getByRole('button', { name: 'Grant', exact: true }).click();
    await resp;
    const t = await L.toast(page, /is on starter/);
    await dlg.waitFor({ state: 'hidden', timeout: 10000 });
    const row2 = (await page.getByRole('row').filter({ hasText: T.email }).innerText()).replace(/\s+/g, ' ');
    const s2 = await L.shot(page, 'D_granted');
    return `wrong pw -> error "${err.trim()}" (${s1}); right pw -> toast "${t.slice(0, 110)}"; row now "${row2.slice(0, 140)}" (${s2})`;
  }, { allow: [{ kind: 'response', status: 403, url: /\/grant$/ }, { kind: 'console', text: /status of 403/, url: /\/grant$/ }] });
  await L.step(D, 'Third account sees the granted plan (sidebar + billing page)', async () => {
    await L.goto(tp, '/app');
    await tp.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
    await L.sleep(800);
    const side = (((await tp.locator('body').textContent()) || '').match(/\d+\.\d\d of \d+ min left/) || [''])[0];
    await L.goto(tp, '/app/billing');
    await tp.getByRole('heading', { level: 1, name: 'Plan & billing' }).waitFor({ timeout: 20000 });
    await tp.getByRole('heading', { level: 2, name: 'Starter' }).waitFor({ timeout: 15000 });
    const body = ((await tp.locator('main').textContent()) || '').replace(/\s+/g, ' ');
    const s = await L.shot(tp, 'D_third_billing', true);
    return `sidebar "${side}"; billing: ${/Active/.test(body) ? 'Active' : '?'}${/Does not renew/.test(body) ? ' + "Does not renew"' : ''}; top-ups ${
      /Add minutes|Add \d+ minutes/.test(body) ? 'picker offered' : 'no picker'
    } (${s})`;
  });
  await L.step(D, 'Third account: buy a top-up pack (test mode, nothing charged)', async () => {
    const card = tp.locator('h2', { hasText: 'Topup Extra minutes' }).locator('xpath=ancestor::div[contains(@class,"p-5")][1]');
    const trigger = card.getByRole('combobox').first();
    if (!(await trigger.count())) {
      const t = (await card.innerText()).replace(/\s+/g, ' ');
      return { note: `no pack picker for this account: "${t.slice(0, 200)}"` };
    }
    await trigger.click();
    const opt = tp.getByRole('option').first();
    await opt.waitFor({ timeout: 5000 });
    const label = (await opt.innerText()).replace(/\s+/g, ' ');
    await opt.click();
    const buy = card.getByRole('button', { name: /^Add \d+ minutes/ });
    const resp = tp.waitForResponse((r) => r.url().endsWith('/api/billing/topup'));
    await buy.click();
    const r = await resp;
    const j = await r.json().catch(() => ({}));
    const t = await L.toast(tp, /Nothing to pay|payment page|not open/i);
    const me = await L.api(tctx, 'GET', '/api/auth/me');
    return `picked "${label.slice(0, 40)}"; POST /api/billing/topup -> ${r.status()} live=${j.live} url=${j.checkout_url}; toast "${t.slice(0, 120)}"; extra minutes now ${me.body.entitlement.minutes_topup_left}`;
  });

  await L.step(D, '"Block buying" (password) -> badge "no buying" and the account cannot buy', async () => {
    const row = await peopleRow(page, T.email);
    await row.getByRole('button', { name: 'Block buying' }).click();
    const dlg = page.getByRole('dialog', { name: 'Block this account from buying' });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.getByLabel('Reason').fill('UI check block');
    await dlg.getByLabel('Your password').fill(S.admin.password);
    await dlg.getByRole('button', { name: 'Block buying' }).click();
    const t = await L.toast(page, /cannot buy anything/);
    await dlg.waitFor({ state: 'hidden', timeout: 10000 });
    const row2 = (await page.getByRole('row').filter({ hasText: T.email }).innerText()).replace(/\s+/g, ' ');
    const plans = await L.api(tctx, 'GET', '/api/billing/plans');
    const co = await L.api(tctx, 'POST', '/api/billing/checkout', { json: { plan_code: 'creator' } });
    await L.goto(tp, '/app/billing');
    await tp.getByRole('heading', { level: 1, name: 'Plan & billing' }).waitFor({ timeout: 20000 });
    await tp.getByRole('heading', { level: 3, name: 'Creator' }).waitFor({ timeout: 15000 });
    const btn = (await tp.getByRole('heading', { level: 3, name: 'Creator' }).locator('xpath=ancestor::div[contains(@class,"flex-col")][1]').getByRole('button').innerText()).trim();
    const s = await L.shot(tp, 'D_third_blocked', true);
    if (!/no buying/.test(row2) || co.status !== 403) throw new Error(`row "${row2}" checkout ${co.status}`);
    return `toast "${t.slice(0, 90)}"; row "${row2.slice(0, 120)}"; their plans.open=${plans.body.open}; their checkout -> ${co.status} "${co.body.detail}"; Creator card button "${btn}" (${s})`;
  });
  await L.step(D, '"Allow buying" (password) lifts the block', async () => {
    const row = await peopleRow(page, T.email);
    await row.getByRole('button', { name: 'Allow buying' }).click();
    const dlg = page.getByRole('dialog', { name: 'Let this account buy again' });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.getByLabel('Reason').fill('UI check allow');
    await dlg.getByLabel('Your password').fill(S.admin.password);
    await dlg.getByRole('button', { name: 'Allow buying' }).click();
    const t = await L.toast(page, /can buy again/);
    await dlg.waitFor({ state: 'hidden', timeout: 10000 });
    const plans = await L.api(tctx, 'GET', '/api/billing/plans');
    return `toast "${t.slice(0, 90)}"; their plans.open=${plans.body.open}`;
  });
  await L.step(D, '"Stop plan" (password, at renewal) then again with "End it now"', async () => {
    let row = await peopleRow(page, T.email);
    await row.getByRole('button', { name: 'Stop plan' }).click();
    let dlg = page.getByRole('dialog', { name: 'Stop this subscription' });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.getByLabel('Reason').fill('UI check stop at renewal');
    await dlg.getByLabel('Your password').fill(S.admin.password);
    await dlg.getByRole('button', { name: 'Stop the plan' }).click();
    const t1 = await L.toast(page, /starter stopped/);
    await dlg.waitFor({ state: 'hidden', timeout: 10000 });
    row = await peopleRow(page, T.email);
    const mid = (await row.innerText()).replace(/\s+/g, ' ');
    await row.getByRole('button', { name: 'Stop plan' }).click();
    dlg = page.getByRole('dialog', { name: 'Stop this subscription' });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.getByRole('checkbox').check();
    await dlg.getByLabel('Reason').fill('UI check end now');
    await dlg.getByLabel('Your password').fill(S.admin.password);
    await dlg.getByRole('button', { name: 'Stop the plan' }).click();
    const t2 = await L.toast(page, /Access ended now/);
    await dlg.waitFor({ state: 'hidden', timeout: 10000 });
    row = await peopleRow(page, T.email);
    const end = (await row.innerText()).replace(/\s+/g, ' ');
    const me = await L.api(tctx, 'GET', '/api/auth/me');
    return `at renewal: toast "${t1.slice(0, 100)}", row "${mid.slice(0, 90)}"; end now: toast "${t2.slice(0, 100)}", row "${end.slice(0, 90)}"; their plan now ${me.body.entitlement.plan_name}`;
  });

  await L.step(D, 'Suspend / unsuspend — admin UI control', async () => {
    const row = await peopleRow(page, T.email);
    const n = await row.getByRole('button', { name: /suspend/i }).count();
    return {
      status: 'FAIL',
      note: `No suspend or unsuspend button in the admin UI (${n} on the account row; there is no api.admin.suspend at all - only a read-only "suspended" badge). Tested the endpoints directly in the next row.`,
    };
  });
  await L.step(
    D,
    'Suspend via API signs the account out and blocks sign-in; admin row shows "suspended"; unsuspend restores sign-in',
    async () => {
      const bad = await L.api(ctx, 'POST', `/api/admin/users/${T.id}/suspend`, { json: { reason: 'UI check suspend', password: 'wrong-password-x' } });
      const sus = await L.api(ctx, 'POST', `/api/admin/users/${T.id}/suspend`, { json: { reason: 'UI check suspend', password: S.admin.password } });
      const self = await L.api(ctx, 'POST', `/api/admin/users/${S.admin.id}/suspend`, { json: { reason: 'UI check self', password: S.admin.password } });
      const me = await L.api(tctx, 'GET', '/api/auth/me');
      const row = await peopleRow(page, T.email);
      const rowT = (await row.innerText()).replace(/\s+/g, ' ');
      const s1 = await L.shot(page, 'D_suspended_row');
      await L.goto(tp, '/login');
      await L.h1(tp);
      await tp.locator('#f-email').fill(T.email);
      await tp.locator('#f-password').fill(T.password);
      await tp.getByRole('button', { name: 'Sign in', exact: true }).click();
      const msg = await tp.getByRole('alert').innerText({ timeout: 10000 });
      const s2 = await L.shot(tp, 'D_suspended_login');
      const un = await L.api(ctx, 'POST', `/api/admin/users/${T.id}/unsuspend`, { json: { reason: 'UI check unsuspend', password: S.admin.password } });
      const ok = bad.status === 403 && sus.status === 200 && self.status === 400 && me.status === 401 && /suspended/.test(rowT) && /suspended/.test(msg) && un.status === 200;
      return {
        status: ok ? 'PASS' : 'FAIL',
        note: `wrong pw -> ${bad.status}; suspend -> ${sus.status} sessions_revoked=${sus.body.sessions_revoked}; self-suspend -> ${self.status} "${self.body.detail}"; their /me -> ${me.status}; row "${rowT.slice(0, 80)}" (${s1}); their sign-in -> "${msg.trim()}" (${s2}); unsuspend -> ${un.status} "${un.body.note}"`,
      };
    },
    {
      allow: [
        { kind: 'response', status: 403, url: /\/api\/auth\/login$/ },
        { kind: 'console', text: /status of 403/, url: /\/api\/auth\/login$/ },
        { kind: 'response', status: 401, url: /\/api\/(jobs|health|privacy|billing)/ },
      ],
    },
  );
  await L.step(D, 'After unsuspend the account can sign in again (login with ?next=//example.org/… stays on-site)', async () => {
    await L.goto(tp, '/login?next=%2F%2Fexample.org%2Fui-check');
    await L.h1(tp);
    await tp.locator('#f-email').fill(T.email);
    await tp.locator('#f-password').fill(T.password);
    await tp.getByRole('button', { name: 'Sign in', exact: true }).click();
    await L.sleep(3000);
    const at = tp.url();
    const me = await L.api(tctx, 'GET', '/api/auth/me');
    const s = await L.shot(tp, 'D_login_next');
    if (me.status !== 200) throw new Error(`sign-in failed (${me.status})`);
    const offsite = !at.startsWith(L.BASE);
    return { status: offsite ? 'FAIL' : 'PASS', note: `signed in (/me 200); after login the browser is at ${at.replace(L.BASE, '')}${offsite ? ' - OFF-SITE REDIRECT' : ' (on-site)'} (${s})` };
  });
  await L.step(D, 'People "Who is signed in" -> "End" signs that session out', async () => {
    await L.goto(page, '/app/admin/people');
    await page.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 20000 });
    const li = page.locator('li').filter({ hasText: T.email }).filter({ has: page.getByRole('button', { name: 'End' }) }).first();
    await li.waitFor({ timeout: 10000 });
    await li.getByRole('button', { name: 'End' }).click();
    const t = await L.toast(page, /Session ended/);
    const me = await L.api(tctx, 'GET', '/api/auth/me');
    await L.goto(tp, '/app');
    await tp.waitForURL(/\/login/, { timeout: 15000 });
    if (me.status !== 401) throw new Error(`their /me after End = ${me.status}`);
    return `toast "${t}"; their /me -> 401; their /app now redirects to ${tp.url().replace(L.BASE, '')}`;
  });
  await L.step(D, 'Admin audit card records every action above', async () => {
    await L.goto(page, '/app/admin/people');
    await page.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 20000 });
    await page.getByText('grant_subscription').first().waitFor({ timeout: 10000 });
    const card = await page.locator('h2', { hasText: 'Admin audit' }).locator('xpath=ancestor::div[contains(@class,"overflow-hidden")][1]').innerText();
    const want = ['grant_subscription', 'block_purchases', 'allow_purchases', 'cancel_subscription', 'refund_minutes', 'suspend_user', 'unsuspend_user', 'revoke_session', 'maintenance_on', 'maintenance_off', 'gpu_force_stop'];
    const missing = want.filter((w) => !card.includes(w));
    const s = await L.shot(page, 'D_audit', true);
    if (missing.length) throw new Error(`missing in audit card: ${missing.join(', ')}`);
    return `all ${want.length} action kinds present (${s})`;
  });

  await tctx.close();
  await userCtx.close();
  await ctx.storageState({ path: S.adminState });
  await ctx.close();
}

module.exports = { run };
