/**
 * Python compatibility, in one place.
 *
 * ── WHY A MODULE LIKE THIS HAS TO EXIST ──────────────────────────────────────
 *
 * This backend replaced one written in Python, and it shares that one's database, its
 * signed tokens and its conversation with the GPU dubbing engine. Three of those care
 * about exact BYTES, and JavaScript and Python disagree about bytes in ways that are
 * silent:
 *
 *   * JSON NUMBERS. Python writes the float 2.0 as `2.0`; JavaScript has no floats and
 *     writes it as `2`. The golden preset is hashed with SHA-256 per job, so `2` would
 *     change every fingerprint — and the requests sent to the engine would no longer be
 *     the requests it has always received.
 *   * ROUNDING. `round(0.3125, 3)` is 0.312 in Python (half-even, on the exact binary
 *     value) and 0.313 in naive JavaScript. Minute balances are rounded and some of the
 *     results are written into the ledger, so a port that rounds differently changes
 *     money-adjacent numbers by a thousandth at a time.
 *   * TIMESTAMPS. Every timestamp in the database is `YYYY-MM-DDTHH:MM:SSZ` and is
 *     compared as TEXT. `new Date().toISOString()` adds milliseconds, which breaks both
 *     the comparisons and the Python parser a rollback would put back in charge.
 *
 * Everything here reproduces the Python behaviour exactly, including the edge cases,
 * and scripts/parity/run_parity.py pins it against CPython: the same values go through
 * both, and the bytes that come out (preset hashes, engine bodies, tokens, prices,
 * error pages, emails) are compared one for one.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// ── floats that must stay floats ─────────────────────────────────────────────

/**
 * A number that Python holds as a `float`.
 *
 * JavaScript cannot tell 2 from 2.0, so values that have to be written back out the way
 * Python would write them are wrapped in this. Only the places that need byte-exact
 * JSON use it — the preset, the engine payloads, and anything hashed. Everywhere else a
 * plain number is fine, because a JSON consumer cannot tell the difference either.
 *
 * `valueOf` makes arithmetic work on it directly (`+f`, `f * 2`), but a database driver
 * will not accept an object, so bind `num(f)` rather than `f`.
 */
export class PyFloat {
  constructor(public readonly v: number) {}
  valueOf(): number {
    return this.v;
  }
  toString(): string {
    return pyFloatRepr(this.v);
  }
  toJSON(): number {
    return this.v;
  }
}

/** Unwrap a PyFloat, or pass a plain number straight through. */
export function num(v: unknown): number {
  if (v instanceof PyFloat) return v.v;
  return v as number;
}

/** Wrap a number as a Python float. `null`/`undefined` pass through. */
export function pyf(v: number | PyFloat | null | undefined): PyFloat | null | undefined {
  if (v === null || v === undefined) return v;
  if (v instanceof PyFloat) return v;
  return new PyFloat(v);
}

/**
 * `repr(float)`, exactly.
 *
 * Python and JavaScript both print the SHORTEST decimal that round-trips, so the
 * digits always agree. What differs is the layout: Python switches to exponent notation
 * when the decimal point would sit more than 16 digits right of the first digit or more
 * than 4 left of it, always writes a two-digit signed exponent (`1e-05`), and adds `.0`
 * to an integral value. This takes JavaScript's digits and lays them out Python's way.
 */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';

  const neg = x < 0;
  // toExponential() with no argument gives the shortest round-trip digits.
  const [mant, expStr] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp10 = parseInt(expStr, 10);
  // Python's `decpt`: value = 0.DIGITS x 10^decpt
  const decpt = exp10 + 1;

  let out: string;
  if (decpt <= -4 || decpt > 16) {
    // exponent notation: d[.ddd]e±XX
    const head = digits[0];
    const tail = digits.slice(1);
    const e = decpt - 1;
    const sign = e < 0 ? '-' : '+';
    const ae = Math.abs(e);
    out = head + (tail ? '.' + tail : '') + 'e' + sign + (ae < 10 ? '0' + ae : String(ae));
  } else if (decpt <= 0) {
    out = '0.' + '0'.repeat(-decpt) + digits;
  } else if (decpt >= digits.length) {
    out = digits + '0'.repeat(decpt - digits.length) + '.0';
  } else {
    out = digits.slice(0, decpt) + '.' + digits.slice(decpt);
  }
  return neg ? '-' + out : out;
}

