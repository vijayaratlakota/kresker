"""Clone-reference quality gate.

Lives in its own module (like services/voice_binding.py) so a speed or sync
revert can never take it away.

Why it exists
-------------
Zero-shot voice cloners are conditioned on a PAIR: reference audio plus the
transcript of that audio. Three independent ways of handing them a bad pair
were measured on a real job, and together they spoiled 92% of its lines:

  * an over-long reference. `_pick_reference_slices` ranked candidates
    LONGEST-FIRST and only enforced MAX_REF_DURATION_S once something had
    already been picked, so a single over-long slice always slipped through
    whole. One 33.4s slice became the reference for 72 of 109 lines - more
    than twice the cap the module's own docstring calls "wasted context".

  * a wrong-script transcript. Multilingual ASR mislabelled one speaker's
    audio as Kannada inside a Hindi video. The audio was fine; the text
    paired with it described different phonemes.

  * a transcript with no lexical content. A 9.8s clip of laughter
    ("Wah! He-he! He-he-he!") carries 2.15 chars/s where the surrounding
    speech runs at 16.6 - nothing for the cloner to align against.

All three surface the same way to a listener: the wrong voice, or a harsh
one. None of them is specific to a video; the picker simply never looked at
what it was choosing.

Design note: the checks are calibrated against THIS job's own transcript
rather than a language code, so nothing has to be plumbed through and the
gate adapts to whatever was filmed. A slice is suspect when it disagrees
with the corpus it came from.
"""
from __future__ import annotations

import os
import logging
import statistics as _st

logger = logging.getLogger("omnivoice.ref_quality")

#: Target window. Long enough for prosody, short enough to stay inside the
#: window zero-shot cloners are trained on.
IDEAL_REF_S = 8.0
#: Hard ceiling. Mirrors speaker_clone.MAX_REF_DURATION_S; duplicated so this
#: module stays importable on its own.
MAX_REF_S = 15.0
#: A slice this far below the corpus rate is thin enough to be suspect. The real
#: content check is type_token_ratio below - it catches laughter and chanting
#: directly, including the case a character rate cannot see. This floor is kept only
#: as a backstop, and deliberately loose: at 0.45 it rejected 'Kutte ke bacche!
#: Tujhe main chhodunga nahi yaar' (nine real words) for being unhurried.
DENSITY_LO = 0.25
#: Far above the corpus rate means the transcript does not fit the audio -
#: usually ASR run-on across a boundary.
DENSITY_HI = 2.20
#: Below this a transcript cannot align anything regardless of rate.
MIN_REF_CHARS = 8

#: Comfortable speaking rate in characters per second, by script. Only used to
#: keep the corpus-derived rate inside a plausible band: a video that is mostly
#: music, song or shouting has a very low median, and calibrating the gate on it
#: widens the acceptance band until nothing is rejected at all. Measured on this
#: engine's own output, and deliberately coarse - it is a sanity bound, not a
#: prediction (a character count cannot predict duration; see CLAUDE.md).
NATURAL_CPS = {
    "latn": 14.0, "cyrl": 12.0, "grek": 12.0, "hebr": 12.0, "arab": 12.0,
    "deva": 11.5, "beng": 11.0, "guru": 11.5, "gujr": 11.5, "orya": 10.5,
    "taml": 10.0, "telu": 10.5, "knda": 10.0, "mlym": 10.0, "sinh": 10.5,
    "thai": 9.0, "mymr": 9.0, "geor": 11.0,
    "hani": 6.0, "kana": 8.0, "hang": 9.0,
}
#: How far the corpus median may sit from the natural rate before it stops being
#: believable as a yardstick. Below the floor the transcript is sparse (music,
#: song, missing words); above the ceiling it is dense (run-on lines).
CORPUS_FLOOR = 0.70
CORPUS_CEIL = 1.40

#: Distinct tokens divided by total tokens. Laughter, chanting and repeated
#: interjections sit far below this; ordinary speech of reference length runs
#: 0.6-1.0. Only applied once there are enough tokens for the ratio to mean
#: something, so a short line is never rejected for being short.
REPEAT_TTR_LO = 0.35
REPEAT_MIN_TOKENS = 6

#: Share of letters in the corpus script above which a Latin-dominant transcript
#: is treated as language mixing rather than romanisation.
MIX_SCRIPT_SHARE = 0.08

