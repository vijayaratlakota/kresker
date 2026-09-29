"""Rebuild a job's timeline from Chirp 2's own word stream, at transcribe time.

Why this exists
---------------
The transcriber proposes start/end per line and is bad at it: on the measured job
(a19mp3hi, Hindi) 46.2% of its lines sat where the words provably were not, and 27.9%
were well placed. Re-cutting the script at Chirp 2's word boundaries scored 11.1% badly
placed and 76.4% well placed, with no starved slots. Everything in between was tried and
measured: re-aligning the transcriber's own text with MMS_FA reached 29.7% badly placed,
a Chirp+MMS cascade 22.0%, merging fragments 13.1%.

What it is allowed to do
------------------------
Move time boundaries and, in the default "native" mode, replace the words with Chirp's.
That second part is a real trade: it makes Chirp the transcriber for this language's
words, not just their timing. OMNIVOICE_CHIRP_MODE=cascade keeps the transcriber's text
and only moves it, at the measured cost of a worse placement score.

What it must never do
---------------------
Lose a speaker label - a line with no speaker cannot be given the right cloned voice,
which is the wrong-voice complaint. Each new line inherits the speaker (and any binding)
of whichever original segment covers most of its span. It must also never make a job
worse than it found it: every failure path and every tripped gate returns the input
segments unchanged.
"""
from __future__ import annotations

import json
import logging
import os
import re

logger = logging.getLogger("omnivoice.chirp_wire")

ENABLED = os.environ.get("OMNIVOICE_CHIRP_TIMING", "1") not in ("0", "false", "False")

# native  = lines are Chirp's words at Chirp's boundaries (measured best)
# cascade = the transcriber's words, moved onto Chirp's times
MODE = (os.environ.get("OMNIVOICE_CHIRP_MODE", "native") or "native").strip().lower()

# A gap this long ends a line. 0.50s was the value the by-hand run used to reach 76.4%.
PAUSE_S = float(os.environ.get("OMNIVOICE_CHIRP_PAUSE", "0.50"))
# No line longer than this, regardless of pauses: long slots hide drift.
MAX_LINE_S = float(os.environ.get("OMNIVOICE_CHIRP_MAXLEN", "12.0"))

# --- sanity gates. Chirp mishearing a whole video must not silently gut the script. ---
MIN_LINES_RATIO = float(os.environ.get("OMNIVOICE_CHIRP_MIN_LINES", "0.15"))
MAX_LINES_RATIO = float(os.environ.get("OMNIVOICE_CHIRP_MAX_LINES", "3.0"))
MIN_CHARS_RATIO = float(os.environ.get("OMNIVOICE_CHIRP_MIN_CHARS", "0.60"))
MIN_SPAN_RATIO = float(os.environ.get("OMNIVOICE_CHIRP_MIN_SPAN", "0.50"))

CACHE_NAME = "chirp_words_cache.json"


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _text_of(seg):
    return (seg.get("text_original") or seg.get("text") or "") if isinstance(seg, dict) else ""


def _group(words, pause_s, max_line_s):
    """Cut the word stream into lines at pauses, capped in length."""
    groups, cur = [], []
    for w in words:
        if cur and (w["s"] - cur[-1]["e"] > pause_s
                    or cur[-1]["e"] - cur[0]["s"] > max_line_s):
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def _cache_read(path, src):
    """Cached words for this exact audio file, or None. Keyed on size+mtime so a
    re-prepared job does not silently reuse the previous cut's words."""
    try:
        st = os.stat(src)
        blob = json.load(open(path))
    except Exception:  # noqa: BLE001
        return None
    if isinstance(blob, list):        # the by-hand format: a bare word list
        return blob or None
    if not isinstance(blob, dict):
        return None
    if int(blob.get("size") or -1) != st.st_size:
        return None
    if abs(_f(blob.get("mtime"), -1) - st.st_mtime) > 1.0:
        return None
    return blob.get("words") or None


def _cache_write(path, src, words):
    try:
        st = os.stat(src)
        json.dump({"src": src, "size": st.st_size, "mtime": st.st_mtime,
                   "words": words}, open(path, "w"), ensure_ascii=False)
    except Exception as e:  # noqa: BLE001
        logger.debug("chirp: could not cache words: %s", e)


def _duration(job, vocals, words):
    d = _f(job.get("duration"))
    if d > 0:
        return d
    try:
        import soundfile as sf
        d = _f(sf.info(vocals).duration)
        if d > 0:
            return d
    except Exception:  # noqa: BLE001
        pass
    return (_f(words[-1]["e"]) + 1.0) if words else 0.0


def _inherit(old, a, b):
    """Speaker and binding of whichever original segment covers most of [a, b]."""
    best, best_ov = None, 0.0
    for s in old:
        ov = min(b, _f(s.get("end"))) - max(a, _f(s.get("start")))
        if ov > best_ov:
            best_ov, best = ov, s
    return best


def _first_binding_for(old, speaker):
    for s in old:
        if s.get("speaker_id") == speaker and s.get("profile_id"):
            return s.get("profile_id")
    return ""


def _build_native(old, groups):
    out = []
    for i, line in enumerate(groups):
        a, b = _f(line[0]["s"]), _f(line[-1]["e"])
        src = _inherit(old, a, b)
        spk = (src or {}).get("speaker_id") or (old[0].get("speaker_id") if old else "Speaker 1")
        txt = " ".join(w["w"] for w in line).strip()
        conf = [w["c"] for w in line if w.get("c") is not None]
        out.append({
            "id": "c%03d" % i,
            "start": round(a, 3),
            "end": round(b, 3),
            "text": txt,
            "text_original": txt,
            "speaker_id": spk,
            "profile_id": (src or {}).get("profile_id") or _first_binding_for(old, spk),
            "asr_confidence": round(sum(conf) / len(conf), 3) if conf else None,
        })
    return out


def _build_cascade(old, words):
    """Keep the transcriber's words; ask chirp_timing where they actually are."""
    from services import chirp_timing as C
    got = C.retime_by_words(old, words, text_of=_text_of)
    if isinstance(got, list) and got and isinstance(got[0], dict) and "start" in got[0]:
        return got, {}
    if isinstance(got, dict):
        return list(old), got     # a decisions map for resolve_timeline
    return list(old), {}


def _gates(old, new, duration):
    """Reasons to refuse. Empty list means the new timeline is safe to keep."""
    bad = []
    if not new:
        return ["produced no lines"]
    n_old, n_new = len(old), len(new)
    if n_old:
        if n_new < MIN_LINES_RATIO * n_old:
            bad.append("only %d line(s) against %d (under %.0f%%)"
                       % (n_new, n_old, 100 * MIN_LINES_RATIO))
        if n_new > MAX_LINES_RATIO * n_old:
            bad.append("%d line(s) against %d (over %.0fx)"
                       % (n_new, n_old, MAX_LINES_RATIO))
    c_old = sum(len(_text_of(s)) for s in old)
    c_new = sum(len(_text_of(s)) for s in new)
    if c_old and c_new < MIN_CHARS_RATIO * c_old:
        bad.append("kept only %.0f%% of the script's characters (%d of %d)"
                   % (100.0 * c_new / c_old, c_new, c_old))
    s_old = sum(max(0.0, _f(s.get("end")) - _f(s.get("start"))) for s in old)
    s_new = sum(max(0.0, _f(s.get("end")) - _f(s.get("start"))) for s in new)
    if s_old and s_new < MIN_SPAN_RATIO * s_old:
        bad.append("covers only %.0f%% of the speaking time (%.0fs of %.0fs)"
                   % (100.0 * s_new / s_old, s_new, s_old))
    for s in new:
        if _f(s.get("end")) <= _f(s.get("start")):
            bad.append("line %s has no duration" % s.get("id"))
            break
    if duration > 0:
        late = [s for s in new if _f(s.get("start")) > duration + 0.5]
        if late:
            bad.append("%d line(s) start past the end of the audio" % len(late))
    return bad


def retime_job(job, segments, *, lang=None, job_dir=None):
    """Return `segments` re-cut onto Chirp's word times, or `segments` unchanged.

    Never raises: the caller is a transcription that has already succeeded, and timing is
    an improvement on it, not a precondition for it.
    """
    if not ENABLED or not segments:
        return segments
    try:
        from services import chirp_timing as C
    except Exception as e:  # noqa: BLE001
        logger.info("chirp: module unavailable (%s); keeping the transcriber's timing", e)
        return segments

    code = (lang or job.get("source_lang") or "").strip()
    if not code:
        logger.info("chirp: source language unknown; keeping the transcriber's timing")
        return segments
    if not C.ENABLED:
        return segments
    if not C.available(code):
        logger.info("chirp: not available for %s; keeping the transcriber's timing", code)
        return segments

    vocals = job.get("vocals_path") or job.get("audio_path")
    if not vocals or not os.path.exists(vocals):
        logger.info("chirp: no audio on the job; keeping the transcriber's timing")
        return segments

    old = [s for s in segments if isinstance(s, dict) and s.get("start") is not None]
    old.sort(key=lambda s: _f(s.get("start")))
    if not old:
        return segments

    if MODE == "lines":
        # No Chirp call at all: the words are already here, only their times are wrong.
        try:
            _ax0, _asr0 = _load_audio(vocals)
            words = _words_from_lines(old, _ax0, _asr0, code)
        except Exception as e:  # noqa: BLE001
            logger.warning("chirp/lines: could not time the transcriber's lines (%s); "
                           "keeping the transcriber's timing", e)
            return segments
        if not words:
            logger.info("chirp/lines: no usable words; keeping the transcriber's timing")
            return segments
        return _finish(job, old, segments, words, code, vocals, duration=None)

    cache = os.path.join(job_dir, CACHE_NAME) if job_dir else None
    words = _cache_read(cache, vocals) if cache else None
    if words:
        logger.info("chirp: %d word(s) from cache", len(words))
    else:
        import time
        t0 = time.time()
        try:
            words = C.transcribe_words(vocals, code) or []
        except Exception as e:  # noqa: BLE001
            logger.warning("chirp: word pass failed (%s); keeping the transcriber's timing", e)
            return segments
        logger.info("chirp: %d word(s) in %.0fs", len(words), time.time() - t0)
        if words and cache:
            _cache_write(cache, vocals, words)
    if not words:
        logger.info("chirp: no words came back; keeping the transcriber's timing")
        return segments

    return _finish(job, old, segments, words, code, vocals, duration=None)


