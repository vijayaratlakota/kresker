"""Speaker-clone extraction.

After diarisation assigns `speaker_id` to every segment, this module picks
the longest clean passage per speaker from the Demucs-isolated vocals track
and writes it as a per-speaker reference WAV. The reference, paired with the
corresponding transcript text, lets zero-shot TTS engines clone the
speaker's voice for dubbing — the central product promise of
"same speaker, new language."

Constraints we live with:
  * Zero-shot TTS wants 5–15 s of clean audio per reference. <5 s risks a
    thin clone; >15 s is wasted context.
  * The reference must be the actual speaker, not background music. Demucs
    handles that upstream — we read from `vocals.wav`, not the raw mix.
  * The accompanying transcript text must align with the audio slice or the
    TTS cloner will mis-align its phoneme lookups.

We don't promote these clones to the persistent voice library; they're
job-scoped (lives next to `seg_N.wav` under `dub_jobs/{id}/`). Users can
promote manually via "Save as Voice Profile" — out of scope here.
"""
from __future__ import annotations

import logging
import os
import re

import numpy as np
import soundfile as sf

logger = logging.getLogger("omnivoice.speaker_clone")

MIN_REF_DURATION_S = 5.0   # below this the clone is thin and unstable
MAX_REF_DURATION_S = 15.0  # above this is just wasted reference context
IDEAL_REF_DURATION_S = 8.0  # target window — long enough for prosody, short enough for coverage

# Per-segment clone refs (Wave 3.2): cutting a reference from a single
# subtitle line gives the dub of that line the prosody/emotion of its source
# line — but a single line is usually short. We use a lower floor than the
# per-speaker MIN (5.0): most dialogue lines are 2-6 s, and a 5 s floor would
# make per-segment refs almost never fire. Below this, the line falls back to
# the per-speaker reference (which always covers ≥ MIN_REF_DURATION_S). 3.0 s
# is the empirical floor below which our zero-shot clone gets unstable.
MIN_SEGMENT_REF_DURATION_S = 3.0

# Clone-purity guards (speaker-hint fix): a per-speaker reference cut from
# mislabeled or boundary-adjacent audio mixes two people's voices and the
# resulting clone sounds "made up".
#   * A slice below MIN_SLICE_DURATION_S is too short to be a reliable
#     single-speaker sample (and diarization boundary jitter dominates it).
#   * A slice whose edges come within ADJACENT_TURN_GUARD_S of a *different*
#     speaker's turn risks bleeding that speaker's audio across the imprecise
#     boundary — deprioritized (scoring preference, not a hard filter, so
#     extraction still succeeds on dense dialogue).
MIN_SLICE_DURATION_S = 1.5
ADJACENT_TURN_GUARD_S = 0.3


def extract_speaker_clones(
    vocals_path: str,
    segments: list[dict],
    out_dir: str,
    *,
    labels_source: str | None = None,
) -> dict[str, dict]:
    """Build a per-speaker reference sample from `vocals_path` + `segments`.

    Returns a dict keyed by `speaker_id`:
        {
          "Speaker 1": {
            "ref_audio": "/abs/path/voice_speaker_1.wav",
            "ref_text":  "…concatenated transcript of the chosen slices…",
            "duration":  7.83,
            "source_count": 2,
          },
          ...
        }

    Speakers whose segments total < MIN_REF_DURATION_S are skipped — we'd
    rather fall back to the default TTS voice than ship a bad clone.

    ``labels_source`` records where the ``speaker_id`` labels came from
    (``"pyannote"`` | ``"turns"`` | ``"heuristic"``; ``None`` = unknown,
    treated as trusted for backward compatibility). ``"heuristic"`` labels
    are silence-gap *estimates*, not voice identity — a reference cut from
    them routinely concatenates two people's audio, so extraction is skipped
    entirely (the caller warns the user and falls back to the default voice).
    """
    if labels_source == "heuristic":
        logger.info(
            "speaker_clone: skipping auto-clone extraction — speaker labels "
            "are gap-based heuristic estimates, not voice identity"
        )
        return {}
    if not vocals_path or not os.path.exists(vocals_path):
        logger.info("speaker_clone: no vocals track at %s; skipping", vocals_path)
        return {}
    if not segments:
        return {}

    try:
        audio, sr = sf.read(vocals_path, dtype="float32", always_2d=False)
    except Exception as e:
        logger.warning("speaker_clone: failed to read %s: %s", vocals_path, e)
        return {}
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # Group by speaker — preserve original segment order for text concat.
    by_speaker: dict[str, list[tuple[int, dict]]] = {}
    for idx, seg in enumerate(segments):
        spk = seg.get("speaker_id") or "Speaker 1"
        by_speaker.setdefault(spk, []).append((idx, seg))

    os.makedirs(out_dir, exist_ok=True)
    out: dict[str, dict] = {}

    for speaker_id, items in by_speaker.items():
        # One batched pass over this speaker's candidate slots. Only slots long enough to be
        # picked at all are scored, so the cost stays proportional to what we might use.
        cand = [seg for _, seg in items
                if (float(seg.get("end", 0.0)) - float(seg.get("start", 0.0)))
                >= MIN_SLICE_DURATION_S]
        _pen: dict[int, int] = {}
        _score: dict[int, float] = {}
        try:
            from services import vocal_events as VE
            if cand and VE.available():
                spans = [(float(s.get("start", 0.0)), float(s.get("end", 0.0)))
                         for s in cand]
                for seg, sc in zip(cand, VE.speech_confidence_many(audio, sr, spans)):
                    if sc is None:
                        continue
                    _score[id(seg)] = sc
                    _pen[id(seg)] = VE.audio_penalty(sc)
                rejected = [s for s in cand if _pen.get(id(s), 0) >= 4]
                if rejected:
                    logger.info(
                        "vocal_events: %s - %d of %d candidate slice(s) are not speech "
                        "(laughter/shouting/crowd); REJECTED, not merely ranked lower",
                        speaker_id, len(rejected), len(cand))
        except Exception as e:
            logger.debug("vocal_events: skipped for %s: %s", speaker_id, e)

        _lvl: dict[int, float] = {}
        for _c in cand:
            _lvl[id(_c)] = _clip_dbfs(audio, sr, _c)

        _common = dict(
            speaker_id=speaker_id,
            all_segments=segments,
            labels_source=labels_source,
            speech_of=lambda seg: _speech_seconds(audio, sr, seg),
            audio_penalty_of=lambda seg: _pen.get(id(seg), 0),
            speech_score_of=lambda seg: _score.get(id(seg)),
            level_of=lambda seg: _lvl.get(id(seg)),
        )
        # Build several candidate references, strictest first, and keep the one that measures
        # best AS ASSEMBLED. Ranking slices individually is not enough: Speaker 1's clips each
        # scored well, yet three of them concatenated scored 0.348 against 0.526 for a longer,
        # laxer selection - the joins read as non-speech and the cloner loses continuous context.
        _assemblies = (
            ("clean, properly spoken", dict(reject_nonspeech=True, require_clean=True,
                                            require_good=True)),
            ("clean",                  dict(reject_nonspeech=True, require_clean=True)),
            ("above the speech gate",  dict(reject_nonspeech=True)),
            ("best available",         dict()),
        )
        best = None          # (score, label, picked, audio)
        for _label, _kw in _assemblies:
            _pick = _pick_reference_slices(items, **_kw, **_common)
            if not _pick:
                continue
            _np_audio = _concat_slices(audio, sr, _pick)
            if _np_audio.size == 0:
                continue
            _sc = None
            try:
                from services import vocal_events as _VE
                if _VE.available():
                    _got = _VE.speech_confidence_many(
                        _np_audio, sr, [(0.0, float(_np_audio.size) / float(sr))])
                    _sc = float(_got[0]) if _got else None
            except Exception:  # noqa: BLE001
                _sc = None
            if _sc is None:
                # No way to judge; take the strictest assembly that produced anything.
                best = (float("nan"), _label, _pick, _np_audio)
                break
            logger.info("speaker_clone: %s candidate reference (%s) scores %.3f over %.2fs",
                        speaker_id, _label, _sc, float(_np_audio.size) / float(sr))
            if best is None or _sc > best[0]:
                best = (_sc, _label, _pick, _np_audio)
            # No early exit. A stricter pass restricts which clips may be used, which can force a
            # short, choppy selection - Speaker 1 scored 0.348 that way while a laxer assembly
            # scored 0.618. Strictness is not quality, so every assembly is measured.

        if best is None:
            # Every assembly failed, which for a minor character means only one thing: they
            # have real audio, just not enough of it in pieces long enough to clear the slice
            # floor. That floor lives inside _pick_reference_slices, so even the "best
            # available" assembly cannot reach past it.
            #
            # The alternative is the engine's stock voice - a stranger speaking that
            # character's lines - and a rough reference of the right person beats that every
            # time. Take whatever they said, shortest pieces included, and say so loudly.
            _lr = [p for p in items if _pair_seconds(p) >= LAST_RESORT_MIN_SLICE_S]
            _lr.sort(key=lambda p: -_pair_seconds(p))
            _take, _tot = [], 0.0
            for _p in _lr:
                if _tot >= MAX_REF_DURATION_S:
                    break
                _take.append(_p)
                _tot += _pair_seconds(_p)
            if _take and _tot >= LAST_RESORT_MIN_TOTAL_S:
                _take.sort(key=lambda p: float((p[1] or {}).get("start") or 0.0))
                _lr_audio = _concat_slices(audio, sr, _take)
                if _lr_audio.size:
                    _lr_score = float("nan")
                    try:
                        from services import vocal_events as _VE
                        if _VE.available():
                            _g = _VE.speech_confidence_many(
                                _lr_audio, sr, [(0.0, float(_lr_audio.size) / float(sr))])
                            _lr_score = float(_g[0]) if _g else float("nan")
                    except Exception:  # noqa: BLE001
                        pass
                    logger.warning(
                        "speaker_clone: %s has only %.1fs of usable audio in %d short "
                        "piece(s) (longest %.1fs), below the %.1fs a clean reference needs. "
                        "Cloning from it anyway, score %s - a rough reference of the right "
                        "person beats the stock voice of a stranger. Expect a thinner clone "
                        "for this character.",
                        speaker_id, _tot, len(_take),
                        max(_pair_seconds(p) for p in _take), MIN_REF_DURATION_S,
                        ("%.3f" % _lr_score) if _lr_score == _lr_score else "unscored")
                    best = (_lr_score, "last resort, short pieces", _take, _lr_audio)
        if best is None:
            logger.warning(
                "speaker_clone: %s has under %.1fs of audio in total; nothing to clone from, "
                "so their lines will use the stock voice",
                speaker_id, LAST_RESORT_MIN_TOTAL_S,
            )
            continue
        chosen = best[2]
        _chosen_audio = best[3]
        logger.info("speaker_clone: %s cloned from the '%s' assembly, score %s",
                    speaker_id, best[1],
                    ("%.3f" % best[0]) if best[0] == best[0] else "unscored")

        ref_audio_np = _chosen_audio
        if ref_audio_np.size == 0:
            continue

        safe_id = _safe_name(speaker_id)
        ref_path = os.path.join(out_dir, f"voice_{safe_id}.wav")
        try:
            sf.write(ref_path, ref_audio_np, sr)
        except Exception as e:
            logger.warning("speaker_clone: failed to write %s: %s", ref_path, e)
            continue

        ref_text = " ".join((seg.get("text") or "").strip() for _, seg in chosen).strip()
        ref_dur = float(ref_audio_np.size) / float(sr)

        # A speaker whose only slice above the floor is longer than the cap
        # still reaches here (the ranking prefers shorter ones but cannot
        # invent them). Shorten audio and transcript together rather than
        # shipping a reference the cloner was never trained to take.
        if ref_dur > MAX_REF_DURATION_S:
            from services.ref_quality import cap_reference
            capped_dur, ref_text = cap_reference(
                ref_path, ref_text,
                max_s=MAX_REF_DURATION_S, target_s=IDEAL_REF_DURATION_S,
            )
            if capped_dur:
                ref_dur = capped_dur

        out[speaker_id] = {
            "ref_audio": ref_path,
            "ref_text": ref_text,
            "duration": ref_dur,
            "source_count": len(chosen),
        }
        if _score:
            picked_scores = [_score[id(seg)] for _, seg in chosen if id(seg) in _score]
            if picked_scores:
                from services import vocal_events as _VE
                logger.info("vocal_events: %s reference is %s",
                            speaker_id, _VE.describe(min(picked_scores)))
        logger.info(
            "speaker_clone: wrote %s (%.2fs from %d slice%s)",
            ref_path, out[speaker_id]["duration"], len(chosen), "" if len(chosen) == 1 else "s",
        )

    # Say out loud what every speaker is being cloned from. A bad reference
    # used to be invisible: the dub completed, the waveform looked plausible,
    # and only listening revealed the wrong voice.
    try:
        from services.ref_quality import audit, corpus_norms
        for line in audit(out, corpus_norms(segments)):
            logger.info("clone reference %s", line)
    except Exception as e:
        logger.debug("speaker_clone: reference audit skipped: %s", e)

    return out


