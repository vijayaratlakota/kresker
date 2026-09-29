'use strict';
/*
  AREA C, part 3 — evidence for the failed erasure, and the same flow on an account
  that never dubbed anything (to separate "erasure is broken" from "erasure is broken
  for accounts with a job").
*/
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const C = 'C user';

async function signIn(page, email, password) {
  await L.goto(page, '/login');
  await L.h1(page, 30000);
  await L.dismissBanner(page);
  await page.locator('#f-email').fill(email);
  await page.locator('#f-password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/app\/?$/, { timeout: 20000 });
  await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
}

async function run(browser, S) {
  const U = S.user;
  const T = S.third;
  const admin = await L.newContext(browser, 'admin-side', { storageState: S.adminState });

  // This used to record the 500 ("FOREIGN KEY constraint failed") that closing an account
  // with a dub produced, and the source video the failed attempt deleted anyway. Fixed on
  // 2026-09-27 (privacy.ts: jobs before uploads, files after the commit). Area C2 closes
  // this account through the UI; this checks what that left behind.
  await L.step(C, 'Close account (customer who has a dub): nothing of theirs is left', async () => {
    const rows = await L.api(admin, 'POST', '/api/admin/db/query', {
      json: { sql: `SELECT (SELECT COUNT(*) FROM uploads WHERE user_id=${U.id}) AS uploads, (SELECT COUNT(*) FROM jobs WHERE user_id=${U.id}) AS jobs, (SELECT role FROM users WHERE id=${U.id}) AS role` },
    });
    const row = (rows.body.rows || [])[0] || {};
    const upAbs = U.uploadRel && path.join(L.DATA_DIR, U.uploadRel);
    const onDisk = upAbs ? fs.existsSync(upAbs) : false;
    if (row.role !== 'erased') throw new Error(`account #${U.id} is not erased: ${JSON.stringify(row)}`);
    if (row.uploads || row.jobs || onDisk) throw new Error(`left behind: ${JSON.stringify(row)}; source file on disk: ${onDisk}`);
    return `account #${U.id} is a tombstone with 0 uploads and 0 jobs, and its source video is gone from disk`;
  });

  await L.step(C, 'Close account (account that never dubbed): erasure completes, mail sent, sign-in refused', async () => {
    const ctx = await L.newContext(browser, 'third');
    const page = await L.newPage(ctx);
    try {
      await signIn(page, T.email, T.password);
      await page.getByRole('link', { name: 'Your data' }).click();
      await page.getByRole('heading', { level: 1, name: 'Your data' }).waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'I want to close my account' }).click();
      await page.locator('#f-your-password').fill(T.password);
      await page.locator('#f-type-delete-to-confirm').fill('DELETE');
      const t0 = Date.now() - 1000;
      const resp = page.waitForResponse((r) => r.url().endsWith('/api/privacy/erase'));
      await page.getByRole('button', { name: 'Erase everything' }).click();
      const r = await resp;
      const j = await r.json();
      const t = await L.toast(page, /Your account is closed/);
      await page.getByText('Your account is closed and your data is gone.').waitFor({ timeout: 10000 });
      const s1 = await L.shot(page, 'C_erased_third', true);
      await page.locator('main').getByRole('button', { name: 'Sign out' }).click();
      await page.waitForURL(/\/login/, { timeout: 15000 });
      const mail = await L.waitMail(T.email, 'account_erased', { after: t0 });
      await page.locator('#f-email').fill(T.email);
      await page.locator('#f-password').fill(T.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByText('That email and password do not match.').waitFor({ timeout: 10000 });
      const q = await L.api(admin, 'POST', '/api/admin/db/query', { json: { sql: `SELECT id, email, role, password_hash FROM users WHERE id=${T.id}` } });
      return `erase -> ${r.status()} deleted ${JSON.stringify(j.deleted)}; toast "${t}"; "Done" card (${s1}); in-card "Sign out" -> /login; mail ${mail.file}; sign-in refused; users row now ${JSON.stringify(q.body.rows)}`;
    } finally {
      await ctx.close();
    }
  }, { allow: [{ kind: 'response', status: 401, url: /\/api\/auth\/login$/ }, { kind: 'console', text: /status of 401/, url: /\/api\/auth\/login$/ }] });

  await admin.close();
}

module.exports = { run };