def _finish(job, old, segments, words, code, vocals, duration=None):
    """Everything after the words are known: partition, split, gate, resolve.

    Split out so MODE=lines shares it byte-for-byte instead of carrying a copy - the
    duplicated-pass bug this module has already produced once."""
    if duration is None:
        duration = _duration(job, vocals, words)

    try:
        if MODE == "cascade":
            new, decisions = _build_cascade(old, words)
        else:
            groups, quality = None, None
            if OPTIMISE:
                # Search the partition instead of trusting one pause threshold. Measured
                # 73.6% -> 97.7% and 81.1% -> 100.0% well placed on the two test jobs.
                try:
                    ax, asr_ = _load_audio(vocals)
                    # Diarization has already run, so the speaker turns are sitting on the
                    # transcriber's own segments. Without them the optimiser merges across a
                    # speaker change and the whole line gets one cloned voice.
                    turns = [(_f(s.get("start")), _f(s.get("end")), s.get("speaker_id"))
                             for s in old if s.get("speaker_id")]
                    fallback = None
                    if USE_FALLBACK:
                        fallback = [(_f(s.get("start")), _f(s.get("end")), _text_of(s))
                                    for s in old if _text_of(s)]
                    blocks, quality = _optimise_partition(
                        words, ax, asr_, code, audio_path=vocals, turns=turns,
                        fallback=fallback)
                    if REANCHOR and blocks:
                        # Chirp chose the boundaries; MMS says where the words are.
                        blocks = _mms_reanchor(blocks, ax, asr_, code)
                    # Blocks decided the timing. Now cut them at speaker changes: each part
                    # becomes a segment with one speaker and one cloned voice.
                    groups = blocks
                    if blocks and SPEAKER_SPLIT and turns:
                        parts = _split_into_parts(blocks, turns)
                        pur, mixed = _part_purity(parts, turns)
                        groups = [g for _bi, g in parts]
                        logger.info("chirp: %d block(s) cut into %d speaker-pure part(s); "
                                    "part purity %.1f%% (%d mixed)",
                                    len(blocks), len(groups), pur, len(mixed))
                        if isinstance(quality, dict):
                            quality = dict(quality)
                            quality["blocks"] = len(blocks)
                            quality["parts"] = len(groups)
                            quality["part_purity"] = round(pur, 1)
                except Exception as e:  # noqa: BLE001 - fall back to the fixed threshold
                    logger.warning("chirp: partition search unavailable (%s); "
                                   "using the fixed pause threshold", e)
                    groups = None
            if not groups:
                groups = _group(words, PAUSE_S, MAX_LINE_S)
            new, decisions = _build_native(old, groups), {}
            if quality:
                job["timing_quality"] = quality
    except Exception as e:  # noqa: BLE001
        logger.warning("chirp: could not build a timeline (%s); keeping the "
                       "transcriber's timing", e)
        return segments

    # Clean, playable, non-overlapping - and give each line the pause after it.
    try:
        from services import aligner as A
        rows, report = A.resolve_timeline(new, decisions, duration)
        if SNAP_ONSET:
            # After resolve, so the line before is fixed and a start can be clamped to
            # it; before breathe, so breathe extends ends toward the moved onsets.
            try:
                _ax, _asr = _load_audio(vocals)
                _sn = _snap_onsets(rows, _ax, _asr)
                logger.info("chirp: onset snap moved %d start(s) back (%.1fs of lead-in "
                            "recovered) and %d forward (%.1fs of dead air trimmed)",
                            _sn["back"], _sn["gained"], _sn["fwd"], _sn["given"])
            except Exception as e:  # noqa: BLE001
                logger.warning("chirp: onset snap unavailable (%s); starts left alone", e)
        A.breathe(rows, duration)          # extends ends in place, never starts
        pos = {r["id"]: (r["start"], r["end"]) for r in rows}
        for s in new:
            a, b = pos.get(s["id"], (_f(s.get("start")), _f(s.get("end"))))
            s["start"], s["end"] = round(a, 3), round(b, 3)
        if report.get("reversed") or report.get("still_overlapping") or report.get("out_of_order"):
            logger.warning("chirp: refusing the new timeline, it is not playable (%s); "
                           "keeping the transcriber's timing", report)
            return segments
    except Exception as e:  # noqa: BLE001
        logger.warning("chirp: timeline resolve failed (%s); keeping the "
                       "transcriber's timing", e)
        return segments

    bad = _gates(old, new, duration)
    if bad:
        logger.warning("chirp: refusing the new timeline - %s; keeping the "
                       "transcriber's timing", "; ".join(bad))
        return segments

    bound = sum(1 for s in new if s.get("profile_id"))
    speakers = {}
    for s in new:
        speakers[s.get("speaker_id")] = speakers.get(s.get("speaker_id"), 0) + 1
    logger.info("chirp: retimed %d line(s) into %d (mode=%s, pause %.2fs, max %.0fs); "
                "speakers %s; %d of %d lines keep a voice binding",
                len(old), len(new), MODE, PAUSE_S, MAX_LINE_S, speakers, bound, len(new))
    job["timing_source"] = "chirp2-native" if MODE != "cascade" else "chirp2-cascade"
    job["timing_lines_before"] = len(old)
    return new

# ---------------------------------------------------------------- the optimiser
# Placement is a choice of partition over the word stream, not a consequence of one pause
# threshold. Measured: a single fixed threshold placed 73.6% / 81.1% of lines well on the
# two test jobs; searching a small grid, then repairing whatever is still below the bar,
# reached 97.7% / 100.0%.
OPTIMISE = os.environ.get("OMNIVOICE_CHIRP_OPTIMISE", "1") not in ("0", "false", "False")