/** The float repr JSON uses: identical except for the non-finite spellings. */
function pyJsonFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  return pyFloatRepr(x);
}

// ── exact decimal arithmetic on a double ─────────────────────────────────────

/** A finite double as an exact fraction: value = sign * num / den. */
function exactFraction(x: number): { neg: boolean; num: bigint; den: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const neg = hi >>> 31 === 1;
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (expBits === 0) {
    e = -1074; // subnormal
  } else {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  if (e >= 0) return { neg, num: mant << BigInt(e), den: 1n };
  return { neg, num: mant, den: 1n << BigInt(-e) };
}

/**
 * Round |x| * 10^nd to an integer, half-to-even, on the EXACT binary value.
 * This is what CPython does, and it is why round(2.675, 2) is 2.67.
 */
function roundScaled(x: number, nd: number): { neg: boolean; q: bigint } {
  const { neg, num: n0, den: d0 } = exactFraction(x);
  let n = n0;
  let d = d0;
  if (nd >= 0) n *= 10n ** BigInt(nd);
  else d *= 10n ** BigInt(-nd);
  let q = n / d;
  const r = n % d;
  const twice = 2n * r;
  if (twice > d || (twice === d && (q & 1n) === 1n)) q += 1n;
  return { neg, q };
}

function scaledToDecimal(q: bigint, nd: number): string {
  if (nd <= 0) return (q * 10n ** BigInt(-nd)).toString();
  let s = q.toString();
  if (s.length <= nd) s = '0'.repeat(nd - s.length + 1) + s;
  return s.slice(0, s.length - nd) + '.' + s.slice(s.length - nd);
}

/**
 * `round(x, nd)` for a float, exactly as CPython computes it.
 *
 * With `nd` omitted it is `round(x)`, which in Python returns an int; the caller gets a
 * plain integral number and can treat it as one.
 */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  // CPython short-circuits: beyond these the value cannot change.
  if (nd > 323) return x;
  if (nd < -308) return x < 0 ? -0 : 0;
  const { neg, q } = roundScaled(x, nd);
  const v = Number(scaledToDecimal(q, nd));
  return neg ? -v : v;
}

/** `format(x, '.Nf')` / f"{x:.Nf}" — fixed point, half-even on the exact value. */
export function pyFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const { neg, q } = roundScaled(x, digits);
  const s = scaledToDecimal(q, digits);
  // Python keeps the sign of a negative value that rounds to zero ("-0.0").
  return neg ? '-' + s : s;
}

/**
 * format(x, 'g') / f"{x:g}": `precision` significant digits (6 by default), trailing
 * zeros dropped, exponent notation outside 1e-4 .. 10^precision. Exact, half-even.
 */
export function pyFormatG(x: number, precision = 6): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const p = precision === 0 ? 1 : precision;
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const neg = x < 0;
  const ax = Math.abs(x);
  const lim = 10n ** BigInt(p);
  let e = Math.floor(Math.log10(ax));
  let q = roundScaled(ax, p - 1 - e).q;
  if (q >= lim) {
    e += 1;
    q = roundScaled(ax, p - 1 - e).q;
  } else if (q < lim / 10n) {
    e -= 1;
    q = roundScaled(ax, p - 1 - e).q;
  }
  const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  let out: string;
  if (e >= -4 && e < p) {
    out = trim(scaledToDecimal(q, p - 1 - e));
  } else {
    const digits = q.toString();
    const mant = trim(digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : ''));
    const ae = Math.abs(e);
    out = mant + 'e' + (e < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
  }
  return neg ? '-' + out : out;
}

/** f"{n:,}" for an integer. */
export function pyThousands(n: number): string {
  const neg = n < 0;
  const s = Math.trunc(Math.abs(n)).toString();
  const out = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? '-' + out : out;
}

// ── JSON, the way Python's json module writes and reads it ───────────────────

