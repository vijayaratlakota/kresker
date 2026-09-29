'use strict';
/*
  Local end-to-end browser check of the kresker.com frontend against the Node backend.

  Usage (backend on 8096 and Vite on 5174 must already be running — see REPORT.md):
      node run_all.js --stamp 0926190147 A B C1 D C2 E

  Areas run in the order given. State (accounts, job ids) is kept in _state.json so a
  later area can be re-run on its own against the same database.
*/
const L = require('./lib');

async function main() {
  const argv = process.argv.slice(2);
  const S = L.loadState();
  const i = argv.indexOf('--stamp');
  if (i >= 0) {
    S.stamp = argv[i + 1];
    argv.splice(i, 2);
  }
  if (!S.stamp) throw new Error('pass --stamp <MMddHHmmss> (the throwaway DB suffix)');
  // A new stamp means a new throwaway database: the accounts in _state.json do not exist there.
  const prev = L.loadState();
  if (prev.stamp && prev.stamp !== S.stamp) for (const k of Object.keys(S)) if (k !== 'stamp') delete S[k];
  const areas = argv.length ? argv : ['A', 'B', 'C1', 'D', 'C2', 'C3', 'E', 'ER', 'E2', 'E3', 'X', 'X2'];

  // SAFETY INTERLOCK. The admin Overview and GPU pages make the backend run the AWS CLI,
  // and "Force stop" runs `aws ec2 stop-instances` on the real GPU instance even with the
  // fake engine (REPORT.md, problem 3). Only run those areas against a backend started
  // with the AWS CLI removed from its PATH and VS_AWS_PROFILE pointing at nothing.
  const needsGuard = areas.filter((a) => ['B', 'BR', 'D', 'PROD', 'X'].includes(a));
  if (needsGuard.length && process.env.UI_CHECK_AWS_GUARD !== '1') {
    throw new Error(
      `areas ${needsGuard.join(', ')} open admin pages that make the backend call the AWS CLI. Start the backend with the AWS guard ` +
        '(see REPORT.md, "How it was run"), then set UI_CHECK_AWS_GUARD=1 to confirm you did.',
    );
  }

  const health = await fetch(L.BASE + '/api/health').catch((e) => ({ ok: false, status: String(e) }));
  if (!health.ok) throw new Error(`frontend/backend not reachable at ${L.BASE}: ${health.status}`);

  const browser = await L.launch();
  console.log('browser', browser.version());
  try {
    for (const a of areas) {
      const mod = {
        A: './area_a',
        B: './area_b',
        BR: './area_br',
        C1: './area_c1',
        D: './area_d',
        C2: './area_c2',
        C3: './area_c3',
        E: './area_e',
        ER: './area_er',
        PROD: './area_prod',
        X: './area_x',
        E2: './area_e2',
        E3: './area_e3',
        X2: './area_x2',
      }[a];
      if (!mod) throw new Error(`unknown area ${a}`);
      console.log(`\n===== area ${a} =====`);
      try {
        await require(mod).run(browser, S);
      } catch (e) {
        L.record(a, 'area aborted', 'FAIL', String((e && e.stack) || e).split('\n').slice(0, 4).join(' / '));
      }
      L.saveState(S);
      L.saveAll();
    }
  } finally {
    L.saveState(S);
    L.saveAll();
    await browser.close();
  }
  const blockedHosts = [...new Set(L.blocked.map((b) => new URL(b.url).host))];
  console.log('\nblocked non-local hosts this run:', blockedHosts.join(', ') || 'none');
  const fail = L.results.filter((r) => r.status === 'FAIL').length;
  console.log(`results so far: ${L.results.length} rows, ${fail} FAIL`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