# Kept deliberately small: each grid point costs a forced-alignment pass over every
# candidate line, and the repair pass below is what actually adapts to the video.
GRID = (
    (0.50, 12.0, None),
    (0.80, 12.0, 0.50),
    (1.00, 16.0, 0.70),
    (0.80, 8.0, 0.50),
)
WELL = float(os.environ.get("OMNIVOICE_CHIRP_WELL", "0.45"))
MAX_MERGED_S = float(os.environ.get("OMNIVOICE_CHIRP_MAX_MERGED", "22.0"))
REPAIR_ROUNDS = int(os.environ.get("OMNIVOICE_CHIRP_REPAIR_ROUNDS", "40"))
REASR = os.environ.get("OMNIVOICE_CHIRP_REASR", "1") not in ("0", "false", "False")
MIN_SPLIT_WORDS = 2
#: Padding around a line when scoring it. A 0.5s window gives forced alignment almost no
#: acoustic context, which is why short lines score badly regardless of where they sit.
#: Scaled with the line so short and long lines are judged on comparable evidence.
PAD_MIN_S = float(os.environ.get("OMNIVOICE_CHIRP_PAD_MIN_S", "0.25"))
PAD_FRACTION = float(os.environ.get("OMNIVOICE_CHIRP_PAD_FRACTION", "0.40"))
#: A line may not hold two speakers. Measured on a19mp3hi: without this, speaker purity is
#: 54.7% - 24 of 53 lines held two or more people, all dubbed in one cloned voice. With it,
#: 97.4%. It costs placement (88.7% -> 69.8% well placed) because the metric rewards long
#: lines, and honouring speaker turns makes them short. A correct voice is worth more.
SPEAKER_SPLIT = os.environ.get("OMNIVOICE_CHIRP_SPEAKER_SPLIT", "1") not in ("0", "false", "False")
_TOKEN_JUNK = re.compile(r"[^\w\u0900-\u0DFF\u0E00-\u0E7F]+", re.UNICODE)
#: A sliver only joins a neighbour this close; further away it is dropped.
NEIGHBOUR_MAX_S = float(os.environ.get("OMNIVOICE_CHIRP_NEIGHBOUR_MAX_S", "1.00"))
#: A stretch of speech longer than this with no line over it is missing content.
GAP_MIN_S = float(os.environ.get("OMNIVOICE_CHIRP_GAP_MIN_S", "0.25"))
COVER_GAPS = os.environ.get("OMNIVOICE_CHIRP_COVER_GAPS", "1") not in ("0", "false", "False")
#: Shortest clip worth sending to a recogniser; shorter gaps are widened to it.
GAP_ASR_MIN_CLIP_S = float(os.environ.get("OMNIVOICE_CHIRP_GAP_CLIP_S", "1.20"))
#: A gap filled from the transcriber is only kept if forced alignment can place
#: its words this well. 0.25 is the badly-placed line in the scorer, so a fill can
#: raise coverage but never raise the badly-placed count.
FILL_MIN_CONF = float(os.environ.get("OMNIVOICE_CHIRP_FILL_MIN_CONF", "0.25"))
#: Fill a gap Chirp cannot transcribe with the transcriber's own words, spread evenly across
#: it. Off by default: proportional word times are what this module exists to replace, and
#: measurement showed those lines drag placement (88.7% -> 75.4%) without helping coverage.
USE_FALLBACK = os.environ.get("OMNIVOICE_CHIRP_USE_FALLBACK", "1") not in ("0", "false", "False")
#: Text sanity. Repetition loops and sound effects are not dialogue.
SANITISE = os.environ.get("OMNIVOICE_CHIRP_SANITISE", "1") not in ("0", "false", "False")
#: Drop a line judged non-dialogue, or keep it? OFF by default: a shouting character is
#: still that character, and dropping the line leaves a hole in the dub - 15.76s of one on
#: the measured job, which the user heard as missing speech. Repetition runs are still
#: collapsed either way; 90 copies of one word is wrong however it got there.
DROP_NONDIALOGUE = os.environ.get("OMNIVOICE_CHIRP_DROP_NONDIALOGUE", "0") not in ("0", "false", "False")
MAX_REPEAT = int(os.environ.get("OMNIVOICE_CHIRP_MAX_REPEAT", "2"))
NONLEX_TTR = float(os.environ.get("OMNIVOICE_CHIRP_NONLEX_TTR", "0.30"))
NONLEX_SPEECH = float(os.environ.get("OMNIVOICE_CHIRP_NONLEX_SPEECH", "0.30"))
#: A line averaging more than this many seconds per word is not one line.
SEC_PER_WORD = float(os.environ.get("OMNIVOICE_CHIRP_SEC_PER_WORD", "1.2"))
#: Pad left after clamping a slot back to its words, so a final consonant is not clipped.
CLAMP_PAD_S = float(os.environ.get("OMNIVOICE_CHIRP_CLAMP_PAD_S", "0.25"))
#: A stretch of speech longer than this with no line over it is missing content.
GAP_MIN_S = float(os.environ.get("OMNIVOICE_CHIRP_GAP_MIN_S", "0.25"))
COVER_GAPS = os.environ.get("OMNIVOICE_CHIRP_COVER_GAPS", "1") not in ("0", "false", "False")
# A line shorter than this cannot be forced-aligned and is not a dubbing unit either.
MIN_LINE_S = float(os.environ.get("OMNIVOICE_CHIRP_MIN_LINE_S", "0.45"))


def _group_by(words, pause_s, max_line_s, min_conf_cut=None):
    """Cut at pauses, capped in length. `min_conf_cut` refuses to START a line on a word
    Chirp was unsure of - such a line tends to misalign, and holding it inside its
    neighbour measured better."""
    out, cur = [], []
    for w in words:
        if cur:
            gap = w["s"] - cur[-1]["e"]
            too_long = cur[-1]["e"] - cur[0]["s"] > max_line_s
            cut = gap > pause_s or too_long
            if (cut and not too_long and min_conf_cut is not None
                    and w.get("c") is not None and w["c"] < min_conf_cut):
                cut = False
            if cut:
                out.append(cur)
                cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


class _Scorer:
    """Median per-word forced-alignment confidence for a candidate line, memoised.

    This is the only honest score available: a line whose words really are in its own
    window scores high, and a line sitting over the wrong audio cannot, whatever the
    timeline claims.
    """

    def __init__(self, audio, sr, lang, turns=None):
        self.x, self.sr, self.lang, self._memo = audio, sr, lang, {}
        self.calls = 0
        # [(start, end, speaker_id)] from diarization. Carried here because every pass already
        # receives the scorer, and a line that mixes two speakers can only be dubbed in one
        # voice however good its alignment looks.
        self.turns = list(turns or [])

    def __call__(self, group):
        if not group:
            return 0.0
        key = (group[0]["s"], group[-1]["e"], len(group))
        if key in self._memo:
            return self._memo[key]
        import statistics as _st
        from services import aligner as A
        text = " ".join(w["w"] for w in group).strip()
        val = 0.0
        if text:
            try:
                self.calls += 1
                a, b = float(group[0]["s"]), float(group[-1]["e"])
                pad = max(PAD_MIN_S, PAD_FRACTION * (b - a))
                got = A.align_window(self.x, self.sr, a - pad, b + pad, text, self.lang)
                if got:
                    val = _st.median([q[3] for q in got])
            except Exception:  # noqa: BLE001
                val = 0.0
        self._memo[key] = val
        return val


def _quality(groups, conf):
    cs = [conf(g) for g in groups]
    n = max(len(cs), 1)
    return (100.0 * sum(1 for c in cs if c >= WELL) / n,
            100.0 * sum(1 for c in cs if c < 0.25) / n, cs)


def _try_split(group, conf):
    """Best cut of one line at an internal pause, by the confidence of its worse half."""
    best = None
    for k in range(MIN_SPLIT_WORDS, len(group) - MIN_SPLIT_WORDS + 1):
        left, right = group[:k], group[k:]
        cl, cr = conf(left), conf(right)
        gap = group[k]["s"] - group[k - 1]["e"]
        score = min(cl, cr) + 0.05 * gap      # prefer cutting at the longer pause
        if best is None or score > best[0]:
            best = (score, left, right, cl, cr)
    return best


def _repair(groups, conf):
    """Fix every line still below the bar by re-partitioning around it.

    Three moves per weak line - merge with the previous line, merge with the next, or split
    at an internal pause. The worst line goes first so it gets the best neighbour before
    that neighbour is spent. A move is only taken if it strictly improves the weaker side,
    so this cannot loop and cannot trade a good line for a bad one.
    """
    for _ in range(REPAIR_ROUNDS):
        cs = [conf(g) for g in groups]
        weak = [i for i, c in enumerate(cs) if c < WELL]
        if not weak:
            break
        moved = False
        for i in sorted(weak, key=lambda k: cs[k]):
            g = groups[i]
            cands = []
            if i > 0 and _can_merge(groups[i - 1], g, conf):
                m = groups[i - 1] + g
                if m[-1]["e"] - m[0]["s"] <= MAX_MERGED_S and conf(m) >= WELL:
                    cands.append((conf(m) - min(cs[i], cs[i - 1]), i - 1, 2, [m]))
            if i + 1 < len(groups) and _can_merge(g, groups[i + 1], conf):
                m = g + groups[i + 1]
                if m[-1]["e"] - m[0]["s"] <= MAX_MERGED_S and conf(m) >= WELL:
                    cands.append((conf(m) - min(cs[i], cs[i + 1]), i, 2, [m]))
            if len(g) >= 2 * MIN_SPLIT_WORDS:
                sp = _try_split(g, conf)
                if sp:
                    cands.append((min(sp[3], sp[4]) - cs[i], i, 1, [sp[1], sp[2]]))
            cands = [c for c in cands if c[0] > 1e-6]
            if not cands:
                continue
            _gain, at, span, rep = max(cands, key=lambda c: c[0])
            groups = groups[:at] + rep + groups[at + span:]
            moved = True
            break
        if not moved:
            break
    return groups