export interface DumpOptions {
  /** json.dumps(sort_keys=...) */
  sortKeys?: boolean;
  /** json.dumps(separators=...). Python's default is [', ', ': ']. */
  separators?: [string, string];
  /** json.dumps(ensure_ascii=...). Python's default is true. */
  ensureAscii?: boolean;
  /** json.dumps(allow_nan=...). Python's default is true; HTTP responses use false. */
  allowNan?: boolean;
  /** json.dumps(indent=...): pretty-printed, with Python's layout. */
  indent?: number;
}

/** Python sorts dict keys by code point; JavaScript's default sort is by UTF-16 unit. */
export function codePointCompare(a: string, b: string): number {
  const ai = [...a];
  const bi = [...b];
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const x = ai[i].codePointAt(0)!;
    const y = bi[i].codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return ai.length - bi.length;
}

/** sorted(strings), in Python's order. Returns a new array. */
export function pySortedStr(items: Iterable<string>): string[] {
  return [...items].sort(codePointCompare);
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function hex4(code: number): string {
  return '\\u' + code.toString(16).padStart(4, '0');
}

/** Python's encode_basestring / encode_basestring_ascii. */
export function pyJsonString(s: string, ensureAscii = true): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    const short = SHORT_ESCAPES[ch];
    if (short) {
      out += short;
    } else if (code < 0x20) {
      out += hex4(code);
    } else if (ensureAscii && code > 0x7e) {
      // UTF-16 code units map one-to-one onto Python's surrogate-pair escapes, and
      // 0x7f (DEL) is escaped too: Python's ascii escaper covers everything outside
      // the printable range ' '..'~'.
      out += hex4(code);
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * `json.dumps`, byte for byte.
 *
 * Numbers: an integral JavaScript number is written as a Python int, a non-integral one
 * as a Python float, and a `PyFloat` always as a float — so wrap anything Python held as
 * a float before relying on this for bytes. `undefined` members are skipped, as
 * JSON.stringify does; Python has no such value, so they never occur in data that came
 * from it.
 */
export function pyDumps(value: unknown, opts: DumpOptions = {}): string {
  const indent = opts.indent;
  // With an indent, Python drops the space after the comma (the newline does its job).
  const [itemSep, keySep] = opts.separators ?? (indent !== undefined ? [',', ': '] : [', ', ': ']);
  const ensureAscii = opts.ensureAscii ?? true;
  const sortKeys = opts.sortKeys ?? false;
  const allowNan = opts.allowNan ?? true;

  const float = (x: number): string => {
    if (!allowNan && !Number.isFinite(x)) {
      throw new RangeError('Out of range float values are not JSON compliant: ' + pyJsonFloat(x));
    }
    return pyJsonFloat(x);
  };

  const pad = (level: number) => (indent === undefined ? '' : '\n' + ' '.repeat(indent * level));

  const enc = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (v instanceof PyFloat) return float(v.v);
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        return Math.abs(v) < 1e21 ? String(v === 0 ? 0 : v) : BigInt(v).toString();
      }
      return float(v);
    }
    if (typeof v === 'string') return pyJsonString(v, ensureAscii);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return '[' + pad(level + 1) + v.map((x) => enc(x, level + 1)).join(itemSep + pad(level + 1)) + pad(level) + ']';
    }
    if (v instanceof Date) return pyJsonString(v.toISOString(), ensureAscii);
    if (Buffer.isBuffer(v)) throw new TypeError('Object of type bytes is not JSON serializable');
    if (isPlainObject(v) || typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      let keys = pyKeys(obj).filter((k) => obj[k] !== undefined);
      if (sortKeys) keys = keys.sort(codePointCompare);
      if (keys.length === 0) return '{}';
      return (
        '{' +
        pad(level + 1) +
        keys.map((k) => pyJsonString(k, ensureAscii) + keySep + enc(obj[k], level + 1)).join(itemSep + pad(level + 1)) +
        pad(level) +
        '}'
      );
    }
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
  };
  return enc(value, 0);
}

/** The compact, sorted, non-escaping form used for every hash in this codebase. */
export function canonicalJson(value: unknown): string {
  return pyDumps(value, { sortKeys: true, separators: [',', ':'], ensureAscii: false });
}

