'use strict';
/*
  READ-ONLY look at the LIVE site on a phone, signed out: WebKit (iPhone Safari's
  engine) with the iPhone 13 profile. Only kresker.com and its own storage bucket are
  allowed; every other request is aborted. No account, no form is submitted, nothing is
  written - page loads only.
  Usage: node live_phone_check.js
*/
const fs = require('fs');
const path = require('path');
const { webkit, devices } = require('C:/paid video player/node_modules/playwright');

const BASE = 'https://kresker.com';
const OUT = path.join(__dirname, 'shots_live');
fs.mkdirSync(OUT, { recursive: true });
const ALLOW = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === 'kresker.com' || h.endsWith('.r2.dev') || u.startsWith('data:') || u.startsWith('blob:');
  } catch {
    return false;
  }
};

(async () => {
  const browser = await webkit.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-IN' });
  await ctx.route('**/*', (r) => (ALLOW(r.request().url()) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  let fail = 0;
  const check = (name, ok, note) => {
    if (!ok) fail++;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${note ? ` | ${note}` : ''}`);
  };

  for (const p of ['/', '/pricing', '/languages', '/about', '/contact', '/privacy', '/terms', '/disclaimer', '/login', '/signup']) {
    const r = await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => ({ status: () => `error ${e.message.split('\n')[0]}` }));
    await page.locator('h1').first().waitFor({ timeout: 20000 }).catch(() => undefined);
    const h1 = await page.locator('h1').first().innerText().catch(() => '(no h1)');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`${p} loads on a phone`, String(r.status()) === '200' && over <= 0, `status ${r.status()}, "${h1.replace(/\s+/g, ' ').slice(0, 50)}", sideways overflow ${over}px`);
  }

  // The contact page: a real address or none, never the placeholder.
  await page.goto(BASE + '/contact', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  const bad = await page.locator('a[href="mailto:NOT CONFIGURED"]').count();
  const mail = await page.locator('a[href^="mailto:"]').first().getAttribute('href').catch(() => null);
  await page.screenshot({ path: path.join(OUT, 'contact.png') });
  check('Contact page has no "NOT CONFIGURED" address', bad === 0 && !(await page.getByText('NOT CONFIGURED').count()), `first mailto: ${mail}`);

  // The privacy notice states the new source-video rule, and the old "gap" warning is gone.
  await page.goto(BASE + '/privacy', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  const body = await page.locator('body').innerText();
  const row = await page.getByText(/Kept as long as the dubs made from it/).first().isVisible().catch(() => false);
  await page.getByText(/Kept as long as the dubs made from it/).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await page.screenshot({ path: path.join(OUT, 'privacy_retention.png') });
  check('Privacy notice shows the new source-video rule', row, row ? 'row visible' : 'row missing');
  check('  and the old "one gap" warning is gone', !/Being straight about one gap/.test(body));

  check('no script errors on any page', errors.length === 0, errors.slice(0, 3).join(' || '));
  await browser.close();
  console.log(`\n${fail ? `${fail} FAILED` : 'all passed'}  (screenshots in ${path.relative(process.cwd(), OUT) || OUT})`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