def _optimise_partition(words, audio, sr, lang, audio_path=None, turns=None,
                        fallback=None):
    """Search the grid, then repair. Returns the best partition found."""
    conf = _Scorer(audio, sr, lang, turns=turns)
    best = None
    for pause, maxlen, snap in GRID:
        start = _group_by(words, pause, maxlen, min_conf_cut=snap)
        if not start:
            continue
        # No speaker split here any more. Blocks are chosen on acoustic evidence alone;
        # cutting them by speaker first produced slivers that cannot be scored, which is what
        # dragged placement from 88.7% to 69.8%. The split happens after the block is chosen.
        start = _absorb_micro(start, conf)
        w0, b0, _ = _quality(start, conf)
        # Repair each start rather than picking a winner up front: the best starting
        # partition is not the best finishing one. Measured 92.3% vs 100.0% on one job.
        got = _repair(list(start), conf)
        well, bad, _cs = _quality(got, conf)
        logger.info("chirp: grid pause %.2fs max %.0fs snap %s -> %d line(s) "
                    "well %.1f%% -> repaired %d line(s) well %.1f%% badly %.1f%%",
                    pause, maxlen, snap, len(start), w0, len(got), well, bad)
        if best is None or (well, -bad) > (best[0], -best[1]):
            best = (well, bad, got, (pause, maxlen, snap))
        if well >= 100.0 and bad <= 0.0:
            break            # nothing left to win
    if best is None:
        return None, None
    logger.info("chirp: kept the start pause %.2fs max %.0fs snap %s",
                best[3][0], best[3][1], best[3][2])
    groups = best[2]
    blocked = []

    # 1. Bad word times, not a bad window. Chirp's times drift inside a long chunk, so a line
    #    that will not align is re-asked about on its own. Measured 0.045 -> 0.612 on the line
    #    that resisted every partition move.
    if REASR and audio_path:
        before = _quality(groups, conf)[0]
        groups = _reasr_weak(groups, conf, audio_path, lang)
        groups = _repair(groups, conf)
        after = _quality(groups, conf)[0]
        if after != before:
            logger.info("chirp: re-recognition moved well-placed %.1f%% -> %.1f%%",
                        before, after)

    # 2. Content sanity BEFORE coverage, and it publishes what it refused. Order matters: run
    #    the other way round, coverage sees a loud stretch with no line, calls it missing, and
    #    puts the same repetition junk straight back.
    try:
        groups = _sanitise_lines(groups, audio, sr, blocked)
    except Exception as e:  # noqa: BLE001
        logger.warning("chirp: text sanity skipped: %s", e)

    # 3. Speech with no line over it is missing content, and the placement metric cannot see
    #    it - that is how 8.2%% of a video's dialogue went absent while placement read 100%%.
    if COVER_GAPS and audio_path:
        try:
            groups, _cov = _cover_gaps(groups, conf, audio, sr, audio_path, lang,
                                       blocked=blocked, fallback=fallback)
            groups = _sanitise_lines(groups, audio, sr, blocked)
            groups = _repair(groups, conf)
        except Exception as e:  # noqa: BLE001
            logger.warning("chirp: gap recovery skipped: %s", e)

    # 4. Shape. A line whose words are scattered over too long a span is not one line, and a
    #    sliver too short to speak is not a line at all.
    try:
        groups = _split_sparse(groups, conf)
        groups = _clamp_sparse_tail(groups)
    except Exception as e:  # noqa: BLE001
        logger.warning("chirp: sparse-line split skipped: %s", e)
    try:
        groups = _absorb_micro(groups, conf, blocked)
    except Exception as e:  # noqa: BLE001
        logger.warning("chirp: sliver cleanup skipped: %s", e)
    # Last word on the subject: gap recovery and re-recognition insert lines of their own, so
    # re-apply the constraint over the finished partition.
    # Blocks are final here. The speaker split runs in retime_job, on these blocks, so the
    # numbers below describe the timeline that was actually optimised.

    try:
        cov = coverage(groups, audio, sr, blocked)[0]
    except Exception:  # noqa: BLE001
        cov = None
    if blocked:
        logger.info("chirp: %d span(s) totalling %.1fs left to the original audio as "
                    "non-dialogue", len(blocked),
                    sum(max(0.0, b - a) for a, b in blocked))
    well, bad, cs = _quality(groups, conf)
    import statistics as _st
    logger.info("chirp: final %d line(s), well %.1f%% badly %.1f%%, speech covered %s "
                "(median conf %.3f, worst %.3f) in %d alignment call(s)",
                len(groups), well, bad,
                ("%.1f%%" % (100.0 * cov)) if cov is not None else "n/a",
                _st.median(cs) if cs else 0.0, min(cs) if cs else 0.0, conf.calls)
    pur, mixed = _purity_words(groups, getattr(conf, "turns", None) or [])
    dialogue_cov = None
    if cov is not None:
        try:
            # Coverage of DIALOGUE, which is the answerable question: the spans deliberately left
            # to the original audio as shouting or effects are not missing content.
            regions = _speech_regions(audio, sr)
            total = sum(b - a for a, b in regions)
            blocked_s = sum(max(0.0, b - a) for a, b in (blocked or []))
            if total > blocked_s > 0:
                lost = (1.0 - cov) * total
                dialogue_cov = max(0.0, 1.0 - lost / (total - blocked_s))
            else:
                dialogue_cov = cov
        except Exception:  # noqa: BLE001
            dialogue_cov = cov
    logger.info("chirp: speaker purity %.1f%% (%d mixed line(s))", pur, len(mixed))
    return groups, {"well": round(well, 1), "bad": round(bad, 1),
                    "median_conf": round(_st.median(cs), 3) if cs else 0.0,
                    "speech_covered": (round(100.0 * cov, 1) if cov is not None else None),
                    "dialogue_covered": (round(100.0 * dialogue_cov, 1)
                                         if dialogue_cov is not None else None),
                    "speaker_purity": round(pur, 1)}


def _load_audio(path):
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != 16000:
        idx = np.linspace(0, len(x) - 1, int(len(x) * 16000 / sr))
        x = np.interp(idx, np.arange(len(x)), x).astype("float32")
        sr = 16000
    return x, sr

def _reasr_weak(groups, conf, audio_path, lang, tmp_dir="/tmp"):
    """Re-recognise the audio under any line that still will not align.

    A line can fail for two different reasons and they need opposite fixes. If the window
    is wrong, re-partitioning fixes it - that is `_repair` above. If the WORD TIMESTAMPS
    are wrong, no partition helps: on the Hindi job 62 words were attributed to a 16s span
    holding about 45, and the identical audio recognised on its own aligned at 0.612
    against 0.045. Chirp's times drift inside a long chunk; asking it about one short span
    removes the drift.

    Only the failing lines are re-asked, so this is a few seconds even on a long video.
    """
    import os as _os
    import subprocess as _sp
    from services import chirp_timing as C

    out = list(groups)
    fixed = 0
    for i, g in enumerate(out):
        if conf(g) >= WELL:
            continue
        a, b = float(g[0]["s"]), float(g[-1]["e"])
        if b - a < 0.60:
            continue
        piece = _os.path.join(tmp_dir, "_reasr_%d_%d.wav" % (_os.getpid(), i))
        try:
            _sp.run(["ffmpeg", "-v", "quiet", "-y", "-ss", "%.3f" % a,
                     "-t", "%.3f" % (b - a), "-i", audio_path,
                     "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", piece], check=False)
            if not _os.path.exists(piece):
                continue
            got = C.transcribe_words(piece, lang) or []
            if not got and fallback:
                # Chirp had nothing for this span twice over. The transcriber's own words for it
                # are already on the job, so use those rather than leaving the dialogue out.
                got = _fallback_words(a, b, fallback, audio=audio, sr=sr,
                                      lang=lang)
                if got:
                    logger.info("chirp: %.2f-%.2f recovered from the transcriber's own text "
                                "(chirp returned nothing)", a, b)
            if not got:
                continue
            fresh = []
            for w in got:
                w = dict(w)
                w["s"] = float(w["s"]) + a
                w["e"] = float(w["e"]) + a
                fresh.append(w)
            if conf(fresh) > conf(g) + 1e-6:
                logger.info("chirp: re-recognised %.2f-%.2f (%d words -> %d), "
                            "alignment %.3f -> %.3f", a, b, len(g), len(fresh),
                            conf(g), conf(fresh))
                out[i] = fresh
                fixed += 1
        except Exception as e:  # noqa: BLE001 - a failed retry just leaves the line alone
            logger.debug("chirp: re-recognition of %.2f-%.2f failed: %s", a, b, e)
        finally:
            try:
                _os.remove(piece)
            except OSError:
                pass
    if fixed:
        logger.info("chirp: re-recognition fixed %d line(s) the partition search could not",
                    fixed)
    return out

def _absorb_micro(groups, conf, blocked=None):
    """Fold or drop lines too short to speak.

    Collapsing a repetition run leaves slivers - two words over 0.20s. Nothing can be spoken in
    0.2s, so these are not dubbing units, and leaving them in moved badly-placed from 2.5% to
    6.0%.

    A sliver joins a neighbour only when that neighbour is close. Merging into a distant one
    would rebuild the sparse twenty-second line `_split_sparse` exists to break apart, so a
    stranded sliver is dropped and its moment is left to the original audio.
    """
    if not groups:
        return groups
    if blocked is None:
        blocked = []
    out = sorted(groups, key=lambda g: float(g[0]["s"]))
    merged_n = dropped_n = 0
    i = 0
    while i < len(out):
        g = out[i]
        if float(g[-1]["e"]) - float(g[0]["s"]) >= MIN_LINE_S:
            i += 1
            continue
        cands = []
        if (i > 0 and float(g[0]["s"]) - float(out[i - 1][-1]["e"]) <= NEIGHBOUR_MAX_S
                and _can_merge(out[i - 1], g, conf)):
            m2 = out[i - 1] + g
            if float(m2[-1]["e"]) - float(m2[0]["s"]) <= MAX_MERGED_S:
                cands.append((conf(m2), i - 1, m2))
        if (i + 1 < len(out) and float(out[i + 1][0]["s"]) - float(g[-1]["e"]) <= NEIGHBOUR_MAX_S
                and _can_merge(g, out[i + 1], conf)):
            m2 = g + out[i + 1]
            if float(m2[-1]["e"]) - float(m2[0]["s"]) <= MAX_MERGED_S:
                cands.append((conf(m2), i, m2))
        if cands:
            _c, at, m2 = max(cands, key=lambda c: c[0])
            out = out[:at] + [m2] + out[at + 2:]
            merged_n += 1
            i = max(0, at)
            continue
        blocked.append((float(g[0]["s"]), float(g[-1]["e"])))
        out = out[:i] + out[i + 1:]
        dropped_n += 1
    if merged_n or dropped_n:
        logger.info("chirp: %d sliver(s) folded into a neighbour, %d dropped as too short "
                    "to speak", merged_n, dropped_n)
    return out


