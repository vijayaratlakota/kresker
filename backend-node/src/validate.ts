/**
 * Request validation, answering the way the Python backend's validator (pydantic 2, as
 * FastAPI uses it) answers.
 *
 * Every request body model in this API is `extra="forbid"`: a field the server does not
 * know is an error, never silently dropped. That is a security property here, not a
 * style choice — it is what stops a client naming its own price, its own minutes or its
 * own pipeline settings — and the tests pin it.
 *
 * The coercions are pydantic's "lax mode" ones, measured rather than remembered (see
 * scripts/parity/pydantic_cases.py): "5" is a valid int, 5.0 is a valid int, 5.5 is not;
 * "yes" is a valid bool; nothing but a string is a valid string. The error items carry
 * pydantic's `type`, `loc`, `msg`, `input` and `ctx`, so a 422 from this backend is the
 * 422 the frontend has always parsed.
 */
import { emailStr, EmailValueError } from './emailstr';
import { PyFloat, pyLen, pyStrip } from './py';

export type Loc = Array<string | number>;

export interface ErrorItem {
  type: string;
  loc: Loc;
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

/** Thrown with every problem found, in pydantic's order. Rendered as FastAPI's 422. */
export class RequestValidationError extends Error {
  override name = 'RequestValidationError';
  constructor(public readonly errors: ErrorItem[]) {
    super(`${errors.length} validation error${errors.length === 1 ? '' : 's'}`);
  }
}

const INVALID: unique symbol = Symbol('invalid');
export type Invalid = typeof INVALID;
export { INVALID };

/** One JSON-schema-ish description, for the OpenAPI document. */
export type Schema = Record<string, unknown>;

export abstract class Type<T = unknown> {
  abstract check(v: unknown, loc: Loc, errs: ErrorItem[]): T | Invalid;
  abstract schema(): Schema;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v instanceof PyFloat || Buffer.isBuffer(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function isNumber(v: unknown): v is number | PyFloat {
  return typeof v === 'number' || v instanceof PyFloat;
}

// ── scalars ──────────────────────────────────────────────────────────────────

export interface StrOptions {
  minLength?: number;
  maxLength?: number;
  description?: string;
}

export class Str extends Type<string> {
  constructor(private readonly o: StrOptions = {}) {
    super();
  }
  check(v: unknown, loc: Loc, errs: ErrorItem[]): string | Invalid {
    if (typeof v !== 'string') {
      errs.push({ type: 'string_type', loc, msg: 'Input should be a valid string', input: v });
      return INVALID;
    }
    // Python counts code points, so an emoji is one character here as it is there.
    const n = pyLen(v);
    const { minLength, maxLength } = this.o;
    if (minLength !== undefined && n < minLength) {
      errs.push({
        type: 'string_too_short',
        loc,
        msg: `String should have at least ${minLength} character${minLength === 1 ? '' : 's'}`,
        input: v,
        ctx: { min_length: minLength },
      });
      return INVALID;
    }
    if (maxLength !== undefined && n > maxLength) {
      errs.push({
        type: 'string_too_long',
        loc,
        msg: `String should have at most ${maxLength} character${maxLength === 1 ? '' : 's'}`,
        input: v,
        ctx: { max_length: maxLength },
      });
      return INVALID;
    }
    return v;
  }
  schema(): Schema {
    const s: Schema = { type: 'string' };
    if (this.o.maxLength !== undefined) s.maxLength = this.o.maxLength;
    if (this.o.minLength !== undefined) s.minLength = this.o.minLength;
    if (this.o.description) s.description = this.o.description;
    return s;
  }
}

const I64 = 2 ** 63;

/** A decimal integer string as pydantic reads one: trimmed, signed, `_` between digits, `.000` allowed. */
function strAsInt(s: string): number | null {
  let t = pyStrip(s);
  const dot = t.indexOf('.');
  if (dot >= 0) {
    if (!/^0*$/.test(t.slice(dot + 1))) return null;
    t = t.slice(0, dot);
  }
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) return null;
  return Number(t.replace(/_/g, ''));
}

export class Int extends Type<number> {
  check(v: unknown, loc: Loc, errs: ErrorItem[]): number | Invalid {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return Number(v);
    if (isNumber(v)) {
      const x = +v;
      const fromFloat = v instanceof PyFloat || !Number.isInteger(x);
      if (!Number.isFinite(x)) {
        errs.push({ type: 'finite_number', loc, msg: 'Input should be a finite number', input: v });
        return INVALID;
      }
      if (!Number.isInteger(x)) {
        errs.push({ type: 'int_from_float', loc, msg: 'Input should be a valid integer, got a number with a fractional part', input: v });
        return INVALID;
      }
      if (fromFloat && Math.abs(x) >= I64) {
        errs.push({ type: 'int_parsing_size', loc, msg: 'Unable to parse input string as an integer, exceeded maximum size', input: v });
        return INVALID;
      }
      return x;
    }
    if (typeof v === 'string') {
      if (pyLen(v) > 4300) {
        errs.push({ type: 'int_parsing_size', loc, msg: 'Unable to parse input string as an integer, exceeded maximum size', input: v });
        return INVALID;
      }
      const n = strAsInt(v);
      if (n === null) {
        errs.push({ type: 'int_parsing', loc, msg: 'Input should be a valid integer, unable to parse string as an integer', input: v });
        return INVALID;
      }
      return n;
    }
    errs.push({ type: 'int_type', loc, msg: 'Input should be a valid integer', input: v });
    return INVALID;
  }
  schema(): Schema {
    return { type: 'integer' };
  }
}

export class Float extends Type<number> {
  check(v: unknown, loc: Loc, errs: ErrorItem[]): number | Invalid {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return Number(v);
    if (isNumber(v)) return +v;
    if (typeof v === 'string') {
      const t = pyStrip(v);
      if (/^[+-]?((\d+(_\d+)*)?\.?\d+(_\d+)*([eE][+-]?\d+)?|\d+\.|inf|infinity|nan)$/i.test(t)) {
        const x = Number(t.replace(/_/g, '').replace(/^([+-]?)inf(inity)?$/i, '$1Infinity'));
        if (!Number.isNaN(x) || /nan/i.test(t)) return x;
      }
      errs.push({ type: 'float_parsing', loc, msg: 'Input should be a valid number, unable to parse string as a number', input: v });
      return INVALID;
    }
    errs.push({ type: 'float_type', loc, msg: 'Input should be a valid number', input: v });
    return INVALID;
  }
  schema(): Schema {
    return { type: 'number' };
  }
}

const TRUE_STR = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_STR = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

export class Bool extends Type<boolean> {
  check(v: unknown, loc: Loc, errs: ErrorItem[]): boolean | Invalid {
    if (typeof v === 'boolean') return v;
    const parsing = (): Invalid => {
      errs.push({ type: 'bool_parsing', loc, msg: 'Input should be a valid boolean, unable to interpret input', input: v });
      return INVALID;
    };
    if (typeof v === 'bigint') return parsing();
    if (isNumber(v)) {
      const x = +v;
      // A float counts as an int only when it is one exactly and fits in 64 bits.
      if (v instanceof PyFloat && !(Number.isInteger(x) && Math.abs(x) < I64)) {
        errs.push({ type: 'bool_type', loc, msg: 'Input should be a valid boolean', input: v });
        return INVALID;
      }
      if (x === 0) return false;
      if (x === 1) return true;
      return parsing();
    }
    if (typeof v === 'string') {
      const t = v.toLowerCase();
      if (TRUE_STR.has(t)) return true;
      if (FALSE_STR.has(t)) return false;
      return parsing();
    }
    errs.push({ type: 'bool_type', loc, msg: 'Input should be a valid boolean', input: v });
    return INVALID;
  }
  schema(): Schema {
    return { type: 'boolean' };
  }
}

/** pydantic's EmailStr: a string, then email-validator's normalised form. */
export class Email extends Type<string> {
  check(v: unknown, loc: Loc, errs: ErrorItem[]): string | Invalid {
    if (typeof v !== 'string') {
      errs.push({ type: 'string_type', loc, msg: 'Input should be a valid string', input: v });
      return INVALID;
    }
    try {
      return emailStr(v);
    } catch (e) {
      if (e instanceof EmailValueError) {
        errs.push({ type: 'value_error', loc, msg: e.message, input: v, ctx: { reason: e.reason } });
        return INVALID;
      }
      throw e;
    }
  }
  schema(): Schema {
    return { type: 'string', format: 'email' };
  }
}

/** typing.Any */
export class AnyType extends Type<unknown> {
  check(v: unknown): unknown {
    return v;
  }
  schema(): Schema {
    return {};
  }
}

// ── containers ───────────────────────────────────────────────────────────────

export class List<T> extends Type<T[]> {
  constructor(private readonly item: Type<T>) {
    super();
  }
  check(v: unknown, loc: Loc, errs: ErrorItem[]): T[] | Invalid {
    if (!Array.isArray(v)) {
      errs.push({ type: 'list_type', loc, msg: 'Input should be a valid list', input: v });
      return INVALID;
    }
    const out: T[] = [];
    let bad = false;
    v.forEach((x, i) => {
      const r = this.item.check(x, [...loc, i], errs);
      if (r === INVALID) bad = true;
      else out.push(r);
    });
    return bad ? INVALID : out;
  }
  schema(): Schema {
    return { type: 'array', items: this.item.schema() };
  }
}

/** dict[str, T] */
export class Dict<T> extends Type<Record<string, T>> {
  constructor(private readonly value: Type<T>) {
    super();
  }
  check(v: unknown, loc: Loc, errs: ErrorItem[]): Record<string, T> | Invalid {
    if (!isPlainObject(v)) {
      errs.push({ type: 'dict_type', loc, msg: 'Input should be a valid dictionary', input: v });
      return INVALID;
    }
    const out: Record<string, T> = {};
    let bad = false;
    for (const [k, x] of Object.entries(v)) {
      const r = this.value.check(x, [...loc, k], errs);
      if (r === INVALID) bad = true;
      else Object.defineProperty(out, k, { value: r, enumerable: true, writable: true, configurable: true });
    }
    return bad ? INVALID : out;
  }
  schema(): Schema {
    return { type: 'object', additionalProperties: this.value.schema() };
  }
}

/** `X | None` */
export class Nullable<T> extends Type<T | null> {
  constructor(readonly inner: Type<T>) {
    super();
  }
  check(v: unknown, loc: Loc, errs: ErrorItem[]): T | null | Invalid {
    if (v === null || v === undefined) return null;
    return this.inner.check(v, loc, errs);
  }
  schema(): Schema {
    return { anyOf: [this.inner.schema(), { type: 'null' }] };
  }
}

// ── models ───────────────────────────────────────────────────────────────────

export interface FieldDef<T = unknown> {
  type: Type<T>;
  required: boolean;
  default?: T;
  description?: string;
}

/** A field the caller must send. */
export function required<T>(type: Type<T>, description?: string): FieldDef<T> {
  return { type, required: true, description };
}

/** A field with a default, used when the caller leaves it out. */
export function optional<T>(type: Type<T>, dflt: T, description?: string): FieldDef<T> {
  return { type, required: false, default: dflt, description };
}

function deepCopy<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return structuredClone(v);
}

/** A pydantic BaseModel with `extra="forbid"` (the default here) or `"ignore"`. */
export class Model<T = Record<string, any>> extends Type<T> {
  constructor(
    readonly name: string,
    readonly fields: Record<string, FieldDef>,
    readonly extra: 'forbid' | 'ignore' = 'forbid',
  ) {
    super();
  }

