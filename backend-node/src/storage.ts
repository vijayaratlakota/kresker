/**
 * Where finished videos live: Cloudflare R2 when configured, local disk otherwise. R2
 * because downloads out of it are free at any volume, which is what makes "unlimited
 * downloads" cost nothing beyond storage.
 *
 * The S3-compatible calls go through the `aws` CLI with `--endpoint-url`, exactly as the
 * Python backend made them. That keeps one credential path and no SDK; the credentials
 * are passed per call in the environment and never written to a config file.
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { R2_ENABLED, R2_ENV_FILE, R2_PREFIX, readEnvFile } from './config';
import { pyQuote } from './http';
import * as procs from './procs';
import { errText, pySlice, pyStrip } from './py';

let cfg: Record<string, string> | null = null;

// A browser's own uploads land here, apart from delivered dubs, so the sweeper that
// clears abandoned ones can never reach a finished video.
export const STAGING_PREFIX = '_incoming';

/** The same r2.env the backups use. */
function loadCfg(): Record<string, string> {
  if (cfg === null) cfg = readEnvFile(R2_ENV_FILE);
  return cfg;
}

export function enabled(): boolean {
  if (!R2_ENABLED) return false;
  const c = loadCfg();
  return ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].every((k) => Boolean(c[k]));
}

export function status(): Record<string, unknown> {
  const c = loadCfg();
  return {
    backend: enabled() ? 'cloudflare-r2' : 'local-disk',
    r2_configured: Boolean(c.R2_ACCOUNT_ID),
    r2_enabled_flag: R2_ENABLED,
    bucket: enabled() ? c.R2_BUCKET ?? null : null,
    prefix: R2_PREFIX,
    env_file: R2_ENV_FILE,
    note: 'downloads out of R2 are free at any volume, which is what makes unlimited downloads cost nothing beyond storage',
  };
}

function awsEnv(): NodeJS.ProcessEnv {
  const c = loadCfg();
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: c.R2_ACCESS_KEY_ID ?? '',
    AWS_SECRET_ACCESS_KEY: c.R2_SECRET_ACCESS_KEY ?? '',
    AWS_DEFAULT_REGION: 'auto',
    // R2 rejects the newer default checksum headers the CLI adds
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  };
}

function endpoint(): string {
  return `https://${loadCfg().R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function bucket(): string {
  return loadCfg().R2_BUCKET ?? '';
}

export function keyFor(jobId: string, targetLang: string): string {
  return `${R2_PREFIX}/${jobId}/dubbed_${targetLang}.mp4`;
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Upload one object. Never throws on failure: a delivered file already on local disk is
 * still deliverable.
 */
export async function put(local: string, key: string, timeoutS = 3600.0): Promise<Record<string, unknown>> {
  if (!enabled()) return { ok: false, why: 'R2 not enabled' };
  const cmd = [
    'aws', 's3api', 'put-object',
    '--endpoint-url', endpoint(),
    '--bucket', bucket(), '--key', key,
    '--body', local,
    '--content-type', 'video/mp4',
    '--query', 'ETag', '--output', 'text',
  ];
  let p: procs.RunResult;
  try {
    p = await procs.run(cmd, { timeoutMs: timeoutS * 1000, env: awsEnv() });
  } catch (e) {
    return { ok: false, why: errText(e) };
  }
  if (p.code !== 0) return { ok: false, why: pySlice(p.stderr || '', 300) };
  return { ok: true, key, etag: pyStrip(p.stdout || ''), bytes: sizeOf(local) };
}

/** A time-limited URL for one object, so the bytes never pass through us. */
export async function presign(key: string, ttlS = 300): Promise<string | null> {
  if (!enabled()) return null;
  const cmd = ['aws', 's3', 'presign', `s3://${bucket()}/${key}`, '--endpoint-url', endpoint(), '--expires-in', String(Math.trunc(ttlS))];
  try {
    const p = await procs.run(cmd, { timeoutMs: 120_000, env: awsEnv() });
    if (p.code !== 0) return null;
    return pyStrip(p.stdout || '') || null;
  } catch {
    return null;
  }
}

export async function del(key: string): Promise<boolean> {
  if (!enabled()) return false;
  const cmd = ['aws', 's3api', 'delete-object', '--endpoint-url', endpoint(), '--bucket', bucket(), '--key', key];
  try {
    const p = await procs.run(cmd, { timeoutMs: 300_000, env: awsEnv() });
    return p.code === 0;
  } catch {
    return false;
  }
}

export async function exists(key: string): Promise<boolean> {
  if (!enabled()) return false;
  const cmd = ['aws', 's3api', 'head-object', '--endpoint-url', endpoint(), '--bucket', bucket(), '--key', key];
  try {
    const p = await procs.run(cmd, { timeoutMs: 120_000, env: awsEnv() });
    return p.code === 0;
  } catch {
    return false;
  }
}

/**
 * Size and type of one object, or null. The size is read from HERE, never from the
 * client, which could otherwise declare a small file and send a large one.
 */
