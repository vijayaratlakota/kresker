/**
 * Email address validation: what pydantic's `EmailStr` does, which is what every sign-up,
 * sign-in and contact form has always been checked with.
 *
 * pydantic hands the value to the `email-validator` library (2.3.0, with deliverability
 * checks off). This is a port of the parts of that library the default options reach:
 * dot-atom local parts, internationalised local parts, IDNA domains, the special-use
 * domain list, and the length limits — with the same error sentences, because a
 * customer sees them.
 *
 * The result is the library's NORMALISED address: the domain lowercased (and IDNA-
 * normalised), the local part NFC-normalised and otherwise left exactly as typed. That
 * is what gets stored, so it has to be the same value Python would have stored.
 *
 * Where the port approximates: IDNA 2008 code point validity is derived from Unicode
 * general categories rather than the IANA table, and the right-to-left (bidi) label
 * rules are not applied. Both only matter for internationalised domain names, and in
 * each case the address is still rejected when Python rejects it, sometimes with a
 * differently worded reason.
 */
import { domainToASCII } from 'node:url';
import { pyIsPrintable, pyRepr, pyRstrip, pyStrip } from './py';

export class EmailSyntaxError extends Error {
  override name = 'EmailSyntaxError';
}

// ── constants (email_validator.rfc_constants) ─────────────────────────────────

const ATEXT = "a-zA-Z0-9_!#\\$%&'\\*\\+\\-/=\\?\\^`\\{\\|\\}~";
const ATEXT_RE = new RegExp('^[.' + ATEXT + ']$', 'u');
const DOT_ATOM_TEXT = new RegExp('^[' + ATEXT + ']+(?:\\.[' + ATEXT + ']+)*$', 'u');
const ATEXT_INTL = ATEXT + '\\u{80}-\\u{10FFFF}';
const ATEXT_INTL_DOT_RE = new RegExp('^[.' + ATEXT_INTL + ']$', 'u');
const DOT_ATOM_TEXT_INTL = new RegExp('^[' + ATEXT_INTL + ']+(?:\\.[' + ATEXT_INTL + ']+)*$', 'u');
const ATEXT_HOSTNAME_INTL = /^[a-zA-Z0-9\-.\u{80}-\u{10FFFF}]$/u;
const HOSTNAME_LABEL = '(?:(?:[a-zA-Z0-9][a-zA-Z0-9\\-]*)?[a-zA-Z0-9])';
const DOT_ATOM_TEXT_HOSTNAME = new RegExp('^' + HOSTNAME_LABEL + '(?:\\.' + HOSTNAME_LABEL + ')*$');
const DOMAIN_NAME_REGEX = /[A-Za-z]$/;
const QTEXT_INTL = /^[\u0020-\u007E\u{80}-\u{10FFFF}]$/u;
const DOMAIN_LITERAL_CHARS = /^[\u0021-\u00FA\u005E-\u007E]$/u;

const EMAIL_MAX_LENGTH = 254;
const DNS_LABEL_LENGTH_LIMIT = 63;
const DOMAIN_MAX_LENGTH = 253;

const CASE_INSENSITIVE_MAILBOX_NAMES = new Set([
  'info', 'marketing', 'sales', 'support',
  'abuse', 'noc', 'security',
  'postmaster', 'hostmaster', 'usenet', 'news', 'webmaster', 'www', 'uucp', 'ftp',
]);

// IANA special-use names; "example" is deliberately NOT here, as in the library.
const SPECIAL_USE_DOMAIN_NAMES = ['arpa', 'invalid', 'local', 'localhost', 'onion', 'test'];

// ── Unicode helpers ──────────────────────────────────────────────────────────

/** Code points, the way Python iterates a str. */
function cps(s: string): string[] {
  return [...s];
}

/** unicodedata.category(c) — the two-letter general category. */
function category(c: string): string {
  const tests: Array<[string, RegExp]> = CATEGORY_TESTS;
  for (const [name, re] of tests) if (re.test(c)) return name;
  return 'Cn';
}
const CATEGORY_TESTS: Array<[string, RegExp]> = [
  'Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Mn', 'Mc', 'Me', 'Nd', 'Nl', 'No',
  'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'Sm', 'Sc', 'Sk', 'So',
  'Zs', 'Zl', 'Zp', 'Cc', 'Cf', 'Cs', 'Co', 'Cn',
].map((n) => [n, new RegExp(`^\\p{${n}}$`, 'u')]);

