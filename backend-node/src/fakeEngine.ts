/**
 * A stand-in for the dubbing engine.
 *
 * Its only purpose is to let the whole backend be exercised — auth, quota, the queue, the
 * worker, progress, storage, download, refunds, the admin panel — without starting a GPU
 * instance and without spending anything.
 *
 * It mimics the SHAPES the real engine returns, including the ones that matter: segment
 * ids in the c%03d format, a separate transcribe and translate step, a task id from
 * generate, and a real playable file from download (made with ffmpeg from the uploaded
 * video, so the download path is genuinely tested). Its numbers are floats where the
 * real engine's are, so the payloads built from them hash exactly as they do in Python.
 *
 * It is NOT a simulator of dub quality. Set VS_ENGINE_MODE=real for that.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FFPROBE } from './config';
import type { Engine } from './engine';
import { ffmpegBin, pyFloatParse } from './media';
import * as procs from './procs';
import { PyFloat, pyRound, pyStrip, sleep } from './py';

interface FakeJob {
  video?: string;
  duration?: number;
  stored_segments?: Array<Record<string, any>>;
  segments?: unknown[];
  lang?: string | null;
  rendered?: boolean;
  task_id?: string;
}

const hex = (n: number) => randomUUID().replace(/-/g, '').slice(0, n);

/** Same surface as the real client, no GPU, no cost. */
export class FakeEngine implements Engine {
  private readonly jobs = new Map<string, FakeJob>();
  readonly base = 'fake://in-process';

  // ── 0 ────────────────────────────────────────────────────────────────────
  async sysinfo(): Promise<unknown> {
    return { version: 'FAKE-0.0', device: 'none', note: 'stand-in engine; set VS_ENGINE_MODE=real for the GPU box' };
  }

  async waitReady(): Promise<unknown> {
    return this.sysinfo();
  }

  // ── 1 ────────────────────────────────────────────────────────────────────
  async upload(videoPath: string, vsJobId: string): Promise<unknown> {
    this.jobs.set(vsJobId, { video: videoPath, duration: await this.dur(videoPath) });
    return { job_id: vsJobId, task_id: 'fake_prep_' + hex(6) };
  }

