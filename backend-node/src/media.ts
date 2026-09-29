/**
 * Post-download verification and audio tagging.
 *
 * Two jobs, both because a delivered file once measured byte-identical to its source
 * while every artifact reported a clean run:
 *
 *   1. PROVE the delivered file carries the dub and not the original audio, by hashing
 *      the DECODED audio and comparing it with the upload's.
 *   2. Make the dubbed track the one and only audio track, marked default and labelled
 *      with the target language, so players name it correctly.
 *
 * ffmpeg runs with `-c copy`, so tagging is a remux: no re-encode, no quality change.
 */
import { existsSync, promises as fsp, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { FFPROBE } from './config';
import * as procs from './procs';
import { pyFixed, pyRepr, pyRound, pySlice, pyStrip } from './py';

export class MediaError extends Error {
  override name = 'MediaError';
}

/** ffmpeg sits beside ffprobe, so it is derived rather than configured separately. */
export function ffmpegBin(): string {
  const name = path.basename(FFPROBE);
  if (name.toLowerCase().startsWith('ffprobe')) {
    const cand = path.join(path.dirname(FFPROBE), name.toLowerCase().replace('ffprobe', 'ffmpeg'));
    if (existsSync(cand)) return cand;
  }
  return 'ffmpeg';
}

// ISO 639-1 (what the API speaks) -> ISO 639-2/B (what MP4 and Matroska want).
export const ISO1_TO_ISO2: Record<string, string> = {
  te: 'tel', hi: 'hin', ta: 'tam', kn: 'kan', ml: 'mal',
  bn: 'ben', gu: 'guj', mr: 'mar', pa: 'pan', ur: 'urd',
  or: 'ori', as: 'asm', ne: 'nep', si: 'sin',
  en: 'eng', es: 'spa', fr: 'fre', de: 'ger', it: 'ita',
  pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'chi',
  'zh-cn': 'chi', ar: 'ara', tr: 'tur', nl: 'dut', pl: 'pol',
  id: 'ind', vi: 'vie', th: 'tha', ms: 'may', fa: 'per',
  he: 'heb', sv: 'swe', da: 'dan', fi: 'fin', no: 'nor',
  cs: 'cze', el: 'gre', hu: 'hun', ro: 'ron', uk: 'ukr',
};

function own<T>(o: Record<string, T>, k: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

export function iso2(lang: string | null | undefined): string {
  const l = pyStrip(lang || '').toLowerCase();
  return own(ISO1_TO_ISO2, l) ?? (l ? pySlice(l, 3) : 'und');
}

// What the downloaded file is called: what it is, the language in a word, who made it,
// and a short id so several dubs into one language can be told apart.
export const BRAND = process.env.VS_BRAND ?? 'Kresker';

// ISO 639-1 -> the English name, for a person to read.
export const LANG_NAMES: Record<string, string> = {
  te: 'telugu', hi: 'hindi', ta: 'tamil', kn: 'kannada',
  ml: 'malayalam', bn: 'bengali', gu: 'gujarati', mr: 'marathi',
  pa: 'punjabi', ur: 'urdu', or: 'odia', as: 'assamese',
  ne: 'nepali', si: 'sinhala',
  en: 'english', es: 'spanish', fr: 'french', de: 'german',
  it: 'italian', pt: 'portuguese', ru: 'russian', ja: 'japanese',
  ko: 'korean', zh: 'chinese', 'zh-cn': 'chinese', ar: 'arabic',
  tr: 'turkish', nl: 'dutch', pl: 'polish', id: 'indonesian',
  vi: 'vietnamese', th: 'thai', ms: 'malay', fa: 'persian',
  he: 'hebrew', sv: 'swedish', da: 'danish', fi: 'finnish',
  no: 'norwegian', cs: 'czech', el: 'greek', hu: 'hungarian',
  ro: 'romanian', uk: 'ukrainian',
};

/** A readable language name, falling back to the code when it is not known. */
export function languageName(lang: string | null | undefined): string {
  const code = pyStrip(lang || '').toLowerCase();
  return own(LANG_NAMES, code) ?? (code || 'unknown');
}

/** What the browser saves a rendition as: one rule for video and audio alike. */
export function downloadFilename(targetLang: string, jobId: string, fmt: string): string {
  const ext = fmt === 'video' ? '.mp4' : AUDIO_FORMATS[fmt].ext;
  const parts = ['dubbed', languageName(targetLang)];
  if (pyStrip(BRAND)) parts.push(pyStrip(BRAND));
  parts.push(pySlice(jobId || '', 8));
  // An env-set brand reaches a Content-Disposition header, so it is sanitised.
  const name = parts.filter(Boolean).join('_').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${name}${ext}`;
}

export type ProbeInfo = { streams?: Array<Record<string, any>>; format?: Record<string, any> };

export async function probe(file: string): Promise<ProbeInfo> {
  const r = await procs.run([FFPROBE, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    timeoutMs: 300_000,
  });
  if (r.code !== 0) throw new MediaError(`ffprobe failed on ${path.basename(file)}: ${pySlice(r.stderr || '', 300)}`);
  try {
    return JSON.parse(r.stdout || '{}');
  } catch (e) {
    throw new MediaError(`ffprobe gave unreadable output for ${path.basename(file)}: ${(e as Error).message}`);
  }
}

export function audioStreams(info: ProbeInfo): Array<Record<string, any>> {
  return (info.streams || []).filter((s) => s.codec_type === 'audio');
}

/** float(x) as Python parses it; throws on anything else. */
export function pyFloatParse(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  const s = pyStrip(String(x));
  if (/^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/.test(s)) return Number(s.replace(/_/g, ''));
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  throw new Error(`could not convert string to float: ${pyRepr(String(x))}`);
}

export function durationS(info: ProbeInfo): number {
  try {
    return pyFloatParse((info.format || {}).duration || 0.0);
  } catch {
    return 0.0;
  }
}

/** MD5 of the DECODED first audio stream: a re-encode of the same audio still matches. */
export async function audioMd5(file: string): Promise<string | null> {
  const cmd = [ffmpegBin(), '-hide_banner', '-nostats', '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'hash', '-hash', 'md5', '-'];
  const r = await procs.run(cmd, { timeoutMs: 1_800_000 });
  if (r.code !== 0) return null;
  const m = /MD5=([0-9a-fA-F]+)/.exec(r.stdout || '');
  return m ? m[1].toLowerCase() : null;
}

/** pathlib's with_suffix: replace the last extension (or add one). */
export function withSuffix(p: string, suffix: string): string {
  const dir = path.dirname(p);
  const base = path.basename(p);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return path.join(dir, stem + suffix);
}

async function unlinkQuiet(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    /* missing_ok */
  }
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

/**
 * Keep exactly one audio track — the dub — as default, tagged with its language. The
 * maps keep the video and the FIRST audio stream only, so even if the engine ever
 * returned the original alongside the dub, the customer gets the dub alone.
 */
export async function makeDubTheOnlyDefaultTrack(file: string, targetLang: string): Promise<{ language_set: string; bytes: number }> {
  const lang2 = iso2(targetLang);
  const tmp = withSuffix(file, '.tagged.mp4');
  const cmd = [
    ffmpegBin(), '-hide_banner', '-nostats', '-v', 'error', '-y',
    '-i', file,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c', 'copy',
    '-metadata:s:a:0', `language=${lang2}`,
    // MP4 does not reliably carry a per-stream title; Matroska does, and it costs nothing
    '-metadata:s:a:0', `title=Dubbed (${targetLang})`,
    '-metadata:s:v:0', `language=${lang2}`,
    '-disposition:a:0', 'default',
    '-movflags', '+faststart', // starts playing before it has downloaded
    tmp,
  ];
  const r = await procs.run(cmd, { timeoutMs: 1_800_000 });
  if (r.code !== 0 || !existsSync(tmp) || sizeOf(tmp) < 1000) {
    await unlinkQuiet(tmp);
    throw new MediaError(`tagging failed: ${pySlice(r.stderr || '', 400)}`);
  }
  await fsp.rename(tmp, file);
  return { language_set: lang2, bytes: sizeOf(file) };
}

/** Refuse to deliver anything that is not a dub, then label it properly. */
export async function verifyAndTag(output: string, source: string | null, targetLang: string): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { target_lang: targetLang };

  const info = await probe(output);
  const streams = audioStreams(info);
  report.audio_streams_before = streams.length;
  report.duration_s = pyRound(durationS(info), 3);

  if (!streams.length) throw new MediaError('the delivered file has NO audio track, so it cannot be a dub');

  // The decisive check: the same decoded audio as the upload means the export returned
  // the original.
  if (source && existsSync(source)) {
    const outMd5 = await audioMd5(output);
    const srcMd5 = await audioMd5(source);
    report.audio_md5_output = outMd5;
    report.audio_md5_source = srcMd5;
    if (outMd5 && srcMd5 && outMd5 === srcMd5) {
      throw new MediaError(
        "the delivered audio is IDENTICAL to the uploaded video's audio. " +
          'The export returned the original track rather than the dub, so ' +
          'this job is being failed instead of delivered. This is plan 2.4 ' +
          'trap 1.',
      );
    }
    report.audio_differs_from_source = Boolean(outMd5 && srcMd5 && outMd5 !== srcMd5);
    const srcDur = durationS(await probe(source));
    report.source_duration_s = pyRound(srcDur, 3);
    report.timeline_preserved = Math.abs(srcDur - durationS(info)) < 0.75;
  }

  Object.assign(report, await makeDubTheOnlyDefaultTrack(output, targetLang));

  const after = await probe(output);
  const a = audioStreams(after);
  report.audio_streams_after = a.length;
  if (a.length !== 1) throw new MediaError(`expected exactly one audio track after tagging, got ${a.length}`);
  const tags = a[0].tags || {};
  report.language_tag = tags.language ?? null;
  report.is_default = Boolean((a[0].disposition || {}).default);
  if (report.language_tag !== iso2(targetLang)) {
    throw new MediaError(`language tag did not stick: wanted ${iso2(targetLang)}, got ${pyRepr(report.language_tag)}`);
  }
  return report;
}

// ── the audio-only exports ────────────────────────────────────────────────────
// YouTube's multi-language audio tracks take an AUDIO-ONLY file of exactly the video's
// length. The duration check is a measurement, so a mismatch fails here rather than
// at YouTube after the customer has uploaded it.
export const AUDIO_DURATION_TOLERANCE_S = 0.5;

export interface AudioFormat {
  ext: string;
  muxers: string[];
  /** null = copy: a remux, the bytes lifted out unchanged */
  codec: string | null;
  args: string[];
  mime: string;
  label: string;
  note: string;
  lossless: boolean;
  tag_language: boolean;
}

// One row per thing a customer can download, as data, so the API, the sweep and the UI
// read the same list.
export const AUDIO_FORMATS: Record<string, AudioFormat> = {
  m4a: {
    ext: '.m4a',
    muxers: ['ipod', 'mp4'], // ipod writes the M4A brand; mp4 is the fallback
    codec: null,
    args: ['-movflags', '+faststart'],
    mime: 'audio/mp4',
    label: 'Audio only · M4A',
    note: "Lossless. Cut straight out of the video, same bytes. What YouTube's audio-track uploader takes.",
    lossless: true,
    tag_language: true,
  },
  mp3: {
    ext: '.mp3',
    muxers: ['mp3'],
    codec: 'libmp3lame',
    args: ['-b:a', '320k'],
    mime: 'audio/mpeg',
    label: 'Audio only · MP3',
    note: '320 kbps. Re-encoded, so very slightly lossy — pick M4A unless something you are using needs MP3.',
    lossless: false,
    tag_language: true,
  },
  wav: {
    ext: '.wav',
    muxers: ['wav'],
    codec: 'pcm_s16le',
    args: ['-ar', '48000'],
    mime: 'audio/wav',
    label: 'Audio only · WAV',
    note: 'Uncompressed 48 kHz. Large — roughly 11 MB a minute — but it is what YouTube prefers for sound recordings.',
    lossless: true,
    // WAV has no standard language tag
    tag_language: false,
  },
};

// `audio` was the name shipped first; bookmarked URLs keep working.
export const FORMAT_ALIASES: Record<string, string> = { audio: 'm4a', aac: 'm4a', mpeg: 'mp3', mp4: 'video' };
export const ALL_FORMATS = ['video', ...Object.keys(AUDIO_FORMATS)];

export function canonicalFormat(raw: string | null | undefined): string {
  let f = pyStrip(raw || 'video').toLowerCase();
  f = own(FORMAT_ALIASES, f) ?? f;
  if (!ALL_FORMATS.includes(f)) throw new MediaError(`format must be one of ${ALL_FORMATS.join(', ')}`);
  return f;
}

/** What the UI renders in the download menu. */
export function formatCatalogue(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    {
      format: 'video',
      ext: '.mp4',
      mime: 'video/mp4',
      kind: 'video',
      label: 'Dubbed video · MP4',
      note: 'The dub as its only audio track, tagged with the language and set as default, so it plays dubbed everywhere.',
      lossless: true,
    },
  ];
  for (const [key, spec] of Object.entries(AUDIO_FORMATS)) {
    out.push({ format: key, ext: spec.ext, mime: spec.mime, kind: 'audio', label: spec.label, note: spec.note, lossless: spec.lossless });
  }
  return out;
}

/** Cut the dubbed audio out of the delivered MP4 into a standalone file. */
export async function extractAudio(src: string, dest: string, targetLang: string, fmt = 'm4a'): Promise<Record<string, unknown>> {
  const spec = own(AUDIO_FORMATS, fmt);
  if (!spec) throw new MediaError(`${pyRepr(fmt)} is not an audio format`);
  if (!existsSync(src)) throw new MediaError('the dubbed video is not on disk, so its audio cannot be cut');

  const srcInfo = await probe(src);
  if (!audioStreams(srcInfo).length) throw new MediaError('the delivered file has no audio track to extract');
  const videoDuration = durationS(srcInfo);

  const lang2 = iso2(targetLang);
  // `.part`, so a crash cannot leave something that looks finished — and ffmpeg cannot
  // infer a muxer from it, which is why every format names one.
  const tmp = dest + '.part';

  const runOnce = (muxer: string) => {
    const cmd = [ffmpegBin(), '-hide_banner', '-nostats', '-v', 'error', '-y', '-i', src, '-vn', '-map', '0:a:0', '-c:a', spec.codec || 'copy', '-f', muxer];
    if (spec.tag_language) cmd.push('-metadata:s:a:0', `language=${lang2}`, '-metadata:s:a:0', `title=Dubbed (${targetLang})`);
    cmd.push(...spec.args, tmp);
    return procs.run(cmd, { timeoutMs: 1_800_000 });
  };

  let r: procs.RunResult | null = null;
  for (const muxer of spec.muxers) {
    r = await runOnce(muxer);
    if (r.code === 0) break;
    await unlinkQuiet(tmp);
  }
  if (r === null || r.code !== 0 || !existsSync(tmp) || sizeOf(tmp) < 512) {
    await unlinkQuiet(tmp);
    throw new MediaError(`${fmt} export failed: ${pySlice(r ? r.stderr || '' : '', 400)}`);
  }

  const outInfo = await probe(tmp);
  const outDuration = durationS(outInfo);
  if (audioStreams(outInfo).length !== 1) {
    await unlinkQuiet(tmp);
    throw new MediaError('the extracted file does not contain exactly one audio track');
  }
  if ((outInfo.streams || []).some((s) => s.codec_type === 'video')) {
    await unlinkQuiet(tmp);
    throw new MediaError('the extracted file still contains video');
  }
  const drift = Math.abs(outDuration - videoDuration);
  if (drift > AUDIO_DURATION_TOLERANCE_S) {
    await unlinkQuiet(tmp);
    throw new MediaError(
      `the audio track is ${pyFixed(drift, 2)}s off the video's length, and YouTube rejects a track that does not match. Not shipping it.`,
    );
  }
  await fsp.rename(tmp, dest);
  return {
    format: fmt,
    language_set: spec.tag_language ? lang2 : null,
    bytes: sizeOf(dest),
    duration_s: pyRound(outDuration, 3),
    video_duration_s: pyRound(videoDuration, 3),
    drift_s: pyRound(drift, 3),
    lossless: spec.lossless,
  };
}

/** Where a rendition is cached: beside the video, so it is swept with it. */
export function renditionPath(videoPath: string, fmt: string): string {
  const spec = own(AUDIO_FORMATS, fmt);
  if (!spec) throw new MediaError(`${pyRepr(fmt)} is not an audio format`);
  return withSuffix(videoPath, spec.ext);
}

/** Every rendition that could have been cut from a delivered video. */
export function renditionsOf(videoPath: string): string[] {
  return Object.values(AUDIO_FORMATS).map((s) => withSuffix(videoPath, s.ext));
}

/** Best-effort. Returns how many were removed. */
export function deleteRenditions(videoPath: string): number {
  let n = 0;
  for (const p of renditionsOf(videoPath)) {
    try {
      if (existsSync(p)) {
        unlinkSync(p);
        n++;
      }
    } catch {
      /* best effort */
    }
  }
  return n;
}