/**
 * `json.loads`, keeping the int/float distinction.
 *
 * `JSON.parse` turns `12.0` into 12, and writing it back produces `12`. For data that is
 * sent on to the engine unchanged, that would change the bytes it receives. This parser
 * returns a `PyFloat` for any number written with a fraction or an exponent, which is
 * exactly the set Python's parser turns into floats.
 *
 * Also accepts Python's non-standard `NaN`, `Infinity` and `-Infinity`, as json.loads
 * does. Duplicate keys: the last one wins, same as Python.
 */
export function pyLoads(text: string): unknown {
  return new PyJsonParser(text).decode();
}

/**
 * json.JSONDecodeError: the message and position Python's C scanner reports.
 *
 * `pos` counts CODE POINTS, as a Python str index does, so an error after an emoji is
 * reported at the same position Python reports it at. The API echoes both in a 422.
 */
export class JSONDecodeError extends SyntaxError {
  override name = 'JSONDecodeError';
  readonly pos: number;
  readonly lineno: number;
  readonly colno: number;
  constructor(public readonly msg: string, doc: string, unitPos: number) {
    const pos = codePointIndex(doc, unitPos);
    const before = doc.slice(0, unitPos);
    const lineno = (before.match(/\n/g)?.length ?? 0) + 1;
    const colno = pos - (before.lastIndexOf('\n') < 0 ? -1 : codePointIndex(doc, before.lastIndexOf('\n')));
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
    this.pos = pos;
    this.lineno = lineno;
    this.colno = colno;
  }
}

function codePointIndex(s: string, unitIndex: number): number {
  let n = 0;
  for (let i = 0; i < unitIndex && i < s.length; i++) {
    const c = s.charCodeAt(i);
    // the low half of a surrogate pair is not a separate code point
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const p = s.charCodeAt(i - 1);
      if (p >= 0xd800 && p <= 0xdbff) continue;
    }
    n++;
  }
  return n;
}

class StopIteration {
  constructor(public readonly idx: number) {}
}

/**
 * The key order Python had, on objects parsed by pyLoads whose keys JavaScript would
 * reorder (integer-like keys such as "0" or "10"). pyDumps honours it.
 */
export const KEY_ORDER: unique symbol = Symbol('pyKeyOrder');

function isArrayIndex(k: string): boolean {
  return /^(0|[1-9]\d{0,9})$/.test(k) && Number(k) < 4294967295;
}

/** The keys of an object in the order Python would iterate them. */
export function pyKeys(obj: Record<string, unknown>): string[] {
  const natural = Object.keys(obj);
  const recorded = (obj as Record<symbol, unknown>)[KEY_ORDER] as string[] | undefined;
  if (!recorded) return natural;
  const present = new Set(natural);
  const out = recorded.filter((k) => present.has(k));
  const seen = new Set(out);
  for (const k of natural) if (!seen.has(k)) out.push(k);
  return out;
}

/** A structural port of CPython's `_json.c` scanner, errors included. */
class PyJsonParser {
  private readonly n: number;
  constructor(private readonly s: string) {
    this.n = s.length;
  }

  private err(msg: string, idx: number): never {
    throw new JSONDecodeError(msg, this.s, idx);
  }