def extract_segment_refs(
    vocals_path: str,
    segments: list[dict],
    out_dir: str,
    *,
    seg_ids: list | None = None,
) -> dict[str, dict]:
    """Per-segment clone references (Wave 3.2 / Spec 4).

    Cut each segment's own slice from the isolated vocals at THAT segment's
    timestamps, so the dub of each line carries the prosody of its source
    line — finer-grained than one reference per speaker. Returns a dict keyed
    by segment id (``seg_ids[i]`` or ``"seg_{i}"``) for segments long enough
    to clone from:

        {"seg_3": {"ref_audio": "/abs/seg_ref_seg_3.wav",
                   "ref_text": "the source-language line",
                   "duration": 4.12}, ...}

    Segments shorter than ``MIN_SEGMENT_REF_DURATION_S`` are omitted — the
    caller falls back to the per-speaker reference for those (a strict
    improvement over per-speaker-only, never a regression). Uses the
    *original* segment timestamps (pre slack-absorption); only the vocals are
    read, never the raw mix.
    """
    if not vocals_path or not os.path.exists(vocals_path) or not segments:
        return {}
    try:
        audio, sr = sf.read(vocals_path, dtype="float32", always_2d=False)
    except Exception as e:
        logger.warning("segment_refs: failed to read %s: %s", vocals_path, e)
        return {}
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    os.makedirs(out_dir, exist_ok=True)
    from services.ref_quality import corpus_norms, slice_text_defect
    _norms = corpus_norms(
        [dict(s, text=(s.get("text_original") or s.get("text") or ""))
         for s in segments if isinstance(s, dict)]
    )
    out: dict[str, dict] = {}
    for i, seg in enumerate(segments):
        seg_id = str(seg_ids[i]) if (seg_ids and i < len(seg_ids)) else f"seg_{i}"
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", 0.0))
        if end - start < MIN_SEGMENT_REF_DURATION_S:
            continue
        s = max(0, int(start * sr))
        e = min(audio.size, int(end * sr))
        if e <= s:
            continue
        clip = audio[s:e].astype(np.float32, copy=False)
        ref_path = os.path.join(out_dir, f"seg_ref_{_safe_name(seg_id)}.wav")
        try:
            sf.write(ref_path, clip, sr)
        except Exception as e2:
            logger.warning("segment_refs: failed to write %s: %s", ref_path, e2)
            continue
        # The vocals slice is source-language audio, so the matching
        # reference transcript is the SOURCE text (text_original), not the
        # translated `text`. Falls back to text only if no original is kept.
        ref_text = (seg.get("text_original") or seg.get("text") or "").strip()
        # A line whose own transcript is unusable - wrong script, or no lexical
        # content - is a broken (audio, text) pair, and cloning "Per line" from
        # it puts the wrong voice on that line. Skip it and let the line fall
        # back to the per-speaker reference, which the gate has validated.
        # Not slice_text_defect: that rejects a repeated exclamation or a shout as
        # low-quality, which is exactly the delivery this reference exists to carry.
        _bad = segref_defect(ref_text, float(clip.size) / float(sr), _norms,
                             clip=clip, sr=sr)
        if _bad:
            logger.info("segment_refs: skipping %s (%s); it will use the "
                        "speaker reference instead", seg_id, _bad)
            continue
        out[seg_id] = {
            "ref_audio": ref_path,
            "ref_text": ref_text,
            "duration": float(clip.size) / float(sr),
        }
    if out:
        logger.info("segment_refs: wrote %d per-segment reference(s)", len(out))
    return out


def refine_ref_text(ref_audio_path: str, asr_backend, fallback_text: str) -> str:
    """Re-transcribe a written reference clip and return that transcript.

    `extract_speaker_clones`/`extract_segment_refs` pair each audio slice with
    the ASR segment's OWN text field, on the assumption that the segment's
    timestamps and its transcribed text agree. They routinely don't — Whisper
    (and friends) frequently drift on segment boundaries: a trailing word
    audible in `[start, end]` but missing from `text`, or vice versa. When the
    (ref_audio, ref_text) pair disagrees, zero-shot TTS prompt-priming breaks
    down and the clone can speak the mismatched reference text itself instead
    of the target-language text it was given to synthesize (issue #1004).

    Re-transcribing the *actual written clip* guarantees the pair matches by
    construction — the model doesn't care whether the original ASR text was
    right, only that ref_text is what's really in ref_audio. `asr_backend` is
    the caller's already-loaded active backend (duck-typed:
    `.transcribe(path, word_timestamps=...) -> dict` with a `chunks` list of
    `{"text": ...}`); the model is already warm, so this costs one more short
    transcribe call, not a fresh load. Falls back to `fallback_text` — never
    raises — so a re-transcribe failure is a strict no-op, never a regression
    from the original (matching) behavior.
    """
    if asr_backend is None:
        return fallback_text
    try:
        result = asr_backend.transcribe(ref_audio_path, word_timestamps=False)
        text = " ".join(
            (c.get("text") or "").strip() for c in (result.get("chunks") or [])
        ).strip()
        return text or fallback_text
    except Exception as e:
        logger.warning(
            "speaker_clone: re-transcribe of %s failed, keeping original ref_text: %s",
            ref_audio_path, e,
        )
        return fallback_text


