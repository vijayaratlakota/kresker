/**
 * The ONLY module that talks to the dubbing engine on the GPU box.
 *
 * Everything here is a read or a call over HTTP to port 3900. Nothing writes to the
 * engine's disk, changes its configuration or touches its code: the engine is driven
 * exactly as its own UI drives it, and the engine itself stays the Python service it
 * has always been.
 *
 * Call order is fixed and is not negotiable:
 *
 *     0  GET  /sysinfo                       readiness gate
 *     1  POST /dub/upload                    multipart, fresh job_id every time
 *     2  GET  /dub/history                   poll until vocals_path appears
 *     3  GET  /dub/transcribe-stream/{job}   SSE - NEVER the POST variant
 *     4  POST /dub/translate
 *     5  POST /dub/generate/{job}            returns a task id
 *     6  GET  /tasks/stream/{task}           progress
 *     6b GET  /dub/tracks/{job}              the real completion signal
 *     7  GET  /dub/download/{job}            muxed mp4
 *     9  DELETE /dub/history/{job}           clear our media off the shared box
 *
 * Step 3 must be the streaming endpoint: the POST variant skips speaker-clone
 * extraction, and every line would be rendered in the engine's default voice.
 *
 * ── THE BYTES ARE THE ONES THE ENGINE HAS ALWAYS RECEIVED ────────────────────
 *
 * The Python backend sent JSON through httpx 0.28: compact separators, UTF-8, no ASCII
 * escaping. Bodies here are written with `pyDumps` in that exact form, and engine
 * replies are parsed with `pyLoads`, which keeps 2.0 a float — so a segment's
 * `"start": 12.0` goes back to the engine as `12.0`, not `12`. Multipart uploads use
 * httpx's layout: data fields first, then the file, CRLF-delimited.
 *
 * Timeouts follow httpx's model: a CONNECT timeout, and a READ timeout that applies to
 * each wait for data rather than to the whole exchange — the transcribe stream is
 * legitimately silent for minutes while it builds voice clones.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, promises as fsp, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
// (ENGINE_RENDER_TIMEOUT_S is httpx's overall/write budget there; a read timeout is what
// actually bounds a silent engine, so that is the one applied here.)
import { ENGINE_CONNECT_TIMEOUT_S, ENGINE_MODE, ENGINE_STREAM_READ_TIMEOUT_S, ENGINE_URL } from './config';
import { urlencode } from './http';
import { PyFloat, errText, pyDumps, pyLoadsBytes, pyLen, pyRepr, pySlice, pyStrip, sleep, truthy } from './py';

export class EngineError extends Error {
  override name = 'EngineError';
}

export class EngineUnavailable extends EngineError {
  override name = 'EngineUnavailable';
}

// httpx's transport errors, by the names that end up in a failed job's error code.
export class HTTPError extends Error {
  override name = 'HTTPError';
}
export class ConnectError extends HTTPError {
  override name = 'ConnectError';
}
export class ConnectTimeout extends HTTPError {
  override name = 'ConnectTimeout';
}
export class ReadTimeout extends HTTPError {
  override name = 'ReadTimeout';
}
export class RemoteProtocolError extends HTTPError {
  override name = 'RemoteProtocolError';
}

/** A fresh id for every upload. Reusing one makes transcribe answer 409. */
export function newJobId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

// ── the HTTP client ──────────────────────────────────────────────────────────

interface Sent {
  status: number;
  body: Readable;
  /** Why the connection died, if it did (a read timeout, say). */
  failure(): Error | null;
}

/** An error while reading a body, under the name httpx would have given it. */
function bodyError(sent: Sent, e: unknown): Error {
  const f = sent.failure();
  if (f) return f;
  if (e instanceof HTTPError) return e;
  return new RemoteProtocolError(`peer closed connection without sending complete message body (${(e as Error)?.message ?? e})`);
}

interface RequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | (() => Readable);
  bodyLength?: number;
  readTimeoutS: number;
  connectTimeoutS?: number;
}

const HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate',
  'User-Agent': 'kresker-backend (node)',
};

function joinUrl(base: string, p: string): URL {
  return new URL(base.replace(/\/+$/, '') + p);
}

