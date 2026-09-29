/**
 * Automatic GPU instance lifecycle.
 *
 *   START  when a dub is asked for, and at no other time. Creating a job wakes the box
 *          once the minutes are charged; the worker wakes it again, waiting, when it
 *          claims one. (It used to start on upload, and every abandoned tab paid for a
 *          machine that bills by the hour.)
 *
 *   STOP   when no job is working or queued, the last work finished at least
 *          GPU_IDLE_MINUTES ago, and the instance is actually running.
 *
 * A running instance is not a running application: the container does not always come
 * back on boot, so the gate is "/sysinfo answers", and if it does not, the EXISTING
 * container is started. Nothing on the box is rebuilt or edited — the dubbing engine
 * belongs to the GPU machine and this module only switches it on and off.
 */
import type { ChildProcess } from 'node:child_process';
import {
  AWS_PROFILE,
  AWS_REGION,
  ENGINE_MODE,
  ENGINE_PORT,
  GPU_APP_TIMEOUT_S,
  GPU_AUTO,
  GPU_BOOT_TIMEOUT_S,
  GPU_CONTAINER_ID,
  GPU_IDLE_MINUTES,
  GPU_INSTANCE_ID,
  GPU_USE_PRIVATE_IP,
  SSH_EXE,
  SSH_KEY,
  SSH_USER,
  UPLOAD_GRACE_MINUTES,
} from './config';
import * as db from './db';
import { Mutex } from './mutex';
import * as procs from './procs';
import { errText, fmtStamp, pyFixed, pySlice, pyStrip, sleep } from './py';

const lock = new Mutex();
let tunnel: ChildProcess | null = null;
let tunnelIp: string | null = null;
let watchStop = false;
let watchTimer: NodeJS.Timeout | null = null;
let watchRunning = false;

// describe-instances is cached briefly, so an open dashboard cannot rate-limit the
// account by polling.
const cache: { at: number; state: string | null; ip: string | null } = { at: 0, state: null, ip: null };
const CACHE_S = 20.0;

let lastHoldReason = 'not evaluated yet';

/** Only a real box is managed. There is nothing to start in fake mode. */
export function enabled(): boolean {
  return GPU_AUTO && ENGINE_MODE === 'real';
}

// ── AWS ───────────────────────────────────────────────────────────────────────

/** One AWS CLI call: [exit code, stdout, stderr]. Exported for the admin force-stop. */
export async function aws(args: string[], timeoutS = 120.0): Promise<[number, string, string]> {
  const cmd = ['aws', ...args, '--profile', AWS_PROFILE, '--region', AWS_REGION];
  try {
    const p = await procs.run(cmd, { timeoutMs: timeoutS * 1000 });
    return [p.code ?? 1, pyStrip(p.stdout || ''), pyStrip(p.stderr || '')];
  } catch (e) {
    return [1, '', errText(e)];
  }
}

/**
 * [state, address] as AWS reports it — never our own desired_state. The PRIVATE address
 * when VS_GPU_USE_PRIVATE_IP=1 (the web server, inside the VPC, where security-group
 * rules only match private traffic); the public one otherwise (a laptop).
 */
export async function describe(force = false): Promise<[string, string | null]> {
  const now = Date.now() / 1000;
  if (!force && now - cache.at < CACHE_S && cache.state) return [cache.state, cache.ip];
  const field = GPU_USE_PRIVATE_IP ? 'PrivateIpAddress' : 'PublicIpAddress';
  const [rc, out] = await aws(
    ['ec2', 'describe-instances', '--instance-ids', GPU_INSTANCE_ID, '--query', `Reservations[0].Instances[0].[State.Name,${field}]`, '--output', 'text'],
    60,
  );
  if (rc !== 0) return ['unknown', null];
  const parts = out.split(/\s+/).filter(Boolean);
  const state = parts[0] ?? 'unknown';
  const ip = parts.length > 1 && parts[1] !== 'None' && parts[1] !== '' ? parts[1] : null;
  cache.at = now;
  cache.state = state;
  cache.ip = ip;
  return [state, ip];
}

function setDesired(value: string): void {
  db.execute('UPDATE gpu_state SET instance_id=?, desired_state=?, updated_at=? WHERE id=1', [GPU_INSTANCE_ID, value, db.now()]);
}

