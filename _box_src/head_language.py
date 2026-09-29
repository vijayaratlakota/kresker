# -*- coding: utf-8 -*-
"""Find and remove source-language audio at the front of a rendered dub line.

WHY NOT FORCED ALIGNMENT - measured, because this was tried first and shipped and failed:

    line c010, piece 14.70s, opens with 2.5s of 100% Devanagari.
    Aligning the TELUGU text over the whole piece scored 0.936 - the HIGHEST of any cut
    point. Cutting the Hindi off made the score go DOWN. Sweeping the cut produced a flat
    curve on every leaking line (c004 +0.05, c012 +0.04).

An aligner is told the text and lays a monotonic path over whatever audio it is handed; it
has no way to report "these words are not in here". Telugu and Hindi romanise to similar
token sequences, so it maps one onto the other happily. It is the right tool for *where a
known text sits* and the wrong tool for *which language this is*.

WHAT THIS USES INSTEAD: the recogniser, which answered unambiguously on the same clips -
96%, 97% and 100% source script on the leaking lines, 0% on the clean ones - and whose
chunks carry timestamps:

    c010   (0.0, 2.5) 100% Devanagari | (2.5, 4.9) 90% Telugu    -> boundary 2.5s
    c012   (0.0, 2.8) 100% Devanagari | (2.8, 5.0) 100% Telugu   -> boundary 2.8s

So one transcription of the piece gives the language AND the boundary. Walk the chunks, find
where the source-script run ends, cut there.

CASES IT DELIBERATELY DOES NOT TOUCH:
  * every chunk is source script - the whole line is in the wrong language, not a lead. Cutting
    would leave nothing. Logged as an error so the line can be found and re-rendered.
  * the piece is neither script (measured: one line transcribed as "Wee! Whee!" in Latin) -
    that is babble, a different defect, and trimming it would not help.
  * nothing source-script at the front - left exactly as it is.

Off with OMNIVOICE_HEAD_LANG=0.
"""

import logging
import os
import subprocess
import tempfile

logger = logging.getLogger("omnivoice.head_language")

ENABLED = os.environ.get("OMNIVOICE_HEAD_LANG", "1") not in ("0", "false", "False")

#: Script ranges by language code. A chunk is "source script" when this share of its letters
#: sits in the source language's block.
SCRIPTS = {
    "hi": (0x0900, 0x097F), "mr": (0x0900, 0x097F), "ne": (0x0900, 0x097F),
    "sa": (0x0900, 0x097F), "bn": (0x0980, 0x09FF), "as": (0x0980, 0x09FF),
    "pa": (0x0A00, 0x0A7F), "gu": (0x0A80, 0x0AFF), "or": (0x0B00, 0x0B7F),
    "ta": (0x0B80, 0x0BFF), "te": (0x0C00, 0x0C7F), "kn": (0x0C80, 0x0CFF),
    "ml": (0x0D00, 0x0D7F), "si": (0x0D80, 0x0DFF), "th": (0x0E00, 0x0E7F),
    "ar": (0x0600, 0x06FF), "ur": (0x0600, 0x06FF), "fa": (0x0600, 0x06FF),
    "he": (0x0590, 0x05FF), "el": (0x0370, 0x03FF), "ru": (0x0400, 0x04FF),
    "uk": (0x0400, 0x04FF), "ka": (0x10A0, 0x10FF), "am": (0x1200, 0x137F),
    "en": (0x0041, 0x007A),
}

#: A leading chunk counts as source-language when its source share is at least this and its
#: target share is below TARGET_MAX. Measured leaks were 96-100% source, 0% target.
SOURCE_MIN = float(os.environ.get("OMNIVOICE_HEAD_SOURCE_MIN", "0.40"))
TARGET_MAX = float(os.environ.get("OMNIVOICE_HEAD_TARGET_MAX", "0.30"))

#: Never cut more than this share of a piece, and never leave less than this.
MAX_FRACTION = float(os.environ.get("OMNIVOICE_HEAD_MAX_FRAC", "0.55"))
MIN_KEEP_S = float(os.environ.get("OMNIVOICE_HEAD_MIN_KEEP_S", "0.35"))