  private ws(idx: number): number {
    const s = this.s;
    while (idx < this.n) {
      const c = s.charCodeAt(idx);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) idx++;
      else break;
    }
    return idx;
  }

  decode(): unknown {
    if (this.s.charCodeAt(0) === 0xfeff) this.err('Unexpected UTF-8 BOM (decode using utf-8-sig)', 0);
    let idx = this.ws(0);
    let value: unknown;
    try {
      [value, idx] = this.scanOnce(idx);
    } catch (e) {
      if (e instanceof StopIteration) this.err('Expecting value', e.idx);
      throw e;
    }
    idx = this.ws(idx);
    if (idx !== this.n) this.err('Extra data', idx);
    return value;
  }

  private scanOnce(idx: number): [unknown, number] {
    const s = this.s;
    if (idx >= this.n) throw new StopIteration(idx);
    const c = s[idx];
    switch (c) {
      case '"':
        return this.scanString(idx + 1);
      case '{':
        return this.parseObject(idx + 1);
      case '[':
        return this.parseArray(idx + 1);
      case 'n':
        if (s.startsWith('null', idx)) return [null, idx + 4];
        break;
      case 't':
        if (s.startsWith('true', idx)) return [true, idx + 4];
        break;
      case 'f':
        if (s.startsWith('false', idx)) return [false, idx + 5];
        break;
      case 'N':
        if (s.startsWith('NaN', idx)) return [new PyFloat(NaN), idx + 3];
        break;
      case 'I':
        if (s.startsWith('Infinity', idx)) return [new PyFloat(Infinity), idx + 8];
        break;
      case '-':
        if (s.startsWith('-Infinity', idx)) return [new PyFloat(-Infinity), idx + 9];
        break;
    }
    return this.matchNumber(idx);
  }

  private matchNumber(start: number): [number | PyFloat, number] {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(this.s.slice(start, start + 1000));
    if (!m) throw new StopIteration(start);
    let text = m[0];
    // a very long literal: take all of it, the way the C scanner does
    if (text.length === 1000 || start + text.length < this.n) {
      const full = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(this.s.slice(start));
      if (full) text = full[0];
    }
    const isFloat = /[.eE]/.test(text);
    const v = Number(text);
    if (!isFloat && !Number.isSafeInteger(v)) {
      // Python ints are unbounded; keep the exact value where JavaScript cannot.
      return [BigInt(text) as unknown as number, start + text.length];
    }
    return [isFloat ? new PyFloat(v) : v, start + text.length];
  }

  private scanString(end: number): [string, number] {
    const s = this.s;
    const begin = end - 1;
    let out = '';
    let chunk = end;
    let i = end;
    while (true) {
      if (i >= this.n) this.err('Unterminated string starting at', begin);
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        out += s.slice(chunk, i);
        return [out, i + 1];
      }
      if (c === 0x5c) {
        out += s.slice(chunk, i);
        i++;
        if (i >= this.n) this.err('Unterminated string starting at', begin);
        const e = s[i];
        if (e !== 'u') {
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          const ch = map[e];
          if (ch === undefined) this.err('Invalid \\escape', i - 1);
          out += ch;
          i++;
        } else {
          const uPos = i;
          i++;
          // the C scanner insists on a character after the four digits
          if (i + 4 >= this.n) this.err('Invalid \\uXXXX escape', uPos);
          const h = s.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) this.err('Invalid \\uXXXX escape', uPos);
          let cp = parseInt(h, 16);
          i += 4;
          // a surrogate pair written as two escapes becomes one character
          if (cp >= 0xd800 && cp <= 0xdbff && s[i] === '\\' && s[i + 1] === 'u') {
            const h2 = s.slice(i + 2, i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(h2)) {
              const lo = parseInt(h2, 16);
              if (lo >= 0xdc00 && lo <= 0xdfff) {
                cp = 0x10000 + (((cp - 0xd800) << 10) | (lo - 0xdc00));
                i += 6;
              }
            }
          }
          out += String.fromCodePoint(cp);
        }
        chunk = i;
        continue;
      }
      if (c <= 0x1f) this.err('Invalid control character at', i);
      i++;
    }
  }

  private parseObject(idx: number): [Record<string, unknown>, number] {
    const s = this.s;
    const obj: Record<string, unknown> = {};
    const order: string[] = [];
    let indexLike = false;
    idx = this.ws(idx);
    if (idx >= this.n || s[idx] !== '}') {
      while (true) {
        if (idx >= this.n || s[idx] !== '"') this.err('Expecting property name enclosed in double quotes', idx);
        let key: string;
        [key, idx] = this.scanString(idx + 1);
        idx = this.ws(idx);
        if (idx >= this.n || s[idx] !== ':') this.err("Expecting ':' delimiter", idx);
        idx = this.ws(idx + 1);
        let val: unknown;
        [val, idx] = this.scanOnce(idx);
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
          order.push(key);
          if (isArrayIndex(key)) indexLike = true;
        }
        // defineProperty, so a key named "__proto__" is data rather than a prototype swap
        Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
        idx = this.ws(idx);
        if (idx < this.n && s[idx] === '}') break;
        if (idx >= this.n || s[idx] !== ',') this.err("Expecting ',' delimiter", idx);
        const comma = idx;
        idx = this.ws(idx + 1);
        if (idx < this.n && s[idx] === '}') this.err('Illegal trailing comma before end of object', comma);
      }
    }
    // JavaScript lists integer-like keys first, in numeric order; Python keeps the order
    // they arrived in. Remember the real order so writing the object back is faithful.
    if (indexLike) (obj as Record<symbol, unknown>)[KEY_ORDER] = order;
    return [obj, idx + 1];
  }

  private parseArray(idx: number): [unknown[], number] {
    const s = this.s;
    const arr: unknown[] = [];
    idx = this.ws(idx);
    if (idx >= this.n || s[idx] !== ']') {
      while (true) {
        let val: unknown;
        [val, idx] = this.scanOnce(idx);
        arr.push(val);
        idx = this.ws(idx);
        if (idx < this.n && s[idx] === ']') break;
        if (idx >= this.n || s[idx] !== ',') this.err("Expecting ',' delimiter", idx);
        const comma = idx;
        idx = this.ws(idx + 1);
        if (idx < this.n && s[idx] === ']') this.err('Illegal trailing comma before end of array', comma);
      }
    }
    return [arr, idx + 1];
  }
}