// unicodedata.name() for the characters that can reach an error message here. Python
// has the whole Unicode name table; the rest fall back to the same U+XXXX form Python
// uses for a character with no name.
const NAMES: Record<number, string> = {
  0x20: 'SPACE', 0xa0: 'NO-BREAK SPACE', 0xad: 'SOFT HYPHEN', 0x1680: 'OGHAM SPACE MARK',
  0x2000: 'EN QUAD', 0x2001: 'EM QUAD', 0x2002: 'EN SPACE', 0x2003: 'EM SPACE',
  0x2004: 'THREE-PER-EM SPACE', 0x2005: 'FOUR-PER-EM SPACE', 0x2006: 'SIX-PER-EM SPACE',
  0x2007: 'FIGURE SPACE', 0x2008: 'PUNCTUATION SPACE', 0x2009: 'THIN SPACE', 0x200a: 'HAIR SPACE',
  0x200b: 'ZERO WIDTH SPACE', 0x200c: 'ZERO WIDTH NON-JOINER', 0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK', 0x200f: 'RIGHT-TO-LEFT MARK', 0x2028: 'LINE SEPARATOR',
  0x2029: 'PARAGRAPH SEPARATOR', 0x202a: 'LEFT-TO-RIGHT EMBEDDING', 0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING', 0x202d: 'LEFT-TO-RIGHT OVERRIDE', 0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x202f: 'NARROW NO-BREAK SPACE', 0x205f: 'MEDIUM MATHEMATICAL SPACE', 0x2060: 'WORD JOINER',
  0x2066: 'LEFT-TO-RIGHT ISOLATE', 0x2067: 'RIGHT-TO-LEFT ISOLATE', 0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE', 0x3000: 'IDEOGRAPHIC SPACE', 0xfeff: 'ZERO WIDTH NO-BREAK SPACE',
  0x0300: 'COMBINING GRAVE ACCENT', 0x0301: 'COMBINING ACUTE ACCENT', 0x0338: 'COMBINING LONG SOLIDUS OVERLAY',
};

/** email_validator.syntax.safe_character_display */
function safeCharacterDisplay(c: string): string {
  if (c === '\\') return `"${c}"`;
  if ('LNPS'.includes(category(c)[0])) return pyRepr(c);
  const cp = c.codePointAt(0)!;
  const h = cp < 0xffff ? 'U+' + cp.toString(16).padStart(4, '0').toUpperCase() : 'U+' + cp.toString(16).padStart(8, '0').toUpperCase();
  return NAMES[cp] ?? h;
}

/** Python's sorted() over strings: by code point. */
function pySorted(xs: Iterable<string>): string[] {
  return [...xs].sort((a, b) => {
    const x = cps(a);
    const y = cps(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
      if (d) return d;
    }
    return x.length - y.length;
  });
}

function utf8Len(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ── split_email ──────────────────────────────────────────────────────────────

function splitAtUnquotedSpecial(text: string, specials: string[]): [string, string] {
  const chars = cps(text);
  let insideQuote = false;
  let escaped = false;
  let left: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    // Something combining with the special character (≮ from < plus U+0338) is not it.
    const nfcFirst = cps(chars.slice(i).join('').normalize('NFC'))[0];
    if (nfcFirst !== c) {
      left.push(c);
    } else if (insideQuote) {
      left.push(c);
      if (c === '\\' && !escaped) escaped = true;
      else if (c === '"' && !escaped) {
        insideQuote = false;
        escaped = false;
      } else escaped = false;
    } else if (c === '"') {
      left.push(c);
      insideQuote = true;
    } else if (specials.includes(c)) {
      break;
    } else {
      left.push(c);
    }
  }
  if (left.length === chars.length) {
    if (text.includes('\uff20')) {
      throw new EmailSyntaxError('The email address has the "full-width" at-sign (@) character instead of a regular at-sign.');
    }
    if (text.includes('\ufe6b')) {
      throw new EmailSyntaxError('The email address has the "small commercial at" character instead of a regular at-sign.');
    }
    throw new EmailSyntaxError('An email address must have an @-sign.');
  }
  return [left.join(''), chars.slice(left.length).join('')];
}