  check(v: unknown, loc: Loc, errs: ErrorItem[]): T | Invalid {
    if (!isPlainObject(v)) {
      errs.push({
        type: 'model_attributes_type',
        loc,
        msg: 'Input should be a valid dictionary or object to extract fields from',
        input: v,
      });
      return INVALID;
    }
    const out: Record<string, unknown> = {};
    let bad = false;
    for (const [name, f] of Object.entries(this.fields)) {
      if (Object.prototype.hasOwnProperty.call(v, name)) {
        const r = f.type.check(v[name], [...loc, name], errs);
        if (r === INVALID) bad = true;
        else out[name] = r;
      } else if (f.required) {
        errs.push({ type: 'missing', loc: [...loc, name], msg: 'Field required', input: v });
        bad = true;
      } else {
        out[name] = deepCopy(f.default);
      }
    }
    if (this.extra === 'forbid') {
      for (const k of Object.keys(v)) {
        if (!Object.prototype.hasOwnProperty.call(this.fields, k)) {
          errs.push({ type: 'extra_forbidden', loc: [...loc, k], msg: 'Extra inputs are not permitted', input: v[k] });
          bad = true;
        }
      }
    }
    return bad ? INVALID : (out as T);
  }

  schema(): Schema {
    return { $ref: `#/components/schemas/${this.name}` };
  }

