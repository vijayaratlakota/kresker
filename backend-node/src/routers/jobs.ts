/**
 * Upload, start a dub, watch it, download it, delete it.
 *
 * The client sends the target language and nothing else that can steer the pipeline;
 * everything else comes from the golden preset.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { DOWNLOAD_TOKEN_TTL_S, FFPROBE, MAX_UPLOAD_BYTES, STREAM_TOKEN_TTL_S, UPLOAD_DIR, UPLOAD_URL_TTL_S } from '../config';
import * as db from '../db';
import type { Row } from '../db';
import { ownedJob, requireCsrf, requireUser } from '../deps';
import * as gpu from '../gpu';
import { ApiRouter, HTTPException, RedirectResponse, type UploadedFile } from '../http';
import * as media from '../media';
import * as paths from '../paths';
import * as preset from '../preset';
import * as procs from '../procs';
import { PyFloat, pyFixed, pyRepr, pyRound, pyStrip } from '../py';
import * as ratelimit from '../ratelimit';
import * as storage from '../storage';
import * as tokens from '../tokens';
import { Model, optional, required, t } from '../validate';

export const router = new ApiRouter('/api', ['jobs']);

const hex = (n: number) => randomUUID().replace(/-/g, '').slice(0, n);

/** A REAL column as Python reads it: a float, or None. */
function real(v: unknown): PyFloat | null {
  return v === null || v === undefined ? null : new PyFloat(Number(v));
}

/** What ffprobe actually found — never what the client claimed. */
async function probe(file: string): Promise<{ duration_s: number; has_audio: boolean; codec: string | null }> {
  let data: Record<string, any>;
  try {
    const out = await procs.run([FFPROBE, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 180_000 });
    data = JSON.parse(out.stdout || '{}');
  } catch (e) {
    throw new HTTPException(400, `could not read that file as video: ${(e as Error).message ?? e}`);
  }
  const fmt = data.format || {};
  const streams = (data.streams || []) as Array<Record<string, any>>;
  const dur = media.pyFloatParse(fmt.duration || 0);
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  const vcodec = streams.find((s) => s.codec_type === 'video')?.codec_name ?? null;
  if (dur <= 0) throw new HTTPException(400, 'that file has no readable duration');
  if (!hasAudio) throw new HTTPException(400, 'that video has no audio track, so there is nothing to dub');
  return { duration_s: dur, has_audio: hasAudio, codec: vcodec };
}

/**
 * Everything that must be true before an upload may cost us anything: shared by both
 * upload routes so they cannot drift. A confirmed address is required (admins exempt).
 */
function uploadGate(req: Request): Row {
  const user = requireUser(req);
  requireCsrf(req);
  const verified = 'email_verified_at' in user ? user.email_verified_at : null;
  if (!verified && user.role !== 'admin') {
    throw new HTTPException(
      403,
      'confirm your email address before your first dub - check your inbox for the link, or ask for a new one from your account page',
    );
  }
  return user;
}

function unlinkQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* missing_ok */
  }
}

/**
 * A video has landed on our disk: probe it, check the plan, record it. Shared by both
 * upload routes, so the direct one cannot become the lenient way in. Deletes the file on
 * every refusal.
 */
