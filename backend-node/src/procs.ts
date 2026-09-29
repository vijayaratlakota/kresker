/**
 * Running external tools: ffmpeg, ffprobe, the AWS CLI, ssh, icacls.
 *
 * ── TWO RULES, AND EACH ONE IS A BUG THAT ALREADY HAPPENED ONCE ──────────────
 *
 * 1. NO CONSOLE WINDOWS. On Windows, starting a console program from a process without
 *    a console makes the OS open one, so a black window flashed up for every AWS call
 *    the GPU watchdog made — every minute, all day. `windowsHide: true` is Node's
 *    spelling of Python's CREATE_NO_WINDOW. It is set here so no caller can forget it.
 *
 * 2. NEVER BLOCK THE EVENT LOOP. This is the rule the Python backend did not need. A
 *    FastAPI endpoint written as a plain function runs on a thread pool, so an ffmpeg
 *    call that takes four seconds only holds up its own request. Node runs every request
 *    on ONE thread: a synchronous child process there freezes the whole site — every
 *    login, every progress poll — for as long as the child runs. So everything here is
 *    asynchronous, and there is deliberately no `runSync`.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  /** The exit code, or null if the process was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunBufferResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface RunOptions {
  /** Kill the child and reject with a TimeoutExpired error after this long. */
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  input?: string | Buffer;
}

/** The error a timed-out run rejects with. Named after Python's, so logs read the same. */
export class TimeoutExpired extends Error {
  override name = 'TimeoutExpired';
  constructor(cmd: string[], ms: number) {
    super(`Command '${cmd.join(' ')}' timed out after ${ms / 1000} seconds`);
  }
}

/** A missing executable. Named after Python's FileNotFoundError. */
export class FileNotFoundError extends Error {
  override name = 'FileNotFoundError';
}

function start(cmd: string[], opts: RunOptions): ChildProcess {
  if (!cmd.length) throw new Error('empty command');
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  return spawn(cmd[0], cmd.slice(1), spawnOpts);
}

function collect(
  cmd: string[],
  opts: RunOptions,
  asBuffer: boolean,
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = start(cmd, opts);
    } catch (e) {
      reject(e);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e: NodeJS.ErrnoException) => {
      done(() => {
        if (e.code === 'ENOENT') {
          reject(new FileNotFoundError(`[Errno 2] No such file or directory: '${cmd[0]}'`));
        } else {
          reject(e);
        }
      });
    });
    child.on('close', (code) => {
      done(() =>
        resolve({
          code,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        }),
      );
    });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(() => reject(new TimeoutExpired(cmd, opts.timeoutMs!)));
      }, opts.timeoutMs);
    }

    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
    void asBuffer;
  });
}

/** subprocess.run(cmd, capture_output=True, text=True). */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await collect(cmd, opts, false);
  return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
}

/** The same, with stdout kept as bytes — for tools that write binary output. */
export async function runBuffer(cmd: string[], opts: RunOptions = {}): Promise<RunBufferResult> {
  return collect(cmd, opts, true);
}

/**
 * subprocess.Popen, for the one long-lived child: the SSH tunnel to the GPU box.
 * The caller owns the returned process and must kill it.
 */
export function popen(
  cmd: string[],
  opts: Omit<RunOptions, 'input' | 'timeoutMs'> & { quiet?: boolean } = {},
): ChildProcess {
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    // quiet = stdout and stderr to the null device, like subprocess.DEVNULL: a long-
    // lived child writing into a pipe nobody reads would eventually block on it.
    stdio: opts.quiet ? 'ignore' : ['ignore', 'pipe', 'pipe'],
  });
  // A missing executable surfaces as an 'error' event; without a listener that would
  // be an uncaught exception. The caller sees it as a child that has exited.
  child.on('error', () => {});
  return child;
}

/** Is this child still running? (Popen.poll() is None) */
export function alive(child: ChildProcess | null | undefined): boolean {
  return !!child && child.exitCode === null && child.signalCode === null && child.pid !== undefined;
}

export const IS_WINDOWS = process.platform === 'win32';