  /** The component schema FastAPI publishes for this model. */
  componentSchema(): Schema {
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const [name, f] of Object.entries(this.fields)) {
      const s: Schema = { ...f.type.schema(), title: titleOf(name) };
      if (!f.required) s.default = f.default ?? null;
      if (f.description) s.description = f.description;
      properties[name] = s;
      if (f.required) required.push(name);
    }
    const out: Schema = { properties, type: 'object' };
    if (this.extra === 'forbid') out.additionalProperties = false;
    if (required.length) out.required = required;
    out.title = this.name;
    return out;
  }

  /** Nested models referenced by this one, for the OpenAPI components section. */
  nested(): Model[] {
    const out: Model[] = [];
    const walk = (t: Type): void => {
      if (t instanceof Model) out.push(t);
      else if (t instanceof Nullable) walk(t.inner);
    };
    for (const f of Object.values(this.fields)) walk(f.type);
    return out;
  }
}

/** pydantic's default field title: "user_id" -> "User Id". */
export function titleOf(name: string): string {
  return name
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ── shorthands, so model declarations read like the Python ones ─────────────

export const t = {
  str: (o?: StrOptions) => new Str(o),
  int: () => new Int(),
  float: () => new Float(),
  bool: () => new Bool(),
  email: () => new Email(),
  any: () => new AnyType(),
  list: <T>(item: Type<T>) => new List(item),
  dict: <T>(value: Type<T>) => new Dict(value),
  nullable: <T>(inner: Type<T>) => new Nullable(inner),
};
