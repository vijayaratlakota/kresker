"""User-supplied transcript / translation import (CSV), replacing the
Transcribe and Translate stages of a dub job.

The flow the endpoints implement, in order:

    POST /dub/import/transcript/{job_id}    -> timeline + speakers + voice clones
    POST /dub/import/translation/{job_id}   -> target text onto that timeline
    GET  /dub/import/status/{job_id}        -> what has been imported so far

Design decisions that are NOT arbitrary - each one is a trap that was already
hit and measured on job `5p113y7e` (see research/manual_csv_render.md):

1.  `extract_speaker_clones` reads ``seg["text"]`` as the reference transcript.
    In the normal pipeline it runs BEFORE translation, so ``text`` is the source
    language there. Here ``text`` is the TARGET language while the reference
    audio cut from ``vocals.wav`` is the SOURCE language. Handing the segments
    over as-is pairs (say) Hindi audio with a Telugu transcript, which is the
    (audio, ref_text) mismatch that causes source-language leakage in the dub.
    So a *shadow* list with ``text = text_original`` is passed instead, and the
    job itself is never mutated for the clone call.

2.  Timestamps and text are written verbatim - no re-timing, no clamping, no
    de-overlapping, no forced alignment. After the write the job is read back
    out of ``dub_history.job_data`` (not the in-memory cache) and every
    start/end is compared to the ORIGINAL CSV cell text within 0.0005 s, and
    every text compared byte-for-byte. A mismatch is a 500 with the offending
    line ids: the import never half-succeeds.

3.  Validation severity follows ``validate_input.py`` / ``merge_pair.py`` with
    two deliberate downgrades to warnings, because the user's timeline is
    authoritative here and the reference file would otherwise be rejected:
      * a row longer than ``MAX_ROW_S`` (the 20 Aug reference transcript has one
        28.7 s row, L0168);
      * ``word_times`` that look generated rather than measured - this import
        ignores that column entirely, so it cannot do any harm.
    Everything that would put the wrong text on the wrong line, or leave a
    speaker without a voice, is still a hard 400/409 with nothing written.

4.  An imported job records its own placement defaults on the job dict
    (``timing_strategy="strict_slot"``, ``slot_fit="off"``) because the built
    frontend never sends ``slot_fit`` and the schema default (``time_stretch``)
    would re-enable the underrun fill. ``dub_generate`` honours these for jobs
    whose ``timing_source`` is ``manual-csv-v1``.
"""

import asyncio
import csv
import io
import json
import logging
import os
import re
import time
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from core.db import db_conn
from core.logging_utils import log_safe
from services import dub_pipeline

router = APIRouter()
logger = logging.getLogger("omnivoice.api")

_get_job = dub_pipeline.get_job
_save_job = dub_pipeline.save_job

# ---------------------------------------------------------------- constants

TIMING_SOURCE = "manual-csv-v1"
IMPORT_VERSION = 1

# Post-write assertion tolerance. The write path is float(str) so the real
# delta is 0.0; this only guards against a rounding pass sneaking in later.
ASSERT_TOL_S = 0.0005
# merge_pair.py TOL_S - the two files may differ by one rounding step where the
# translation echoes start/end.
JOIN_TOL_S = 0.002

MAX_ROW_S = 12.0                # validate_input.py MAX_ROW_S (warning here, see 3)
MAX_SPEAKERS = 8                # services/diar_unmerge.py MAX_SPEAKERS
SOFT_SPEAKERS = 6
MIN_SPEAKER_S = 3.0             # MIN_SEGMENT_REF_DURATION_S: below this, no clone
MAX_CSV_BYTES = 8 * 1024 * 1024

# validate_input.py CPS - indicative only; character count explains under 10%
# of real duration variance, so overflow is always a warning.
CPS = {"te": 13.0, "kn": 13.0, "ml": 13.0, "hi": 14.0, "gu": 14.0, "ta": 14.0,
       "en": 15.0}

_LANG_NAMES = {
    "hindi": ("hi", "Hindi"), "telugu": ("te", "Telugu"),
    "tamil": ("ta", "Tamil"), "kannada": ("kn", "Kannada"),
    "malayalam": ("ml", "Malayalam"), "gujarati": ("gu", "Gujarati"),
    "english": ("en", "English"), "marathi": ("mr", "Marathi"),
    "bengali": ("bn", "Bengali"), "punjabi": ("pa", "Punjabi"),
    "urdu": ("ur", "Urdu"),
}
_CODE_NAMES = {code: name for code, name in _LANG_NAMES.values()}