def _script_majority(entries) -> str | None:
    """The script most of these references are written in.

    Computed over the whole batch, so one mislabelled clip cannot define the
    norm it is then judged against.
    """
    from services.ref_quality import script_counts

    counts: dict[str, int] = {}
    for e in entries:
        for k, v in script_counts(e.get("ref_text") or "").items():
            counts[k] = counts.get(k, 0) + v
    return max(counts.items(), key=lambda kv: kv[1])[0] if counts else None


def _accept_refined(entry: dict, text: str, majority: str | None) -> str:
    """Take a re-transcription only when it does not change script.

    Re-transcribing the written clip is the right way to guarantee the
    reference pair matches, but multilingual ASR occasionally comes back in a
    different language for a short or noisy clip. Pairing a speaker's audio
    with a transcript in the wrong script breaks the zero-shot cloner's
    alignment and produces the wrong voice, or a harsh one - measured on a real
    job, where one speaker's Hindi reference was labelled in Kannada and every
    one of that speaker's lines came back wrong. Everything else about the
    refinement is kept: this only declines a change of script.
    """
    from services.ref_quality import dominant_script

    old = entry.get("ref_text", "") or ""
    if not text or text == old:
        return old
    got = dominant_script(text)
    # Same romanisation exemption the gate uses: Latin over non-Latin audio is
    # how multilingual ASR writes Hindi half the time, not a different language.
    if (majority and got and got != majority
            and not (got == "latn" and majority != "latn")):
        logger.info(
            "speaker_clone: keeping the original reference text for %s - the "
            "re-transcription came back in %s while the rest of this video is %s",
            os.path.basename(entry.get("ref_audio") or "?"), got, majority,
        )
        return old
    return text


# Re-transcribing every reference clip was the bulk of transcription wall clock AND the bulk of
# the old account's audio spend: ~163 short ASR calls on a 9 minute video, about 2.6x the video's
# length in billed audio, every single transcribe.
#
# It only rewrites ref_text for voice cloning - no timing, segmentation or coverage decision - and
# the fallback is the line's own text, which is the right transcript because the clip was cut from
# that line. Off by default; OMNIVOICE_REF_TEXT_REFINE=1 restores it.
REFINE_REF_TEXT = os.environ.get("OMNIVOICE_REF_TEXT_REFINE", "0") not in ("0", "false", "False")
def refine_ref_texts(clones: dict[str, dict], asr_backend) -> dict[str, dict]:
    """Apply `refine_ref_text` to every entry's `ref_text` in place.

    Batches the whole dict (per-speaker `clones` from `extract_speaker_clones`
    or per-segment `seg_clones` from `extract_segment_refs`) into the single
    executor round-trip the caller submits to the GPU pool, rather than one
    dispatch per reference. Mutates and returns `clones` for a convenient
    call-and-reassign at the call site.
    """
    if not REFINE_REF_TEXT:
        logger.info("ref text refine: skipped for %d reference(s); keeping the transcript "
                    "text (set OMNIVOICE_REF_TEXT_REFINE=1 to re-enable)", len(clones))
        return clones
    entries = list(clones.values())
    if not entries:
        return clones
    # Established before anything is replaced, from the texts the picker
    # already accepted.
    _majority = _script_majority(entries)

    # Run several at once when the ASR is a network service.
    #
    # This loop is the bulk of transcription's wall clock: one short transcribe per
    # reference, 163 of them on a 9 minute video, about 8 seconds each because the call
    # crosses the network while the GPU sits idle. The calls are independent - one clip in,
    # one text out, written back under its own key - so running them concurrently changes
    # the schedule and nothing else. It produces no timestamps and takes no segmentation or
    # timing decisions, so line slots are untouched, and refine_ref_text already treats any
    # failure as a no-op that keeps the original text.
    #
    # A local model is a different matter: one model on one GPU, not safe from several
    # threads, so that path stays sequential.
    workers = int(os.environ.get("OMNIVOICE_REF_TEXT_CONCURRENCY", "6"))
    is_network = type(asr_backend).__name__ in (
        "OpenAICompatASRBackend", "OpenAIWhisperAPIBackend",
    )
    if workers > 1 and is_network and len(entries) > 1:
        from concurrent.futures import ThreadPoolExecutor

        def _one(entry):
            return entry, refine_ref_text(
                entry["ref_audio"], asr_backend, entry.get("ref_text", "")
            )

        logger.info(
            "speaker_clone: refining %d reference text(s), %d at a time",
            len(entries), workers,
        )
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for entry, text in pool.map(_one, entries):
                entry["ref_text"] = _accept_refined(entry, text, _majority)
        return clones

    for entry in entries:
        entry["ref_text"] = _accept_refined(
            entry,
            refine_ref_text(entry["ref_audio"], asr_backend,
                            entry.get("ref_text", "")),
            _majority,
        )
    return clones


# ── Internals ───────────────────────────────────────────────────────────────


def _adjacent_to_other_speaker(
    seg: dict, speaker_id: str, all_segments: list[dict] | None
) -> bool:
    """True when `seg`'s edges come within ADJACENT_TURN_GUARD_S of (or
    overlap) a segment attributed to a *different* speaker — a boundary where
    imprecise diarization timestamps risk bleeding the other voice into the
    reference slice."""
    if not all_segments:
        return False
    s0 = float(seg.get("start", 0.0))
    s1 = float(seg.get("end", 0.0))
    for other in all_segments:
        if other is seg:
            continue
        if (other.get("speaker_id") or "Speaker 1") == speaker_id:
            continue
        o0 = float(other.get("start", 0.0))
        o1 = float(other.get("end", 0.0))
        # Signed gap between the two spans; negative = overlap.
        if max(o0 - s1, s0 - o1) < ADJACENT_TURN_GUARD_S:
            return True
    return False


def _combined_key(duration: float, text: str, norms, audio_pen: int):
    """Rank on text defects and audio defects together, worst last.

    Both are graded and simply added: a clip that is unfit on BOTH counts must rank below one
    that is only doubtful on one of them. The remaining terms are the original ones - inside
    the duration cap, then closest to the ideal window.
    """
    from services.ref_quality import defect_severity, MAX_REF_S, IDEAL_REF_S

    return (
        defect_severity(duration, text, norms) + max(0, int(audio_pen)),
        1 if duration > MAX_REF_S else 0,
        abs(duration - IDEAL_REF_S),
    )


