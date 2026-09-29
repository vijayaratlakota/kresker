/**
 * The GPU watchdog, as a standalone process.
 *
 * WHY THIS EXISTS SEPARATELY. The backend runs this same check every 60 seconds, which
 * covers the normal case. It does not cover the case that actually costs money: the
 * backend NOT running. Stop it, point it at another database, let it crash, close the
 * laptop lid — and nothing is left watching a box that bills by the hour.
 *
 * So this is the same decision in its own process, driven by the scheduler rather than
 * by the API being alive. Safe alongside the backend: both answer from `holdReason()`,
 * which reads only the database, and stopping an already-stopping instance is harmless.
 *
 *   node dist/watchdog.js            evaluate once and act
 *   node dist/watchdog.js --dry-run  say what it would do, change nothing
 *   node dist/watchdog.js --status   print the full state and exit
 */
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// The configuration is read when the modules below load, so the environment is settled
// first and they are required afterwards (an `import` would load them before this runs).

// The watchdog only ever has a job to do against the REAL box.
if (!process.env.VS_ENGINE_MODE) process.env.VS_ENGINE_MODE = 'real';

// VS_DB_PATH IS NOT DEFAULTED, AND THAT IS THE WHOLE POINT. A scheduled copy on the
// operator's laptop once picked up a local file that merely shared production's name,
// found nothing holding the box, and stopped a GPU a paying customer's dub was waiting
// on — every five minutes. A wrong database that exists is indistinguishable from an
// idle one, so the path must be stated by whoever schedules this, never inferred.
function refuseWithoutDbPath(): void {
  if (!process.env.VS_DB_PATH) {
    console.log(
      'REFUSING: VS_DB_PATH is not set. This script stops a machine that bills by the hour, and it decides that purely from a database - so it must be told exactly which one, rather than guessing from its own location. Point it at the database the live backend is using.',
    );
    process.exit(2);
  }
}

type Gpu = typeof import('./gpu');
type Config = typeof import('./config');
type Py = typeof import('./py');

let logFile: string | null = null;
let stamp: () => string = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function log(line: string): void {
  const text = `${stamp()}  ${line}`;
  console.log(text);
  if (!logFile) return;
  try {
    // Python's text mode writes the platform's line ending.
    appendFileSync(logFile, text + (process.platform === 'win32' ? '\r\n' : '\n'), 'utf8');
  } catch {
    // a watchdog that dies because it cannot log is worse
  }
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const config = require('./config') as Config;
  const py = require('./py') as Py;
  logFile = path.join(config.DATA_DIR, 'watchdog.log');
  stamp = () => py.fmtStamp(new Date());

  // No schema creation here. This process must never be the thing that creates a
  // database: an empty one would look exactly like "no work in flight".
  const dbPath = process.env.VS_DB_PATH as string;
  if (!existsSync(dbPath)) {
    log(`REFUSING: no database at ${dbPath}. An empty database is indistinguishable from an idle one, so this is not safe to guess at.`);
    return 2;
  }

  const gpu = require('./gpu') as Gpu;
  /* eslint-enable @typescript-eslint/no-require-imports */

  if (args.has('--status')) {
    console.log(py.pyDumps(await gpu.state(), { indent: 2 }));
    return 0;
  }

  if (!gpu.enabled()) {
    log('nothing to do: lifecycle disabled or not in real mode');
    return 0;
  }

  const hold = gpu.holdReason();
  const [actual, ip] = await gpu.describe(true);

  if (hold) {
    log(`instance is ${actual}; leaving it alone: ${hold}`);
    return 0;
  }

  if (actual !== 'running') {
    // Only worth a line when it is not the boring steady state.
    if (actual !== 'stopped') log(`nothing holding it, instance is ${actual}; no action`);
    return 0;
  }

  if (args.has('--dry-run')) {
    log(`WOULD STOP ${config.GPU_INSTANCE_ID}: running at ${py.pyStr(ip)}, nothing holding it`);
    return 0;
  }

  const out = await gpu.maybeStop();
  if (out.acted) {
    log(`STOPPED ${config.GPU_INSTANCE_ID} (was running at ${py.pyStr(ip)}): ${py.pyStr(out.why)}`);
  } else {
    // maybeStop re-checks under a lock, so a job that arrived in the last moment lands
    // here rather than losing a render
    log(`stood down: ${py.pyStr(out.why)}`);
  }
  return 0;
}

refuseWithoutDbPath();
main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const name = e instanceof Error ? e.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    log(`ERROR ${name}: ${msg}`);
    process.exit(1);
  },
);
