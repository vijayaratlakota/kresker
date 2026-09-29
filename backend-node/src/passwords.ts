/**
 * Is this password one an attacker would try first?
 *
 * A minimum length on its own accepts `password123`, which is in every credential-
 * stuffing list ever assembled. Length is a floor, not a policy.
 *
 * TWO CHECKS, ONLY ONE OF THEM ALWAYS ON:
 *
 *   * A local denylist, always. Offline, instant, and it catches the passwords that
 *     actually show up in automated attacks. Deliberately short.
 *   * Have I Been Pwned, opt-in via VS_PASSWORD_BREACH_CHECK=1. It needs a network call
 *     on the signup path, so it is a switch rather than a default.
 *
 * The HIBP call uses k-anonymity: only the first five characters of the SHA-1 leave this
 * process. And it FAILS OPEN — an outage at a third party must not become an outage here.
 */
import { createHash } from 'node:crypto';
import { pyStrip, pyThousands } from './py';

// The shapes that appear in real stuffing lists. A longer list starts rejecting
// passwords people can actually remember, which pushes them towards a sticky note.
const DENY = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssword', 'p@ssw0rd', 'passwordpassword',
  '12345678', '123456789', '1234567890', '12345678910', '1234512345',
  'qwertyuiop', 'qwerty123', 'qwerty1234', '1qaz2wsx', 'zaq12wsx',
  'iloveyou', 'princess', 'sunshine', 'football', 'baseball', 'superman',
  'letmein1', 'letmein123', 'welcome1', 'welcome123', 'admin123',
  'administrator', 'changeme', 'changeme123', 'trustno1', 'starwars',
  'monkey123', 'dragon123', 'michael1', 'jennifer', 'shadow123',
  'abc12345', 'abcd1234', 'asdfghjkl', '11111111', '00000000',
  'aaaaaaaa', 'qazwsxedc', 'google123', 'whatever1', 'freedom1',
]);

export const BREACH_CHECK = (process.env.VS_PASSWORD_BREACH_CHECK || '0') === '1';
const HIBP_URL = 'https://api.pwnedpasswords.com/range/';
const HIBP_TIMEOUT_S = parseFloat(process.env.VS_PASSWORD_BREACH_TIMEOUT_S || '3');

/** Its own type, so the router answers 400 with this text and nothing else. */
export class WeakPassword extends Error {
  override name = 'WeakPassword';
}

function inDenylist(password: string): boolean {
  return DENY.has(pyStrip(password).toLowerCase());
}

/**
 * How many known breaches contain this password. 0 when unknown or unreachable.
 * Never throws: "we could not tell" is treated as acceptable.
 */
export async function breachCount(password: string): Promise<number> {
  if (!BREACH_CHECK) return 0;
  try {
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    const r = await fetch(HIBP_URL + prefix, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_S * 1000),
    });
    if (r.status !== 200) return 0;
    const text = await r.text();
    for (const line of text.split(/\r\n|\r|\n/)) {
      const i = line.indexOf(':');
      const head = i < 0 ? line : line.slice(0, i);
      const count = i < 0 ? '' : line.slice(i + 1);
      if (pyStrip(head).toUpperCase() === suffix) {
        const n = parseInt(pyStrip(count) || '0', 10);
        return Number.isFinite(n) ? n : 0;
      }
    }
  } catch {
    return 0; // fail open, on purpose
  }
  return 0;
}

/** Throws WeakPassword if this one should not be allowed. */
export async function check(password: string): Promise<void> {
  if (inDenylist(password)) {
    throw new WeakPassword(
      'that password appears in public lists of the most commonly used ' +
        'passwords, so it would be guessed almost immediately. Please pick ' +
        'another one.',
    );
  }
  const n = await breachCount(password);
  if (n > 0) {
    throw new WeakPassword(
      `that password has appeared in known data breaches (${pyThousands(n)} times), which ` +
        'means it is already in the lists attackers try first. Please pick ' +
        'another one.',
    );
  }
}