#: English function words. Present in English prose, absent from a transliteration
#: of Indic speech, which is what lets the two be told apart. Deliberately grammar
#: only - no nouns or verbs, because those appear as loanwords in real romanised
#: speech ("main office jaunga", "thanks", "love you").
_ENGLISH_FUNCTION_WORDS = frozenset((
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this",
    "these", "those", "of", "to", "in", "on", "at", "by", "for", "with", "from",
    "into", "about", "as", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "can", "could",
    "should", "shall", "may", "might", "must", "not", "no", "yes", "it", "its",
    "he", "she", "they", "them", "their", "his", "her", "we", "our", "us", "you",
    "your", "yours", "yourself", "myself", "himself", "herself", "themselves",
    "what", "when", "where", "who", "whom", "which", "why", "how", "there",
    "here", "very", "just", "only", "also", "because", "while", "after", "before",
))
#: Distinct function words needed before a Latin transcript is called English.
#: One is a loanword; two is grammar.
ENGLISH_HITS_MIN = 2

#: Unicode blocks, by the four-letter script code. Enough to separate every
#: script VoiceStudio transcribes into; anything unmatched is ignored rather
#: than guessed at.
_SCRIPT_RANGES = (
    ("latn", 0x0041, 0x024F),
    ("grek", 0x0370, 0x03FF),
    ("cyrl", 0x0400, 0x04FF),
    ("hebr", 0x0590, 0x05FF),
    ("arab", 0x0600, 0x06FF),
    ("deva", 0x0900, 0x097F),
    ("beng", 0x0980, 0x09FF),
    ("guru", 0x0A00, 0x0A7F),
    ("gujr", 0x0A80, 0x0AFF),
    ("orya", 0x0B00, 0x0B7F),
    ("taml", 0x0B80, 0x0BFF),
    ("telu", 0x0C00, 0x0C7F),
    ("knda", 0x0C80, 0x0CFF),
    ("mlym", 0x0D00, 0x0D7F),
    ("sinh", 0x0D80, 0x0DFF),
    ("thai", 0x0E00, 0x0E7F),
    ("mymr", 0x1000, 0x109F),
    ("geor", 0x10A0, 0x10FF),
    ("hang", 0xAC00, 0xD7AF),
    ("hani", 0x4E00, 0x9FFF),
    ("kana", 0x3040, 0x30FF),
)


def script_counts(text: str) -> dict[str, int]:
    """Letters per script in `text`. Digits and punctuation are ignored."""
    out: dict[str, int] = {}
    for ch in text or "":
        if not ch.isalpha():
            continue
        code = ord(ch)
        for name, lo, hi in _SCRIPT_RANGES:
            if lo <= code <= hi:
                out[name] = out.get(name, 0) + 1
                break
    return out


def dominant_script(text: str) -> str | None:
    """The script most of `text` is written in, or None when it has no letters."""
    counts = script_counts(text)
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def corpus_norms(segments) -> dict:
    """What "normal" looks like for this transcript.

    Returns ``{"script": <code or None>, "cps": <median chars/s or None>}``.
    Deriving the norms from the transcript itself, instead of a language code,
    means nothing has to be threaded through the call chain and a slice is
    judged against the video it came from.
    """
    counts: dict[str, int] = {}
    rates: list[float] = []
    for seg in segments or []:
        row = seg[1] if isinstance(seg, tuple) else seg
        if not isinstance(row, dict):
            continue
        text = (row.get("text") or "").strip()
        if not text:
            continue
        for name, n in script_counts(text).items():
            counts[name] = counts.get(name, 0) + n
        try:
            dur = float(row.get("end", 0.0)) - float(row.get("start", 0.0))
        except (TypeError, ValueError):
            continue
        # Very short slices have unreliable boundaries; they would drag the
        # median around without telling us anything about the speaking rate.
        if dur >= 1.0:
            rates.append(len(text) / dur)
    script = max(counts.items(), key=lambda kv: kv[1])[0] if counts else None
    raw = _st.median(rates) if rates else None
    natural = NATURAL_CPS.get(script) if script else None
    # The corpus may narrow the band but never widen it. On a trailer the median
    # came out at 3.86 chars/s against Telugu's 10.5, which let 15 seconds of
    # laughter through as the main character's voice.
    cps = raw
    if raw and natural:
        cps = min(max(raw, natural * CORPUS_FLOOR), natural * CORPUS_CEIL)
    elif natural and not raw:
        cps = natural
    return {
        "script": script,
        "cps": cps,
        "cps_raw": raw,
        "natural": natural,
    }