function unquoteQuotedString(text: string): [string, boolean] {
  const chars = cps(text);
  let quoted = false;
  let escaped = false;
  let value = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (quoted) {
      if (escaped) {
        value += c;
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        if (i !== chars.length - 1) {
          throw new EmailSyntaxError(
            'Extra character(s) found after close quote: ' + chars.slice(i + 1).map(safeCharacterDisplay).join(', '),
          );
        }
        break;
      } else value += c;
    } else if (i === 0 && c === '"') {
      quoted = true;
    } else value += c;
  }
  return [value, quoted];
}

function splitEmail(email: string): [string | null, string, string, boolean] {
  let [left, right] = splitAtUnquotedSpecial(email, ['@', '<']);
  let displayName: string | null;
  let local: string;
  let domain: string;
  if (right.startsWith('<')) {
    left = pyRstrip(left);
    const [dn, dnQuoted] = unquoteQuotedString(left);
    displayName = dn;
    if (!dnQuoted) {
      const bad = new Set<string>();
      for (const c of cps(dn)) if ((!ATEXT_RE.test(c) && c !== ' ') || c === '.') bad.add(safeCharacterDisplay(c));
      if (bad.size) {
        throw new EmailSyntaxError('The display name contains invalid characters when not quoted: ' + pySorted(bad).join(', ') + '.');
      }
    }
    checkUnsafeChars(dn, true);
    if (!right.includes('>')) {
      throw new EmailSyntaxError(
        'An open angle bracket at the start of the email address has to be followed by a close angle bracket at the end.',
      );
    }
    right = pyRstrip(right, ' ');
    if (!right.endsWith('>')) throw new EmailSyntaxError("There can't be anything after the email address.");
    const addrSpec = pyRstrip(right.slice(1), '>');
    [local, domain] = splitAtUnquotedSpecial(addrSpec, ['@']);
  } else {
    displayName = null;
    local = left;
    domain = right;
  }
  if (domain.startsWith('@')) domain = domain.slice(1);
  const [unq, isQuoted] = unquoteQuotedString(local);
  return [displayName, unq, domain, isQuoted];
}

// ── the local part ───────────────────────────────────────────────────────────

function checkUnsafeChars(s: string, allowSpace = false): void {
  const bad = new Set<string>();
  cps(s).forEach((c, i) => {
    const cat = category(c);
    if ('LNPS'.includes(cat[0])) return;
    if (cat[0] === 'M') {
      if (i === 0) bad.add(c);
    } else if (cat === 'Zs') {
      if (!allowSpace) bad.add(c);
    } else {
      bad.add(c); // Zl, Zp, and every C category
    }
  });
  if (bad.size) {
    throw new EmailSyntaxError(
      'The email address contains unsafe characters: ' + pySorted(bad).map(safeCharacterDisplay).join(', ') + '.',
    );
  }
}

function checkDotAtom(label: string, startDescr: string, endDescr: string, isHostname: boolean): void {
  if (label.endsWith('.')) throw new EmailSyntaxError(endDescr.replace('{}', 'period'));
  if (label.startsWith('.')) throw new EmailSyntaxError(startDescr.replace('{}', 'period'));
  if (label.includes('..')) throw new EmailSyntaxError('An email address cannot have two periods in a row.');
  if (isHostname) {
    if (label.endsWith('-')) throw new EmailSyntaxError(endDescr.replace('{}', 'hyphen'));
    if (label.startsWith('-')) throw new EmailSyntaxError(startDescr.replace('{}', 'hyphen'));
    if (label.includes('.-') || label.includes('-.')) {
      throw new EmailSyntaxError('An email address cannot have a period and a hyphen next to each other.');
    }
  }
}

interface LocalInfo {
  local_part: string;
  ascii_local_part: string | null;
  smtputf8: boolean;
}