/**
 * json.loads(bytes): the encoding detection Python applies before parsing (a BOM, or
 * the zero-byte pattern of UTF-16/32), then a strict decode. A body that is not valid in
 * its encoding throws a plain Error, which is not a JSONDecodeError — FastAPI answers
 * that one with a 400 rather than a 422, and so does this backend.
 */
export function pyLoadsBytes(b: Buffer): unknown {
  let enc: 'utf-8' | 'utf-8-sig' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be' | 'utf-16' | 'utf-32' = 'utf-8';
  if ((b[0] === 0x00 && b[1] === 0x00 && b[2] === 0xfe && b[3] === 0xff) || (b[0] === 0xff && b[1] === 0xfe && b[2] === 0x00 && b[3] === 0x00)) enc = 'utf-32';
  else if ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0xff && b[1] === 0xfe)) enc = 'utf-16';
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) enc = 'utf-8-sig';
  else if (b.length >= 4) {
    if (!b[0]) enc = b[1] ? 'utf-16be' : 'utf-32be';
    else if (!b[1]) enc = b[2] || b[3] ? 'utf-16le' : 'utf-32le';
  } else if (b.length === 2) {
    if (!b[0]) enc = 'utf-16be';
    else if (!b[1]) enc = 'utf-16le';
  }
  return pyLoads(decodeStrict(b, enc));
}

function decodeStrict(b: Buffer, enc: string): string {
  const utf32 = (buf: Buffer, le: boolean): string => {
    if (buf.length % 4) throw new Error('UnicodeDecodeError: truncated data');
    let out = '';
    for (let i = 0; i < buf.length; i += 4) {
      const cp = le ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
      if (cp > 0x10ffff) throw new Error('UnicodeDecodeError: code point not in range(0x110000)');
      out += String.fromCodePoint(cp);
    }
    return out;
  };
  switch (enc) {
    case 'utf-8':
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
    case 'utf-8-sig':
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b.subarray(3));
    case 'utf-16':
      return b[0] === 0xff ? decodeStrict(b.subarray(2), 'utf-16le') : decodeStrict(b.subarray(2), 'utf-16be');
    case 'utf-16le':
      return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(b);
    case 'utf-16be': {
      if (b.length % 2) throw new Error('UnicodeDecodeError: truncated data');
      const sw = Buffer.from(b);
      sw.swap16();
      return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(sw);
    }
    case 'utf-32':
      return b[0] === 0xff ? utf32(b.subarray(4), true) : utf32(b.subarray(4), false);
    case 'utf-32le':
      return utf32(b, true);
    case 'utf-32be':
      return utf32(b, false);
  }
  throw new Error(`unknown encoding ${enc}`);
}

/** Deep copy with every PyFloat unwrapped to a plain number. */
export function plain<T = unknown>(v: unknown): T {
  if (v instanceof PyFloat) return v.v as T;
  if (Array.isArray(v)) return v.map((x) => plain(x)) as T;
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = plain(x);
    return out as T;
  }
  return v as T;
}

// ── strings ──────────────────────────────────────────────────────────────────

/** Exactly the characters for which Python's str.isspace() is true. */
const PY_WS =
  '\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005' +
  '\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';

function stripSet(chars?: string): Set<string> {
  return new Set([...(chars ?? PY_WS)]);
}