def _pick_reference_slices(
    items: list[tuple[int, dict]],
    *,
    speaker_id: str | None = None,
    all_segments: list[dict] | None = None,
    labels_source: str | None = None,
    speech_of=None,
    audio_penalty_of=None,
    speech_score_of=None,
    level_of=None,
    reject_nonspeech: bool = False,
    require_clean: bool = False,
    require_good: bool = False,
) -> list[tuple[int, dict]]:
    """Select the subset of a speaker's segments to use as reference audio.

    Strategy: rank candidates clean-first (not temporally adjacent to a
    different speaker's turn — see ``_adjacent_to_other_speaker``), longest
    first within each tier, and accumulate until IDEAL_REF_DURATION_S is
    cleared. Adjacency is a scoring preference, NOT a hard filter — on dense
    dialogue where every slice borders another speaker, extraction still
    succeeds using the adjacent ones. Two hard guards protect clone purity:

    * slices shorter than MIN_SLICE_DURATION_S are rejected outright
      (boundary jitter dominates them, so they're the likeliest to carry a
      second speaker's audio);
    * ``labels_source="heuristic"`` returns [] — gap-based labels are not
      voice identity, so no slice of them is safe to clone from.

    Cap at MAX_REF_DURATION_S. Return [] if we can't reach
    MIN_REF_DURATION_S. When ``all_segments``/``speaker_id`` are not
    provided (legacy callers), adjacency scoring degrades to duration-only —
    the pre-guard behavior.
    """
    if not items:
        return []
    if labels_source == "heuristic":
        return []
    if speaker_id is None:
        speaker_id = items[0][1].get("speaker_id") or "Speaker 1"

    def _slot(pair) -> float:
        return max(0.0, float(pair[1].get("end", 0.0)) - float(pair[1].get("start", 0.0)))

    def _dur(pair) -> float:
        """What the cloner will actually receive from this slice.

        Speech seconds when the audio is available, slot length otherwise. Ranking,
        the duration cap and the transcript-density check all use this, so a line
        that is 13 characters in a 9.7s slot is judged as the ~1.3s of voice it is
        rather than as a long, dense-looking reference.
        """
        if speech_of is None:
            return _slot(pair)
        try:
            got = float(speech_of(pair[1]))
        except Exception:
            return _slot(pair)
        return got if got > 0 else _slot(pair)

    # Rank: usable transcript first, then inside the duration cap, then
    # clean (non-adjacent), then CLOSEST TO IDEAL.
    #
    # This used to rank longest-first, which actively selected the worst
    # available clip: on a real job it handed one speaker a 33.4s reference
    # for 72 of 109 lines, because the MAX_REF_DURATION_S check below only
    # applies once something has already been picked. Ranking by closeness to
    # the target window makes the cap almost never the thing that saves us.
    #
    # The transcript matters as much as the audio - a zero-shot cloner aligns
    # one against the other, so a wrong-script or contentless line is a bad
    # reference no matter how clean the audio is. See services/ref_quality.py
    # for what "bad" means and how it is measured against this transcript's
    # own script and speaking rate.
    from services.ref_quality import corpus_norms, sort_key

    _norms = corpus_norms(all_segments if all_segments else [s for _, s in items])

    # The audio-side gate answers a question the transcript cannot: whether the clip is a
    # VOICE TALKING at all. Laughter, shouting and crowd noise all land in the Demucs vocal
    # stem, and a line whose text looks fine can still hold a burst of crowd noise. Scored
    # in one batched call for the whole speaker; see services/vocal_events.py for the
    # measurement behind the thresholds.
    def _audio_pen(seg) -> int:
        if audio_penalty_of is None:
            return 0
        try:
            return int(audio_penalty_of(seg))
        except Exception:
            return 0

    # Loudness tie-break: once defects and adjacency have spoken, prefer the louder clip.
    # A reference 6 dB below its neighbours clones thin and breathy.
    _loudest = None
    if level_of is not None:
        _levels = []
        for _p in items:
            try:
                _v = level_of(_p[1])
            except Exception:  # noqa: BLE001
                _v = None
            if _v is not None:
                _levels.append(float(_v))
        if _levels:
            _loudest = max(_levels)

    def _level_tier(pair) -> int:
        if level_of is None or _loudest is None:
            return 0
        try:
            v = level_of(pair[1])
        except Exception:  # noqa: BLE001
            return 0
        if v is None:
            return 0
        return 0 if float(v) >= _loudest - LEVEL_TIER_DB else 1

    from services.ref_quality import defect_severity, MAX_REF_S, IDEAL_REF_S

    def _speech_of_seg(seg):
        if speech_score_of is None:
            return None
        try:
            v = speech_score_of(seg)
        except Exception:  # noqa: BLE001
            return None
        return None if v is None else float(v)

    def _speech_tier(seg) -> int:
        """Is this character talking cleanly here? Ranked ABOVE duration on purpose: a clip that
        is 8 seconds long is worthless if the character is shouting through it, and Speaker 4 was
        cloned from a 0.791 clip while a 0.939 one went unused because duration decided."""
        sc = _speech_of_seg(seg)
        if sc is None:
            return 1
        good, reject = _speech_good(), _nonspeech_reject()
        if sc >= good:
            return 0
        if sc >= reject:
            return 1
        return 2

    def _sort_key(pair):
        idx, seg = pair
        dur = _dur(pair)
        text = seg.get("text") or ""
        sc = _speech_of_seg(seg)
        return (
            defect_severity(dur, text, _norms) + max(0, _audio_pen(seg)),
            _speech_tier(seg),
            1 if _adjacent_to_other_speaker(seg, speaker_id, all_segments) else 0,
            1 if dur > MAX_REF_S else 0,
            -round(sc, 2) if sc is not None else 0.0,
            abs(dur - IDEAL_REF_S),
            _level_tier(pair),
            idx,
        )

    ranked = sorted(items, key=_sort_key)

    picked: list[tuple[int, dict]] = []
    total = 0.0
    for idx, seg in ranked:
        dur = _dur((idx, seg))
        # The slot guard stays on the slot: it exists because short slots have
        # jittery boundaries and are the likeliest to carry a second voice.
        if _slot((idx, seg)) < MIN_SLICE_DURATION_S:
            continue
        if speech_of is not None and dur < MIN_SPEECH_IN_SLICE_S:
            continue
        # A slice touching another speaker's turn may carry that voice - and _voiced_span pads
        # outward by SPEECH_PAD_S, which on such a boundary reaches into them. Cloning from it
        # produces a voice that sounds like two people, so prefer to refuse it outright.
        if require_clean and _adjacent_to_other_speaker(seg, speaker_id, all_segments):
            continue
        # Only clips where the character is talking properly, when such clips exist.
        if require_good and speech_score_of is not None:
            try:
                _g = speech_score_of(seg)
            except Exception:  # noqa: BLE001
                _g = None
            if _g is not None and float(_g) < _speech_good():
                continue
        # The hard gate. A clip that is not a voice talking cannot be this character's voice.
        if reject_nonspeech and speech_score_of is not None:
            try:
                _sc = speech_score_of(seg)
            except Exception:  # noqa: BLE001
                _sc = None
            if _sc is not None and float(_sc) < _nonspeech_reject():
                continue
        if total + dur > MAX_REF_DURATION_S and picked:
            # Ranking is no longer duration-monotonic, so a later (shorter or
            # adjacent) slice may still fit — skip, don't stop.
            continue
        picked.append((idx, seg))
        total += dur
        if total >= IDEAL_REF_DURATION_S:
            break

    if total < MIN_REF_DURATION_S:
        return []

    # Restore original order so concatenated transcript reads left-to-right.
    picked.sort(key=lambda pair: pair[0])
    return picked


#: A slice must carry at least this much voice to be worth cloning from. A 9.7s
#: slot holding one word is not a 9.7s reference.
MIN_SPEECH_IN_SLICE_S = 0.8

#: Last resort for a speaker with too little audio for a clean reference. Their own voice,
#: roughly cloned, is better than the engine's stock voice - which is a stranger speaking
#: their lines. Only a total this small is genuinely unusable.
LAST_RESORT_MIN_TOTAL_S = float(os.environ.get("OMNIVOICE_CLONE_LAST_RESORT_TOTAL_S", "2.0"))
#: Pieces shorter than this carry no usable voice, only onsets and room tone.
LAST_RESORT_MIN_SLICE_S = float(os.environ.get("OMNIVOICE_CLONE_LAST_RESORT_SLICE_S", "0.7"))


def _pair_seconds(pair) -> float:
    """Seconds of the (score, segment) pair the slice pickers pass around."""
    try:
        seg = pair[1] if isinstance(pair, (tuple, list)) else pair
        return max(0.0, float((seg or {}).get("end") or 0.0)
                   - float((seg or {}).get("start") or 0.0))
    except Exception:  # noqa: BLE001
        return 0.0
#: Kept either side of the voiced span so the cut lands in room tone rather than on
#: a consonant, and the cloner still hears the attack of the first phoneme.
SPEECH_PAD_S = 0.12


def _voiced_span(clip: np.ndarray, sr: int):
    """(start, end) sample offsets of the voiced part of `clip`, or None.

    Gate is derived from the clip's own loudness so a quiet recording and a loud one
    are judged on their own terms - the same reasoning as the proxy's VAD, and for
    the same reason: a fixed dB threshold does not survive real material.
    """
    if clip.size < int(0.05 * sr):
        return None
    hop = max(1, int(0.02 * sr))
    n = clip.size // hop
    if n < 3:
        return None
    frames = clip[:n * hop].reshape(n, hop)
    rms = np.sqrt(np.mean(np.square(frames.astype(np.float64)), axis=1))
    peak = float(np.percentile(rms, 95))
    if peak <= 1e-6:
        return None
    gate = max(peak * 0.06, 1e-5)          # ~24 dB below this clip's speech peak
    loud = np.nonzero(rms > gate)[0]
    if loud.size == 0:
        return None
    pad = int(SPEECH_PAD_S * sr)
    a = max(0, int(loud[0]) * hop - pad)
    b = min(clip.size, (int(loud[-1]) + 1) * hop + pad)
    if b <= a:
        return None
    return a, b


def _speech_seconds(audio: np.ndarray, sr: int, seg: dict) -> float:
    """Seconds of voice inside a segment's slot, measured from the audio."""
    try:
        start = max(0, int(float(seg.get("start", 0.0)) * sr))
        end = min(audio.size, int(float(seg.get("end", 0.0)) * sr))
    except (TypeError, ValueError):
        return 0.0
    if end <= start:
        return 0.0
    span = _voiced_span(audio[start:end], sr)
    if not span:
        return 0.0
    a, b = span
    return (b - a) / float(sr)