function validateLocalPart(local: string, quoted: boolean): LocalInfo {
  if (local.length === 0) throw new EmailSyntaxError('There must be something before the @-sign.');
  if (DOT_ATOM_TEXT.test(local)) return { local_part: local, ascii_local_part: local, smtputf8: false };

  let valid: string | null = null;
  let requiresSmtputf8 = false;
  if (DOT_ATOM_TEXT_INTL.test(local)) {
    valid = 'dot-atom';
    requiresSmtputf8 = true; // allow_smtputf8 is on by default
  } else if (quoted) {
    const bad = new Set<string>();
    for (const c of cps(local)) if (!QTEXT_INTL.test(c)) bad.add(safeCharacterDisplay(c));
    if (bad.size) {
      throw new EmailSyntaxError(
        'The email address contains invalid characters in quotes before the @-sign: ' + pySorted(bad).join(', ') + '.',
      );
    }
    if (cps(local).some((c) => !(c.codePointAt(0)! >= 32 && c.codePointAt(0)! <= 126))) requiresSmtputf8 = true;
    valid = 'quoted';
  }

  if (valid) {
    checkUnsafeChars(local, valid === 'quoted');
    if (/[\uD800-\uDFFF]/.test(local.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
      throw new EmailSyntaxError('The email address contains an invalid character.');
    }
    let out = local;
    if (valid === 'quoted') out = '"' + local.replace(/(["\\])/g, '\\$1') + '"';
    return { local_part: out, ascii_local_part: requiresSmtputf8 ? null : out, smtputf8: requiresSmtputf8 };
  }

  const bad = new Set<string>();
  for (const c of cps(local)) if (!ATEXT_INTL_DOT_RE.test(c)) bad.add(safeCharacterDisplay(c));
  if (bad.size) {
    throw new EmailSyntaxError('The email address contains invalid characters before the @-sign: ' + pySorted(bad).join(', ') + '.');
  }
  checkDotAtom(local, 'An email address cannot start with a {}.', 'An email address cannot have a {} immediately before the @-sign.', false);
  throw new EmailSyntaxError('The email address contains invalid characters before the @-sign.');
}

// ── IDNA, as far as the default options reach it ─────────────────────────────

class IDNAError extends Error {}

function unot(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

/** email_validator.syntax.uts46_valid_char */
function uts46ValidChar(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  if (c >= 0x80 && c <= 0x9f) return false;
  if (
    (c >= 0x2010 && c <= 0x2060 && !(c >= 0x2024 && c <= 0x2026) && !(c >= 0x2028 && c <= 0x202e)) ||
    c === 0x00ad || c === 0x2064 || c === 0xff0e ||
    (c >= 0x200b && c <= 0x200d) ||
    (c >= 0x1bca0 && c <= 0x1bca3)
  ) {
    return true;
  }
  if (['Cf', 'Cn', 'Co', 'Cs', 'Zs', 'Zl', 'Zp'].includes(category(ch))) return false;
  // Characters that decompose into a sequence containing a full stop (e.g. "⒈").
  const nfkd = ch.normalize('NFKD');
  if (nfkd !== ch && nfkd.includes('.')) return false;
  return true;
}

/**
 * idna.uts46_remap(domain, std3_rules=False, transitional=False): case folding, NFC, and
 * the alternative full stops turned into '.'. Node's WHATWG URL implementation carries
 * the same UTS #46 mapping table.
 */
function uts46Remap(domain: string): string {
  if (/^[\x00-\x7f]*$/.test(domain)) return domain.toLowerCase();
  const labels = domain.split('.');
  const out: string[] = [];
  for (const label of labels) {
    if (label === '') {
      out.push('');
      continue;
    }
    let mapped = '';
    for (const ch of cps(label)) {
      if (/^[\x00-\x7f]$/.test(ch)) {
        mapped += ch.toLowerCase();
        continue;
      }
      // One code point at a time. Alone first (a right-to-left letter must not be mixed
      // with a Latin prefix); then after a letter, for a combining mark, which may not
      // start a label.
      let a = domainToASCII(ch);
      let prefixed = false;
      if (a === '') {
        a = domainToASCII('a' + ch);
        prefixed = true;
      }
      if (a === '') {
        const pos = cps(domain).indexOf(ch) + 1;
        throw new IDNAError(`Codepoint ${unot(ch.codePointAt(0)!)} not allowed at position ${pos} in ${pyRepr(domain)}`);
      }
      const u = decodeDomainLoose(a);
      mapped += prefixed ? u.slice(1) : u;
    }
    out.push(mapped.normalize('NFC'));
  }
  return out.join('.');
}

// ── Punycode (RFC 3492), for turning A-labels back into Unicode ─────────────

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let k = 0;
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  for (; delta > ((BASE - TMIN) * TMAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - TMIN));
  return Math.floor(k + ((BASE - TMIN + 1) * delta) / (delta + SKEW));
}

function punyDecode(input: string): string {
  const output: number[] = [];
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  // Everything before the LAST hyphen is literal; the rest is the encoded tail.
  const delim = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(delim, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) throw new IDNAError('Invalid A-label');
    output.push(c);
  }
  for (let idx = delim >= 0 ? delim + 1 : 0; idx < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= input.length) throw new IDNAError('Invalid A-label');
      const cc = input.charCodeAt(idx++);
      const digit = cc - 48 < 10 ? cc - 22 : cc - 65 < 26 ? cc - 65 : cc - 97 < 26 ? cc - 97 : BASE;
      if (digit >= BASE) throw new IDNAError('Invalid A-label');
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) throw new IDNAError('Invalid A-label');
    }
    const len = output.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) throw new IDNAError('Invalid A-label');
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function decodeDomainLoose(ascii: string): string {
  return ascii
    .split('.')
    .map((l) => {
      if (!l.toLowerCase().startsWith('xn--')) return l;
      try {
        return punyDecode(l.slice(4).toLowerCase());
      } catch {
        return l;
      }
    })
    .join('.');
}

/** IDNA 2008 PVALID, approximated from the general category. */
function pvalid(ch: string): boolean {
  if (/^[a-z0-9-]$/.test(ch)) return true;
  if (/^[\x00-\x7f]$/.test(ch)) return false;
  const cat = category(ch);
  if (!['Ll', 'Lo', 'Lm', 'Mn', 'Mc', 'Nd'].includes(cat)) return false;
  // "Unstable": a character that NFKC case folding would change is not PVALID.
  return ch.normalize('NFKC').toLowerCase().normalize('NFKC') === ch;
}

function contexto(label: string[], pos: number): boolean | null {
  const cp = label[pos].codePointAt(0)!;
  if (cp === 0x00b7) return pos > 0 && pos < label.length - 1 && label[pos - 1] === 'l' && label[pos + 1] === 'l';
  if (cp === 0x0375) return pos < label.length - 1 && /^\p{Script=Greek}$/u.test(label[pos + 1]);
  if (cp === 0x05f3 || cp === 0x05f4) return pos > 0 && /^\p{Script=Hebrew}$/u.test(label[pos - 1]);
  if (cp === 0x30fb) return label.some((c) => c !== '\u30fb' && /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]$/u.test(c));
  if (cp >= 0x0660 && cp <= 0x0669) return !label.some((c) => c >= '\u06f0' && c <= '\u06f9');
  if (cp >= 0x06f0 && cp <= 0x06f9) return !label.some((c) => c >= '\u0660' && c <= '\u0669');
  return null;
}