def _tokens(text: str) -> list[str]:
    """Words, with punctuation stripped. Script-agnostic: splitting on
    non-letters works for every script VoiceStudio transcribes."""
    out, cur = [], []
    for ch in text or "":
        if ch.isalpha() or ch.isdigit():
            cur.append(ch.lower())
        elif cur:
            out.append("".join(cur)); cur = []
    if cur:
        out.append("".join(cur))
    return out


def type_token_ratio(text: str) -> float | None:
    """Distinct tokens over total tokens, or None when there are too few.

    This is the check a character rate cannot do. "Ha ha ha ha ha ha ha!" three
    times over is 65 characters in 15 seconds - a perfectly normal rate - and
    carries exactly one word. A zero-shot cloner conditioned on it learns a
    laugh, which is why that speaker came out harsh on every line.
    """
    toks = _tokens(text)
    if len(toks) < REPEAT_MIN_TOKENS:
        return None
    return len(set(toks)) / float(len(toks))


def looks_english(text: str) -> bool:
    """Whether a Latin transcript is English rather than a romanisation.

    Only meaningful for audio in a non-Latin language: a source transcript that
    comes back in English means the ASR translated instead of transcribing, so the
    text describes different phonemes than the audio it is paired with.
    """
    toks = set(_tokens(text))
    return len(toks & _ENGLISH_FUNCTION_WORDS) >= ENGLISH_HITS_MIN


def slice_text_defect(text, duration, norms: dict | None) -> str | None:
    """Why this transcript cannot be trusted as a clone reference, or None.

    Returns a short reason string so callers can log which check fired.
    Unknown is never treated as bad: with no corpus to compare against, only
    the absolute minimum-length check applies.
    """
    text = (text or "").strip()
    if len(text) < MIN_REF_CHARS:
        return "text-too-short:%dch" % len(text)
    norms = norms or {}
    want = norms.get("script")
    got = dominant_script(text)
    # Latin over non-Latin audio is romanisation, not a different language:
    # multilingual ASR writes Hindi as "Kutte ke bacche" often enough that
    # treating it as a mismatch cost 19 of 109 usable references on a real job.
    # A different NON-Latin script cannot be a romanisation, so that still
    # counts - which is the case that matters (Kannada text over Hindi audio).
    # Contentless clips like laughter are caught by the rate check below, where
    # they belong.
    if want and got and got != want:
        romanised = got == "latn" and want != "latn"
        if romanised:
            # A romanisation is written ENTIRELY in Latin. A transcript that
            # carries both Latin and the corpus script is the ASR changing
            # language part-way through the clip, so the audio and the text
            # describe different phonemes for part of the reference.
            counts = script_counts(text)
            total = sum(counts.values()) or 1
            if counts.get(want, 0) / total >= MIX_SCRIPT_SHARE:
                return "mixed-script:%s+%s" % (got, want)
            # A romanisation transliterates the words that were spoken. English
            # grammar in the transcript of non-English audio means the ASR
            # translated the line, so the pair describes different phonemes.
            if looks_english(text):
                return "translated-not-transcribed:en-over-%s" % want
        else:
            return "wrong-script:%s-in-%s" % (got, want)
    ttr = type_token_ratio(text)
    if ttr is not None and ttr < REPEAT_TTR_LO:
        return "repeated-filler:ttr%.2f" % ttr
    cps_norm = norms.get("cps")
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = 0.0
    if cps_norm and duration >= 1.0:
        ratio = (len(text) / duration) / cps_norm
        if ratio < DENSITY_LO:
            return "no-lexical-content:%.2fx" % ratio
        if ratio > DENSITY_HI:
            return "transcript-overruns-audio:%.2fx" % ratio
    return None


def duration_defect(duration) -> str | None:
    """Whether the reference is outside the window the cloner can use."""
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        return "duration-unknown"
    if duration > MAX_REF_S:
        return "over-cap:%.1fs" % duration
    return None


def defects(duration, text, norms: dict | None) -> list[str]:
    """Every reason this reference is a poor one. Empty list means it is fine."""
    out = []
    d = duration_defect(duration)
    if d:
        out.append(d)
    t = slice_text_defect(text, duration, norms)
    if t:
        out.append(t)
    return out