/** Decompress per Content-Encoding, as httpx does transparently. */
function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  return res;
}

function sendRequest(base: string, o: RequestOptions): Promise<Sent> {
  const url = joinUrl(base, o.path);
  const lib = url.protocol === 'https:' ? https : http;
  const connectMs = (o.connectTimeoutS ?? ENGINE_CONNECT_TIMEOUT_S) * 1000;
  const readMs = o.readTimeoutS * 1000;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...HEADERS, ...(o.headers ?? {}) };
    if (Buffer.isBuffer(o.body)) headers['Content-Length'] = String(o.body.length);
    else if (o.bodyLength !== undefined) headers['Content-Length'] = String(o.bodyLength);
    const req = lib.request(url, { method: o.method, headers, agent: false });
    let settled = false;
    let failure: Error | null = null;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(e);
    };
    const connectTimer = setTimeout(() => fail(new ConnectTimeout(`timed out connecting to ${url.host}`)), connectMs);
    req.on('socket', (sock) => {
      const armRead = () => {
        clearTimeout(connectTimer);
        // a READ timeout in httpx's sense: the longest wait for the next bytes
        sock.setTimeout(readMs, () => {
          failure = new ReadTimeout('The read operation timed out');
          if (!settled) fail(failure);
          else sock.destroy(failure);
        });
      };
      if ((sock as unknown as { connecting?: boolean }).connecting) sock.once('connect', armRead);
      else armRead();
    });
    req.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(connectTimer);
      if (e instanceof HTTPError) return fail(e);
      if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET'].includes(e.code || '') && !settled) {
        return fail(new ConnectError(e.message));
      }
      fail(new RemoteProtocolError(e.message));
    });
    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      const body = decoded(res);
      res.on('close', () => {
        if (!res.complete && !body.destroyed) {
          body.destroy(failure ?? new RemoteProtocolError('peer closed connection without sending complete message body'));
        }
      });
      resolve({ status: res.statusCode ?? 0, body, failure: () => failure });
    });
    if (Buffer.isBuffer(o.body)) req.end(o.body);
    else if (typeof o.body === 'function') {
      const src = o.body();
      src.on('error', (e) => fail(e));
      src.pipe(req);
    } else req.end();
  });
}

async function readAll(sent: Sent): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const c of sent.body) chunks.push(c as Buffer);
  } catch (e) {
    throw bodyError(sent, e);
  }
  return Buffer.concat(chunks);
}

/** httpx's Response.text: UTF-8 with replacement. */
function text(b: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(b);
}

/**
 * httpx's line decoder: str.splitlines() semantics, applied incrementally, so a line
 * split across two reads is still one line.
 */
async function* iterLines(sent: Sent): AsyncGenerator<string> {
  try {
    yield* iterLinesRaw(sent.body);
  } catch (e) {
    throw bodyError(sent, e);
  }
}

async function* iterLinesRaw(body: Readable): AsyncGenerator<string> {
  const dec = new TextDecoder('utf-8', { fatal: false });
  const NEWLINE = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;
  let buffer = '';
  let trailingCr = false;
  const decode = (chunk: string): string[] => {
    let t = chunk;
    if (trailingCr) {
      t = '\r' + t;
      trailingCr = false;
    }
    if (t.endsWith('\r')) {
      trailingCr = true;
      t = t.slice(0, -1);
    }
    if (!t) return [];
    const trailingNewline = NEWLINE.test(t[t.length - 1]);
    const lines = t.split(new RegExp(NEWLINE.source));
    if (trailingNewline) lines.pop(); // splitlines() drops the empty tail
    if (lines.length === 1 && !trailingNewline) {
      buffer += lines[0];
      return [];
    }
    if (buffer) {
      lines[0] = buffer + lines[0];
      buffer = '';
    }
    if (!trailingNewline) buffer = lines.pop() ?? '';
    return lines;
  };
  for await (const c of body) {
    for (const line of decode(dec.decode(c as Buffer, { stream: true }))) yield line;
  }
  const tail = dec.decode();
  if (tail) for (const line of decode(tail)) yield line;
  if (buffer || trailingCr) {
    yield buffer;
    buffer = '';
    trailingCr = false;
  }
}