#: Leads shorter than this are not worth a cut.
MIN_LEAD_S = float(os.environ.get("OMNIVOICE_HEAD_MIN_LEAD_S", "0.20"))

#: Keep a little before the boundary so the first consonant survives.
PREROLL_S = float(os.environ.get("OMNIVOICE_HEAD_PREROLL_S", "0.04"))

#: Do not spend a call on a piece shorter than this.
MIN_PIECE_S = float(os.environ.get("OMNIVOICE_HEAD_MIN_PIECE_S", "0.50"))


def _code(lang):
    return (str(lang or "").split("-")[0].split("_")[0] or "").lower()


def _share(text, rng):
    if not rng:
        return 0.0
    lo, hi = rng
    ch = [c for c in (text or "") if not c.isspace() and not c.isdigit()
          and c not in ".,!?;:'\"()[]-\u2014\u2013"]
    if not ch:
        return 0.0
    return sum(1 for c in ch if lo <= ord(c) <= hi) / float(len(ch))


def _chunks(res):
    """[(start, end, text)] from whatever shape the backend returned."""
    out = []
    if not isinstance(res, dict):
        return out
    for ch in (res.get("chunks") or res.get("segments") or []):
        if not isinstance(ch, dict):
            continue
        txt = ch.get("text") or ""
        ts = ch.get("timestamp") or ch.get("time")
        a = b = None
        if isinstance(ts, (list, tuple)) and len(ts) >= 2:
            a, b = ts[0], ts[1]
        else:
            a, b = ch.get("start"), ch.get("end")
        try:
            a = float(a) if a is not None else None
            b = float(b) if b is not None else None
        except Exception:  # noqa: BLE001
            a = b = None
        if a is None:
            continue
        out.append((a, b if b is not None else a, txt))
    out.sort(key=lambda r: r[0])
    return out


def boundary(res, source_lang, target_lang, duration):
    """Where the source-language run at the front ends. (seconds, note)."""
    src_rng = SCRIPTS.get(_code(source_lang))
    tgt_rng = SCRIPTS.get(_code(target_lang))
    if not src_rng or not tgt_rng or src_rng == tgt_rng:
        return 0.0, "source and target share a script - cannot tell them apart"
    chunks = _chunks(res)
    if not chunks:
        return 0.0, "no timed chunks came back"
    lead_end = 0.0
    n_src = 0
    for a, b, txt in chunks:
        s = _share(txt, src_rng)
        t = _share(txt, tgt_rng)
        if s >= SOURCE_MIN and t < TARGET_MAX:
            lead_end = max(lead_end, float(b))
            n_src += 1
            continue
        break                      # the first non-source chunk ends the lead
    if n_src == 0:
        return 0.0, "front is not source language"
    if n_src == len(chunks) and lead_end >= duration * 0.95:
        return 0.0, ("THE WHOLE LINE is in the source language, not a lead - "
                     "it needs re-rendering")
    return lead_end, "source language for the first %.2fs (%d chunk(s))" % (lead_end, n_src)