def _concat_slices(audio: np.ndarray, sr: int, picked: list[tuple[int, dict]]) -> np.ndarray:
    """Concatenate the picked segment audio slices into one reference array."""
    parts: list[np.ndarray] = []
    for _, seg in picked:
        start = int(float(seg.get("start", 0.0)) * sr)
        end = int(float(seg.get("end", 0.0)) * sr)
        if start < 0:
            start = 0
        if end > audio.size:
            end = audio.size
        if end <= start:
            continue
        clip = audio[start:end]
        # Trim the slot's silence. Without this a sparse line contributes seconds of
        # room tone to a reference that its transcript claims is all speech.
        span = _voiced_span(clip, sr)
        if span:
            clip = clip[span[0]:span[1]]
        if clip.size == 0:
            continue
        parts.append(clip)
    if not parts:
        return np.zeros(0, dtype=np.float32)
    # A 20 ms silence pad between slices keeps the TTS reference clean and
    # gives the phoneme aligner something to anchor on at the boundary.
    gap = np.zeros(int(0.02 * sr), dtype=np.float32)
    out: list[np.ndarray] = []
    for i, part in enumerate(parts):
        if i > 0:
            out.append(gap)
        out.append(part.astype(np.float32, copy=False))
    return np.concatenate(out)


def _safe_name(speaker_id: str) -> str:
    """`Speaker 1` → `speaker_1`. Keeps filenames portable across OSes."""
    cleaned = []
    for ch in speaker_id.lower():
        if ch.isalnum():
            cleaned.append(ch)
        elif ch in (" ", "-"):
            cleaned.append("_")
    return "".join(cleaned) or "speaker"


def auto_profile_id(speaker_id: str) -> str:
    """Stable profile id prefix so `_gen` can tell auto-clones apart from
    persistent voice-profile ids."""
    return f"auto:{_safe_name(speaker_id)}"


def build_cast_sources(
    segments: list[dict],
    speaker_clones: dict[str, dict] | None,
    segment_clones: dict[str, dict] | None,
) -> dict[str, dict]:
    """Return path-free metadata for every usable ``From video`` voice.

    A trusted diarizer can produce a pooled per-speaker clone.  When it
    cannot, the pipeline still extracts clean per-segment references; those
    references are valid voice prompts even though they are not reliable
    evidence for grouping identities.  The cast UI needs to know that a
    speaker label has at least one usable source without receiving host paths
    or transcript text.
    """
    sources: dict[str, dict] = {}
    for speaker_id, info in (speaker_clones or {}).items():
        sources[speaker_id] = {
            "duration": float(info.get("duration") or 0.0),
            "source_count": int(info.get("source_count") or 1),
            "kind": "speaker",
        }

    for segment in segments or []:
        if not isinstance(segment, dict):
            continue
        speaker_id = segment.get("speaker_id") or "Speaker 1"
        current = sources.get(speaker_id)
        if current and current.get("kind") == "speaker":
            continue
        info = (segment_clones or {}).get(str(segment.get("id", "")))
        if not info or not info.get("ref_audio"):
            continue
        duration = float(info.get("duration") or 0.0)
        if current is None or duration > current["duration"]:
            sources[speaker_id] = {
                "duration": duration,
                "source_count": 1,
                "kind": "segment",
            }
    return sources

#: A candidate below this speech confidence is not a voice talking, so it may not be cloned from.
#: Measured over 110 labelled clips: under 0.30 catches every clip that poisoned a clone at zero
#: cost to real dialogue. Sourced from vocal_events so there is one threshold, not two.
def _nonspeech_reject() -> float:
    try:
        from services import vocal_events as _VE
        return float(os.environ.get("OMNIVOICE_CLONE_SPEECH_REJECT", _VE.SPEECH_REJECT))
    except Exception:  # noqa: BLE001
        return float(os.environ.get("OMNIVOICE_CLONE_SPEECH_REJECT", "0.30"))


def _speech_good() -> float:
    """The score at which a clip counts as the character talking properly, not merely voicing."""
    try:
        from services import vocal_events as _VE
        return float(os.environ.get("OMNIVOICE_CLONE_SPEECH_GOOD", _VE.SPEECH_GOOD))
    except Exception:  # noqa: BLE001
        return float(os.environ.get("OMNIVOICE_CLONE_SPEECH_GOOD", "0.55"))


#: Within this many dB of the loudest candidate counts as "equally loud" for tie-breaking.
LEVEL_TIER_DB = float(os.environ.get("OMNIVOICE_CLONE_LEVEL_TIER_DB", "6.0"))


def _clip_dbfs(audio, sr, seg) -> float:
    """RMS level of one candidate slice, in dBFS. Quiet references clone thin and breathy, so
    level is worth a tie-break once defects and adjacency have had their say."""
    try:
        a = int(max(0.0, float(seg.get("start", 0.0))) * sr)
        b = int(max(0.0, float(seg.get("end", 0.0))) * sr)
        if b <= a:
            return -120.0
        clip = audio[a:b]
        if clip.size == 0:
            return -120.0
        import numpy as _np
        rms = float(_np.sqrt(_np.mean(clip.astype("float32") ** 2)) + 1e-12)
        return 20.0 * _np.log10(rms)
    except Exception:  # noqa: BLE001
        return -120.0


# ------------------------------------------- keeping per-segment references usable
#: Below this share of lines having their own reference, rebuild rather than limp on with
#: the pooled clone. Not zero: a job may legitimately have a few short lines with no clip
#: of their own, and rebuilding for those would be pointless churn.
SEGREF_MIN_COVERAGE = float(os.environ.get("OMNIVOICE_SEGREF_MIN_COVERAGE", "0.20"))


def segref_coverage(job, seg_ids=None):
    """How many of the lines about to be rendered have a reference of their own.

    Returns ``(hits, total, share)``. A reference only counts when its file still exists -
    a stale path is exactly as useless as a missing key, and both end in the pooled clone.
    """
    ids = [str(i) for i in (seg_ids or [s.get("id") for s in (job.get("segments") or [])])
           if i is not None]
    sc = job.get("segment_clones") or {}
    hits = 0
    for i in ids:
        info = sc.get(i)
        p = (info or {}).get("ref_audio")
        if p and os.path.exists(p):
            hits += 1
    return hits, len(ids), (hits / len(ids)) if ids else 0.0


def ensure_segment_refs(job, job_dir, *, seg_ids=None, vocals_path=None):
    """Guarantee the per-segment references match the ids being rendered.

    Per-segment references are what give each line the prosody of its own source line;
    the pooled per-speaker clone is a fallback that delivers every line identically. The
    keys are segment ids, and any re-cut of the transcript renames them, so this has to be
    checked at render time rather than assumed from prepare time.

    Returns a dict for the log. Never raises: a failure here must leave the render exactly
    as it would have been.
    """
    out = {"before": 0.0, "after": 0.0, "rebuilt": False, "hits": 0, "total": 0,
           "reason": ""}
    try:
        if not job.get("per_segment_refs", True):
            out["reason"] = "per-segment references are turned off for this job"
            return out
        hits, total, share = segref_coverage(job, seg_ids)
        out.update(before=share, after=share, hits=hits, total=total)
        if not total:
            out["reason"] = "no segments"
            return out
        vocals = vocals_path or job.get("vocals_path") or job.get("audio_path")
        if not vocals or not os.path.exists(vocals):
            out["reason"] = "no vocals on disk to cut references from"
            return out
        # The coverage gate guards the expensive full re-extraction only. Whatever the
        # overall figure, a line with no reference of its own still gets delivered in the
        # pooled voice, so it still needs a top-up. Gating the top-up on overall coverage
        # measured 57% on a real job and left 55 lines - including every line of a minor
        # character - permanently on the pooled clone.
        if share >= SEGREF_MIN_COVERAGE:
            ids = [str(i) for i in (seg_ids or [s.get("id") for s in (job.get("segments") or [])])]
            widened = _widen_short_refs(job, job_dir or os.path.dirname(vocals), ids, vocals)
            hits2, total2, share2 = segref_coverage(job, ids)
            out.update(after=share2, hits=hits2, total=total2, widened=widened,
                       rebuilt=bool(widened),
                       reason=("topped up %d line(s) that had none" % widened) if widened
                              else "coverage is fine")
            return out
        segments = job.get("segments") or []
        ids = [str(i) for i in (seg_ids or [s.get("id") for s in segments])]
        # Segments are matched by id, not by position. A partial render sends a handful of
        # ids against a job holding all of them, and requiring the two lists to line up
        # positionally made this whole pass a no-op on exactly that path - which is the
        # common one, since re-rendering one edited line is a partial render.
        _by_id = {str(s.get("id")): s for s in segments if s.get("id") is not None}
        want = [i for i in ids if i in _by_id]
        if not want:
            out["reason"] = ("none of the %d id(s) being rendered match the job's segments"
                             % len(ids))
            return out
        _subset = [_by_id[i] for i in want]

        fresh = extract_segment_refs(vocals, _subset, job_dir or os.path.dirname(vocals),
                                     seg_ids=want)
        if not fresh:
            out["reason"] = "re-extraction produced nothing"
            return out
        # Merge, not replace: an explicitly chosen cross-binding under some other key has
        # to survive a rebuild.
        merged = dict(job.get("segment_clones") or {})
        merged.update(fresh)
        job["segment_clones"] = merged
        # Lines too short for a reference of their own would still fall back to the
        # pooled clone, so widen their window rather than giving up on them.
        widened = _widen_short_refs(job, job_dir or os.path.dirname(vocals), ids, vocals)
        hits2, total2, share2 = segref_coverage(job, ids)
        out.update(after=share2, rebuilt=True, hits=hits2, total=total2, widened=widened,
                   reason="rebuilt %d reference(s)%s"
                          % (len(fresh),
                             ", widened %d short one(s)" % widened if widened else ""))
    except Exception as e:  # noqa: BLE001 - never fail a render over this
        out["reason"] = "%s: %s" % (type(e).__name__, e)
    return out