/** str.strip([chars]). JavaScript's trim() also removes U+FEFF, which Python keeps. */
export function pyStrip(s: string, chars?: string): string {
  return pyRstrip(pyLstrip(s, chars), chars);
}

export function pyLstrip(s: string, chars?: string): string {
  const set = stripSet(chars);
  const cps = [...s];
  let a = 0;
  while (a < cps.length && set.has(cps[a])) a++;
  return cps.slice(a).join('');
}

export function pyRstrip(s: string, chars?: string): string {
  const set = stripSet(chars);
  const cps = [...s];
  let b = cps.length;
  while (b > 0 && set.has(cps[b - 1])) b--;
  return cps.slice(0, b).join('');
}

/**
 * str.isprintable() for one code point: false for the "Other" and "Separator"
 * categories, except the ASCII space.
 */
export function pyIsPrintable(ch: string): boolean {
  return isPrintable(ch);
}

/** str.splitlines(): every line break Python recognises, and no empty last line. */
export function pySplitlines(s: string): string[] {
  const out = s.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

function isPrintable(ch: string): boolean {
  if (ch === ' ') return true;
  return !/^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u.test(ch);
}

/** str.isspace() for a single character. */
export function pyIsSpace(ch: string): boolean {
  return ch.length > 0 && [...ch].every((c) => PY_WS.includes(c));
}

/** str.partition(sep): split at the FIRST occurrence. */
export function pyPartition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, '', ''];
  return [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** str.rpartition(sep): split at the LAST occurrence. */
export function pyRpartition(s: string, sep: string): [string, string, string] {
  const i = s.lastIndexOf(sep);
  if (i < 0) return ['', '', s];
  return [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** len(s) — Python counts code points, JavaScript counts UTF-16 units. */
export function pyLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** s[start:end] by code point, so an emoji is never cut in half. */
export function pySlice(s: string, end: number, start = 0): string {
  if (start === 0 && end >= 0 && s.length <= end) return s; // cannot be longer in code points
  if (start < 0 || end < 0) return [...s].slice(start, end).join('');
  // walk code points without materialising the whole string as an array
  let cp = 0;
  let from = -1;
  let i = 0;
  while (i < s.length) {
    if (cp === start && from < 0) from = i;
    if (cp === end) break;
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    cp++;
  }
  if (from < 0) from = cp === start ? i : s.length;
  return s.slice(from, i);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64.b64decode(s) — Python's forgiving decoder, exactly.
 *
 * Characters outside the STANDARD alphabet are skipped (so '-' and '_' are dropped, where
 * Node's decoder would read them as base64url), decoding stops at a complete pad
 * sequence, and a truncated final group is an error. Webhook signing keys are decoded
 * with this, so the key bytes are the ones Python derived from the same secret.
 */
export function pyB64decode(s: string): Buffer {
  if (!/^[\x00-\x7f]*$/.test(s)) throw new Error('string argument should contain only ASCII characters');
  const out: number[] = [];
  let quad = 0;
  let left = 0;
  let pads = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '=') {
      if (quad >= 2 && quad + ++pads >= 4) {
        return Buffer.from(out);
      }
      continue;
    }
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    pads = 0;
    switch (quad) {
      case 0:
        quad = 1;
        left = v;
        break;
      case 1:
        quad = 2;
        out.push(((left << 2) | (v >> 4)) & 0xff);
        left = v & 0x0f;
        break;
      case 2:
        quad = 3;
        out.push(((left << 4) | (v >> 2)) & 0xff);
        left = v & 0x03;
        break;
      default:
        quad = 0;
        out.push(((left << 6) | v) & 0xff);
        left = 0;
    }
  }
  if (quad !== 0) {
    if (quad === 1) throw new Error('Invalid base64-encoded string: number of data characters cannot be 1 more than a multiple of 4');
    throw new Error('Incorrect padding');
  }
  return Buffer.from(out);
}

/** str(v): what Python prints for a value inside an f-string. */
export function pyStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return pyRepr(v);
}

/** str.title(): capitalise the first letter of every run of letters. */
export function pyTitle(s: string): string {
  let out = '';
  let prevCased = false;
  for (const ch of s) {
    const isLetter = ch.toLowerCase() !== ch.toUpperCase();
    if (isLetter) {
      out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
      prevCased = true;
    } else {
      out += ch;
      prevCased = false;
    }
  }
  return out;
}

/**
 * repr() for the values that end up inside error and event messages.
 *
 * Only used for human-readable text, so it covers str, int, float, bool, None, and
 * lists/dicts of those.
 */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v instanceof PyFloat) return pyFloatRepr(v.v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === 'string') {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of v) {
      const c = ch.codePointAt(0)!;
      if (ch === '\\') out += '\\\\';
      else if (ch === quote) out += '\\' + quote;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (!pyIsPrintable(ch)) {
        // Python's repr escapes every character str.isprintable() rejects.
        if (c <= 0xff) out += '\\x' + c.toString(16).padStart(2, '0');
        else if (c <= 0xffff) out += '\\u' + c.toString(16).padStart(4, '0');
        else out += '\\U' + c.toString(16).padStart(8, '0');
      } else out += ch;
    }
    return out + quote;
  }
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (typeof v === 'object') {
    return (
      '{' +
      Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => pyRepr(k) + ': ' + pyRepr(x))
        .join(', ') +
      '}'
    );
  }
  return String(v);
}

