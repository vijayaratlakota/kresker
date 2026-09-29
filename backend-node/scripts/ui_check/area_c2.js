'use strict';
/* AREA C, part 2 — the customer resets their password, then closes the account. */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const C = 'C user';

async function run(browser, S) {
  const U = S.user;
  U.password2 = U.password2 || `Ui-User-${S.stamp}-pw2`;
  const ctx = await L.newContext(browser, 'user', { storageState: S.userState });
  const page = await L.newPage(ctx);
  const admin = await L.newContext(browser, 'admin-side', { storageState: S.adminState });

  // ── password reset ────────────────────────────────────────────────────────
  await L.step(C, 'Sign out from the sidebar', async () => {
    await L.goto(page, '/app');
    await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
    await L.dismissBanner(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/, { timeout: 15000 });
    const me = await L.api(ctx, 'GET', '/api/auth/me');
    if (me.status !== 401) throw new Error(`/me ${me.status}`);
    return `-> ${page.url().replace(L.BASE, '')}; /me 401`;
  });
  let t0 = 0;
  await L.step(C, 'Forgot password: request a reset link for the account', async () => {
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.waitForURL(/\/reset$/, { timeout: 10000 });
    await L.h1(page);
    t0 = Date.now() - 1000;
    await page.locator('#f-email').fill(U.email);
    await page.getByRole('button', { name: 'Send the reset link' }).click();
    await page.getByText(/If that address has an account, a reset link is on its way/).waitFor({ timeout: 10000 });
    const mail = await L.waitMail(U.email, 'password_reset', { after: t0 });
    U.resetLink = L.linkIn(mail.text, '/reset').hit;
    return `neutral confirmation shown; mail ${mail.file} with link ${String(U.resetLink).replace(/token=.*/, 'token=…')}`;
  });
  await L.step(C, 'Reset link: mismatch is caught, new password saved, "Go to sign in"', async () => {
    if (!U.resetLink || !U.resetLink.startsWith(L.BASE + '/reset?token=')) throw new Error(`bad link ${U.resetLink}`);
    await L.goto(page, U.resetLink);
    await page.getByRole('heading', { level: 1, name: 'Choose a new password' }).waitFor({ timeout: 20000 });
    await page.locator('#f-new-password').fill(U.password2);
    await page.locator('#f-new-password-again').fill(U.password2 + 'x');
    await page.locator('#f-new-password').click();
    const mism = await page.locator('#f-new-password-again-err').innerText({ timeout: 5000 });
    await page.locator('#f-new-password-again').fill(U.password2);
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/auth/reset/confirm'));
    await page.getByRole('button', { name: 'Change password' }).click();
    const r = await resp;
    await page.getByRole('heading', { level: 1, name: 'Password changed' }).waitFor({ timeout: 10000 });
    const note = (await L.text(page, 'main, body')).match(/No other sessions were open\.|Signed out of \d+ other sessions?[^.]*\./);
    const s = await L.shot(page, 'C_password_changed');
    await page.getByRole('button', { name: 'Go to sign in' }).click();
    await page.waitForURL(/\/login$/, { timeout: 10000 });
    return `mismatch -> "${mism.trim()}"; confirm -> ${r.status()}; "Password changed" + "${note ? note[0] : '?'}"; "Go to sign in" -> /login (${s})`;
  });
  await L.step(C, 'Reset link cannot be used twice', async () => {
    const tok = new URL(U.resetLink).searchParams.get('token');
    const r = await L.api(ctx, 'POST', '/api/auth/reset/confirm', { json: { token: tok, password: 'Another-pw-12345' }, csrf: false });
    if (r.status !== 400) throw new Error(`second use -> ${r.status}`);
    return `second use -> 400 "${r.body.detail}"`;
  });
  await L.step(
    C,
    'Old password no longer works',
    async () => {
      await page.locator('#f-email').fill(U.email);
      await page.locator('#f-password').fill(U.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByText('That email and password do not match.').waitFor({ timeout: 10000 });
      return 'refused with "That email and password do not match."';
    },
    { allow: [{ kind: 'response', status: 401, url: /\/api\/auth\/login$/ }, { kind: 'console', text: /status of 401/, url: /\/api\/auth\/login$/ }] },
  );
  await L.step(C, 'Sign in with the new password', async () => {
    await page.locator('#f-password').fill(U.password2);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/app\/?$/, { timeout: 20000 });
    await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
    return 'signed in, on /app';
  });

  // ── erasure ───────────────────────────────────────────────────────────────
  await L.step(
    C,
    'Close account: wrong password is refused',
    async () => {
      await page.getByRole('link', { name: 'Your data' }).click();
      await page.getByRole('heading', { level: 1, name: 'Your data' }).waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'I want to close my account' }).click();
      const erase = page.getByRole('button', { name: 'Erase everything' });
      const disabled0 = await erase.isDisabled();
      await page.locator('#f-your-password').fill('wrong-password-x');
      await page.locator('#f-type-delete-to-confirm').fill('delete');
      const disabledLower = await erase.isDisabled();
      await page.locator('#f-type-delete-to-confirm').fill('DELETE');
      await erase.click();
      const err = await page.getByText('That password is not right.').innerText({ timeout: 10000 });
      const s = await L.shot(page, 'C_erase_wrong_pw');
      return `"Erase everything" disabled until filled (${disabled0}) and for lower-case "delete" (${disabledLower}); wrong password -> "${err}" (${s})`;
    },
    { allow: [{ kind: 'response', status: 403, url: /\/api\/privacy\/erase$/ }, { kind: 'console', text: /status of 403/, url: /\/api\/privacy\/erase$/ }] },
  );
  await L.step(C, 'Close account: correct password + DELETE erases the account', async () => {
    // files on disk before, so the erasure can be checked against them
    const upAbs = U.uploadRel && (path.isAbsolute(U.uploadRel) ? U.uploadRel : path.join(L.DATA_DIR, U.uploadRel));
    const upBefore = upAbs && fs.existsSync(upAbs);
    t0 = Date.now() - 1000;
    await page.locator('#f-your-password').fill(U.password2);
    await page.locator('#f-type-delete-to-confirm').fill('DELETE');
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/privacy/erase'));
    await page.getByRole('button', { name: 'Erase everything' }).click();
    const r = await resp;
    const j = await r.json();
    const t = await L.toast(page, /Your account is closed/);
    await page.getByText('Your account is closed and your data is gone.').waitFor({ timeout: 10000 });
    const done = (await L.text(page, 'main')).slice(0, 400);
    const s = await L.shot(page, 'C_erased', true);
    const upAfter = upAbs && fs.existsSync(upAbs);
    U.erase = { status: r.status(), deleted: j.deleted, retained: j.retained, upAbs, upBefore, upAfter };
    if (upAfter) throw new Error(`source upload still on disk: ${upAbs}`);
    return `POST /api/privacy/erase -> ${r.status()}; toast "${t}"; deleted ${JSON.stringify(j.deleted)}; upload file ${U.uploadRel} before=${upBefore} after=${upAfter}; page "${done.slice(0, 160)}" (${s})`;
  });
  await L.step(C, 'After erasure: "Sign out" button, account_erased mail, sign-in refused', async () => {
    await page.getByRole('button', { name: 'Sign out' }).last().click();
    await page.waitForURL(/\/login/, { timeout: 15000 });
    const mail = await L.waitMail(U.email, 'account_erased', { after: t0 }).catch((e) => ({ file: `(none: ${e.message})` }));
    await page.locator('#f-email').fill(U.email);
    await page.locator('#f-password').fill(U.password2);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('That email and password do not match.').waitFor({ timeout: 10000 });
    const s = await L.shot(page, 'C_login_after_erase');
    const users = await L.api(admin, 'GET', `/api/admin/users?q=${encodeURIComponent(U.email)}`);
    const q = await L.api(admin, 'POST', '/api/admin/db/query', { json: { sql: `SELECT id, email, role, status FROM users WHERE id=${U.id}` } });
    if (!/account_erased/.test(mail.file)) throw new Error(`no account_erased mail: ${mail.file}`);
    return `-> /login; mail ${mail.file}; sign-in refused (401); admin search for the address -> ${(users.body.users || []).length} rows; users row #${U.id} is now ${JSON.stringify(q.body.rows)} (${s})`;
  }, { allow: [{ kind: 'response', status: 401, url: /\/api\/auth\/login$/ }, { kind: 'console', text: /status of 401/, url: /\/api\/auth\/login$/ }] });

  await admin.close();
  await ctx.close();
}

module.exports = { run };