async function acceptUpload(
  user: Row,
  uploadId: string,
  dest: string,
  originalName: string | null,
  contentType: string | null,
  size: number,
): Promise<Record<string, unknown>> {
  let info: { duration_s: number; has_audio: boolean; codec: string | null };
  try {
    info = await probe(dest);
  } catch (e) {
    unlinkQuiet(dest);
    throw e;
  }
  const ent = db.entitlement(user.id);
  const isAdmin = user.role === 'admin';

  // Quota before any work. An admin is exempt from the LIMIT, never from being counted.
  const minutes = info.duration_s / 60.0;
  if (!isAdmin) {
    if (info.duration_s > ent.max_video_seconds) {
      unlinkQuiet(dest);
      // structured: "shorten this" is a different instruction from "out of minutes"
      throw new HTTPException(400, {
        code: 'video_too_long',
        message: `that video is ${pyFixed(info.duration_s, 0)}s. Your plan (${ent.plan_name}) allows up to ${ent.max_video_seconds}s per video. Trim it and upload it again.`,
        duration_s: new PyFloat(pyRound(info.duration_s, 2)),
        max_video_seconds: Math.trunc(ent.max_video_seconds),
        plan_name: ent.plan_name,
      });
    }
    if (minutes > ent.minutes_left + 1e-6) {
      unlinkQuiet(dest);
      throw new HTTPException(402, {
        code: 'not_enough_minutes',
        message: `that video needs ${pyFixed(minutes, 2)} minutes and you have ${pyFixed(ent.minutes_left, 2)} left on ${ent.plan_name}.`,
        duration_s: new PyFloat(pyRound(info.duration_s, 2)),
        minutes_needed: new PyFloat(pyRound(minutes, 3)),
        minutes_left: new PyFloat(pyRound(ent.minutes_left, 3)),
        plan_name: ent.plan_name,
      });
    }
  }

  db.execute(
    'INSERT INTO uploads (id, user_id, stored_path, original_name, bytes, content_type, probed_duration_s, probed_has_audio, probed_codec, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,\'ready\',?)',
    [uploadId, user.id, paths.store(dest), originalName, size, contentType, new PyFloat(info.duration_s), 1, info.codec, db.now()],
  );
  return {
    upload_id: uploadId,
    duration_s: new PyFloat(pyRound(info.duration_s, 2)),
    minutes: new PyFloat(pyRound(minutes, 3)),
    bytes: size,
    entitlement: ent,
  };
}

/** pathlib's Path(name).name */
function baseName(name: string): string {
  const b = path.basename(name);
  return b === '.' ? '' : b;
}

/**
 * The video streamed through us as multipart. Still the fallback: it needs no object
 * storage, so it works on a bare install, in the test suites, and if the bucket is down.
 */
router.post(
  '/uploads',
  { name: 'create_upload', upload: { field: 'file', dir: UPLOAD_DIR, maxBytes: MAX_UPLOAD_BYTES } },
  async (req, _res, { file }: { file: UploadedFile }) => {
    const user = uploadGate(req);
    ratelimit.check('upload', String(user.id));

    const uploadId = hex(32);
    const dest = path.join(UPLOAD_DIR, `${uploadId}_${baseName(file.filename || 'video')}`);
    if (file.tooLarge) throw new HTTPException(413, 'file is too large');
    renameSync(file.path, dest);
    return acceptUpload(user, uploadId, dest, file.filename, file.contentType, file.size);
  },
);

// ── uploading straight into storage ───────────────────────────────────────────
// The browser PUTs the video to storage itself and we import it: an 80 MB upload goes
// from about 81 seconds to about 22, and the proxy's hundred-second ceiling is gone.

const PresignRequest = new Model('PresignRequest', {
  filename: required(t.str()),
  content_type: optional(t.nullable(t.str()), null),
  // what the client BELIEVES it will send; only used to fail fast
  bytes: optional(t.nullable(t.int()), null),
});

/** A URL the browser may PUT one video to, once. The key is chosen HERE, never by the client. */
router.post('/uploads/presign', { name: 'presign_upload', body: PresignRequest }, (req, _res, { body }) => {
  const user = uploadGate(req);
  ratelimit.check('upload', String(user.id));
  if (!storage.enabled()) {
    // the dashboard falls back to sending the file through us
    throw new HTTPException(503, { code: 'direct_upload_unavailable', message: 'direct upload is not configured; use /api/uploads' });
  }
  const declared = Math.trunc(Number(body.bytes || 0));
  if (declared && declared > MAX_UPLOAD_BYTES) throw new HTTPException(413, 'file is too large');

  const uploadId = hex(32);
  const key = storage.stagingKey(user.id, uploadId, body.filename);
  const url = storage.presignPut(key, UPLOAD_URL_TTL_S, body.content_type || 'video/mp4');
  if (!url) throw new HTTPException(503, { code: 'direct_upload_unavailable', message: 'could not prepare the upload; use /api/uploads' });
  // NOTHING IS STARTED HERE: asking for an upload URL is not a decision to dub
  return {
    upload_id: uploadId,
    key,
    url,
    expires_in_s: UPLOAD_URL_TTL_S,
    note: 'PUT the file to `url` with Content-Type set, then call /api/uploads/complete with the upload_id and key.',
  };
});

