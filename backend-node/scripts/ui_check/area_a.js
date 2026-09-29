'use strict';
/* AREA A — signed out, every public page. */
const L = require('./lib');

const A = 'A public';

const NOT_FOUND = /There is nothing here/;

async function run(browser, S) {
  const ctx = await L.newContext(browser, 'anon');
  const page = await L.newPage(ctx);
  const allLinks = new Map(); // href -> {text, from}
  const external = new Map();

  const PAGES = [
    ['/', 'Landing', null],
    ['/pricing', 'Pricing', /Pay for minutes, not seats/],
    ['/languages', 'Languages', null],
    ['/about', 'About', null],
    ['/contact', 'Contact', null],
    ['/privacy', 'Privacy', null],
    ['/terms', 'Terms', null],
    ['/disclaimer', 'Disclaimer', null],
    ['/login', 'Login', /Welcome back/],
    ['/signup', 'Signup', /Create an account/],
    ['/reset', 'Forgot password (/reset)', /Reset your password/],
    ['/verify', 'Verify email (no token)', /Confirm your email/],
  ];

  // ── A1: consent banner on first visit ─────────────────────────────────────
  await L.step(A, 'Privacy banner shows on first visit and "No analytics" dismisses it', async () => {
    await L.goto(page, '/');
    await L.h1(page, 30000);
    const b = page.locator('[data-consent-banner="true"]');
    await b.waitFor({ state: 'visible', timeout: 15000 });
    const t = (await b.innerText()).replace(/\s+/g, ' ');
    if (!/We use one cookie/.test(t)) throw new Error(`banner text unexpected: ${t.slice(0, 120)}`);
    const shotA = await L.shot(page, 'A_banner');
    await b.getByRole('button', { name: 'No analytics' }).click();
    await b.waitFor({ state: 'detached', timeout: 5000 });
    const ack = await page.evaluate(() => localStorage.getItem('vs_privacy_ack'));
    const parsed = JSON.parse(ack || '{}');
    if (parsed.analytics !== false) throw new Error(`vs_privacy_ack not recorded as refused: ${ack}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await L.h1(page);
    await L.sleep(1500);
    if (await b.isVisible().catch(() => false)) throw new Error('banner came back after reload');
    return `banner shown, dismissed, stayed dismissed after reload; stored ${ack} (${shotA})`;
  });

  await L.step(A, 'Privacy banner "That’s fine" (fresh visitor) records analytics=true; hidden on /privacy', async () => {
    const c2 = await L.newContext(browser, 'anon2');
    const p2 = await L.newPage(c2);
    try {
      await L.goto(p2, '/privacy');
      await L.h1(p2, 30000);
      await L.sleep(1500);
      const onPrivacy = await p2.locator('[data-consent-banner="true"]').isVisible().catch(() => false);
      await L.goto(p2, '/about');
      await L.h1(p2);
      const b = p2.locator('[data-consent-banner="true"]');
      await b.waitFor({ state: 'visible', timeout: 15000 });
      await b.getByRole('button', { name: /That.s fine/ }).click();
      await b.waitFor({ state: 'detached', timeout: 5000 });
      const ack = JSON.parse((await p2.evaluate(() => localStorage.getItem('vs_privacy_ack'))) || '{}');
      if (onPrivacy) throw new Error('banner was visible on /privacy (it is meant to hide there)');
      if (ack.analytics !== true) throw new Error(`expected analytics=true, got ${JSON.stringify(ack)}`);
      return 'hidden on /privacy; on /about accepted -> vs_privacy_ack.analytics=true';
    } finally {
      await c2.close();
    }
  });

  // ── A2: every public page renders ─────────────────────────────────────────
  for (const [p, name, h1re] of PAGES) {
    await L.step(A, `Page ${p} (${name}) renders`, async () => {
      const resp = await L.goto(page, p);
      const h = await L.h1(page, 30000);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      await L.sleep(800);
      const title = await page.title();
      const body = await L.text(page);
      if (NOT_FOUND.test(body)) throw new Error('rendered the 404 page');
      if (h1re && !h1re.test(h)) throw new Error(`h1 "${h}" does not match ${h1re}`);
      if (!title || /undefined|null/.test(title)) throw new Error(`bad <title>: "${title}"`);
      const links = await page.$$eval('a[href]', (as) =>
        as.map((a) => ({
          href: a.getAttribute('href'),
          text: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50),
          where: a.closest('header') ? 'header' : a.closest('footer') ? 'footer' : 'body',
        })),
      );
      for (const l of links) {
        const href = l.href || '';
        if (/^(mailto:|tel:)/.test(href) || (/^https?:/.test(href) && !href.startsWith(L.BASE))) {
          if (!external.has(href)) external.set(href, { ...l, from: p });
        } else if (!allLinks.has(href)) allLinks.set(href, { ...l, from: p });
      }
      const buttons = await page.$$eval('button', (bs) =>
        bs
          .filter((b) => b.offsetParent !== null)
          .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)),
      );
      const s = await L.shot(page, `A_page${p.replace(/\//g, '_') || '_root'}`);
      return {
        note: `HTTP ${resp ? resp.status() : '?'}; h1 "${h.slice(0, 60)}"; title "${title.slice(0, 60)}"; ${links.length} links, buttons: [${[...new Set(buttons)].join(' | ').slice(0, 300)}] (${s})`,
      };
    });
  }

  await L.step(A, 'Unknown route shows the not-found page', async () => {
    await L.goto(page, `/no-such-page-${S.stamp}`);
    const h = await L.h1(page, 30000);
    const body = await L.text(page);
    if (!NOT_FOUND.test(h) || !/404/.test(body)) throw new Error(`h1 "${h}"`);
    const s = await L.shot(page, 'A_404');
    await page.getByRole('button', { name: 'Back to the homepage' }).click();
    await page.waitForURL(L.BASE + '/', { timeout: 10000 });
    await L.goto(page, `/no-such-page-${S.stamp}`);
    await L.h1(page);
    await page.getByRole('button', { name: 'Open the dashboard' }).click();
    await page.waitForURL(/\/login\?next=%2Fapp/, { timeout: 10000 });
    return `404 page with "There is nothing here"; "Back to the homepage" -> /; "Open the dashboard" -> ${page.url().replace(L.BASE, '')} (${s})`;
  });

  // ── A3: header nav links, clicked ─────────────────────────────────────────
  const NAV = [
    ['link', 'Kresker home', '/', null],
    ['text', 'How it works', '/#how', 'how'],
    ['text', 'Languages', '/languages', null],
    ['text', 'Pricing', '/pricing', null],
    ['button', 'Log in', '/login', null],
    ['button', 'Start free', '/signup', null],
  ];
  for (const [kind, label, expect, anchor] of NAV) {
    await L.step(A, `Header nav "${label}" (clicked from /pricing)`, async () => {
      await L.goto(page, '/pricing');
      await L.h1(page, 30000);
      const header = page.locator('header').first();
      const target =
        kind === 'link'
          ? header.getByRole('link', { name: label })
          : kind === 'button'
            ? header.getByRole('button', { name: label, exact: true })
            : header.getByRole('link', { name: label, exact: true });
      await target.first().click();
      await page.waitForURL((u) => u.pathname + u.hash === expect || u.pathname === expect, { timeout: 15000 });
      await L.sleep(1200);
      const body = await L.text(page);
      if (NOT_FOUND.test(body)) throw new Error('landed on 404');
      if (anchor) {
        const inView = await page.evaluate((id) => {
          const el = document.getElementById(id);
          if (!el) return 'missing';
          const r = el.getBoundingClientRect();
          return r.top < window.innerHeight && r.bottom > 0 ? 'in-view' : `off-screen top=${Math.round(r.top)}`;
        }, anchor);
        if (inView !== 'in-view') throw new Error(`#${anchor} ${inView}`);
      } else await L.h1(page);
      return `-> ${page.url().replace(L.BASE, '')}`;
    });
  }

  // ── A4: footer links, clicked ─────────────────────────────────────────────
  await L.goto(page, '/');
  await L.h1(page, 30000);
  const footerLinks = await page.$$eval('footer a[href]', (as) =>
    as.map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().replace(/\s+/g, ' ') })),
  );
  for (const fl of footerLinks) {
    await L.step(A, `Footer link "${fl.text}" -> ${fl.href}`, async () => {
      await L.goto(page, '/about');
      await L.h1(page, 30000);
      const link = page.locator('footer').getByRole('link', { name: fl.text, exact: true }).first();
      await link.scrollIntoViewIfNeeded();
      await link.click();
      const want = new URL(fl.href, L.BASE);
      await page.waitForURL(
        (u) =>
          (u.pathname === want.pathname && (u.search === want.search || !want.search)) ||
          (want.pathname === '/app' && u.pathname === '/login'),
        { timeout: 15000 },
      );
      await L.sleep(1200);
      const body = await L.text(page);
      if (NOT_FOUND.test(body)) throw new Error('landed on 404');
      if (want.hash) {
        const ok = await page.evaluate((id) => !!document.getElementById(id), want.hash.slice(1));
        if (!ok) throw new Error(`anchor ${want.hash} missing`);
      } else await L.h1(page);
      return `-> ${page.url().replace(L.BASE, '')}`;
    });
  }

  // ── A5: every other internal link found on the public pages resolves ──────
  await L.step(A, 'Every internal link found on public pages resolves (no 404)', async () => {
    const bad = [];
    const seen = [];
    for (const [href, info] of allLinks) {
      if (!href || href.startsWith('#')) continue;
      const u = new URL(href, L.BASE);
      const key = u.pathname + u.search;
      if (seen.includes(key)) continue;
      seen.push(key);
      await L.goto(page, key);
      try {
        await L.h1(page, 20000);
      } catch {
        bad.push(`${key} (no h1; from ${info.from})`);
        continue;
      }
      if (NOT_FOUND.test(await L.text(page))) bad.push(`${key} -> 404 (link "${info.text}" on ${info.from})`);
      if (u.hash) {
        const ok = await page.evaluate((id) => !!document.getElementById(id), decodeURIComponent(u.hash.slice(1)));
        if (!ok) bad.push(`${href} anchor missing`);
      }
    }
    if (bad.length) throw new Error(bad.join('; '));
    return `${seen.length} distinct internal targets OK: ${seen.join(' ')}`;
  });

  await L.step(A, 'External / mailto links inventory (not clicked, local-only rule)', async () => {
    const list = [...external.entries()].map(([h, i]) => `${h} ["${i.text}" on ${i.from}]`);
    return { note: list.length ? list.join(' ; ') : 'none found' };
  });

  // ── A6: landing page buttons ──────────────────────────────────────────────
  await L.step(A, 'Landing: hero "Dub your first video free" -> /signup', async () => {
    await L.goto(page, '/');
    await L.h1(page, 30000);
    await page.getByRole('button', { name: 'Dub your first video free' }).first().click();
    await page.waitForURL(/\/signup$/, { timeout: 10000 });
    return 'ok';
  });
  await L.step(A, 'Landing: "See how it works" scrolls to #how', async () => {
    await L.goto(page, '/');
    await L.h1(page, 30000);
    await page.getByRole('button', { name: /See how it works/ }).click();
    await L.sleep(1500);
    const r = await page.evaluate(() => {
      const el = document.getElementById('how');
      const b = el && el.getBoundingClientRect();
      return { hash: location.hash, top: b ? Math.round(b.top) : null };
    });
    if (r.top === null || r.top > 450 || r.top < -2000) throw new Error(`#how top=${r.top} hash=${r.hash}`);
    return `hash=${r.hash} #how top=${r.top}px`;
  });
  await L.step(A, 'Landing: FAQ accordion items open and close', async () => {
    await L.goto(page, '/#faq');
    await L.h1(page, 30000);
    const triggers = page.locator('#faq button[aria-expanded]');
    const n = await triggers.count();
    if (!n) throw new Error('no FAQ triggers found');
    const log = [];
    for (let i = 0; i < n; i++) {
      const t = triggers.nth(i);
      await t.scrollIntoViewIfNeeded();
      const before = await t.getAttribute('aria-expanded');
      await t.click();
      await L.sleep(350);
      const after = await t.getAttribute('aria-expanded');
      if (before === after) log.push(`#${i} did not toggle (${before})`);
    }
    if (log.length) throw new Error(log.join('; '));
    const s = await L.shot(page, 'A_faq');
    return `${n} FAQ items toggled (${s})`;
  });
  await L.step(
    A,
    'Landing: demo reel "Play the demo" and "Demo language" buttons',
    async () => {
      await L.goto(page, '/');
      await L.h1(page, 30000);
      const play = page.getByRole('button', { name: /Play the demo|Pause the demo/ }).first();
      await play.scrollIntoViewIfNeeded();
      await play.click();
      await L.sleep(2500);
      const v = await page.evaluate(() => {
        const vid = [...document.querySelectorAll('video')].find((x) => x.closest('section'));
        return vid ? { src: vid.currentSrc || vid.src, paused: vid.paused, t: vid.currentTime, err: vid.error && vid.error.code } : null;
      });
      const group = page.getByRole('group', { name: 'Demo language' });
      const langs = group.getByRole('button');
      const n = await langs.count();
      const picked = [];
      for (let i = 0; i < Math.min(n, 6); i++) {
        await langs.nth(i).click();
        await L.sleep(400);
        picked.push((await langs.nth(i).innerText()).trim().replace(/\s+/g, ' '));
      }
      const s = await L.shot(page, 'A_demo');
      return {
        note: `video=${JSON.stringify(v)}; clicked ${n} language buttons [${picked.join(', ')}] (${s})`,
      };
    },
    { noiseOk: true },
  );
  await L.step(A, 'Landing: bottom CTA "Create an account" -> /signup', async () => {
    await L.goto(page, '/');
    await L.h1(page, 30000);
    const b = page.getByRole('button', { name: 'Create an account', exact: true }).last();
    await b.scrollIntoViewIfNeeded();
    await b.click();
    await page.waitForURL(/\/signup$/, { timeout: 10000 });
    return 'ok';
  });

  // ── A7: pricing matches the API ───────────────────────────────────────────
  await L.step(A, 'Pricing: cards match GET /api/billing/plans (monthly + annual)', async () => {
    const plans = await L.api(ctx, 'GET', '/api/billing/plans');
    if (plans.status !== 200) throw new Error(`plans API ${plans.status}`);
    S.plans = plans.body;
    const wait = page.waitForResponse((r) => r.url().endsWith('/api/billing/plans'), { timeout: 20000 });
    await L.goto(page, '/pricing');
    await wait;
    await L.h1(page, 30000);
    await L.sleep(800);
    const rup = (p) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    const problems = [];
    const cardText = async (name) => {
      const h = page.locator('h2', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }).first();
      if (!(await h.count())) return null;
      return (await h.locator('xpath=ancestor::*[.//a or .//button][1]').innerText()).replace(/\s+/g, ' ');
    };
    const free = plans.body.plans.find((p) => p.code === 'free');
    const ft = await cardText(free.name);
    if (!ft) problems.push(`free card "${free.name}" missing`);
    else {
      if (!ft.includes('₹0')) problems.push('free card has no ₹0');
      if (!ft.includes(`${free.minutes_per_period} minute, once`)) problems.push(`free minutes text missing (${free.minutes_per_period})`);
      if (!ft.includes(`Videos up to ${free.max_video_seconds} seconds`)) problems.push('free max length text missing');
    }
    const checkInterval = async (interval) => {
      const shown = plans.body.plans.filter((p) => p.interval === interval && p.purchasable);
      for (const p of shown) {
        const t = await cardText(p.name);
        if (!t) {
          problems.push(`${interval}: card "${p.name}" missing`);
          continue;
        }
        if (!t.includes(rup(p.price_paise))) problems.push(`${p.name}: price ${rup(p.price_paise)} not shown`);
        if (!t.includes(`${p.minutes_per_period} minutes ${interval === 'month' ? 'a month' : 'a year'}`))
          problems.push(`${p.name}: minutes ${p.minutes_per_period} not shown`);
        if (!t.includes(`Videos up to ${Math.floor(p.max_video_seconds / 60)} minutes`)) problems.push(`${p.name}: max length not shown`);
        if (!t.includes(`Choose ${p.name}`)) problems.push(`${p.name}: no "Choose ${p.name}" button`);
      }
      return shown.map((p) => `${p.name} ${rup(p.price_paise)} ${p.minutes_per_period}min`).join(', ');
    };
    const m = await checkInterval('month');
    const s1 = await L.shot(page, 'A_pricing_month', true);
    await page.getByRole('button', { name: 'Annual', exact: true }).first().click();
    await L.sleep(600);
    if (!(await page.getByText('Save 20%').first().isVisible())) problems.push('"Save 20%" badge not shown on Annual');
    const y = await checkInterval('year');
    const s2 = await L.shot(page, 'A_pricing_year', true);
    await page.getByRole('button', { name: 'Monthly', exact: true }).first().click();
    if (problems.length) throw new Error(problems.join('; '));
    return `open=${plans.body.open} live=${plans.body.live}; monthly: ${m}; annual: ${y} (${s1}, ${s2})`;
  });
  await L.step(A, 'Pricing: "Start free" and "Choose <plan>" buttons go to /signup', async () => {
    await L.goto(page, '/pricing');
    await L.h1(page, 30000);
    await page.getByRole('button', { name: 'Start free' }).last().click();
    await page.waitForURL(/\/signup$/, { timeout: 10000 });
    await L.goto(page, '/pricing');
    await L.h1(page);
    const choose = page.getByRole('button', { name: /^Choose / }).first();
    const label = (await choose.innerText()).trim();
    await choose.click();
    await page.waitForURL(/\/signup$/, { timeout: 10000 });
    return `"Start free" -> /signup; "${label}" -> /signup`;
  });

  // ── A8: contact form ──────────────────────────────────────────────────────
  S.contactEmail = `ui-contact-${S.stamp}@example.com`;
  S.contactSubject = `UI check ${S.stamp}`;
  await L.step(A, 'Contact: short message is refused client-side', async () => {
    await L.goto(page, '/contact');
    await L.h1(page, 30000);
    await page.locator('#msg').fill('short');
    await page.getByText('A little more than that, please.').waitFor({ timeout: 5000 });
    return 'shows "A little more than that, please." for a 5-character message';
  });
  await L.step(A, 'Contact: mode tabs switch to "Data rights request" and back', async () => {
    await page.getByRole('tab', { name: 'Data rights request' }).click();
    await page.locator('#rights-kind').waitFor({ timeout: 5000 });
    const opts = await page.locator('#rights-kind option').allInnerTexts();
    if (!/kind=access/.test(page.url())) throw new Error(`url did not gain ?kind=: ${page.url()}`);
    await page.getByRole('tab', { name: 'General message' }).click();
    await page.locator('#f-your-name').waitFor({ timeout: 5000 });
    return `rights kinds: ${opts.join(' | ')}`;
  });
  await L.step(A, 'Contact: submit a general message -> "Got it." + contact_ack mail', async () => {
    const t0 = Date.now() - 2000;
    await page.locator('#f-your-name').fill('UI Tester');
    await page.locator('#f-email').fill(S.contactEmail);
    await page.locator('#f-subject').fill(S.contactSubject);
    await page.locator('#msg').fill(`Hello, this is the local browser check ${S.stamp}. Please ignore.`);
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/contact') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send message' }).click();
    const r = await resp;
    const j = await r.json();
    await page.getByText('Got it.').waitFor({ timeout: 10000 });
    const body = await L.text(page);
    const ref = (body.match(/Reference #(\d+)/) || [])[1];
    S.contactId = Number(j.id);
    const s = await L.shot(page, 'A_contact_sent');
    const mail = await L.waitMail(S.contactEmail, 'contact_ack', { after: t0 });
    if (String(ref) !== String(j.id)) throw new Error(`reference on page #${ref} != API id ${j.id}`);
    return `HTTP ${r.status()} id=${j.id}; page shows "Got it. Reference #${ref}"; mail file ${mail.file} (${s})`;
  });
  await L.step(A, 'Contact: "Send another" resets the form, "Back to the site" -> /', async () => {
    await page.getByRole('button', { name: 'Send another' }).click();
    await page.getByRole('button', { name: 'Send message' }).waitFor({ timeout: 5000 });
    await L.goto(page, '/contact');
    await L.h1(page);
    return 'form shown again after "Send another"';
  });

  // ── A9: auth pages, signed out ────────────────────────────────────────────
  await L.step(
    A,
    'Login: wrong credentials show a non-enumerating error',
    async () => {
      await L.goto(page, '/login');
      await L.h1(page, 30000);
      await page.locator('#f-email').fill(`nobody-${S.stamp}@example.com`);
      await page.locator('#f-password').fill('not-the-password-1');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByText('That email and password do not match.').waitFor({ timeout: 10000 });
      const s = await L.shot(page, 'A_login_wrong');
      return `error shown (${s})`;
    },
    { allow: [{ kind: 'response', status: 401, url: /\/api\/auth\/login$/ }, { kind: 'console', text: /status of 401/, url: /\/api\/auth\/login$/ }] },
  );
  await L.step(A, 'Login: "Forgot your password?" -> /reset and "Create an account" -> /signup', async () => {
    await L.goto(page, '/login');
    await L.h1(page);
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.waitForURL(/\/reset$/, { timeout: 10000 });
    await L.goto(page, '/login');
    await L.h1(page);
    await page.getByRole('link', { name: 'Create an account' }).click();
    await page.waitForURL(/\/signup$/, { timeout: 10000 });
    return 'both links work';
  });
  await L.step(
    A,
    'Google sign-in button (not configured in this env)',
    async () => {
      await L.goto(page, '/login');
      await L.h1(page);
      await L.sleep(1500);
      const visible = await page.getByRole('button', { name: /with Google/ }).isVisible().catch(() => false);
      const site = await L.api(ctx, 'GET', '/api/site');
      const start = await L.api(ctx, 'GET', '/api/auth/google/start?next=%2Fapp');
      return {
        note: `google_auth=${site.body.google_auth}; button visible=${visible}; GET /api/auth/google/start -> ${start.status}${
          start.headers.location ? ' location=' + start.headers.location : ''
        } (sign-in NOT attempted, by rule)`,
        status: visible === !!site.body.google_auth ? 'PASS' : 'FAIL',
      };
    },
  );
  await L.step(A, 'Signup: short password shows "At least 8 characters." and blocks submit; legal links', async () => {
    await L.goto(page, '/signup');
    await L.h1(page);
    await page.locator('#f-email').fill(`never-${S.stamp}@example.com`);
    await page.locator('#f-password').fill('short');
    await page.locator('#f-email').click();
    await page.locator('#f-password-err').waitFor({ timeout: 5000 });
    const err = await page.locator('#f-password-err').innerText();
    let posted = false;
    const onReq = (r) => {
      if (r.url().endsWith('/api/auth/register')) posted = true;
    };
    page.on('request', onReq);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await L.sleep(800);
    page.off('request', onReq);
    if (posted) throw new Error('register was POSTed with a 5-character password');
    const hrefs = await page.$$eval('[data-signup-legal="true"] a', (as) => as.map((a) => a.getAttribute('href')));
    await page.getByRole('link', { name: 'Terms of Service' }).click();
    await page.waitForURL(/\/terms$/, { timeout: 10000 });
    return `error "${err}", no request sent; legal links ${hrefs.join(', ')}; Terms link works`;
  });
  await L.step(A, 'Forgot password: request for an unknown address shows the neutral confirmation', async () => {
    await L.goto(page, '/reset');
    await L.h1(page);
    await page.locator('#f-email').fill(`nobody-${S.stamp}@example.com`);
    await page.getByRole('button', { name: 'Send the reset link' }).click();
    await page.getByText(/If that address has an account, a reset link is on its way/).waitFor({ timeout: 10000 });
    const s = await L.shot(page, 'A_reset_sent');
    await page.getByRole('link', { name: 'Back to sign in' }).click();
    await page.waitForURL(/\/login$/, { timeout: 10000 });
    return `neutral message shown; "Back to sign in" works (${s})`;
  });
  await L.step(A, 'Verify page: "Send me a new link" for an unknown address shows the neutral confirmation', async () => {
    await L.goto(page, '/verify');
    await L.h1(page);
    await page.locator('#f-email').fill(`nobody2-${S.stamp}@example.com`);
    await page.getByRole('button', { name: 'Send me a new link' }).click();
    await page.getByText(/If that address needs confirming, a new link is on its way/).waitFor({ timeout: 10000 });
    return 'neutral message shown';
  });
  await L.step(
    A,
    'Verify page with a bogus token shows "That link did not work"',
    async () => {
      await L.goto(page, `/verify?token=bogus-${S.stamp}`);
      await L.h1(page);
      const got = await page
        .getByText('That link did not work')
        .waitFor({ timeout: 12000 })
        .then(() => 'failed-screen')
        .catch(() => 'timeout');
      const h = `${await L.h1(page)} / ${await L.text(page, 'main, body').then((t) => t.slice(0, 120))}`;
      const s = await L.shot(page, 'A_verify_bogus');
      if (got !== 'failed-screen') throw new Error(`after 12 s the page still says "${h}" (${s})`);
      return `failure screen shown (${s})`;
    },
    { allow: [{ kind: 'response', status: 400, url: /\/api\/auth\/verify$/ }, { kind: 'console', text: /status of 400/, url: /\/api\/auth\/verify$/ }] },
  );

  // ── A10: guards, redirects, generated files ───────────────────────────────
  await L.step(A, 'Signed-out /app, /app/billing, /app/admin and /dashboard redirect to /login', async () => {
    const out = [];
    for (const p of ['/app', '/app/billing', '/app/admin', '/dashboard']) {
      await L.goto(page, p);
      await page.waitForURL(/\/login/, { timeout: 15000 });
      out.push(`${p} -> ${page.url().replace(L.BASE, '')}`);
    }
    return out.join('; ');
  });
  await L.step(A, '/robots.txt and /sitemap.xml (proxied to the backend)', async () => {
    const r = await L.api(ctx, 'GET', '/robots.txt');
    const m = await L.api(ctx, 'GET', '/sitemap.xml');
    if (r.status !== 200 || m.status !== 200) throw new Error(`robots ${r.status} sitemap ${m.status}`);
    const locs = (String(m.body).match(/<loc>[^<]+<\/loc>/g) || []).length;
    return `robots 200: "${String(r.body).split('\n').filter((l) => /^(User-agent|Disallow|Allow|Sitemap)/i.test(l)).join(' / ')}"; sitemap 200 with ${locs} <loc> entries`;
  });

  // ── A11: phone-width menu ─────────────────────────────────────────────────
  await L.step(A, 'Phone width (390px): "Open menu" shows the nav and its links work', async () => {
    const c3 = await L.newContext(browser, 'anon-phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p3 = await L.newPage(c3);
    try {
      await L.goto(p3, '/');
      await L.h1(p3, 30000);
      await L.dismissBanner(p3);
      await p3.getByRole('button', { name: 'Open menu' }).click();
      await p3.getByRole('button', { name: 'Close menu' }).waitFor({ timeout: 5000 });
      const s = await L.shot(p3, 'A_phone_menu');
      await p3.locator('header').getByRole('link', { name: 'Pricing', exact: true }).last().click();
      await p3.waitForURL(/\/pricing$/, { timeout: 10000 });
      await L.h1(p3);
      const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      return `menu opens, Pricing link works; horizontal overflow on /pricing = ${overflow}px (${s})`;
    } finally {
      await c3.close();
    }
  });

  await ctx.close();
}

module.exports = { run };