/** idna.core.check_label, without the bidi rules. */
function checkLabel(label: string): void {
  if (label.length === 0) throw new IDNAError('Empty Label');
  if (label.normalize('NFC') !== label) throw new IDNAError('Label must be in Normalization Form C');
  const chars = cps(label);
  if (chars.slice(2, 4).join('') === '--') throw new IDNAError('Label has disallowed hyphens in 3rd and 4th position');
  if (chars[0] === '-' || chars[chars.length - 1] === '-') throw new IDNAError('Label must not start or end with a hyphen');
  if (category(chars[0])[0] === 'M') throw new IDNAError('Label begins with an illegal combining character');
  chars.forEach((c, pos) => {
    if (pvalid(c)) return;
    const ctx = contexto(chars, pos);
    if (ctx === true) return;
    if (ctx === false) {
      throw new IDNAError(`Codepoint ${unot(c.codePointAt(0)!)} not allowed at position ${pos + 1} in ${pyRepr(label)}`);
    }
    throw new IDNAError(`Codepoint ${unot(c.codePointAt(0)!)} at position ${pos + 1} of ${pyRepr(label)} not allowed`);
  });
}

/** idna.alabel for a label with non-ASCII characters. */
function alabel(label: string): string {
  if (/^[\x00-\x7f]*$/.test(label)) {
    ulabel(label);
    if (label.length > 63) throw new IDNAError('Label too long');
    return label;
  }
  checkLabel(label);
  const a = domainToASCII(label);
  if (!a || a.includes('.')) throw new IDNAError('Invalid label');
  if (a.length > 63) throw new IDNAError('Label too long');
  return a;
}