  private async dur(p: string): Promise<number> {
    try {
      const out = await procs.run([FFPROBE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { timeoutMs: 120_000 });
      return pyFloatParse(pyStrip(out.stdout || '0') || 0);
    } catch {
      return 60.0;
    }
  }

  // ── 2 ────────────────────────────────────────────────────────────────────
  async waitPrep(vsJobId: string, _timeoutS?: number, _pollS?: number, onWait: ((m: string) => void) | null = null): Promise<Record<string, any>> {
    if (onWait) onWait('separating speech from background (fake)');
    await sleep(1000);
    return { vocals_path: `/fake/${vsJobId}/vocals.wav`, audio_path: `/fake/${vsJobId}/audio.wav` };
  }

  // ── 3 ────────────────────────────────────────────────────────────────────
  /** Invent evenly spaced lines with c000-style ids. */
  async transcribeStream(
    vsJobId: string,
    _numSpeakers: number | null = null,
    onProgress: ((ev: Record<string, any>) => void) | null = null,
  ): Promise<[Array<Record<string, any>>, string[]]> {
    const dur = this.jobs.get(vsJobId)?.duration || 60.0;
    const n = Math.max(3, Math.min(30, Math.trunc(Math.floor(dur / 6))));
    const step = dur / n;
    const segs: Array<Record<string, any>> = [];
    for (let i = 0; i < n; i++) {
      const start = pyRound(i * step, 3);
      const end = pyRound(Math.min(dur, start + step * 0.82), 3);
      segs.push({
        id: 'c' + String(i).padStart(3, '0'),
        start: new PyFloat(start),
        end: new PyFloat(end),
        text: `[fake source line ${i + 1}]`,
        text_original: `[fake source line ${i + 1}]`,
        speaker_id: `Speaker ${(i % 2) + 1}`,
        profile_id: `auto:speaker_${(i % 2) + 1}`,
      });
      if (onProgress && i % 5 === 0) {
        onProgress({
          stage: 'transcribe',
          percent: new PyFloat(10 + (30 * i) / Math.max(1, n)),
          detail: `fake transcribing line ${i + 1}/${n}`,
          segments: segs.slice(0, i + 1),
        });
      }
      await sleep(20);
    }
    // The authoritative copy is stored under the job, as the real engine does, and the
    // stream is handed a DIFFERENT id style on purpose — the trap that once cost a real
    // render, reproduced so fake mode exercises the same guard.
    const job = this.jobs.get(vsJobId) ?? {};
    job.stored_segments = segs;
    this.jobs.set(vsJobId, job);
    const streamView = segs.map((s, i) => ({ ...s, id: 's' + String(i).padStart(5, '0'), profile_id: null }));
    return [streamView, ['fake engine: transcript is placeholder text']];
  }

  async detectedSourceLang(): Promise<string | null> {
    return 'hi';
  }

  async jobRecord(vsJobId: string): Promise<Record<string, any> | null> {
    const job = this.jobs.get(vsJobId) ?? {};
    return { segments: job.stored_segments || [], source_lang: 'hi', vocals_path: `/fake/${vsJobId}/vocals.wav` };
  }

  async storedSegments(vsJobId: string): Promise<Array<Record<string, any>>> {
    return [...(this.jobs.get(vsJobId)?.stored_segments || [])];
  }

  // ── 4 ────────────────────────────────────────────────────────────────────
  /** Wraps the list under "translated", exactly as the real engine does. */
  async translate(body: Record<string, any>): Promise<[any[], unknown]> {
    const out: Array<Record<string, unknown>> = [];
    for (const s of (body.segments ?? []) as Array<Record<string, any>>) {
      out.push({ id: s.id ?? null, text: `[${pyStrOf(body.target_lang)}] ${pyStrOf(s.text)}`, rate_ratio: new PyFloat(1.0) });
      await sleep(10);
    }
    const raw = {
      translated: out,
      target_lang: body.target_lang ?? null,
      source_lang: body.source_lang || 'hi',
      quality_used: body.quality || 'fast',
    };
    return [out, raw];
  }

  // ── 5 ────────────────────────────────────────────────────────────────────
  async generate(vsJobId: string, body: Record<string, any>): Promise<string> {
    const job = this.jobs.get(vsJobId) ?? {};
    job.segments = body.segments || [];
    job.lang = body.language_code ?? null;
    job.rendered = true;
    const tid = 'fake_task_' + hex(8);
    job.task_id = tid;
    this.jobs.set(vsJobId, job);
    return tid;
  }

  // ── 6 ────────────────────────────────────────────────────────────────────
  async *taskStream(_taskId: string, afterSeq = 0): AsyncGenerator<Record<string, any>> {
    const n = 12;
    for (let i = 0; i <= n; i++) {
      await sleep(250);
      yield {
        seq: afterSeq + i,
        percent: new PyFloat(pyRound((100.0 * i) / n, 1)),
        detail: `fake rendering ${i}/${n}`,
        type: i < n ? 'progress' : 'done',
      };
    }
  }

  // ── 6b ───────────────────────────────────────────────────────────────────
  async tracks(vsJobId: string): Promise<unknown> {
    const job = this.jobs.get(vsJobId) ?? {};
    const lang = job.lang;
    return { tracks: lang && job.rendered ? { [lang]: { fake: true } } : {} };
  }

  async hasTrack(vsJobId: string, targetLang: string): Promise<boolean> {
    const job = this.jobs.get(vsJobId) ?? {};
    return Boolean(job.rendered) && job.lang === targetLang;
  }

  // ── 7 ────────────────────────────────────────────────────────────────────
  /** A real file, so the download path is genuinely exercised: the video with silence. */
  async download(vsJobId: string, query: Record<string, unknown>, dest: string): Promise<number> {
    const job = this.jobs.get(vsJobId) ?? {};
    const src = job.video;
    mkdirSync(path.dirname(dest), { recursive: true });
    const lang = String(query.default_track || 'und');
    if (src && existsSync(src)) {
      const cmd = [
        ffmpegBin(), '-y', '-i', src,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-map', '0:v:0', '-map', '1:a:0', '-shortest',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k',
        '-metadata:s:a:0', `language=${lang}`,
        dest,
      ];
      try {
        const r = await procs.runBuffer(cmd, { timeoutMs: 1_800_000 });
        if (r.code !== 0) throw new Error('ffmpeg failed');
      } catch {
        copyFileSync(src, dest);
      }
    } else {
      writeFileSync(dest, Buffer.from('FAKE OUTPUT - no source video was available\n'));
    }
    return statSync(dest).size;
  }

  // ── 9 ────────────────────────────────────────────────────────────────────
  async deleteHistory(vsJobId: string): Promise<void> {
    this.jobs.delete(vsJobId);
  }
}

/** f"{x}" for the values the fake formats. */
function pyStrOf(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}