export function noteWorkFinished(): void {
  db.execute('UPDATE gpu_state SET last_work_finished_at=?, updated_at=? WHERE id=1', [db.now(), db.now()]);
}

export function noteRunning(): void {
  db.execute('UPDATE gpu_state SET last_seen_running_at=?, updated_at=? WHERE id=1', [db.now(), db.now()]);
}

// ── the SSH tunnel ────────────────────────────────────────────────────────────

// Where ssh throws away host keys: "NUL" is only the null device on Windows.
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** The ssh PROCESS is running — not the same as the tunnel carrying anything. */
function tunnelAlive(): boolean {
  return procs.alive(tunnel);
}

async function killTunnel(): Promise<void> {
  const t = tunnel;
  tunnel = null;
  tunnelIp = null;
  if (!t || !procs.alive(t)) return;
  try {
    t.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((r) => t.once('exit', () => r(true))),
      sleep(10_000).then(() => false),
    ]);
    if (!exited) t.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Forward the engine port over SSH. A tunnel to a stale address goes first. */
async function openTunnel(ip: string): Promise<void> {
  if (tunnelAlive() && tunnelIp === ip) return;
  // Somebody else's tunnel already works: leave it alone rather than fight over the port.
  if (!tunnelAlive() && (await engineAnswers(4.0))) return;
  await killTunnel();
  const cmd = [
    SSH_EXE, '-i', SSH_KEY,
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${NULL_DEVICE}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=6',
    '-o', 'ExitOnForwardFailure=yes',
    '-N', '-L', `${ENGINE_PORT}:127.0.0.1:${ENGINE_PORT}`,
    `${SSH_USER}@${ip}`,
  ];
  tunnel = procs.popen(cmd, { quiet: true });
  tunnelIp = ip;
  await sleep(4000);
}