def transcribe_piece(path, backend, seconds=None):
    """One recogniser call over the piece (or its first `seconds`)."""
    tmp = os.path.join(tempfile.gettempdir(), "_hl_%d.wav" % os.getpid())
    cmd = ["ffmpeg", "-nostdin", "-v", "quiet", "-y"]
    if seconds:
        cmd += ["-t", "%.2f" % seconds]
    cmd += ["-i", path, "-ac", "1", "-ar", "16000", tmp]
    subprocess.run(cmd, check=False)
    if not os.path.exists(tmp):
        return None
    try:
        return backend.transcribe(tmp)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def head_seconds(wav_path, source_lang, target_lang, *, backend=None, seg_id=""):
    """How much source-language audio is at the front of this file. (seconds, note)."""
    if not ENABLED:
        return 0.0, "disabled"
    try:
        import soundfile as sf
        info = sf.info(wav_path)
        dur = float(info.frames) / float(info.samplerate)
    except Exception as e:  # noqa: BLE001
        return 0.0, "unreadable: %s" % e
    if dur < MIN_PIECE_S:
        return 0.0, "piece too short to bother"
    if backend is None:
        from services import asr_backend as B
        backend = B.get_active_asr_backend()
    try:
        res = transcribe_piece(wav_path, backend)
    except Exception as e:  # noqa: BLE001
        return 0.0, "recogniser failed: %s" % e
    end, note = boundary(res, source_lang, target_lang, dur)
    if end <= 0:
        return 0.0, note
    cut = max(0.0, end - PREROLL_S)
    if cut < MIN_LEAD_S:
        return 0.0, "lead only %.2fs" % cut
    if cut > MAX_FRACTION * dur:
        logger.error("head language: %s is source language for %.2fs of a %.2fs piece, past "
                     "the %.0f%% cap - left alone, this line needs a look",
                     seg_id or "?", end, dur, 100 * MAX_FRACTION)
        return 0.0, "lead %.2fs past the cap" % cut
    if dur - cut < MIN_KEEP_S:
        return 0.0, "would leave too little"
    return cut, note


def trim_tensor(audio, sr, cut_s):
    """Drop the first `cut_s` seconds from a tensor or array."""
    k = int(cut_s * sr)
    if k <= 0:
        return audio
    try:
        if hasattr(audio, "shape") and getattr(audio, "ndim", 1) > 1:
            return audio[..., k:]
        return audio[k:]
    except Exception:  # noqa: BLE001
        return audio


# ------------------------------------------------------------- the whole-line verdict
#: Verdicts. UNKNOWN means "no honest judgement was possible" and is NOT the same as OK -
#: conflating them is what let a 1.17s line report clean when nothing had been read.
OK = "ok"
LEAD = "lead"
#: Source language at the END of the clip. The front walk stops at the first target
#: chunk, so a source-language tail was invisible to it - and the tail is exactly what
#: is still sounding in the gap before the next line, which is what a listener reports
#: as "the original just before every dubbed line". Repaired by RE-RENDERING only:
#: cutting a tail is never done, so cut_s stays 0.0 for this verdict.
TAIL_SOURCE = "tail_source"
ALL_SOURCE = "all_source"
BABBLE = "babble"          # kept for callers; never returned
UNKNOWN = "unknown"

_SEVERITY = {UNKNOWN: 0, OK: 1, LEAD: 2, TAIL_SOURCE: 3, ALL_SOURCE: 4}

#: How much of the end of the clip is "the tail". 0.30s is the window a listener hears
#: running into the next line (median gap on the measured job was 150ms).
TAIL_S = float(os.environ.get("OMNIVOICE_HEAD_TAIL_S", "0.30"))

#: Re-render caps.
MAX_RERENDER = int(os.environ.get("OMNIVOICE_HEAD_MAX_RERENDER", "2"))
JOB_RERENDER_FRACTION = float(os.environ.get("OMNIVOICE_HEAD_JOB_FRACTION", "1.0"))

#: How many independent looks a piece gets before it is called clean. The recogniser chunks
#: the same audio differently between calls: on line c012 look 1 merged the Hindi head into
#: a 2.40s chunk that also held Telugu (coverage diluted to 0.65 against 0.51, under the
#: margin) while look 2 split it at 1.48s and scored 0.91 against 0.65. Set to 1 to halve
#: the recogniser cost at the price of missing that class again.
LOOKS = int(os.environ.get("OMNIVOICE_HEAD_LOOKS", "2"))

#: Content thresholds. A leaked head is almost entirely contained in the line's own source
#: text - measured 0.91-0.98 - while a clean chunk sits at 0.20-0.85.
MIN_CHARS = int(os.environ.get("OMNIVOICE_HEAD_MIN_CHARS", "16"))
MIN_CHARS_FLOOR = int(os.environ.get("OMNIVOICE_HEAD_MIN_CHARS_FLOOR", "5"))
OWN_MIN = float(os.environ.get("OMNIVOICE_HEAD_OWN_MIN", "0.90"))