#: How damaging each defect is as a clone reference, worst first. Used to rank,
#: not to filter: on sparse content every candidate may be flawed, and a speaker
#: with no reference falls back to the default voice - which is the louder bug.
_SEVERITY = (
    ("repeated-filler", 4),      # nothing lexical to align at all
    ("wrong-script", 3),         # text describes different phonemes
    ("mixed-script", 3),
    ("translated-not-transcribed", 3),
    ("text-too-short", 2),
    ("no-lexical-content", 2),
    # Ranked 1 - the LOWEST of any defect, below text-too-short - until this was measured.
    # A transcript that describes more speech than its clip contains is the proven cause of
    # source-language audio at the front of a dubbed line: the engine builds
    # `full_text = ref_text + target_text` and speaks the surplus. It belongs at the top.
    ("transcript-overruns-audio", 4),
)


#: An overrun at or above this is worth saying out loud. It is NOT a rejection threshold:
#: measured over 94 live references the distribution is median 1.09, p90 1.75, p95 2.20, so
#: rejecting at 1.5 would strip 12 of them of their own reference and drop those lines to the
#: pooled voice. Visibility first; the two code paths that manufactured real overruns
#: (_widen_short_refs and _fallback_words) are fixed at source.
DENSITY_WARN = float(os.environ.get("OMNIVOICE_REF_DENSITY_WARN", "1.50"))


def overrun_ratio(text, duration, norms: dict | None) -> float:
    """How much more speech this transcript describes than its clip holds. 0.0 = unknown.

    1.0 means the transcript matches the corpus speaking rate for this much audio. The
    engine's own estimator does the same division, so this is the number that decides how
    much of the reference it thinks it has to fit into the line.
    """
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        return 0.0
    cps_norm = (norms or {}).get("cps")
    text = (text or "").strip()
    if not cps_norm or duration < 1.0 or not text:
        return 0.0
    return (len(text) / duration) / cps_norm


def defect_severity(duration, text, norms: dict | None) -> int:
    """0 when the reference is clean, otherwise how bad the worst defect is."""
    why = slice_text_defect(text, duration, norms)
    if not why:
        return 0
    for prefix, score in _SEVERITY:
        if why.startswith(prefix):
            return score
    return 1


def sort_key(duration, text, norms: dict | None):
    """Rank candidate references, best first.

    Order of concerns: a usable transcript, then a duration inside the cap,
    then closeness to IDEAL_REF_S. Closeness replaces the old longest-first
    rule, which actively selected the worst available clip.
    """
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = 0.0
    return (
        defect_severity(duration, text, norms),
        1 if duration > MAX_REF_S else 0,
        abs(duration - IDEAL_REF_S),
    )


