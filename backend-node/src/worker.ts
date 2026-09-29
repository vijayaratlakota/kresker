/**
 * The job worker.
 *
 * Drives the engine through its stages and copies every result OUT of the engine and
 * INTO our database as each stage finishes, so nothing of the customer's depends on the
 * GPU box staying up.
 *
 * It runs inside the web process, one job at a time. Node runs it as an asynchronous
 * loop rather than a thread: while a job waits on the engine, the website keeps serving
 * requests. All state lives in the database, so a restart loses nothing but the job in
 * hand, and `recoverOrphans` picks that one up again.
 *
 * The browser is never a participant: a refresh, a crash or a deployment does not affect
 * a running job.
 */
import { existsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import * as billing from './billing';
import { FREE_RETENTION_HOURS, OUTPUT_DIR, PAID_RETENTION_DAYS, PUBLIC_BASE_URL } from './config';
import * as db from './db';
import { EngineError, getEngine, newJobId } from './engine';
import * as gpu from './gpu';
import * as media from './media';
import * as notify from './notify';
import * as paths from './paths';
import * as preset from './preset';
import { FileNotFoundError } from './procs';
import { PyFloat, errName, errText, fmtStamp, or, pyDumps, pyFixed, pyRepr, pyRound, pySlice, pyStr, sleep, truthy } from './py';
import * as storage from './storage';

let stopping = false;
let loopPromise: Promise<void> | null = null;

// ── state helpers ─────────────────────────────────────────────────────────────

function setState(jobId: string, state: string, percent: number | null = null, detail: string | null = null): void {
  if (percent === null) db.execute('UPDATE jobs SET state=? WHERE id=?', [state, jobId]);
  else db.execute('UPDATE jobs SET state=?, percent=? WHERE id=?', [state, new PyFloat(percent), jobId]);
  db.addEvent(jobId, state, percent, detail);
}

/** Python's isinstance(x, (int, float)) — bool included, as it is an int there. */
function isNum(x: unknown): boolean {
  return typeof x === 'number' || x instanceof PyFloat || typeof x === 'boolean';
}

/**
 * Fail a job, refund what is still outstanding, and tell the customer.
 *
 * The customer is told their dub failed and that they were not charged; the diagnosis
 * (our code, and whatever the engine said) is recorded for the operator only. The charge
 * is CANCELLED with a refund row, never deleted — the ledger is append-only — and only
 * what is still outstanding is credited, so this is idempotent and cannot hand out
 * minutes twice. The refund goes back to the pocket it came from: plan or top-up.
 */
export async function fail(jobId: string, code: string, detail: string): Promise<void> {
  db.execute("UPDATE jobs SET state='failed', error_code=?, error_detail=?, finished_at=? WHERE id=?", [
    code,
    pySlice(detail, 2000),
    db.now(),
    jobId,
  ]);
  db.addEvent(jobId, 'failed', null, 'this dub could not be completed, and the minutes have been put back on your plan');
  db.addEvent(jobId, 'failed', null, `${code}: ${pySlice(detail, 500)}`, null, true);

  const split = db.jobLedgerSplit(jobId);
  const outstanding = split.outstanding;
  if (outstanding > 1e-9) {
    const owner = db.one('SELECT user_id FROM jobs WHERE id=?', [jobId]);
    if (owner) {
      db.execute(
        "INSERT INTO usage_ledger (user_id, job_id, minutes_charged, kind, note, at, topup_minutes) VALUES (?,?,?,'refund',?,?,?)",
        [owner.user_id, jobId, new PyFloat(-outstanding), `job failed (${code}); minutes returned automatically`, db.now(), new PyFloat(-split.outstanding_topup)],
      );
    }
  }

  // A customer who is never told assumes it is still running and waits.
  try {
    const row = db.one('SELECT user_id, notified_done_at FROM jobs WHERE id=?', [jobId]);
    if (row && !row.notified_done_at) {
      const u = db.one('SELECT email FROM users WHERE id=?', [row.user_id]);
      if (u) {
        await notify.jobFailed(u.email, row.user_id, jobId, code);
        db.execute('UPDATE jobs SET notified_done_at=? WHERE id=?', [db.now(), jobId]);
      }
    }
  } catch (e) {
    db.addEvent(jobId, null, null, `could not send the 'failed' email: ${errName(e)}`, null, true);
  }
}

function artifact(jobId: string, kind: string, payload: unknown): void {
  let blob: string;
  try {
    blob = typeof payload === 'string' ? payload : pySlice(pyDumps(payload, { ensureAscii: false }), 400000);
  } catch {
    blob = '<unserialisable>';
  }
  db.execute('INSERT INTO job_artifacts (job_id, kind, payload, at) VALUES (?,?,?,?)', [jobId, kind, blob, db.now()]);
}

/** end - start, rounded to the millisecond; a float, or null. */
function slot(seg: Record<string, any>): PyFloat | null {
  try {
    if (!('end' in seg) || !('start' in seg)) return null;
    const end = floatOf(seg.end);
    const start = floatOf(seg.start);
    return new PyFloat(pyRound(end - start, 3));
  } catch {
    return null;
  }
}

/** float(x), throwing where Python would. */
function floatOf(x: unknown): number {
  if (x instanceof PyFloat) return x.v;
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string') return media.pyFloatParse(x);
  throw new TypeError('float() argument must be a string or a real number');
}

function plusHours(hours: number): string {
  return fmtStamp(new Date(Date.now() + hours * 3600_000));
}

function storeSegments(jobId: string, segs: Array<Record<string, any>>): void {
  const rows = segs.map((s, i) => [
    jobId,
    pyStr(or(s.id, `seg_${i}`)),
    i,
    s.start ?? null,
    s.end ?? null,
    or(s.speaker_id, s.speaker) ?? null,
    s.profile_id ?? null,
    or(s.text_original, s.text, '') ?? '',
    slot(s),
  ]);
  db.executemany(
    'INSERT OR REPLACE INTO job_segments (job_id, seg_id, ordinal, start_s, end_s, speaker_label, profile_id,  source_text, slot_seconds) VALUES (?,?,?,?,?,?,?,?,?)',
    rows,
  );
}

function storeTranslation(jobId: string, byId: Map<string, Record<string, any>>): void {
  for (const [sid, t] of byId) {
    // (fit_status or plan.verdict) when there is a plan, else fit_status
    const plan = t.plan;
    const planIsDict = !!plan && typeof plan === 'object' && !Array.isArray(plan);
    const fit = planIsDict ? or(t.fit_status, plan.verdict) : t.fit_status;
    db.execute('UPDATE job_segments SET translated_text=?, fit_status=? WHERE job_id=? AND seg_id=?', [t.text ?? null, fit ?? null, jobId, sid]);
  }
}

// ── the stages ────────────────────────────────────────────────────────────────

export async function runJob(jobId: string): Promise<void> {
  const job = db.one('SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) return;
  const upload = db.one('SELECT * FROM uploads WHERE id=?', [job.upload_id]);
  if (!upload) {
    await fail(jobId, 'NO_UPLOAD', 'the upload row is missing');
    return;
  }
  // The retention sweep never deletes a source under a queued job, so this is a belt:
  // a job must not reach the engine with nothing to send.
  if (upload.status === 'deleted') {
    await fail(jobId, 'SOURCE_DELETED', 'the source video was deleted by the retention sweep before this dub started');
    return;
  }

  const engine = getEngine();
  const target: string = job.target_lang;
  const vsJob: string = job.vs_job_id || newJobId();
  db.execute('UPDATE jobs SET vs_job_id=?, started_at=? WHERE id=?', [vsJob, db.now(), jobId]);

  try {
    // The server's copy of the golden preset must still be byte-identical to preset.py.
    // Checked before anything is sent: a drifted copy must never reach the engine.
    if (!preset.presetIntact()) {
      throw new EngineError(
        `the preset fingerprint is ${preset.presetOnlyFingerprint()}, not the golden ${preset.PRESET_SHA256_EXPECTED}. ` +
          'Refusing to render with settings that differ from the approved ones.',
      );
    }

    // 0 ── the box must be up and the APP answering before anything is sent. What the
    // customer sees is one line; the lifecycle's own chatter is internal.
    setState(jobId, 'preparing', 2, 'getting things ready');
    await gpu.ensureRunning(`job ${jobId}`, true, (m) => db.addEvent(jobId, 'preparing', 2, m, null, true));
    const info = await engine.waitReady(900.0, 5.0, (m) => db.addEvent(jobId, 'preparing', 2, m, null, true));
    artifact(jobId, 'sysinfo', info);

    // 1 ── upload
    setState(jobId, 'preparing', 5, 'uploading your video for processing');
    const source = paths.resolve(upload.stored_path);
    if (!source || !existsSync(source)) {
      throw new FileNotFoundError(
        `the uploaded file is missing: ${pyRepr(upload.stored_path)} resolved to ${source === null ? 'None' : source}. ` +
          'If this database was restored from another machine, the videos have to be copied across too.',
      );
    }
    const up = await engine.upload(source, vsJob);
    artifact(jobId, 'upload_response', up);

    // 2 ── prep: audio extract + speech/background separation
    setState(jobId, 'preparing', 10, 'separating speech from background');
    const prep = await engine.waitPrep(vsJob, 1800.0, 4.0, (m) => db.addEvent(jobId, 'preparing', 10, m, null, true));
    artifact(jobId, 'prep', prep);

    // 3 ── transcribe + diarize + clone, over SSE
    setState(jobId, 'transcribing', 15, 'transcribing, identifying speakers and sampling voices');
    const tp = (ev: Record<string, any>): void => {
      const pct = ev.percent;
      const det = or(ev.detail, ev.stage);
      if (truthy(det) || (pct !== null && pct !== undefined)) {
        // The percentage is the customer's; the engine's stage wording is not.
        db.addEvent(jobId, 'transcribing', 15 + (isNum(pct) ? +pct * 0.25 : 0), truthy(det) ? pySlice(pyStr(det), 400) : null, null, true);
      }
    };
    const [streamSegs, warns] = await engine.transcribeStream(vsJob, null, tp);
    artifact(jobId, 'transcribe_stream_segments', streamSegs);
    for (const w of warns.slice(0, 20)) db.addEvent(jobId, 'transcribing', null, `engine: ${pySlice(w, 400)}`, null, true);

    // The AUTHORITATIVE list comes from the engine's own job record, not the stream:
    // only its ids carry the per-line voice bindings.
    let segs = await engine.storedSegments(vsJob);
    artifact(jobId, 'engine_stored_segments', segs);
    if (!segs.length) {
      db.addEvent(
        jobId,
        'transcribing',
        null,
        "WARNING: the engine's job record had no segments; falling back to the stream's list, so per-line voice references may not bind",
        null,
        true,
      );
      segs = streamSegs;
    } else {
      db.addEvent(
        jobId,
        'transcribing',
        null,
        `using the engine's own ${segs.length} stored segments (stream offered ${streamSegs.length}); ids like ${pyRepr(pyStr(segs[0].id ?? null))}`,
        null,
        true,
      );
    }

    const bound = segs.filter((s) => truthy(s.profile_id)).length;
    const speakers = [...new Set(segs.map((s) => pyStr(or(s.speaker_id, s.speaker, '?'))))].sort(codePointCompare);
    db.addEvent(jobId, 'transcribing', null, `voice bindings: ${bound} of ${segs.length} lines have a clone reference; speakers detected: ${speakers.join(', ')}`, null, true);
    if (bound === 0) {
      // Every line would be spoken by the engine's stock voice. Better to fail.
      throw new EngineError(
        `none of the ${segs.length} lines carry a voice-clone binding ` +
          "(profile_id). Every line would be rendered in the engine's STOCK " +
          "voice rather than the speaker's own. Refusing to render. Check the " +
          'engine log for the speaker_clone stage - usually it means there ' +
          'was too little clean audio per speaker to clone from.',
      );
    }

    // the transcript is persisted at once: this is the system of record
    storeSegments(jobId, segs);
    setState(jobId, 'transcribing', 40, `transcribed ${segs.length} lines, ${bound} with a cloned voice`);

    // 4 ── translate
    setState(jobId, 'translating', 45, 'translating');
    const tSegments = segs.map((s) => ({
      id: pyStr(s.id ?? null),
      text: or(s.text_original, s.text, '') ?? '',
      slot_seconds: slot(s),
      start: s.start ?? null,
      end: s.end ?? null,
    }));
    // Always name the source language: left unset, the engine guesses, and it guessed
    // "en" for Hindi — which changes the translated wording.
    const srcLang: string | null = job.source_lang || (await engine.detectedSourceLang(vsJob));
    if (srcLang && srcLang !== job.source_lang) {
      db.execute('UPDATE jobs SET source_lang=? WHERE id=?', [srcLang, jobId]);
      db.addEvent(jobId, 'translating', null, `detected the original language as '${srcLang}'`);
    } else if (!srcLang) {
      db.addEvent(jobId, 'translating', null, 'WARNING: source language unknown, the engine will guess and that can change the translated wording', null, true);
    }

    const tBody = preset.translatePayload(tSegments, target, srcLang, vsJob);
    artifact(jobId, 'translate_request', tBody);
    const [translated, raw] = await engine.translate(tBody);
    // Store the RAW reply: storing the normalised one once hid an empty response.
    artifact(jobId, 'translate_response_raw', raw);
    const byId = new Map<string, Record<string, any>>();
    for (const t of translated) {
      if (t && typeof t === 'object' && !Array.isArray(t) && !(t instanceof PyFloat) && truthy(t.text)) byId.set(pyStr(t.id ?? null), t);
    }
    storeTranslation(jobId, byId);

    // A translation that comes back short must FAIL the job, never fall back to the
    // source text — that renders a perfect-looking dub in the wrong language.
    const missing = segs.map((s) => pyStr(s.id ?? null)).filter((id) => !byId.has(id));
    if (missing.length) {
      throw new EngineError(
        `translation covered only ${byId.size} of ${segs.length} lines; ` +
          `${missing.length} missing (first few: ${pyRepr(missing.slice(0, 6))}). Refusing to ` +
          'render, because filling the gaps with the source text would ' +
          'produce a dub in the wrong language. Raw reply stored as the ' +
          'translate_response_raw artifact.',
      );
    }
    setState(jobId, 'translating', 60, `translated ${byId.size} of ${segs.length} lines`);

    // 5 ── render. Every row goes, in order, including emptied ones.
    setState(jobId, 'rendering', 62, 'cloning voices and rendering');
    const gSegments: Array<Record<string, unknown>> = [];
    const gIds: string[] = [];
    for (const s of segs) {
      const sid = pyStr(s.id ?? null);
      const tr = byId.get(sid) || {};
      let text = tr.text;
      if (text === null || text === undefined) text = or(s.text, '') ?? '';
      const row: Record<string, unknown> = { start: s.start ?? null, end: s.end ?? null, text };
      // Only send profile_id when there IS one: "" reads as an explicit "no voice".
      if (truthy(s.profile_id)) row.profile_id = s.profile_id;
      gSegments.push(row);
      gIds.push(sid);
    }

    // The row-identity rule: ids the engine does not recognise silently lose their
    // per-line voice reference. Checked before spending a render on it.
    const engineIds = new Set((await engine.storedSegments(vsJob)).map((s) => pyStr(s.id ?? null)));
    if (engineIds.size) {
      const unknown = gIds.filter((i) => !engineIds.has(i));
      if (unknown.length) {
        throw new EngineError(
          `${unknown.length} of ${gIds.length} segment ids are not in the ` +
            `engine's stored segments (e.g. ${pyRepr(unknown.slice(0, 5))}). Rendering would ` +
            'lose every per-line voice reference and voice each line from a ' +
            'single pooled clone, which sounds like a different person. ' +
            'Refusing to render.',
        );
      }
      db.addEvent(jobId, 'rendering', null, `all ${gIds.length} segment ids match the engine's own segments, so per-line voice references will bind`, null, true);
    }

    const gBody = preset.generatePayload(gSegments, gIds, target);
    artifact(jobId, 'generate_request', gBody);

    const fp = preset.fingerprint(tBody, gBody, preset.downloadQuery(target));
    db.execute('UPDATE jobs SET preset_version=?, preset_sha256=? WHERE id=?', [preset.PRESET_VERSION, fp, jobId]);

    const taskId = await engine.generate(vsJob, gBody);
    db.execute('UPDATE jobs SET vs_task_id=? WHERE id=?', [taskId, jobId]);

    let lastSeq = 0;
    for await (const ev of engine.taskStream(taskId)) {
      const e = (ev && typeof ev === 'object' ? ev : {}) as Record<string, any>;
      const seq = e.seq;
      if ((typeof seq === 'number' && Number.isInteger(seq)) || typeof seq === 'boolean') lastSeq = Number(seq);
      const pct = e.percent;
      const mapped = 62 + (isNum(pct) ? +pct * 0.3 : 0);
      const det = or(e.detail, e.type);
      db.addEvent(jobId, 'rendering', mapped, truthy(det) ? pySlice(pyStr(det), 400) : null, lastSeq, true);
      if (pct !== null && pct !== undefined) db.execute('UPDATE jobs SET percent=? WHERE id=?', [new PyFloat(mapped), jobId]);
      if (e.type === 'done') break;
    }

    // 6b ── the real completion signal. Never trust the stream alone.
    if (!(await engine.hasTrack(vsJob, target))) {
      throw new EngineError(
        'the engine reports no rendered track for this language. Refusing to ' +
          'download, because /dub/download would return the ORIGINAL audio and ' +
          'that has shipped as a finished dub before.',
      );
    }

    // 7 ── export
    setState(jobId, 'exporting', 94, 'putting the final video together');
    const dest = path.join(OUTPUT_DIR, `${jobId}.mp4`);
    let size = await engine.download(vsJob, preset.downloadQuery(target), dest);
    if (size < 10000) throw new EngineError(`downloaded file is implausibly small (${size} bytes)`);

    // 7b ── prove it is a dub, then make the dubbed track the only, default, labelled one.
    setState(jobId, 'exporting', 97, 'checking the result');
    const mediaReport = await media.verifyAndTag(dest, source, target);
    artifact(jobId, 'delivery_check', mediaReport);
    size = statSync(dest).size;
    db.addEvent(
      jobId,
      'exporting',
      98,
      `audio track: 1, default, language=${pyStr(mediaReport.language_tag ?? null)}; ` +
        `differs from source=${pyStr(mediaReport.audio_differs_from_source ?? null)}; ` +
        `timeline preserved=${pyStr(mediaReport.timeline_preserved ?? null)}`,
      null,
      true,
    );

    // 7c ── into storage when configured; local disk stays as the fallback.
    let r2Key: string | null = null;
    if (storage.enabled()) {
      setState(jobId, 'exporting', 98, 'saving your video');
      const rep = await storage.put(dest, storage.keyFor(jobId, target));
      artifact(jobId, 'r2_upload', rep);
      if (rep.ok) {
        r2Key = rep.key as string;
        db.addEvent(jobId, 'exporting', 99, `in R2 as ${r2Key} (${pyFixed(Number(rep.bytes ?? 0) / 1048576, 1)} MB)`, null, true);
      } else {
        db.addEvent(jobId, 'exporting', 99, `R2 upload failed (${pySlice(pyStr(rep.why ?? null), 160)}); serving from local disk instead`, null, true);
      }
    }

    const ent = db.entitlement(job.user_id);
    const hours = ent.is_free ? FREE_RETENTION_HOURS : PAID_RETENTION_DAYS * 24;
    const expires = plusHours(hours);
    db.execute(
      "UPDATE jobs SET state='done', percent=100, output_path=?, output_bytes=?, output_r2_key=?, finished_at=?, output_expires_at=? WHERE id=?",
      [paths.store(dest), size, r2Key, db.now(), expires, jobId],
    );
    db.addEvent(jobId, 'done', 100, `finished, ${pyFixed(size / 1048576, 1)} MB, deleted after ${pyFixed(hours / 24, 0)} day(s)`);

    // 8 ── tell them. A mail outage must not turn a finished dub into a failed one, but
    // the failure is recorded rather than swallowed.
    try {
      const u = db.one('SELECT email FROM users WHERE id=?', [job.user_id]);
      if (u && !job.notified_done_at) {
        const rep = await notify.jobDone(u.email, job.user_id, jobId, target, expires, PUBLIC_BASE_URL);
        artifact(jobId, 'notify_done', rep);
        db.execute('UPDATE jobs SET notified_done_at=? WHERE id=?', [db.now(), jobId]);
      }
    } catch (e) {
      artifact(jobId, 'notify_done', { ok: false, why: errText(e) });
      db.addEvent(jobId, null, null, `could not send the 'ready' email: ${errName(e)}`, null, true);
    }

    // 9 ── take our media off the shared box
    await engine.deleteHistory(vsJob);
  } catch (e) {
    // a worker must never die silently
    const stack = e instanceof Error && e.stack ? e.stack : String(e);
    await fail(jobId, errName(e), `${e instanceof Error ? e.message : String(e)}\n${stack.slice(-1500)}`);
  } finally {
    // Start the idle clock however the job ended.
    try {
      gpu.noteWorkFinished();
    } catch {
      /* ignore */
    }
  }
}

function codePointCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

// ── the queue ─────────────────────────────────────────────────────────────────

/**
 * Claim one queued job: BEGIN IMMEDIATE plus a guarded UPDATE. rowid breaks the tie,
 * because one multi-language request queues every job inside the same second and the
 * customer who put Telugu first wants Telugu back first.
 */
export function claimNext(): string | null {
  return db.transaction(() => {
    const row = db.one("SELECT id FROM jobs WHERE state='queued' ORDER BY queued_at, rowid LIMIT 1");
    if (!row) return null;
    const cur = db.execute("UPDATE jobs SET state='claimed' WHERE id=? AND state='queued'", [row.id]);
    return cur.rowcount ? (row.id as string) : null;
  });
}

/** Delete outputs past their retention window, and stamp the row. */
export async function sweepExpired(): Promise<number> {
  const rows = db.query(
    'SELECT id, output_path, output_r2_key FROM jobs' +
      ' WHERE (output_path IS NOT NULL OR output_r2_key IS NOT NULL)' +
      '   AND output_deleted_at IS NULL' +
      '   AND output_expires_at IS NOT NULL AND output_expires_at <= ?',
    [db.now()],
  );
  let n = 0;
  for (const r of rows) {
    try {
      if (r.output_path) {
        const p = paths.resolve(r.output_path);
        if (p && existsSync(p)) {
          // whatever was cut from it goes at the same moment
          media.deleteRenditions(p);
          unlinkSync(p);
        }
      }
    } catch {
      /* best effort */
    }
    try {
      if (r.output_r2_key) await storage.del(r.output_r2_key);
    } catch {
      /* best effort */
    }
    db.execute("UPDATE jobs SET output_deleted_at=?, output_deleted_by='expiry' WHERE id=?", [db.now(), r.id]);
    db.addEvent(r.id, null, null, 'output deleted: retention window passed');
    n++;
  }
  return n;
}

/** A stored timestamp plus some hours, in the same format; null when it cannot be read. */
function stampPlusHours(stamp: unknown, hours: number): string | null {
  if (typeof stamp !== 'string' || !stamp) return null;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return null;
  return fmtStamp(new Date(t + hours * 3600_000));
}

/** Every state the worker may still act on. A source video is never deleted under one. */
const ACTIVE_STATES = "('queued','claimed','preparing','transcribing','translating','rendering','exporting')";

/**
 * Delete the SOURCE videos nobody needs any more, and stamp the row.
 *
 * Until this existed a customer's original upload was kept forever - closing the account
 * was the only thing that removed it, and the privacy notice had to say so as a known gap.
 *
 * THE RULE, which the privacy notice states from the same constants: a source is kept as
 * long as the dubs made from it - FREE_RETENTION_HOURS on the free plan, PAID_RETENTION_DAYS
 * on a paid one, counted from the LAST dub made from it finishing (or from the upload, if
 * it was never dubbed) - and never while a dub that uses it is queued or running. The
 * longest of those windows wins, so a source can never go before a dub made from it.
 *
 * The row stays, marked `status='deleted'`, because jobs point at it; only the file goes.
 * (A value in the existing column, not a new column: the schema must stay identical to
 * the Python rollback's.) It is marked first, inside the write lock and after
 * re-checking that no dub picked it up since the query, and the file is removed after
 * that commit - so a crash in between leaves at worst a file with a row that says it is
 * gone, never a live row pointing at a missing file.
 */
export function sweepSourceUploads(): number {
  // VS_SOURCE_SWEEP_SINCE: uploads created before this moment are left alone. It exists so
  // the sweep can be switched on WITHOUT also deleting, in the same instant, every old
  // upload it has never seen - an operator clears that backlog deliberately, by removing
  // the setting. Also useful after restoring an old database. Unset: one rule for all.
  // Read on every call, so a test (or an operator's one-off run) can change it.
  const rawSince = (process.env.VS_SOURCE_SWEEP_SINCE || '').trim();
  const since = rawSince ? stampPlusHours(rawSince, 0) : null;
  if (rawSince && !since) {
    // Set but unreadable: the safe reading is "protect everything", never "protect nothing".
    console.error(`  sweep: VS_SOURCE_SWEEP_SINCE=${rawSince} is not a timestamp, so no source video is being deleted`);
    return 0;
  }
  const now = db.now();
  const rows = db.query(
    'SELECT u.id, u.user_id, u.stored_path, u.created_at,' +
      ` (SELECT COUNT(*) FROM jobs j WHERE j.upload_id=u.id AND j.state IN ${ACTIVE_STATES}) AS active,` +
      ' (SELECT MAX(j.output_expires_at) FROM jobs j WHERE j.upload_id=u.id) AS last_expiry,' +
      ' (SELECT MAX(COALESCE(j.finished_at, j.created_at)) FROM jobs j WHERE j.upload_id=u.id) AS last_finished' +
      " FROM uploads u WHERE u.status <> 'deleted'",
  );
  // The plan decides the window; looked up once per account per sweep.
  const windowHours = new Map<number, number>();
  let n = 0;
  for (const r of rows) {
    if (Number(r.active) > 0) continue;
    if (since && (stampPlusHours(r.created_at, 0) ?? '') < since) continue;
    let hours = windowHours.get(r.user_id);
    if (hours === undefined) {
      let free = true;
      try {
        free = Boolean(db.entitlement(r.user_id).is_free);
      } catch {
        free = true; // the shorter window, never a longer one than the notice promises
      }
      hours = free ? FREE_RETENTION_HOURS : PAID_RETENTION_DAYS * 24;
      windowHours.set(r.user_id, hours);
    }
    // Every candidate goes through the same parse-and-format, so the comparison is between
    // like strings even if an old row was written in another timestamp format.
    let keepUntil = '';
    for (const c of [stampPlusHours(r.created_at, hours), stampPlusHours(r.last_finished, hours), stampPlusHours(r.last_expiry, 0)]) {
      if (typeof c === 'string' && c > keepUntil) keepUntil = c;
    }
    if (!keepUntil || keepUntil > now) continue;

    const marked = db.transaction(() => {
      if (db.scalar(`SELECT COUNT(*) FROM jobs WHERE upload_id=? AND state IN ${ACTIVE_STATES}`, [r.id], 0) > 0) return false;
      return db.execute("UPDATE uploads SET status='deleted' WHERE id=? AND status <> 'deleted'", [r.id]).rowcount > 0;
    });
    if (!marked) continue;
    try {
      const p = paths.resolve(r.stored_path);
      if (p && existsSync(p)) unlinkSync(p);
    } catch (e) {
      console.error(`  sweep: could not delete the source video of upload ${r.id}: ${errText(e)}`);
    }
    n++;
  }
  if (n) console.log(`  deleted ${n} source video(s) whose retention window had passed`);
  return n;
}

/**
 * Delete session rows dead for a month. Kept that long because they are the only record
 * of where an account was signed in from, and that question gets asked days later.
 */
export function purgeDeadSessions(keepDays = 30.0): number {
  const cutoff = fmtStamp(new Date(Date.now() - keepDays * 86400_000));
  const cur = db.execute(
    'DELETE FROM sessions WHERE (expires_at <= ? AND (revoked_at IS NULL OR revoked_at <= ?)) OR (revoked_at IS NOT NULL AND revoked_at <= ?)',
    [cutoff, cutoff, cutoff],
  );
  return cur.rowcount || 0;
}

async function loop(): Promise<void> {
  let lastSweep = 0;
  while (!stopping) {
    try {
      const jobId = claimNext();
      if (jobId) {
        await runJob(jobId);
        continue;
      }
      if (Date.now() / 1000 - lastSweep > 300) {
        await sweepExpired();
        // The originals, on the same clock as the dubs made from them.
        try {
          sweepSourceUploads();
        } catch (e) {
          console.error(e);
        }
        // Annual plans do not renew themselves: a sweep that never runs is silent churn.
        try {
          await billing.sweep();
        } catch (e) {
          console.error(e);
        }
        // abandoned direct uploads
        try {
          const n = await storage.sweepStaging(6.0);
          if (n) console.log(`  swept ${n} abandoned upload(s) from storage`);
        } catch (e) {
          console.error(e);
        }
        try {
          const n = purgeDeadSessions();
          if (n) console.log(`  purged ${n} long-dead session row(s)`);
        } catch (e) {
          console.error(e);
        }
        lastSweep = Date.now() / 1000;
      }
    } catch (e) {
      console.error(e);
    }
    await sleep(1500);
  }
}

// Two: a job abandoned twice is more likely crashing the worker than unlucky.
export const MAX_ORPHAN_RECOVERIES = parseInt(process.env.VS_MAX_ORPHAN_RECOVERIES || '2', 10);

/**
 * Jobs left mid-flight by a worker that died: requeue them, or fail them. Runs at
 * startup and treats every active job as abandoned, which is right for one in-process
 * worker — and would be wrong for several sharing a database.
 */
export async function recoverOrphans(): Promise<{ requeued: string[]; failed: string[] }> {
  const rows = db.query(
    "SELECT id, state, attempts FROM jobs WHERE state IN ('claimed','preparing','transcribing','translating','rendering','exporting')",
  );
  const requeued: string[] = [];
  const failed: string[] = [];
  for (const r of rows) {
    const attempts = Math.trunc(Number(r.attempts || 0));
    if (attempts >= MAX_ORPHAN_RECOVERIES) {
      await fail(
        r.id,
        'worker_lost',
        `picked up again ${attempts} time(s) after a worker stopped mid-job and did not get further. Not retrying; your minutes are refunded.`,
      );
      failed.push(r.id);
      continue;
    }
    db.execute('UPDATE jobs SET state=\'queued\', attempts=attempts+1, queued_at=?, started_at=NULL, vs_job_id=NULL, vs_task_id=NULL WHERE id=?', [
      db.now(),
      r.id,
    ]);
    db.addEvent(r.id, 'queued', 0, 'restarted from the beginning');
    db.addEvent(r.id, 'queued', 0, `the worker holding this job stopped while it was ${r.state}; requeued from the start`, null, true);
    requeued.push(r.id);
  }
  if (requeued.length || failed.length) {
    console.log(`  orphans     : requeued ${requeued.length}, failed ${failed.length} (left behind by a worker that stopped mid-job)`);
  }
  return { requeued, failed };
}

/** Start the loop, after releasing whatever the previous process left behind. */
export async function start(): Promise<void> {
  if (loopPromise) return;
  try {
    await recoverOrphans();
  } catch (e) {
    console.error(e);
  }
  stopping = false;
  loopPromise = loop().finally(() => {
    loopPromise = null;
  });
}

export function stop(): void {
  stopping = true;
}