#: Comparing against the REFERENCE transcript needs at least this much text, because
#: ref_text is long and short strings match long ones by chance. Measured: at 16 characters
#: c022 (7) and c024 (8) stop firing while c018 (31), c029 (31), c010 (44) and c012 (56) all
#: still do.
REF_MIN_CHARS = int(os.environ.get("OMNIVOICE_HEAD_REF_MIN_CHARS", "16"))
MARGIN = float(os.environ.get("OMNIVOICE_HEAD_MARGIN", "0.20"))

#: The veto. Above this, the chunk is saying the line's OWN words and cannot be a leak no
#: matter what script it came back in.
TARGET_SAYS = float(os.environ.get("OMNIVOICE_HEAD_TARGET_SAYS", "0.80"))

#: Latin is the recogniser's fallback for audio it cannot place, so the script test is
#: unsafe when the SOURCE language is Latin-scripted. Content still works there.
_LATIN = (0x0041, 0x007A)

_uro = {}


def _romanise(text, lang):
    """Romanised, alphanumerics only, lowercased, single-spaced.

    Compares CONTENT rather than script, which is the point: the same leaked Hindi came
    back as Devanagari on one call and in Telugu script on the next.
    """
    if not text:
        return ""
    if "u" not in _uro:
        try:
            import uroman
            _uro["u"] = uroman.Uroman()
        except Exception as e:  # noqa: BLE001
            logger.info("head language: uroman unavailable (%s); content test off",
                        str(e)[:120])
            _uro["u"] = None
    u = _uro.get("u")
    s = text
    if u is not None:
        try:
            s = u.romanize_string(text, lcode=(lang or None))
        except Exception:  # noqa: BLE001
            s = text
    s = "".join((c.lower() if c.isalnum() else " ") for c in s)
    return " ".join(s.split())


def _cover(a, b):
    """How much of a is found in b, 0..1."""
    if not a or not b:
        return 0.0
    import difflib
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return sum(bl.size for bl in sm.get_matching_blocks()) / float(len(a))


#: Notes for which a second look cannot possibly help.
_FINAL_NOTES = ("disabled", "nothing to compare", "no usable test", "unreadable",
                "too short to judge")