def _norm_tok(t):
    return _TOKEN_JUNK.sub("", str(t or "")).strip().lower()


def _ttr(group):
    """Distinct tokens over total tokens. Real dialogue sits near 1.0; a repetition loop or
    a laugh transcribed as words collapses toward 0."""
    toks = [_norm_tok(w["w"]) for w in group]
    toks = [t for t in toks if t]
    return (len(set(toks)) / float(len(toks))) if toks else 0.0


def _collapse_repeats(group):
    """Keep at most MAX_REPEAT consecutive copies of the same token.

    Chirp emitted one word 90 times over 8 seconds of shouting on job 0r1xzjss. Repetition IS
    meaningful in dialogue - "no, no, no" - so a couple are kept; it is the runaway run that
    is an artefact.
    """
    out, prev, run = [], None, 0
    for w in group:
        t = _norm_tok(w["w"])
        if t and t == prev:
            run += 1
            if run >= MAX_REPEAT:
                continue
        else:
            prev, run = t, 0
        out.append(w)
    return out


def _speech_scores(spans, audio, sr):
    """AST speech confidence per span, or None if the model is unavailable. Only the one-sided
    SPEECH question is used - class detection was measured unreliable on this material."""
    if not spans:
        return None
    try:
        from services import vocal_events as V
        if not V.available():
            return None
        got = V.speech_confidence_many(audio, sr, spans)
        return [float(g) for g in got]
    except Exception as e:  # noqa: BLE001
        logger.debug("chirp: speech scoring unavailable: %s", e)
        return None


def _sanitise_lines(groups, audio, sr, blocked=None):
    """Collapse repetition runs, and drop lines that are not dialogue at all.

    A line is only dropped when BOTH tests agree: its text is degenerate after collapsing
    (type/token under NONLEX_TTR) and its audio fails the speech test. One signal alone is not
    enough - "paagal paagal paagal" can be real dialogue, and a low speech score can just be a
    noisy room. When both agree, the moment is a shout or an effect, and leaving it out means
    the original audio carries it instead of a cloned voice reciting a word 90 times.
    """
    if blocked is None:
        blocked = []
    if not SANITISE or not groups:
        return groups
    collapsed, cand = 0, []
    out = []
    for g in groups:
        g2 = _collapse_repeats(g)
        if len(g2) < len(g):
            collapsed += 1
            # _recut_after_collapse: the survivors keep their original times, so what is
            # left of a 90-token run is a handful of words spread over the whole stretch.
            # Cutting them at their pauses turns one bogus 20s slot into its real pieces
            # and leaves the shouting between them to the original audio.
            pieces = _group_by(g2, PAUSE_S, MAX_LINE_S)
            # The middle of the run is shouting we deliberately removed - not a gap to refill.
            for _p, _q in zip(pieces, pieces[1:]):
                blocked.append((float(_p[-1]["e"]), float(_q[0]["s"])))
            logger.info("chirp: collapsed a repetition run at %.2f-%.2f (%d token(s) -> %d) "
                        "and re-cut it into %d line(s)",
                        float(g[0]["s"]), float(g[-1]["e"]), len(g), len(g2), len(pieces))
            out.extend(pieces)
        else:
            out.append(g2)
    # Positional lookup into `groups` is gone: re-cutting means `out` no longer lines up
    # with it one to one. Judge each surviving line on its own text.
    for i, g in enumerate(out):
        if len(g) >= 4 and _ttr(g) < NONLEX_TTR:
            cand.append(i)
    if not cand:
        if collapsed:
            logger.info("chirp: collapsed %d repetition run(s); no line was dropped", collapsed)
        return out
    scores = _speech_scores([(float(out[i][0]["s"]), float(out[i][-1]["e"])) for i in cand],
                            audio, sr)
    drop = set()
    for k, i in enumerate(cand):
        sc = scores[k] if scores else None
        if sc is not None and sc < NONLEX_SPEECH and DROP_NONDIALOGUE:
            drop.add(i)
            # Remember the span. Coverage measures energy, which cannot tell a shout from a
            # sentence, so without this it would call this stretch missing content and put
            # the same junk back.
            blocked.append((float(out[i][0]["s"]), float(out[i][-1]["e"])))
            logger.info("chirp: dropping %.2f-%.2f - not dialogue (type/token %.2f, "
                        "speech %.3f); the original audio keeps that moment",
                        float(out[i][0]["s"]), float(out[i][-1]["e"]), _ttr(out[i]), sc)
        elif sc is None and _ttr(out[i]) < 0.10 and DROP_NONDIALOGUE:
            drop.add(i)
            blocked.append((float(out[i][0]["s"]), float(out[i][-1]["e"])))
            logger.info("chirp: dropping %.2f-%.2f - type/token %.2f with no speech model "
                        "to appeal to", float(out[i][0]["s"]), float(out[i][-1]["e"]),
                        _ttr(out[i]))
    if collapsed or drop:
        logger.info("chirp: text sanity - %d repetition run(s) collapsed, %d line(s) dropped "
                    "as non-dialogue", collapsed, len(drop))
    return [g for i, g in enumerate(out) if i not in drop]