/** idna.ulabel */
function ulabel(label: string): string {
  if (!/^[\x00-\x7f]*$/.test(label)) {
    checkLabel(label);
    return label;
  }
  let lb = label.toLowerCase();
  if (lb.startsWith('xn--')) {
    lb = lb.slice(4);
    if (!lb) throw new IDNAError('Malformed A-label, no Punycode eligible content found');
    if (lb.endsWith('-')) throw new IDNAError('A-label must not end with a hyphen');
  } else {
    checkLabel(lb);
    return lb;
  }
  const u = punyDecode(lb);
  checkLabel(u);
  return u;
}

/** idna.decode, for the ASCII domain the validator has already built. */
function idnaDecode(ascii: string): string {
  const labels = ascii.split(/[.\u3002\uff0e\uff61]/);
  if (!labels.length || (labels.length === 1 && labels[0] === '')) throw new IDNAError('Empty domain');
  let trailingDot = false;
  if (labels[labels.length - 1] === '') {
    labels.pop();
    trailingDot = true;
  }
  const result = labels.map((l) => {
    const s = ulabel(l);
    if (!s) throw new IDNAError('Empty label');
    return s;
  });
  if (trailingDot) result.push('');
  return result.join('.');
}

// ── the domain ───────────────────────────────────────────────────────────────

function lengthReason(addr: string, limit: number): string {
  const diff = cps(addr).length - limit;
  return `(${diff} character${diff > 1 ? 's' : ''} too many)`;
}