const CompleteRequest = new Model('CompleteRequest', {
  upload_id: required(t.str()),
  key: required(t.str()),
  filename: optional(t.nullable(t.str()), null),
  content_type: optional(t.nullable(t.str()), null),
});

/**
 * The browser finished its PUT: import the object and treat it as any other upload.
 * Every check is redone on what storage actually holds — the key must be this account's
 * own, the size comes from storage, and the length from ffprobe.
 */
router.post('/uploads/complete', { name: 'complete_upload', body: CompleteRequest }, async (req, _res, { body }) => {
  const user = uploadGate(req);
  if (!storage.enabled()) throw new HTTPException(503, 'direct upload is not configured');

  const expectedPrefix = `${storage.STAGING_PREFIX}/${Math.trunc(user.id)}/${body.upload_id}/`;
  if (!body.key.startsWith(expectedPrefix)) throw new HTTPException(403, 'that upload does not belong to you');
  if (db.one('SELECT id FROM uploads WHERE id=?', [body.upload_id])) throw new HTTPException(409, 'that upload was already completed');

  const head = await storage.head(body.key);
  if (!head || !head.bytes) {
    throw new HTTPException(400, { code: 'upload_not_found', message: 'we cannot find that upload. If the transfer was interrupted, please try again.' });
  }
  const size = Math.trunc(head.bytes);
  if (size > MAX_UPLOAD_BYTES) {
    await storage.del(body.key);
    throw new HTTPException(413, 'file is too large');
  }
  const name = baseName(body.filename || body.key);
  const dest = path.join(UPLOAD_DIR, `${body.upload_id}_${name}`);
  const rep = await storage.fetchObject(body.key, dest);
  if (!rep.ok) {
    throw new HTTPException(502, { code: 'import_failed', message: 'your video reached us but could not be read back. Please try again.' });
  }
  let out: Record<string, unknown>;
  try {
    out = await acceptUpload(user, body.upload_id, dest, name, body.content_type, size);
  } finally {
    // the staging copy has done its job either way
    await storage.del(body.key);
  }
  out.via = 'direct';
  return out;
});

// One language, or several (as ONE request, so the quota is checked against the total
// and the batch is atomic).
const NewJob = new Model('NewJob', {
  upload_id: required(t.str()),
  target_lang: optional(t.nullable(t.str()), null),
  target_langs: optional(t.nullable(t.list(t.str())), null),
  source_lang: optional(t.nullable(t.str()), null),
});

// How many jobs ONE request may create. The dubs run serially on one GPU, so this is
// about the box, not the money. The dashboard's picker stops at the same number.
export const MAX_LANGS_PER_REQUEST = 8;

// ISO 639-1, optionally with a region: a shape check, not a list of what we sell.
const LANG_RE = /^[a-z]{2,3}(-[a-z]{2})?$/;

/** The languages to dub into, in order, de-duplicated silently. */
function targetLangs(body: { target_lang: string | null; target_langs: string[] | null }): string[] {
  if (body.target_lang !== null && body.target_langs !== null) throw new HTTPException(400, 'send target_lang or target_langs, not both');
  let raw: string[];
  if (body.target_langs !== null) raw = [...body.target_langs];
  else if (body.target_lang !== null) raw = [body.target_lang];
  else throw new HTTPException(400, 'pick at least one language to dub into');

  const langs: string[] = [];
  for (const item of raw) {
    const lang = pyStrip(item || '').toLowerCase();
    // shape, not just length: the value reaches the jobs row, the storage key and ffmpeg
    if (!LANG_RE.test(lang)) throw new HTTPException(400, `target language ${pyRepr(item)} looks wrong`);
    if (!langs.includes(lang)) langs.push(lang);
  }
  if (!langs.length) throw new HTTPException(400, 'pick at least one language to dub into');
  if (langs.length > MAX_LANGS_PER_REQUEST) {
    throw new HTTPException(
      400,
      `at most ${MAX_LANGS_PER_REQUEST} languages in one go - each dub runs after the one before it, so a longer list takes proportionally longer. You asked for ${langs.length}; send the rest as another batch.`,
    );
  }
  return langs;
}