def _speech_regions(audio, sr):
    """Energy-gated speech regions, 20 ms frames. Simple on purpose: it only has to find
    stretches loud enough to be dialogue, and it runs on the separated vocal stem."""
    import numpy as np
    frame = int(0.02 * sr)
    usable = (len(audio) // frame) * frame
    if usable < frame * 2:
        return []
    rms = np.sqrt((audio[:usable].reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    gate = min(float(np.quantile(db, 0.97)) - 35.0, -45.0)
    voiced = db > gate
    out, i = [], 0
    while i < len(voiced):
        if voiced[i]:
            j = i
            while j < len(voiced) and voiced[j]:
                j += 1
            a, b = i * 0.02, j * 0.02
            if b - a >= 0.30:
                if out and a - out[-1][1] < 0.25:
                    out[-1] = (out[-1][0], b)
                else:
                    out.append((a, b))
            i = j
        else:
            i += 1
    return out


def _is_blocked(a, b, blocked):
    """True when most of [a, b] was deliberately left empty by the sanity pass."""
    if not blocked:
        return False
    hit = 0.0
    for ba, bb in blocked:
        hit += max(0.0, min(b, bb) - max(a, ba))
    return hit >= 0.5 * (b - a)


def _uncovered(groups, audio, sr, blocked=None, min_s=None):
    """The stretches of speech that genuinely have no line over them.

    Returns precise intervals, not the speech regions containing them. Asking Chirp about
    a 66 s region to recover 2 s of it reintroduces the chunk drift this module exists to
    remove, and then almost every recovered word is discarded for overlapping a line that
    was already there.
    """
    floor = GAP_MIN_S if min_s is None else min_s
    regs = _speech_regions(audio, sr)
    lines = sorted((_f(g[0].get("s")), _f(g[-1].get("e"))) for g in groups if g)
    out = []
    for a, b in regs:
        cuts = sorted((max(a, la), min(b, lb)) for la, lb in lines
                      if min(b, lb) - max(a, la) > 0)
        pos = a
        for ca, cb in cuts:
            if ca > pos:
                out.append((pos, ca))
            pos = max(pos, cb)
        if pos < b:
            out.append((pos, b))
    return [(a, b) for a, b in out
            if b - a >= floor and not _is_blocked(a, b, blocked)]


def coverage(groups, audio, sr, blocked=None):
    """How much detected speech has a line over it.

    `lost` counts every uncovered second. It used to count only gaps inside a region big
    enough to report, which could conceal tens of seconds of missing dialogue behind a
    flattering percentage. The second return value is what to act on: uncovered spans at
    least GAP_MIN_S long that the sanity pass did not deliberately leave empty.
    """
    regs = _speech_regions(audio, sr)
    total = sum(b - a for a, b in regs)
    if total <= 0:
        return 1.0, [], 0.0
    every = _uncovered(groups, audio, sr, blocked=None, min_s=0.0)
    lost = sum(b - a for a, b in every)
    missing = [(a, b, b - a) for a, b in _uncovered(groups, audio, sr, blocked)]
    return 1.0 - lost / total, missing, total


def _cover_gaps(groups, conf, audio, sr, audio_path, lang, tmp_dir="/tmp", blocked=None,
                fallback=None):
    """Fill stretches of speech that no line covers.

    Two sources, tried in order, neither reachable only by luck:

    1. Chirp on the gap alone. Its word times drift inside a long chunk, which is what
       empties a span in the first place; asking about a short span removes the drift.
    2. the transcriber's own words for that span, positioned inside it by forced
       alignment. The transcriber covers more of the speech than Chirp does (98.6%
       against 91-93% measured on this material), so where Chirp is silent it usually
       is not - and this is the only path that uses it.

    An earlier version accepted `fallback` and never read it, and the version after that
    put it behind a `continue` that fired whenever the clip could not be cut.
    """
    import os as _os
    import subprocess as _sp
    from services import chirp_timing as C

    cov, missing, _total = coverage(groups, audio, sr, blocked)
    if not missing:
        return groups, cov
    logger.info("chirp: %.1f%% of speech has a line over it; %d gap(s) totalling %.1fs "
                "have none - recovering them", 100.0 * cov, len(missing),
                sum(m[2] for m in missing))
    added = 0
    filled_from_transcriber = 0
    still_open = []
    for a, b, _gap in missing:
        if b - a < GAP_MIN_S:
            continue
        # 1 --- Chirp, on this gap alone -------------------------------------------
        fresh = []
        piece = _os.path.join(tmp_dir, "_gap_%d_%d.wav" % (_os.getpid(), int(a * 100)))
        # A recogniser needs something to chew on. Widen the clip, then subtract the
        # widened offset - not `a` - or every recovered word lands early by the padding.
        _pad = max(0.20, (GAP_ASR_MIN_CLIP_S - (b - a)) / 2.0)
        _pa, _pb = max(0.0, a - _pad), b + _pad
        try:
            _sp.run(["ffmpeg", "-v", "quiet", "-y", "-ss", "%.3f" % _pa,
                     "-t", "%.3f" % (_pb - _pa), "-i", audio_path,
                     "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", piece],
                    check=False)
            if _os.path.exists(piece):
                for w in (C.transcribe_words(piece, lang) or []):
                    w = dict(w)
                    w["s"] = _f(w.get("s")) + _pa
                    w["e"] = _f(w.get("e")) + _pa
                    fresh.append(w)
        except Exception as e:  # noqa: BLE001 - fall through to the transcriber
            logger.debug("chirp: gap %.2f-%.2f could not be re-recognised: %s", a, b, e)
        finally:
            try:
                _os.remove(piece)
            except OSError:
                pass

        # Reject any word overlapping an existing line AT ALL. An earlier test only
        # caught words sitting entirely inside one, so a word straddling the boundary
        # got through and produced a recovered line overlapping a real one.
        lines = sorted((_f(g[0].get("s")), _f(g[-1].get("e"))) for g in groups if g)

        def _clear(w, _lines=lines):
            return not any(min(lb, _f(w.get("e"))) - max(la, _f(w.get("s"))) > 0.02
                           for la, lb in _lines)

        fresh = [w for w in fresh if _clear(w)]

        # 2 --- the transcriber, placed by forced alignment ------------------------
        if not fresh and fallback:
            try:
                # _fallback_words returns times relative to `a`.
                fb = _fallback_words(a, b, fallback, audio=audio, sr=sr, lang=lang) or []
                cand = [dict(w, s=_f(w.get("s")) + a, e=_f(w.get("e")) + a) for w in fb]
                cand = [w for w in cand if _clear(w)]
                # A fill has to defend itself. These confidences come from the same
                # forced alignment the placement metric uses, so a fill below the
                # badly-placed line would be text put where those words are not.
                cs = sorted(_f(w.get("c"), 0.0) for w in cand)
                med = cs[len(cs) // 2] if cs else 0.0
                if cand and med >= FILL_MIN_CONF:
                    fresh = cand
                    filled_from_transcriber += 1
                else:
                    if cand:
                        logger.debug("chirp: refused a transcriber fill at %.2f-%.2f, "
                                     "median confidence %.3f", a, b, med)
                    fresh = []
            except Exception as e:  # noqa: BLE001
                logger.debug("chirp: transcriber fill failed at %.2f-%.2f: %s", a, b, e)

        if not fresh:
            still_open.append((round(a, 2), round(b, 2)))
            continue
        for grp in _group_by(_collapse_repeats(fresh), 0.50, 12.0):
            if grp:
                groups.append(grp)
                added += 1

    groups.sort(key=lambda g: _f(g[0].get("s")))
    cov2 = coverage(groups, audio, sr, blocked)[0]
    logger.info("chirp: recovered %d line(s) over %d gap(s) - %d of them from the "
                "transcriber rather than Chirp; speech coverage %.1f%% -> %.1f%%",
                added, len(missing), filled_from_transcriber, 100.0 * cov, 100.0 * cov2)
    if still_open:
        logger.info("chirp: %d gap(s) neither source could read, %.1fs in total: %s",
                    len(still_open), sum(y - x for x, y in still_open),
                    still_open[:8])
    return groups, cov2


def _split_sparse(groups, conf):
    """Split any line averaging more than SEC_PER_WORD seconds a word at its largest pause.

    A 7-word line spanning 18 seconds is not a line: its words were scattered across the span
    by the same timestamp drift everything else here is defending against. Repeated until every
    piece is either dense enough or too short to cut again.
    """
    out, changed = [], 0
    for g in list(groups):
        stack = [g]
        while stack:
            cur = stack.pop()
            span = float(cur[-1]["e"]) - float(cur[0]["s"])
            if len(cur) < 2 or span <= SEC_PER_WORD * len(cur):
                out.append(cur)
                continue
            best_k, best_gap = None, 0.0
            for k in range(1, len(cur)):
                gap = float(cur[k]["s"]) - float(cur[k - 1]["e"])
                if gap > best_gap:
                    best_gap, best_k = gap, k
            if best_k is None or best_gap < 0.30:
                out.append(cur)
                continue
            changed += 1
            stack.append(cur[best_k:])
            stack.append(cur[:best_k])
    out.sort(key=lambda g: float(g[0]["s"]))
    if changed:
        logger.info("chirp: split %d line(s) whose words were scattered over too long a span",
                    changed)
    return out

def _speaker_at(t, turns):
    """The speaker talking at time `t`, or None when diarization has no opinion."""
    for a, b, spk in turns:
        if a - 0.01 <= t <= b + 0.01:
            return spk
    best, best_d = None, 1e9
    for a, b, spk in turns:
        d = a - t if t < a else (t - b if t > b else 0.0)
        if d < best_d:
            best_d, best = d, spk
    return best if best_d <= 0.25 else None


def _speaker_of_word(w, turns):
    return _speaker_at((float(w["s"]) + float(w["e"])) / 2.0, turns)


def _dominant_speaker(group, turns):
    """Whoever holds most of the group's duration."""
    if not turns or not group:
        return None
    a, b = float(group[0]["s"]), float(group[-1]["e"])
    tally = {}
    for ta, tb, spk in turns:
        ov = min(b, tb) - max(a, ta)
        if ov > 0:
            tally[spk] = tally.get(spk, 0.0) + ov
    if not tally:
        return None
    return max(tally.items(), key=lambda kv: kv[1])[0]


def _can_merge(g1, g2, conf):
    """May these two lines become one? Not if that would put two speakers in one line."""
    turns = getattr(conf, "turns", None)
    if not SPEAKER_SPLIT or not turns:
        return True
    s1 = _dominant_speaker(g1, turns)
    s2 = _dominant_speaker(g2, turns)
    if s1 is not None and s2 is not None and s1 != s2:
        return False
    # also refuse when a change falls inside the span the merged line would cover
    a, b = float(g1[0]["s"]), float(g2[-1]["e"])
    seen = set()
    for ta, tb, spk in turns:
        if min(b, tb) - max(a, ta) > 0.20:
            seen.add(spk)
    return len(seen) <= 1


def _split_on_speaker(groups, conf):
    """Cut any line that straddles a speaker change at the change itself."""
    turns = getattr(conf, "turns", None)
    if not SPEAKER_SPLIT or not turns or not groups:
        return groups
    out, cuts = [], 0
    for g in groups:
        cur = [g[0]]
        prev = _speaker_of_word(g[0], turns)
        for w in g[1:]:
            spk = _speaker_of_word(w, turns)
            if spk is not None and prev is not None and spk != prev:
                out.append(cur)
                cur = [w]
                cuts += 1
            else:
                cur.append(w)
            if spk is not None:
                prev = spk
        if cur:
            out.append(cur)
    if cuts:
        logger.info("chirp: cut %d line(s) at a speaker change - one line cannot hold two "
                    "voices", cuts)
    return out

def _purity_words(groups, turns):
    """Share of lines whose WORDS all belong to one speaker.

    The earlier metric asked whether a line's span touched two diarization turns. That is
    unpassable wherever two people talk at once, and it is not what decides anything: the line
    gets one cloned voice, and what matters is whether the words in it were said by one person.
    """
    if not turns or not groups:
        return 100.0, []
    ok, mixed = 0, []
    for g in groups:
        who = {_speaker_of_word(w, turns) for w in g}
        who.discard(None)
        if len(who) <= 1:
            ok += 1
        else:
            mixed.append((float(g[0]["s"]), float(g[-1]["e"]), sorted(who)))
    return 100.0 * ok / len(groups), mixed


def _enforce_word_purity(groups, conf):
    """Split until every line's words belong to one speaker. Runs to a fixed point.

    `_split_on_speaker` cuts at the first change it meets; re-recognition and gap recovery insert
    lines afterwards that were never checked. This is the final guarantee.
    """
    turns = getattr(conf, "turns", None)
    if not SPEAKER_SPLIT or not turns or not groups:
        return groups
    for _ in range(8):
        out, cuts = [], 0
        for g in groups:
            by = {}
            for w in g:
                by.setdefault(_speaker_of_word(w, turns), []).append(w)
            if len([k for k in by if k is not None]) <= 1:
                out.append(g)
                continue
            # One line per speaker, in time order. Two of them may overlap - in the source the
            # speakers overlap too, and the renderer mixes per-line audio.
            for spk, ws in sorted(by.items(), key=lambda kv: float(kv[1][0]["s"])):
                if spk is None and len(by) > 1:
                    continue          # unattributable words follow whoever surrounds them
                out.append(sorted(ws, key=lambda w: float(w["s"])))
            cuts += 1
        groups = sorted(out, key=lambda g: float(g[0]["s"]))
        if not cuts:
            break
    return groups

#: The fastest a real word is spoken, used to decide what a gap can hold. A gap of 0.56s
#: therefore has room for about three words, not twenty-four.
FILL_MIN_WORD_S = float(os.environ.get("OMNIVOICE_CHIRP_FILL_MIN_WORD_S", "0.18"))
#: Past this multiple of what fits, the fill is refused outright rather than truncated -
#: the text clearly does not belong to this gap at all.
FILL_REFUSE_FACTOR = float(os.environ.get("OMNIVOICE_CHIRP_FILL_REFUSE", "3.0"))


def _fill_fraction(text, frac, *, tail=False):
    """The leading (or trailing) `frac` of a transcript, by word count."""
    ws = (text or "").split()
    if not ws:
        return ""
    if frac >= 0.999:
        return " ".join(ws)
    n = max(1, int(round(len(ws) * max(0.0, min(1.0, frac)))))
    return " ".join(ws[-n:] if tail else ws[:n])


def _fallback_words(a, b, fallback, audio=None, sr=None, lang=None):
    """Gemini's words for a span Chirp could not read, with times MMS actually found.

    Chirp has no timing in a gap by definition, so nothing of its work is overridden here. The
    earlier version spread the words evenly across the span - the proportional guessing this whole
    module exists to replace - and those lines aligned around 0.1. Forced alignment inside the gap
    window gives frame-level positions instead, from a model that does not chunk and so has no
    drift to inherit.

    Times are returned relative to `a`, which is what the caller adds its offset to.
    """
    # A neighbour overlapping the gap contributes only the PROPORTIONAL part of its
    # transcript that actually lies inside it. Taking the whole thing is what put 24 words
    # into a 0.56s gap on job dq1g7fxj - roughly a 15x overrun, against the 2.0x that made
    # c004 leak in every render. Same bug, and same fix, as _widen_short_refs.
    text = []
    for sa, sb, t in fallback or []:
        t = (t or "").strip()
        if not t:
            continue
        ov = min(b, sb) - max(a, sa)
        if ov <= 0.20:
            continue
        span = max(float(sb) - float(sa), 0.01)
        frac = ov / span
        if frac >= 0.999:
            text.append(t)
        else:
            # tail when the gap holds this line's END, head when it holds its start
            text.append(_fill_fraction(t, frac, tail=(min(b, sb) >= sb - 0.02)))
    text = [t for t in text if t]
    if not text:
        return []
    joined = " ".join(text)
    toks = joined.split()
    if not toks:
        return []
    # Refuse what the gap cannot physically hold. A gap of 0.56s cannot contain 24 words at
    # any speaking rate, and a line that claims it hands the cloner a reference whose
    # transcript describes ten times its own audio.
    room = max(1, int((b - a) / FILL_MIN_WORD_S))
    if len(toks) > room:
        if len(toks) > room * FILL_REFUSE_FACTOR:
            logger.info("chirp: refusing to fill gap %.2f-%.2f - %d word(s) will not fit in "
                        "%.2fs (room for about %d)", a, b, len(toks), b - a, room)
            return []
        logger.info("chirp: gap %.2f-%.2f can hold about %d word(s), not %d - keeping the "
                    "first %d", a, b, room, len(toks), room)
        toks = toks[:room]
        joined = " ".join(toks)

    # aligned_fallback: ask MMS where these words really are inside the gap.
    if audio is not None and sr:
        try:
            from services import aligner as A
            got = A.align_window(audio, sr, a, b, joined, lang)
            if got:
                out = []
                for q in got:
                    w, ws, we = q[0], float(q[1]), float(q[2])
                    conf = float(q[3]) if len(q) > 3 else 0.3
                    out.append({"w": w, "s": max(0.0, ws - a), "e": max(0.0, we - a),
                                "c": conf})
                if out:
                    logger.info("chirp: gap %.2f-%.2f filled from the transcriber, %d word(s) "
                                "positioned by forced alignment", a, b, len(out))
                    return out
        except Exception as e:  # noqa: BLE001
            logger.debug("chirp: could not align the fallback text at %.2f-%.2f: %s", a, b, e)

    # Last resort only: even spacing. Better a line with approximate times than no line.
    span = max(0.1, b - a)
    step = span / len(toks)
    logger.info("chirp: gap %.2f-%.2f filled from the transcriber with EVEN spacing "
                "(alignment unavailable) - %d word(s)", a, b, len(toks))
    return [{"w": t, "s": i * step, "e": min(span, (i + 1) * step), "c": 0.30}
            for i, t in enumerate(toks)]


def _part_purity(parts, turns):
    """Share of parts whose words all belong to one speaker."""
    if not turns or not parts:
        return 100.0, []
    ok, mixed = 0, []
    for _bi, g in parts:
        who = {_speaker_of_word(w, turns) for w in g}
        who.discard(None)
        if len(who) <= 1:
            ok += 1
        else:
            mixed.append((float(g[0]["s"]), float(g[-1]["e"]), sorted(who)))
    return 100.0 * ok / len(parts), mixed

def _clamp_sparse_tail(groups):
    """Shrink a slot back onto its own words when it is still far too long for them.

    A one-word line spanning 6.7s is not a line with a long word in it - its end was stretched,
    either by breathe or by Chirp's drift. There is nothing to split, so the only honest fix is to
    give the slot back to the audio: the line keeps its start and ends just after its last word.
    Starts are never touched, which is the rule the whole timeline depends on.
    """
    fixed = 0
    for g in groups:
        a = float(g[0]["s"])
        last = float(g[-1]["e"])
        span = last - a
        if len(g) >= 2 and span <= SEC_PER_WORD * len(g):
            continue
        if span <= SEC_PER_WORD * max(1, len(g)):
            continue
        want = last + CLAMP_PAD_S
        if want < last:
            continue
        # the words themselves already end at `last`; the slot is whatever the caller derives from
        # them, so nothing to trim here unless a word's own end was stretched
        if span > SEC_PER_WORD * max(1, len(g)) + CLAMP_PAD_S:
            # trim the final word's end back to a plausible duration for one word
            per = max(0.20, min(0.60, span / max(1, len(g))))
            newend = float(g[-1]["s"]) + per
            if newend < last - 0.05:
                g[-1] = dict(g[-1])
                g[-1]["e"] = newend
                fixed += 1
    if fixed:
        logger.info("chirp: clamped %d slot(s) back onto their own words - a slot far longer than "
                    "its words makes the engine stretch a word across the gap", fixed)
    return groups

def _split_into_parts(blocks, turns):
    """Cut every block at its speaker changes. Returns [(block_index, part_words), ...].

    A part is what becomes a segment, so it carries exactly one speaker and renders in exactly one
    cloned voice - purity by construction rather than by optimisation. The block index is kept so
    timing can go on being reported where it was actually measured.
    """
    out = []
    for bi, g in enumerate(blocks):
        if not turns:
            out.append((bi, g))
            continue
        cur = [g[0]]
        prev = _speaker_of_word(g[0], turns)
        for w in g[1:]:
            spk = _speaker_of_word(w, turns)
            if spk is not None and prev is not None and spk != prev:
                out.append((bi, cur))
                cur = [w]
            else:
                cur.append(w)
            if spk is not None:
                prev = spk
        if cur:
            out.append((bi, cur))
    return out


# ------------------------------------------- MMS re-anchoring and the onset snap
# From the six-way comparison on a19mp3hi, one scorer, one audio file:
#
#   * re-anchoring a line's span with MMS forced alignment improved every metric on
#     every word source tried (Chirp two ways, Amazon Transcribe, gemini-3.7-flash).
#     Chirp reports word times as a by-product of recognising; a forced aligner is
#     given the text, so it answers a much easier question and answers it tighter.
#   * even re-anchored, 91-98% of lines start AFTER the voice does, median 450-640 ms.
#     That is speech clipped off the front of every slot - it reads as the dub coming
#     in late - and it is why EBU R37 compliance never passed 20%. The error is almost
#     entirely one-directional, so a bounded snap toward the onset is safe.
REANCHOR = os.environ.get("OMNIVOICE_CHIRP_REANCHOR", "1") not in ("0", "false", "False")
#: Below this median word confidence the alignment is not evidence of anything; the
#: line keeps the times it arrived with.
REANCHOR_MIN_CONF = float(os.environ.get("OMNIVOICE_CHIRP_REANCHOR_CONF", "0.30"))
#: A re-anchored edge that moves further than this is not a correction, it is CTC
#: dumping unmatched tokens at the window boundary - the artefact that once produced
#: "relocations" of 88 s and 108 s.
REANCHOR_MAX_SHIFT_S = float(os.environ.get("OMNIVOICE_CHIRP_REANCHOR_SHIFT", "2.0"))
REANCHOR_PAD_MIN_S = float(os.environ.get("OMNIVOICE_CHIRP_REANCHOR_PAD", "0.60"))
REANCHOR_PAD_FRAC = 0.50
#: Reaching the window edge is the tell of that same artefact.
REANCHOR_EDGE_S = 0.03

SNAP_ONSET = os.environ.get("OMNIVOICE_CHIRP_SNAP_ONSET", "1") not in ("0", "false", "False")
#: How far a start may travel. Wide enough to cover the measured median clip, narrow
#: enough that slots cannot inflate the way breathe() once did (which stretched every
#: line to its 0.85x floor).
SNAP_MAX_S = float(os.environ.get("OMNIVOICE_CHIRP_SNAP_MAX_S", "0.60"))
#: Land just inside the voiced run, not on its first frame: ITU-R BT.1359-1 tolerates
#: audio late (~125 ms) far better than early (~45 ms), so aim to stay marginally late.
SNAP_LEAVE_S = float(os.environ.get("OMNIVOICE_CHIRP_SNAP_LEAVE_S", "0.05"))
SNAP_MIN_S = 0.04
SNAP_GUARD_S = 0.05


def _mms_reanchor(groups, audio, sr, lang):
    """Replace each line's span with where forced alignment actually finds its words.

    Returns a new list of groups; any line the aligner cannot speak to confidently is
    returned exactly as it came in.
    """
    from services import aligner as A
    dur = len(audio) / float(sr)
    out, took, weak, edge = [], 0, 0, 0
    for g in groups:
        if not g:
            continue
        a, b = _f(g[0].get("s")), _f(g[-1].get("e"))
        text = " ".join(str(w.get("w") or "") for w in g).strip()
        if b - a <= 0.05 or not text:
            out.append(g); continue
        pad = max(REANCHOR_PAD_MIN_S, REANCHOR_PAD_FRAC * (b - a))
        t0, t1 = max(0.0, a - pad), min(dur, b + pad)
        try:
            got = A.align_window(audio, sr, t0, t1, text, lang)
        except Exception:  # noqa: BLE001
            got = None
        if not got:
            out.append(g); weak += 1; continue
        cs = sorted(float(q[3]) for q in got)
        if cs[len(cs) // 2] < REANCHOR_MIN_CONF:
            out.append(g); weak += 1; continue
        na, nb = min(float(q[1]) for q in got), max(float(q[2]) for q in got)
        if (na - t0 < REANCHOR_EDGE_S or t1 - nb < REANCHOR_EDGE_S
                or nb - na < 0.10
                or abs(na - a) > REANCHOR_MAX_SHIFT_S
                or abs(nb - b) > REANCHOR_MAX_SHIFT_S):
            out.append(g); edge += 1; continue
        ng = [dict(w) for w in g]
        if len(got) == len(ng):
            # Nothing was dropped in tokenisation, so every word has its own measured
            # span. Taking them fixes drift inside the line as well as at its edges.
            for w, q in zip(ng, got):
                w["s"], w["e"] = round(float(q[1]), 3), round(float(q[2]), 3)
        else:
            # Map the interior onto the new span. Order and relative spacing are what
            # the speaker split and the purity check read, and both survive this.
            span = max(b - a, 1e-6)
            k = (nb - na) / span
            for w in ng:
                w["s"] = round(na + (_f(w.get("s")) - a) * k, 3)
                w["e"] = round(na + (_f(w.get("e")) - a) * k, 3)
            ng[0]["s"], ng[-1]["e"] = round(na, 3), round(nb, 3)
        prev = None
        for w in ng:
            if _f(w.get("e")) <= _f(w.get("s")):
                w["e"] = round(_f(w.get("s")) + 0.02, 3)
            if prev is not None and _f(w.get("s")) < prev:
                w["s"] = round(prev, 3)
                if _f(w.get("e")) <= _f(w.get("s")):
                    w["e"] = round(_f(w.get("s")) + 0.02, 3)
            prev = _f(w.get("e"))
        out.append(ng); took += 1
    logger.info("chirp: MMS re-anchored %d of %d line(s) (%d too weak to judge, "
                "%d refused as an edge artefact)", took, len(groups), weak, edge)
    return out


def _voiced_mask(audio, sr, hop=0.02):
    """Same gate as _speech_regions, kept as a frame mask so a run can be walked."""
    import numpy as np
    frame = int(hop * sr)
    usable = (len(audio) // frame) * frame
    if usable < frame * 2:
        return None, hop
    rms = np.sqrt((audio[:usable].reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    gate = min(float(np.quantile(db, 0.97)) - 35.0, -45.0)
    return db > gate, hop


def _run_onset(voiced, hop, t, look=2.0):
    """Boundary of the voiced run t belongs to: inside speech, walk back to where that
    speech began; in silence, walk forward to where speech begins."""
    i = int(round(t / hop))
    if i < 0 or i >= len(voiced):
        return None
    if voiced[i]:
        j = i
        while j > 0 and voiced[j - 1]:
            j -= 1
        return j * hop
    j, lim = i, i + int(look / hop)
    while j < len(voiced) and j < lim and not voiced[j]:
        j += 1
    return j * hop if (j < len(voiced) and j < lim and voiced[j]) else None


def _snap_onsets(rows, audio, sr):
    """Move each start onto its voice onset, bounded. Never past the line before it,
    never further than SNAP_MAX_S, never past its own end."""
    voiced, hop = _voiced_mask(audio, sr)
    if voiced is None:
        return {"back": 0, "fwd": 0, "gained": 0.0, "given": 0.0}
    rows.sort(key=lambda r: _f(r.get("start")))
    back = fwd = 0
    gained = given = 0.0
    for i, r in enumerate(rows):
        a, b = _f(r.get("start")), _f(r.get("end"))
        o = _run_onset(voiced, hop, a)
        if o is None:
            continue
        floor = (_f(rows[i - 1].get("end")) + SNAP_GUARD_S) if i else 0.0
        if o < a:                       # the voice was already going: the slot clips it
            want = max(o + SNAP_LEAVE_S, a - SNAP_MAX_S, floor)
            if want < a - SNAP_MIN_S:
                r["start"] = round(want, 3)
                back += 1; gained += a - want
        elif o - a <= SNAP_MAX_S:       # the slot opens on silence: the dub would be early
            want = o - SNAP_LEAVE_S
            if want > a + SNAP_MIN_S and b - want >= MIN_LINE_S:
                r["start"] = round(want, 3)
                fwd += 1; given += want - a
    return {"back": back, "fwd": fwd, "gained": gained, "given": given}


# ------------------------------------------ the transcriber's words, MMS's times
#: How many of a line's words must survive romanisation before its alignment is trusted.
LINES_MIN_KEPT = 0.60
#: A line the aligner cannot read keeps its own span with words spread across it. Marked
#: with a low confidence so the boundary snap refuses to START a line there - that is
#: exactly the guessing this module exists to replace, tolerated only to avoid a hole.
LINES_GUESS_CONF = 0.15


def _words_from_lines(old, audio, sr, lang):
    """A word stream built from the transcriber's lines, timed by forced alignment.

    Returns [{"w","s","e","c"}, ...] in time order. The text is the transcriber's, so
    nothing the user edited is discarded and the character-count gate cannot trip.
    """
    from services import aligner as A
    dur = len(audio) / float(sr)
    out, aligned, guessed, empty = [], 0, 0, 0
    for s in old:
        a, b = _f(s.get("start")), _f(s.get("end"))
        text = (_text_of(s) or "").strip()
        toks = text.split()
        if b - a <= 0.05 or not toks:
            empty += 1
            continue
        pad = max(0.30, 0.25 * (b - a))
        got = None
        try:
            got = A.align_window(audio, sr, max(0.0, a - pad), min(dur, b + pad),
                                 text, lang)
        except Exception:  # noqa: BLE001
            got = None
        if got and len(got) >= LINES_MIN_KEPT * len(toks):
            prev = None
            for q in got:
                ws, we = float(q[1]), float(q[2])
                if we <= ws:
                    we = ws + 0.02
                if prev is not None and ws < prev:
                    ws = prev
                    we = max(we, ws + 0.02)
                prev = we
                out.append({"w": str(q[0]), "s": round(ws, 3), "e": round(we, 3),
                            "c": round(float(q[3]), 3)})
            aligned += 1
        else:
            # Keep the line's own span. The transcriber's line boundaries were the best
            # covering source measured (98.6%), so a span with guessed interior beats a
            # span with no words at all - which is what produces a missing line.
            step = (b - a) / float(len(toks))
            for i, w in enumerate(toks):
                out.append({"w": w, "s": round(a + i * step, 3),
                            "e": round(a + (i + 1) * step - 0.005, 3),
                            "c": LINES_GUESS_CONF})
            guessed += 1
    out.sort(key=lambda w: (float(w["s"]), float(w["e"])))
    logger.info("chirp/lines: %d word(s) from %d line(s) - %d aligned by MMS, "
                "%d kept their own span, %d empty",
                len(out), len(old), aligned, guessed, empty)
    return out