function validateDomainName(domainIn: string): { ascii_domain: string; domain: string } {
  let domain = domainIn;
  let bad = new Set<string>();
  for (const c of cps(domain)) if (!ATEXT_HOSTNAME_INTL.test(c)) bad.add(safeCharacterDisplay(c));
  if (bad.size) throw new EmailSyntaxError('The part after the @-sign contains invalid characters: ' + pySorted(bad).join(', ') + '.');

  checkUnsafeChars(domain);

  bad = new Set();
  for (const c of cps(domain)) if (!uts46ValidChar(c)) bad.add(safeCharacterDisplay(c));
  if (bad.size) throw new EmailSyntaxError('The part after the @-sign contains invalid characters: ' + pySorted(bad).join(', ') + '.');

  const original = domain;
  try {
    domain = uts46Remap(domain);
  } catch (e) {
    throw new EmailSyntaxError(`The part after the @-sign contains invalid characters (${(e as Error).message}).`);
  }

  bad = new Set();
  for (const c of cps(domain)) if (!ATEXT_HOSTNAME_INTL.test(c)) bad.add(safeCharacterDisplay(c));
  if (bad.size) {
    throw new EmailSyntaxError(
      'The part after the @-sign contains invalid characters after Unicode normalization: ' + pySorted(bad).join(', ') + '.',
    );
  }

  checkDotAtom(domain, 'An email address cannot have a {} immediately after the @-sign.', 'An email address cannot end with a {}.', true);

  for (const label of domain.split('.')) {
    const l = cps(label);
    if (l.length >= 4 && l[2] === '-' && l[3] === '-' && !/^xn$/i.test(l[0] + l[1])) {
      throw new EmailSyntaxError(
        'An email address cannot have two letters followed by two dashes immediately after the @-sign or after a period, except Punycode.',
      );
    }
  }

  let asciiDomain: string;
  if (DOT_ATOM_TEXT_HOSTNAME.test(domain)) {
    asciiDomain = domain;
  } else {
    try {
      asciiDomain = domain.split('.').map(alabel).join('.');
    } catch (e) {
      throw new EmailSyntaxError(`The part after the @-sign is invalid (${(e as Error).message}).`);
    }
    if (!DOT_ATOM_TEXT_HOSTNAME.test(asciiDomain)) {
      throw new EmailSyntaxError('The email address contains invalid characters after the @-sign after IDNA encoding.');
    }
  }

  if (asciiDomain.length > DOMAIN_MAX_LENGTH) {
    if (asciiDomain === original) {
      throw new EmailSyntaxError(`The email address is too long after the @-sign ${lengthReason(asciiDomain, DOMAIN_MAX_LENGTH)}.`);
    }
    const diff = asciiDomain.length - DOMAIN_MAX_LENGTH;
    throw new EmailSyntaxError(
      `The email address is too long after the @-sign (${diff} byte${diff === 1 ? '' : 's'} too many after IDNA encoding).`,
    );
  }
  for (const label of asciiDomain.split('.')) {
    if (label.length > DNS_LABEL_LENGTH_LIMIT) {
      throw new EmailSyntaxError(
        `After the @-sign, periods cannot be separated by so many characters ${lengthReason(label, DNS_LABEL_LENGTH_LIMIT)}.`,
      );
    }
  }

  // globally_deliverable (the default)
  if (!asciiDomain.includes('.')) throw new EmailSyntaxError('The part after the @-sign is not valid. It should have a period.');
  if (!DOMAIN_NAME_REGEX.test(asciiDomain)) {
    throw new EmailSyntaxError('The part after the @-sign is not valid. It is not within a valid top-level domain.');
  }
  for (const d of SPECIAL_USE_DOMAIN_NAMES) {
    if (asciiDomain === d || asciiDomain.endsWith('.' + d)) {
      throw new EmailSyntaxError('The part after the @-sign is a special-use or reserved name that cannot be used with email.');
    }
  }

  let i18n: string;
  try {
    i18n = idnaDecode(asciiDomain);
  } catch (e) {
    throw new EmailSyntaxError(`The part after the @-sign is not valid IDNA (${(e as Error).message}).`);
  }
  bad = new Set();
  for (const c of cps(i18n)) if (!ATEXT_HOSTNAME_INTL.test(c)) bad.add(safeCharacterDisplay(c));
  if (bad.size) throw new EmailSyntaxError('The part after the @-sign contains invalid characters: ' + pySorted(bad).join(', ') + '.');
  checkUnsafeChars(i18n);

  return { ascii_domain: asciiDomain, domain: i18n };
}

function validateDomainLiteral(lit: string): void {
  if (/^[0-9.]+$/.test(lit)) {
    const ok = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lit);
    if (!ok || ok.slice(1).some((o) => Number(o) > 255 || (o.length > 1 && o.startsWith('0')))) {
      throw new EmailSyntaxError(
        `The address in brackets after the @-sign is not valid: It is not an IPv4 address (${pyRepr(lit)} does not appear to be an IPv4 or IPv6 address) or is missing an address literal tag.`,
      );
    }
    return;
  }
  if (lit.startsWith('IPv6:')) return; // refused right after this anyway
  if (!lit.includes(':')) {
    throw new EmailSyntaxError('The part after the @-sign in brackets is not an IPv4 address and has no address literal tag.');
  }
  const bad = new Set<string>();
  for (const c of cps(lit)) if (!DOMAIN_LITERAL_CHARS.test(c)) bad.add(safeCharacterDisplay(c));
  if (bad.size) {
    throw new EmailSyntaxError('The part after the @-sign contains invalid characters in brackets: ' + pySorted(bad).join(', ') + '.');
  }
  throw new EmailSyntaxError('The part after the @-sign contains an invalid address literal tag in brackets.');
}

