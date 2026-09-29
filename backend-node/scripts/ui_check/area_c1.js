'use strict';
/* AREA C, part 1 — a regular account: sign up, confirm, dub, play, download, billing, privacy. */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const C = 'C user';

async function run(browser, S) {
  S.user = S.user || { email: `ui-user-${S.stamp}@example.com`, password: `Ui-User-${S.stamp}-pw1` };
  const U = S.user;
  const ctx = await L.newContext(browser, 'user');
  const page = await L.newPage(ctx);
  const admin = await L.newContext(browser, 'admin-side', { storageState: S.adminState });

  // ── signup and confirmation ───────────────────────────────────────────────
  let tSignup = Date.now() - 1500;
  await L.step(C, 'Sign up in the UI -> "Check your inbox" (confirm your email)', async () => {
    await L.goto(page, '/signup');
    await L.h1(page, 30000);
    await L.dismissBanner(page);
    await page.locator('#f-email').fill(U.email);
    await page.locator('#f-password').fill(U.password);
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/auth/register'));
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    const r = await resp;
    const j = await r.json();
    U.id = j.id;
    await page.getByRole('heading', { level: 1, name: 'Check your inbox' }).waitFor({ timeout: 15000 });
    const note = await page.getByRole('status').innerText();
    const s = await L.shot(page, 'C_check_inbox');
    const mail = await L.waitMail(U.email, 'verify_email', { after: tSignup });
    U.firstVerify = L.linkIn(mail.text, '/verify').hit;
    if (!note.includes(U.email)) throw new Error(`status note does not name the address: ${note}`);
    if (!j.verification_required) throw new Error('verification_required not set');
    return `register ${r.status()} verification_required=true; "${note.replace(/\s+/g, ' ').slice(0, 140)}"; mail ${mail.file} (${s})`;
  });
  await L.step(C, '"Send the link again" on the check-your-inbox panel', async () => {
    const t0 = Date.now() - 500;
    await page.getByRole('button', { name: 'Send the link again' }).click();
    await page.getByRole('button', { name: 'Sent again' }).waitFor({ timeout: 10000 });
    const disabled = await page.getByRole('button', { name: 'Sent again' }).isDisabled();
    const mail = await L.waitMail(U.email, 'verify_email', { after: t0 });
    return `button -> "Sent again" (disabled=${disabled}); new mail ${mail.file}`;
  });
  await L.step(
    C,
    'Sign in before confirming is refused with the confirm-your-email note (+ resend)',
    async () => {
      await L.goto(page, '/login');
      await L.h1(page);
      await page.locator('#f-email').fill(U.email);
      await page.locator('#f-password').fill(U.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const st = page.getByRole('status');
      await st.getByText(/Confirm your email address before signing in/).waitFor({ timeout: 10000 });
      const s = await L.shot(page, 'C_login_unconfirmed');
      const t0 = Date.now() - 500;
      await page.getByRole('button', { name: 'Send the link again' }).click();
      await page.getByText(/A new confirmation link is on its way/).waitFor({ timeout: 10000 });
      const mail = await L.waitMail(U.email, 'verify_email', { after: t0 });
      U.verifyLink = L.linkIn(mail.text, '/verify').hit;
      return `refused (403 email_not_confirmed) with the note; resend -> "A new confirmation link is on its way…", mail ${mail.file} (${s})`;
    },
    { allow: [{ kind: 'response', status: 403, url: /\/api\/auth\/login$/ }, { kind: 'console', text: /status of 403/, url: /\/api\/auth\/login$/ }] },
  );
  await L.step(C, 'Only the newest confirmation link works (first link rejected, via API)', async () => {
    const tok = new URL(U.firstVerify).searchParams.get('token');
    const probe = await L.newContext(browser, 'probe');
    try {
      const r = await L.api(probe, 'POST', '/api/auth/verify', { json: { token: tok }, csrf: false });
      if (r.status !== 400) throw new Error(`first link -> ${r.status} ${JSON.stringify(r.body)}`);
      return `first link -> 400 "${r.body.detail}"`;
    } finally {
      await probe.close();
    }
  });
  await L.step(C, 'Open the newest confirmation link from the outbox -> signed in, lands in /app', async () => {
    if (!U.verifyLink || !U.verifyLink.startsWith(L.BASE + '/verify?token=')) throw new Error(`link in mail: ${U.verifyLink}`);
    await L.goto(page, U.verifyLink);
    const landed = await page
      .waitForURL(/\/app\/?$/, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    const h = await L.h1(page).catch(() => '(no h1)');
    const body = (await L.text(page)).slice(0, 160);
    const s = await L.shot(page, 'C_verify_link');
    const me = await L.api(ctx, 'GET', '/api/auth/me');
    if (!landed) {
      return {
        status: 'FAIL',
        note: `after 15 s still on ${page.url().replace(L.BASE, '')} showing "${h}" / "${body}"; yet /api/auth/me -> ${me.status} (${
          me.status === 200 ? 'the backend DID confirm and sign in' : 'not signed in'
        }) (${s})`,
      };
    }
    return `landed on /app, /me ${me.status} email_verified=${me.body.email_verified} (${s})`;
  });

  // ── the dashboard ─────────────────────────────────────────────────────────
  await L.step(C, 'Dashboard: plan card, minutes, no admin menu, "Upgrade" link', async () => {
    await L.goto(page, '/app');
    await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 30000 });
    await L.dismissBanner(page);
    await L.sleep(1000);
    const body = ((await page.locator('body').textContent()) || '').replace(/\s+/g, ' ');
    const minutes = (body.match(/\d+\.\d\d of \d+ min left/) || [''])[0];
    const adminVisible = await page.getByRole('link', { name: 'Overview' }).isVisible().catch(() => false);
    const service = await page.locator('[data-service-state]').first().innerText().catch(() => '?');
    const me = await L.api(ctx, 'GET', '/api/auth/me');
    U.ent0 = me.body.entitlement;
    const s = await L.shot(page, 'C_dashboard', true);
    await page.getByRole('button', { name: 'Upgrade' }).click();
    await page.waitForURL(/\/app\/billing$/, { timeout: 10000 });
    await page.goBack();
    await page.getByRole('heading', { level: 1, name: 'Dubbing' }).waitFor({ timeout: 15000 });
    if (adminVisible) throw new Error('admin navigation visible to a regular user');
    if (minutes !== '1.00 of 1 min left') throw new Error(`sidebar says "${minutes}"`);
    return `sidebar "${minutes}", plan ${U.ent0.plan_name} (${U.ent0.max_video_seconds}s max), service line "${service.trim()}", no admin links; "Upgrade" -> /app/billing (${s})`;
  });

  // ── upload ────────────────────────────────────────────────────────────────
  await L.step(
    C,
    'Upload _realtest_30s.mp4 (file picker)',
    async () => {
      const upload = page.waitForResponse((r) => /\/api\/uploads$/.test(r.url()) && r.request().method() === 'POST', { timeout: 120000 });
      await page.locator('input[type="file"]').setInputFiles(L.VIDEO);
      const r = await upload;
      const j = await r.json();
      U.upload = j;
      await page.getByText('Left after this').waitFor({ timeout: 20000 });
      const facts = ((await page.locator('main').textContent()) || '').replace(/\s+/g, ' ');
      const s = await L.shot(page, 'C_uploaded');
      if (r.status() !== 200) throw new Error(`upload ${r.status()} ${JSON.stringify(j)}`);
      return `POST /api/uploads -> 200 duration ${j.duration_s}s minutes ${j.minutes}; page: "${(facts.match(/Length.{0,60}/) || [''])[0]}" (direct-to-storage presign answered 503 as expected with R2 off, the page fell back to multipart) (${s})`;
    },
    {
      allow: [
        { kind: 'response', status: 503, url: /\/api\/uploads\/presign$/ },
        { kind: 'console', text: /status of 503/, url: /\/api\/uploads\/presign$/ },
      ],
    },
  );
  await L.step(C, 'Language picker: search, pick Hindi, "None" clears, pick again', async () => {
    await page.getByText(/Select languages — \d+ available/).click();
    const search = page.getByLabel('Search languages');
    await search.waitFor({ timeout: 5000 });
    await search.fill('Hindi');
    await page.getByRole('option', { name: /^Hindi/ }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Remove Hindi' }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Dub into Hindi' }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'None', exact: true }).click();
    const off = await page.getByRole('button', { name: 'Pick a language' }).isDisabled();
    await page.getByText(/Select languages — \d+ available/).click();
    await page.getByLabel('Search languages').fill('hi');
    await page.getByRole('option', { name: /^Hindi/ }).click();
    await page.keyboard.press('Escape');
    const trig = await page.getByText(/1 of 8 selected/).count();
    const s = await L.shot(page, 'C_language');
    return `Hindi chip + "Dub into Hindi"; "None" -> disabled "Pick a language" (${off}); search by code "hi" works; trigger reads "1 of 8 selected" (${trig}) (${s})`;
  });
  await L.step(C, 'Start the dub and watch it to done', async () => {
    const t0 = Date.now() - 1000;
    const created = page.waitForResponse((r) => r.url().endsWith('/api/jobs') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Dub into Hindi' }).click();
    const r = await created;
    const j = await r.json();
    U.jobId = j.job_id;
    const toast = await L.toast(page, /Your dub is running/);
    await page.getByText('Dubbing into Hindi').waitFor({ timeout: 10000 });
    const s1 = await L.shot(page, 'C_dub_running');
    const started = Date.now();
    await page.getByText('Your dub is ready').waitFor({ timeout: 180000 });
    const took = Math.round((Date.now() - started) / 1000);
    const s2 = await L.shot(page, 'C_dub_ready');
    let mail = null;
    try {
      mail = await L.waitMail(U.email, 'job_done', { after: t0, timeout: 20000 });
      // The job's own page (it used to be `/?job=<id>`, the homepage).
      U.jobDoneLink = (mail.text.match(/https?:\/\/\S+\/app\/jobs\/[A-Za-z0-9]+/) || [])[0];
    } catch (e) {
      mail = { file: `(none: ${e.message})` };
    }
    return `POST /api/jobs -> ${r.status()} job ${j.job_id} charged ${j.minutes_charged} min; toast "${toast.slice(0, 60)}"; "Your dub is ready" after ~${took}s; job_done mail ${mail.file} (${s1}, ${s2})`;
  });
  await L.step(C, 'Recent dubs table lists the finished job', async () => {
    await page.getByRole('button', { name: 'Refresh' }).first().click();
    const row = page.getByRole('row').filter({ hasText: U.jobId });
    await row.waitFor({ timeout: 10000 });
    const t = (await row.innerText()).replace(/\s+/g, ' ');
    return `row: "${t.slice(0, 140)}"`;
  });

  // ── the job page ──────────────────────────────────────────────────────────
  await L.step(C, '"Open and download" -> job page with transcript and events', async () => {
    await page.getByRole('button', { name: 'Open and download' }).click();
    await page.waitForURL(new RegExp(`/app/jobs/${U.jobId}$`), { timeout: 10000 });
    await page.getByRole('heading', { level: 1, name: 'Dub into Hindi' }).waitFor({ timeout: 20000 });
    await page.getByText('Transcript and translation').waitFor({ timeout: 15000 });
    const body = ((await page.locator('main').textContent()) || '').replace(/\s+/g, ' ');
    const lines = (body.match(/(\d+) lines/) || [])[1];
    const s = await L.shot(page, 'C_job_page', true);
    return `badge ${/Ready/.test(body) ? 'Ready' : '?'}; ${(body.match(/Minutes used\s*\S+/) || [''])[0]}; ${(body.match(/File size\s*[\d.]+ \w+/) || [''])[0]}; transcript ${lines} lines; events section present=${/What happened, step by step/.test(body)} (${s})`;
  });
  await L.step(
    C,
    'Play the dub in the page (Playwright Chromium)',
    async () => {
      const v = page.locator('video[data-dub-player="video"]');
      await v.waitFor({ timeout: 20000 });
      const src = await v.getAttribute('src');
      const res = await v.evaluate(async (el) => {
        el.muted = true;
        let err = null;
        try {
          await el.play();
        } catch (e) {
          err = `${e.name}: ${e.message}`;
        }
        await new Promise((r) => setTimeout(r, 2500));
        return { err, t: el.currentTime, paused: el.paused, ready: el.readyState, code: el.error ? el.error.code : null, dur: el.duration };
      }).catch((e) => ({ gone: String(e.message).split('\n')[0] }));
      await L.sleep(800);
      const fallback = await page.getByText('Your browser could not play this file here').isVisible().catch(() => false);
      const s = await L.shot(page, 'C_player_chromium');
      U.playerChromium = { src, res, fallback };
      if (res.t > 0.5 && !res.code) return `src ${src.slice(0, 12)}…; played to ${res.t.toFixed(1)}s of ${res.dur}s (${s})`;
      return {
        status: 'FAIL',
        note: `src ${String(src).slice(0, 12)}…; result ${JSON.stringify(res)}; fallback note shown=${fallback} - Playwright's Chromium build has no H.264/AAC decoder, see the Chrome check (${s})`,
      };
    },
    { noiseOk: true },
  );
  await L.step(
    C,
    'Player "Audio only" tab',
    async () => {
      await page.getByRole('tab', { name: 'Audio only' }).click();
      const a = page.locator('audio[data-dub-player="audio"]');
      const ok = await a
        .waitFor({ timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      const src = ok ? await a.getAttribute('src') : null;
      const res = ok
        ? await a.evaluate(async (el) => {
            el.muted = true;
            let err = null;
            try {
              await el.play();
            } catch (e) {
              err = `${e.name}: ${e.message}`;
            }
            await new Promise((r) => setTimeout(r, 2000));
            return { err, t: el.currentTime, code: el.error ? el.error.code : null };
          })
        : null;
      const sel = await page.getByRole('tab', { name: 'Audio only' }).getAttribute('aria-selected');
      await page.getByRole('tab', { name: 'Video' }).click();
      return {
        status: ok ? (res && res.t > 0.3 ? 'PASS' : 'FAIL') : 'FAIL',
        note: `tab aria-selected=${sel}; audio element=${ok} src ${String(src).slice(0, 14)}…; play ${JSON.stringify(res)}`,
      };
    },
    { noiseOk: true },
  );

  // downloads
  const want = { video: /h264/, m4a: /aac/, mp3: /mp3/, wav: /pcm_s16le|pcm/ };
  U.downloads = {};
  for (const fmt of ['video', 'm4a', 'mp3', 'wav']) {
    await L.step(C, `Download menu: ${fmt}`, async () => {
      await page.getByRole('button', { name: 'Download' }).first().click();
      const item = page.locator(`[data-format="${fmt}"]`);
      await item.waitFor({ timeout: 10000 });
      const label = (await item.innerText()).trim();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), item.click()]);
      const name = dl.suggestedFilename();
      const file = path.join(L.ART, 'downloads', `${fmt}__${name}`);
      await dl.saveAs(file);
      const size = fs.statSync(file).size;
      const probe = L.ffprobe(file);
      const codecs = (probe.streams || []).map((s) => `${s.codec_type}:${s.codec_name}${s.tags && s.tags.language ? '[' + s.tags.language + ']' : ''}`).join(',');
      let toastText = '';
      if (fmt === 'wav') toastText = await L.toast(page, /WAV is uncompressed/).catch(() => '(no WAV toast)');
      U.downloads[fmt] = { name, size, codecs, duration: probe.format && probe.format.duration };
      await page.keyboard.press('Escape').catch(() => undefined);
      if (size < 5000 || !want[fmt].test(codecs)) throw new Error(`"${name}" ${size} bytes codecs ${codecs || JSON.stringify(probe)}`);
      return `menu item "${label}" -> "${name}" ${size} bytes, ${codecs}, ${Number(probe.format.duration).toFixed(1)}s${toastText ? `; toast "${toastText.slice(0, 80)}"` : ''}`;
    });
  }
  await L.step(C, 'Downloads counter on the job page went up', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Dub into Hindi' }).waitFor({ timeout: 20000 });
    const body = ((await page.locator('main').textContent()) || '').replace(/\s+/g, ' ');
    const n = Number((body.match(/Downloads\s*(\d+)/) || [])[1]);
    if (!(n >= 4)) throw new Error(`Downloads shows ${n}`);
    return `Downloads = ${n}`;
  });
  await L.step(C, 'Minutes used went down (sidebar + /api/auth/me)', async () => {
    const me = await L.api(ctx, 'GET', '/api/auth/me');
    const e = me.body.entitlement;
    U.ent1 = e;
    const body = ((await page.locator('body').textContent()) || '').replace(/\s+/g, ' ');
    const side = (body.match(/\d+\.\d\d of \d+ min left/) || [''])[0];
    const expectLeft = 1 - U.upload.minutes;
    if (Math.abs(e.minutes_left - expectLeft) > 0.01) throw new Error(`minutes_left ${e.minutes_left}, expected ~${expectLeft.toFixed(3)}`);
    if (side !== `${e.minutes_plan_left.toFixed(2)} of 1 min left`) throw new Error(`sidebar "${side}"`);
    return `before ${U.ent0.minutes_left} left -> after ${e.minutes_left.toFixed(3)} left (used ${e.minutes_used.toFixed(3)}); sidebar "${side}"`;
  });
  await L.step(
    C,
    'Play the dub in Google Chrome (codec-capable browser, same page, same guards)',
    async () => {
      let chrome = null;
      try {
        chrome = await L.launch({ channel: 'chrome' });
      } catch (e) {
        return { status: 'FAIL', note: `could not launch Chrome: ${String(e.message).split('\n')[0]}` };
      }
      try {
        const st = path.join(L.ART, 'user_state.json');
        await ctx.storageState({ path: st });
        const c2 = await L.newContext(chrome, 'user-chrome', { storageState: st });
        const p2 = await L.newPage(c2);
        await L.goto(p2, `/app/jobs/${U.jobId}`);
        await p2.getByRole('heading', { level: 1, name: 'Dub into Hindi' }).waitFor({ timeout: 30000 });
        const v = p2.locator('video[data-dub-player="video"]');
        await v.waitFor({ timeout: 20000 });
        const res = await v.evaluate(async (el) => {
          el.muted = true;
          let err = null;
          try {
            await el.play();
          } catch (e) {
            err = `${e.name}: ${e.message}`;
          }
          await new Promise((r) => setTimeout(r, 3000));
          return { err, t: el.currentTime, paused: el.paused, w: el.videoWidth, h: el.videoHeight, code: el.error ? el.error.code : null, dur: el.duration };
        });
        const s = await L.shot(p2, 'C_player_chrome');
        await p2.getByRole('tab', { name: 'Audio only' }).click();
        const a = p2.locator('audio[data-dub-player="audio"]');
        await a.waitFor({ timeout: 15000 });
        const ra = await a.evaluate(async (el) => {
          el.muted = true;
          try {
            await el.play();
          } catch (e) {
            return { err: e.name };
          }
          await new Promise((r) => setTimeout(r, 2500));
          return { t: el.currentTime, code: el.error ? el.error.code : null };
        });
        await c2.close();
        U.playerChrome = { res, ra };
        const ok = res.t > 1 && !res.code && ra.t > 0.5;
        return {
          status: ok ? 'PASS' : 'FAIL',
          note: `Chrome ${chrome.version()}: video played to ${res.t.toFixed(1)}s (${res.w}x${res.h}, duration ${res.dur}); audio-only played to ${Number(ra.t).toFixed(1)}s (${s})`,
        };
      } finally {
        await chrome.close();
      }
    },
    { noiseOk: true },
  );

  // ── library ───────────────────────────────────────────────────────────────
  await L.step(C, 'Library: row, filter chips, search, refresh, row "Get" menu', async () => {
    await page.getByRole('link', { name: 'Library' }).click();
    await page.waitForURL(/\/app\/library$/, { timeout: 10000 });
    await page.getByRole('heading', { level: 1, name: 'Library' }).waitFor({ timeout: 20000 });
    await page.getByRole('row').filter({ hasText: U.jobId }).waitFor({ timeout: 10000 });
    const chips = [];
    for (const f of ['running', 'done', 'failed', 'all']) {
      const b = page.getByRole('button', { name: new RegExp(`^${f}\\s*\\d+`) });
      await b.click();
      await L.sleep(400);
      const pressed = await b.getAttribute('aria-pressed');
      const rows = await page.getByRole('row').filter({ hasText: U.jobId }).count();
      chips.push(`${f}:pressed=${pressed},row=${rows}`);
    }
    await page.getByLabel('Search dubs').fill('Hindi');
    await L.sleep(400);
    const byLang = await page.getByRole('row').filter({ hasText: U.jobId }).count();
    await page.getByLabel('Search dubs').fill('zzzz');
    await page.getByText('Nothing matches that').waitFor({ timeout: 5000 });
    await page.getByLabel('Search dubs').fill('');
    await page.getByRole('button', { name: 'Refresh' }).click();
    const row = page.getByRole('row').filter({ hasText: U.jobId });
    await row.getByRole('button', { name: 'Get' }).click();
    await page.locator('[data-format="mp3"]').waitFor({ timeout: 10000 });
    const items = await page.locator('[data-format]').evaluateAll((els) => els.map((e) => e.getAttribute('data-format')));
    await page.keyboard.press('Escape');
    const s = await L.shot(page, 'C_library');
    const bad = chips.filter((c) => (c.startsWith('done') && !c.includes('row=1')) || (c.startsWith('running') && !c.includes('row=0')));
    if (bad.length) throw new Error(`filters wrong: ${chips.join(' ')}`);
    return `chips ${chips.join(' ')}; search "Hindi" -> ${byLang} row; "zzzz" -> "Nothing matches that"; row menu offers [${items.join(', ')}] (${s})`;
  });

  // ── billing ───────────────────────────────────────────────────────────────
  await L.step(C, 'Billing page: current plan, notice, plan list, top-ups message', async () => {
    await page.getByRole('link', { name: 'Plan & billing' }).click();
    await page.waitForURL(/\/app\/billing$/, { timeout: 10000 });
    await page.getByRole('heading', { level: 1, name: 'Plan & billing' }).waitFor({ timeout: 20000 });
    await page.getByRole('heading', { level: 3, name: 'Starter' }).waitFor({ timeout: 15000 });
    const body = ((await page.locator('main').textContent()) || '').replace(/\s+/g, ' ');
    const plans = await L.api(ctx, 'GET', '/api/billing/plans');
    const topups = await L.api(ctx, 'GET', '/api/billing/topups');
    const cards = await page.locator('h3').allInnerTexts();
    const buttons = await page.locator('main button').evaluateAll((bs) => bs.map((b) => `${b.innerText.trim()}${b.disabled ? '(disabled)' : ''}`).filter(Boolean));
    const s = await L.shot(page, 'C_billing', true);
    const warn = plans.body.warning || '';
    const problems = [];
    if (warn && !body.includes(warn.slice(0, 40))) problems.push('plans.warning not shown');
    if (!/0\.\d\d of 1 minutes left/.test(body)) problems.push('current plan minutes line missing');
    const tb = topups.body;
    const expectTop = !tb.available
      ? tb.message || 'Extra minutes are not available just now.'
      : !tb.open
        ? 'Paid plans are not open yet. You will be able to add minutes here when they are.'
        : null;
    if (expectTop && !body.includes(expectTop.slice(0, 50))) problems.push(`top-up message "${expectTop}" not shown`);
    if (problems.length) throw new Error(problems.join('; '));
    return `notice "${warn.slice(0, 60)}…"; current "${(body.match(/Free\s*Free\s*[\d.]+ of 1 minutes left/) || [''])[0]}"; plan cards [${cards.join(', ')}]; buttons [${buttons.join(' | ').slice(0, 220)}]; plans.open=${plans.body.open}; top-ups heading "${
      (body.match(/Topup Extra minutes|Top up[^.]{0,20}|Extra minutes/) || [''])[0]
    }" message "${topups.body.message}" (${s})`;
  });
  await L.step(C, 'Billing: pressing "Choose Starter" (test mode) shows "Paid plans are not open yet" and changes nothing', async () => {
    const b = page.getByRole('button', { name: 'Choose Starter' });
    if (await b.isDisabled()) return 'button disabled ("Not open yet") - checkout closed for this account';
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/billing/checkout'));
    await b.click();
    const r = await resp;
    const j = await r.json().catch(() => ({}));
    const t = await L.toast(page, /Paid plans are not open yet/);
    const me = await L.api(ctx, 'GET', '/api/billing/me');
    const s = await L.shot(page, 'C_billing_choose');
    if (!me.body.entitlement.is_free) throw new Error('plan changed after a test-mode checkout');
    return `POST /api/billing/checkout -> ${r.status()} live=${j.live} checkout_url=${j.checkout_url} order ${j.order_id || j.subscription_id}; toast "${t}"; still on ${me.body.entitlement.plan_name} (${s})`;
  });
  await L.step(C, 'Billing: Monthly / Annual toggle', async () => {
    await page.getByRole('button', { name: 'Annual', exact: true }).click();
    await page.getByRole('heading', { level: 3, name: 'Starter (annual)' }).waitFor({ timeout: 5000 });
    const note = await page.getByText('Why annual is a one-off payment.').isVisible();
    await page.getByRole('button', { name: 'Monthly', exact: true }).click();
    await page.getByRole('heading', { level: 3, name: 'Starter' }).waitFor({ timeout: 5000 });
    return `annual cards + "Why annual is a one-off payment." note (${note}); back to monthly`;
  });

  // ── privacy centre ────────────────────────────────────────────────────────
  await L.step(C, 'Your data (/app/privacy): consent toggles', async () => {
    await page.getByRole('link', { name: 'Your data' }).click();
    await page.waitForURL(/\/app\/privacy$/, { timeout: 10000 });
    await page.getByRole('heading', { level: 1, name: 'Your data' }).waitFor({ timeout: 20000 });
    await page.getByText('Necessary to provide the service').waitFor({ timeout: 15000 });
    const out = [];
    const toggles = page.locator('li').filter({ has: page.getByRole('button', { name: /^(Turn on|Withdraw)$/ }) });
    const n = await toggles.count();
    for (let i = 0; i < n; i++) {
      const li = toggles.nth(i);
      const label = (await li.locator('p').first().innerText()).trim();
      const btn = li.getByRole('button', { name: /^(Turn on|Withdraw)$/ });
      const before = (await btn.innerText()).trim();
      await btn.click();
      const t = await L.toast(page, before === 'Turn on' ? /Recorded/ : /Withdrawn/);
      await li.getByRole('button', { name: before === 'Turn on' ? 'Withdraw' : 'Turn on' }).waitFor({ timeout: 5000 });
      await li.getByRole('button', { name: before === 'Turn on' ? 'Withdraw' : 'Turn on' }).click();
      await L.toast(page, before === 'Turn on' ? /Withdrawn/ : /Recorded/);
      out.push(`"${label}": ${before} -> toast "${t.slice(0, 30)}" -> back`);
    }
    const s = await L.shot(page, 'C_privacy', true);
    if (!n) throw new Error('no optional consent toggles found');
    return `${n} optional purpose(s): ${out.join('; ')} (${s})`;
  });
  await L.step(C, 'Your data: consent history "Show N"', async () => {
    const b = page.getByRole('button', { name: /^Show \d+$/ });
    const label = (await b.innerText()).trim();
    await b.click();
    const rows = await page.locator('table tbody tr').count();
    await page.getByRole('button', { name: 'Hide' }).click();
    return `"${label}" -> ${rows} rows, "Hide" collapses`;
  });
  await L.step(C, 'Your data: "Download my data" export', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: 'Download my data' }).click()]);
    const name = dl.suggestedFilename();
    const file = path.join(L.ART, 'downloads', `export__${name}`);
    await dl.saveAs(file);
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    const keys = Object.keys(j);
    const leaks = /password_hash|token_sha256|scrypt\$/.test(raw);
    U.exportFile = file;
    if (leaks) throw new Error('export contains credential material');
    if (!j.account || j.account.email !== U.email) throw new Error('export account block missing/wrong');
    return `downloaded "${name}" (${raw.length} bytes) keys [${keys.join(', ')}]; jobs=${(j.jobs || []).length} sessions=${(j.sessions || []).length}; no hashes/tokens`;
  });
  await L.step(C, 'Your data: sessions list / sign out other sessions', async () => {
    const body = ((await page.locator('main').textContent()) || '').replace(/\s+/g, ' ');
    const hasSessions = /session/i.test(body) && (await page.getByRole('button', { name: /sign out|log out|end/i }).count()) > 0;
    return {
      status: hasSessions ? 'PASS' : 'FAIL',
      note: hasSessions
        ? 'session controls present'
        : 'No sessions list and no "sign out other devices" control on /app/privacy (or anywhere for a customer). Only the sidebar "Sign out" (this browser) exists; sessions appear only inside the JSON export and in the admin panel.',
    };
  });
  await L.step(C, 'Your data: "Ask here" link -> /contact?kind=correction', async () => {
    await page.getByRole('link', { name: 'Ask here' }).click();
    await page.waitForURL(/\/contact\?kind=correction$/, { timeout: 10000 });
    const sel = await page.locator('#rights-kind').inputValue();
    const email = await page.locator('#f-email').inputValue();
    await page.goBack();
    return `rights form pre-selected "${sel}", email pre-filled "${email}"`;
  });

  // ── job_done email link ───────────────────────────────────────────────────
  await L.step(C, 'Link in the job_done email opens the job', async () => {
    if (!U.jobDoneLink) throw new Error('no link captured from the job_done mail');
    await L.goto(page, U.jobDoneLink);
    await L.h1(page, 30000);
    await L.sleep(1500);
    const h = await L.h1(page);
    const at = page.url().replace(L.BASE, '');
    const s = await L.shot(page, 'C_job_done_link');
    if (!at.startsWith(`/app/jobs/${U.jobId}`)) return { status: 'FAIL', note: `mail link ${U.jobDoneLink.replace(L.BASE, '')} leaves the customer on ${at} ("${h.replace(/\s+/g, ' ')}"), not on their job (${s})` };
    return `-> ${at}`;
  });

  // ── delete the video early ────────────────────────────────────────────────
  await L.step(C, 'Job page "Delete now" (confirm) removes the video file', async () => {
    const q = await L.api(admin, 'POST', '/api/admin/db/query', { json: { sql: `SELECT output_path, upload_id FROM jobs WHERE id='${U.jobId}'` } });
    const rel = q.body.rows && q.body.rows[0] && q.body.rows[0].output_path;
    U.uploadId = q.body.rows && q.body.rows[0] && q.body.rows[0].upload_id;
    const up = await L.api(admin, 'POST', '/api/admin/db/query', { json: { sql: `SELECT stored_path FROM uploads WHERE id='${U.uploadId}'` } });
    U.uploadRel = up.body.rows && up.body.rows[0] && up.body.rows[0].stored_path;
    const abs = rel && (path.isAbsolute(rel) ? rel : path.join(L.DATA_DIR, rel));
    U.outputAbs = abs;
    const existedBefore = abs && fs.existsSync(abs);
    await L.goto(page, `/app/jobs/${U.jobId}`);
    await page.getByRole('heading', { level: 1, name: 'Dub into Hindi' }).waitFor({ timeout: 20000 });
    L.dialogPolicy.set(page, 'accept');
    const resp = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${U.jobId}/video`) && r.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Delete now' }).click();
    const r = await resp;
    L.dialogPolicy.set(page, 'dismiss');
    const t = await L.toast(page, /Video deleted/);
    await page.getByText(/This video was deleted by you/).waitFor({ timeout: 10000 });
    const still = await page.locator('video[data-dub-player]').count();
    const existsAfter = abs && fs.existsSync(abs);
    const s = await L.shot(page, 'C_deleted');
    // Is the endpoint CSRF-checked like every other state-changing route? Asked AFTER the
    // delete, so the probe cannot destroy anything: a checked route answers 403 first.
    const probe = await L.api(ctx, 'DELETE', `/api/jobs/${U.jobId}/video`, { csrf: false });
    U.deleteCsrfProbe = probe;
    if (existsAfter) throw new Error(`output file still on disk: ${abs}`);
    return `DELETE -> ${r.status()}; toast "${t}"; notice "This video was deleted by you…"; player gone (${still === 0}); ${rel} existed before=${existedBefore}, after=${existsAfter}; same DELETE with NO X-CSRF-Token -> ${probe.status} ${JSON.stringify(probe.body)} (${s})`;
  });

  S.userState = path.join(L.ART, 'user_state.json');
  await ctx.storageState({ path: S.userState });
  await admin.close();
  await ctx.close();
}

module.exports = { run };
