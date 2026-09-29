/**
 * The tracking gate.
 *
 * There is currently nothing to gate. The audit found no analytics vendor, no
 * pixel, no third-party CDN, no remote web font and no `localStorage` use anywhere
 * in this frontend — grep for `analytics|gtag|plausible|posthog|sentry|hotjar|
 * clarity|pixel|unpkg|jsdelivr|googleapis|gstatic` returns nothing. One cookie
 * exists, `vs_session`, and it is what keeps you signed in.
 *
 * So why does this file exist?
 *
 * Because the alternative was building a "manage your tracking preferences" dialog
 * for trackers that do not exist, which is consent theatre (decision D-1). The
 * useful thing to build instead is the *gate*: a single function that any future
 * tracker must ask before it may load, which returns `false` until somebody has
 * explicitly opted in. Adding a script tag to `index.html` bypasses it; adding one
 * through this module cannot ship switched-on by accident.
 *
 * `allowTracking()` is the whole enforcement surface. It defaults to refused, it
 * refuses when the stored value is malformed, and it refuses when the browser has no
 * storage at all.
 */

const KEY = 'vs_privacy_ack';

export interface Ack {
  /** Notice version the person was shown when they answered. */
  v: string;
  /** Their answer to the optional analytics purpose. Defaults to refused. */
  analytics: boolean;
  at: string;
}

function read(): Ack | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const a = parsed as Partial<Ack>;
    if (typeof a.v !== 'string') return null;
    // `analytics` must be a real boolean. Anything else — missing, a string,
    // truthy junk — resolves to refused rather than to "probably yes".
    return { v: a.v, analytics: a.analytics === true, at: String(a.at ?? '') };
  } catch {
    // Private mode, storage disabled, quota, corrupt JSON. All mean "no record".
    return null;
  }
}

function write(ack: Ack): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ack));
  } catch {
    // If it cannot be stored the banner reappears next load. That is the correct
    // failure: asking again is harmless, assuming an answer is not.
  }
}

/** Has this visitor been shown the current notice and answered? */
export function hasAcked(noticeVersion: string): boolean {
  const a = read();
  return a !== null && a.v === noticeVersion;
}

export function storedAck(): Ack | null {
  return read();
}

export function recordAck(noticeVersion: string, analytics: boolean): Ack {
  const ack: Ack = { v: noticeVersion, analytics, at: new Date().toISOString() };
  write(ack);
  return ack;
}

export function forgetAck(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * THE GATE. Every non-essential script, beacon or third-party embed must be behind
 * this call. Returns false unless the visitor explicitly opted in.
 *
 * Usage, for whoever adds the first one:
 *
 *     if (allowTracking()) void import('./analytics').then((m) => m.init());
 *
 * Do not add the script to index.html instead. That is the one way to get past this,
 * and doing it would put the product in breach on the day it shipped.
 */
export function allowTracking(): boolean {
  return read()?.analytics === true;
}