function jsonBody(v: unknown): Buffer {
  // httpx 0.28's json= encoding, byte for byte
  return Buffer.from(pyDumps(v, { separators: [',', ':'], ensureAscii: false, allowNan: false }), 'utf8');
}

/** The rows of /dub/history, whichever shape the reply takes. */
function historyRows(hist: any): any[] {
  if (Array.isArray(hist)) return hist;
  if (hist && typeof hist === 'object') return hist.jobs || hist.history || [];
  return [];
}

function isDict(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PyFloat);
}

/** The part of the engine's surface the worker uses; the fake implements it too. */
export interface Engine {
  base: string;
  sysinfo(): Promise<unknown>;
  waitReady(timeoutS?: number, pollS?: number, onWait?: ((m: string) => void) | null): Promise<unknown>;
  upload(videoPath: string, vsJobId: string): Promise<unknown>;
  waitPrep(vsJobId: string, timeoutS?: number, pollS?: number, onWait?: ((m: string) => void) | null): Promise<Record<string, any>>;
  transcribeStream(vsJobId: string, numSpeakers?: number | null, onProgress?: ((ev: Record<string, any>) => void) | null): Promise<[Array<Record<string, any>>, string[]]>;
  translate(body: Record<string, unknown>, timeoutS?: number): Promise<[any[], unknown]>;
  generate(vsJobId: string, body: Record<string, unknown>): Promise<string>;
  taskStream(taskId: string, afterSeq?: number): AsyncGenerator<Record<string, any>>;
  jobRecord(vsJobId: string): Promise<Record<string, any> | null>;
  storedSegments(vsJobId: string): Promise<Array<Record<string, any>>>;
  detectedSourceLang(vsJobId: string): Promise<string | null>;
  tracks(vsJobId: string): Promise<unknown>;
  hasTrack(vsJobId: string, targetLang: string): Promise<boolean>;
  download(vsJobId: string, query: Record<string, unknown>, dest: string): Promise<number>;
  deleteHistory(vsJobId: string): Promise<void>;
}

/** A thin, faithful client. No retries that could double-render, no cleverness. */
export class VoiceStudioEngine implements Engine {
  readonly base: string;
  constructor(baseUrl: string = ENGINE_URL) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  // ── plumbing ─────────────────────────────────────────────────────────────
  private async getJson(p: string, timeoutS = 60.0): Promise<any> {
    const r = await sendRequest(this.base, { method: 'GET', path: p, readTimeoutS: timeoutS });
    const raw = await readAll(r);
    if (r.status >= 400) throw new EngineError(`GET ${p} -> ${r.status}: ${pySlice(text(raw), 300)}`);
    return pyLoadsBytes(raw);
  }

  private async postJson(p: string, body: unknown, timeoutS = 300.0): Promise<any> {
    const r = await sendRequest(this.base, {
      method: 'POST',
      path: p,
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody(body),
      readTimeoutS: timeoutS,
    });
    const raw = await readAll(r);
    if (r.status >= 400) throw new EngineError(`POST ${p} -> ${r.status}: ${pySlice(text(raw), 300)}`);
    return pyLoadsBytes(raw);
  }