router.post('/jobs', { name: 'create_job', body: NewJob }, (req, _res, { body }) => {
  const user = requireUser(req);
  requireCsrf(req);

  // anything that could steer the pipeline is refused loudly
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined) set[k] = v;
  preset.rejectClientOverrides(set);

  const up = db.one('SELECT * FROM uploads WHERE id=? AND user_id=?', [body.upload_id, user.id]);
  if (!up) throw new HTTPException(404, 'not found');
  // Originals are deleted on the same clock as the dubs made from them (worker.ts,
  // sweepSourceUploads). Refused here, before anything is charged, rather than queued to
  // fail with nothing to send.
  let src: string | null = null;
  try {
    src = up.status === 'deleted' ? null : paths.resolve(up.stored_path);
  } catch {
    src = null; // a stored path that escapes the data directory is no source at all
  }
  if (!src || !existsSync(src)) {
    throw new HTTPException(
      410,
      'the original video has been deleted - we only keep it as long as the dubs made from it. Upload it again to dub it into more languages.',
    );
  }

  const langs = targetLangs(body);

  // one job per (upload, language): the same video into Telugu twice is a double charge
  const already = new Set(db.query('SELECT target_lang FROM jobs WHERE upload_id=?', [body.upload_id]).map((r) => r.target_lang));
  const clash = langs.filter((l) => already.has(l));
  if (clash.length) throw new HTTPException(409, 'that upload is already being dubbed into ' + clash.join(', '));

  const ent = db.entitlement(user.id);
  const minutes = Number(up.probed_duration_s) / 60.0;
  const total = minutes * langs.length;
  const isAdmin = user.role === 'admin';

  // Counting and blocking are different questions: every job is charged, admin included;
  // only the LIMIT is lifted for an admin.
  if (!isAdmin && total > ent.minutes_left + 1e-6) {
    throw new HTTPException(
      402,
      `${langs.length} language${langs.length > 1 ? 's' : ''} of a ${pyFixed(minutes, 2)} minute video needs ${pyFixed(total, 2)} minutes and you have ${pyFixed(ent.minutes_left, 2)} left on ${ent.plan_name}.`,
    );
  }

  const at = db.now();
  const created: Array<Record<string, unknown>> = [];
  // running balances: each language is its own charge row, drawn plan-first
  let planLeft = Number(ent.minutes_plan_left);
  let topupLeft = Number(ent.minutes_topup_left);

  db.transaction(() => {
    for (const lang of langs) {
      const jobId = hex(12);
      const [fromPlan, fromTopup] = db.splitCharge(minutes, planLeft, topupLeft);
      planLeft = Math.max(0.0, planLeft - fromPlan);
      topupLeft = Math.max(0.0, topupLeft - fromTopup);
      db.execute(
        "INSERT INTO jobs (id, user_id, upload_id, source_lang, target_lang, state, percent, minutes_quoted, origin, billable, created_at, queued_at) VALUES (?,?,?,?,?,'queued',0,?,?,?,?,?)",
        [jobId, user.id, body.upload_id, body.source_lang, lang, new PyFloat(minutes), isAdmin ? 'admin' : 'customer', 1, at, at],
      );
      // minutes_charged is the WHOLE charge; topup_minutes the part from the balance
      db.execute("INSERT INTO usage_ledger (user_id, job_id, minutes_charged, kind, note, at, topup_minutes) VALUES (?,?,?,'charge',?,?,?)", [
        user.id,
        jobId,
        new PyFloat(minutes),
        `dub queued (${lang})`,
        at,
        new PyFloat(fromTopup),
      ]);
      created.push({ job_id: jobId, target_lang: lang, minutes_charged: new PyFloat(pyRound(minutes, 3)) });
    }
  });

  // after the commit: an event describing a rolled-back job would be a false record
  for (const c of created) db.addEvent(c.job_id as string, 'queued', 0, `queued, ${pyFixed(minutes, 2)} minutes quoted, into ${c.target_lang}`);

  // THE ONLY PLACE A CUSTOMER'S ACTION STARTS A MACHINE: the work is real now. The
  // worker's own call when it claims the job is the actual guarantee.
  void gpu.ensureRunning(`dub requested by user ${user.id}`, false);

  return {
    job_id: created[0].job_id,
    jobs: created,
    state: 'queued',
    minutes_charged: new PyFloat(pyRound(total, 3)),
    billable: true,
  };
});

