import os
import re
import json
import logging
import time
import asyncio
import shutil
import zipfile
import torch
import torchaudio
from fastapi import APIRouter, HTTPException

from core.db import db_conn
from core.config import DUB_DIR, VOICES_DIR, dub_seg_path
from core.tasks import task_manager
from schemas.requests import DubRequest
from services.model_manager import _gpu_pool, run_on_gpu_pool_guarded
from services.tts_backend import resolve_generation_backend, active_backend_id
from services import gpu_gateway
from services.audio_dsp import apply_mastering, normalize_audio, apply_effects_chain, get_effect_chain
from services.audio_io import atomic_save_wav, _safe_torchaudio_save
from services.ffmpeg_utils import (
    find_ffmpeg,
    spawn_subprocess,
    # Moved to ffmpeg_utils so the Smart Fit export pipeline (Phase B) can
    # reuse them; re-imported here so `dub_generate._atempo_chain` /
    # `_pitch_preserving_stretch` keep working for existing importers.
    _atempo_chain,
    _pitch_preserving_stretch,
)
from services.rvc import apply_rvc, is_enabled as rvc_is_enabled
from services.incremental import segment_fingerprint, fit_fingerprint
from services.fit_planner import UNDERRUN_TOLERANCE, FitParams, plan_fit
from services.watermark import mark_synthetic
from services.speaker_clone import auto_profile_id
from api.routers.dub_core import _get_job, _safe_job_dir, _save_job
from omnivoice.utils.voice_design import heal_design_instruct

logger = logging.getLogger("omnivoice.dub")

# Maximum compression ratio we'll attempt with pitch-preserving stretch
# before declaring "no way to fit cleanly" and falling back. atempo
# remains intelligible up to ~1.5× then introduces audible WSOLA
# artefacts; above ~1.8× speech becomes a fast garbled stream that no
# DSP can rescue. The contributing-factor pipeline (CPS-aware slot-fit
# in services/speech_rate.py, gap absorption below) keeps us under this
# in practice — this is only a guard rail.
MAX_STRETCH_RATIO = 1.8


# The engine often speaks a short breath or false start before a line's actual
# words. Measured in a delivered 546.7s dub: 10 of 29 line onsets began with
# 40-450 ms of sound before speech became sustained, median 150 ms. On fresh renders
# of the same lines it appears in roughly one in five.
#
# It is not a copy of the clone reference. Log-mel similarity of those lead-ins to
# the reference was 0.753 against 0.603 for a frame-shuffled control, and the best
# match landed scattered across the whole 14s reference rather than at one place, so
# there is nothing upstream to clean. The model generates a fresh breath each time,
# which is why it sounds identical while measuring as different audio.
#
# This ATTENUATES the lead-in; it does not cut it. An earlier version of this patch
# cut the leading samples and was reverted: cutting pulls every later sample earlier
# and destroys the sync the fitter maintains, and it also put the speech attack at
# the very start where it measured worse than the breath it replaced.
LEAD_MIN_S = float(os.environ.get("DUB_LEAD_MIN_S", "0.04"))
# Raised from 0.45 after the hiss pass went in. Removing the sibilant burst
# revealed the lead-in it had been masking: with a loud hiss present the
# level-based onset test saw speech starting immediately and measured a lead
# of zero. A 530 ms lead then showed up just past the old ceiling.
LEAD_MAX_S = float(os.environ.get("DUB_LEAD_MAX_S", "0.60"))
LEAD_CUT_DB = float(os.environ.get("DUB_LEAD_CUT_DB", "-22"))
LEAD_SUSTAIN_FRAMES = int(os.environ.get("DUB_LEAD_SUSTAIN_FRAMES", "12"))