async function ssh(ip: string, remoteCmd: string, timeoutS = 90.0): Promise<[number, string]> {
  const cmd = [SSH_EXE, '-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${NULL_DEVICE}`, '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=15', `${SSH_USER}@${ip}`, remoteCmd];
  try {
    const p = await procs.run(cmd, { timeoutMs: timeoutS * 1000 });
    return [p.code ?? 1, pyStrip(p.stdout || '')];
  } catch (e) {
    return [1, errText(e)];
  }
}

export async function engineAnswers(timeoutS = 8.0): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/sysinfo`, { signal: AbortSignal.timeout(timeoutS * 1000) });
    await r.arrayBuffer().catch(() => undefined);
    return r.status === 200;
  } catch {
    return false;
  }
}

// ── bringing it up ────────────────────────────────────────────────────────────

/**
 * Make the engine reachable. Safe to call from anywhere, any number of times.
 * `block=false` returns at once and warms up in the background.
 */
export async function ensureRunning(reason = '', block = true, onStep: ((m: string) => void) | null = null): Promise<boolean> {
  if (!enabled()) return engineAnswers();

  if (!block) {
    void ensureRunning(reason, true, onStep).catch((e) => console.error('[gpu] warm-up failed:', e));
    return false;
  }

  // The print is not decoration: a background warm-up has no callback, and the boot of
  // a machine that bills by the hour must be readable in the journal.
  const step = (m: string): void => {
    console.log(`[gpu] ${reason || 'wake'}: ${m}`);
    if (onStep) {
      try {
        onStep(m);
      } catch {
        /* the caller's problem */
      }
    }
  };

  return lock.run(async () => {
    // Already good? Test the ENGINE, not our ownership of the tunnel: a forward opened by
    // hand in another window is fine.
    if (await engineAnswers()) {
      setDesired('running');
      noteRunning();
      return true;
    }

    setDesired('running');
    let [state, ip] = await describe(true);
    step(`instance is ${state}`);

    if (state === 'stopping' || state === 'shutting-down') {
      // cannot start from stopping; wait it out
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline && state === 'stopping') {
        await sleep(10_000);
        [state, ip] = await describe(true);
      }
    }

    if (state !== 'running') {
      step('starting the GPU instance');
      const [rc, , err] = await aws(['ec2', 'start-instances', '--instance-ids', GPU_INSTANCE_ID, '--output', 'text'], 120);
      if (rc !== 0) {
        step(`start-instances failed: ${pySlice(err, 200)}`);
        return false;
      }
      const deadline = Date.now() + GPU_BOOT_TIMEOUT_S * 1000;
      while (Date.now() < deadline) {
        [state, ip] = await describe(true);
        if (state === 'running') break;
        step(`waiting for the instance (${state})`);
        await sleep(10_000);
      }
      if (state !== 'running') {
        step('the instance never reached running');
        return false;
      }
    }

    if (!ip) [state, ip] = await describe(true);
    if (!ip) {
      step('the instance has no public IP');
      return false;
    }
    step(`instance running at ${ip}`);
    noteRunning();

    // SSH up?
    let deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const [, out] = await ssh(ip, 'echo up', 30);
      if (pyStrip(out) === 'up') break;
      await sleep(8000);
    }

    await openTunnel(ip);

    // A running instance is not a running application. The address is re-read every
    // fifth pass: a stop/start underneath us moves it, and a tunnel to the old address
    // stays "alive" while carrying nothing.
    deadline = Date.now() + GPU_APP_TIMEOUT_S * 1000;
    let startedContainer = false;
    let passes = 0;
    while (Date.now() < deadline) {
      if (await engineAnswers()) {
        step('the dubbing engine is answering');
        // Start the idle clock from the moment the box became useful, or a box brought
        // up with nothing queued could be stopped a minute after a six-minute boot.
        noteWorkFinished();
        return true;
      }
      passes++;
      if (passes % 5 === 0) {
        const [curState, curIp] = await describe(true);
        if (curState !== 'running') {
          step(`the box is ${curState} again, not running; giving up on this attempt so it can be started afresh`);
          return false;
        }
        if (curIp && curIp !== ip) {
          step(`the box came back on a new address (${ip} -> ${curIp}); rebuilding the tunnel`);
          ip = curIp;
          await killTunnel();
          await openTunnel(ip);
          startedContainer = false;
        }
      }
      if (!tunnelAlive() || tunnelIp !== ip) await openTunnel(ip);
      if (!startedContainer) {
        step('engine not answering yet, starting the existing container');
        await ssh(ip, `sudo docker start ${GPU_CONTAINER_ID} >/dev/null 2>&1`, 90);
        startedContainer = true;
      }
      await sleep(8000);
    }
    step('the engine never answered');
    return false;
  });
}

// ── deciding whether to stop ──────────────────────────────────────────────────

function isoMinus(minutes: number): string {
  return fmtStamp(new Date(Date.now() - minutes * 60_000));
}

export const ACTIVE_STATES = ['claimed', 'preparing', 'transcribing', 'translating', 'rendering', 'exporting'];

/** Why the box must stay up, or null if it may be stopped. All from the database. */
export function holdReason(): string | null {
  const n = db.scalar(
    "SELECT COUNT(*) FROM jobs WHERE state IN ('claimed','preparing','transcribing','translating','rendering','exporting')",
    [],
    0,
  );
  if (n) return `${n} job(s) still working`;

  const q = db.scalar("SELECT COUNT(*) FROM jobs WHERE state='queued'", [], 0);
  if (q) return `${q} job(s) queued`;

  // An accepted upload with no job. Off by default: an upload is a file waiting for a
  // decision, not work in flight.
  if (UPLOAD_GRACE_MINUTES > 0) {
    const pending = db.scalar(
      'SELECT COUNT(*) FROM uploads u WHERE u.created_at >= ? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.upload_id = u.id)',
      [isoMinus(UPLOAD_GRACE_MINUTES)],
      0,
    );
    if (pending) return `${pending} upload(s) accepted in the last ${pyFixed(UPLOAD_GRACE_MINUTES, 0)} min with no job yet`;
  }

  const row = db.one('SELECT last_work_finished_at FROM gpu_state WHERE id=1');
  const last = row ? row.last_work_finished_at : null;
  if (last) {
    const cutoff = isoMinus(GPU_IDLE_MINUTES);
    if (last > cutoff) return `last work finished at ${last}, inside the ${pyFixed(GPU_IDLE_MINUTES, 0)} min idle window`;
  }
  return null;
}

/** Stop the instance if every condition allows it. */
export async function maybeStop(): Promise<Record<string, unknown>> {
  if (!enabled()) return { acted: false, why: 'auto lifecycle disabled' };

  let reason = holdReason();
  if (reason) {
    lastHoldReason = reason;
    return { acted: false, why: reason };
  }
  const [state] = await describe();
  if (state !== 'running') {
    lastHoldReason = `instance already ${state}`;
    return { acted: false, why: lastHoldReason };
  }

  return lock.run(async () => {
    // re-check under the lock; a job could have arrived in the meantime
    reason = holdReason();
    if (reason) {
      lastHoldReason = reason;
      return { acted: false, why: reason };
    }
    setDesired('stopped');
    await killTunnel();
    const [rc, out, err] = await aws(
      ['ec2', 'stop-instances', '--instance-ids', GPU_INSTANCE_ID, '--query', 'StoppingInstances[0].CurrentState.Name', '--output', 'text'],
      120,
    );
    await describe(true);
    lastHoldReason = 'stopped: idle';
    if (rc !== 0) return { acted: false, why: `stop failed: ${pySlice(err, 200)}` };
    return { acted: true, why: 'idle for long enough', state: out };
  });
}

/** Everything the admin panel needs, actual state included. */
export async function state(): Promise<Record<string, unknown>> {
  const [actual, ip] = await describe();
  const row = db.one('SELECT * FROM gpu_state WHERE id=1');
  const desired = row ? row.desired_state : 'unknown';
  return {
    enabled: enabled(),
    engine_mode: ENGINE_MODE,
    instance_id: GPU_INSTANCE_ID,
    actual_state: actual,
    desired_state: desired,
    diverged: Boolean(actual !== 'unknown' && desired !== 'unknown' && actual !== desired),
    public_ip: ip,
    tunnel_up: tunnelAlive(),
    // Ask the ENGINE, not whether we happen to own the tunnel process.
    engine_answers: await engineAnswers(5.0),
    idle_minutes: GPU_IDLE_MINUTES,
    upload_grace_minutes: UPLOAD_GRACE_MINUTES,
    last_seen_running_at: row ? row.last_seen_running_at : null,
    last_work_finished_at: row ? row.last_work_finished_at : null,
    hold_reason: holdReason(),
    last_watchdog_note: lastHoldReason,
  };
}

// ── the watchdog ──────────────────────────────────────────────────────────────

function schedule(ms: number): void {
  watchTimer = setTimeout(async () => {
    if (watchStop) return;
    watchRunning = true;
    try {
      if (enabled()) await maybeStop();
    } catch {
      /* never let the watchdog die */
    } finally {
      watchRunning = false;
    }
    if (!watchStop) schedule(60_000);
  }, ms);
  watchTimer.unref();
}

export function startWatchdog(): void {
  if (watchTimer && !watchStop) return;
  watchStop = false;
  // first pass after a short delay, so startup does not race the worker
  schedule(45_000);
}

export function stopWatchdog(): void {
  watchStop = true;
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  void watchRunning;
}

export async function shutdownTunnel(): Promise<void> {
  await killTunnel();
}

/**
 * Readiness for a SIGNED-IN customer: 'ready' | 'starting' | 'idle' | 'demo'. Words
 * about the service, never about its parts.
 */
export function publicServiceState(engineReachable: boolean): string {
  if (!enabled()) return engineReachable ? 'ready' : 'demo';
  if (engineReachable) return 'ready';
  let desired: string;
  try {
    const row = db.one('SELECT desired_state FROM gpu_state WHERE id=1');
    desired = (row ? row.desired_state : null) || 'stopped';
  } catch {
    return 'idle';
  }
  if (desired === 'running') return 'starting';
  if (cache.state === 'pending' || cache.state === 'running') return 'starting';
  return 'idle';
}

/**
 * One word for the operator's sidebar: 'demo' | 'connected' | 'starting' | 'asleep'.
 * Never calls describe(): /api/health is polled by every open dashboard.
 */
export function publicEngineState(engineReachable: boolean): string {
  if (!enabled()) return engineReachable ? 'connected' : 'demo';
  if (engineReachable) return 'connected';
  let desired: string;
  try {
    const row = db.one('SELECT desired_state FROM gpu_state WHERE id=1');
    desired = (row ? row.desired_state : null) || 'stopped';
  } catch {
    return 'asleep';
  }
  if (desired === 'running') return 'starting';
  if (cache.state === 'pending' || cache.state === 'running') return 'starting';
  return 'asleep';
}

export { GPU_IDLE_MINUTES };