/**
 * One job, as the API describes it. `error_detail` is operator-only: it is usually the
 * engine talking about itself. The customer gets the short, stable `error_code`.
 */
export function jobView(row: Row, forAdmin = false): Record<string, unknown> {
  const now = db.now();
  const expired = Boolean(row.output_expires_at && row.output_expires_at <= now);
  const deleted = Boolean(row.output_deleted_at);
  const view: Record<string, unknown> = {
    job_id: row.id,
    state: row.state,
    percent: new PyFloat(pyRound(Number(row.percent || 0), 1)),
    target_lang: row.target_lang,
    minutes_quoted: real(row.minutes_quoted),
    created_at: row.created_at,
    finished_at: row.finished_at,
    error_code: row.error_code,
  };
  if (forAdmin) view.error_detail = row.error_detail;
  Object.assign(view, {
    preset_version: row.preset_version,
    preset_sha256: row.preset_sha256,
    output_bytes: row.output_bytes,
    expires_at: row.output_expires_at,
    deleted_at: row.output_deleted_at,
    deleted_by: row.output_deleted_by,
    download_count: row.download_count,
    // decided in one place, so the UI and the API cannot disagree
    can_download: Boolean(row.state === 'done' && row.output_path && !deleted && !expired),
    can_cancel: ['queued', 'claimed', 'preparing', 'transcribing', 'translating', 'rendering'].includes(row.state),
  });
  return view;
}

router.get('/jobs', { name: 'list_jobs' }, (req) => {
  const user = requireUser(req);
  const rows = db.query('SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 200', [user.id]);
  return { jobs: rows.map((r) => jobView(r, user.role === 'admin')), entitlement: db.entitlement(user.id) };
});

router.get('/jobs/{job_id}', { name: 'get_job', path: { job_id: t.str() } }, (req, _res, { job_id }) => {
  const user = requireUser(req);
  const row = ownedJob(user, job_id);
  const view = jobView(row, user.role === 'admin');
  view.segments = db.query('SELECT * FROM job_segments WHERE job_id=? ORDER BY ordinal', [job_id]).map((s) => ({
    seg_id: s.seg_id,
    ordinal: s.ordinal,
    start: real(s.start_s),
    end: real(s.end_s),
    speaker: s.speaker_label,
    source_text: s.source_text,
    translated_text: s.translated_text,
  }));
  // operator-only lines are for an admin's eyes alone
  const everything = user.role === 'admin';
  view.events = db
    .query('SELECT * FROM job_events WHERE job_id=?' + (everything ? '' : ' AND COALESCE(internal,0)=0') + ' ORDER BY id DESC LIMIT 60', [job_id])
    .map((e) => ({ at: e.at, state: e.state, percent: real(e.percent), detail: e.detail }))
    .reverse();
  return view;
});

/** Progress by polling: it survives a refresh, a proxy and a laptop lid. Never internal lines. */
router.get(
  '/jobs/{job_id}/events',
  { name: 'job_events', path: { job_id: t.str() }, query: { after_id: optional(t.int(), 0) } },
  (req, _res, { job_id, after_id }) => {
    const user = requireUser(req);
    ownedJob(user, job_id);
    const rows = db.query(
      'SELECT id, at, state, percent, detail FROM job_events WHERE job_id=? AND id>? AND COALESCE(internal,0)=0 ORDER BY id LIMIT 200',
      [job_id, after_id],
    );
    const job = db.one('SELECT state, percent FROM jobs WHERE id=?', [job_id])!;
    return {
      state: job.state,
      percent: new PyFloat(pyRound(Number(job.percent || 0), 1)),
      events: rows.map((r) => ({ ...r, percent: real(r.percent) })),
      last_id: rows.length ? rows[rows.length - 1].id : after_id,
    };
  },
);