def classify(wav_path, source_lang, target_lang, *, target_text="", source_text="",
             ref_text="", backend=None, seg_id="", judge_end_s=None):
    """One look. Returns dict(verdict, cut_s, note, chunks, judged).

    `judge_end_s` is where the clip will actually END once the caller has capped it to
    its slot (strict_slot trims to the slot AFTER this check runs). The tail test uses
    it so it judges the audio that ships, not audio that is about to be thrown away.
    """
    out = {"verdict": UNKNOWN, "cut_s": 0.0, "note": "", "chunks": 0, "judged": 0,
           "content_evidence": False}
    if not ENABLED:
        out["note"] = "disabled"
        return out
    sc, tc = _code(source_lang), _code(target_lang)
    if not sc or not tc or sc == tc:
        out["note"] = "source=%r target=%r - nothing to compare" % (sc, tc)
        return out
    src_rng, tgt_rng = SCRIPTS.get(sc), SCRIPTS.get(tc)
    use_script = bool(src_rng and tgt_rng and src_rng != tgt_rng and src_rng != _LATIN)
    tgt_rom = _romanise(target_text, tc)
    own_rom = _romanise(source_text, sc)
    # The engine generates ref_text + the line as ONE text sequence, so a leak is the
    # REFERENCE TRANSCRIPT being spoken - not necessarily this line's own source text, which
    # is only a subset of it once the window is widened to absorb neighbours. Measured on
    # xs25qh86: leaked heads match ref_text at a median of 0.98 while clean heads sit at
    # 0.66, and it is what finally catches c018 (0.19 against the line's own source text,
    # 0.97 against ref_text) and c029 (0.39 -> 1.00).
    ref_rom = _romanise(ref_text, sc)
    use_content = bool(tgt_rom and (own_rom or ref_rom))
    if not use_script and not use_content:
        out["note"] = "no usable test for %s -> %s" % (sc, tc)
        return out
    try:
        import soundfile as sf
        info = sf.info(wav_path)
        dur = float(info.frames) / float(info.samplerate)
    except Exception as e:  # noqa: BLE001
        out["note"] = "unreadable: %s" % e
        return out
    if dur < MIN_PIECE_S:
        out["note"] = "piece too short to judge (%.2fs)" % dur
        return out
    if backend is None:
        from services import asr_backend as B
        backend = B.get_active_asr_backend()
    try:
        res = transcribe_piece(wav_path, backend)
    except Exception as e:  # noqa: BLE001
        out["note"] = "recogniser failed: %s" % e
        return out
    chunks = _chunks(res)
    out["chunks"] = len(chunks)
    if not chunks:
        out["note"] = "no timed chunks came back"
        return out

    # A short line's own text is short too, so a flat character gate makes short lines
    # unjudgeable and therefore invisible. Scale it, with a floor.
    gate = MIN_CHARS
    if tgt_rom:
        gate = max(MIN_CHARS_FLOOR, min(MIN_CHARS, int(round(0.5 * len(tgt_rom)))))

    _content_fired = []

    def judge(text):
        """(True source, False target, None could-not-judge), why, evidence.

        `evidence` is "content" or "script" - which of the two orthogonal signals
        fired. The tail test acts on "content" only: a tail is repaired by spending a
        re-render, and script alone has been measured firing on correct audio that the
        recogniser merely transliterated.
        """
        rom = _romanise(text, tc)
        if len(rom) < gate:
            return None, "only %d character(s), gate is %d" % (len(rom), gate), None
        # The line's own source text is short, so the adaptive gate above is enough
        # for it. ref_text is a long haystack and a handful of characters will be found
        # inside it by chance - c022 (7 characters) and c024 (8) both scored >= 0.90
        # against it - so that comparison gets an absolute floor.
        co = _cover(rom, own_rom) if use_content else 0.0
        if use_content and ref_rom and len(rom) >= REF_MIN_CHARS:
            co = max(co, _cover(rom, ref_rom))
        ct = _cover(rom, tgt_rom) if use_content else 0.0
        # The veto first: correct audio sometimes comes back in the SOURCE script.
        if use_content and ct >= TARGET_SAYS and ct > co:
            return False, "says its own words (%.2f)" % ct, None
        # Content first, and remember that it fired: it is the only evidence strong
        # enough to justify CUTTING. The script test has been measured firing on correct
        # audio that the recogniser merely transliterated - on te->en line c000 that cut
        # deleted the words "good morning from china".
        if use_content and co >= OWN_MIN and (co - ct) >= MARGIN:
            _content_fired.append(1)
            return True, ("says the %s line's words (%.2f against %.2f for its own text)"
                          % (sc, co, ct)), "content"
        if use_script:
            ss, ts = _share(text, src_rng), _share(text, tgt_rng)
            if ss >= SOURCE_MIN and ts < TARGET_MAX:
                return True, "written in %s script (%.0f%%)" % (sc, 100.0 * ss), "script"
        return False, "", None

    calls = [judge(t) for _, _, t in chunks]
    judged = [v for v, _w, _e in calls if v is not None]
    out["judged"] = len(judged)
    if not judged:
        out["note"] = ("no chunk had enough text to judge (%d chunk(s), gate %d)"
                       % (len(chunks), gate))
        return out
    out["content_evidence"] = bool(_content_fired)
    if all(judged):
        out["verdict"] = ALL_SOURCE
        why = next(w for v, w, _e in calls if v is True)
        out["note"] = "every readable chunk is %s: %s" % (sc, why)
        return out

    def _tail_note():
        """Is the audio the listener hears LAST in the source language?

        Costs no extra recogniser call: the timed chunks for this piece are already
        here, and the front walk simply never looked at the end of them. Content
        evidence only, and measured against the line's OWN text_original / ref_text -
        a script-only tail test would re-render clean lines, which is the documented
        way this detector has been made worse before.
        """
        end_s = dur
        try:
            if judge_end_s and 0.0 < float(judge_end_s) < dur:
                end_s = float(judge_end_s)
        except (TypeError, ValueError):
            end_s = dur
        lo = max(0.0, end_s - TAIL_S)
        hit = None
        for (a, b, _t), (v, w, ev) in zip(chunks, calls):
            if v is not True or ev != "content":
                continue
            if min(float(b), end_s) > lo and float(a) < end_s:
                hit = (float(a), float(b), w)
        if hit is None:
            return ""
        return ("%s in the last %.0f ms (chunk %.2f-%.2f of a %.2fs piece, judged to "
                "%.2fs): %s" % (sc, 1000.0 * (end_s - lo), hit[0], hit[1], dur,
                                end_s, hit[2]))

    lead_end, n, why = 0.0, 0, ""
    for (a, b, _t), (v, w, _e) in zip(chunks, calls):
        if v is True:
            lead_end = max(lead_end, float(b))
            n += 1
            why = why or w
            continue
        break                      # a target chunk, or one we could not read, ends the lead
    if n == 0:
        _tn = _tail_note()
        if _tn:
            out["verdict"] = TAIL_SOURCE
            out["note"] = _tn
            return out
        out["verdict"] = OK
        out["note"] = "%s from the start" % tc
        return out
    cut = max(0.0, lead_end - PREROLL_S)
    if cut < MIN_LEAD_S:
        _tn = _tail_note()
        if _tn:
            out["verdict"] = TAIL_SOURCE
            out["note"] = _tn
            return out
        out["verdict"] = OK
        out["note"] = "lead only %.2fs, not worth a cut" % cut
        return out
    if cut > MAX_FRACTION * dur or dur - cut < MIN_KEEP_S:
        out["verdict"] = ALL_SOURCE
        out["note"] = ("%s for %.2fs of a %.2fs piece - too much to cut, re-render"
                       % (sc, lead_end, dur))
        return out
    out["verdict"] = LEAD
    out["cut_s"] = cut
    out["note"] = "%s for the first %.2fs (%d chunk(s)): %s" % (sc, lead_end, n, why)
    return out