_SCRIPT_RANGES = {
    "deva": (0x0900, 0x097F), "telu": (0x0C00, 0x0C7F), "taml": (0x0B80, 0x0BFF),
    "knda": (0x0C80, 0x0CFF), "mlym": (0x0D00, 0x0D7F), "gujr": (0x0A80, 0x0AFF),
    "beng": (0x0980, 0x09FF), "guru": (0x0A00, 0x0A7F), "arab": (0x0600, 0x06FF),
}
_SCRIPT_TO_CODE = {"telu": "te", "knda": "kn", "mlym": "ml", "taml": "ta",
                   "gujr": "gu", "deva": "hi", "beng": "bn", "guru": "pa",
                   "arab": "ur", "latn": "en"}


def _script_counts(s: str) -> dict:
    out = {k: 0 for k in _SCRIPT_RANGES}
    out["latn"] = 0
    for ch in s:
        o = ord(ch)
        if ch.isascii():
            if ch.isalpha():
                out["latn"] += 1
            continue
        for name, (lo, hi) in _SCRIPT_RANGES.items():
            if lo <= o <= hi:
                out[name] += 1
                break
    return out


def _lang_from_name(name: str):
    """'FILE1-Transcript-Hindi.csv' -> ('hi', 'Hindi'). Also handles the
    documented `<video>__<src>-<tgt>.csv` convention, returning the side asked
    for. Returns (None, None) when nothing is recognisable."""
    base = os.path.splitext(os.path.basename(name or ""))[0].lower()
    for word, pair in _LANG_NAMES.items():
        if word in base:
            return pair
    codes = "|".join(sorted(set(list(CPS) + list(_CODE_NAMES))))
    m = re.search(r"(?:^|_|-)(%s)-(%s)(?:$|_|-)" % (codes, codes), base)
    if m:
        return m.group(1), _CODE_NAMES.get(m.group(1), m.group(1))
    return None, None


def _lang_pair_from_name(name: str):
    base = os.path.splitext(os.path.basename(name or ""))[0].lower()
    codes = "|".join(sorted(set(list(CPS) + list(_CODE_NAMES))))
    m = re.search(r"(?:^|_|-)(%s)-(%s)(?:$|_|-)" % (codes, codes), base)
    if m:
        return m.group(1), m.group(2)
    return None, None


def _fail(problems, *, status=400, warnings=None, extra=None):
    """Reject the whole upload. Nothing has been written at any call site of
    this helper - the job dict is only touched after validation passes."""
    detail = {
        "error": "csv_rejected",
        "message": ("This file was not imported. Fix the problem(s) below and "
                    "upload it again - nothing on the job was changed."),
        "problems": problems,
        "warnings": warnings or [],
    }
    if extra:
        detail.update(extra)
    raise HTTPException(status_code=status, detail=detail)


async def _read_upload(file: UploadFile) -> str:
    try:
        raw = await file.read()
    except Exception as e:  # noqa: BLE001 - surfaced to the user verbatim
        raise HTTPException(status_code=400,
                            detail=f"Could not read the uploaded file: {e}") from e
    if not raw:
        _fail(["the uploaded file is empty"])
    if len(raw) > MAX_CSV_BYTES:
        _fail(["the uploaded file is %d bytes; the limit is %d"
               % (len(raw), MAX_CSV_BYTES)])
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        _fail(["the file is not valid UTF-8 (%s). Re-save it as UTF-8 - not ANSI, "
               "not UTF-16." % e])


def _rows_of(text: str, required: list, what: str):
    try:
        rows = list(csv.DictReader(io.StringIO(text)))
    except csv.Error as e:
        _fail(["the %s CSV could not be parsed: %s" % (what, e)])
    if not rows:
        _fail(["the %s CSV has a header but no data rows" % what])
    have = [c.strip() for c in rows[0].keys() if c]
    missing = [c for c in required if c not in have]
    if missing:
        _fail(["the %s CSV is missing required column(s): %s. Found: %s"
               % (what, ", ".join(missing), ", ".join(have) or "nothing")])
    return rows, have