def segref_report(res) -> str:
    """One line for the log. The percentage is always printed, including 0%."""
    r = res or {}
    base = ("segment refs: %d of %d line(s) have a reference of their own (%.0f%%)"
            % (r.get("hits", 0), r.get("total", 0), 100.0 * r.get("after", 0.0)))
    if r.get("rebuilt"):
        return (base + " - was %.0f%%, %s. Lines without one fall back to the pooled "
                "per-speaker clone and lose their own delivery."
                % (100.0 * r.get("before", 0.0), r.get("reason", "")))
    if r.get("after", 0.0) < 1.0:
        return (base + " (%s). The rest fall back to the pooled per-speaker clone, which "
                "delivers every line the same way." % r.get("reason", ""))
    return base


#: A widened reference aims for this much audio. Same figure as the skip threshold, so a
#: line that was skipped for being short now gets exactly enough.
SEGREF_PAD_TO_S = float(os.environ.get("OMNIVOICE_SEGREF_PAD_TO_S", "3.0"))
#: Never widen further than this in total, or a one-word line ends up cloned from a
#: paragraph and stops sounding like that moment at all.
SEGREF_PAD_MAX_S = float(os.environ.get("OMNIVOICE_SEGREF_PAD_MAX_S", "6.0"))


def _text_window(text, lo_frac, hi_frac):
    """The words of `text` lying between two fractions of its span, by word count.

    `_text_fraction` handles a slice taken from one END; this handles a slice taken from the
    MIDDLE, which is what `_own_span_ref` needs: it keeps the loudest window inside a line's
    span, and that window may start anywhere. Pairing the whole line's transcript with a
    window that holds part of it is the same defect that gave _widen_short_refs a 2.0-2.6x
    overrun and _fallback_words ~15x.
    """
    ws = (text or "").split()
    if not ws:
        return ""
    lo = max(0.0, min(1.0, float(lo_frac)))
    hi = max(0.0, min(1.0, float(hi_frac)))
    if hi <= lo:
        return " ".join(ws)
    if lo <= 0.001 and hi >= 0.999:
        return " ".join(ws)
    i = int(round(len(ws) * lo))
    j = int(round(len(ws) * hi))
    i = max(0, min(i, len(ws) - 1))
    j = max(i + 1, min(j, len(ws)))
    return " ".join(ws[i:j])


def _text_fraction(text, frac, *, tail=False):
    """The leading (or trailing) `frac` of a transcript, by word count.

    Used when a widened window covers only part of a neighbouring line. Appending that
    line's WHOLE transcript is what gave c004 6.0s of audio described by an 11.9s
    transcript (2.0x), c009 2.6x and c011 2.1x - and all of them leaked the surplus text,
    which has no audio behind it, into the front of the dubbed line. Word-proportional is
    approximate, but it keeps audio and transcript in step, and refusing the neighbour
    outright would leave the shortest lines with no reference at all.
    """
    ws = (text or "").split()
    if not ws:
        return ""
    if frac >= 0.999:
        return " ".join(ws)
    n = max(1, int(round(len(ws) * max(0.0, min(1.0, frac)))))
    return " ".join(ws[-n:] if tail else ws[:n])


def _widen_short_refs(job, job_dir, ids, vocals_path):
    """Give a reference to lines too short for one, by widening the window.

    Widening stops at a neighbouring line belonging to a different speaker, and every
    neighbouring line the window does absorb contributes its text - ref_audio and ref_text
    have to describe the same sound or the clone degrades.

    Returns the number of references added.
    """
    segments = job.get("segments") or []
    if not segments or not vocals_path or not os.path.exists(vocals_path):
        return 0
    try:
        audio, sr = sf.read(vocals_path, dtype="float32", always_2d=False)
    except Exception as e:  # noqa: BLE001
        logger.info("segment refs: cannot read %s: %s", vocals_path, e)
        return 0
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    dur = audio.size / float(sr)
    # sf.write does not create the directory, and the failure surfaces only as one info
    # line per skipped reference - which read as "nothing to widen" in a test.
    try:
        os.makedirs(job_dir, exist_ok=True)
    except OSError as e:
        logger.info("segment refs: cannot use %s: %s", job_dir, e)
        return 0

    # Every line of the job is a row, because widening a short line looks at its
    # neighbours - but only the ids being rendered are given a reference. Rows are keyed by
    # the segment's OWN id; the earlier version indexed `ids` positionally and mislabelled
    # every row as soon as a partial render passed a shorter list.
    wanted = {str(i) for i in (ids or [])}
    rows = []
    for seg in segments:
        sid = str(seg.get("id"))
        rows.append((sid, float(seg.get("start") or 0.0), float(seg.get("end") or 0.0),
                     str(seg.get("speaker_id") or ""),
                     (seg.get("text_original") or seg.get("text") or "").strip()))
    rows.sort(key=lambda r: r[1])
    sc = job.get("segment_clones") or {}
    added = 0
    for k, (sid, a, b, spk, text) in enumerate(rows):
        if wanted and sid not in wanted:
            continue
        info = sc.get(sid)
        if info and info.get("ref_audio") and os.path.exists(info["ref_audio"]):
            continue
        if b - a <= 0.05 or not text:
            continue
        need = SEGREF_PAD_TO_S - (b - a)
        if need <= 0:
            # Long enough on its own, so it was skipped for a text reason rather than a
            # duration one. Cut from its own span instead of leaving it on the pooled clone.
            if _own_span_ref(job, job_dir, sid, a, b, text, audio, sr, sc):
                added += 1
            continue
        lo, hi = a, b
        parts = [(a, b, text)]   # (start, end, transcript) of every absorbed line
        # Walk outward, alternating sides, taking only same-speaker neighbours.
        left, right = k - 1, k + 1
        while (hi - lo) < SEGREF_PAD_TO_S and (hi - lo) < SEGREF_PAD_MAX_S:
            grew = False
            if right < len(rows) and rows[right][3] == spk:
                _sid, ra, rb, _s, rtext = rows[right]
                if ra - hi < 1.0:        # contiguous enough to be the same moment
                    # max(b, ...) so the clamp can never push the window past the end of
                    # the line it exists to describe.
                    hi = max(b, min(dur, rb, lo + SEGREF_PAD_MAX_S))
                    if rtext:
                        parts.append((ra, rb, rtext))
                    right += 1
                    grew = True
            if (hi - lo) < SEGREF_PAD_TO_S and left >= 0 and rows[left][3] == spk:
                _sid, la, lb, _s, ltext = rows[left]
                if lo - lb < 1.0:
                    # min(a, ...) for the same reason, in the other direction: this is the
                    # clamp that silently cut 4 of 13 lines out of their own reference.
                    lo = min(a, max(0.0, la, hi - SEGREF_PAD_MAX_S))
                    if ltext:
                        parts.append((la, lb, ltext))
                    left -= 1
                    grew = True
            if not grew:
                break
        # Silence either side is worth having if there was no same-speaker neighbour: it
        # gives the model room without putting another voice in the reference.
        if (hi - lo) < SEGREF_PAD_TO_S:
            slack = (SEGREF_PAD_TO_S - (hi - lo)) / 2.0
            floor = rows[k - 1][2] if k else 0.0
            ceil = rows[k + 1][1] if k + 1 < len(rows) else dur
            lo = min(a, max(0.0, floor, lo - slack))
            hi = max(b, min(dur, ceil, hi + slack))
        if hi - lo < MIN_SLICE_DURATION_S:
            continue                     # still nothing usable; the pooled clone it is
        s0, e0 = max(0, int(lo * sr)), min(audio.size, int(hi * sr))
        if e0 <= s0:
            continue
        clip = audio[s0:e0].astype(np.float32, copy=False)
        path = os.path.join(job_dir, "seg_ref_%s_wide.wav" % re.sub(r"[^A-Za-z0-9_.-]", "_", sid))
        try:
            sf.write(path, clip, sr)
        except Exception as e:  # noqa: BLE001
            logger.info("segment refs: cannot write %s: %s", path, e)
            continue
        parts.sort(key=lambda p: p[0])
        # Assemble the transcript from the FINISHED window. A line wholly inside it
        # contributes all of its text; a line the window only clips contributes the
        # proportional part that is actually present. Doing it here rather than during
        # the growth loop also covers the silence-padding branch, which moves lo/hi
        # after the loop has run.
        _chunks = []
        for _ps, _pe, _ptext in parts:
            if not _ptext or _pe <= lo + 0.02 or _ps >= hi - 0.02:
                continue
            if _ps >= lo - 0.02 and _pe <= hi + 0.02:
                _chunks.append(_ptext)
                continue
            _oa, _ob = max(_ps, lo), min(_pe, hi)
            _frac = (_ob - _oa) / max(_pe - _ps, 0.01)
            _chunks.append(_text_fraction(_ptext, _frac, tail=(_ob >= _pe - 0.02)))
        _ref_text = " ".join(t for t in _chunks if t).strip()
        try:
            from services.ref_quality import DENSITY_WARN, corpus_norms, overrun_ratio
            _wn = corpus_norms([dict(s, text=(s.get("text_original") or s.get("text") or ""))
                                for s in (job.get("segments") or []) if isinstance(s, dict)])
            _r = overrun_ratio(_ref_text, hi - lo, _wn)
            if _r >= DENSITY_WARN:
                logger.warning("segment refs: %s reference transcript describes %.2fx the "
                               "speech its %.2fs clip holds - the cloner may speak the "
                               "surplus", sid, _r, hi - lo)
        except Exception:  # noqa: BLE001 - a log line must never fail a render
            pass
        sc[sid] = {"ref_audio": path,
                   "ref_text": _ref_text,
                   "duration": round(hi - lo, 3),
                   "widened_from_s": round(b - a, 3),
                   # Recorded so the window can be checked rather than inferred.
                   "win_start": round(lo, 3), "win_end": round(hi, 3)}
        added += 1
    if added:
        job["segment_clones"] = sc
        logger.info("segment refs: widened the window for %d short line(s) so they keep "
                    "their own delivery", added)
    return added