def classify_best(wav_path, source_lang, target_lang, **kw):
    """Up to LOOKS independent looks; the most severe verdict wins.

    Stops as soon as a look finds something actionable, so the extra call is only paid on
    lines that look clean - and it is those lines where a single look was measured to miss
    (c012: look 1 clean, look 2 a 1.48s Hindi head at 0.91 against 0.65).
    """
    best, used = None, 0
    for _ in range(max(1, LOOKS)):
        v = classify(wav_path, source_lang, target_lang, **kw)
        used += 1
        if best is None or _SEVERITY.get(v["verdict"], 0) > _SEVERITY.get(best["verdict"], 0):
            best = v
        if _SEVERITY.get(v["verdict"], 0) >= _SEVERITY[LEAD]:
            break
        note = (v.get("note") or "").lower()
        if any(k in note for k in _FINAL_NOTES):
            break                  # a second look cannot change any of these
    best["looks"] = used
    return best


# ------------------------------------------------------- starting the line on time
#: Remove the dub's own leading silence so its first syllable lands on the slot's start.
#: Measured on job dq1g7fxj: all 31 lines began with 0.06-1.15s of dub silence (7.28s in
#: total) while the ORIGINAL voice underneath sat at -6 to -26 dB - so the original is what
#: you hear at every line start. Unlike the language trim this cannot delete words, because
#: it only ever removes audio that is already near-silent.
START_ON_TIME = os.environ.get("OMNIVOICE_START_ON_TIME", "1") not in ("0", "false", "False")
START_DROP_DB = float(os.environ.get("OMNIVOICE_START_DROP_DB", "28"))
#: Was 0.08, which meant anything under 80ms was left alone - and measured on job
#: fno0wbe7 that is where nearly all of it lived: leading silence median 30ms, p90 105ms,
#: 149 of 168 clips over 20ms. The floor now sits just under the audible-offset budget
#: instead of above it.
START_MIN_S = float(os.environ.get("OMNIVOICE_START_MIN_S", "0.008"))
START_MAX_S = float(os.environ.get("OMNIVOICE_START_MAX_S", "1.50"))
START_MIN_KEEP_S = float(os.environ.get("OMNIVOICE_START_MIN_KEEP_S", "0.15"))
#: Was 0.03. The pre-roll is deliberately kept - a word-initial fricative or stop
#: closure is low energy and belongs to the word - but 30ms of it on a 10ms grid could
#: not land inside a 20ms budget. 12ms can.
START_PREROLL_S = float(os.environ.get("OMNIVOICE_START_PREROLL_S", "0.010"))
#: Envelope resolution. Was hard-coded at 10ms, which quantised every answer to 10ms
#: and, with the 3-frame run test, needed 30ms of sustained energy before it would
#: believe speech had started.
START_HOP_S = float(os.environ.get("OMNIVOICE_START_HOP_S", "0.005"))
#: How much sustained energy counts as the start (was 3 frames = 30ms). Held at 30ms in
#: TIME, not frames, so the finer hop buys resolution without making a click look like
#: a word.
START_RUN_S = float(os.environ.get("OMNIVOICE_START_RUN_S", "0.030"))
#: THE SAFETY PROPERTY, now checked rather than assumed: whatever is removed must be at
#: least this far below the clip's own speech level. The cut is walked back until it is,
#: so a quiet word onset is never eaten - it is better to leave 40ms of silence than to
#: remove 5ms of a word.
START_VERIFY_DB = float(os.environ.get("OMNIVOICE_START_VERIFY_DB", "20"))


