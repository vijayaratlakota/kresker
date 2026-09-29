"""
Prosodic alignment (PA) for automatic dubbing.

Based on the standard automatic-dubbing pipeline described in the literature
(Federico et al., "From Speech-to-Speech Translation to Automatic Dubbing";
Virkar et al., "Improvements to prosodic alignment for automatic dubbing";
Chronopoulou et al., "Jointly Optimizing Translations and Speech Timing").

The key idea we were missing
----------------------------
Dubbing quality depends on ISOCHRONY: the dub must match not just the total
duration of an utterance but its internal *speech-pause arrangement*. The
reference pipeline "segments the translated text into phrases and pauses that
follow the phrase-pause arrangement of the original speech", then lets TTS adjust
the speaking rate of EACH PHRASE.

Previously we synthesized a whole utterance as one block and fitted that block to
the slot. If the original was phrase(0.8s) + pause(0.3s) + phrase(1.2s), our
continuous 2.3s blob destroyed the internal rhythm — which is what made timing
drift, left gaps, and forced heavy stretching (the robotic artefact).

This module recovers that structure:
  1. find pauses inside each source utterance (>= PAUSE_MS of low energy),
  2. give the per-phrase durations to the LLM so it can split the translation
     into the same number of phrases,
  3. synthesize each phrase and place it at its own source phrase start time,
     preserving the original pauses.

Because each phrase only needs a small rate correction, the speech stays natural.

Pause threshold follows the literature: a pause is at least ~300 ms of silence
between two spoken words.
"""

import json
import os

import numpy as np

PAUSE_MS = int(os.environ.get("PA_PAUSE_MS", "300"))
FRAME_MS = 10
MIN_PHRASE_MS = int(os.environ.get("PA_MIN_PHRASE_MS", "220"))
SILENCE_REL_DB = float(os.environ.get("PA_SILENCE_DB", "-32.0"))


def _frame_energy_db(mono, sr):
    """Per-frame energy in dB relative to the loudest frame."""
    win = max(1, int(sr * FRAME_MS / 1000.0))
    n = mono.size // win
    if n < 1:
        return np.zeros(0, dtype=np.float32), win
    frames = mono[: n * win].reshape(n, win).astype(np.float64)
    rms = np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-12
    peak = float(rms.max())
    if peak <= 1e-11:
        return np.full(n, -120.0, dtype=np.float32), win
    return (20.0 * np.log10(rms / peak)).astype(np.float32), win