def _attenuate_lead(wav, sr: int):
    """Pull down any non-speech lead at the start of a synthesized clip.

    Conservative: acts only when the clip opens with 40-450 ms that is audible but
    not yet sustained speech, never changes the clip's length, and returns the input
    untouched on anything unexpected.
    """
    try:
        if wav is None or wav.numel() < sr // 4:
            return wav
        mono = wav.detach().to(torch.float32)
        mono = mono.mean(dim=0) if mono.dim() > 1 else mono
        hop = max(1, int(sr * 0.01))
        n = mono.numel() // hop
        if n < 20:
            return wav
        f = mono[:n * hop].reshape(n, hop).pow(2).mean(dim=1).sqrt()
        peak = float(torch.quantile(f, 0.95))
        floor = float(torch.quantile(f, 0.10))
        if peak <= 0.0 or peak <= floor * 1.5:
            return wav
        on = f >= floor + 0.08 * (peak - floor)
        if not bool(on.any()):
            return wav
        start = int(torch.argmax(on.to(torch.int8)))
        j = start
        limit = min(int(on.numel()) - LEAD_SUSTAIN_FRAMES,
                    start + int(LEAD_MAX_S * sr / hop) + LEAD_SUSTAIN_FRAMES)
        while j < limit:
            if bool(on[j:j + LEAD_SUSTAIN_FRAMES].all()):
                break
            j += 1
        lead_s = (j - start) * hop / float(sr)
        if not (LEAD_MIN_S <= lead_s <= LEAD_MAX_S):
            return wav

        a = start * hop
        b = min(int(wav.shape[-1]), j * hop)
        if b - a < 8:
            return wav
        g = 10.0 ** (LEAD_CUT_DB / 20.0)
        length = b - a
        gain = torch.full((length,), g, dtype=wav.dtype, device=wav.device)
        tail = max(1, length // 4)
        gain[-tail:] = torch.linspace(g, 1.0, tail, dtype=wav.dtype,
                                      device=wav.device)
        out = wav.clone()
        out[..., a:b] = out[..., a:b] * gain
        return out
    except Exception:
        return wav


# The engine leaves a sibilant burst in many generated clips: a run of audio whose
# energy is almost entirely above 4 kHz, at full speech loudness. It is heard as an
# "sss" around the edges of a line, which reads to a listener as a sound sitting in
# the gap between lines.
#
# Measured on a delivered 546.7s dub of 176 lines: 103 bursts totalling 21.8s,
# 120-360 ms each at -13 to -21 dB, high-frequency fraction 0.986-0.999. Two spots a
# user marked independently both fell inside detected bursts.
#
# Thresholds were calibrated against the separated ORIGINAL HUMAN VOICE of the same
# video, which contains real Telugu sibilants, because the detector has to tell a
# generated hiss from a genuine /s/:
#
#     fraction >= 0.97, >= 120 ms, >= -30 dB  ->  103 in the dub, 2 in the human
#                                                 original (51:1)
#
# Looser settings took real speech: 0.90 and 80 ms produced 39 hits on the human
# original. This is where the two populations separate, not a value tuned to one clip.
#
# Note this is NOT covered by _attenuate_lead. That decides where speech begins from
# LEVEL alone, and a loud hiss reads as speech, so the lead measures zero and nothing
# is done. The two passes are complementary.
HISS_FRAC = float(os.environ.get("DUB_HISS_FRAC", "0.97"))
HISS_MIN_S = float(os.environ.get("DUB_HISS_MIN_S", "0.12"))
HISS_MIN_DB = float(os.environ.get("DUB_HISS_MIN_DB", "-30"))
HISS_CUT_DB = float(os.environ.get("DUB_HISS_CUT_DB", "-25"))
HISS_FRAME_S = 0.02


def _suppress_hiss_burst(wav, sr: int):
    """Attenuate near-pure high-frequency bursts inside a synthesized clip.

    Never changes the clip's length, so timing is untouched. Returns the input
    unchanged on anything unexpected.
    """
    try:
        if wav is None or wav.numel() < int(sr * HISS_MIN_S) * 2:
            return wav
        mono = wav.detach().to(torch.float32)
        mono = mono.mean(dim=0) if mono.dim() > 1 else mono
        n = max(16, int(sr * HISS_FRAME_S))
        cnt = mono.numel() // n
        if cnt < 3:
            return wav
        frames = mono[:cnt * n].reshape(cnt, n)
        win = torch.hann_window(n, dtype=frames.dtype, device=frames.device)
        spec = torch.fft.rfft(frames * win, dim=1).abs().pow(2)
        freqs = torch.fft.rfftfreq(n, d=1.0 / sr).to(spec.device)
        hi = spec[:, (freqs >= 4000) & (freqs < 9000)].sum(dim=1)
        lo = spec[:, (freqs >= 80) & (freqs < 1000)].sum(dim=1)
        frac = hi / (hi + lo + 1e-20)
        rms = frames.pow(2).mean(dim=1).clamp_min(1e-24).sqrt()
        lvl = 20.0 * torch.log10(rms)
        mask = (frac >= HISS_FRAC) & (lvl >= HISS_MIN_DB)
        if not bool(mask.any()):
            return wav

        need = max(1, int(round(HISS_MIN_S / HISS_FRAME_S)))
        g = 10.0 ** (HISS_CUT_DB / 20.0)
        out = wav.clone()
        m = mask.tolist()
        i = 0
        touched = 0
        while i < len(m):
            if m[i]:
                j = i
                while j < len(m) and m[j]:
                    j += 1
                if j - i >= need:
                    a = i * n
                    b = min(int(out.shape[-1]), j * n)
                    length = b - a
                    if length >= 8:
                        gain = torch.full((length,), g, dtype=out.dtype,
                                         device=out.device)
                        r = min(max(1, int(0.010 * sr)), length // 2)
                        if r > 0:
                            gain[:r] = torch.linspace(1.0, g, r, dtype=out.dtype,
                                                      device=out.device)
                            gain[-r:] = torch.linspace(g, 1.0, r, dtype=out.dtype,
                                                       device=out.device)
                        out[..., a:b] = out[..., a:b] * gain
                        touched += 1
                i = j
            else:
                i += 1
        return out if touched else wav
    except Exception:
        return wav


# Minimum sampling steps for a dub.
#
# The Dubbing tab sends no num_step (store numStep is null), so every segment of a
# real job rendered at 16: seg_num_step came back {16: 176}. Their own Audiobook tab
# defaults to 32, and the Fast/Autofit/Cinematic buttons in Dubbing control the
# translation LLM, not TTS sampling.
#
# 16 is the last untested suspect for the sibilant bursts. Everything downstream has
# been eliminated by measurement: the AudioSeal watermark (residual -43 dB, adds 0
# bursts to real human audio), the mastering chain (60 Hz highpass + 1.5:1
# compressor), peak normalisation, the background stem, Demucs separation (speech-band
# leak -50 dB, background does not track the voice), the clone reference (log-mel
# similarity 0.753 against a 0.603 shuffled control, best match scattered over the
# whole clip), and a fixed inserted clip (line starts match each other at 0.022,
# same as mid-line controls).
#
# An under-sampled flow-matching model produces exactly this artifact: unvoiced noise
# in regions it has not converged. Raising the floor costs render time roughly
# linearly and is the only remaining change that addresses the producer rather than
# the symptom.
DUB_MIN_STEPS = int(os.environ.get("DUB_MIN_STEPS", "32"))


def _prepare_oom_retry(error: Exception, *, execution_target: str) -> bool:
    """Prepare one *local* low-step retry after a genuine device OOM.

    The cache being flushed must belong to the device that raised the error.
    A remote worker owns its own recovery policy; flushing this process's CUDA
    cache after a remote failure both stalls the wrong GPU and can evict an
    unrelated local job.  Keep this guard at the retry chokepoint so a future
    ``dub_segments`` producer cannot accidentally inherit the old behaviour.

    Returns ``False`` for non-OOM errors.  Remote OOMs are deliberately raised
    unchanged: the worker may classify/retry them, but this process must not.
    """
    is_oom = (
        isinstance(error, torch.cuda.OutOfMemoryError)
        or "out of memory" in str(error).lower()
        or "CUDA error" in str(error)
    )
    if not is_oom:
        return False
    if execution_target != "local":
        raise error

    import gc

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        torch.mps.empty_cache()
    return True


def _trim_trailing_silence(wav, sr: int, *, keep_s: float = 0.06,
                           min_trim_s: float = 0.20, min_voiced_s: float = 0.15):
    """Drop the silence the engine leaves after the last word.

    strict_slot asks the engine for the whole slot as its target duration. When
    the line does not need that long the engine says its piece and leaves the
    rest of the canvas empty, so the returned buffer is slot-length but only
    part speech. Keeping that tail is what the listener hears as the audio
    cutting out mid-shot.

    Conservative by construction: `keep_s` of room is left after the last
    voiced frame so a soft final consonant and the mix loop's 15 ms fade are
    never clipped, nothing is done unless at least `min_trim_s` would come off,
    and a buffer holding less than `min_voiced_s` of voiced content is left
    alone entirely (there is nothing there to protect, so the detection is not
    trustworthy). Any failure returns the input untouched - this is a timing
    helper and must not be able to damage audio.

    An earlier version capped the trim at a fraction of the buffer instead.
    Unit tests rejected it: a short line inside a long slot is exactly the case
    that needs a large trim, and the cap preserved the dead air it was supposed
    to be guarding against.
    """
    try:
        import torch as _t

        n = int(wav.shape[-1])
        if n <= 0 or sr <= 0:
            return wav
        mono = wav if wav.dim() == 1 else wav.mean(dim=0)
        frame = max(1, int(0.02 * sr))
        usable = (n // frame) * frame
        if usable < frame * 2:
            return wav
        rms = mono[:usable].reshape(-1, frame).pow(2).mean(dim=1).sqrt()
        db = 20.0 * _t.log10(rms.clamp_min(1e-10))
        peak = _t.quantile(db, 0.97)
        # 35 dB below the line's own peak, but never above a hard floor: a
        # whispered line must not have its quiet half declared silence.
        gate = _t.minimum(peak - 35.0, _t.tensor(-45.0, device=db.device, dtype=db.dtype))
        voiced = (db > gate).nonzero()
        if voiced.numel() == 0:
            return wav
        last_end = int(voiced[-1].item() + 1) * frame
        cut = min(n, last_end + int(keep_s * sr))
        if float(voiced.numel()) * frame / sr < min_voiced_s:
            return wav
        if n - cut < int(min_trim_s * sr):
            return wav
        if cut >= n:
            return wav
        return wav[..., :cut]
    except Exception:
        return wav


def _underrun_min_rate() -> float:
    """Floor for the underrun fill (audio slowed toward its slot, never below
    this rate). Default 0.85 stays natural-sounding; OMNIVOICE_UNDERRUN_MIN_RATE=1.0
    disables the fill. Clamped to atempo's per-stage sane range."""
    try:
        v = float(os.environ.get("OMNIVOICE_UNDERRUN_MIN_RATE", "0.85"))
    except ValueError:
        v = 0.85
    return min(1.0, max(0.5, v))
# How far a too-long segment is allowed to bleed into the silent gap
# before the next segment. Buys headroom on languages with higher
# information density (Bengali, Hindi, Arabic…) without the audio
# colliding with the next speaker's onset.
GAP_OVERFLOW_MAX_S = 0.25
GAP_OVERFLOW_BUFFER_S = 0.05


def _sync_job_segments(job: dict, req: DubRequest) -> None:
    """Persist the segments this dub was actually generated from back onto the job.

    The editor only sends the (translated / user-edited) segment text in the
    generate request; the job itself kept the original-language ASR transcript.
    SRT/VTT export and ffmpeg subtitle burn-in read `job["segments"]`, so they
    rendered the source language instead of the dub the user just heard (#309).

    Merge strategy: rebuild `job["segments"]` from the request, carrying over
    per-segment metadata (speaker_id, id, …) from the existing job segment
    matched by stable id (fallback: index). `text_original` always keeps the
    source-language text so dual-subtitle layouts can still stack it under the
    translation.
    """
    if not req.segments:
        return
    existing = [s for s in (job.get("segments") or []) if isinstance(s, dict)]
    by_id = {str(s["id"]): s for s in existing if s.get("id") is not None}
    seg_ids = req.segment_ids or []
    merged: list[dict] = []
    for i, seg in enumerate(req.segments):
        seg_id = seg_ids[i] if i < len(seg_ids) else None
        prev = by_id.get(str(seg_id)) if seg_id is not None else None
        if prev is None and i < len(existing):
            prev = existing[i]
        row = dict(prev) if prev else {}
        if seg_id is not None:
            # The request id is authoritative — seg_order and the per-segment
            # WAV manifest are keyed by it.
            row["id"] = seg_id
        # Source-language text survives the overwrite so dual-subtitle export
        # keeps working; never let the translation clobber it.
        row["text_original"] = row.get("text_original") or row.get("text") or ""
        row["start"] = seg.start
        row["end"] = seg.end
        row["text"] = seg.text
        merged.append(row)
    job["segments"] = merged

    # P1.2 — per-language text, additively. `job["segments"]` stays the flat
    # single-slot map every existing consumer reads (last generated language);
    # `job["segments_i18n"]` preserves EACH generated track's text so
    # /dub/srt|vtt?lang= can emit that language instead of N identical files.
    # Shape: { langCode: { segKey: text } } where segKey is the segment's
    # stable id (str) or, for id-less legacy segments, its list index (str).
    # The whole per-language map is rebuilt on every generate of that language
    # (the request always carries the full segment list), so deleted segments
    # never linger. Jobs predating this field simply lack it — every reader
    # falls back to `job["segments"]`.
    lang = (req.language_code or "und").strip() or "und"
    i18n = job.setdefault("segments_i18n", {})
    i18n[lang] = {
        (str(row["id"]) if row.get("id") is not None else str(i)): row["text"]
        for i, row in enumerate(merged)
    }


def _seg_hashes_by_lang(job: dict) -> dict:
    """Per-language segment fingerprints: { langCode: { segId: hash } }.

    Additive migration (P1.3): jobs written by previous builds carry ONE flat
    `seg_hashes` map that was overwritten by whichever language generated
    last. That flat map can only describe the job's last-generated track, so
    it is attributed to `job["language_code"]` (which generate has always
    kept in lock-step with the last run). When even that is unknown the
    legacy hashes are dropped — segments then read as stale and regenerate
    cleanly, which is safer than guessing a language and splicing wrong-track
    audio. Note the legacy hashes also predate language-scoped fingerprints
    (see services.incremental.segment_fingerprint), so they compare stale
    once regardless — carrying them over just preserves the job shape.
    """
    by_lang = job.get("seg_hashes_by_lang")
    if not isinstance(by_lang, dict):
        by_lang = {}
        legacy = job.get("seg_hashes")
        prev_lang = job.get("language_code")
        if isinstance(legacy, dict) and legacy and prev_lang:
            by_lang[prev_lang] = dict(legacy)
        job["seg_hashes_by_lang"] = by_lang
    return by_lang


def _legacy_seg_cache_ok(job: dict, lang_code: str) -> bool:
    """May this run reuse legacy un-keyed ``seg_<id>.wav`` files?

    Only when no OTHER language's audio could be sitting in them: the job has
    no dubbed track in a different language. Single-language jobs rendered by
    previous builds therefore keep their whole on-disk cache; the moment a
    job carries a second language the un-keyed files are ambiguous (they hold
    whichever language wrote them last) and must never be spliced into a
    track again — the P1.3 cross-contamination class.
    """
    tracks = job.get("dubbed_tracks") or {}
    return not any(lc != lang_code for lc in tracks)


# ── voice_match="consistent" resolution ─────────────────────────────────────
# Owner report: "still 4 segments different in voice". Per-segment refs (Wave
# 3.2) clone each line from a clip of its own source audio — best prosody
# match, but the voice IDENTITY drifts line to line, and heuristic-diarized
# jobs have no pooled speaker clones to anchor it. `voice_match="consistent"`
# resolves every segment of a speaker to ONE reference: the per-speaker clone
# when it exists, otherwise a deterministic pick among that speaker's own
# per-segment clips.

# Below ~3 s zero-shot prompt-priming gets unstable, so prefer clips at or
# above it when choosing the one shared reference.
CONSISTENT_MIN_REF_S = 3.0


def _speaker_key_matches(speaker_id: str, key: str) -> bool:
    """Same matching rule the `auto:` branch has always used: the safe-name
    slug first (`auto_profile_id`), the raw speaker id as fallback."""
    return auto_profile_id(speaker_id) == f"auto:{key}" or speaker_id == key


def _find_speaker_clone(clones: dict, key: str):
    for spk, info in (clones or {}).items():
        if _speaker_key_matches(spk, key):
            return info
    return None


def _seg_id_order(sid: str):
    """Sort key for the tie-break: numeric suffix when there is one (so
    'seg_2' < 'seg_10'), plain string ordering otherwise. Deterministic for
    any id shape."""
    m = re.search(r"(\d+)$", sid)
    return (0, int(m.group(1)), sid) if m else (1, 0, sid)


def _speaker_key_for_segment(job: dict, sid) -> str | None:
    """The `auto:`-style key of the speaker that owns segment `sid`, from the
    job's diarized segment rows. None when the segment is unknown (the caller
    then keeps per-line behaviour for it — best effort, never a crash)."""
    for row in job.get("segments") or []:
        if isinstance(row, dict) and str(row.get("id", "")) == str(sid):
            spk = row.get("speaker_id") or "Speaker 1"
            return auto_profile_id(spk)[len("auto:"):]
    return None


#: ``job_id -> {(segment, path)}`` already warned about, so a 300-segment dub
#: whose clip directory was cleaned logs once per segment rather than once per
#: retry.
#:
#: Keyed on the PATH as well as the segment, not the segment alone. The
#: single-segment preview endpoint has no segment identity to pass — it is a
#: "render this text" call — so every preview shared one key and only the first
#: missing reference in a job was ever reported, silencing the rest (greptile).
#: A distinct path is distinct information wherever it comes from, and on the
#: render path this also means a segment whose binding was changed to a second
#: missing clip is not mistaken for the one already reported.
_MISSING_REF_WARNED: dict = {}


def warn_if_ref_missing(ref_audio, *, job_id: str = "", seg_id="", where: str = "dub"):
    """Say so when a clone reference points at a file that is gone (#1331).

    Reported as: re-dubbing a single sentence loses the cloned voice, while
    re-dubbing everything keeps it.

    Clone references are FILE PATHS into the job's extracted-clip directory,
    and the whole job dict — those paths included — is persisted to
    ``dub_history.job_data`` so saved projects reopen after a restart. The job
    therefore outlives its clips. Reopen a saved dub once the clip directory
    has been cleaned, regenerate one line, and every resolution branch hands
    the engine a path that is no longer there. An engine given a missing
    reference renders *uncloned* rather than failing, so the line comes back in
    a default voice matching nothing else in the dub, with no error anywhere.
    Re-running the full dub re-extracts the clips — which is exactly why that
    appears to fix it, and is the workaround the reporter found unaided.

    Deliberately DIAGNOSTIC ONLY: ``ref_audio`` is returned unchanged. Nulling
    it would not change what the user hears (the engine already falls back),
    and it would decide on the engine's behalf that a reference it cannot
    ``stat`` is unusable — untrue for anything resolved inside a sidecar's own
    namespace. The defect here is the silence, not the fallback.
    """
    if not ref_audio:
        return ref_audio
    try:
        if os.path.exists(ref_audio):
            return ref_audio
    except OSError:  # unreadable path (permissions, dead mount) — same symptom
        pass
    seen = _MISSING_REF_WARNED.setdefault(str(job_id), set())
    key = (str(seg_id), str(ref_audio))
    if key not in seen:
        seen.add(key)
        logger.warning(
            "%s: the voice reference for segment %s is gone (%s), so this line "
            "will most likely render in a DEFAULT voice instead of the cloned "
            "one, with no error of its own. Clone clips are extracted per job "
            "and the job outlives them, so a saved dub regenerated after "
            "cleanup loses them — re-running the full dub re-extracts the "
            "clips, which is why that appears to fix it (#1331).",
            where, seg_id, ref_audio,
        )
    return ref_audio


def forget_missing_ref_warnings(job_id: str) -> None:
    """Drop the once-per-segment warning memo for a job (a fresh render should
    warn again if the clips are still gone)."""
    _MISSING_REF_WARNED.pop(str(job_id), None)


def resolve_consistent_ref(job: dict, speaker_key: str, memo: dict | None = None):
    """ONE clone reference for every segment of `speaker_key`.

    Preference order:
      1. the pooled per-speaker clone (job["speaker_clones"]) — same lookup
         the per-line path uses as its fallback;
      2. no speaker clone (heuristic diarization skips extraction entirely —
         the key case): a deterministic pick among that speaker's per-segment
         clips: longest clip ≥3 s, tie-break lowest segment id. Clips all
         shorter than 3 s degrade to "longest overall", same tie-break.

    Returns the clone info dict ({"ref_audio", "ref_text", ...}) or None.
    Pure function of the job dict; `memo` (keyed by speaker_key) just avoids
    rescanning per segment — the pick is deterministic with or without it.
    """
    if memo is not None and speaker_key in memo:
        return memo[speaker_key]

    ref = _find_speaker_clone(job.get("speaker_clones") or {}, speaker_key)
    if ref is None:
        seg_clones = job.get("segment_clones") or {}
        candidates = []
        for row in job.get("segments") or []:
            if not isinstance(row, dict):
                continue
            spk = row.get("speaker_id") or "Speaker 1"
            if not _speaker_key_matches(spk, speaker_key):
                continue
            sid = str(row.get("id", ""))
            info = seg_clones.get(sid)
            if info and info.get("ref_audio"):
                candidates.append((sid, info))
        if candidates:
            usable = [
                c for c in candidates
                if float(c[1].get("duration") or 0.0) >= CONSISTENT_MIN_REF_S
            ] or candidates
            usable.sort(
                key=lambda c: (-float(c[1].get("duration") or 0.0), _seg_id_order(c[0]))
            )
            ref = usable[0][1]

    if memo is not None:
        memo[speaker_key] = ref
    return ref


def _remote_voice(job: dict, profile_id: str | None, seg_id, voice_match: str,
                  memo: dict) -> tuple[str | None, str | None, bool, str | None, int | None]:
    """Resolve a dub binding without touching the TTS model."""
    ref_audio = ref_text = instruct = None
    seed = None
    single_use = False
    if profile_id and profile_id.startswith("auto-seg:"):
        sid = profile_id[len("auto-seg:"):]
        info = (job.get("segment_clones") or {}).get(sid)
        shared = False
        if voice_match == "consistent" and sid == str(seg_id):
            key = _speaker_key_for_segment(job, sid)
            alternate = resolve_consistent_ref(job, key, memo) if key else None
            if alternate:
                info = alternate
                shared = True
        if info:
            ref_audio, ref_text = info.get("ref_audio"), info.get("ref_text")
            single_use = not shared
    elif profile_id and profile_id.startswith("auto:"):
        key = profile_id[len("auto:"):]
        if voice_match == "consistent":
            info = resolve_consistent_ref(job, key, memo)
        else:
            info = ((job.get("segment_clones") or {}).get(str(seg_id))
                    or _find_speaker_clone(job.get("speaker_clones") or {}, key))
            single_use = str(seg_id) in (job.get("segment_clones") or {})
        if info:
            ref_audio, ref_text = info.get("ref_audio"), info.get("ref_text")
    elif profile_id:
        with db_conn() as conn:
            row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if row:
            seed = row["seed"]
            if row["is_locked"] and row["locked_audio_path"]:
                ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                ref_text = row["ref_text"]
            elif row["instruct"] and not row["is_locked"]:
                try:
                    vd_states = row["vd_states"]
                except (KeyError, IndexError):
                    vd_states = None
                instruct = heal_design_instruct(row["instruct"], vd_states)
            else:
                ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                ref_text = row["ref_text"]
    return ref_audio, ref_text, single_use, instruct, seed


def _decode_remote_dub(result: gpu_gateway.RemoteResult) -> dict[int, str]:
    """Extract the worker bundle into a task-scoped directory, path-safely."""
    target = os.path.join(DUB_DIR, ".remote", result.task_id)
    os.makedirs(target, exist_ok=True)
    paths: dict[int, str] = {}
    with zipfile.ZipFile(result.path) as archive:
        for member in archive.infolist():
            match = re.fullmatch(r"segments/(\d+)\.wav", member.filename)
            if not match:
                raise ValueError(f"unexpected dub artifact member: {member.filename}")
            index = int(match.group(1))
            destination = os.path.join(target, f"{index}.wav")
            partial = f"{destination}.part"
            with archive.open(member) as source, open(partial, "wb") as output:
                shutil.copyfileobj(source, output)
            os.replace(partial, destination)
            paths[index] = destination
    return paths


router = APIRouter()

@router.post("/dub/generate/{job_id}")
async def dub_generate(job_id: str, req: DubRequest):
    """Adds a dub generation job to the async batch task pool."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="This dub session has expired or was never created. Re-upload the video to start a new one.",
        )

    # Last line of defence for the voice binding. Any path that rewrote job["segments"]
    # can have dropped profile_id, and without it this render silently uses the default
    # voice for every line instead of the speaker's clone. Re-deriving here also heals
    # jobs that were already damaged, with no need to transcribe them again. It never
    # overrides a binding the user chose.
    try:
        from services.voice_binding import ensure_segment_bindings
        if ensure_segment_bindings(job):
            _save_job(job_id, job)
    except Exception as e:  # noqa: BLE001 - a render must not fail on this
        logger.warning("voice binding refresh before render skipped: %s", e)

    # ── Engine resolution (issue #312 class) ────────────────────────────────
    # Dub used to hardcode VoiceStudio via get_model() regardless of the engine
    # selected in Settings → Engines — a SILENT fallback. Every real dub
    # segment's ref_audio resolves to either an auto:<speaker>/auto-seg:<id>
    # clone cut from the source video or a saved voice-profile row (see
    # `_gen` below), so require_cloning=True: an engine that can't clone
    # would either mis-clone per segment or fail deep into the job. Checked
    # ONCE here, before the streaming task starts, so a doomed job fails fast
    # with one clear message instead of N per-segment ones.
    try:
        backend = await resolve_generation_backend(require_cloning=True)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    async def _stream(task_id):
        total = len(req.segments)
        all_segment_wavs = []
        sync_scores = []
        # Wrong-language-audio accounting for this run. A job whose every line
        # comes back in the source language must not silently triple its own
        # render time, so re-renders are capped per line AND per job.
        _hl_stats = {"ok": 0, "lead": 0, "all_source": 0, "babble": 0,
                     "unknown": 0, "cut_s": 0.0, "rerendered": 0}
        _hl_budget = -1

        # Track language for this run. Everything per-track — the per-segment
        # WAV cache, fingerprints, seg_wav_kind — is keyed by it (P1.3) so a
        # multi-language job's tracks can't cross-contaminate.
        lang_code = req.language_code or "und"

        def _seg_lang_path(seg_key) -> str:
            # Per-language per-segment WAV: seg_{lang}_{id}.wav. Built through
            # dub_seg_path so the sanitisation + DUB_DIR containment guard
            # apply to the combined key. Legacy un-keyed seg_{id}.wav files
            # remain readable via the gated fallback (_legacy_seg_cache_ok).
            return dub_seg_path(job_id, f"{lang_code}_{seg_key}")

        # Throttle the device cache flush. empty_cache() is a synchronous
        # device stall, so calling it every segment (as the old code did)
        # serialised the GPU loop; the batched-I/O design it replaced kept
        # it off the hot path on purpose. Flush every ~16 releases instead —
        # frequent enough to bound VRAM, rare enough to stay invisible.
        _RELEASE_FLUSH_EVERY = 16
        _release_count = {"n": 0}

        def _release_audio_tensors(*objs) -> None:
            """Best-effort VRAM cleanup after a segment is safely on disk.

            Tensors are freed by the callers' own ``del`` once they fall out
            of scope; this only throttles the device cache flush. ``*objs`` is
            kept for call-site compatibility but intentionally unused — a local
            ``del`` here would only unbind the parameter, never the caller's
            reference.
            """
            _release_count["n"] += 1
            if _release_count["n"] % _RELEASE_FLUSH_EVERY != 0:
                return
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    torch.mps.empty_cache()
            except Exception:
                pass

        # mix_<id> scratch WAVs written for silence/cached-fail/error slots are
        # pure assembly inputs (no preview/regen contract), so they're deleted
        # once the final track is written.
        _mix_temp_paths: list[str] = []

        def _store_mix_wav(start: float, end: float, wav: torch.Tensor, sr: int, seg_key: str):
            """Write one segment to disk and keep only its path in the mix manifest.

            A zero/negative-length buffer is never written (``atomic_save_wav``
            raises on empty audio); instead a harmless zero-length in-memory
            entry is returned, which the assembly tolerates via its ``e > s``
            guard.
            """
            if wav.shape[-1] <= 0:
                return (start, end, torch.zeros(1, 0), sr)
            path = dub_seg_path(job_id, seg_key)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            atomic_save_wav(path, wav.detach().cpu(), sr)
            if seg_key.startswith("mix_"):
                _mix_temp_paths.append(path)
            _release_audio_tensors(wav)
            return (start, end, path, sr)

        def _entry_num_samples(entry) -> int:
            # Zero/negative-duration slots are kept as in-memory tensors (never
            # written to disk); report their length directly.
            if isinstance(entry[2], torch.Tensor):
                return int(entry[2].shape[-1])
            try:
                info = torchaudio.info(entry[2])
                return int(info.num_frames)
            except Exception:
                wav, _sr = torchaudio.load(entry[2])
                n = int(wav.shape[-1])
                _release_audio_tensors(wav)
                return n

        def _load_entry_wav(entry, target_sr: int) -> torch.Tensor:
            if isinstance(entry[2], torch.Tensor):
                return entry[2]
            wav, loaded_sr = torchaudio.load(entry[2])
            if loaded_sr != target_sr:
                import torchaudio.functional as AF
                wav = AF.resample(wav, loaded_sr, target_sr)
            return wav

        def _write_memmap_wav_atomic(target_path: str, samples, sample_rate: int) -> None:
            """Write a mono float32 memmap to int16 WAV without loading it all.

            Intentionally does NOT watermark: the final track is assembled from
            per-segment WAVs that were already watermarked once at synthesis
            time (see the seg-write path below), exactly as ``main`` does.
            Re-marking here would double-mark every segment in the final mix.
            """
            import tempfile
            import wave
            import numpy as np

            target_dir = os.path.dirname(target_path) or "."
            target_base = os.path.basename(target_path)
            fd, tmp_path = tempfile.mkstemp(
                prefix=f".{target_base}.",
                suffix=".wav",
                dir=target_dir,
            )
            os.close(fd)
            chunk_samples = max(sample_rate * 30, 1)
            try:
                with wave.open(tmp_path, "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(sample_rate)
                    total_len = int(samples.shape[0])
                    for off in range(0, total_len, chunk_samples):
                        chunk = np.array(samples[off: off + chunk_samples], dtype=np.float32, copy=True)
                        if chunk.size == 0:
                            continue
                        np.nan_to_num(chunk, copy=False, nan=0.0, posinf=1.0, neginf=-1.0)
                        chunk = np.clip(chunk, -1.0, 1.0)
                        pcm = (chunk * 32767.0).astype("<i2", copy=False)
                        wf.writeframes(pcm.tobytes())
                os.replace(tmp_path, target_path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise

        # Phase 4.1 — partial regen. If `regen_only` is set, we only run TTS
        # on segments whose id is in that set; the others reuse their existing
        # `seg_i.wav` on disk and slot into the final mix unchanged.
        regen_only = set(req.regen_only or []) if req.regen_only is not None else None
        seg_ids = req.segment_ids or []
        strategy = (req.timing_strategy or "concise").lower()
        # Voice-identity mode (see DubRequest.voice_match). The memo makes the
        # "consistent" pick once per speaker and hands the SAME reference to
        # every segment of that speaker for the whole run.
        voice_match = (req.voice_match or "per_line").lower()
        # Per-segment references are keyed by segment id, and any re-cut of the
        # transcript renames every line - after which each line silently falls back
        # to the pooled per-speaker clone and the whole dub is delivered in one
        # tone. Checked here, at the point of use, rather than trusted from prepare
        # time. Measured on a real job: 0 of 72 lines had a reference of their own
        # and nothing in the log said so.
        # A speaker with no voice of their own is rendered in the engine's stock voice -
        # a stranger reading their lines. Jobs transcribed before the last-resort path
        # existed carry exactly that, so heal it here rather than making the user
        # re-transcribe. Runs whatever the voice-match mode is: it is about having a
        # voice at all, not about which reference a line picks.
        try:
            from services.speaker_clone import (
                clone_audit,
                clone_audit_message,
                ensure_speaker_clones,
            )
            _sh = ensure_speaker_clones(
                job, _safe_job_dir(job_id), vocals_path=job.get("vocals_path"))
            if _sh.get("built"):
                logger.warning(
                    "speaker voices: built a missing voice for %s at render time; "
                    "this job predates that repair", ", ".join(_sh["built"]))
                try:
                    from services.speaker_clone import build_cast_sources
                    job["cast_sources"] = build_cast_sources(
                        job.get("segments") or [], job.get("speaker_clones") or {},
                        job.get("segment_clones") or {})
                except Exception:  # noqa: BLE001 - the cast row is cosmetic
                    pass
                _save_job(job_id, job)
            logger.info("%s", clone_audit_message(
                clone_audit(job.get("segments") or [], job.get("speaker_clones") or {})))
        except Exception as _e:  # noqa: BLE001 - never fail a render for this
            logger.warning("speaker voice repair skipped: %s", _e)
        if voice_match != "consistent":
            try:
                from services.speaker_clone import (
                    ensure_segment_refs,
                    segref_report,
                )
                _sr = ensure_segment_refs(
                    job, _safe_job_dir(job_id), seg_ids=seg_ids,
                    vocals_path=job.get("vocals_path"))
                logger.info("%s", segref_report(_sr))
                if _sr.get("rebuilt"):
                    _save_job(job_id, job)
            except Exception as _e:  # noqa: BLE001 - never fail a render for this
                logger.warning("segment refs: check skipped: %s", _e)
        _consistent_ref_memo: dict = {}
        remote_audio: dict[int, str] = {}
        # Strategy-transition guard: smart_fit re-mixes the *natural-rate*
        # per-segment WAVs from disk. If the previous run used strict_slot,
        # the on-disk WAVs are slot-squeezed ("slotted") — reusing them would
        # double-compress. Force one full regen; afterwards seg_wav_kind is
        # "natural" and partial regen / fit-only re-mix (regen_only=[]) work.
        # Jobs predating this field have unknown kind → also regen once.
        # P1.3: the kind is per-track now (each language renders under its own
        # strategy); the flat job["seg_wav_kind"] is only consulted for jobs
        # written before the per-language map existed — once the map is
        # present, a language without an entry has unknown-kind WAVs (or none
        # at all) and must regen once, exactly like the pre-field case.
        _kind_map = job.get("seg_wav_kind_by_lang")
        _wav_kind = (
            _kind_map.get(lang_code) if isinstance(_kind_map, dict) else job.get("seg_wav_kind")
        )
        if strategy == "smart_fit" and regen_only is not None and _wav_kind != "natural":
            regen_only = None
        # Manifest: stable segment id per current index. Per-segment WAVs are
        # named by stable id (dub_seg_path) so regen reuses the right audio after
        # reorder; index-keyed readers (preview/export) resolve via this manifest.
        job["seg_order"] = [seg_ids[k] if k < len(seg_ids) else f"seg_{k}" for k in range(len(req.segments))]

        # Per-segment metadata to persist after the hot loop. Audio itself is
        # written immediately and only file paths are kept, so long videos don't
        # retain every generated tensor in RAM until final assembly.
        _pending_seg_writes: list[tuple] = []

        # Calibration records for the pre-synthesis duration planner
        # (services/duration_planner.py): text length + the NATURAL-rate TTS
        # duration of every freshly synthesized segment. Only meaningful for
        # the natural-rate strategies — strict_slot forces the audio to the
        # slot length, which would poison the observed chars-per-second.
        _natural_dur_records: dict[str, dict] = {}

        # Phase 4.1 bench instrumentation: measure where incremental time goes.
        # Only prints when regen_only is active (real-user incremental path).
        _t_start = time.perf_counter()
        _t_cache = 0.0
        _t_tts = 0.0

        # One coarse remote lease for every segment that actually needs fresh
        # synthesis. Assembly, fitting and the separately-pooled RVC pass stay
        # here; the worker returns a single verified bundle of segment WAVs.
        decision = gpu_gateway.decide("dub_segments")
        if decision.remote:
            remote_rows: list[dict] = []
            remote_refs: list[str | None] = []
            for i, seg in enumerate(req.segments):
                seg_id = seg_ids[i] if i < len(seg_ids) else f"seg_{i}"
                if (regen_only is not None and seg_id not in regen_only) or not seg.text.strip():
                    continue
                ref_audio, ref_text, ref_single_use, profile_instruct, seed = _remote_voice(
                    job, seg.profile_id or None, seg_id, voice_match, _consistent_ref_memo
                )
                ref_audio = warn_if_ref_missing(
                    ref_audio, job_id=job_id, seg_id=seg_id, where="remote dub render"
                )
                seg_instruct = seg.instruct or req.instruct or profile_instruct
                seg_speed = seg.speed if seg.speed is not None else req.speed
                if seg.direction and seg.direction.strip():
                    try:
                        from services.director import parse as _parse_direction
                        direction = _parse_direction(seg.direction)
                        extra = direction.instruct_prompt()
                        if extra:
                            seg_instruct = f"{seg_instruct}, {extra}" if seg_instruct else extra
                        bias = direction.rate_bias()
                        if bias and abs(bias - 1.0) > 0.01 and strategy == "strict_slot":
                            seg_speed = (seg_speed or 1.0) * bias
                    except Exception:
                        logger.debug("direction parse skipped for remote segment %s", seg_id,
                                     exc_info=True)
                remote_rows.append({
                    "index": i, "text": seg.text,
                    "language": seg.target_lang or req.language,
                    "ref_text": ref_text, "ref_single_use": ref_single_use,
                    "instruct": seg_instruct,
                    "duration": (seg.end - seg.start) if strategy == "strict_slot" else None,
                    "num_step": 8 if req.preview else req.num_step,
                    "guidance_scale": req.guidance_scale, "speed": seg_speed,
                    "effect_preset": seg.effect_preset or "broadcast",
                    "seed": seed,
                    # RVC changes the waveform locally after TTS, so that path
                    # is marked at the existing post-RVC chokepoint below.
                    "watermark": not rvc_is_enabled(),
                })
                remote_refs.append(ref_audio)
            if remote_rows:
                states: asyncio.Queue = asyncio.Queue()
                call = gpu_gateway.RemoteCall(
                    engine=active_backend_id(), operation="dub_segments",
                    params={"segments": remote_rows, "ref_audio": remote_refs},
                    decode=_decode_remote_dub,
                )
                dub_run = gpu_gateway.JobRun("dub_segments")
                run = asyncio.create_task(gpu_gateway.run(
                    "dub_segments", local=gpu_gateway.LocalCall(fn=lambda: {}),
                    remote=call, decision=decision, job=dub_run,
                    on_state=states.put_nowait,
                ))
                while not run.done():
                    if task_manager.is_cancelled(task_id):
                        run.cancel()
                        try:
                            await run
                        except asyncio.CancelledError:
                            pass
                        yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': 0})}\n\n"
                        return
                    try:
                        state = await asyncio.wait_for(states.get(), timeout=0.25)
                    except asyncio.TimeoutError:
                        continue
                    fraction = float(state.get("progress") or 0.0)
                    yield f"data: {json.dumps({'type': 'progress', 'current': round(fraction * total, 2), 'total': total, 'text': state.get('stage') or state.get('phase')})}\n\n"
                remote_audio = await run
                notice = dub_run.notice()
                if notice is not None:
                    yield f"data: {json.dumps({'type': 'routing_notice', 'status': notice[0], 'reason': notice[1]})}\n\n"

        for i, seg in enumerate(req.segments):
            seg_id = seg_ids[i] if i < len(seg_ids) else f"seg_{i}"

            # Check abort flag before each segment
            if task_manager.is_cancelled(task_id):
                yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i})}\n\n"
                return

            if not remote_audio:
                yield f"data: {json.dumps({'type': 'progress', 'current': i, 'total': total, 'text': seg.text[:50]})}\n\n"

            seg_duration = seg.end - seg.start
            if seg_duration <= 0.05 or not seg.text.strip():
                sr = backend.sample_rate
                # max(0, …): a zero/negative-duration slot must not feed a
                # negative length to torch.zeros (raises) — _store_mix_wav
                # turns the empty buffer into a harmless in-memory entry.
                silence = torch.zeros(1, max(0, int(seg_duration * sr)))
                all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, silence, sr, f"mix_{seg_id}"))
                try:
                    del silence
                except Exception:
                    pass
                _release_audio_tensors()
                sync_scores.append(1.0)
                continue

            # Partial regen: if this segment isn't in the allow-list, reuse its
            # previously-rendered WAV so the final mix still covers the timeline.
            if regen_only is not None and seg_id not in regen_only:
                # This track's own cache first (seg_{lang}_{id}.wav). Legacy
                # un-keyed files (seg_{id}.wav / seg_{index}.wav) are reused
                # ONLY when no other-language track exists on the job — a
                # multi-track job's un-keyed files hold whichever language
                # rendered last, and splicing them here was exactly how
                # "Regen N changed" mixed language B into track A (P1.3).
                seg_wav_path = _seg_lang_path(seg_id)
                if not os.path.exists(seg_wav_path) and _legacy_seg_cache_ok(job, lang_code):
                    for _legacy_key in (seg_id, i):
                        _legacy = dub_seg_path(job_id, _legacy_key)
                        if os.path.exists(_legacy):
                            seg_wav_path = _legacy
                            break
                if os.path.exists(seg_wav_path):
                    try:
                        _t_cache_0 = time.perf_counter()
                        cached_wav, cached_sr = torchaudio.load(seg_wav_path)
                        if cached_sr != backend.sample_rate:
                            import torchaudio.functional as AF
                            cached_wav = AF.resample(cached_wav, cached_sr, backend.sample_rate)
                        # Pad/trim to slot — except smart_fit, whose mix
                        # loop needs the natural-rate length to compute the
                        # audio/video split (the seg_wav_kind guard above
                        # guarantees these cached WAVs are natural-rate).
                        if strategy == "strict_slot":
                            # Cached strict_slot WAVs are tail-trimmed now
                            # (see the generation loop). Padding them back to
                            # slot length would restore exactly the dead air
                            # the mix loop's underrun fill exists to remove,
                            # so a partial regen would silently undo the fix
                            # for every segment it reused.
                            target_samples = int(seg_duration * backend.sample_rate)
                            if cached_wav.shape[-1] > target_samples:
                                cached_wav = cached_wav[..., :target_samples]
                        elif strategy != "smart_fit":
                            target_samples = int(seg_duration * backend.sample_rate)
                            current_samples = cached_wav.shape[-1]
                            if target_samples > current_samples:
                                cached_wav = torch.nn.functional.pad(cached_wav, (0, target_samples - current_samples))
                            elif current_samples > target_samples:
                                cached_wav = cached_wav[..., :target_samples]
                        all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, cached_wav, backend.sample_rate, f"mix_{seg_id}"))
                        try:
                            del cached_wav
                        except Exception:
                            pass
                        _release_audio_tensors()
                        sync_scores.append(getattr(seg, 'sync_ratio', None) or 1.0)
                        _t_cache += time.perf_counter() - _t_cache_0
                        continue
                    except Exception as e:
                        # Fall through to a silent placeholder if the cached WAV
                        # is broken — cleaner than aborting the whole mix.
                        yield f"data: {json.dumps({'type': 'warning', 'segment': i, 'message': f'cached seg lost, padding silence: {str(e)[:120]}'})}\n\n"
                sr = backend.sample_rate
                silence = torch.zeros(1, max(0, int(seg_duration * sr)))
                all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, silence, sr, f"mix_{seg_id}"))
                try:
                    del silence
                except Exception:
                    pass
                _release_audio_tensors()
                sync_scores.append(1.0)
                continue

            def _gen(text, lang, instruct_str, dur_s, nstep, cfg, spd, profile_id, effect_preset,
                     *, execution_target="local", force_speaker_ref=False):
                # Normalize once at the segment's text→engine choke point
                # (covers the OOM-retry generate below too, which reuses this
                # closure's `text`). Pref-gated, idempotent, never raises.
                from services.text_normalization import normalize_for_tts
                text = normalize_for_tts(text, lang)

                ref_audio = None
                ref_text = None
                used_seed = None
                # Per-segment refs are a distinct file per segment, each used
                # exactly once in this render — telling the prompt cache to
                # store them would evict the per-speaker / locked-profile
                # prompts that every OTHER segment reuses (LRU of 8 vs
                # potentially hundreds of segment clips). cache_ref=False =
                # "encode it, don't let it displace anything".
                ref_single_use = False

                # Auto-clones extracted from the source video during prepare
                # (see services/speaker_clone.py) live at job["speaker_clones"]
                # keyed by speaker_id. We use the `auto:` prefix so they can't
                # collide with persistent voice_profiles.id values.
                # Wave 3.2: a per-segment clone ref (cut from this line's own
                # source audio) takes precedence over the per-speaker clone.
                if profile_id and profile_id.startswith("auto-seg:"):
                    sid = profile_id[len("auto-seg:"):]
                    info = (job.get("segment_clones") or {}).get(sid)
                    # voice_match="consistent": an auto-seg binding to the
                    # segment's OWN id is the server default from prepare —
                    # heuristic diarization skips speaker-clone extraction, so
                    # every long line gets `auto-seg:{its own id}` (see
                    # dub_core's assignment loop). That's not a user choice
                    # (the Voice dropdown can't even render auto-seg ids), so
                    # swap it for the speaker's ONE consistent reference. A
                    # CROSS binding (sid != this segment) can only come from an
                    # explicit request — honour its clip unchanged.
                    _consistent_alt = None
                    if voice_match == "consistent" and sid == str(seg_id):
                        _spk_key = _speaker_key_for_segment(job, sid)
                        if _spk_key:
                            _consistent_alt = resolve_consistent_ref(
                                job, _spk_key, _consistent_ref_memo
                            )
                    if _consistent_alt:
                        ref_audio = _consistent_alt.get("ref_audio")
                        ref_text = _consistent_alt.get("ref_text")
                        # Shared by every segment of the speaker → multi-use;
                        # keep it warm in the prompt cache (#1132 semantics).
                    elif info:
                        ref_audio = info.get("ref_audio")
                        ref_text = info.get("ref_text")
                        ref_single_use = True
                    profile_id = None  # prevent the voice_profiles lookup below

                elif profile_id and profile_id.startswith("auto:"):
                    key = profile_id[len("auto:"):]
                    if voice_match == "consistent":
                        # ONE reference per speaker for the whole dub: the
                        # pooled per-speaker clone, else the deterministic
                        # segment-clip pick (heuristic-diarized jobs have no
                        # speaker_clones at all — the key case). Multi-use by
                        # construction → ref_single_use stays False so the
                        # prompt cache keeps it warm across segments (#1132).
                        auto = resolve_consistent_ref(job, key, _consistent_ref_memo)
                        if auto:
                            ref_audio = auto.get("ref_audio")
                            ref_text = auto.get("ref_text")
                    else:
                        # per_line (DEFAULT) — #486: an `auto:{speaker}`
                        # binding still prefers THIS segment's own per-segment
                        # ref when one exists (cut from this line's source
                        # audio → matches its prosody), falling back to the
                        # per-speaker clone otherwise. This keeps the Wave 3.2
                        # per-segment-ref quality win while letting every
                        # segment carry the UI-visible `auto:` id the dub
                        # editor's Voice dropdown can actually render ("From
                        # Video → Speaker N"). `seg_id` is closed over from
                        # the per-segment loop below.
                        segment_speaker_key = _speaker_key_for_segment(job, seg_id)
                        # Legacy jobs may not persist diarized segment rows.
                        # Preserve their established per-line preference; only
                        # suppress it when current metadata proves the user
                        # explicitly selected a different speaker.
                        selected_is_segment_speaker = (
                            segment_speaker_key is None or segment_speaker_key == key
                        )
                        seg_ref = (
                            (job.get("segment_clones") or {}).get(str(seg_id))
                            if selected_is_segment_speaker
                            else None
                        )
                        if seg_ref:
                            ref_audio = seg_ref.get("ref_audio")
                            ref_text = seg_ref.get("ref_text")
                            ref_single_use = True
                        else:
                            auto = _find_speaker_clone(
                                job.get("speaker_clones") or {}, key
                            )
                            if auto is None:
                                # Short lines may have no line-specific clip.
                                # Reuse this speaker's best source instead of
                                # silently reverting to the engine default.
                                auto = resolve_consistent_ref(
                                    job, key, _consistent_ref_memo
                                )
                            if auto:
                                ref_audio = auto.get("ref_audio")
                                ref_text = auto.get("ref_text")
                    profile_id = None  # prevent the voice_profiles lookup below

                if profile_id:
                    with db_conn() as conn:
                        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
                    if row:
                        if row["is_locked"] and row["locked_audio_path"]:
                            ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                            ref_text = row["ref_text"]
                            used_seed = row["seed"]
                        elif row["instruct"] and not row["is_locked"]:
                            used_seed = row["seed"] 
                        else:
                            ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                            ref_text = row["ref_text"]
                            used_seed = row["seed"]
                            
                        if not instruct_str:
                            try:
                                _vd = row["vd_states"]
                            except (KeyError, IndexError):
                                _vd = None
                            instruct_str = heal_design_instruct(row["instruct"], _vd)

                if used_seed is not None:
                    torch.manual_seed(used_seed)

                # Last gate before the engine: every resolution branch above
                # produces a PATH, and none of them can know it still exists.
                # A retake from DIFFERENT conditioning. The wrong-language leak comes
                # from the engine failing to trim the reference it was conditioned on,
                # so re-rolling the same reference re-rolls the same risk. This swaps
                # the line's own clip for the speaker's pooled one.
                if force_speaker_ref:
                    try:
                        _alt_key = _speaker_key_for_segment(job, seg_id)
                        _alt = (resolve_consistent_ref(job, _alt_key,
                                                       _consistent_ref_memo)
                                if _alt_key else None)
                        if not (_alt or {}).get("ref_audio"):
                            _alt = _find_speaker_clone(
                                job.get("speaker_clones") or {}, _alt_key or "")
                        if (_alt or {}).get("ref_audio"):
                            ref_audio = _alt.get("ref_audio")
                            ref_text = _alt.get("ref_text")
                            ref_single_use = False
                    except Exception as _e:  # noqa: BLE001
                        logger.debug("dub: speaker-ref retake could not resolve a "
                                     "reference for %s: %s", seg_id, _e)

                ref_audio = warn_if_ref_missing(
                    ref_audio, job_id=job_id, seg_id=seg_id, where="dub render",
                )

                try:
                    audio_out = backend.generate(
                        text=text, language=lang if lang != "Auto" else None,
                        ref_audio=ref_audio, ref_text=ref_text,
                        cache_ref=not ref_single_use,
                        instruct=instruct_str if instruct_str else None,
                        duration=dur_s, num_step=nstep, guidance_scale=cfg,
                        speed=spd, denoise=True, postprocess_output=True,
                    )
                    sr = backend.sample_rate

                    # Apply per-segment DSP effect preset (default: broadcast)
                    seg_effect_preset = effect_preset or "broadcast"
                    if seg_effect_preset == "raw":
                        return audio_out

                    mastered_audio = audio_out
                    if not getattr(backend, "applies_own_mastering", False):
                        mastered_audio = apply_mastering(audio_out, sample_rate=sr)
                    effect_chain = get_effect_chain(seg_effect_preset)
                    if effect_chain:
                        mastered_audio = apply_effects_chain(
                            mastered_audio,
                            sample_rate=sr,
                            chain=effect_chain,
                        )
                    return normalize_audio(mastered_audio, target_dBFS=-2.0)
                except Exception as e:
                    if not _prepare_oom_retry(e, execution_target=execution_target):
                        raise

                    retry_steps = min(nstep, 8)
                    logger.warning(
                        "OOM on segment (nstep=%d), retrying with %d steps after cache flush",
                        nstep, retry_steps,
                    )
                    try:
                        # An OOM retry on a single-use ref pays the reference
                        # encode a second time (~0.4s) — deliberate: caching it
                        # would reintroduce the eviction this flag exists to
                        # prevent, to optimize a path that only runs after an
                        # OOM already cost seconds.
                        audio_out = backend.generate(
                            text=text, language=lang if lang != "Auto" else None,
                            ref_audio=ref_audio, ref_text=ref_text,
                            cache_ref=not ref_single_use,
                            instruct=instruct_str if instruct_str else None,
                            duration=dur_s, num_step=retry_steps, guidance_scale=cfg,
                            speed=spd, denoise=True, postprocess_output=True,
                        )
                        sr = backend.sample_rate

                        seg_effect_preset = effect_preset or "broadcast"
                        if seg_effect_preset == "raw":
                            return audio_out

                        mastered_audio = audio_out
                        if not getattr(backend, "applies_own_mastering", False):
                            mastered_audio = apply_mastering(audio_out, sample_rate=sr)
                        effect_chain = get_effect_chain(seg_effect_preset)
                        if effect_chain:
                            mastered_audio = apply_effects_chain(
                                mastered_audio,
                                sample_rate=sr,
                                chain=effect_chain,
                            )
                        return normalize_audio(mastered_audio, target_dBFS=-2.0)
                    except Exception as retry_err:
                        raise RuntimeError(
                            f"Ran out of GPU memory generating this segment. "
                            f"Retried with {retry_steps} steps but still failed. "
                            f"Try the Flush button in the header to free VRAM, "
                            f"or switch to CPU in Settings. "
                            f"Underlying error: {retry_err}"
                        ) from retry_err

            seg_profile = seg.profile_id or None
            seg_speed = seg.speed if hasattr(seg, 'speed') and seg.speed is not None else req.speed
            seg_lang = seg.target_lang if getattr(seg, 'target_lang', None) else req.language

            seg_instruct = seg.instruct or req.instruct
            # Phase 4.2 — if the segment carries a free-form direction, parse it
            # and append the taxonomy instruct (e.g. "urgent, surprised") on top
            # of whatever instruct was already set. Also apply the director's
            # speed bias so "urgent" actually sounds a bit quicker.
            seg_direction = getattr(seg, 'direction', None)
            if seg_direction and seg_direction.strip():
                try:
                    from services.director import parse as _parse_direction
                    d = _parse_direction(seg_direction)
                    extra_instruct = d.instruct_prompt()
                    if extra_instruct:
                        seg_instruct = (
                            f"{seg_instruct}, {extra_instruct}" if seg_instruct else extra_instruct
                        )
                    bias = d.rate_bias()
                    if bias and abs(bias - 1.0) > 0.01:
                        # Speed-bias from a Direction only multiplies seg_speed
                        # in strict_slot mode, which is the legacy path that
                        # compresses audio at synthesis time to fit the slot.
                        # In concise / stretch_video modes we preserve natural
                        # rate so the user gets the "urgent" or "slow" voice
                        # the director asked for without the chipmunk side-
                        # effect that overshooting the slot would otherwise
                        # cause.
                        if (req.timing_strategy or "concise") == "strict_slot":
                            seg_speed = (seg_speed or 1.0) * bias
                except Exception as e:
                    logger.debug("direction parse skipped for %s: %s", getattr(seg, 'id', '?'), e)

            loop = asyncio.get_running_loop()
            try:
                # Fast-preview mode for interactive edits — trade ~10–20 %
                # quality for ~2× speed by dropping flow-matching steps.
                # Client sends `preview=true` when the user is iterating;
                # before final export the client should re-call without the
                # flag to restore num_step=req.num_step quality.
                # Floor the step count; see DUB_MIN_STEPS.
                _num_step = (8 if req.preview
                             else max(int(req.num_step or DUB_MIN_STEPS),
                                      DUB_MIN_STEPS))
                _t_tts_0 = time.perf_counter()
                seg_effect_preset = getattr(seg, "effect_preset", None) or "broadcast"

                # In concise / stretch_video / smart_fit modes we pass
                # dur_s=None so the TTS model speaks at its natural rate for
                # this text length — the whole point of the new timing
                # strategies is to never squeeze the speech to fit at
                # synthesis time. strict_slot keeps the legacy behaviour
                # where dur_s is the slot hint.
                _dur_for_tts = seg_duration if strategy == "strict_slot" else None

                # Bounded + pool-reset on hang so a wedged dub segment can't
                # starve the GPU pool and brick the backend (#730 class).
                # Budget from the shared length-scaled helper (#1190): a long
                # dub segment used to die on the flat 300s even after v0.3.22.
                from services.model_manager import generate_timeout_s
                if i in remote_audio:
                    audio_tensor, remote_sr = torchaudio.load(remote_audio[i])
                    try:
                        os.unlink(remote_audio[i])
                    except OSError:
                        pass
                    if remote_sr != backend.sample_rate:
                        import torchaudio.functional as AF
                        audio_tensor = AF.resample(audio_tensor, remote_sr, backend.sample_rate)
                else:
                    audio_tensor = await run_on_gpu_pool_guarded(
                        lambda: _gen(
                            seg.text, seg_lang, seg_instruct, _dur_for_tts,
                            _num_step, req.guidance_scale, seg_speed, seg_profile, seg_effect_preset,
                        ),
                        what="Dub generate",
                        timeout=generate_timeout_s(seg.text),
                    )
                _t_tts += time.perf_counter() - _t_tts_0

                # A cloned line sometimes speaks before its own first word. The model is
                # conditioned on the reference audio AND its transcript, generates both as
                # one stream, and trims the reference by estimated length - when that trim
                # lands early, the tail of the reference transcript (Hindi, in a Hindi to
                # Telugu dub) is still at the front. Measured on job xs25qh86: line c001's
                # own Telugu text started 2.52s into a 9.59s piece at alignment confidence
                # 0.965, and 13 of 27 lines started more than 0.5s late - 15.8s in total.
                # Nothing else could see it: right length, right loudness, text 100% Telugu.
                # Aligning the piece against its own text says where the first word is; what
                # precedes it is not that word. Offline on those pieces this removed 14.3s
                # across 12 lines, every one landing on the pre-roll, and reverted the one
                # line whose alignment was unstable.
                # Source-language audio in the dub. Measured on job xs25qh86: of five
                # reported bad lines, two opened with a Hindi lead (2.46s, 2.72s) and TWO
                # WERE HINDI FROM START TO FINISH - so a trim alone can never fix it, and
                # the detector cannot be forced alignment. The aligner scored a 100%
                # Devanagari head at 0.936 against the Telugu text, its best score of any
                # cut point, because it lays a monotonic path over whatever it is handed
                # and Hindi and Telugu romanise alike. The recogniser read 94-100% source
                # script on exactly the bad lines and 0% on the clean ones, and its chunks
                # carry timestamps, so one call gives the language and the boundary.
                try:
                    from services import head_language as _HL
                    if _HL.ENABLED and audio_tensor is not None:
                        if _hl_budget < 0:
                            _hl_budget = max(4, int(round(
                                total * _HL.JOB_RERENDER_FRACTION)))
                        _hl_sr = backend.sample_rate
                        _src_lang = ""
                        try:
                            if isinstance(job, dict):
                                _src_lang = (job.get("source_lang")
                                             or job.get("source_language") or "")
                        except Exception:  # noqa: BLE001
                            _src_lang = ""
                        if not _src_lang:
                            _src_lang = getattr(req, "source_lang", "") or ""
                        _tgt_lang = (req.language_code or "")
                        # The content test needs both texts: what this line is SUPPOSED
                        # to say, and what the source line said. A leaked head says the
                        # latter, which is how it is told apart from the target language
                        # even when the recogniser transliterates it.
                        _hl_tgt_text = (getattr(seg, "text", "") or "")
                        _hl_src_text = ""
                        try:
                            for _js in (job.get("segments") or []):
                                if str(_js.get("id")) == str(seg_id):
                                    _hl_src_text = _js.get("text_original") or ""
                                    break
                        except Exception:  # noqa: BLE001
                            _hl_src_text = ""
                        # What the engine is actually conditioned on. A widened reference absorbs
                        # neighbouring lines, so its transcript is a superset of this line's own
                        # source text - and the leak speaks THAT, which is why comparing only
                        # against text_original missed c018 (0.19) and c029 (0.39) while ref_text
                        # scores them 0.97 and 1.00.
                        _hl_ref_text = ""
                        try:
                            _sc = (job.get("segment_clones") or {}).get(str(seg_id))
                            if isinstance(_sc, dict) and _sc.get("ref_text"):
                                _hl_ref_text = _sc.get("ref_text") or ""
                            if not _hl_ref_text:
                                _pid = str(getattr(seg, "profile_id", "") or "")
                                _key = (_pid[len("auto:"):] if _pid.startswith("auto:")
                                        else str(getattr(seg, "speaker_id", "") or ""))
                                _spk = job.get("speaker_clones") or {}
                                _alt = _spk.get(_key) or _spk.get("auto:" + _key)
                                if isinstance(_alt, dict):
                                    _hl_ref_text = _alt.get("ref_text") or ""
                        except Exception:  # noqa: BLE001
                            _hl_ref_text = ""
                        if not _src_lang:
                            # Never fail silently: without the source language there is
                            # nothing to compare against and the whole check is a no-op.
                            logger.warning("head language: no source language on job %s - "
                                           "the wrong-language check cannot run", job_id)

                        def _hl_probe_path(_t):
                            import tempfile as _tf
                            import torchaudio as _ta
                            import torch as _th
                            _fd, _p = _tf.mkstemp(suffix=".wav", prefix="_hlprobe_")
                            os.close(_fd)
                            _x = _t
                            if not hasattr(_x, "detach"):
                                _x = _th.as_tensor(_x)
                            _x = _x.detach().cpu().float()
                            if _x.dim() == 1:
                                _x = _x.unsqueeze(0)
                            _ta.save(_p, _x, _hl_sr)
                            return _p

                        def _hl_look(_t):
                            _p = _hl_probe_path(_t)
                            try:
                                return _HL.classify_best(_p, _src_lang, _tgt_lang,
                                                    target_text=_hl_tgt_text,
                                                    source_text=_hl_src_text,
                                                    ref_text=_hl_ref_text,
                                                    seg_id=str(seg_id))
                            finally:
                                try:
                                    os.unlink(_p)
                                except OSError:
                                    pass

                        _attempt = 0
                        while _src_lang:
                            # The recogniser call is network I/O, not GPU work, so it must
                            # not hold the GPU pool and must not block the event loop -
                            # the SSE stream is what the UI reads progress from.
                            _v = await loop.run_in_executor(None, _hl_look, audio_tensor)
                            _verdict = _v.get("verdict") or _HL.UNKNOWN
                            if _verdict in (_HL.LEAD, _HL.ALL_SOURCE, _HL.BABBLE):
                                _hl_stats[_verdict] += 1
                                if (_attempt >= _HL.MAX_RERENDER
                                        or _hl_stats["rerendered"] >= _hl_budget):
                                    # Takes exhausted. Cutting is all that is left and it
                                    # DELETES WORDS: on te->en line c000 the recogniser wrote
                                    # English in TELUGU letters, the script test fired, and the
                                    # cut removed "good morning from china" - coverage of the
                                    # line's own text fell to 0.69. So cut only when the CONTENT
                                    # test was the evidence, never on script alone.
                                    _cut = float(_v.get("cut_s") or 0.0)
                                    if (_verdict == _HL.LEAD and _cut > 0
                                            and _v.get("content_evidence")):
                                        logger.warning("head language: %s still leaking after "
                                                       "%d take(s) - cutting %.2fs as a last "
                                                       "resort (%s)", seg_id, _attempt + 1,
                                                       _cut, _v.get("note"))
                                        audio_tensor = _HL.trim_tensor(audio_tensor, _hl_sr,
                                                                       _cut)
                                        _hl_stats["cut_s"] += _cut
                                    else:
                                        logger.error("head language: %s is still wrong after "
                                                     "%d take(s) (%s) - shipping it; cutting "
                                                     "was not safe enough to risk",
                                                     seg_id, _attempt + 1, _v.get("note"))
                                    break
                                _attempt += 1
                                _hl_stats["rerendered"] += 1
                                logger.warning("head language: %s take %d unusable (%s) - "
                                               "re-rendering (%d/%d of this job's budget)",
                                               seg_id, _attempt, _v.get("note"),
                                               _hl_stats["rerendered"], _hl_budget)
                                _hl_t0 = time.perf_counter()
                                _hl_force = (_attempt >= 2)
                                audio_tensor = await run_on_gpu_pool_guarded(
                                    lambda: _gen(
                                        seg.text, seg_lang, seg_instruct, _dur_for_tts,
                                        _num_step, req.guidance_scale, seg_speed,
                                        seg_profile, seg_effect_preset,
                                        force_speaker_ref=_hl_force,
                                    ),
                                    what="Dub re-render (wrong language)",
                                    timeout=generate_timeout_s(seg.text),
                                )
                                _t_tts += time.perf_counter() - _hl_t0
                                continue
                            if _verdict == _HL.OK:
                                _hl_stats["ok"] += 1
                            else:
                                _hl_stats["unknown"] += 1
                                logger.debug("head language: %s no verdict (%s)",
                                             seg_id, _v.get("note"))
                            break
                        logger.info("head language tally: %s", _hl_stats)
                except Exception as _e:  # noqa: BLE001
                    logger.warning("dub: wrong-language check skipped on %s: %s",
                                   seg_id, _e)

                # Check abort immediately after GPU work completes
                if task_manager.is_cancelled(task_id):
                    yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i + 1})}\n\n"
                    return

                # Quieten the breath the engine sometimes speaks before the
                # words. Length is unchanged, so timing is unaffected.
                audio_tensor = _suppress_hiss_burst(audio_tensor,
                                                   backend.sample_rate)
                audio_tensor = _attenuate_lead(audio_tensor, backend.sample_rate)

                # Start the line on its slot. Measured on job dq1g7fxj: every one of 31
                # lines opened with dub silence (0.06-1.15s, 7.28s in total) while the
                # ORIGINAL voice underneath sat at -6 to -26 dB, so the original is what
                # you hear at each line start. Removing near-silence cannot delete words,
                # which is why this is safe where the language trim is not. It runs after
                # the lead attenuation above, so whatever that quietens is then dropped.
                try:
                    from services import head_language as _HLS
                    _sil = _HLS.front_silence(audio_tensor, backend.sample_rate)
                    if _sil > 0:
                        audio_tensor = _HLS.trim_tensor(audio_tensor,
                                                        backend.sample_rate, _sil)
                        logger.info("start on time: %s began %.2fs late, moved onto its "
                                    "slot", seg_id, _sil)
                except Exception as _e:  # noqa: BLE001
                    logger.debug("start on time skipped for %s: %s", seg_id, _e)

                target_samples = int(seg_duration * backend.sample_rate)
                current_samples = audio_tensor.shape[-1]

                if strategy == "strict_slot":
                    # Was: pad short audio out to slot length. That froze the
                    # engine's own trailing silence into the track AND made the
                    # mix loop's underrun fill unreachable - it only runs when
                    # wl < slot_samples * UNDERRUN_TOLERANCE, which forcing
                    # wl == slot_samples makes permanently false. The result was
                    # dead air inside a slot while the on-screen mouth kept
                    # moving, which reads as "the dub is out of sync".
                    #
                    # Hand the mix loop the real speech length instead. It slows
                    # the line toward its slot with the pitch-preserving atempo
                    # pipe, floored at _underrun_min_rate(), and pads only the
                    # remainder. Over-long audio is still trimmed here exactly
                    # as before, so the too-much-text case is unchanged.
                    audio_tensor = _trim_trailing_silence(audio_tensor,
                                                          backend.sample_rate)
                    current_samples = audio_tensor.shape[-1]
                    if current_samples > target_samples:
                        audio_tensor = audio_tensor[..., :target_samples]
                # concise / stretch_video / smart_fit: keep audio at its
                # natural length. The mix loop decides per-mode whether to
                # trim, slip, stretch the video, or split audio/video
                # retiming (smart_fit) to accommodate it.

                generated_dur = audio_tensor.shape[-1] / backend.sample_rate
                sync_ratio = round(generated_dur / max(seg_duration, 0.01), 3)

                sync_scores.append(sync_ratio)

                # Duration-planner calibration sample: this text length spoke
                # for this long at natural rate. Keyed by stable seg id and
                # merged into the per-language job map after the loop.
                if strategy != "strict_slot" and seg.text.strip() and generated_dur > 0:
                    _natural_dur_records[str(seg_id)] = {
                        "chars": len(seg.text.strip()),
                        "dur": round(generated_dur, 4),
                    }

                # Build the fingerprint now (cheap) but defer the disk write
                # and job flush to the batch-write phase after the GPU loop.
                _seg_fp = None
                try:
                    # track_lang scopes the hash to THIS track (P1.3); the
                    # client-side recompute (/tools/incremental) sends the
                    # same code, so parity (#281 class) holds per language.
                    _seg_fp = segment_fingerprint({
                        "text": seg.text,
                        "target_lang": getattr(seg, "target_lang", None),
                        "profile_id": getattr(seg, "profile_id", None),
                        "instruct": getattr(seg, "instruct", None),
                        "speed": getattr(seg, "speed", None),
                        "direction": getattr(seg, "direction", None),
                        "effect_preset": getattr(seg, "effect_preset", None),
                    }, track_lang=lang_code, voice_match=voice_match)
                except Exception as e:
                    logger.debug("seg fingerprint skipped for %s: %s", seg_id, e)

                _pending_seg_writes.append((i, backend.sample_rate, seg_id, _seg_fp, _num_step))

                # RVC needs the WAV on disk, so write it immediately only
                # when RVC is active (uncommon path).
                if rvc_is_enabled():
                    seg_wav_path = _seg_lang_path(seg_id)
                    atomic_save_wav(seg_wav_path, audio_tensor, backend.sample_rate)
                    try:
                        await loop.run_in_executor(_gpu_pool, apply_rvc, seg_wav_path)
                        rvc_wav, rvc_sr = torchaudio.load(seg_wav_path)
                        if rvc_sr == backend.sample_rate:
                            audio_tensor = rvc_wav

                            target_samples = int(seg_duration * backend.sample_rate)
                            current_samples = audio_tensor.shape[-1]
                            if target_samples > current_samples:
                                audio_tensor = torch.nn.functional.pad(audio_tensor, (0, target_samples - current_samples))
                            elif current_samples > target_samples:
                                audio_tensor = audio_tensor[..., :target_samples]
                    except Exception as e:
                        yield f"data: {json.dumps({'type': 'warning', 'segment': i, 'message': f'RVC skipped: {str(e)[:120]}'})}\n\n"

                # Watermark this FRESH TTS output exactly once, right before it
                # is persisted. The same seg_{lang}_{id}.wav is BOTH the
                # downloadable per-segment file AND the assembly input for the
                # final track, so marking it here (and nowhere else) gives the
                # downloadable WAV its mark back and the final mix inherits it —
                # no double-mark. Cached-reuse audio is already marked;
                # silence/zero slots carry no speech to mark, so neither is
                # re-watermarked.
                if i not in remote_audio or rvc_is_enabled():
                    audio_tensor = mark_synthetic(audio_tensor, backend.sample_rate,
                                                  context="dub_generate.segment")

                seg_wav_path = _seg_lang_path(seg_id)
                try:
                    # Keep the existing per-segment WAV contract for previews
                    # and partial regeneration, but do not keep the tensor in RAM.
                    atomic_save_wav(seg_wav_path, audio_tensor, backend.sample_rate)
                except Exception as e:
                    logger.warning("seg write failed for %s: %s", seg_id, e)
                    # If the durable segment write fails, still preserve a mix
                    # copy so this generation can finish.
                    all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, audio_tensor, backend.sample_rate, f"mix_{seg_id}"))
                    try:
                        del audio_tensor
                    except Exception:
                        pass
                    _release_audio_tensors()
                else:
                    all_segment_wavs.append((seg.start, seg.end, seg_wav_path, backend.sample_rate))
                    try:
                        del audio_tensor
                    except Exception:
                        pass
                    _release_audio_tensors()
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'segment': i, 'error': str(e)})}\n\n"
                sr = backend.sample_rate
                all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, torch.zeros(1, max(0, int(seg_duration * sr))), sr, f"mix_{seg_id}"))
                sync_scores.append(1.0)

        _t_loop_end = time.perf_counter()

        yield f"data: {json.dumps({'type': 'assembling'})}\n\n"

        # ── Batch metadata phase ──────────────────────────────────────
        # Per-segment WAVs were written during the loop to keep RAM bounded.
        # Flush only lightweight fingerprints/quality metadata here.
        _t_diskw_0 = time.perf_counter()
        # P1.3 — fingerprints live per language so each track's staleness is
        # judged against ITS OWN last generate. The flat job["seg_hashes"] is
        # kept as a mirror of the CURRENT track's map: every existing consumer
        # (the `done` event, dub-history restore, older frontends) already
        # treats it as "the hashes of the language generated last", which is
        # exactly what it now provably contains.
        hashes = _seg_hashes_by_lang(job).setdefault(lang_code, {})
        quality_map = job.setdefault("seg_num_step", {})
        for (_si, _sr, _sid, _fp, _nstep) in _pending_seg_writes:
            if _fp is not None:
                hashes[_sid] = _fp
            quality_map[_sid] = _nstep
        job["seg_hashes"] = dict(hashes)
        # Duration-planner calibration: per-language (chars, natural dur)
        # records. update() (not replace) so partial regens keep accumulating
        # samples from earlier runs of this track.
        if _natural_dur_records:
            job.setdefault("seg_natural_durs_by_lang", {}).setdefault(
                lang_code, {},
            ).update(_natural_dur_records)
        # Single job flush instead of one per 8 segments.
        _save_job(job_id, job)
        _t_diskw = time.perf_counter() - _t_diskw_0

        sr = backend.sample_rate
        slot_fit = (req.slot_fit or "time_stretch").lower()
        overflow_budget_s = max(0.0, float(req.overflow_budget_s or 0.0))

        # Per-segment fit_status emitted alongside the legacy sync_scores so
        # the UI can replace the lying "Sync: 100%" badge with a truthful
        # "Fits / Overflows +0.4s / Slipped 0.2s / Video stretched 1.18×".
        fit_status: list[dict] = []

        # Mode B layout: when stretch_video is on, compute a new timeline
        # where each segment's slot equals the natural-rate dub audio length;
        # gaps stay at 1.0×. Persisted on the job so dub_export.py can build
        # the matching per-segment setpts filter chain on the source video.
        new_layout: list[tuple[float, float]] = []
        video_stretch_plan: list[dict] = []
        fit_plan = None  # smart_fit only — services.fit_planner.FitPlan
        orig_total_dur = float(job.get("duration") or 0.0)

        if strategy == "stretch_video":
            cursor = 0.0
            for i, (orig_start, orig_end, wav_path, _) in enumerate(all_segment_wavs):
                wl_i = _entry_num_samples((orig_start, orig_end, wav_path, sr))
                natural_dur = (wl_i / sr) if wl_i > 0 else max(0.0, orig_end - orig_start)
                if i == 0:
                    # Preserve the pre-roll (silence before the first seg).
                    cursor = orig_start
                else:
                    prev_orig_end = all_segment_wavs[i - 1][1]
                    gap = max(0.0, orig_start - prev_orig_end)
                    cursor += gap
                new_start = cursor
                new_end = cursor + natural_dur
                new_layout.append((new_start, new_end))
                orig_dur = max(1e-3, orig_end - orig_start)
                video_stretch_plan.append({
                    "orig_start": round(orig_start, 4),
                    "orig_end": round(orig_end, 4),
                    "new_start": round(new_start, 4),
                    "new_end": round(new_end, 4),
                    "stretch_ratio": round(natural_dur / orig_dur, 4),
                })
                cursor = new_end
            # Preserve the trailing tail (anything after the last seg in the
            # original video) at 1.0× rate.
            if all_segment_wavs:
                last_orig_end = all_segment_wavs[-1][1]
                cursor += max(0.0, orig_total_dur - last_orig_end)
            new_total_dur = max(cursor, orig_total_dur)
            total_samples = int(new_total_dur * sr)
        elif strategy == "smart_fit":
            # Smart Fit: plan the audio-rate / video-ratio split per segment
            # from the natural-rate WAV lengths. Pure planning — the mix
            # loop below applies the audio side; the video side ships as
            # fit_plans[lang] for the (Phase B) export pipeline.
            _fo = req.fit_options
            _fit_defaults = FitParams()
            fit_params = FitParams(
                max_audio_only_rate=float(getattr(_fo, "max_audio_only_rate", None) or _fit_defaults.max_audio_only_rate),
                audio_rate_cap=float(getattr(_fo, "audio_rate_cap", None) or _fit_defaults.audio_rate_cap),
                video_slow_cap=float(getattr(_fo, "video_slow_cap", None) or _fit_defaults.video_slow_cap),
                gap_guard_s=float(_fo.gap_guard_s) if _fo is not None and _fo.gap_guard_s is not None else _fit_defaults.gap_guard_s,
                allow_video_retime=bool(_fo.allow_video_retime) if _fo is not None and _fo.allow_video_retime is not None else _fit_defaults.allow_video_retime,
                min_audio_rate=_underrun_min_rate(),
            )
            _seg_order = job.get("seg_order") or []
            fit_plan = plan_fit(
                [
                    {
                        "id": _seg_order[i] if i < len(_seg_order) else f"seg_{i}",
                        "start": s,
                        "end": e,
                    }
                    for i, (s, e, _path, _) in enumerate(all_segment_wavs)
                ],
                [_entry_num_samples(entry) / sr for entry in all_segment_wavs],
                orig_total_dur,
                fit_params,
            )
            total_samples = int(fit_plan.total_duration * sr)
        else:
            total_samples = int(orig_total_dur * sr)

        # smart_fit: cue times for the fitted timeline, computed from the
        # ACTUAL stretched/trimmed sample positions in the mix loop below —
        # not from the plan — so subtitles land exactly on the audio.
        fitted_cues: list[dict] = []

        track_path = os.path.join(DUB_DIR, job_id, f"dubbed_{lang_code}.wav")
        os.makedirs(os.path.dirname(track_path), exist_ok=True)

        import gc
        import tempfile
        import numpy as np

        mix_samples = max(total_samples, 1)
        fd, mix_path = tempfile.mkstemp(
            prefix=f".{os.path.basename(track_path)}.mix.",
            suffix=".f32",
            dir=os.path.dirname(track_path),
        )
        os.close(fd)
        try:
            with open(mix_path, "r+b") as mix_file:
                mix_file.truncate(mix_samples * 4)
            mix_audio = np.memmap(mix_path, dtype=np.float32, mode="r+", shape=(mix_samples,))

            for i, (start, end, wav_path, _) in enumerate(all_segment_wavs):
                seg_ref = req.segments[i] if i < len(req.segments) else None
                seg_gain = getattr(seg_ref, "gain", None) if seg_ref is not None else None
                seg_gain = seg_gain if seg_gain is not None else 1.0
                seg_gain = max(0.0, min(2.0, seg_gain))
                wav = _load_entry_wav((start, end, wav_path, sr), sr)
                adjusted = wav * seg_gain
                if adjusted.ndim == 2 and adjusted.shape[0] > 1:
                    adjusted = adjusted.mean(dim=0, keepdim=True)
                wl = adjusted.shape[-1]
                natural_dur = wl / sr if wl > 0 else 0.0
                orig_dur = max(0.0, end - start)

                if strategy == "stretch_video":
                    # Mode B: audio at natural rate, placed on the stretched
                    # timeline. No trim, no atempo. dub_export handles the video.
                    new_start, _new_end = new_layout[i]
                    place_at = new_start
                    fit_status.append({
                        "status": "video_stretched",
                        "stretch_ratio": round(natural_dur / max(orig_dur, 1e-3), 3),
                    })

                elif strategy == "smart_fit":
                    # Smart Fit: apply the planner's audio_rate via the same
                    # pitch-preserving atempo pipe strict_slot uses, place the
                    # result at the planned new_start, and hard-trim whatever
                    # the caps couldn't absorb. The video side (video_ratio per
                    # chunk) is persisted below for the export pipeline.
                    sf = fit_plan.segments[i]
                    place_at = sf.new_start
                    # Both directions: >1 compresses an overrun, <1 slows an
                    # underrun toward the slot (the "hole" fix — a dub that
                    # finishes early leaves the mouth moving over near-silence).
                    if abs(sf.audio_rate - 1.0) > 1e-6 and wl > 0:
                        target = max(1, int(round(wl / sf.audio_rate)))
                        try:
                            adjusted = await _pitch_preserving_stretch(
                                adjusted, target, sr,
                            )
                        except Exception as e:
                            logger.warning(
                                "atempo stretch failed for seg %d (%.2f×), "
                                "falling back to linear interp: %s",
                                i, sf.audio_rate, e,
                            )
                            adjusted = torch.nn.functional.interpolate(
                                adjusted.unsqueeze(0),
                                size=target,
                                mode='linear',
                                align_corners=False,
                            ).squeeze(0)
                        wl = adjusted.shape[-1]
                    # Residual overflow → hard-trim to the segment's new video
                    # slot (fade below keeps the cut pop-free).
                    new_slot_samples = int(max(0.0, sf.new_end - sf.new_start) * sr)
                    if new_slot_samples > 0 and wl > new_slot_samples:
                        adjusted = adjusted[..., :new_slot_samples]
                        wl = adjusted.shape[-1]
                    # Truthful per-segment verdict for the UI badge.
                    entry = {"status": sf.status}
                    if abs(sf.audio_rate - 1.0) > 1e-6:
                        entry["audio_rate"] = round(sf.audio_rate, 3)
                    if sf.video_ratio > 1.0 + 1e-6:
                        entry["video_ratio"] = round(sf.video_ratio, 3)
                    if sf.overflow_s > 0:
                        entry["overflow_s"] = round(sf.overflow_s, 3)
                    fit_status.append(entry)
                    # Cue times from the ACTUAL stretched sample positions.
                    fitted_cues.append({
                        "id": sf.seg_id,
                        "start": round(place_at, 4),
                        "end": round(place_at + wl / sr, 4),
                    })

                elif strategy == "concise":
                    # Mode A: never compress. Allow the audio to extend into the
                    # silent gap before the next seg (existing heuristic) plus
                    # any extra `overflow_budget_s`. Beyond that, hard-trim with
                    # a short fade so we never overlap the next speaker.
                    place_at = start
                    effective_end = end
                    if i + 1 < len(all_segment_wavs):
                        next_start = all_segment_wavs[i + 1][0]
                        gap = next_start - end
                        if gap > GAP_OVERFLOW_BUFFER_S:
                            effective_end = end + min(
                                gap - GAP_OVERFLOW_BUFFER_S, GAP_OVERFLOW_MAX_S,
                            )
                    effective_end += overflow_budget_s
                    slot_samples_eff = int(max(0.0, (effective_end - start)) * sr)
                    if slot_samples_eff > 0 and wl > slot_samples_eff:
                        overflow_s = (wl - slot_samples_eff) / sr
                        adjusted = adjusted[..., :slot_samples_eff]
                        wl = adjusted.shape[-1]
                        fit_status.append({
                            "status": "overflows",
                            "overflow_s": round(overflow_s, 3),
                        })
                    else:
                        fit_status.append({"status": "fits"})

                else:
                    # strict_slot (legacy): preserve the previous atempo / trim /
                    # off semantics so existing callers and back-compat tests
                    # keep passing.
                    place_at = start
                    effective_end = end
                    slowed_rate = None
                    if i + 1 < len(all_segment_wavs):
                        next_start = all_segment_wavs[i + 1][0]
                        gap = next_start - end
                        if gap > GAP_OVERFLOW_BUFFER_S:
                            effective_end = end + min(
                                gap - GAP_OVERFLOW_BUFFER_S, GAP_OVERFLOW_MAX_S,
                            )
                    slot_samples = int(max(0.0, (effective_end - start)) * sr)
                    if slot_fit != "off" and slot_samples > 0 and wl > slot_samples:
                        if slot_fit == "time_stretch":
                            ratio = wl / slot_samples
                            capped_ratio = min(ratio, MAX_STRETCH_RATIO)
                            capped_target = int(wl / capped_ratio)
                            try:
                                adjusted = await _pitch_preserving_stretch(
                                    adjusted, capped_target, sr,
                                )
                                if adjusted.shape[-1] > slot_samples:
                                    adjusted = adjusted[..., :slot_samples]
                                if ratio > MAX_STRETCH_RATIO:
                                    logger.info(
                                        "seg %d compression %.2f× exceeded cap; "
                                        "stretched to %.2f×, tail trimmed",
                                        i, ratio, capped_ratio,
                                    )
                            except Exception as e:
                                logger.warning(
                                    "atempo stretch failed for seg %d (%.2f×), "
                                    "falling back to linear interp: %s",
                                    i, ratio, e,
                                )
                                adjusted = torch.nn.functional.interpolate(
                                    adjusted.unsqueeze(0),
                                    size=slot_samples,
                                    mode='linear',
                                    align_corners=False,
                                ).squeeze(0)
                        else:  # "trim"
                            adjusted = adjusted[..., :slot_samples]
                        wl = adjusted.shape[-1]
                    elif (
                        slot_fit == "time_stretch"
                        and slot_samples > 0
                        and wl > 0
                        and wl < slot_samples * UNDERRUN_TOLERANCE
                        and _underrun_min_rate() < 1.0 - 1e-6
                    ):
                        # Underrun fill (mirror of the compression above): the
                        # dub finished early, leaving the on-screen mouth moving
                        # over the thin under-speech bed residue — perceived as
                        # dead air. Slow toward the slot, never below the floor.
                        rate = max(wl / slot_samples, _underrun_min_rate())
                        target = min(slot_samples, int(round(wl / rate)))
                        try:
                            adjusted = await _pitch_preserving_stretch(
                                adjusted, target, sr,
                            )
                            slowed_rate = rate
                        except Exception as e:
                            logger.warning(
                                "underrun fill failed for seg %d (%.2f×), "
                                "keeping natural rate: %s", i, rate, e,
                            )
                        wl = adjusted.shape[-1]
                    # Truthful verdict: a slowed segment says so (and by how
                    # much) instead of hiding behind "fits" — the same honesty
                    # contract the smart_fit branch keeps.
                    if slowed_rate is not None:
                        fit_status.append({
                            "status": "audio_slowed",
                            "audio_rate": round(slowed_rate, 3),
                        })
                    else:
                        fit_status.append({
                            "status": "fits",
                            "compression_applied": (slot_fit == "time_stretch"
                                                    and wl != int(natural_dur * sr)),
                        })

                # Common: short fades to avoid pops, then mix into disk-backed audio.
                fade_ms = 15
                fade_samples = int((fade_ms / 1000.0) * sr)
                if wl > fade_samples * 2:
                    ramp_up = torch.linspace(0, 1, fade_samples, device=adjusted.device)
                    ramp_down = torch.linspace(1, 0, fade_samples, device=adjusted.device)
                    adjusted[0, :fade_samples] *= ramp_up
                    adjusted[0, -fade_samples:] *= ramp_down

                s = int(place_at * sr)
                if s < 0:
                    adjusted = adjusted[..., -s:]
                    wl = adjusted.shape[-1]
                    s = 0
                e = min(s + wl, total_samples)
                if s < total_samples and e > s:
                    mix_len = e - s
                    seg_np = (
                        adjusted[:, :mix_len]
                        .detach()
                        .cpu()
                        .to(torch.float32)
                        .clamp(-1.0, 1.0)
                        .squeeze(0)
                        .numpy()
                    )
                    mix_audio[s:e] += seg_np
                try:
                    del wav, adjusted
                except Exception:
                    pass
                _release_audio_tensors()

            _t_save_0 = time.perf_counter()
            mix_audio.flush()
            _write_memmap_wav_atomic(track_path, mix_audio[:mix_samples], sr)
            _t_save = time.perf_counter() - _t_save_0
            _t_mix = _t_save_0 - _t_loop_end
        finally:
            try:
                mix_audio.flush()
                mix_mmap = getattr(mix_audio, "_mmap", None)
                if mix_mmap is not None:
                    mix_mmap.close()
            except Exception:
                pass
            try:
                del mix_audio
            except Exception:
                pass
            gc.collect()
            try:
                os.unlink(mix_path)
            except OSError:
                pass
            # The final track is written; the mix_<id> scratch WAVs (silence /
            # cached-fail / error slots) have served their only purpose as
            # assembly inputs and would otherwise leak into the job dir.
            for _mp in _mix_temp_paths:
                try:
                    os.unlink(_mp)
                except OSError:
                    pass
        # Per-track metadata. For stretch_video, the dub wav is at the new
        # (longer) timeline, so we record its actual duration here too — the
        # mux step needs this to know whether to use the original video as-is
        # or stretch it per the plan.
        track_dur = total_samples / sr if total_samples > 0 else 0.0
        job["dubbed_tracks"][lang_code] = {
            "path": track_path,
            "language": req.language,
            "language_code": lang_code,
            "duration": round(track_dur, 4),
            "timing_strategy": strategy,
        }

        # Persist the timing strategy + (for Mode B) the per-segment stretch
        # plan so dub_export can build the matching video pipeline at mux
        # time. Plans are keyed by language code because each language gets
        # its own dub track with its own natural-rate audio layout.
        job["language"] = req.language
        job["language_code"] = lang_code
        job["timing_strategy"] = strategy
        # Keep job segments in lock-step with what was just rendered so
        # subtitle export / burn-in use the translated text (#309).
        _sync_job_segments(job, req)
        if strategy == "stretch_video":
            stretch_plans = job.setdefault("video_stretch_plans", {})
            stretch_plans[lang_code] = {
                "plan": video_stretch_plan,
                "total_duration": round(track_dur, 4),
                "orig_duration": round(orig_total_dur, 4),
            }
        elif strategy == "smart_fit" and fit_plan is not None:
            # video_stretch_plans stays untouched — smart_fit persists its
            # own keyspace so a job can carry both without clobbering.
            _fit_params_payload = {
                "timing_strategy": strategy,
                "max_audio_only_rate": fit_params.max_audio_only_rate,
                "audio_rate_cap": fit_params.audio_rate_cap,
                "video_slow_cap": fit_params.video_slow_cap,
                "gap_guard_s": fit_params.gap_guard_s,
                "allow_video_retime": fit_params.allow_video_retime,
            }
            fit_fp = fit_fingerprint(_fit_params_payload)
            job.setdefault("fit_plans", {})[lang_code] = {
                # Same dict shape _build_video_stretch_filter_graph consumes.
                "plan": fit_plan.video_plan,
                # Cue times from actual stretched sample positions — for
                # subtitle export on the fitted timeline.
                "fitted_segments": fitted_cues,
                "total_duration": round(track_dur, 4),
                "orig_duration": round(orig_total_dur, 4),
                "params": _fit_params_payload,
                "fit_fp": fit_fp,
            }
            job["dubbed_tracks"][lang_code]["fit_fp"] = fit_fp
        # Record what kind of per-segment WAVs are on disk so a later
        # smart_fit run knows whether partial regen / fit-only re-mix can
        # reuse them ("natural") or must regen once ("slotted"). Per-track
        # (P1.3) — each language renders under its own strategy; the flat
        # field stays in lock-step for older readers.
        _kind = "slotted" if strategy == "strict_slot" else "natural"
        job.setdefault("seg_wav_kind_by_lang", {})[lang_code] = _kind
        job["seg_wav_kind"] = _kind
        _save_job(job_id, job)

        _t_total = time.perf_counter() - _t_start
        logger.info(
            "bench[generate] total=%.2fs tts=%.2fs cache=%.2fs diskw=%.2fs mix=%.2fs save=%.2fs segs=%d%s",
            _t_total, _t_tts, _t_cache, _t_diskw, _t_mix, _t_save, total,
            f" regen={len(regen_only)}" if regen_only is not None else "",
        )

        yield f"data: {json.dumps({'type': 'done', 'segments_processed': total, 'language_code': lang_code, 'tracks': list(job['dubbed_tracks'].keys()), 'sync_scores': sync_scores, 'fit_status': fit_status, 'timing_strategy': strategy, 'seg_hashes': job.get('seg_hashes', {}), 'seg_num_step': job.get('seg_num_step', {})})}\n\n"

    task_id = f"dub_{job_id}_{int(time.time())}"
    await task_manager.add_task(task_id, "dub_generate", _stream, task_id)
    return {"task_id": task_id}


# ── Real-time segment preview ──────────────────────────────────────────
# Stream TTS for a single segment without the full pipeline overhead.
# The frontend calls this when the user edits a segment's text/instruct
# and wants to hear the result immediately.

from pydantic import BaseModel
from typing import Optional
from fastapi.responses import Response
import io


class SegmentPreviewRequest(BaseModel):
    # Optional, and only used to label diagnostics: a preview is a "render this
    # text" call, so it has never needed segment identity. Supplying it makes a
    # missing-clone warning name the line the user was editing instead of a
    # bare "preview" (greptile).
    segment_id: Optional[str] = None
    text: str
    language: str = "Auto"
    instruct: Optional[str] = None
    profile_id: Optional[str] = None
    speed: float = 1.0
    duration: Optional[float] = None


@router.post("/dub/preview-segment/{job_id}")
async def preview_segment(job_id: str, req: SegmentPreviewRequest):
    """Generate TTS for a single segment and return WAV bytes.

    This is the fast path for interactive editing — 8 diffusion steps,
    no disk write, no mix. The preview IS synthetic audio leaving the app,
    so it carries the same invisible provenance mark as every other
    producer (#1169 — "no watermark" here used to be an exemption).
    """
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # See the /dub/generate/{job_id} resolution above (issue #312 class) —
    # a segment preview resolves ref_audio from the same auto-clone /
    # voice-profile sources, so it needs the same cloning-capable gate.
    try:
        backend = await resolve_generation_backend(require_cloning=True)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    def _gen():
        ref_audio = None
        ref_text = None

        # Resolve profile / auto-clone
        pid = req.profile_id
        if pid and pid.startswith("auto:"):
            key = pid[len("auto:"):]
            info = None
            if (
                req.segment_id is not None
                and _speaker_key_for_segment(job, req.segment_id) == key
            ):
                info = (job.get("segment_clones") or {}).get(str(req.segment_id))
            if info is None:
                info = resolve_consistent_ref(job, key)
            if info:
                ref_audio = info.get("ref_audio")
                ref_text = info.get("ref_text")
            pid = None

        instruct_str = req.instruct
        if pid:
            with db_conn() as conn:
                row = conn.execute(
                    "SELECT * FROM voice_profiles WHERE id=?", (pid,)
                ).fetchone()
            if row:
                if row["is_locked"] and row["locked_audio_path"]:
                    ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                    ref_text = row["ref_text"]
                elif row["ref_audio_path"]:
                    ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                    ref_text = row["ref_text"]
                if not instruct_str and row["instruct"]:
                    instruct_str = row["instruct"]

        ref_audio = warn_if_ref_missing(
            ref_audio, job_id=job_id,
            seg_id=req.segment_id or "preview", where="dub preview",
        )
        lang = req.language if req.language != "Auto" else None
        # Same normalization as the full dub render above, so a preview
        # sounds exactly like the final segment. Pref-gated, never raises.
        from services.text_normalization import normalize_for_tts
        audio_out = backend.generate(
            text=normalize_for_tts(req.text, lang),
            language=lang,
            ref_audio=ref_audio,
            ref_text=ref_text,
            instruct=instruct_str if instruct_str else None,
            duration=req.duration,
            num_step=8,  # fast preview
            guidance_scale=2.0,
            speed=req.speed,
            denoise=True,
            postprocess_output=True,
        )
        if not getattr(backend, "applies_own_mastering", False):
            audio_out = apply_mastering(audio_out, sample_rate=backend.sample_rate)
        audio_out = normalize_audio(audio_out, target_dBFS=-2.0)
        # Invisible provenance mark before the WAV encode (#1169); pref-gated,
        # never raises, and short-preview embedding runs in this same
        # GPU-pool job.
        return mark_synthetic(audio_out, backend.sample_rate,
                              context="dub_generate.preview_segment")

    # Bounded + pool-reset on hang so a wedged preview generate can't starve the
    # GPU pool and brick the backend (#730 class). Length-scaled budget (#1190).
    from services.model_manager import generate_timeout_s
    audio_tensor = await run_on_gpu_pool_guarded(
        _gen, what="Dub preview generate",
        timeout=generate_timeout_s(req.text),
    )

    sr = backend.sample_rate
    audio_tensor = _suppress_hiss_burst(audio_tensor, sr)
    audio_tensor = _attenuate_lead(audio_tensor, sr)
    buf = io.BytesIO()
    _safe_torchaudio_save(buf, audio_tensor, sr, format="wav")
    buf.seek(0)

    return Response(
        content=buf.read(),
        media_type="audio/wav",
        headers={
            "X-Audio-Duration": str(round(audio_tensor.shape[-1] / sr, 2)),
        },
    )
