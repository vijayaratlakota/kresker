/**
 * How file locations are written into the database.
 *
 * The rule: A DATABASE ROW NEVER RECORDS WHERE THIS PARTICULAR MACHINE KEEPS ITS FILES.
 * It records where the file sits inside the data directory, and the data directory comes
 * from the environment at read time.
 *
 * This exists because rows used to hold `C:\video translator\backend\data\outputs\x.mp4`.
 * Restore that into a Linux box and every row points at a path that does not exist —
 * and nothing errors until a customer's download 410s. The stored form is always
 * POSIX-separated, so a database written on Windows reads correctly on Linux and back.
 */
import path from 'node:path';
import { DATA_DIR } from './config';

/** The subdirectories a stored path is allowed to name. */
export const KNOWN_ROOTS = ['uploads', 'outputs', 'mail', 'export'] as const;

/** Path(x).is_absolute(), with Windows drive paths recognised on every platform. */
function isAbsolute(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** Split on either separator, dropping empty pieces. */
function parts(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/**
 * A real path, in the portable form to write into a row.
 *
 * Inside the data directory: relative to it. Outside: kept as given, because silently
 * rewriting it would be a lie — `unportableRows()` reports it instead.
 */
export function store(p: string): string {
  const full = path.resolve(p);
  const rel = path.relative(path.resolve(DATA_DIR), full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return String(p);
  return parts(rel).join('/');
}

/** The stored form, back into a real path on this machine. */
export function resolve(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const raw = String(stored).trim();
  if (!raw) return null;
  if (isAbsolute(raw)) {
    // A legacy row, or a deliberately external file. Left alone.
    return raw;
  }
  const root = path.resolve(DATA_DIR);
  const full = path.resolve(root, ...parts(raw));
  // A relative value comes from our own code, never from a request. Checking anyway
  // means a corrupted row cannot walk out of the data directory.
  if (!full.startsWith(root)) {
    throw new Error(`stored path escapes the data directory: '${raw}'`);
  }
  return full;
}

/** Would this value survive a move to another machine? */
export function portable(stored: string | null | undefined): boolean {
  if (!stored) return true;
  return !isAbsolute(String(stored));
}

/**
 * One legacy absolute path in the portable form, or null if it cannot be recognised.
 *
 * Matches on the trailing components rather than a prefix, so a row written on another
 * machine — another drive, another install directory — still converts.
 */
export function toRelative(stored: string): string | null {
  const s = String(stored);
  const ps = parts(s);
  if (!isAbsolute(s)) return ps.join('/');
  // The anchor is never a candidate: a drive letter is ps[0] here, while a POSIX root
  // has already been dropped by the split.
  const lo = /^[A-Za-z]:/.test(s) ? 1 : 0;
  for (let i = ps.length - 1; i >= lo; i--) {
    if ((KNOWN_ROOTS as readonly string[]).includes(ps[i])) return ps.slice(i).join('/');
  }
  return null;
}