function validateLength(original: string, normalized: string, asciiForm: string): void {
  const checks: Array<[string, string | null]> = [
    [original, null],
    [normalized, 'after normalization'],
    [asciiForm, 'when the part after the @-sign is converted to IDNA ASCII'],
  ];
  for (const [addr, why] of checks) {
    const len = cps(addr).length;
    const u8 = utf8Len(addr);
    const diff = u8 - EMAIL_MAX_LENGTH;
    if (diff <= 0) continue;
    let reason: string;
    if (why === null && len === u8) {
      reason = lengthReason(addr, EMAIL_MAX_LENGTH);
    } else if (why === null) {
      const mbpc = Math.max(...cps(addr).map(utf8Len));
      const mchars = Math.max(1, Math.floor(diff / mbpc));
      const suffix = diff > 1 ? 's' : '';
      reason = mchars === diff ? `(${diff} character${suffix} too many)` : `(${mchars}-${diff} character${suffix} too many)`;
    } else {
      reason = `${why} (${diff} byte${diff > 1 ? 's' : ''} too many)`;
    }
    throw new EmailSyntaxError(`The email address is too long ${reason}.`);
  }
}

/** email_validator.validate_email(email, check_deliverability=False).normalized */
export function validateEmail(email: string): string {
  const [displayName, local, domainPart, isQuoted] = splitEmail(email);
  const original = (isQuoted ? '"' + local + '"' : local) + '@' + domainPart;

  const info = validateLocalPart(local, isQuoted);
  let localPart = info.local_part;
  let asciiLocal = info.ascii_local_part;
  const smtputf8 = info.smtputf8;

  const nfc = localPart.normalize('NFC');
  if (nfc !== localPart) {
    try {
      validateLocalPart(nfc, isQuoted);
    } catch (e) {
      throw new EmailSyntaxError('After Unicode normalization: ' + (e as Error).message);
    }
    localPart = nfc;
  }

  if (isQuoted) throw new EmailSyntaxError('Quoting the part before the @-sign is not allowed here.');

  if (asciiLocal !== null && CASE_INSENSITIVE_MAILBOX_NAMES.has(asciiLocal.toLowerCase())) {
    asciiLocal = asciiLocal.toLowerCase();
    localPart = localPart.toLowerCase();
  }

  if (domainPart.length === 0) throw new EmailSyntaxError('There must be something after the @-sign.');
  if (domainPart.startsWith('[') && domainPart.endsWith(']')) {
    validateDomainLiteral(domainPart.slice(1, -1));
    throw new EmailSyntaxError('A bracketed IP address after the @-sign is not allowed here.');
  }
  const d = validateDomainName(domainPart);
  const normalized = localPart + '@' + d.domain;
  void smtputf8;

  validateLength(original, normalized, (asciiLocal || localPart || '') + '@' + d.ascii_domain);

  if (displayName !== null) {
    throw new EmailSyntaxError('A display name and angle brackets around the email address are not permitted here.');
  }
  return normalized;
}

// ── pydantic's wrapper ───────────────────────────────────────────────────────

const MAX_EMAIL_LENGTH = 2048;

// pydantic.networks._build_pretty_email_regex, with Python's \w and \s spelled out.
const W = '[\\p{L}\\p{N}\\p{Mn}\\p{Mc}\\p{Pc}]';
const S = '[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const NAME_CHARS = `(?:${W}|[!#$%&'*+\\-/=?^_\`{|}~])`;
const PRETTY_EMAIL = new RegExp(
  `^${S}*(?:((?:${NAME_CHARS}+${S}+)*${NAME_CHARS}+)|"((?:[^"]|")+)")?${S}*<([^\\n]+)>${S}*$`,
  'u',
);

/**
 * The error pydantic raises, carried as data: the router turns it into a 422 item of
 * type `value_error`.
 */
export class EmailValueError extends Error {
  override name = 'EmailValueError';
  constructor(public readonly reason: string) {
    super(`value is not a valid email address: ${reason}`);
  }
}

/** pydantic's EmailStr: returns the normalised address or throws EmailValueError. */
export function emailStr(value: string): string {
  if (cps(value).length > MAX_EMAIL_LENGTH) {
    throw new EmailValueError(`Length must not exceed ${MAX_EMAIL_LENGTH} characters`);
  }
  let v = value;
  const m = PRETTY_EMAIL.exec(v);
  if (m) v = m[3];
  const email = pyStrip(v);
  try {
    return validateEmail(email);
  } catch (e) {
    if (e instanceof EmailSyntaxError) throw new EmailValueError(e.message);
    throw e;
  }
}

// Exported for the parity test only.
export const _internal = { pyIsPrintable };