def cap_reference(ref_path: str, ref_text: str, *, max_s: float = MAX_REF_S,
                  target_s: float = IDEAL_REF_S):
    """Last resort: shorten an over-long reference WAV in place.

    Only reached when a speaker has no candidate inside the cap at all. The
    audio is cut at the quietest 200 ms window near `target_s` so the cut
    lands in a pause rather than mid-word, and the transcript is truncated to
    the same fraction of its characters at a word boundary - the pair has to
    stay a pair, which is the whole point of this module.

    Returns ``(duration, text)`` after the trim, or the original values when
    anything goes wrong. Never raises.
    """
    try:
        import numpy as np
        import soundfile as sf

        audio, sr = sf.read(ref_path, dtype="float32", always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        dur = len(audio) / float(sr)
        if dur <= max_s:
            return dur, ref_text

        # Look for a pause in a window around the target, then cut there.
        lo = int(max(1.0, target_s - 2.0) * sr)
        hi = int(min(dur, target_s + 2.0) * sr)
        cut = int(min(target_s, max_s) * sr)
        if hi > lo:
            win = int(0.2 * sr)
            frame = max(1, win // 4)
            best, best_e = cut, None
            for pos in range(lo, max(lo + 1, hi - win), frame):
                e = float(np.mean(np.abs(audio[pos:pos + win])))
                if best_e is None or e < best_e:
                    best_e, best = e, pos + win // 2
            cut = best
        cut = max(int(2.0 * sr), min(cut, int(max_s * sr), len(audio)))
        sf.write(ref_path, audio[:cut], sr)

        kept = cut / float(sr)
        text = (ref_text or "").strip()
        if text:
            keep_chars = max(MIN_REF_CHARS, int(len(text) * (kept / dur)))
            if keep_chars < len(text):
                head = text[:keep_chars]
                space = head.rfind(" ")
                text = (head[:space] if space > MIN_REF_CHARS else head).strip()
        logger.info(
            "ref_quality: trimmed over-long reference %s from %.2fs to %.2fs "
            "(no candidate inside the %.0fs cap); transcript cut to match",
            ref_path, dur, kept, max_s,
        )
        return kept, text
    except Exception as e:              # pragma: no cover - defensive only
        logger.warning("ref_quality: could not cap %s: %s", ref_path, e)
        return None, ref_text


def audit(clones: dict, norms: dict | None) -> list[str]:
    """One human-readable verdict per speaker, for the render log.

    A silent bad reference is what made this class of bug survive so long:
    the dub completed, the waveform looked plausible, and nothing said which
    voice had been cloned from what.
    """
    lines = []
    for name, info in sorted((clones or {}).items()):
        if not isinstance(info, dict):
            continue
        dur = info.get("duration")
        text = info.get("ref_text") or ""
        bad = defects(dur, text, norms)
        try:
            shown = "%.2fs" % float(dur)
        except (TypeError, ValueError):
            shown = "?s"
        lines.append("%s: %s, %d ch, %s" % (
            name, shown, len(text), ("OK" if not bad else "; ".join(bad)),
        ))
    return lines


def source_segments(job: dict) -> list[dict]:
    """The job's segments carrying their SOURCE-language text.

    ``job["segments"]`` holds the translated line after a render (the editor
    only ever sends the dub text), so the source line lives in
    ``text_original``. Clone references are cut from the source audio and must
    be paired with the source transcript, not the translation.
    """
    out = []
    for row in job.get("segments") or []:
        if not isinstance(row, dict):
            continue
        text = (row.get("text_original") or "").strip()
        if not text:
            # Pre-existing jobs may not have kept it; the per-segment clone
            # text is the same source line.
            info = (job.get("segment_clones") or {}).get(str(row.get("id")))
            if isinstance(info, dict):
                text = (info.get("ref_text") or "").strip()
        if not text:
            text = (row.get("text") or "").strip()
        out.append(dict(row, text=text))
    return out


def heal_job_clones(job: dict) -> list[str]:
    """Replace any defective per-speaker clone reference on `job`, in place.

    Returns log lines describing what changed (empty when nothing was wrong).
    Re-extraction is attempted only when the isolated vocals are still on disk
    and only the defective speakers are replaced - a good reference is never
    disturbed, and a re-extraction that comes back no better is discarded, so
    this can only improve a job or leave it alone.

    Never raises: a render must not fail because a reference could not be
    improved.
    """
    lines: list[str] = []
    try:
        clones = job.get("speaker_clones")
        if not isinstance(clones, dict) or not clones:
            return lines
        segs = source_segments(job)
        norms = corpus_norms(segs)
        bad = {
            name: defects(info.get("duration"), info.get("ref_text") or "", norms)
            for name, info in clones.items()
            if isinstance(info, dict)
        }
        bad = {k: v for k, v in bad.items() if v}
        if not bad:
            return lines
        for name, why in sorted(bad.items()):
            lines.append("clone reference %s is unusable (%s)" % (name, "; ".join(why)))

        vocals = job.get("vocals_path")
        import os
        if not vocals or not os.path.exists(vocals):
            lines.append("cannot re-cut references: isolated vocals are gone; "
                         "re-transcribe this video to fix the voices")
            return lines

        from services.speaker_clone import extract_speaker_clones
        fresh = extract_speaker_clones(
            vocals, segs, os.path.dirname(vocals), labels_source=None,
        ) or {}

        for name in sorted(bad):
            cand = fresh.get(name)
            if not isinstance(cand, dict):
                lines.append("no better reference available for %s; leaving it" % name)
                continue
            still = defects(cand.get("duration"), cand.get("ref_text") or "", norms)
            if still:
                lines.append("re-cut reference for %s is no better (%s); leaving it"
                             % (name, "; ".join(still)))
                continue
            clones[name] = cand
            lines.append("re-cut reference for %s: %.2fs, %d ch, OK" % (
                name, float(cand.get("duration") or 0.0),
                len(cand.get("ref_text") or ""),
            ))
        job["speaker_clones"] = clones
    except Exception as e:                  # pragma: no cover - defensive only
        logger.warning("ref_quality: clone healing skipped: %s", e)
    return lines