export async function head(key: string): Promise<{ bytes: number; content_type: string | null; etag: string } | null> {
  if (!enabled()) return null;
  const cmd = ['aws', 's3api', 'head-object', '--endpoint-url', endpoint(), '--bucket', bucket(), '--key', key, '--output', 'json'];
  let d: Record<string, any>;
  try {
    const p = await procs.run(cmd, { timeoutMs: 120_000, env: awsEnv() });
    if (p.code !== 0) return null;
    d = JSON.parse(p.stdout || '{}');
  } catch {
    return null;
  }
  return {
    bytes: Math.trunc(Number(d.ContentLength || 0)),
    content_type: d.ContentType ?? null,
    etag: String(d.ETag || '').replace(/^"+|"+$/g, ''),
  };
}

/** Bring one object down to local disk: the other direction of `put`. */
export async function fetchObject(key: string, local: string, timeoutS = 3600.0): Promise<Record<string, unknown>> {
  if (!enabled()) return { ok: false, why: 'R2 not enabled' };
  mkdirSync(path.dirname(local), { recursive: true });
  const cmd = ['aws', 's3api', 'get-object', '--endpoint-url', endpoint(), '--bucket', bucket(), '--key', key, local];
  let p: procs.RunResult;
  try {
    p = await procs.run(cmd, { timeoutMs: timeoutS * 1000, env: awsEnv() });
  } catch (e) {
    return { ok: false, why: errText(e) };
  }
  const drop = () => {
    try {
      unlinkSync(local);
    } catch {
      /* missing_ok */
    }
  };
  if (p.code !== 0) {
    drop();
    return { ok: false, why: pySlice(p.stderr || '', 300) };
  }
  if (!existsSync(local) || sizeOf(local) === 0) {
    drop();
    return { ok: false, why: 'the object downloaded empty' };
  }
  return { ok: true, key, bytes: sizeOf(local) };
}

// ── letting the browser upload straight into storage ──────────────────────────
// A presigned PUT, signed here (SigV4) because the CLI only presigns GETs. Sending the
// bytes straight at storage instead of through our origin made uploads three to four
// times faster.

/** pathlib's Path(name).name: the last component, never "." */
function baseName(filename: string): string {
  const b = path.basename(filename);
  return b === '.' ? '' : b;
}

/**
 * Where a browser is allowed to put bytes. The user id and a fresh upload id are both in
 * the path, and only the signing endpoint chooses it, so one customer cannot be handed a
 * URL that overwrites another's object.
 */
export function stagingKey(userId: number, uploadId: string, filename: string): string {
  const safe = pySlice(baseName(filename || 'video').replace(/[^A-Za-z0-9._-]+/g, '_'), 120) || 'video';
  return `${STAGING_PREFIX}/${Math.trunc(userId)}/${uploadId}/${safe}`;
}

/**
 * A URL the browser may PUT one object to, for a limited time. UNSIGNED-PAYLOAD, so a
 * phone does not have to hash a whole video before it can start sending; content-type is
 * deliberately not signed, because intermediaries adjust it and nothing trusts it anyway.
 */
export function presignPut(key: string, ttlS = 900, _contentType = 'application/octet-stream'): string | null {
  if (!enabled()) return null;
  const c = loadCfg();
  const access = c.R2_ACCESS_KEY_ID ?? '';
  const secret = c.R2_SECRET_ACCESS_KEY ?? '';
  if (!access || !secret) return null;

  const host = `${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const service = 's3';
  const iso = new Date().toISOString(); // 2026-08-24T10:00:00.000Z
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '') + 'Z';
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;

  const canonicalUri = '/' + pyQuote(`${bucket()}/${key}`, '/');
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${access}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(Math.trunc(ttlS)),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQs = Object.keys(params)
    .sort()
    .map((k) => `${pyQuote(k, '-_.~')}=${pyQuote(params[k], '-_.~')}`)
    .join('&');
  const canonicalRequest = ['PUT', canonicalUri, canonicalQs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');

  const h = (k: Buffer | string, m: string) => createHmac('sha256', k).update(m, 'utf8').digest();
  const kSigning = h(h(h(h(Buffer.from(`AWS4${secret}`, 'utf8'), day), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  return `https://${host}${canonicalUri}?${canonicalQs}&X-Amz-Signature=${signature}`;
}

/**
 * Delete abandoned staging objects. A customer who asks for a signature and closes the
 * tab leaves bytes nothing will reference. Six hours is far longer than any upload.
 */
export async function sweepStaging(olderThanHours = 6.0): Promise<number> {
  if (!enabled()) return 0;
  const cmd = ['aws', 's3api', 'list-objects-v2', '--endpoint-url', endpoint(), '--bucket', bucket(), '--prefix', `${STAGING_PREFIX}/`, '--output', 'json'];
  let items: Array<Record<string, any>>;
  try {
    const p = await procs.run(cmd, { timeoutMs: 300_000, env: awsEnv() });
    if (p.code !== 0) return 0;
    items = (JSON.parse(p.stdout || '{}') || {}).Contents || [];
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanHours * 3600_000;
  let gone = 0;
  for (const it of items) {
    const when = Date.parse(String(it.LastModified || ''));
    if (Number.isNaN(when)) continue;
    if (when < cutoff && (await del(String(it.Key || '')))) gone++;
  }
  return gone;
}
