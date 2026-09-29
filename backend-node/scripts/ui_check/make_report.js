'use strict';
/*
  Builds REPORT.md from results.json + problems.md.

  Row rules, applied in this order, so nothing is hidden silently:
    1. MANUAL below: rows discarded or merged by hand, each with its reason.
    2. Same area+item recorded twice -> the later row wins (a re-run of the same step).
    3. A row whose item is "X (re-check…)" supersedes the row "X" — the first attempt
       failed because of the test script, not the product (reason given in the table
       footnote and in the re-check row itself).
  Superseded rows are listed at the end of the report.
*/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'results.json'), 'utf8')).map((r, i) => ({ ...r, idx: i }));

const MANUAL = [
  { item: 'Verify page with a bogus token shows "That link did not work"', why: 'same failure as the E evidence row (which has the screenshot) and the production-build row' },
  { item: 'Contact page "Data rights request" (erasure) is filed with a deadline', why: 'script read a <main> the page does not have; the re-check row confirms both submissions reached the inbox and both acknowledgement mails exist' },
  { item: 'Auth page footer links: signup "Sign in", verify "Sign in", reset-with-token "Need a new link?"', why: 'script waited on a stale heading; re-checked link by link (five "Auth footer link" rows)' },
  { item: 'Close account (customer who has a dub): what the UI shows', why: 'second attempt of the same erasure, merged into the "Close account: correct password + DELETE" row' },
];
const RENAME = {
  '/openapi.json and /docs through the site origin': {
    item: '/openapi.json through the site origin',
    note: '/openapi.json -> 200 with 84 paths (the /docs half is its own row)',
  },
};
const NOTE = {
  'Overview page (/app/admin) (re-check)':
    'all 8 stat cards present (Collected all time, Today, This week, Subscribers, Accounts, Signed in now, Jobs today, In flight); GPU card shows "AWS says unknown" because this run hid the AWS CLI from the backend (shots/043_B_overview_recheck.png)',
  'Close account: correct password + DELETE erases the account':
    'POST /api/privacy/erase -> 500 {"detail":"Something went wrong on our side.","reference":"fe0a67fc81b6"} (second attempt: reference fc89783ce426). The page shows the red note "Something went wrong on our side."; the account stays signed in (/api/auth/me 200) and its uploads/jobs rows remain, but the source video file was already deleted from disk. Backend log: SqliteError: FOREIGN KEY constraint failed at wipe (dist/routers/privacy.js:359) (shots/073_C_erase_500.png)',
  'After erasure: "Sign out" button, account_erased mail, sign-in refused':
    'Cannot pass: the erasure above failed, so there is no "Done" card, no account_erased mail for this address, and signing in with the new password still works (POST /api/auth/login 200 in the backend log).',
};
const KIND = [
  [/Force stop" — accepted/, 'bug (safety)'],
  [/Maintenance: a separate signed-out browser|signed-out visitor during maintenance/, 'bug'],
  [/Run SELECT/, 'bug'],
  [/admin UI control|Refund button/, 'missing UI'],
  [/sessions list/, 'missing UI'],
  [/confirmation link from the outbox|bogus token \(evidence/, 'dev server only'],
  [/job_done email|job_failed email/, 'bug'],
  [/correct password \+ DELETE|After erasure/, 'bug (critical)'],
  [/Prefer email/, 'bug (config-dependent)'],
  [/CSRF like the other/, 'security hardening'],
  [/\/docs \(Swagger UI\)/, 'bug (dev-only page)'],
  [/Remove this file/, 'privacy / retention'],
];

// ── apply the rules ─────────────────────────────────────────────────────────
// `pos` is where a row is listed: a re-check takes the place of the attempt it replaces.
const superseded = [];
let kept = rows.filter((r) => {
  r.pos = r.idx;
  const m = MANUAL.find((x) => x.item === r.item);
  if (m) superseded.push({ ...r, why: m.why });
  return !m;
});
const lastIdx = new Map();
const firstIdx = new Map();
for (const r of kept) {
  lastIdx.set(`${r.area}|${r.item}`, r.idx);
  if (!firstIdx.has(`${r.area}|${r.item}`)) firstIdx.set(`${r.area}|${r.item}`, r.idx);
}
kept = kept.filter((r) => {
  const keep = lastIdx.get(`${r.area}|${r.item}`) === r.idx;
  if (!keep) superseded.push({ ...r, why: 'the same step was run again later; the later result is the one counted' });
  else r.pos = firstIdx.get(`${r.area}|${r.item}`);
  return keep;
});
const REASON = {
  'Your data: sessions list / sign out other sessions':
    'the first check was too loose (it matched the sidebar "Sign out"); the stricter check inside the page body is the one counted',
  'GPU "Force stop" — accepted':
    'same outcome as the re-check; the first attempt also counted the product\'s own confirm() dialog as an error',
};
kept = kept.filter((r) => {
  const re = kept.find((x) => x.idx > r.idx && x.item.startsWith(`${r.item} (re-check`));
  if (re) {
    const why = /\b409\b/.test(r.note || '')
      ? 'accidental second run of this area with an address that was already registered (409); the re-check with a fresh account is counted'
      : REASON[r.item] ||
        (re.status === 'PASS'
          ? `re-checked as "${re.item}" (PASS) — the first attempt failed on a test-script problem`
          : `re-checked as "${re.item}" (${re.status}); the re-check is the one counted`);
    superseded.push({ ...r, why });
    // a re-check in the same area takes the original's place in the table
    if (re.area === r.area) re.pos = Math.min(re.pos, r.pos);
  }
  return !re;
});
kept.sort((a, b) => a.pos - b.pos || a.idx - b.idx);
// The note's machine suffixes: the one blocked host is explained once, at the top.
for (const r of kept) {
  const hadEnv = / \| env-blocked: /.test(r.note || '');
  r.note = String(r.note || '').replace(/ \| env-blocked: .*$/, '');
  if (hadEnv) r.note += ' [demo-reel video request to the R2 host blocked by the test guard]';
}
for (const r of kept) {
  if (RENAME[r.item]) Object.assign(r, RENAME[r.item]);
  if (NOTE[r.item]) r.note = NOTE[r.item];
  if (r.status === 'FAIL') r.kind = (KIND.find(([re]) => re.test(r.item)) || [null, 'bug'])[1];
}

// ── render ──────────────────────────────────────────────────────────────────
const AREAS = [
  ['A public', 'A. Signed out — public pages'],
  ['B admin', 'B. Admin account and admin panel'],
  ['C user', 'C. Regular account, end to end'],
  ['D admin actions', 'D. Back as admin — refund, plans, suspension, sessions'],
  ['E extras', 'E. Everything else'],
  ['P prod build', 'P. Production build cross-check (vite build + vite preview on :5175)'],
];
const esc = (s) => String(s || '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const pass = kept.filter((r) => r.status === 'PASS').length;
const fail = kept.filter((r) => r.status === 'FAIL').length;
const byKind = {};
for (const r of kept.filter((x) => x.status === 'FAIL')) byKind[r.kind] = (byKind[r.kind] || 0) + 1;

let md = '';
md += `# kresker.com — local end-to-end browser check\n\n`;
md += `**${pass} passed / ${fail} failed** (${kept.length} checks, run ${rows[0].at.slice(0, 10)} against the Node backend with the fake engine). `;
md += `Failures by kind: ${Object.entries(byKind)
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${n} ${k}`)
  .join(', ')}.\n\n`;
md += fs.readFileSync(path.join(ROOT, 'report_head.md'), 'utf8').trim() + '\n\n';
md += `## Results\n\n`;
for (const [area, title] of AREAS) {
  const list = kept.filter((r) => r.area === area);
  if (!list.length) continue;
  const p = list.filter((r) => r.status === 'PASS').length;
  md += `### ${title} — ${p}/${list.length} passed\n\n`;
  md += `| # | Item | Result | Note |\n|---|---|---|---|\n`;
  list.forEach((r, i) => {
    const res = r.status === 'PASS' ? 'PASS' : `**FAIL** (${r.kind})`;
    const flat = String(r.note || '').replace(/\s+/g, ' ').trim();
    md += `| ${area[0]}${i + 1} | ${esc(r.item)} | ${res} | ${esc(trim(flat, 420))} |\n`;
  });
  md += '\n';
}
md += fs.readFileSync(path.join(ROOT, 'problems.md'), 'utf8').trim() + '\n\n';
md += `## Appendix — rows not counted (${superseded.length})\n\n`;
md += `These are earlier attempts that were re-run, or duplicates merged by hand. Kept here so nothing is hidden.\n\n`;
md += `| Area | Item (first attempt) | Result then | Why it is not counted |\n|---|---|---|---|\n`;
for (const r of superseded.sort((a, b) => a.idx - b.idx)) md += `| ${esc(r.area)} | ${esc(r.item)} | ${r.status} | ${esc(r.why)} |\n`;
fs.writeFileSync(path.join(ROOT, 'REPORT.md'), md);
console.log(`REPORT.md written: ${pass} passed / ${fail} failed (${kept.length} counted, ${superseded.length} superseded)`);
console.log(JSON.stringify(byKind));