/** Valid session, their job, finished, and still inside its window. */
function authoriseDownload(user: Row, jobId: string): Row {
  const row = ownedJob(user, jobId);
  const view = jobView(row);
  if (!view.can_download) {
    if (view.deleted_at) throw new HTTPException(410, 'this video has been deleted');
    if (view.expires_at && (view.expires_at as string) <= db.now()) throw new HTTPException(410, 'the download window has passed');
    throw new HTTPException(409, 'this job has no finished video');
  }
  return row;
}

/** Which rendition: 'video', or one of the audio-only formats in media.AUDIO_FORMATS. */
function variantOf(raw: string): string {
  try {
    return media.canonicalFormat(raw);
  } catch (e) {
    if (e instanceof media.MediaError) throw new HTTPException(400, e.message);
    throw e;
  }
}

router.get('/jobs/{job_id}/formats', { name: 'job_formats', path: { job_id: t.str() } }, (req, _res, { job_id }) => {
  const user = requireUser(req);
  const row = ownedJob(user, job_id);
  const view = jobView(row);
  return { job_id, can_download: view.can_download, target_lang: row.target_lang, formats: media.formatCatalogue(), default: 'video' };
});

/** Mint a short-lived token naming ONE object in ONE format; /dl/ only verifies it. */
router.get(
  '/jobs/{job_id}/download-token',
  { name: 'download_token', path: { job_id: t.str() }, query: { format: optional(t.str(), 'video'), inline: optional(t.bool(), false) } },
  (req, _res, { job_id, format, inline }) => {
    const user = requireUser(req);
    // unlimited is a product promise, not an invitation to a script
    ratelimit.check('download', String(user.id));
    const variant = variantOf(format);
    const row = authoriseDownload(user, job_id);
    const key = 'output_r2_key' in row ? row.output_r2_key : null;
    const ttl = inline ? STREAM_TOKEN_TTL_S : DOWNLOAD_TOKEN_TTL_S;
    const tok = tokens.mint(job_id, key || String(row.output_path), user.id, ttl, variant, inline);
    return {
      token: tok,
      url: `/dl/${tok}`,
      format: variant,
      inline,
      expires_in_s: ttl,
      note: 'names one object and one format, expires, cannot be edited',
    };
  },
);

/** The simple entry point: authorise, then hand off to the doorman. Same rate bucket. */
router.get(
  '/jobs/{job_id}/download',
  { name: 'download', path: { job_id: t.str() }, query: { format: optional(t.str(), 'video') } },
  (req, _res, { job_id, format }) => {
    const user = requireUser(req);
    ratelimit.check('download', String(user.id));
    const variant = variantOf(format);
    const row = authoriseDownload(user, job_id);
    const key = 'output_r2_key' in row ? row.output_r2_key : null;
    const tok = tokens.mint(job_id, key || String(row.output_path), user.id, null, variant);
    return new RedirectResponse(`/dl/${tok}`, 307);
  },
);

/** The customer deleting their own video early. Idempotent, irreversible, and NOT refunded. */
router.delete('/jobs/{job_id}/video', { name: 'delete_video', path: { job_id: t.str() } }, async (req, _res, { job_id }) => {
  const user = requireUser(req);
  const row = ownedJob(user, job_id);
  if (row.output_deleted_at) return { ok: true, already: true };
  if (row.output_path) {
    try {
      const p = paths.resolve(row.output_path);
      if (p) {
        // the audio renditions go with it
        media.deleteRenditions(p);
        if (existsSync(p)) await fsp.unlink(p);
      }
    } catch {
      /* best effort */
    }
  }
  const r2Key = 'output_r2_key' in row ? row.output_r2_key : null;
  if (r2Key) {
    try {
      await storage.del(r2Key);
    } catch {
      /* best effort */
    }
  }
  db.execute("UPDATE jobs SET output_deleted_at=?, output_deleted_by='user' WHERE id=?", [db.now(), job_id]);
  db.addEvent(job_id, null, null, 'video deleted by the user');
  return { ok: true };
});