#: A reference cut from a long line's own span is capped at this, and must be at least this
#: fraction speech - otherwise a sparse line (one word spread over fourteen seconds, which
#: this pipeline does produce) would hand the model silence labelled with a word.
OWN_SPAN_REF_MAX_S = float(os.environ.get("OMNIVOICE_OWN_SPAN_REF_MAX_S", "8.0"))
OWN_SPAN_MIN_VOICED = float(os.environ.get("OMNIVOICE_OWN_SPAN_MIN_VOICED", "0.40"))


def _own_span_ref(job, job_dir, sid, a, b, text, audio, sr, sc):
    """Reference for a line long enough to need no widening but still without one.

    Takes the loudest window inside the line's own span, so a line whose speech sits in one
    part of a badly cut slot still gets its own delivery. Returns True when one was written.
    """
    try:
        s0, e0 = max(0, int(a * sr)), min(audio.size, int(b * sr))
        if e0 - s0 < int(MIN_SLICE_DURATION_S * sr):
            return False
        span = audio[s0:e0]
        win = int(min(OWN_SPAN_REF_MAX_S, (e0 - s0) / sr) * sr)
        frame = max(1, int(0.02 * sr))
        usable = (span.size // frame) * frame
        if usable < frame * 2:
            return False
        rms = np.sqrt((span[:usable].reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
        # loudest contiguous window, by frame energy
        per = max(1, win // frame)
        if per >= rms.size:
            off = 0
        else:
            csum = np.concatenate([[0.0], np.cumsum(rms)])
            tot = csum[per:] - csum[:-per]
            off = int(np.argmax(tot)) * frame
        clip = span[off:off + win].astype(np.float32, copy=False)
        if clip.size < int(MIN_SLICE_DURATION_S * sr):
            return False
        db = 20 * np.log10(np.sqrt((clip[:(clip.size // frame) * frame]
                                   .reshape(-1, frame) ** 2).mean(axis=1) + 1e-12))
        gate = min(float(np.quantile(db, 0.95)) - 25.0, -45.0)
        voiced = float((db > gate).mean())
        if voiced < OWN_SPAN_MIN_VOICED:
            logger.info("segment refs: %s is only %.0f%% speech across its slot - leaving it "
                        "on the pooled clone rather than cloning from silence",
                        sid, 100.0 * voiced)
            return False
        # This path applied no text check at all, which was too lax in the other
        # direction: a transcript that does not describe its audio breaks cloning.
        _norms = None
        try:
            from services.ref_quality import corpus_norms
            _norms = corpus_norms([dict(s, text=(s.get("text_original") or s.get("text") or ""))
                                   for s in (job.get("segments") or []) if isinstance(s, dict)])
        except Exception:  # noqa: BLE001
            _norms = None
        # The clip is the LOUDEST window inside the line, capped at OWN_SPAN_REF_MAX_S,
        # so it may hold only part of the line. Pair it with only that part of the
        # transcript - the whole line's text over an 8s window of a 16s line is a 2.0x
        # overrun by construction, and the engine speaks the surplus into the dub.
        _span_n = float(e0 - s0)
        if _span_n > 0 and clip.size < _span_n - int(0.05 * sr):
            _lo_f = off / _span_n
            _hi_f = (off + clip.size) / _span_n
            _sliced = _text_window(text, _lo_f, _hi_f)
            if _sliced:
                logger.info("segment refs: %s keeps %.2fs of its %.2fs span, so its "
                            "reference transcript is cut to match (%d -> %d char)",
                            sid, clip.size / float(sr), _span_n / float(sr),
                            len(text), len(_sliced))
                text = _sliced
        _bad = segref_defect(text, clip.size / float(sr), _norms, clip=clip, sr=sr)
        if _bad:
            logger.info("segment refs: %s cannot be its own reference (%s)", sid, _bad)
            return False
        os.makedirs(job_dir, exist_ok=True)
        path = os.path.join(job_dir, "seg_ref_%s_own.wav"
                            % re.sub(r"[^A-Za-z0-9_.-]", "_", str(sid)))
        sf.write(path, clip, sr)
        lo = a + off / float(sr)
        sc[str(sid)] = {"ref_audio": path, "ref_text": text,
                        "duration": round(clip.size / float(sr), 3),
                        "win_start": round(lo, 3),
                        "win_end": round(lo + clip.size / float(sr), 3),
                        "from_own_span": True}
        return True
    except Exception as e:  # noqa: BLE001
        logger.info("segment refs: own-span reference failed for %s: %s", sid, e)
        return False


# ------------------------------------------- what disqualifies a per-LINE reference
# A pooled per-speaker reference has to represent the character across the whole film, so
# rejecting a shout, a laugh or a repeated exclamation is right there. The reference that
# belongs to the line where the character shouts is a different question: the shout is what
# that line sounds like, and replacing it with the character's calmest clip is how a dub
# ends up with the same delivery on every line.
#
# So only the defects that mean the TRANSCRIPT DOES NOT DESCRIBE THE AUDIO are fatal here.
# Those break cloning outright, because the engine is handed ref_audio and ref_text together
# and assumes they are the same sound.
#: A clip with less voiced audio than this, whose transcript is also thin, is a
#: badly cut slot rather than a shout - and cloning from it hands the engine
#: silence labelled with a word.
SEGREF_MIN_VOICED = float(os.environ.get("OMNIVOICE_SEGREF_MIN_VOICED", "0.45"))
#: A thin transcript is only believable as a held shout while the clip stays SMALL. Nobody
#: sustains one sound for thirteen seconds, so more voiced audio than this - or too many
#: separate runs - means dialogue nobody transcribed, whatever the loudness says.
SEGREF_THIN_MAX_VOICED_S = float(os.environ.get("OMNIVOICE_SEGREF_THIN_MAX_VOICED_S", "6.0"))
SEGREF_THIN_MAX_RUNS = int(os.environ.get("OMNIVOICE_SEGREF_THIN_MAX_RUNS", "3"))
SEGREF_FATAL_DEFECTS = (
    "wrong-script",                  # Kannada text over Hindi audio
    "mixed-script",                  # the ASR changed language part-way through
    "translated-not-transcribed",    # English grammar over non-English audio
    "transcript-overruns-audio",     # more text than the clip can contain
)
#: Set to 0 to go back to rejecting emotional lines the way the pooled path does.
SEGREF_KEEP_EXPRESSIVE = os.environ.get(
    "OMNIVOICE_SEGREF_KEEP_EXPRESSIVE", "1") not in ("0", "false", "False")


def voiced_fraction(clip, sr) -> float:
    """Share of a clip that is speech rather than silence, on 20 ms frames.

    The one thing that separates a shout from a badly cut slot: both look like "too little
    text for this much audio", and only the audio can say which it is.
    """
    try:
        frame = max(1, int(0.02 * sr))
        usable = (clip.size // frame) * frame
        if usable < frame * 2:
            return 0.0
        rms = np.sqrt((clip[:usable].reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
        db = 20 * np.log10(rms)
        gate = min(float(np.quantile(db, 0.95)) - 25.0, -45.0)
        return float((db > gate).mean())
    except Exception:  # noqa: BLE001
        return 0.0


def voiced_runs(clip, sr, gap_s: float = 0.15):
    """(number of voiced runs, voiced seconds) for a clip.

    A held shout is one long run. Ten seconds of dialogue is many runs with pauses between
    them. That difference is what tells a line worth cloning for its delivery apart from a
    badly cut slot full of speech nobody transcribed.
    """
    try:
        frame = max(1, int(0.02 * sr))
        usable = (clip.size // frame) * frame
        if usable < frame * 2:
            return 0, 0.0
        rms = np.sqrt((clip[:usable].reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
        db = 20 * np.log10(rms)
        gate = min(float(np.quantile(db, 0.95)) - 25.0, -45.0)
        v = db > gate
        need = max(1, int(gap_s / 0.02))
        runs, i, n = 0, 0, len(v)
        while i < n:
            if v[i]:
                j = i
                while j < n and v[j]:
                    j += 1
                runs += 1
                # a gap shorter than `need` does not end the run
                k = j
                while k < n and not v[k] and (k - j) < need:
                    k += 1
                i = k if (k < n and v[k]) else j
                if k < n and v[k]:
                    runs -= 1        # the gap was too short to split it
                    continue
            else:
                i += 1
        return runs, float(v.sum()) * 0.02
    except Exception:  # noqa: BLE001
        return 0, 0.0


def segref_defect(text, duration, norms, clip=None, sr=None):
    """Why this line cannot be its own clone reference, or None.

    Differs from ref_quality.slice_text_defect in one way only: a content-quality
    judgement is not a reason to reject the reference belonging to the line it describes.
    A repeated exclamation is what an angry line looks like. Replacing it with the
    character's calmest clip is how every line ends up delivered the same way.

    Mismatches between transcript and audio are still fatal - the engine is handed
    ref_audio and ref_text together and assumes they are the same sound. And where the text
    alone cannot tell a shout from a silent slot, the audio decides.
    """
    from services import ref_quality as RQ
    try:
        found = RQ.defects(duration, text, norms) or []
    except Exception:  # noqa: BLE001
        one = RQ.slice_text_defect(text, duration, norms)
        found = [one] if one else []
    if not found:
        return None
    if not SEGREF_KEEP_EXPRESSIVE:
        return found[0]

    # Any mismatch at all disqualifies it, even when a content defect was reported first.
    for bad in found:
        if str(bad).split(":")[0] in SEGREF_FATAL_DEFECTS:
            return bad
    # ref_quality reports one text defect at a time and the repetition check runs before
    # the density check, so a repetitive line that ALSO overruns its audio only ever
    # mentions the repetition. Ask whether it overruns its audio regardless.
    try:
        from services.ref_quality import DENSITY_HI
        _cps = (norms or {}).get("cps")
        _d = float(duration or 0.0)
        if _cps and _d >= 1.0:
            _ratio = (len((text or "").strip()) / _d) / _cps
            if _ratio > DENSITY_HI:
                return "transcript-overruns-audio:%.2fx" % _ratio
    except Exception:  # noqa: BLE001
        pass

    thin = [b for b in found
            if str(b).split(":")[0] in ("no-lexical-content", "text-too-short")]
    if thin:
        if clip is None or not sr:
            # Cannot check the audio, so cannot tell a shout from silence. Refuse: a
            # reference of near-silence labelled with a word is worse than the pooled clone.
            return thin[0]
        vf = voiced_fraction(clip, sr)
        if vf < SEGREF_MIN_VOICED:
            logger.info("segment refs: %s over %.1fs is only %.0f%% speech - that is a "
                        "badly cut slot, not a shout; leaving it on the pooled clone",
                        thin[0], float(duration or 0.0), 100.0 * vf)
            return thin[0]
        runs, vsec = voiced_runs(clip, sr)
        if vsec > SEGREF_THIN_MAX_VOICED_S or runs > SEGREF_THIN_MAX_RUNS:
            # Loud, but structured like dialogue rather than a single held sound. The text
            # does not describe it, so cloning from it would hand the engine %.0fs of
            # speech labelled with a handful of characters.
            logger.info("segment refs: %s has %.1fs of speech in %d run(s) but only %d "
                        "character(s) of text - that is dialogue nobody transcribed, not a "
                        "shout; leaving it on the pooled clone",
                        thin[0], vsec, runs, len((text or "").strip()))
            return thin[0]
        logger.debug("segment refs: keeping a line a pooled reference would reject (%s) - "
                     "the clip is %.0f%% speech, so it is delivery, not silence",
                     thin[0], 100.0 * vf)
        return None
    logger.debug("segment refs: keeping an expressive line a pooled reference would "
                 "reject (%s)", found[0])
    return None


# ------------------------------------------------- who speaks in their own voice
def clone_audit(segments, clones) -> dict:
    """Which speakers got a reference of their own, and which did not.

    A speaker with no reference is voiced by the engine's stock voice - a stranger reading
    that character's lines. On one real job that happened to a minor character and the only
    sign was the word "Default" in the cast row, which reads like a setting rather than a
    failure. This exists so it is stated instead.
    """
    dur, cnt = {}, {}
    for s in segments or []:
        spk = (s or {}).get("speaker_id")
        if not spk:
            continue
        try:
            d = float((s or {}).get("end") or 0.0) - float((s or {}).get("start") or 0.0)
        except (TypeError, ValueError):
            d = 0.0
        dur[spk] = dur.get(spk, 0.0) + max(0.0, d)
        cnt[spk] = cnt.get(spk, 0) + 1
    have = set()
    for k, v in (clones or {}).items():
        p = (v or {}).get("ref_audio")
        if p and os.path.exists(p):
            have.add(k)
    missing = sorted(k for k in dur if k not in have)
    return {"speakers": sorted(dur), "cloned": sorted(have & set(dur)), "missing": missing,
            "seconds": {k: round(v, 1) for k, v in dur.items()},
            "lines": dict(cnt)}


def clone_audit_message(a) -> str:
    """One line, always logged, so the count is visible even when nothing is wrong."""
    a = a or {}
    total = len(a.get("speakers") or [])
    ok = len(a.get("cloned") or [])
    base = "speaker voices: %d of %d speaker(s) cloned from the video" % (ok, total)
    miss = a.get("missing") or []
    if not miss:
        return base
    detail = ", ".join("%s (%d line(s), %.1fs)"
                       % (m, (a.get("lines") or {}).get(m, 0),
                          (a.get("seconds") or {}).get(m, 0.0)) for m in miss)
    return (base + ". %s will be voiced by the STOCK VOICE, not their own: %s. "
            "There was not enough of their audio to clone from, even as a last resort."
            % ("This speaker" if len(miss) == 1 else "These speakers", detail))


def ensure_speaker_clones(job, job_dir, *, vocals_path=None):
    """Give a voice to any speaker about to be rendered who has none.

    Jobs transcribed before the last-resort path existed carry speakers with no reference at
    all - one real job missed the floor by two tenths of a second - and nothing would fix that
    short of re-transcribing the whole video. So it is repaired at the point of use, like the
    per-line references.

    Only the missing speakers are rebuilt. Rebuilding every speaker would waste the time and,
    worse, could change a voice the user has already heard and accepted halfway through a
    project.

    Never raises: a failure here must leave the render exactly as it would have been.
    """
    out = {"missing_before": [], "built": [], "still_missing": [], "reason": ""}
    try:
        segments = job.get("segments") or []
        clones = dict(job.get("speaker_clones") or {})
        audit = clone_audit(segments, clones)
        out["missing_before"] = list(audit.get("missing") or [])
        if not out["missing_before"]:
            out["reason"] = "every speaker already has a voice"
            return out
        vocals = vocals_path or job.get("vocals_path") or job.get("audio_path")
        if not vocals or not os.path.exists(vocals):
            out["reason"] = "no vocals on disk to clone from"
            out["still_missing"] = out["missing_before"]
            return out
        want = set(out["missing_before"])
        subset = [s for s in segments if (s or {}).get("speaker_id") in want]
        if not subset:
            out["reason"] = "the missing speakers have no segments"
            out["still_missing"] = out["missing_before"]
            return out
        fresh = extract_speaker_clones(
            vocals, subset, job_dir or os.path.dirname(vocals),
            labels_source=job.get("labels_source") or "diarization")
        added = {}
        for k, v in (fresh or {}).items():
            # Never overwrite a voice that already exists and works.
            if k in want and (v or {}).get("ref_audio"):
                added[k] = v
        if added:
            clones.update(added)
            job["speaker_clones"] = clones
        out["built"] = sorted(added)
        out["still_missing"] = sorted(want - set(added))
        out["reason"] = "built %d, still without a voice %d" % (len(added), len(out["still_missing"]))
    except Exception as e:  # noqa: BLE001
        out["reason"] = "%s: %s" % (type(e).__name__, e)
    return out