  // ── 0. readiness ─────────────────────────────────────────────────────────
  async sysinfo(): Promise<unknown> {
    try {
      return await this.getJson('/sysinfo', 20.0);
    } catch (e) {
      if (e instanceof HTTPError) throw new EngineUnavailable(`engine not reachable at ${this.base}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Poll /sysinfo until it answers. A healthy instance does not guarantee a healthy
   * app, so this gate is about the application answering.
   */
  async waitReady(timeoutS = 900.0, pollS = 5.0, onWait: ((m: string) => void) | null = null): Promise<unknown> {
    const deadline = Date.now() + timeoutS * 1000;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try {
        return await this.sysinfo();
      } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        last = e;
        if (onWait) onWait(`waiting for the engine: ${pySlice(e.message, 120)}`);
        await sleep(pollS * 1000);
      }
    }
    throw new EngineUnavailable(`engine never became ready: ${last instanceof Error ? last.message : last}`);
  }

  // ── 1. upload ────────────────────────────────────────────────────────────
  async upload(videoPath: string, vsJobId: string): Promise<unknown> {
    // httpx's multipart layout: a 32-hex boundary, data fields first, then the file.
    const boundary = randomBytes(16).toString('hex');
    const param = (name: string, value: string) =>
      `${name}="${value.replace(/["\\\x00-\x1a\x1c-\x1f]/g, (c) => (c === '"' ? '%22' : c === '\\' ? '\\\\' : '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')))}"`;
    const field = (name: string, value: string) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; ${param('name', name)}\r\n\r\n${value}\r\n`, 'utf8');
    const filename = path.basename(videoPath);
    const head = Buffer.concat([
      field('job_id', vsJobId),
      field('input_type', 'video'),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; ${param('name', 'video')}; ${param('filename', filename)}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      ),
    ]);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const size = statSync(videoPath).size;
    const r = await sendRequest(this.base, {
      method: 'POST',
      path: '/dub/upload',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: () =>
        Readable.from(
          (async function* () {
            yield head;
            for await (const c of createReadStream(videoPath, { highWaterMark: 64 * 1024 })) yield c as Buffer;
            yield tail;
          })(),
        ),
      bodyLength: head.length + size + tail.length,
      readTimeoutS: 3600.0,
    });
    const raw = await readAll(r);
    if (r.status >= 400) throw new EngineError(`upload -> ${r.status}: ${pySlice(text(raw), 300)}`);
    return pyLoadsBytes(raw);
  }

  // ── 2. wait for prep ─────────────────────────────────────────────────────
  /** Poll /dub/history until this job's row carries vocals_path. */
  async waitPrep(vsJobId: string, timeoutS = 1800.0, pollS = 4.0, onWait: ((m: string) => void) | null = null): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      const hist = await this.getJson('/dub/history', 60.0);
      for (const row of historyRows(hist)) {
        if (!isDict(row)) continue;
        const rid = row.job_id || row.id;
        if (pyStr(rid) !== String(vsJobId)) continue;
        let jd: any = row.job_data || row;
        if (typeof jd === 'string') {
          try {
            jd = pyLoadsBytes(Buffer.from(jd, 'utf8'));
          } catch {
            jd = {};
          }
        }
        if (isDict(jd) && (jd.vocals_path || jd.audio_path)) return jd;
      }
      if (onWait) onWait('separating speech from background');
      await sleep(pollS * 1000);
    }
    throw new EngineError('prep did not finish in time (no vocals_path appeared)');
  }

  // ── 3. transcribe + diarize + clone, over SSE ────────────────────────────
  /**
   * Returns [segments, warnings], keeping the richest segment list seen. If the stream
   * stalls, what arrived is KEPT rather than falling back to the POST endpoint.
   */
  async transcribeStream(
    vsJobId: string,
    numSpeakers: number | null = null,
    onProgress: ((ev: Record<string, any>) => void) | null = null,
  ): Promise<[Array<Record<string, any>>, string[]]> {
    const q = numSpeakers ? `?num_speakers=${Math.trunc(numSpeakers)}` : '';
    const url = `/dub/transcribe-stream/${vsJobId}${q}`;
    let segs: Array<Record<string, any>> | null = null;
    const warnings: string[] = [];
    try {
      const r = await sendRequest(this.base, { method: 'GET', path: url, readTimeoutS: ENGINE_STREAM_READ_TIMEOUT_S });
      if (r.status >= 400) {
        r.body.resume();
        throw new EngineError(`transcribe-stream -> ${r.status}`);
      }
      for await (const line of iterLines(r)) {
        if (!line || !line.startsWith('data:')) continue;
        let ev: unknown;
        try {
          ev = pyLoadsBytes(Buffer.from(pyStrip(line.slice(5)), 'utf8'));
        } catch {
          continue;
        }
        if (!isDict(ev)) continue;
        const got = ev.segments;
        if (truthyList(got) && (segs === null || got.length >= segs.length)) segs = got;
        if (truthy(ev.detail)) warnings.push(pyStr(ev.detail));
        if (onProgress) onProgress(ev);
      }
    } catch (e) {
      if (e instanceof ReadTimeout || e instanceof RemoteProtocolError) {
        if (!segs || !segs.length) throw new EngineError(`transcribe stream died with nothing usable: ${e.message}`);
        warnings.push(`stream stalled, kept ${segs.length} segments already received`);
      } else throw e;
    }
    if (!segs || !segs.length) throw new EngineError('transcribe returned no segments');
    return [segs, warnings];
  }

  // ── 4. translate ─────────────────────────────────────────────────────────
  /** Returns [normalised list, raw reply], so the caller can store what actually arrived. */
  async translate(body: Record<string, unknown>, timeoutS = 3600.0): Promise<[any[], unknown]> {
    const raw = await this.postJson('/dub/translate', body, timeoutS);
    let out: any = raw;
    if (isDict(out)) {
      if (out.error) throw new EngineError(`translate refused: ${pyStr(out.error)}`);
      // "translated" first: it is what the live engine sends.
      let found = false;
      for (const key of ['translated', 'segments', 'results', 'translations', 'lines', 'data']) {
        const v = out[key];
        if (Array.isArray(v)) {
          out = v;
          found = true;
          break;
        }
      }
      if (!found) {
        throw new EngineError(`translate returned a dict with no recognised list of segments. Keys were: ${pyRepr(Object.keys(out).sort())}`);
      }
    }
    if (!Array.isArray(out)) throw new EngineError(`translate returned an unexpected shape: ${pyTypeName(out)}`);
    return [out, raw];
  }

  // ── 5. render ────────────────────────────────────────────────────────────
  async generate(vsJobId: string, body: Record<string, unknown>): Promise<string> {
    const out = await this.postJson(`/dub/generate/${vsJobId}`, body, 300.0);
    const taskId = isDict(out) ? out.task_id : null;
    if (!taskId) throw new EngineError(`generate did not return a task id: ${pySlice(pyReprLoose(out), 300)}`);
    return taskId;
  }

  // ── 6. progress ──────────────────────────────────────────────────────────
  /** SSE progress. after_seq makes it resumable. */
  async *taskStream(taskId: string, afterSeq = 0): AsyncGenerator<Record<string, any>> {
    const r = await sendRequest(this.base, {
      method: 'GET',
      path: `/tasks/stream/${taskId}?after_seq=${afterSeq}`,
      readTimeoutS: ENGINE_STREAM_READ_TIMEOUT_S,
    });
    if (r.status >= 400) {
      r.body.resume();
      throw new EngineError(`task stream -> ${r.status}`);
    }
    try {
      for await (const line of iterLines(r)) {
        if (!line || !line.startsWith('data:')) continue;
        let ev: unknown;
        try {
          ev = pyLoadsBytes(Buffer.from(pyStrip(line.slice(5)), 'utf8'));
        } catch {
          continue;
        }
        yield ev as Record<string, any>;
      }
    } finally {
      r.body.destroy();
    }
  }

  /** The engine's own stored record for this job, out of /dub/history. */
  async jobRecord(vsJobId: string): Promise<Record<string, any> | null> {
    let hist: any;
    try {
      hist = await this.getJson('/dub/history', 120.0);
    } catch (e) {
      if (e instanceof EngineError) return null;
      throw e;
    }
    for (const row of historyRows(hist)) {
      if (!isDict(row)) continue;
      if (pyStr(row.job_id || row.id) !== String(vsJobId)) continue;
      let jd: any = row.job_data || row;
      if (typeof jd === 'string') {
        try {
          jd = pyLoadsBytes(Buffer.from(jd, 'utf8'));
        } catch {
          return null;
        }
      }
      return isDict(jd) ? jd : null;
    }
    return null;
  }

  /**
   * THE AUTHORITATIVE SEGMENT LIST. The engine maps a render onto its own stored
   * segments BY ID, and only those ids carry the per-line voice bindings.
   */
  async storedSegments(vsJobId: string): Promise<Array<Record<string, any>>> {
    const jd = await this.jobRecord(vsJobId);
    if (!jd) return [];
    const segs = jd.segments;
    return Array.isArray(segs) ? segs.filter(isDict) : [];
  }

  /** What language the engine decided the source is; sent back explicitly on translate. */
  async detectedSourceLang(vsJobId: string): Promise<string | null> {
    let hist: any;
    try {
      hist = await this.getJson('/dub/history', 60.0);
    } catch (e) {
      if (e instanceof EngineError) return null;
      throw e;
    }
    for (const row of historyRows(hist)) {
      if (!isDict(row)) continue;
      if (pyStr(row.job_id || row.id) !== String(vsJobId)) continue;
      let jd: any = row.job_data || row;
      if (typeof jd === 'string') {
        try {
          jd = pyLoadsBytes(Buffer.from(jd, 'utf8'));
        } catch {
          return null;
        }
      }
      for (const key of ['source_lang', 'source_language', 'detected_lang', 'detected_language', 'lang']) {
        const v = isDict(jd) ? jd[key] : undefined;
        if (typeof v === 'string' && pyLen(v) >= 2 && pyLen(v) <= 5) return v.toLowerCase();
      }
    }
    return null;
  }

  // ── 6b. the real completion signal ───────────────────────────────────────
  async tracks(vsJobId: string): Promise<unknown> {
    return this.getJson(`/dub/tracks/${vsJobId}`, 60.0);
  }

  async hasTrack(vsJobId: string, targetLang: string): Promise<boolean> {
    let t: any;
    try {
      t = await this.tracks(vsJobId);
    } catch (e) {
      if (e instanceof EngineError) return false;
      throw e;
    }
    if (isDict(t)) {
      for (const key of ['tracks', 'dubbed_tracks', 'languages']) {
        const v = t[key];
        if (isDict(v) && Object.prototype.hasOwnProperty.call(v, targetLang)) return true;
        if (Array.isArray(v) && v.includes(targetLang)) return true;
      }
      if (Object.prototype.hasOwnProperty.call(t, targetLang)) return true;
    }
    return false;
  }

  // ── 7. download ──────────────────────────────────────────────────────────
  async download(vsJobId: string, query: Record<string, unknown>, dest: string): Promise<number> {
    mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const qs = urlencode(Object.entries(query).map(([k, v]) => [k, httpxPrimitive(v)] as [string, unknown]));
    const r = await sendRequest(this.base, {
      method: 'GET',
      path: `/dub/download/${vsJobId}${qs ? '?' + qs : ''}`,
      readTimeoutS: 600.0,
    });
    if (r.status >= 400) {
      const raw = await readAll(r);
      throw new EngineError(`download -> ${r.status}: ${pySlice(text(raw), 200)}`);
    }
    let total = 0;
    r.body.on('data', (c: Buffer) => (total += c.length));
    try {
      await pipeline(r.body, createWriteStream(tmp));
    } catch (e) {
      throw bodyError(r, e);
    }
    await fsp.rename(tmp, dest);
    return total;
  }

  // ── 9. clean our media off the shared box ────────────────────────────────
  async deleteHistory(vsJobId: string): Promise<void> {
    try {
      const r = await sendRequest(this.base, { method: 'DELETE', path: `/dub/history/${vsJobId}`, readTimeoutS: 120.0 });
      r.body.resume();
    } catch {
      // best effort: failing to tidy up must never fail a finished job
    }
  }
}

// ── small Python-isms the messages above depend on ───────────────────────────

/** str(v) for the values that reach an error message. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || v instanceof PyFloat) return pyReprLoose(v);
  return pyReprLoose(v);
}

function pyReprLoose(v: unknown): string {
  try {
    return pyRepr(v);
  } catch {
    return String(v);
  }
}

function truthyList(v: unknown): v is Array<Record<string, any>> {
  return Array.isArray(v) && v.length > 0;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "<class 'NoneType'>";
  if (typeof v === 'string') return "<class 'str'>";
  if (typeof v === 'boolean') return "<class 'bool'>";
  if (v instanceof PyFloat) return "<class 'float'>";
  if (typeof v === 'number') return Number.isInteger(v) ? "<class 'int'>" : "<class 'float'>";
  return "<class 'dict'>";
}

/** httpx's primitive_value_to_str for query parameters. */
function httpxPrimitive(v: unknown): string {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Real engine, or the stand-in, decided by configuration alone. */
export function getEngine(): Engine {
  if (ENGINE_MODE === 'real') return new VoiceStudioEngine();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { FakeEngine } = require('./fakeEngine') as typeof import('./fakeEngine');
  return new FakeEngine();
}

export { errText };