def front_silence(audio, sr):
    """Seconds of near-silence at the front. 0.0 when there is nothing worth removing."""
    if not START_ON_TIME:
        return 0.0
    try:
        import numpy as np
        x = audio
        if hasattr(x, "detach"):
            x = x.detach().cpu().float().numpy()
        x = np.asarray(x, dtype="float32")
        if x.ndim > 1:
            x = x.mean(axis=0)
        n = len(x)
        if n < int(sr * 0.25):
            return 0.0
        h = max(1, int(sr * START_HOP_S))
        m = (n // h) * h
        if m < h * 5:
            return 0.0
        e = np.sqrt((x[:m].reshape(-1, h) ** 2).mean(axis=1) + 1e-12)
        d = 20.0 * np.log10(e + 1e-9)
        loud = float(d.max())
        thr = loud - START_DROP_DB
        need = max(1, int(round(START_RUN_S / max(START_HOP_S, 1e-6))))
        run, first = 0, None
        for i, v in enumerate(d):
            if v >= thr:
                run += 1
                if run >= need:
                    first = (i - need + 1) * START_HOP_S
                    break
            else:
                run = 0
        if first is None:
            return 0.0
        cut = max(0.0, first - START_PREROLL_S)
        if cut < START_MIN_S:
            return 0.0
        cut = min(cut, START_MAX_S)
        if (n / float(sr)) - cut < START_MIN_KEEP_S:
            return 0.0
        # Verify, do not assume: the removed audio must be well below this clip's own
        # speech level. Walk the cut back a frame at a time until it is, so a low-energy
        # word onset that the RMS envelope missed is kept rather than deleted.
        k = int(cut * sr)
        while k > 0:
            seg = x[:k]
            peak = 20.0 * np.log10(float(np.max(np.abs(seg))) + 1e-9)
            if peak <= loud - START_VERIFY_DB:
                break
            k -= h
        cut = max(0.0, k / float(sr))
        if cut < START_MIN_S:
            return 0.0
        return float(cut)
    except Exception as e:  # noqa: BLE001
        logger.debug("head language: leading silence check skipped: %s", e)
        return 0.0
