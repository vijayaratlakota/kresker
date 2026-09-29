'use strict';
/* AREA E3 — the auth footer links, one step each (the combined step failed on a selector). */
const L = require('./lib');

const E = 'E extras';

async function run(browser) {
  const anon = await L.newContext(browser, 'anon-e3');
  const p = await L.newPage(anon);
  const cases = [
    ['/signup', 'Create an account', 'Sign in', /\/login$/],
    ['/verify', 'Confirm your email', 'Sign in', /\/login$/],
    ['/reset?token=not-a-real-token', 'Choose a new password', 'Need a new link?', /\/reset$/],
    ['/reset', 'Reset your password', 'Back to sign in', /\/login$/],
    ['/login', 'Welcome back', 'Create an account', /\/signup$/],
  ];
  try {
    for (const [from, heading, link, to] of cases) {
      await L.step(E, `Auth footer link "${link}" on ${from.split('?')[0]}${from.includes('token') ? ' (with token)' : ''} (re-check)`, async () => {
        await L.goto(p, from);
        await p.getByRole('heading', { level: 1, name: heading }).waitFor({ timeout: 30000 });
        await L.dismissBanner(p);
        const l = p.getByRole('link', { name: link, exact: true });
        const n = await l.count();
        if (!n) {
          const s = await L.shot(p, `E3_missing_${link}`);
          throw new Error(`no link "${link}" (${s})`);
        }
        await l.first().click();
        await p.waitForURL(to, { timeout: 10000 });
        return `-> ${p.url().replace(L.BASE, '')}`;
      });
    }
  } finally {
    await anon.close();
  }
}

module.exports = { run };