def detect_phrases(mono, sr, start, end):
    """Split one source utterance into phrases separated by real pauses.

    Returns a list of (phrase_start, phrase_end) absolute times in seconds.
    A single phrase spanning the whole utterance is returned when no internal
    pause is long enough — which is the common case for short lines.
    """
    a = max(0, int(float(start) * sr))
    b = min(mono.size, int(float(end) * sr))
    if b - a < int(0.2 * sr):
        return [(float(start), float(end))]

    seg = mono[a:b]
    db, win = _frame_energy_db(seg, sr)
    if db.size == 0:
        return [(float(start), float(end))]

    voiced = db > SILENCE_REL_DB
    min_pause_frames = max(1, PAUSE_MS // FRAME_MS)

    # Collect runs of voiced frames, treating short unvoiced runs as within-phrase.
    phrases = []
    i = 0
    n = db.size
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j < n:
            if voiced[j]:
                j += 1
                continue
            # Look ahead: is this a real pause or a brief stop consonant?
            k = j
            while k < n and not voiced[k]:
                k += 1
            if (k - j) >= min_pause_frames:
                break          # genuine pause -> phrase ends at j
            j = k              # short gap -> keep going
        phrases.append((i, j))
        i = j

    if not phrases:
        return [(float(start), float(end))]

    # Convert to absolute seconds and drop slivers.
    out = []
    for (fs, fe) in phrases:
        ps = float(start) + (fs * win) / sr
        pe = float(start) + (fe * win) / sr
        if (pe - ps) * 1000.0 >= MIN_PHRASE_MS:
            out.append((ps, pe))
    if not out:
        return [(float(start), float(end))]

    # Keep the utterance boundaries intact.
    out[0] = (float(start), out[0][1])
    out[-1] = (out[-1][0], float(end))
    return out


def voiced_runs(mono, sr, start, end, min_pause_ms=None, pad=0.06):
    """Speech runs inside [start, end] WITHOUT forcing the outer boundaries.

    The difference from detect_phrases matters. detect_phrases deliberately keeps
    the utterance's original start/end (out[0] and out[-1] are snapped back) so
    that a line still occupies its declared slot. That is right for phrase
    alignment but wrong for repairing a bad ASR segment.

    Real case from VoiceStudio's ASR: a segment spanning 10.24 -> 20.28 (10.0 s)
    contained three words. Treating that as a 10 s slot does two bad things:
      * the character budget is computed from 10 s, so the translator is asked
        for ~120 characters of dialogue that was never spoken, and
      * whatever is synthesized gets spread across 10 s, so it drifts out of
        sync with the mouth and leaves dead air.
    Trimming to where speech actually is fixes both.

    Returns [(run_start, run_end), ...] in absolute seconds, possibly empty when
    the window holds no speech at all.
    """
    a = max(0, int(float(start) * sr))
    b = min(mono.size, int(float(end) * sr))
    if b <= a:
        return []
    seg = mono[a:b]
    db, win = _frame_energy_db(seg, sr)
    if db.size == 0:
        return []

    # Threshold relative to the loudest frame IN THIS WINDOW, so a quiet line is
    # not read as silence.
    voiced = db > SILENCE_REL_DB
    gap_frames = max(1, (min_pause_ms or PAUSE_MS) // FRAME_MS)

    runs, i, n = [], 0, db.size
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j < n:
            if voiced[j]:
                j += 1
                continue
            k = j
            while k < n and not voiced[k]:
                k += 1
            if (k - j) >= gap_frames:
                break
            j = k
        runs.append((i, j))
        i = j

    out = []
    for fs, fe in runs:
        rs = float(start) + (fs * win) / sr - pad
        re_ = float(start) + (fe * win) / sr + pad
        rs = max(float(start), rs)
        re_ = min(float(end), re_)
        if (re_ - rs) * 1000.0 >= MIN_PHRASE_MS:
            out.append((rs, re_))
    return out


def split_long_runs(runs, max_seconds):
    """Break any run longer than max_seconds at its own internal pauses.

    Long runs cannot be pace-fitted: a single block of speech that has to cover
    7+ seconds either gets slowed until it sounds robotic or ends early. Retrying
    with a shorter pause threshold usually finds a natural breath to cut on.
    """
    out = []
    for rs, re_ in runs:
        if (re_ - rs) <= max_seconds:
            out.append((rs, re_))
            continue
        # Split into equal-ish chunks at the nearest sensible count. Callers that
        # have audio should prefer re-running voiced_runs with a smaller pause
        # threshold; this is the geometric fallback.
        parts = int((re_ - rs) // max_seconds) + 1
        step = (re_ - rs) / parts
        for p in range(parts):
            out.append((rs + p * step, rs + (p + 1) * step))
    return out


def speech_overlap(source_seconds, dub_seconds):
    """Isochrony metric from the literature:
        SO = 1 - |source - dub| / source
    1.0 is perfect; published baselines sit near 0.53 and tuned systems near 0.92.
    """
    if source_seconds <= 0:
        return 0.0
    return 1.0 - abs(float(source_seconds) - float(dub_seconds)) / float(source_seconds)


def build_phrase_plan(segments, mono, sr):
    """Attach a phrase structure to every segment.

    Returns {segment_index: [(start, end), ...]}.
    """
    plan = {}
    if mono is None or not sr:
        for i, seg in enumerate(segments):
            plan[i] = [(float(seg["start"]), float(seg["end"]))]
        return plan
    for i, seg in enumerate(segments):
        try:
            plan[i] = detect_phrases(mono, sr, seg["start"], seg["end"])
        except Exception:
            plan[i] = [(float(seg["start"]), float(seg["end"]))]
    return plan


def split_prompt(items, dst_name):
    """Ask the LLM to split each translation into phrases matching the source."""
    return f"""You are doing PROSODIC ALIGNMENT for dubbing into {dst_name}.

Each item below is one line of dialogue that must be split into a fixed number of PHRASES, because the original actor paused at specific moments and the dub must pause at the same moments.

For each item you get:
- "i": line index
- "text": the full {dst_name} translation
- "phrases": a list of phrase slots, each with its duration in seconds and a character budget

Split "text" into EXACTLY len(phrases) parts, in order, so that:
- part 1 fits phrase slot 1, part 2 fits slot 2, and so on
- each part is a natural phrase or clause — never split mid-word, and avoid splitting inside a tight grammatical unit if you can
- every word of "text" appears in exactly one part, in the original order

ABSOLUTE RULES — breaking either of these ruins the dub:
1. Do NOT invent, add or substitute ANY word, sound, interjection or filler that is not already in "text". Never add something just to fill a short slot.
2. Do NOT drop or replace meaning to hit a character budget. The budgets are guidance for WHERE to cut, not permission to rewrite.

This is a SPLIT, not a translation or a rewrite: joining your parts back together with spaces must reproduce "text" (minor punctuation adjustment at the cut points is the only change allowed). If a slot's budget is too small for its natural part, exceed the budget rather than inventing or deleting words.

Return ONLY JSON: {{"lines":[{{"i":0,"parts":["...","..."]}}]}}

Items:
{json.dumps(items, ensure_ascii=False)}"""