def _num(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def _speaker_map(labels_in_order):
    """Label -> pipeline speaker id. `SPK3` keeps its number so the mapping is
    stable and auditable; anything else is numbered by first appearance."""
    out, used = {}, set()
    for lab in labels_in_order:
        if lab in out:
            continue
        m = re.fullmatch(r"(?i)spk[\s_-]*(\d+)", lab.strip())
        if m and int(m.group(1)) not in used:
            n = int(m.group(1))
        else:
            n = 1
            while n in used:
                n += 1
        used.add(n)
        out[lab] = "Speaker %d" % n
    return out


def _profile_id(speaker_id: str) -> str:
    return "auto:%s" % speaker_id.lower().replace(" ", "_")


def _db_segments(job_id: str):
    """Read segments back out of the persisted row, NOT the in-memory cache.
    The whole point of the assertion is to prove what landed on disk."""
    with db_conn() as conn:
        row = conn.execute("SELECT job_data FROM dub_history WHERE id=?",
                           (job_id,)).fetchone()
    if not row or not row["job_data"]:
        raise HTTPException(status_code=500, detail={
            "error": "verify_failed",
            "message": "The import was written but the job could not be read back.",
        })
    return (json.loads(row["job_data"]).get("segments") or [])


# ---------------------------------------------------------------- transcript

_T_REQUIRED = ["line_id", "speaker", "start", "end", "source_text"]


def _parse_transcript(text: str):
    """Validate and parse a transcript CSV. Returns (rows, warnings).

    `csv_start` / `csv_end` keep the ORIGINAL cell text so the post-write
    assertion compares against the file, not against a value we already
    converted once.
    """
    rows, have = _rows_of(text, _T_REQUIRED, "transcript")
    problems: list = []
    warnings: list = []

    extra = [c for c in have
             if c not in _T_REQUIRED + ["word_times", "notes"]]
    if extra:
        warnings.append("unexpected column(s) ignored: %s" % ", ".join(extra))

    parsed = []
    seen_ids: dict = {}
    for n, r in enumerate(rows, 2):          # row 1 is the header
        lid = (r.get("line_id") or "").strip()
        spk = (r.get("speaker") or "").strip()
        a, b = _num(r.get("start")), _num(r.get("end"))
        src = r.get("source_text") or ""
        if not lid:
            problems.append("row %d: empty line_id" % n)
            continue
        if lid in seen_ids:
            problems.append("row %d: duplicate line_id %s (first seen on row %d)"
                            % (n, lid, seen_ids[lid]))
            continue
        seen_ids[lid] = n
        if not spk:
            problems.append("row %d (%s): empty speaker" % (n, lid))
        if a is None or b is None:
            problems.append("row %d (%s): unreadable start/end - expected seconds "
                            "with 3 decimals, e.g. 12.480" % (n, lid))
            continue
        if b <= a:
            problems.append("row %d (%s): end (%.3f) is not after start (%.3f)"
                            % (n, lid, b, a))
        if not src.strip():
            problems.append("row %d (%s): empty source_text" % (n, lid))
        if "..." in src or "\u2026" in src:
            problems.append("row %d (%s): source_text contains an ellipsis - it must "
                            "be verbatim" % (n, lid))
        if (b - a) > MAX_ROW_S:
            warnings.append("row %d (%s) is %.1fs long, over the %.0fs guideline. "
                            "Imported as given; a block this long is one synthesised "
                            "utterance and the voice can drift inside it."
                            % (n, lid, b - a, MAX_ROW_S))
        parsed.append({
            "row": n, "line_id": lid, "speaker": spk,
            "csv_start": (r.get("start") or "").strip(),
            "csv_end": (r.get("end") or "").strip(),
            "start": a, "end": b, "source_text": src,
            "notes": (r.get("notes") or "").strip(),
        })

    if not parsed:
        problems.append("no usable rows")
        _fail(problems, warnings=warnings)

    # word_times is not used by this import (boundaries come straight from
    # start/end), so its defects are informational only.
    if "word_times" in have:
        malformed = fabricated = populated = 0
        for r in rows:
            cell = (r.get("word_times") or "").strip()
            if not cell:
                continue
            populated += 1
            spans = []
            for tok in cell.split("|"):
                bits = tok.rsplit(":", 2)
                if len(bits) != 3:
                    malformed += 1
                    break
                try:
                    spans.append((float(bits[1]), float(bits[2])))
                except ValueError:
                    malformed += 1
                    break
            if len(spans) >= 4:
                widths = [y - x for x, y in spans]
                if max(widths) - min(widths) < 0.005:
                    fabricated += 1
        if malformed:
            warnings.append("%d row(s) have malformed word_times (expected "
                            "word:start:end joined by '|'). Ignored - this import "
                            "takes boundaries from start/end." % malformed)
        if fabricated:
            warnings.append("%d row(s) have evenly spaced word_times, i.e. generated "
                            "rather than measured. Ignored." % fabricated)

    # ordering (informational - we sort by start) and per-speaker overlap (fatal:
    # a speaker cannot talk over themselves, and it breaks reference cutting)
    if [p["line_id"] for p in parsed] != [p["line_id"] for p in
                                          sorted(parsed, key=lambda p: p["start"])]:
        warnings.append("rows are not in increasing start order; imported in start "
                        "order. Check that is intended.")
    by_spk: dict = {}
    for p in parsed:
        by_spk.setdefault(p["speaker"], []).append(p)
    for spk, ss in by_spk.items():
        ss = sorted(ss, key=lambda p: p["start"])
        for prev, cur in zip(ss, ss[1:]):
            if cur["start"] < prev["end"] - 0.001:
                problems.append("speaker %s overlaps itself: rows %d (%s) and %d (%s)"
                                % (spk, prev["row"], prev["line_id"],
                                   cur["row"], cur["line_id"]))

    if len(by_spk) > MAX_SPEAKERS:
        problems.append("%d distinct speakers, but the diarization ceiling is %d. "
                        "Merge the least important voices into one shared label."
                        % (len(by_spk), MAX_SPEAKERS))
    elif len(by_spk) > SOFT_SPEAKERS:
        warnings.append("%d distinct speakers. Under the hard limit of %d, but most "
                        "content has 2-5 - check for one voice under two labels."
                        % (len(by_spk), MAX_SPEAKERS))
    for spk, ss in sorted(by_spk.items()):
        tot = sum(p["end"] - p["start"] for p in ss)
        if tot < MIN_SPEAKER_S:
            problems.append("speaker %s has only %.1fs of speech across %d row(s) - "
                            "needs at least %.0fs to get a cloned voice of its own, "
                            "otherwise it falls back to the pooled voice. Merge it "
                            "into the nearest main speaker."
                            % (spk, tot, len(ss), MIN_SPEAKER_S))
        elif len(ss) == 1:
            warnings.append("speaker %s appears in only one row (%.1fs) - enough to "
                            "clone, but check it is not a label typo." % (spk, tot))

    if problems:
        _fail(problems, warnings=warnings)
    parsed.sort(key=lambda p: (p["start"], p["line_id"]))
    return parsed, warnings


def _build_clones(job, job_dir, segments):
    """Cut a voice reference per speaker from that speaker's own audio.

    The shadow list is the whole point: `extract_speaker_clones` reads
    ``seg["text"]`` as the reference transcript, and at this point ``text``
    holds the TARGET language while the audio is SOURCE language. Feeding the
    segments straight in pairs source audio with a target transcript, which
    leaks the source language into the dub.
    """
    from services.speaker_clone import extract_speaker_clones, build_cast_sources

    vocals = job.get("vocals_path") or os.path.join(job_dir, "vocals.wav")
    if not vocals or not os.path.isfile(vocals):
        return {}, {}, ["no separated vocals for this job yet, so no voice clones "
                       "were cut. Wait for the upload's prep stage to finish, then "
                       "re-upload the transcript."]
    shadow = [dict(s, text=(s.get("text_original") or "")) for s in segments]
    t0 = time.time()
    clones = extract_speaker_clones(vocals, shadow, job_dir,
                                    labels_source="manual") or {}
    logger.info("csv-import: extract_speaker_clones for %s took %.1fs, %d clone(s)",
                log_safe(job.get("_job_id") or ""), time.time() - t0, len(clones))
    notes = []
    wanted = sorted({s["speaker_id"] for s in segments})
    for miss in [w for w in wanted if w not in clones]:
        notes.append("speaker %s got no cloned voice and will use the stock voice"
                     % miss)
    cast = build_cast_sources(segments, clones, {}) or {}
    return clones, cast, notes


def _clone_report(segments, clones):
    out = []
    per_spk: dict = {}
    for s in segments:
        per_spk.setdefault(s["speaker_id"], 0.0)
        per_spk[s["speaker_id"]] += float(s["end"]) - float(s["start"])
    for spk in sorted(per_spk):
        c = (clones or {}).get(spk) or {}
        dur = float(c.get("duration") or 0.0)
        ref_text = c.get("ref_text") or ""
        out.append({
            "speaker_id": spk,
            "csv_speech_s": round(per_spk[spk], 2),
            "cloned": bool(c),
            "reference_s": round(dur, 2),
            "reference_slices": int(c.get("source_count") or 0),
            "ref_text_chars": len(ref_text),
            # Density is the guard on the leak bug class: a reference must not
            # carry more transcript than its audio can plausibly hold.
            "ref_chars_per_s": round(len(ref_text) / dur, 1) if dur > 0 else None,
            "reference_file": os.path.basename(c.get("ref_audio") or "") or None,
        })
    return out


@router.post("/dub/import/transcript/{job_id}")
async def dub_import_transcript(
    job_id: str,
    file: UploadFile = File(...),
    source_lang: Optional[str] = Form(None),
    build_clones: bool = Form(True),
):
    """Import a hand-authored transcript CSV as this job's timeline.

    `line_id,speaker,start,end,source_text[,word_times][,notes]`

    start/end/source_text are written EXACTLY as given: no forced alignment, no
    de-overlapping, no clamping to duration. Distinct speakers get a voice
    reference cut from their own audio. Idempotent - a second upload replaces
    the timeline, and a translation already imported is re-applied if (and only
    if) it still joins on line_id.
    """
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job_dir = dub_pipeline.safe_job_dir(job_id)
    if not job_dir or not os.path.isdir(job_dir):
        raise HTTPException(status_code=400,
                            detail="This job has no media directory yet.")

    text = await _read_upload(file)
    parsed, warnings = _parse_transcript(text)

    fname = file.filename or ""
    code = (source_lang or "").strip().lower()
    name = _CODE_NAMES.get(code, "")
    if not code:
        code, name = _lang_from_name(fname)
        pair_src, _pair_tgt = _lang_pair_from_name(fname)
        code = pair_src or code
        name = _CODE_NAMES.get(code or "", name or "")
    if not code:
        sc = _script_counts("".join(p["source_text"] for p in parsed))
        top = max(sc, key=sc.get)
        code = _SCRIPT_TO_CODE.get(top)
        name = _CODE_NAMES.get(code or "", "")
        if code:
            warnings.append("source language not given and not in the filename; "
                            "guessed '%s' from the script in source_text." % code)
    if not code:
        _fail(["could not determine the source language. Pass it as the "
               "`source_lang` form field (e.g. hi) or name the file "
               "'<something>-Hindi.csv'."], warnings=warnings)

    label_map = _speaker_map([p["speaker"] for p in parsed])
    segments = []
    for i, p in enumerate(parsed):
        spk = label_map[p["speaker"]]
        segments.append({
            "id": "c%03d" % i,
            "line_id": p["line_id"],
            "speaker_id": spk,
            "start": p["start"],
            "end": p["end"],
            # `text` is the TARGET language slot. Empty until the translation
            # CSV arrives; pre-filling it with the source would make a
            # premature Generate render the source language back at the user.
            "text": "",
            "text_original": p["source_text"],
            "profile_id": _profile_id(spk),
            # Hand-authored, so nothing downstream may gate on a low ASR score.
            "asr_confidence": 1.0,
            "csv_notes": p["notes"],
        })

    # Idempotency: re-apply a translation imported earlier, but only if it still
    # joins cleanly. If the ids moved, drop it and say so rather than pairing
    # the wrong text with the wrong line.
    prev = ((job.get("csv_import") or {}).get("translation") or {})
    prev_rows = prev.get("rows") or {}
    reapplied = 0
    if prev_rows:
        ids = {s["line_id"] for s in segments}
        if set(prev_rows) == ids:
            for s in segments:
                s["text"] = prev_rows[s["line_id"]]
            reapplied = len(segments)
        else:
            warnings.append("a translation was imported before, but its line_ids no "
                            "longer match this transcript - it was dropped. Upload "
                            "the translation CSV again.")

    clones, cast, clone_notes = ({}, {}, [])
    if build_clones:
        job_for_clone = dict(job)
        job_for_clone["_job_id"] = job_id
        clones, cast, clone_notes = await asyncio.to_thread(
            _build_clones, job_for_clone, job_dir, segments)
    warnings.extend(clone_notes)

    job["segments"] = segments
    job["source_lang"] = code
    job["source_language"] = name or code
    job["timing_source"] = TIMING_SOURCE
    job["timing_quality"] = {"source": TIMING_SOURCE, "hand_authored": True}
    job["labels_source"] = "manual"
    job["per_segment_refs"] = True
    if clones:
        job["speaker_clones"] = clones
        job["segment_clones"] = {}     # rebuilt by ensure_segment_refs at render
        job["cast_sources"] = cast
    # Placement defaults for an imported job. dub_generate honours these when
    # timing_source == manual-csv-v1, because the built frontend never sends
    # slot_fit and the schema default (time_stretch) would re-enable the
    # underrun fill that slows early-finishing lines.
    job["timing_strategy"] = "strict_slot"
    job["slot_fit"] = "off"
    imp = job.setdefault("csv_import", {})
    imp["version"] = IMPORT_VERSION
    imp["transcript"] = {
        "filename": fname,
        "rows": len(segments),
        "source_lang": code,
        "speakers": {lab: label_map[lab] for lab in sorted(label_map)},
        "imported_at": time.time(),
        "warnings": list(warnings),
    }
    if reapplied:
        imp.setdefault("translation", {})["reapplied"] = True
    elif prev_rows:
        imp.pop("translation", None)
        for s in segments:
            s["text"] = ""

    _save_job(job_id, job, duration=float(job.get("duration") or 0.0))

    # Assert against the ORIGINAL CSV cells, from the persisted row.
    back = _db_segments(job_id)
    bad = []
    worst_s = worst_e = 0.0
    if len(back) != len(parsed):
        bad.append("segment count changed on the round trip: %d written, %d in the "
                   "CSV" % (len(back), len(parsed)))
    for b, p in zip(back, parsed):
        ds = abs(float(b["start"]) - float(p["csv_start"]))
        de = abs(float(b["end"]) - float(p["csv_end"]))
        worst_s, worst_e = max(worst_s, ds), max(worst_e, de)
        if ds > ASSERT_TOL_S or de > ASSERT_TOL_S:
            bad.append("%s: start delta %.9fs, end delta %.9fs"
                       % (p["line_id"], ds, de))
        if (b.get("text_original") or "") != p["source_text"]:
            bad.append("%s: source text is not byte-identical to the CSV"
                       % p["line_id"])
    if bad:
        raise HTTPException(status_code=500, detail={
            "error": "verify_failed",
            "message": ("The transcript was written but did not read back "
                        "identical to the CSV. Do not generate from this job."),
            "mismatches": bad[:20],
        })

    logger.info("csv-import: transcript %d row(s) into job %s (src=%s, clones=%d)",
                len(segments), log_safe(job_id), log_safe(code), len(clones))
    return {
        "job_id": job_id,
        "rows": len(segments),
        "source_lang": code,
        "speakers": _clone_report(segments, clones),
        "speaker_labels": {lab: label_map[lab] for lab in sorted(label_map)},
        "clones_built": len(clones),
        "clones_expected": len({s["speaker_id"] for s in segments}),
        "translation_reapplied": reapplied,
        "verification": {
            "worst_start_delta_s": round(worst_s, 9),
            "worst_end_delta_s": round(worst_e, 9),
            "text_byte_identical": True,
            "tolerance_s": ASSERT_TOL_S,
        },
        "defaults": {"timing_strategy": "strict_slot", "slot_fit": "off",
                     "timing_source": TIMING_SOURCE},
        "warnings": warnings,
        "next_step": "translation",
    }


# ---------------------------------------------------------------- translation

_X_REQUIRED = ["line_id", "target_text"]


@router.post("/dub/import/translation/{job_id}")
async def dub_import_translation(
    job_id: str,
    file: UploadFile = File(...),
    language_code: Optional[str] = Form(None),
):
    """Import a translation CSV onto the already-imported transcript timeline.

    `line_id,start,end,target_text[,notes]`

    Joins on `line_id`. Refuses the whole file on any id mismatch, duplicate id
    or timestamp drift beyond 0.002 s, because the failure mode of a silent
    off-by-one join is the wrong translation on the wrong line - inaudible until
    the dub is played. Fills `text` only; start/end/text_original are not
    touched. Idempotent.
    """
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    imp = job.get("csv_import") or {}
    if not imp.get("transcript"):
        raise HTTPException(status_code=409, detail={
            "error": "no_transcript",
            "message": ("Import the transcript CSV first - the translation is joined "
                        "onto it on line_id."),
        })
    segments = [s for s in (job.get("segments") or []) if isinstance(s, dict)]
    if not segments:
        raise HTTPException(status_code=409, detail={
            "error": "no_segments",
            "message": "This job has no segments. Re-import the transcript CSV.",
        })

    text = await _read_upload(file)
    rows, have = _rows_of(text, _X_REQUIRED, "translation")

    problems: list = []
    warnings: list = []
    extra = [c for c in have
             if c not in _X_REQUIRED + ["start", "end", "speaker", "notes"]]
    if extra:
        warnings.append("unexpected column(s) ignored: %s" % ", ".join(extra))

    xmap: dict = {}
    for n, r in enumerate(rows, 2):
        lid = (r.get("line_id") or "").strip()
        if not lid:
            problems.append("row %d: empty line_id" % n)
            continue
        if lid in xmap:
            problems.append("row %d: duplicate line_id %s" % (n, lid))
            continue
        tgt = r.get("target_text") or ""
        note = (r.get("notes") or "").strip().lower()
        if not tgt.strip() and "song" not in note and "music" not in note:
            problems.append("row %d (%s): empty target_text (allowed only on a "
                            "song/music row)" % (n, lid))
        xmap[lid] = {"row": n, "target_text": tgt, "notes": note,
                     "start": _num(r.get("start")), "end": _num(r.get("end"))}

    by_lid = {}
    for s in segments:
        lid = s.get("line_id")
        if lid:
            by_lid[str(lid)] = s
    if len(by_lid) != len(segments):
        problems.append("the imported transcript has segments without a line_id - "
                        "re-import the transcript CSV before the translation")

    only_t = sorted(set(by_lid) - set(xmap))
    only_x = sorted(set(xmap) - set(by_lid))
    if only_t:
        problems.append("%d transcript line(s) have no translation row: %s"
                        % (len(only_t), only_t[:10]))
    if only_x:
        problems.append("%d translation row(s) have no transcript line: %s"
                        % (len(only_x), only_x[:10]))

    # Where the translation echoes start/end, they must still agree. Drift here
    # means one of the two passes renumbered or reshifted, and the join would be
    # wrong even though the ids line up.
    drift = []
    for lid, x in xmap.items():
        s = by_lid.get(lid)
        if not s:
            continue
        for col in ("start", "end"):
            if x[col] is None:
                continue
            d = abs(float(s[col]) - x[col])
            if d > JOIN_TOL_S:
                drift.append("%s %s: transcript %.3f vs translation %.3f (delta "
                             "%.3fs)" % (lid, col, float(s[col]), x[col], d))
    if drift:
        problems.append("%d timestamp mismatch(es) between the two files: %s"
                        % (len(drift), drift[:5]))

    if problems:
        _fail(problems, status=409, warnings=warnings,
              extra={"joined_on": "line_id"})

    fname = file.filename or ""
    code = (language_code or "").strip().lower()
    name = _CODE_NAMES.get(code, "")
    if not code:
        _src, pair_tgt = _lang_pair_from_name(fname)
        if pair_tgt:
            code, name = pair_tgt, _CODE_NAMES.get(pair_tgt, "")
        else:
            code, name = _lang_from_name(fname)
    if not code:
        sc = _script_counts("".join(x["target_text"] for x in xmap.values()))
        top = max(sc, key=sc.get)
        code = _SCRIPT_TO_CODE.get(top)
        name = _CODE_NAMES.get(code or "", "")
        if code:
            warnings.append("target language not given and not in the filename; "
                            "guessed '%s' from the script in target_text." % code)
    if not code:
        _fail(["could not determine the target language. Pass it as the "
               "`language_code` form field (e.g. te) or name the file "
               "'<something>-Telugu.csv'."], warnings=warnings)

    # Untranslated rows: target text still carrying the source script is the
    # one content check worth failing on, because it dubs the source language.
    src_sc = _script_counts("".join(s.get("text_original") or "" for s in segments))
    src_top = max(src_sc, key=src_sc.get)
    if src_top != "latn" and _SCRIPT_TO_CODE.get(src_top) != code:
        leaked = [lid for lid, x in xmap.items()
                  if _script_counts(x["target_text"])[src_top] > 0]
        if leaked:
            _fail(["%d target row(s) still contain source-script (%s) text, i.e. they "
                   "were not translated: %s"
                   % (len(leaked), src_top, sorted(leaked)[:12])],
                  status=409, warnings=warnings)

    # Fit budget. Indicative only - character count explains under 10% of real
    # duration variance, and the 20 Aug run measured 31 of 50 lines filling
    # their slot where this proxy predicted 8. Reported, never enforced.
    rate = CPS.get(code, 13.5)
    fits = []
    for s in segments:
        x = xmap[str(s["line_id"])]
        slot = float(s["end"]) - float(s["start"])
        need = len(x["target_text"]) / rate if rate > 0 else 0.0
        if slot > 0 and need > slot * 1.05:
            fits.append({"line_id": s["line_id"], "segment_id": s["id"],
                         "slot_s": round(slot, 3), "needs_s": round(need, 3),
                         "ratio": round(need / slot, 2),
                         "chars": len(x["target_text"])})
    fits.sort(key=lambda d: -d["ratio"])
    if fits:
        warnings.append("%d of %d line(s) have more text than their slot fits at "
                        "%.1f chars/s (worst %.2fx on %s). Under strict_slot these "
                        "are spoken faster, and whatever still overruns is trimmed "
                        "at the slot edge."
                        % (len(fits), len(segments), rate, fits[0]["ratio"],
                           fits[0]["line_id"]))

    for s in segments:
        s["text"] = xmap[str(s["line_id"])]["target_text"]
        note = xmap[str(s["line_id"])]["notes"]
        if note:
            s["csv_notes"] = note
    job["segments"] = segments
    job["language_code"] = code
    job["language"] = name or code
    job["timing_source"] = TIMING_SOURCE
    job["timing_strategy"] = "strict_slot"
    job["slot_fit"] = "off"
    # Keep the raw rows so a transcript re-import can re-apply them without the
    # user uploading this file again.
    imp = job.setdefault("csv_import", {})
    imp["translation"] = {
        "filename": fname,
        "language_code": code,
        "imported_at": time.time(),
        # line_id -> target_text, kept so a transcript re-import can re-apply
        # the translation instead of making the user upload it twice.
        "rows": {lid: x["target_text"] for lid, x in xmap.items()},
        "row_count": len(xmap),
        "warnings": list(warnings),
    }
    _save_job(job_id, job, duration=float(job.get("duration") or 0.0))

    # Assert against the uploaded cells, from the persisted row.
    back = _db_segments(job_id)
    bad = []
    worst = 0.0
    if len(back) != len(segments):
        bad.append("segment count changed on the round trip: %d vs %d"
                   % (len(back), len(segments)))
    for b, s in zip(back, segments):
        x = xmap[str(s["line_id"])]
        if (b.get("text") or "") != x["target_text"]:
            bad.append("%s: target text is not byte-identical to the CSV"
                       % s["line_id"])
        if (b.get("text_original") or "") != (s.get("text_original") or ""):
            bad.append("%s: source text changed during the translation import"
                       % s["line_id"])
        for col in ("start", "end"):
            d = abs(float(b[col]) - float(s[col]))
            worst = max(worst, d)
            if d > ASSERT_TOL_S:
                bad.append("%s: %s moved by %.9fs during the translation import"
                           % (s["line_id"], col, d))
    if bad:
        raise HTTPException(status_code=500, detail={
            "error": "verify_failed",
            "message": ("The translation was written but did not read back "
                        "identical to the CSV. Do not generate from this job."),
            "mismatches": bad[:20],
        })

    logger.info("csv-import: translation %d row(s) into job %s (lang=%s, %d over fit)",
                len(xmap), log_safe(job_id), log_safe(code), len(fits))
    return {
        "job_id": job_id,
        "rows": len(xmap),
        "joined": len(segments),
        "language_code": code,
        "language": name or code,
        "fit_warnings": fits[:40],
        "fit_over_budget": len(fits),
        "chars_per_s_budget": rate,
        "verification": {
            "worst_timestamp_move_s": round(worst, 9),
            "text_byte_identical": True,
            "tolerance_s": ASSERT_TOL_S,
        },
        "defaults": {"timing_strategy": "strict_slot", "slot_fit": "off",
                     "timing_source": TIMING_SOURCE},
        "warnings": warnings,
        "next_step": "generate",
    }


# ---------------------------------------------------------------- status

@router.get("/dub/import/status/{job_id}")
def dub_import_status(job_id: str):
    """What has been imported so far, so a UI can decide which step to show."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    imp = job.get("csv_import") or {}
    t = imp.get("transcript") or {}
    x = imp.get("translation") or {}
    segments = [s for s in (job.get("segments") or []) if isinstance(s, dict)]
    translated = sum(1 for s in segments if (s.get("text") or "").strip())
    vocals = job.get("vocals_path") or ""
    clones = job.get("speaker_clones") or {}
    if not t:
        nxt = "transcript"
    elif not x:
        nxt = "translation"
    else:
        nxt = "generate"
    return {
        "job_id": job_id,
        "filename": job.get("filename") or "",
        "duration": job.get("duration") or 0.0,
        "media_ready": bool(vocals and os.path.isfile(vocals)),
        "is_csv_import": (job.get("timing_source") == TIMING_SOURCE),
        "timing_source": job.get("timing_source") or "",
        "transcript": {
            "imported": bool(t),
            "filename": t.get("filename") or "",
            "rows": t.get("rows") or 0,
            "source_lang": t.get("source_lang") or job.get("source_lang") or "",
            "speakers": t.get("speakers") or {},
            "imported_at": t.get("imported_at"),
            "warnings": t.get("warnings") or [],
        },
        "translation": {
            "imported": bool(x),
            "filename": x.get("filename") or "",
            "rows": x.get("row_count") or 0,
            "language_code": x.get("language_code") or "",
            "imported_at": x.get("imported_at"),
            "warnings": x.get("warnings") or [],
        },
        "segments": len(segments),
        "segments_with_target_text": translated,
        "speaker_clones": sorted(clones),
        "defaults": {
            "timing_strategy": job.get("timing_strategy") or "",
            "slot_fit": job.get("slot_fit") or "",
        },
        "next_step": nxt,
    }
