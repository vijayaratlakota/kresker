'use strict';
/*
  AREA E re-checks: the rights-request steps read a <main> element the legal pages do
  not have (script bug, the requests themselves were filed), and the "Reject" step
  clicked a card while the list was reloading.
*/
const fs = require('fs');
const L = require('./lib');

const E = 'E extras';

async function run(browser, S) {
  const anon = await L.newContext(browser, 'anon-e');
  const ap = await L.newPage(anon);
  const admin = await L.newContext(browser, 'admin', { storageState: S.adminState });
  const page = await L.newPage(admin);
  const rightsEmail = `ui-rights-${S.stamp}@example.com`;

  if (!S.rights.correction) await L.step(E, 'Contact page "Data rights request" (access) is filed with a deadline (re-check)', async () => {
    const acks = L.mailFiles(rightsEmail, 'rights_ack');
    const inbox = await L.api(admin, 'GET', '/api/admin/inbox?status=&kind=');
    const mine = (inbox.body.messages || []).filter((m) => m.email === rightsEmail).map((m) => `#${m.id} ${m.kind} ${m.status} due ${m.due_at}`);
    if (acks.length < 2 || mine.length < 2) throw new Error(`rights_ack mails ${acks.length}, inbox rows ${mine.join('; ')}`);
    return `the first run's two submissions (access, erasure) reached the inbox: ${mine.join('; ')}; rights_ack mails: ${acks.map((a) => a.f).join(', ')}`;
  });
  if (!S.rights.correction) await L.step(E, 'Contact page "Data rights request" (correction): "Got it." page with the deadline', async () => {
    const t0 = Date.now() - 1000;
    await L.goto(ap, '/contact?kind=correction');
    await L.h1(ap, 30000);
    await L.dismissBanner(ap);
    await ap.locator('#f-email').fill(rightsEmail);
    await ap.locator('#msg').fill(`UI check correction request ${S.stamp}: my name is spelled wrong.`);
    const resp = ap.waitForResponse((r) => r.url().endsWith('/api/privacy/request'));
    await ap.getByRole('button', { name: 'File the request' }).click();
    const r = await resp;
    const j = await r.json();
    S.rights.correction = j.id;
    await ap.getByText('Got it.').waitFor({ timeout: 10000 });
    const body = await L.text(ap, 'body');
    const due = (body.match(/we will answer by [^.]+/) || ['(no deadline text)'])[0];
    const ref = (body.match(/Reference #\d+/) || [''])[0];
    const s = await L.shot(ap, 'E_rights_correction');
    const mail = await L.waitMail(rightsEmail, 'rights_ack', { after: t0 });
    return `-> ${r.status()} id=${j.id}; page "Got it. ${ref}" + "${due}"; mail ${mail.file} (${s})`;
  });
  await L.step(E, 'Admin inbox: erasure request shows the identity warning; "Reject" (re-check)', async () => {
    await L.goto(page, '/app/admin/inbox');
    await page.getByRole('heading', { level: 1, name: 'Inbox' }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Rights only', exact: true }).click();
    await L.sleep(1500);
    const card = page.locator('button[aria-expanded]').filter({ hasText: 'Erasure' }).filter({ hasText: rightsEmail }).first();
    await card.waitFor({ timeout: 10000 });
    if ((await card.getAttribute('aria-expanded')) !== 'true') await card.click();
    await L.sleep(600);
    const li = page.locator('li').filter({ has: page.locator('button[aria-expanded="true"]') }).last();
    const s = await L.shot(page, 'E_inbox_erasure', true);
    const btns = await li.getByRole('button').allInnerTexts();
    const warn = await li.getByText(/Verify who this is before doing anything/).isVisible().catch(() => false);
    const reject = li.getByRole('button', { name: 'Reject', exact: true });
    if (!(await reject.count())) throw new Error(`no Reject button in the open row; buttons [${btns.join(' | ')}] (${s})`);
    await reject.click();
    const t = await L.toast(page, /marked rejected/);
    return `identity warning shown=${warn}; "Reject" -> "${t}" (${s})`;
  });
  await L.step(E, 'Admin inbox: "Reply by email" on a rights request is a mailto: (not clicked)', async () => {
    await page.getByRole('button', { name: 'Everything', exact: true }).click();
    await L.sleep(1500);
    const card = page.locator('button[aria-expanded]').filter({ hasText: 'Correction' }).filter({ hasText: rightsEmail }).first();
    await card.waitFor({ timeout: 10000 });
    if ((await card.getAttribute('aria-expanded')) !== 'true') await card.click();
    await L.sleep(600);
    const li = page.locator('li').filter({ has: page.locator('button[aria-expanded="true"]') }).last();
    const href = await li.getByRole('link', { name: 'Reply by email' }).getAttribute('href');
    await li.locator(`#note-${S.rights.correction}`).fill('Corrected by the UI check');
    await li.getByRole('button', { name: 'Resolved', exact: true }).click();
    const t = await L.toast(page, /marked resolved/);
    return `href ${href}; resolved with a note -> "${t}"`;
  });

  await admin.close();
  await anon.close();
  void fs;
}

module.exports = { run };
