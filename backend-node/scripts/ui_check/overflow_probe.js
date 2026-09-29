'use strict';
/*
  Which pages scroll SIDEWAYS on a phone, and what sticks out. iPhone 13 profile, WebKit
  (and Chromium for comparison). Read-only against the local Vite + backend.
  Usage: node overflow_probe.js
*/
const L = require('./lib');
const { webkit, chromium, devices } = require('C:/paid video player/node_modules/playwright');

const PAGES = ['/', '/pricing', '/languages', '/about', '/contact', '/privacy', '/terms', '/disclaimer', '/login', '/signup', '/reset', '/no-such-page'];

async function probe(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = document.documentElement.scrollWidth - vw;
    const culprits = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 || r.left < -1) {
        // Skip descendants of something already reported, and anything clipped by an
        // ancestor that hides overflow (it cannot cause a page scroll).
        let clipped = false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (/(hidden|clip|auto|scroll)/.test(cs.overflowX)) { clipped = true; break; }
        }
        if (clipped) continue;
        if (culprits.some((c) => c.el.contains(el))) continue;
        culprits.push({ el, desc: `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 90)} left=${Math.round(r.left)} right=${Math.round(r.right)} fixed=${getComputedStyle(el).position}` });
      }
    }
    return { over, vw, culprits: culprits.slice(0, 6).map((c) => c.desc) };
  });
}

// The dashboard and admin pages, signed in as the phone check's admin (first account).
const APP_PAGES = ['/app', '/app/library', '/app/billing', '/app/privacy', '/app/admin', '/app/admin/gpu', '/app/admin/people', '/app/admin/inbox', '/app/admin/billing', '/app/admin/system'];
const STAMP = process.argv[2] || '0927p1';
const ADMIN = { email: `phone-admin-${STAMP}@example.com`, password: `Phone-Admin-${STAMP}-pw` };

(async () => {
  for (const [bt, label] of [[webkit, 'webkit'], [chromium, 'chromium']]) {
    const browser = await bt.launch({ headless: true, proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost,[::1]' } });
    const ctx = await L.newContext(browser, `probe-${label}`, { ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    const pages = [...PAGES];
    if (process.argv.includes('--app')) {
      const reg = await L.api(ctx, 'POST', '/api/auth/register', { json: ADMIN, csrf: false });
      if (reg.status !== 200) {
        const li = await L.api(ctx, 'POST', '/api/auth/login', { json: ADMIN, csrf: false });
        if (li.status !== 200) throw new Error(`cannot sign in the probe admin: ${reg.status}/${li.status}`);
      }
      pages.push(...APP_PAGES);
    }
    for (const p of pages) {
      try {
        await L.goto(page, p);
        await page.locator('h1').first().waitFor({ timeout: 30000 });
        await L.sleep(900);
        // With the consent banner still up (a first visit), and after it is dismissed.
        const withBanner = await probe(page);
        const bannerUp = await page.locator('[data-consent-banner="true"]').isVisible().catch(() => false);
        await L.dismissBanner(page);
        await L.sleep(400);
        const r = await probe(page);
        const scroll = await page.evaluate(() => ({ x: window.scrollX, vvx: window.visualViewport ? Math.round(window.visualViewport.offsetLeft) : 0, scale: window.visualViewport ? window.visualViewport.scale : 1 }));
        console.log(
          `${label} ${p.padEnd(14)} overflow ${r.over}px, with banner ${withBanner.over}px (banner ${bannerUp ? 'shown' : 'not shown'}), scrollX ${scroll.x} vv ${scroll.vvx} scale ${scroll.scale}` +
            (withBanner.culprits.length ? '\n    ' + withBanner.culprits.join('\n    ') : '') +
            (r.culprits.length ? '\n    ' + r.culprits.join('\n    ') : ''),
        );
      } catch (e) {
        console.log(`${label} ${p} ERROR ${String(e.message).split('\n')[0]}`);
      }
    }
    await browser.close();
  }
})();