/**
 * Python truthiness. JavaScript treats `[]` and `{}` as true; Python does not.
 */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v instanceof PyFloat) return v.v !== 0;
  // NaN is truthy in Python, so only zero is false.
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return Boolean(v);
}

// ── secrets and hashes ───────────────────────────────────────────────────────

/** secrets.token_urlsafe(n): n random bytes, base64url, no padding. */
export function tokenUrlsafe(nbytes = 32): string {
  return randomBytes(nbytes).toString('base64url');
}

/** secrets.token_hex(n). */
export function tokenHex(nbytes = 32): string {
  return randomBytes(nbytes).toString('hex');
}

/** hashlib.sha256(s.encode()).hexdigest() */
export function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * hmac.compare_digest, for strings or buffers. Constant time for equal lengths; a
 * length mismatch is answered immediately, which reveals only the length — the same
 * thing Python's version reveals.
 */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
  const y = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// ── time ─────────────────────────────────────────────────────────────────────

/**
 * `%Y-%m-%dT%H:%M:%SZ` in UTC — THE timestamp format of this database.
 *
 * Second precision, a literal Z, fixed width, so lexical order is time order and
 * string comparison against `now()` is a correct time comparison.
 */
export function fmtStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`
  );
}

/**
 * datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ"), strict: throws on anything else, the
 * way Python raises ValueError. Accepts one-digit fields, as strptime does.
 */
export function parseStamp(s: string): Date {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})Z$/.exec(String(s));
  if (!m) throw new RangeError(`time data ${pyRepr(s)} does not match format '%Y-%m-%dT%H:%M:%SZ'`);
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  const dt = new Date(t);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d ||
    h > 23 || mi > 59 || se > 59
  ) {
    throw new RangeError(`time data ${pyRepr(s)} is out of range`);
  }
  return dt;
}

/**
 * datetime.fromisoformat(x.replace("Z", "+00:00")) followed by our format — how
 * provider timestamps are normalised. Returns null for anything unparseable.
 */
export function isoToStamp(x: unknown): string | null {
  if (typeof x !== 'string' || !x) return null;
  const s = x.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    return null;
  }
  let iso = s.replace(' ', 'T');
  // A bare date or a naive datetime is UTC for our purposes, as Python's comparison
  // against aware values would require.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += 'T00:00:00';
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return fmtStamp(d);
}

/** Seconds since the epoch as Python's int(time.time()). */
export function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Add seconds to a Date without mutating it. */
export function addSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * 1000);
}

// ── small conveniences ───────────────────────────────────────────────────────

/** Python's `a or b` for strings and other values. */
export function or<T>(...vals: T[]): T {
  for (const v of vals) if (truthy(v)) return v;
  return vals[vals.length - 1];
}

/** time.sleep, as a promise. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** "Type: message" — what Python's f"{type(e).__name__}: {e}" produces. */
export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** str(e) for an exception: its message alone. */
export function excStr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return pyStr(e);
}

/** type(e).__name__ */
export function errName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}
