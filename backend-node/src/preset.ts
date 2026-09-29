/**
 * THE GOLDEN PRESET — as data, copied from the Python backend's `app/preset.py`, which
 * stays the source of truth and is never edited from here.
 *
 * This is the only place any pipeline value is written down. The API accepts exactly one
 * pipeline-relevant input from a client — the target language — and everything else
 * comes from here. Every payload built from it is hashed, and the hash plus the version
 * are recorded on the job row, so any dub can be traced back to the exact bytes that
 * produced it.
 *
 * ── WHY THE NUMBERS ARE WRAPPED ──────────────────────────────────────────────
 *
 * The engine has always received `"guidance_scale":2.0`, not `2`. JavaScript cannot
 * tell those apart, so every value Python holds as a float is a PyFloat here and is
 * written exactly as Python writes it. The result is checked, not assumed: at startup
 * the preset's fingerprint is compared with PRESET_SHA256_EXPECTED, which was computed
 * by the Python backend from preset.py itself, and a mismatch stops every render (see
 * `presetIntact`). The parity script in scripts/parity/ also replays real payloads
 * through both implementations and compares the bytes.
 *
 * PROVENANCE (from preset.py): the values were read off the engine's own UI on
 * 2026-08-25 while a real dub ran, and the owner confirmed "use these settings as default
 * except language". timing_strategy=strict_slot is confirmed by every job in the
 * engine's own history. Values the UI does not expose stay at the engine's defaults.
 */
import { canonicalJson, PyFloat, sha256Hex } from './py';

export const PRESET_VERSION = '2026-08-25.2-ui-confirmed';

/**
 * preset_only_fingerprint() as the PYTHON backend computes it from preset.py. If this
 * copy ever drifts from that file, the fingerprints disagree and renders are refused.
 */
export const PRESET_SHA256_EXPECTED = '853a9e63a12b31be7026f27e52dff6b929e1eb9c8e1bf15fe793a16453356992';

const f = (v: number) => new PyFloat(v);

// ── /dub/generate body, minus the per-job segment list ────────────────────────
export const GENERATE_BASE: Readonly<Record<string, unknown>> = Object.freeze({
  // UI: TIMING = "Strict slot". The engine's own default is "concise", so this must be
  // sent explicitly or the dub silently changes character.
  timing_strategy: 'strict_slot',
  // UI: VOICE MATCH = "Per line". Sent explicitly so the preset is self-describing.
  voice_match: 'per_line',
  // Legacy knob, ignored whenever timing_strategy is set. Kept so the payload is complete.
  slot_fit: 'time_stretch',
  // 0.0, so per-line overruns cannot accumulate and push later lines off their mouths.
  overflow_budget_s: f(0.0),
  // Not exposed in the UI; the engine's defaults.
  num_step: 16,
  guidance_scale: f(2.0),
  speed: f(1.0),
  // Inert under strict_slot; correct guard rails in case the strategy ever changes:
  // never slow the picture to fit long audio.
  fit_options: Object.freeze({
    gap_guard_s: f(0.12),
    audio_rate_cap: f(1.25),
    max_audio_only_rate: f(1.25),
    video_slow_cap: f(1.0),
    allow_video_retime: false,
  }),
});

// ── /dub/translate body, minus the per-job segment list ───────────────────────
export const TRANSLATE_BASE: Readonly<Record<string, unknown>> = Object.freeze({
  // UI: ENGINE = "LLM (OpenAI-compatible)". Unset would fall back to a different
  // translator entirely.
  provider: 'openai',
  // UI: QUALITY = "Autofit": cinematic reflect-then-adapt plus strict fit-to-slot.
  quality: 'autofit',
  // UI: "Auto glossary" and "Reflect pass" checked.
  auto_glossary: true,
  reflect: true,
  // UI: "Suggest shorter lines" checked (matches the approved configuration exactly).
  condense: true,
});

// ── /dub/download query ───────────────────────────────────────────────────────
export const DOWNLOAD_QUERY_BASE: Readonly<Record<string, unknown>> = Object.freeze({
  // UI: "Mix BG Audio" checked. Dual and burned subtitles are unchecked, so omitted.
  preserve_bg: 'true',
});

// default_track is the TARGET language, deliberately not the UI's "Original": the
// customer must receive the dub as the only and default track.

/**
 * The exact body for POST /dub/generate/{job_id}. `segments` must carry EVERY row in
 * order, including empty ones; `segment_ids` makes the mapping explicit.
 */
export function generatePayload(segments: unknown[], segmentIds: string[], targetLang: string): Record<string, unknown> {
  const body: Record<string, unknown> = { ...GENERATE_BASE };
  body.fit_options = { ...(GENERATE_BASE.fit_options as object) };
  body.segments = segments;
  body.segment_ids = segmentIds;
  body.language_code = targetLang;
  return body;
}

export function translatePayload(segments: unknown[], targetLang: string, sourceLang: string | null | undefined, vsJobId: string): Record<string, unknown> {
  const body: Record<string, unknown> = { ...TRANSLATE_BASE };
  body.segments = segments;
  body.target_lang = targetLang;
  body.job_id = vsJobId;
  if (sourceLang) body.source_lang = sourceLang;
  return body;
}

export function downloadQuery(targetLang: string): Record<string, unknown> {
  const q: Record<string, unknown> = { ...DOWNLOAD_QUERY_BASE };
  q.default_track = targetLang;
  q.include_tracks = targetLang;
  return q;
}

/** SHA-256 over the preset version and the payloads actually sent. */
export function fingerprint(...payloads: unknown[]): string {
  return sha256Hex(Buffer.from(canonicalJson({ version: PRESET_VERSION, payloads }), 'utf8'));
}

/** Hash of the preset values alone, independent of any job's segments. */
export function presetOnlyFingerprint(): string {
  return sha256Hex(
    Buffer.from(
      canonicalJson({ version: PRESET_VERSION, generate: GENERATE_BASE, translate: TRANSLATE_BASE, download: DOWNLOAD_QUERY_BASE }),
      'utf8',
    ),
  );
}

/** Is this copy still byte-identical to preset.py? Checked before every render. */
export function presetIntact(): boolean {
  return presetOnlyFingerprint() === PRESET_SHA256_EXPECTED;
}

// What a client may never set (asserted in code rather than trusted).
export const FORBIDDEN_CLIENT_FIELDS: ReadonlySet<string> = new Set([
  'timing_strategy', 'voice_match', 'slot_fit', 'num_step', 'guidance_scale',
  'speed', 'fit_options', 'overflow_budget_s', 'provider', 'quality',
  'auto_glossary', 'reflect', 'condense', 'preserve_bg', 'default_track',
  'include_tracks', 'burn_subs', 'dual', 'segments', 'segment_ids',
]);

/** A client tried to set a field the server preset owns. Answered as a 400. */
export class ClientOverrideError extends Error {
  override name = 'ClientOverrideError';
}

/** Refuse, loudly, anything a client sends that could steer the pipeline. */
export function rejectClientOverrides(payload: Record<string, unknown>): void {
  const bad = Object.keys(payload)
    .filter((k) => FORBIDDEN_CLIENT_FIELDS.has(k))
    .sort();
  if (bad.length) {
    throw new ClientOverrideError('these fields are set by the server preset and cannot be supplied by a client: ' + bad.join(', '));
  }
}
