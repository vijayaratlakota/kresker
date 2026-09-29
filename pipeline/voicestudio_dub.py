"""
VoiceStudio (OmniVoice) dubbing engine — a second dubbing backend.

Why this exists
---------------
VoiceStudio does real zero-shot voice cloning, which Google's gated Chirp voice
cloning would not give us, and its clone quality is the best we have. What it is
weaker at is TRANSLATION: its bundled engines are Argos / NLLB / Google Translate,
none of which handle Hindi->Telugu context well, and none of which know anything
about how long a line is allowed to be.

So this module splits the work by strength:

  VoiceStudio : prep (Demucs), ASR, diarization, voice cloning, mux
  Gemini      : translation, with a per-line CHARACTER BUDGET derived from the
                slot duration, plus a per-line delivery/emotion instruction

That combination fixes both reported problems: bad translation (Gemini instead of
Argos/Google) and gaps (budgeted lines actually fill their slot, plus the fit
controls below).

Gap handling
------------
Gaps came from lines finishing early and from the fitter refusing to overflow.
We therefore pass VoiceStudio:
  timing_strategy = smart_fit     (rather than the default `concise`)
  overflow_budget_s > 0           (a small overrun beats a silent hole)
  fit_options.gap_guard_s         (explicit guard against leaving gaps)
  fit_options.allow_video_retime  (let it nudge video slightly, like VMEG does)

Flow: upload -> wait for prep -> transcribe(+diarize) -> Gemini translate
      -> generate(clone + fit) -> download.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request

# Where the VoiceStudio backend lives (the GPU box).
BASE = os.environ.get("VOICESTUDIO_URL", "http://127.0.0.1:3900").rstrip("/")

# Timing / gap controls. Defaults chosen to prefer a small overrun over silence.
# Timing policy: every line stays locked to its ORIGINAL timestamp.
#
# The previous settings caused exactly the drift the user reported ("the video is
# going fast and the audio is slow", the dub running 21.8 s against a 20.27 s
# video). Two of them were to blame:
#
#   smart_fit + overflow_budget_s=0.35  let each line overrun its slot, and with
#       several lines the overruns accumulate, so every later line lands later
#       than the mouth that speaks it.
#   allow_video_retime=1 + video_slow_cap=1.10  gave permission to SLOW THE VIDEO
#       DOWN by up to 10% to accommodate long audio, which is why the exported
#       video no longer matched the original timing.
#
# strict_slot pins each line to its own slot with no overflow and no video
# retiming: a line that is slightly long is compressed within the rate cap, and a
# short one simply leaves its natural pause. Drift cannot accumulate.
TIMING_STRATEGY = os.environ.get("VS_TIMING_STRATEGY", "strict_slot")
SLOT_FIT = os.environ.get("VS_SLOT_FIT", "time_stretch")
OVERFLOW_BUDGET_S = float(os.environ.get("VS_OVERFLOW_BUDGET_S", "0.0"))
GAP_GUARD_S = float(os.environ.get("VS_GAP_GUARD_S", "0.12"))
AUDIO_RATE_CAP = float(os.environ.get("VS_AUDIO_RATE_CAP", "1.25"))
VIDEO_SLOW_CAP = float(os.environ.get("VS_VIDEO_SLOW_CAP", "1.0"))
ALLOW_VIDEO_RETIME = os.environ.get("VS_ALLOW_VIDEO_RETIME", "0") == "1"
# One shared reference per speaker for the whole dub, rather than cloning each
# line from its own source clip.
#
# VoiceStudio's own descriptions of the two modes:
#   per_line   "Each line clones from a clip of its own source audio. Best
#               per-line prosody match, but the voice identity can drift from
#               line to line."
#   consistent "Every line of a speaker clones from one shared reference.
#               Steadier voice identity across the whole dub."
#
# `consistent` is the right choice here for a specific reason: once the transcript
# has been rebuilt, our line boundaries no longer match the segments VoiceStudio
# cut its per-segment reference clips from, so per_line's lookup misses and falls
# back to the per-speaker clone anyway — just less predictably. Asking for
# `consistent` makes that the deliberate behaviour and keeps each character
# sounding like one person.
#
# It also removes an audible artifact, which is the stronger reason. A per-line
# reference is cut from THAT line's own separated vocals, so wherever the speech
# sits over music the clip carries Demucs separation residue, and the cloner
# reproduces that residue as a breathy hiss at the start of the line. Measured on
# a real job (5 lines x 3 renders per mode, same text, same speaker):
#
#     per_line    5 of 15 renders had a hissy onset (33%)
#     consistent  1 of 15 (7%)
#
# with the worst line going from 34.45 / 10.99 / 1.73 down to 0.57 / 0.29 / 0.95
# on an onset-to-body high-frequency energy ratio. The references themselves show
# why: the shared speaker clip measured 0.015 hissiness against 0.024 and 0.043 for
# per-line clips cut from the same video. That 33% matches the 33% of line starts
# measured in the delivered dub of that job, which was rendered with per_line.
#
# It also explains why the artifact fades as a video goes on: this job's background
# runs at -28.0 dB through the intro and -40.8 dB by two minutes in, so the early
# per-line references are the contaminated ones.
VOICE_MATCH = os.environ.get("VS_VOICE_MATCH", "consistent")

# Synthesis speed. This is the fix for the whole class of timing problems, and it
# is an engine parameter we had never touched — every job went out at 1.0.
#
# Pitch does not rise with speed, so this is genuinely faster SYNTHESIS, not
# resampling. That matters: resampling raises pitch (chipmunk) and
# post-hoc time-stretching smears transients (robotic). Native speed does neither.
#
# An earlier note here claimed the engine ran at 6.76 chars/s at speed 1.0 and
# built the whole speed-up argument on it. That number was read off the duration
# planner's est_dur_s, not off audio, and it was wrong by roughly 2.5x. Rendering
# real lines and timing the audio with end silence trimmed (research_base_rate.py)
# gave, at speed 1.0:
#     71 chars ->  4.22s = 16.8 chars/s
#    133 chars ->  7.76s = 17.1 chars/s
#    231 chars -> 12.82s = 18.0 chars/s
# For reference an ElevenLabs dub of comparable material measured 14.03 chars/s
# with every utterance at <= 0.99x of its original block. So this engine at speed
# 1.0 is already FASTER than the reference, and the deficit the speed-up existed to
# close was never real. Acting on 6.76 made compute_speed ask for 2.12, driving the
# voice to about 35 chars/s -- which is what the first lines of a video sounded
# like when they were reported as robotic with glitch sounds.
#
# measure_engine_rate() now supplies this number from rendered audio per job, so
# the speed decision follows the voice actually in use.
#
# The cap is 2.0: sweeping 1.0-2.0 with three repeats per point on two jobs
# (research_speed_knee.py) found every harmonicity change smaller than the
# run-to-run spread of 0.046, so nothing up to 2.0 is measurably degraded. It is
# only a guard against a bad measurement -- compute_speed targets the language's
# natural rate, so a correctly measured voice never asks for much above 1.0.
SPEED_MIN = float(os.environ.get("VS_SPEED_MIN", "1.0"))
SPEED_MAX = float(os.environ.get("VS_SPEED_MAX", "2.0"))
SPEED_FIXED = os.environ.get("VS_SPEED")          # set to override auto-fitting


def target_rate_for(target_lang):
    """The natural speaking rate we want the dub to achieve, in chars/second."""
    from gemini_audio import CHARS_PER_SEC
    return CHARS_PER_SEC.get((target_lang or "").lower(), 11.0)


# Hard ceiling on how much the fitter may compress a line. Above roughly 1.15x
# speech starts to sound rushed; the delivered dub was measured at an EFFECTIVE
# 17-25 chars/second against a natural 14, because nothing capped this.
MAX_COMPRESSION = float(os.environ.get("VS_MAX_COMPRESSION", "1.15"))


# Rate assumed only when a job's own voice could not be measured. Set from three
# rendered probes of different lengths on a real cloned voice (16.8 / 17.1 / 18.0
# chars/s at speed 1.0); the low end is used so a fallback errs towards allowing
# more time rather than crushing a line.
FALLBACK_CPS = float(os.environ.get("VS_FALLBACK_CPS", "16.0"))


def cps_at_speed(base_cps, speed):
    """Characters per second this engine produces at a given speed setting.

    Linear in `speed`, verified by measurement on a real cloned voice (82 chars):
        speed 1.00 -> 5.16s = 15.9 chars/s   (1.00x)
        speed 1.10 -> 4.72s = 17.4 chars/s   (1.09x)
        speed 1.20 -> 4.32s = 19.0 chars/s   (1.19x)
        speed 1.50 -> 3.48s = 23.6 chars/s   (1.48x)
        speed 2.00 -> 2.68s = 30.6 chars/s   (1.93x)
    """
    return max(0.5, float(base_cps or FALLBACK_CPS)) \
        * max(0.1, float(speed or 1.0))


def natural_seconds(text, base_cps, speed):
    """How long this line takes to SPEAK before any fitting.

    Needed because duration cannot be verified from the rendered clip under
    strict_slot: that pins every clip to its slot, so every measurement reads
    "fits" whether the speech was natural or crushed.
    """
    return len((text or "").strip()) / cps_at_speed(base_cps, speed)


def _trimmed_speech_seconds(raw_bytes):
    """Seconds of audio in a rendered clip, with end silence removed.

    End padding has to come off or the rate is understated. Measured padding on
    real previews was 0.22-0.58s, which on a 4-second clip is a 5-13% error in the
    wrong direction.
    """
    import io

    import numpy as np
    import soundfile as sf

    x, sr = sf.read(io.BytesIO(raw_bytes))
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    n = max(1, int(sr * 0.02))
    frames = [float(np.max(np.abs(x[i:i + n])))
              for i in range(0, len(x) - n + 1, n)]
    if not frames:
        return 0.0
    # Threshold from this clip's own level, so a quiet voice is not read as silence.
    thr = max(float(np.percentile(frames, 95)) * 0.02, 1e-4)
    on = [i for i, v in enumerate(frames) if v >= thr]
    if not on:
        return len(x) / float(sr)
    return ((on[-1] + 1) - on[0]) * n / float(sr)


def measure_engine_rate(job_id, segments, target_lang, emit=None, probes=3):
    """Render a few of this job's own lines and time them. Returns chars/second.

    Replaces reading the rate off the planner's `est_dur_s`, which was wrong by a
    factor of 2.5 and sent every other decision the wrong way. The planner said
    this voice ran at 6.6-6.8 chars/second; rendering 71, 133 and 231 characters
    of real text and timing the audio gave 16.0, 16.6 and 17.2 -- already faster
    than the 14.03 measured on the ElevenLabs reference.

    Believing 6.6 made compute_speed ask for speed 2.12 to "reach" 14, which
    actually drove the voice to roughly 35 chars/second: the rushed, glitchy
    delivery reported on the first lines of a video.

    Probes use the job's own translated lines and profiles, so this measures the
    real voice speaking the real target language rather than a fixed test phrase.
    """
    import json as _json
    import urllib.request

    cands = []
    for s in segments:
        t = (s.get("text") or "").strip()
        if len(t) >= 40 and s.get("profile_id"):
            cands.append((abs(len(t) - 120), t, s.get("profile_id")))
    if not cands:
        cands = [(abs(len((s.get("text") or "")) - 120),
                  (s.get("text") or "").strip(), s.get("profile_id"))
                 for s in segments if len((s.get("text") or "").strip()) >= 20]
    if not cands:
        return None, "no line long enough to measure the voice rate"
    cands.sort()

    # Spread the probes over different speakers where there are several, so one
    # unusual voice cannot set the rate for the whole job.
    picked, seen = [], set()
    for _, t, prof in cands:
        if prof in seen and len(seen) > 1:
            continue
        picked.append((t, prof))
        seen.add(prof)
        if len(picked) >= probes:
            break
    for _, t, prof in cands:
        if len(picked) >= probes:
            break
        if (t, prof) not in picked:
            picked.append((t, prof))

    rates, detail = [], []
    for text, prof in picked:
        body = {"text": text, "language": target_lang, "speed": 1.0}
        if prof:
            body["profile_id"] = prof
        try:
            req = urllib.request.Request(
                BASE + f"/dub/preview-segment/{job_id}",
                data=_json.dumps(body).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=600) as r:
                raw = r.read()
            secs = _trimmed_speech_seconds(raw)
        except Exception as e:
            detail.append(f"probe failed: {str(e)[:50]}")
            continue
        if secs > 0.3:
            rates.append(len(text) / secs)
            detail.append(f"{len(text)} chars in {secs:.2f}s = "
                          f"{len(text)/secs:.2f} chars/s")
    if not rates:
        return None, "; ".join(detail) or "voice rate could not be measured"
    rates.sort()
    cps = rates[len(rates) // 2]          # median resists one odd render
    return cps, (f"measured this voice at {cps:.2f} chars/s at speed 1.0 "
                 f"({len(rates)} probe(s): " + "; ".join(detail) + ")")


def measure_voice_rate_early(job_id, segments, source_lang, target_lang,
                             emit=None, probes=3):
    """Time the cloned voice BEFORE the script is written.

    The character budget decides how much each line gets to say, and it was being
    seeded from the speaker's own pace in the SOURCE language. That is the wrong
    quantity. What matters is how fast the CLONED voice says the TARGET language, and
    on this engine the two differ by a lot: one job measured the Hindi speaker at 13.5
    chars/s, which set a Telugu budget of 12.3, while the cloned voice actually
    delivered 19.5. Every line was then written at about two thirds of what its slot
    could hold, and the dub covered 0.59x of the original's speech.

    Correcting it after the first render never fully recovers: lengthening an
    already-written line is limited, and 34 of 97 attempts came back no longer.
    Measuring first costs three short renders and removes the problem instead.

    Translates a few of the job's own lines, renders them through the same voice, and
    times the audio. Returns (chars_per_second, note) or (None, why not).
    """
    from gemini_audio import translate_at_budget

    cands = []
    for i, s in enumerate(segments):
        src = (s.get("text") or "").strip()
        if len(src) >= 40 and s.get("profile_id"):
            cands.append((abs(len(src) - 110), i, src, s["profile_id"]))
    if not cands:
        return None, "no line long enough to measure the voice on"
    cands.sort()

    picked, seen = [], set()
    for _, i, src, prof in cands:
        if prof in seen and len(seen) > 1:
            continue
        picked.append((i, src, prof))
        seen.add(prof)
        if len(picked) >= probes:
            break
    for _, i, src, prof in cands:
        if len(picked) >= probes:
            break
        if not any(p[0] == i for p in picked):
            picked.append((i, src, prof))

    # Deliberately generous budgets: this pass is measuring the voice, so the
    # translation must not be squeezed to fit anything.
    items = [{"i": i, "seconds": 30.0, "budget": max(60, len(src) * 2),
              "src": src} for i, src, prof in picked]
    try:
        dst = translate_at_budget(items, source_lang, target_lang, emit=emit)
    except Exception as e:
        return None, f"probe translation failed ({str(e)[:60]})"
    probe_segs = [{"text": dst.get(i, ""), "profile_id": prof}
                  for i, src, prof in picked if dst.get(i)]
    if not probe_segs:
        return None, "probe translation returned nothing"
    cps, note = measure_engine_rate(job_id, probe_segs, target_lang, emit=emit,
                                    probes=len(probe_segs))
    return cps, note


def measure_rate_from_render(job_id, segments, target_lang, emit=None):
    """Characters per second, read off every line this job has already rendered.

    Three probe renders are far too few. Within one run they gave 15.88, 23.85 and
    24.80 chars/s, and the two medians taken at different points in the same run were
    34% apart. That one number decides everything downstream, in both directions: too
    low and lines are written short, leaving the surplus time that makes the engine
    recite its reference audio in the original language; too high and the slot trim
    cuts words off the end of real lines.

    VoiceStudio already records, per rendered segment, both the character count and the
    natural duration:

        seg_natural_durs_by_lang["te"]["s00001-1"] = {"chars": 47, "dur": 3.84}

    Totalling those is the same voice speaking the same language across the whole job,
    it needs no alignment with our own segment list, and it costs nothing. Totals
    rather than per-line averages, so one odd short clip cannot dominate.

    Returns (chars_per_second, note) or (None, why not).
    """
    row = _history_row(job_id) or {}
    try:
        jd = json.loads(row.get("job_data") or "{}")
    except Exception:
        jd = {}
    by_lang = jd.get("seg_natural_durs_by_lang") or {}
    entry = by_lang.get(target_lang) or by_lang.get("und") or {}
    if not isinstance(entry, dict) or not entry:
        return None, "the job has no recorded per-line durations yet"

    chars = 0
    secs = 0.0
    used = 0
    for v in entry.values():
        if not isinstance(v, dict):
            continue
        try:
            c, d = int(v.get("chars") or 0), float(v.get("dur") or 0.0)
        except (TypeError, ValueError):
            continue
        # Short clips time badly, and a handful of characters says nothing about rate.
        if d < 0.5 or c < 12:
            continue
        chars += c
        secs += d
        used += 1
    if used < 8 or secs < 20.0:
        return None, (f"only {used} rendered line(s) were long enough to measure "
                      f"({secs:.1f}s)")
    cps = chars / secs
    return cps, (f"measured {cps:.2f} chars/s across {used} rendered line(s) "
                 f"({chars} chars in {secs:.1f}s, from the engine's own records)")


def compute_speed(measured_cps, target_lang):
    """Engine speed that makes the voice speak at the language's natural rate.

    Generic by construction: it compares what the engine ACTUALLY produced for
    this voice against the target language's normal rate, so it adapts to every
    video, voice and language pair instead of being tuned per clip.
    """
    want = target_rate_for(target_lang)
    if not measured_cps or measured_cps <= 0:
        return 1.0, f"no measured rate; leaving speed at 1.0 (target {want})"
    raw = want / measured_cps
    speed = max(SPEED_MIN, min(SPEED_MAX, raw))
    note = (f"voice measured {measured_cps:.2f} chars/s, target {want:.1f} for "
            f"{target_lang} -> speed {speed:.2f}"
            + (f" (clamped from {raw:.2f})" if abs(raw - speed) > 0.01 else ""))
    return round(speed, 2), note
NUM_STEP = int(os.environ.get("VS_NUM_STEP", "16"))


def _req(path, data=None, method="GET", timeout=3600, headers=None):
    body = None
    hdr = dict(headers or {})
    if data is not None:
        body = json.dumps(data).encode()
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=body, headers=hdr,
                                 method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def health():
    return _req("/health", timeout=60)


def upload(video_path, timeout=3600, job_id=None):
    """Multipart upload of the source video. Returns (job_id, task_id).

    A unique job_id is requested every time. Without it, re-uploading the same
    file reuses the previous job, and transcribe then answers HTTP 409 — which is
    worse than it sounds, because container recreation deletes the job's working
    files while the database row survives, leaving a job that can neither be
    transcribed nor read.
    """
    import uuid
    job_id = job_id or uuid.uuid4().hex[:8]
    boundary = "----voicestudioboundary"
    with open(video_path, "rb") as f:
        payload = f.read()
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"video\"; "
            f"filename=\"{os.path.basename(video_path)}\"\r\n"
            f"Content-Type: video/mp4\r\n\r\n").encode()
    jid = (f"\r\n--{boundary}\r\nContent-Disposition: form-data; "
           f"name=\"job_id\"\r\n\r\n{job_id}").encode()
    body = head + payload + jid + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        BASE + "/dub/upload", data=body, method="POST",
        headers={"Content-Type":
                 f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    return out.get("job_id"), out.get("task_id")


def _history_row(job_id):
    hist = _req("/dub/history", timeout=120)
    rows = hist if isinstance(hist, list) else hist.get("items", [])
    return next((x for x in rows if x.get("id") == job_id), None)


def wait_prep(job_id, timeout=1800, emit=None):
    """Block until prep (extract + Demucs separation) has produced its paths.

    Necessary because /dub/upload returns immediately with a prep task; calling
    transcribe too early gets "Job not found".
    """
    t0 = time.time()
    while time.time() - t0 < timeout:
        row = _history_row(job_id)
        if row:
            try:
                jd = json.loads(row.get("job_data") or "{}")
            except Exception:
                jd = {}
            if jd.get("vocals_path") or jd.get("audio_path"):
                return jd
        if emit:
            emit("separate", 20,
                 f"VoiceStudio preparing media ({int(time.time()-t0)}s)",
                 device="Cloud")
        time.sleep(5)
    raise RuntimeError("VoiceStudio prep timed out")


def diarization_ready():
    """Is real speaker diarization available?

    VoiceStudio needs a HuggingFace token (plus acceptance of the gated
    pyannote/speaker-diarization licence) to separate speakers. Without it, it
    warns "auto voice cloning skipped: speaker labels are gap-based estimates"
    and falls back to a silence-gap heuristic that merges every character into
    one speaker — which is why a multi-character video came out in a single
    voice with no cloning.
    """
    try:
        st = _req("/api/settings/hf-token/state", timeout=60)
        for s in st.get("sources", []):
            if s.get("whoami_ok"):
                return {"ready": True, "source": s.get("source"),
                        "user": s.get("whoami_user")}
        any_set = any(s.get("set") for s in st.get("sources", []))
        return {"ready": False, "token_present": any_set}
    except Exception as e:
        return {"ready": False, "error": str(e)}


def existing_segments(job_id):
    """Segments already stored for this job (populated after transcription).

    Needed because re-uploading the same video reuses the job, and re-running
    transcribe then returns HTTP 409 instead of the transcript.
    """
    row = _history_row(job_id) or {}
    try:
        return json.loads(row.get("job_data") or "{}").get("segments") or []
    except Exception:
        return []


def transcribe_stream(job_id, num_speakers=None, timeout=3600, emit=None):
    """ASR + diarization via the SSE endpoint the VoiceStudio UI itself uses.

    THIS IS WHAT MAKES CLONING WORK, and the difference is not obvious.

    POST /dub/transcribe returns segments and looks fine, but the auto
    speaker-clone step lives inside the SSE generator behind
    /dub/transcribe-stream. Using the plain POST therefore produced jobs with
    `speaker_clones: []` and `profile_id: None` on every segment, so
    /dub/generate found no reference audio and synthesized in the engine's
    DEFAULT voice — the original speakers' voices were never cloned at all.

    Measured on the same video:
        POST   /dub/transcribe        -> 3 merged segments, speaker_clones []
        GET    /dub/transcribe-stream -> 8 segments, speaker_clones
                                        ['Speaker 3','Speaker 2'],
                                        profile_id auto:speaker_3 / auto:speaker_2

    The stream also segments far better (8 lines instead of one 13.22 s block),
    which removes most of the timing damage at the source.
    """
    q = f"?num_speakers={int(num_speakers)}" if num_speakers else ""
    if emit:
        emit("transcribe", 35,
             "VoiceStudio transcribing + diarizing (with voice cloning)",
             device="Cloud")
    segs, warnings = None, []
    # Per-READ timeout, not a total one.
    #
    # This stream reports progress every few seconds (it runs the ASR once per
    # segment reference), so a long silence means it has stopped, not that it is
    # busy. Twice now it went quiet with the socket still open and the run sat there
    # for half an hour: once with a second job competing for the single pinned GPU
    # thread, and once when the job's working directory was deleted underneath it
    # mid-transcription. A total timeout of an hour cannot tell those apart from
    # progress; a read timeout can.
    # 900s rather than something tighter: the clone-building tail of this stream is
    # silent for minutes at a time, and cutting it off there cost more than the stall
    # it was meant to catch. A stall now KEEPS whatever segments arrived (see below)
    # instead of discarding them for the coarser POST endpoint.
    stall = float(os.environ.get("VS_STREAM_STALL_S", "900"))
    with urllib.request.urlopen(f"{BASE}/dub/transcribe-stream/{job_id}{q}",
                                timeout=min(stall, timeout)) as r:
      try:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except Exception:
                continue
            if not isinstance(ev, dict):
                continue
            # "segments" arrives progressively and again as "final"; keep the
            # richest version seen.
            if ev.get("segments") and (segs is None
                                       or len(ev["segments"]) >= len(segs)):
                segs = ev["segments"]
            if ev.get("detail"):
                warnings.append(str(ev["detail"]))
      except TimeoutError:
        # Keep what arrived. The alternative is the POST endpoint, and that is a
        # materially worse transcript: it returns coarse blocks where the stream
        # returns utterances. One run that fell back this way produced a single
        # Hindi sentence spread over four fragments with 8-15 second slots each -
        # 44 seconds of slot for 4 seconds of speech - and a 33 second stretch of
        # the finished dub had nothing to say.
        if not segs:
            raise
        warnings.append(
            f"the transcription stream stopped sending after {len(segs)} "
            f"segments; using what it had rather than the coarser fallback")
    for w in warnings[:3]:
        if emit:
            emit("transcribe", 36, f"VoiceStudio: {w[:120]}", device="Cloud")
    return segs or [], warnings


def gpu_recover(emit=None, wait=150):
    """Restart the VoiceStudio container after a CUDA fault, then wait for health.

    A CUDA "device-side assert" poisons the process's CUDA context: every later
    kernel launch on that process fails, so the TTS model cannot be restored and
    the ASR load fails too. Nothing short of restarting the process clears it, and
    the server does not do that itself — it just returns HTTP 500 for the rest of
    its life.

    Observed on this box after the earlier out-of-memory kills, so it is a
    recurring failure rather than a one-off.
    """
    import subprocess
    import time as _t

    key = os.path.expanduser(os.environ.get(
        "VS_SSH_KEY", os.path.join("~", ".ssh", "videotrans-key.pem")))
    host = os.environ.get("VS_SSH_HOST")
    if not host:
        m = re.search(r"//([^:/]+)", BASE)
        host = m.group(1) if m else None
    if not host or not os.path.exists(key):
        if emit:
            emit("transcribe", 34,
                 "GPU fault detected but no SSH access to restart the engine")
        return False

    ssh = (r"C:\Windows\System32\OpenSSH\ssh.exe"
           if os.name == "nt" else "ssh")
    cmd = [ssh, "-i", key, "-o", "StrictHostKeyChecking=no",
           "-o", "ConnectTimeout=20", f"ubuntu@{host}",
           'CT=$(docker ps --filter publish=3900 --format "{{.Names}}" | head -1);'
           ' docker restart "$CT" >/dev/null && echo RESTARTED']
    if emit:
        emit("transcribe", 34,
             "GPU fault (CUDA assert): restarting the voice engine", device="Cloud")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        if "RESTARTED" not in (r.stdout or ""):
            return False
    except Exception:
        return False

    for _ in range(wait // 5):
        _t.sleep(5)
        try:
            if health().get("status") == "ok":
                if emit:
                    emit("transcribe", 35, "Voice engine back up", device="Cloud")
                return True
        except Exception:
            pass
    return False


def _is_gpu_fault(err):
    s = str(err).lower()
    return ("device-side assert" in s or "cuda" in s
            or "500" in s and "internal server error" in s)


def transcribe(job_id, num_speakers=None, timeout=3600, emit=None,
               _retried=False):
    """ASR + diarization. Returns the segment list.

    Prefers the streaming endpoint, because only that path extracts the
    per-speaker voice clones (see transcribe_stream). The POST endpoint remains
    as a fallback so a stream failure degrades to a working, if uncloned, dub
    rather than no dub at all.
    """
    try:
        try:
            segs, warns = transcribe_stream(job_id, num_speakers=num_speakers,
                                            timeout=timeout, emit=emit)
        except TimeoutError:
            # The stream stopped sending. Say so plainly rather than falling through
            # to the POST endpoint, which would report an unrelated failure.
            raise RuntimeError(
                f"VoiceStudio stopped sending transcription progress for job "
                f"{job_id}. It is not busy - this stream reports every few seconds. "
                f"Check that the job still exists: deleting job working files, or "
                f"running a second job on the same GPU, stops it silently."
            ) from None
        # A CUDA fault surfaces as a warning in the stream, or as a 500 below.
        if not segs and not _retried and any(_is_gpu_fault(w) for w in warns):
            if gpu_recover(emit=emit):
                return transcribe(job_id, num_speakers=num_speakers,
                                  timeout=timeout, emit=emit, _retried=True)
        if segs:
            cloned = sum(1 for s in segs if s.get("profile_id"))
            if emit:
                emit("transcribe", 37,
                     f"{len(segs)} segments, {cloned} with a cloned voice profile",
                     device="Cloud")
            return segs
    except Exception as e:
        # A poisoned CUDA context returns 500 for every later request, so retrying
        # the same call is pointless; the engine has to be restarted first.
        if not _retried and _is_gpu_fault(e) and gpu_recover(emit=emit):
            return transcribe(job_id, num_speakers=num_speakers,
                              timeout=timeout, emit=emit, _retried=True)
        if emit:
            emit("transcribe", 36,
                 f"Transcribe stream failed ({str(e)[:60]}); falling back",
                 device="Cloud")

    q = f"?num_speakers={int(num_speakers)}" if num_speakers else ""
    try:
        out = _req(f"/dub/transcribe/{job_id}{q}", data=None, method="POST",
                   timeout=timeout)
        segs = out.get("segments") or []
    except urllib.error.HTTPError as e:
        if e.code != 409:
            raise
        # A 409 here is NOT necessarily "already transcribed". VoiceStudio also
        # returns 409 with error="asr_model_missing" when the selected ASR engine
        # has no model downloaded. Surfacing that message matters: it is
        # actionable, whereas silently treating it as a duplicate produced a
        # confusing "produced no segments" failure.
        body = {}
        try:
            body = json.loads(e.read().decode("utf-8", "replace")) or {}
        except Exception:
            pass
        detail = body.get("detail") if isinstance(body, dict) else None
        if isinstance(detail, dict) and detail.get("error") == "asr_model_missing":
            raise RuntimeError(
                "VoiceStudio has no speech-to-text model installed for the "
                f"selected engine. Missing: {detail.get('missing_repo_id')}. "
                "Install it in VoiceStudio → Settings → Models, or switch the "
                "ASR engine back to one whose model is present."
            ) from None
        if emit:
            emit("transcribe", 40, "Reusing existing transcript for this video",
                 device="Cloud")
        segs = existing_segments(job_id)
    if not segs:
        segs = existing_segments(job_id)
    if not segs:
        jd = wait_prep(job_id, timeout=300)
        segs = jd.get("segments") or []
    return segs


# How much longer than its source a translation may be asked to run.
#
# This is the guard that lets the budget be taken from the SLOT rather than from
# measured speech time inside it. Without a cap, a 10 second slot holding three words
# would ask for about 120 characters and the translator would invent dialogue to reach
# it. With it, the budget can fill the slot wherever the speaker actually spoke, and
# where he did not the source's own length holds the line honest.
#
# 1.35 from this pair: our Hindi transcript carries 13.6 characters per second of slot
# and the UI's Telugu dub of the same video carries 17.5, a ratio of 1.29.
SRC_EXPANSION_MAX = float(os.environ.get("VS_SRC_EXPANSION_MAX", "1.35"))


def _budget_chars(seconds, target_lang, target_cps=None):
    from gemini_audio import budget_for

    if target_cps and target_cps > 0:
        # headroom matches budget_for's 1.15 so the two paths agree
        return max(6, int(seconds * target_cps * 1.15))
    return budget_for(seconds, target_lang)


def measure_source_pace(segments, source_lang, target_lang):
    """Derive the target-language character rate from THIS speaker's own pace.

    Replaces the per-language constant, which is the root cause of the overruns.
    The constant assumes an average talker; a slow one then gets far too much text.
    Measured on a real job the same English output ran at 6.5 chars/sec for one
    speaker and 17.6 for another, against an assumed 14.0.

    The source audio already tells us how fast this person speaks. Comparing his
    measured rate to the typical rate for his language gives a dimensionless pace
    factor, which transfers across languages because the cloned voice imitates his
    delivery:

        pace   = measured_source_cps / typical_cps(source_lang)
        target = typical_cps(target_lang) * pace

    Worked example from the Tianmen video (Telugu -> English): the speaker managed
    22 source characters in 4.08 s = 5.4 cps against a typical Telugu 10.5, so
    pace 0.51, predicting 14.0 * 0.51 = 7.2 cps for English. The rate actually
    measured after rendering was 6.5-7.1 cps.

    Returns (target_cps, note). target_cps is None when there is too little to
    measure, in which case callers fall back to the language constant.
    """
    from gemini_audio import CHARS_PER_SEC

    chars = 0
    secs = 0.0
    for s in segments:
        text = (s.get("source_text") or s.get("text_original")
                or s.get("text") or "")
        text = text.strip(" .,·…\u0964")
        dur = float(s.get("end", 0)) - float(s.get("start", 0))
        # Skip degenerate rows; they would drag the average down artificially.
        if len(text) < 4 or dur < 0.4:
            continue
        chars += len(text)
        secs += dur
    if secs < 2.0 or chars < 20:
        return None, "not enough source speech to measure pace"

    src_cps = chars / secs
    typical_src = CHARS_PER_SEC.get((source_lang or "").lower())
    typical_dst = CHARS_PER_SEC.get((target_lang or "").lower(), 11.0)
    if not typical_src:
        return None, f"no reference rate for source language {source_lang!r}"

    pace = src_cps / typical_src
    # Clamp: a wild ratio usually means the transcript is bad, not that someone
    # speaks at a third or triple the normal rate.
    pace = max(0.35, min(1.8, pace))
    target_cps = typical_dst * pace
    note = (f"source pace {src_cps:.1f} chars/s over {secs:.1f}s "
            f"({chars} chars) vs typical {typical_src} for {source_lang} "
            f"-> pace {pace:.2f} -> budget at {target_cps:.1f} chars/s for "
            f"{target_lang} (language constant was {typical_dst})")
    return target_cps, note


def strip_asr_fragment(segments):
    """Drop half-words the ASR leaves at the end of a segment.

    Real example from the user's video, segment 7:

        source ASR : "प्रेगनेंट कर दी प्र"
        translation: "ప్రెగ్నెంట్ చేశాను ప్ర"

    The trailing "प्र" is not a word. It is the first syllables of the segment's
    own opening word, repeated by the recogniser at the cut point. Translated
    faithfully and handed to a TTS, it comes out as a stray syllable right after
    the sentence finishes — which is what is heard as a "cha cha" type sound at
    the end of lines.

    The test is positional rather than orthographic: a trailing token is removed
    only when it is a strict PREFIX of a nearby word, so genuinely
    consonant-final words (common in Telugu, e.g. "టెస్ట్") are left alone.
    """
    removed = []
    for idx, s in enumerate(segments):
        text = (s.get("text") or "").strip()
        toks = text.split()
        if len(toks) < 2:
            continue
        last = toks[-1].strip(".,!?;:\u0964")
        if not (2 <= len(last) <= 4):
            continue
        # Candidate words this fragment could be a broken copy of.
        neighbours = list(toks[:-1])
        if idx + 1 < len(segments):
            neighbours += (segments[idx + 1].get("text") or "").split()[:2]
        if any(w != last and w.startswith(last) for w in
               (t.strip(".,!?;:\u0964") for t in neighbours)):
            s["text"] = " ".join(toks[:-1])
            removed.append(f"[{idx}] dropped trailing fragment {last!r}")
    return removed


# Interjections a dubbing line should never END on unless the source had one.
# These are what an LLM reaches for when told to fill a slot, and they are heard
# as a stray sound after the sentence.
_TRAILING_FILLER = {
    "te": ["చ చ", "చచ", "అచ్చా", "అచ్ఛా", "హ్మ్", "హం", "ఆహ్", "ఊఁ", "ఊం"],
    "hi": ["च च", "अच्छा", "हम्म", "हूँ", "अरे"],
    "ta": ["ச ச", "ஹ்ம்"], "kn": ["ಚ ಚ", "ಹ್ಮ್"], "ml": ["ച ച"],
}


def strip_trailing_filler(segments, target_lang):
    """Remove a bolted-on interjection at the end of a line.

    Safety net for the case where the model appends filler despite being told not
    to. Only fires when the line has real content before it, so a line that is
    genuinely just an interjection survives.
    """
    fillers = _TRAILING_FILLER.get((target_lang or "").lower(), [])
    if not fillers:
        return []
    removed = []
    for idx, s in enumerate(segments):
        text = (s.get("text") or "").strip()
        for f in fillers:
            for tail in (f, f + ".", f + "!", f + "?", f + ","):
                if text.endswith(tail) and len(text) > len(tail) + 3:
                    text = text[: -len(tail)].rstrip(" ,.-")
                    removed.append(f"[{idx}] dropped trailing filler {f!r}")
                    break
        if text != (s.get("text") or "").strip():
            s["text"] = text
    return removed


# Longest slot we are willing to hand to the voice engine. A block much longer
# than this cannot be pace-fitted: it is either slowed until it sounds robotic or
# it ends early and leaves dead air.
MAX_SLOT_SECONDS = float(os.environ.get("VS_MAX_SLOT_S", "6.0"))
# If a segment's actual speech covers less than this fraction of its declared
# span, the segment boundaries are wrong and get rebuilt from the audio.
SPARSE_SPEECH_RATIO = float(os.environ.get("VS_SPARSE_RATIO", "0.75"))

# Shortest slot worth treating as its own line. Fragments below this get merged
# into a neighbour instead of becoming their own slot.
#
# This is not a cosmetic threshold. A 0.67 s slot has a character budget of about
# 8, which is too small for a real phrase, and the splitter then either invents
# filler (a stray "చ చ" / "cha cha" appeared at the end of lines) or throws away
# meaning to fit. Keeping slots substantial removes the condition entirely.
MIN_SLOT_SECONDS = float(os.environ.get("VS_MIN_SLOT_S", "1.2"))
# A pause must be at least this long to justify splitting a line across it.
# Shorter gaps are breaths, not phrase boundaries.
MIN_SPLIT_GAP_S = float(os.environ.get("VS_MIN_SPLIT_GAP_S", "0.45"))
# Cap the fragmentation of any one utterance.
MAX_SLOTS_PER_SEGMENT = int(os.environ.get("VS_MAX_SLOTS", "3"))


def _consolidate(slots):
    """Merge slot fragments so each one can carry a real phrase.

    Absorbing a fragment means the pause next to it stays *inside* the slot, so
    the line is spoken across it — which is the behaviour that was working before
    slot splitting existed. Splitting only survives where there is a genuinely
    long pause and both sides are substantial.
    """
    if not slots:
        return []
    merged = [list(slots[0])]
    for a, b in slots[1:]:
        prev = merged[-1]
        gap = a - prev[1]
        if (gap < MIN_SPLIT_GAP_S
                or (prev[1] - prev[0]) < MIN_SLOT_SECONDS
                or (b - a) < MIN_SLOT_SECONDS):
            prev[1] = b
        else:
            merged.append([a, b])
    # Still too many pieces: repeatedly close the smallest pause.
    while len(merged) > MAX_SLOTS_PER_SEGMENT:
        i = min(range(len(merged) - 1),
                key=lambda k: merged[k + 1][0] - merged[k][1])
        merged[i][1] = merged[i + 1][1]
        del merged[i + 1]
    return [(a, b) for a, b in merged]


# Untranscribed speech shorter than this is not worth a new line.
MIN_MISSING_SECONDS = float(os.environ.get("VS_MIN_MISSING_S", "0.8"))


def is_degenerate(seg, target_lang="te"):
    """Is this segment's text meaningless or far too little for its duration?

    A segment can EXIST and still carry nothing to say, which hides the problem
    from plain gap detection. Real case: a segment spanning 30.03 -> 48.48
    (18.45 s) whose text was ". . . . .". VoiceStudio keeps the ORIGINAL audio
    for a segment it cannot speak, so those 18 seconds played the source speaker's
    Telugu inside an English dub — heard as "the original voice is in the dub".
    """
    from gemini_audio import CHARS_PER_SEC

    text = (seg.get("text") or "").strip()
    dur = float(seg.get("end", 0)) - float(seg.get("start", 0))
    if dur <= 0.2:
        return False
    stripped = text.strip(" .,-_·…\u0964\u0965*")
    if len(stripped) < 2:
        return True                       # punctuation only, e.g. ". . . . ."
    if dur > MAX_SLOT_SECONDS:
        rate = CHARS_PER_SEC.get(target_lang, 11.0)
        if len(stripped) < 0.35 * dur * rate:
            return True                   # a long slot with almost no dialogue
    return False


def find_missing_speech(segments, wav_path, target_lang="te"):
    """Stretches of real speech that the transcript does not usefully cover.

    Segments that exist but say nothing are treated as NOT covered, so their span
    can be re-transcribed instead of silently replaying the original audio.

    Returns (regions, source_speech_seconds, transcript_end).
    """
    import numpy as np
    import soundfile as sf
    from prosodic import voiced_runs

    d, sr = sf.read(wav_path, always_2d=True)
    mono = d.mean(axis=1).astype(np.float32)
    dur = len(mono) / sr
    runs = voiced_runs(mono, sr, 0.0, dur)
    speech = sum(b - a for a, b in runs)

    covered = sorted((float(s.get("start", 0)), float(s.get("end", 0)))
                     for s in segments
                     if not is_degenerate(s, target_lang))
    missing = []
    for a, b in runs:
        cur = a
        for ca, cb in covered:
            if cb <= cur or ca >= b:
                continue
            if ca > cur:
                missing.append((cur, min(ca, b)))
            cur = max(cur, cb)
            if cur >= b:
                break
        if cur < b:
            missing.append((cur, b))
    missing = [(a, b) for a, b in missing if (b - a) >= MIN_MISSING_SECONDS]
    return missing, speech, max((b for _, b in covered), default=0.0)


def transcript_density(segments, wav_path):
    """Transcript characters per second of detected speech.

    The single most useful quality number for a transcript. Natural speech runs
    close to the language's own rate (about 10.5 chars/sec for Telugu); a value
    far below that means words were heard but never written down.
    """
    import numpy as np
    import soundfile as sf
    from prosodic import voiced_runs

    d, sr = sf.read(wav_path, always_2d=True)
    mono = d.mean(axis=1).astype(np.float32)
    dur = len(mono) / sr
    speech = sum(b - a for a, b in voiced_runs(mono, sr, 0.0, dur))
    chars = sum(len((s.get("source_text") or s.get("text_original")
                     or s.get("text") or "").strip(" .·…\u0964"))
                for s in segments)
    return (chars / speech if speech > 0.5 else 0.0), chars, speech, dur


def rebuild_transcript_with_gemini(segments, wav_path, source_lang, emit=None):
    """Replace a too-sparse transcript with Gemini's, keeping cloning identity.

    Measured on a real 48.44s video with 45.85s of speech:

        VoiceStudio ASR : 138 characters, 3.01 chars/sec, text stops at 29.99s
        Gemini          : 734 characters, 16.0 chars/sec, covers to 40.50s

    So roughly 70% of what the speaker said was never transcribed. That is the
    root cause behind the 230-315% overflow figures: each slot is sized for a
    fragment, so any faithful translation of the real speech cannot fit it, and
    the dub also simply says far less than the speaker did.

    VoiceStudio's own transcript is still required — it is what produces the
    per-speaker voice clones — so this keeps its diarization and replaces only the
    WORDS. Each new line inherits the speaker_id and profile_id of the VoiceStudio
    segment it overlaps most, so cloning continues to work.

    Returns (segments, notes). Unchanged when the transcript looks healthy.
    """
    from gemini_audio import CHARS_PER_SEC, transcribe_lines

    density, chars, speech, dur = transcript_density(segments, wav_path)
    typical = CHARS_PER_SEC.get((source_lang or "").lower(), 11.0)
    floor = typical * float(os.environ.get("VS_DENSITY_FLOOR", "0.55"))
    if density >= floor:
        return segments, [f"transcript density {density:.1f} chars/s of speech "
                          f"(floor {floor:.1f}) - kept VoiceStudio's transcript"]

    if emit:
        emit("transcribe", 38,
             f"VoiceStudio transcribed only {chars} chars for {speech:.0f}s of "
             f"speech ({density:.1f}/s, expected ~{typical}); re-transcribing "
             f"with Gemini", device="Cloud")

    best = []
    for attempt in range(1, int(os.environ.get("VS_ASR_ATTEMPTS", "2")) + 1):
        try:
            got = transcribe_lines(wav_path, source_lang, emit=emit)
        except Exception as e:
            if emit:
                emit("transcribe", 39,
                     f"Gemini transcription attempt {attempt} failed "
                     f"({str(e)[:50]})")
            continue
        g_chars = sum(len(l["text"]) for l in got)
        if g_chars > sum(len(l["text"]) for l in best):
            best = got
        if g_chars / max(speech, 0.01) >= floor:
            break
    if not best:
        return segments, ["! Gemini transcription failed; kept the sparse "
                          "VoiceStudio transcript"]

    g_chars = sum(len(l["text"]) for l in best)
    if g_chars <= chars:
        return segments, [f"Gemini produced {g_chars} chars vs VoiceStudio's "
                          f"{chars}; kept VoiceStudio's"]

    def overlap(a1, b1, a2, b2):
        return max(0.0, min(b1, b2) - max(a1, a2))

    def identity_for(a, b):
        """The diarized speaker whose segment overlaps this line the most."""
        best_id, best_ov = None, 0.0
        for s in segments:
            if not s.get("speaker_id"):
                continue
            ov = overlap(a, b, float(s.get("start", 0)), float(s.get("end", 0)))
            if ov > best_ov:
                best_id, best_ov = (s.get("speaker_id"), s.get("profile_id")), ov
        if best_id:
            return best_id
        mid = (a + b) / 2
        near, nd = None, 1e9
        for s in segments:
            if not s.get("speaker_id"):
                continue
            c = (float(s.get("start", 0)) + float(s.get("end", 0))) / 2
            if abs(c - mid) < nd:
                near, nd = (s.get("speaker_id"), s.get("profile_id")), abs(c - mid)
        return near

    out = []
    for L in best:
        seg = {"start": float(L["start"]), "end": float(L["end"]),
               "text": L["text"], "source_text": L["text"]}
        ident = identity_for(seg["start"], seg["end"])
        if ident:
            seg["speaker_id"] = ident[0]
            if ident[1]:
                seg["profile_id"] = ident[1]
        out.append(seg)
    out.sort(key=lambda s: s["start"])

    cloned = sum(1 for s in out if s.get("profile_id"))
    notes = [f"REBUILT TRANSCRIPT: VoiceStudio {chars} chars ({density:.1f}/s) "
             f"-> Gemini {g_chars} chars ({g_chars/max(speech,0.01):.1f}/s)",
             f"  {len(segments)} segment(s) -> {len(out)}, "
             f"{cloned} carrying a cloned voice profile"]
    notes += [f"  + {s['start']:6.2f}-{s['end']:6.2f} {s.get('speaker_id','?')} "
              f"{s['text'][:60]}" for s in out]
    if emit:
        emit("transcribe", 41,
             f"Re-transcribed: {chars} -> {g_chars} chars, {len(out)} lines, "
             f"{cloned} with a cloned voice", device="Cloud")
    return out, notes


def fill_transcript_gaps(segments, wav_path, source_lang, emit=None):
    """Add the dialogue VoiceStudio's ASR missed, keeping ITS speaker identities.

    Why this is necessary, and why it does not replace VoiceStudio's ASR:

    VoiceStudio's transcript is what creates the per-speaker voice profiles the
    cloner uses, so it has to stay in charge of speaker identity. But it also
    stops early. Measured on the user's own video: 3 segments ending at 7.66 s of
    20.27 s, leaving 12.96 s — 65% of the speech — with no transcript and
    therefore no dubbed voice. That silence is the reported "audio has gaps but
    the video doesn't".

    So Gemini transcribes the full audio, only the lines landing in uncovered
    regions are taken, and each inherits a real VoiceStudio speaker profile:
    Gemini's own speaker grouping is mapped onto VoiceStudio's labels by temporal
    overlap, falling back to the nearest labelled segment. Cloning therefore keeps
    working on the new lines.
    """
    from gemini_audio import transcribe_lines

    missing, speech, end = find_missing_speech(segments, wav_path, source_lang)
    if not missing:
        return segments, []
    # Segments that carry no usable dialogue are dropped once we have real lines
    # for their span; leaving them in would keep replaying the original audio.
    dead = [s for s in segments if is_degenerate(s, source_lang)]
    # `live` must be used for every overlap test below. Comparing against the full
    # list rejected every recovered line, because a recovered line inside a dead
    # segment's span overlaps that dead segment.
    live = [s for s in segments if s not in dead]
    total = sum(b - a for a, b in missing)
    if emit:
        emit("transcribe", 38,
             f"Transcript covers only {end:.1f}s; {total:.1f}s of speech is "
             f"missing - filling it in", device="Cloud")

    # Retry until the transcription actually covers the missing regions.
    #
    # A single attempt is not good enough: on the same video one run returned
    # 4 usable lines and the next returned none, so the 18 s hole was sometimes
    # filled and sometimes not. Silently continuing on an empty result is the
    # worst outcome, because the dub then replays the ORIGINAL audio there and
    # nothing in the log says why.
    lines = []
    attempts = int(os.environ.get("VS_GAPFILL_ATTEMPTS", "3"))
    for attempt in range(1, attempts + 1):
        try:
            got = transcribe_lines(wav_path, source_lang, emit=emit)
        except Exception as e:
            if emit:
                emit("transcribe", 40,
                     f"Gap transcription attempt {attempt} failed "
                     f"({str(e)[:50]})")
            got = []
        # Judge the attempt on whether it covers the HOLES, not on line count.
        covered_missing = 0.0
        for a, b in missing:
            for L in got:
                covered_missing += max(0.0, min(b, L["end"]) - max(a, L["start"]))
        frac = covered_missing / max(total, 0.01)
        if emit:
            emit("transcribe", 40,
                 f"Gap transcription attempt {attempt}: {len(got)} lines, "
                 f"covers {frac*100:.0f}% of the missing {total:.1f}s",
                 device="Cloud")
        if len(got) > len(lines):
            lines = got
        if frac >= 0.6:
            break
    if not lines:
        if emit:
            emit("transcribe", 41,
                 f"WARNING: could not recover the missing {total:.1f}s of "
                 f"dialogue after {attempts} attempts - the dub will replay the "
                 f"ORIGINAL audio there", device="Cloud")
        return segments, [f"! FAILED to recover {total:.1f}s of dialogue "
                          f"after {attempts} attempts"]

    def overlap(a1, b1, a2, b2):
        return max(0.0, min(b1, b2) - max(a1, a2))

    # Map each Gemini speaker onto the VoiceStudio speaker it overlaps most.
    from collections import defaultdict
    votes = defaultdict(lambda: defaultdict(float))
    for L in lines:
        for s in segments:
            ov = overlap(L["start"], L["end"],
                         float(s.get("start", 0)), float(s.get("end", 0)))
            if ov > 0 and s.get("speaker_id"):
                votes[L["speaker"]][(s.get("speaker_id"),
                                     s.get("profile_id"))] += ov
    mapping = {g: max(v.items(), key=lambda kv: kv[1])[0]
               for g, v in votes.items() if v}

    def nearest_identity(t):
        best, bestd = None, 1e9
        for s in segments:
            if not s.get("speaker_id"):
                continue
            mid = (float(s.get("start", 0)) + float(s.get("end", 0))) / 2
            if abs(mid - t) < bestd:
                best, bestd = (s.get("speaker_id"), s.get("profile_id")), abs(mid - t)
        return best

    added, notes = [], []
    for L in lines:
        # Only take what the existing transcript does not already cover.
        inside = max((overlap(L["start"], L["end"], a, b) for a, b in missing),
                     default=0.0)
        if inside < min(0.5, 0.6 * (L["end"] - L["start"])):
            continue
        if any(overlap(L["start"], L["end"], float(s.get("start", 0)),
                       float(s.get("end", 0))) > 0.25 for s in live):
            continue
        ident = mapping.get(L["speaker"]) or nearest_identity(
            (L["start"] + L["end"]) / 2)
        seg = {"start": L["start"], "end": L["end"], "text": L["text"]}
        if ident:
            seg["speaker_id"], prof = ident[0], ident[1]
            if prof:
                seg["profile_id"] = prof
        added.append(seg)
        notes.append(f"+ {L['start']:6.2f}-{L['end']:6.2f} "
                     f"{seg.get('speaker_id','?')} {L['text'][:60]}")

    if not added:
        return segments, []
    if emit:
        emit("transcribe", 42,
             f"Recovered {len(added)} missing line(s) of dialogue"
             + (f", dropped {len(dead)} empty segment(s)" if dead else ""),
             device="Cloud")
    for s in dead:
        notes.append(f"- dropped empty segment {float(s.get('start',0)):.2f}"
                     f"-{float(s.get('end',0)):.2f} "
                     f"(text {(s.get('text') or '')[:20]!r} would have replayed "
                     f"the original audio)")
    keep = [s for s in segments if s not in dead]
    merged = sorted(keep + added, key=lambda s: float(s.get("start", 0)))
    return merged, notes


# Window used to compare our transcript against a second recogniser, and the share
# below which that window is rebuilt.
#
# The whole-transcript density check cannot see this. Measured on a 9 minute video,
# our transcript held 61% of the characters Gemini heard in the same audio, but not
# evenly: 100% in one 60-second window and 39% in two others. Averaged over the file
# the density looked healthy, so nothing fired, while a third of the dialogue in those
# stretches was never written down and the dub had nothing to say there.
THIN_WINDOW_S = float(os.environ.get("VS_THIN_WINDOW_S", "30"))
THIN_RATIO = float(os.environ.get("VS_THIN_RATIO", "0.70"))
# A window has to hold a reasonable amount of speech before a shortfall means anything.
THIN_MIN_CHARS = int(os.environ.get("VS_THIN_MIN_CHARS", "80"))


def repair_thin_transcript(segments, wav_path, source_lang, emit=None):
    """Rebuild only the stretches where our transcript is missing words.

    rebuild_transcript_with_gemini replaces the WHOLE transcript and only when the
    average density is poor. This is the local version, for the far more common case
    of a recogniser that is fine for most of a video and drops a third of the words in
    a few stretches.

    Keeps VoiceStudio's diarization exactly as the whole-transcript rebuild does: each
    replacement line inherits the speaker_id and profile_id of the original segment it
    overlaps most, so cloning is unaffected.

    Returns (segments, notes).
    """
    from gemini_audio import transcribe_lines

    if os.environ.get("VS_REPAIR_THIN", "1") != "1" or not segments:
        return segments, []

    try:
        ref = transcribe_lines(wav_path, source_lang, emit=emit)
    except Exception as e:
        return segments, [f"! second-opinion transcription failed ({str(e)[:70]})"]
    if not ref:
        return segments, ["! second-opinion transcription returned nothing"]

    end = max(max(float(s.get("end", 0)) for s in segments),
              max(float(l["end"]) for l in ref))

    def chars_in(lines, a, b, field="text"):
        total = 0
        for l in lines:
            la, lb = float(l["start"]), float(l["end"])
            ov = min(lb, b) - max(la, a)
            if ov <= 0:
                continue
            total += int(len((l.get(field) or "").strip())
                         * ov / max(lb - la, 1e-6))
        return total

    thin = []
    t = 0.0
    while t < end:
        w = (t, min(t + THIN_WINDOW_S, end))
        mine = chars_in(segments, *w)
        theirs = chars_in(ref, *w)
        if theirs >= THIN_MIN_CHARS and mine < THIN_RATIO * theirs:
            if thin and w[0] - thin[-1][1] < 0.01:
                thin[-1] = (thin[-1][0], w[1], thin[-1][2] + mine,
                            thin[-1][3] + theirs)
            else:
                thin.append((w[0], w[1], mine, theirs))
        t += THIN_WINDOW_S
    if not thin:
        return segments, ["transcript matches the second opinion everywhere; "
                          "nothing rebuilt"]

    def overlap(a1, b1, a2, b2):
        return max(0.0, min(b1, b2) - max(a1, a2))

    def identity_for(a, b):
        best_id, best_ov = None, 0.0
        for s in segments:
            if not s.get("speaker_id"):
                continue
            ov = overlap(a, b, float(s.get("start", 0)), float(s.get("end", 0)))
            if ov > best_ov:
                best_id, best_ov = (s.get("speaker_id"), s.get("profile_id")), ov
        if best_id:
            return best_id
        mid = (a + b) / 2
        near, nd = None, 1e9
        for s in segments:
            if not s.get("speaker_id"):
                continue
            c = (float(s.get("start", 0)) + float(s.get("end", 0))) / 2
            if abs(c - mid) < nd:
                near, nd = (s.get("speaker_id"), s.get("profile_id")), abs(c - mid)
        return near

    notes, kept, added = [], [], 0
    for s in segments:
        a, b = float(s.get("start", 0)), float(s.get("end", 0))
        mid = (a + b) / 2
        if not any(wa <= mid < wb for wa, wb, _, _ in thin):
            kept.append(s)
    for wa, wb, mine, theirs in thin:
        lines = [l for l in ref
                 if wa <= (float(l["start"]) + float(l["end"])) / 2 < wb
                 and (l.get("text") or "").strip()]
        notes.append(f"  {wa:7.2f}-{wb:7.2f}  ours {mine:4d} chars vs "
                     f"{theirs:4d} ({100.0*mine/max(theirs,1):3.0f}%) "
                     f"-> {len(lines)} line(s) from the second opinion")
        for l in lines:
            seg = {"start": float(l["start"]), "end": float(l["end"]),
                   "text": (l.get("text") or "").strip()}
            seg["source_text"] = seg["text"]
            ident = identity_for(seg["start"], seg["end"])
            if ident:
                seg["speaker_id"] = ident[0]
                if ident[1]:
                    seg["profile_id"] = ident[1]
            kept.append(seg)
            added += 1

    kept.sort(key=lambda s: float(s.get("start", 0)))
    if emit:
        thin_s = sum(wb - wa for wa, wb, _, _ in thin)
        emit("transcribe", 42,
             f"Rebuilt {thin_s:.0f}s of transcript in {len(thin)} thin stretch(es): "
             f"{len(segments)} lines -> {len(kept)}", device="Cloud")
    return kept, ([f"THIN STRETCHES REBUILT: {len(thin)}, {added} new line(s)"]
                  + notes)


def fetch_onsets(job_id, timeout=120):
    """Speech onset times VoiceStudio computed from the SEPARATED VOCALS.

    Far better than analysing the mixed audio ourselves. On the user's video the
    music never drops below our silence threshold, so energy analysis of the mix
    found only two "runs" across 20 s and could not split anything. VoiceStudio
    runs Demucs first, so its onsets survive the music: for the 7.10-20.32 s block
    it reports onsets at 11.64, 15.42, 16.30, 16.78 and 17.14.
    """
    try:
        r = _req(f"/dub/onsets/{job_id}", timeout=timeout)
        return sorted(float(x) for x in (r.get("onsets") or []))
    except Exception:
        return []


def _consolidate_contiguous(slots, cap):
    """Merge back-to-back pieces until each is long enough, then honour `cap`.

    Separate from _consolidate because these pieces touch (there is no pause
    between them to measure), so the gap test does not apply — merging is driven
    purely by minimum duration.
    """
    if not slots:
        return []
    merged = [list(slots[0])]
    for a, b in slots[1:]:
        prev = merged[-1]
        if (prev[1] - prev[0]) < MIN_SLOT_SECONDS or (b - a) < MIN_SLOT_SECONDS:
            prev[1] = b
        else:
            merged.append([a, b])
    while len(merged) > max(1, cap):
        i = min(range(len(merged)), key=lambda k: merged[k][1] - merged[k][0])
        j = i - 1 if i > 0 and (i == len(merged) - 1 or
                                (merged[i - 1][1] - merged[i - 1][0])
                                <= (merged[i + 1][1] - merged[i + 1][0])) else i + 1
        lo, hi = min(i, j), max(i, j)
        merged[lo][1] = merged[hi][1]
        del merged[hi]
    return [(a, b) for a, b in merged]


def _even_split(a, b, max_len):
    """Last-resort split into equal pieces, each within max_len.

    Used only when neither pause detection nor vocal onsets found a boundary
    (continuous speech, or music covering every pause). An arbitrary cut is
    still better than handing the voice engine a single very long utterance.
    """
    import math

    n = max(1, int(math.ceil((b - a) / max_len)))
    step = (b - a) / n
    return [(a + i * step, a + (i + 1) * step) for i in range(n)]


def split_at_onsets(st, en, onsets, pad=0.05):
    """Cut [st, en] at vocal onsets, keeping every piece a usable length."""
    cuts = [o - pad for o in onsets
            if st + MIN_SLOT_SECONDS <= o <= en - MIN_SLOT_SECONDS]
    if not cuts:
        return [(st, en)]
    bounds = [st] + cuts + [en]
    cap = max(MAX_SLOTS_PER_SEGMENT, int((en - st) / MAX_SLOT_SECONDS) + 1)
    return _consolidate_contiguous(list(zip(bounds[:-1], bounds[1:])), cap)


def plan_slots(segments, wav_path, onsets=None, emit=None):
    """Find where speech ACTUALLY is inside each ASR segment.

    VoiceStudio's ASR sometimes emits a segment far longer than the speech it
    contains. Measured on a real job: a segment declared 10.24 -> 20.28 (10.0 s)
    held three words. Two things then go wrong:

      * the character budget is derived from the declared 10 s, so the translator
        is asked for roughly 120 characters of Telugu for three words of Hindi —
        it fills the space with invented wording, which is exactly the "wrong
        words" complaint, and
      * the synthesized line is spread across the whole 10 s, so it drifts off
        the mouth movement and leaves audible dead air.

    This attaches to each segment:
      slots         : [(start, end), ...] where speech really occurs
      speech_seconds: total of those slots, used for the character budget
    """
    import numpy as np
    import soundfile as sf
    from prosodic import voiced_runs

    try:
        data, sr = sf.read(wav_path, always_2d=True)
        mono = data.mean(axis=1).astype(np.float32)
    except Exception as e:
        if emit:
            emit("transcribe", 44, f"Slot analysis skipped ({e})")
        for s in segments:
            s["slots"] = [(float(s["start"]), float(s["end"]))]
            s["speech_seconds"] = float(s["end"]) - float(s["start"])
        return segments, []

    notes = []
    for s in segments:
        st, en = float(s.get("start", 0)), float(s.get("end", 0))
        span = max(0.01, en - st)
        runs = voiced_runs(mono, sr, st, en)
        voiced_total = sum(b - a for a, b in runs)

        # Only rebuild when there is a real problem: an over-long block, or a
        # block whose speech is sparse. Otherwise trust the ASR boundaries,
        # because they carry the speaker/profile alignment.
        needs_fix = span > MAX_SLOT_SECONDS or (
            runs and voiced_total < SPARSE_SPEECH_RATIO * span)

        if not runs:
            slots = [(st, en)]
        elif needs_fix:
            # Three escalating ways to break up an over-long block, because each
            # fails on real material in a different way:
            #   1. pauses in the MIXED audio     - blind when music plays under
            #      the dialogue, which is why a 13.22 s block stayed intact and
            #      got dubbed as one long utterance in a single voice
            #   2. vocal onsets from VoiceStudio - music-proof (Demucs runs
            #      first), but only where it found onsets
            #   3. an even split                 - always available
            # A slot is never left above the cap: one long utterance is what
            # collapses several speakers into one voice and drifts out of sync.
            slots = []
            for a, b in _consolidate(runs):
                if (b - a) <= MAX_SLOT_SECONDS:
                    slots.append((a, b))
                    continue
                finer = _consolidate(
                    voiced_runs(mono, sr, a, b, min_pause_ms=200))
                if len(finer) > 1:
                    slots.extend(finer)
                    continue
                by_onset = split_at_onsets(a, b, onsets) if onsets else [(a, b)]
                if len(by_onset) > 1:
                    slots.extend(by_onset)
                    continue
                slots.extend(_even_split(a, b, MAX_SLOT_SECONDS))

            # Cap fragmentation, allowing more pieces for a longer segment. The
            # merge is duration-driven, not gap-driven: several pieces above are
            # contiguous, and a gap-based merge would undo the split entirely.
            cap = max(MAX_SLOTS_PER_SEGMENT, int(span / MAX_SLOT_SECONDS) + 1)
            if len(slots) > cap:
                slots = _consolidate_contiguous(slots, cap)
            notes.append(
                f"[{st:6.2f}-{en:6.2f}] span={span:5.2f}s speech={voiced_total:5.2f}s"
                f" -> {len(slots)} slot(s): "
                + ", ".join(f"{a:.2f}-{b:.2f}" for a, b in slots))
        else:
            slots = [(st, en)]

        s["slots"] = slots
        s["speech_seconds"] = round(sum(b - a for a, b in slots), 2)

    if emit and notes:
        emit("transcribe", 45,
             f"Retimed {len(notes)} over-long/sparse segment(s) from the audio",
             device="Cloud")
    return segments, notes


# Characters a split may legitimately add or drop at a cut point: a clause that
# becomes its own line often needs its own terminator.
_SPLIT_PUNCT = set(" \t\n.,!?;:'\"()[]-–—…\u200c\u200d\u0964\u0965")


def _split_is_faithful(text, parts, max_inserted=0, max_dropped_ratio=0.08):
    """Did the splitter actually SPLIT the line, or quietly rewrite it?

    Two observed failures, both reported by the user, are caught here:
      * words deleted to fit a character budget — "translator" disappeared and
        "I hope you are doing well" became "everything is good". The slot then
        holds less speech than time, which is heard as a gap.
      * filler invented for a slot too small for real words, the source of the
        stray "cha cha" at the end of lines.

    A split must not INSERT anything, so insertions are compared by count rather
    than by percentage. A ratio test is useless here: two invented characters in
    an 85-character line is only 2%, which sails through any sane percentage
    threshold while being clearly audible.

    Punctuation and whitespace are ignored, since a clause promoted to its own
    line reasonably gains a full stop.
    """
    import difflib

    if not parts or not text:
        return False

    def norm(s):
        return "".join(ch for ch in s if ch not in _SPLIT_PUNCT)

    src, got = norm(text), norm(" ".join(parts))
    if not src:
        return False

    inserted = dropped = 0
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(
            None, src, got, autojunk=False).get_opcodes():
        if op == "insert":
            inserted += j2 - j1
        elif op == "delete":
            dropped += i2 - i1
        elif op == "replace":
            inserted += j2 - j1
            dropped += i2 - i1
    return inserted <= max_inserted and (dropped / len(src)) <= max_dropped_ratio


def apply_slots(segments, target_lang, emit=None):
    """Expand multi-slot segments into one segment per slot.

    The translation is split across the slots by the LLM so each part lands on the
    speech it belongs to, and the silence between slots stays silent. Everything
    that identifies the voice (speaker_id / profile_id) is copied to every part,
    so cloning is unaffected.
    """
    from gemini_audio import budget_for, split_into_phrases

    multi = [(i, s) for i, s in enumerate(segments)
             if len(s.get("slots") or []) > 1 and (s.get("text") or "").strip()]
    parts_by_i = {}
    if multi:
        items = [{"i": i,
                  "text": s["text"],
                  "phrases": [{"seconds": round(b - a, 2),
                               "budget": budget_for(b - a, target_lang)}
                              for a, b in s["slots"]]}
                 for i, s in multi]
        if emit:
            emit("translate", 55,
                 f"Splitting {len(items)} line(s) across their speech slots",
                 device="Cloud")
        try:
            parts_by_i = split_into_phrases(items, target_lang)
        except Exception as e:
            if emit:
                emit("translate", 55, f"Slot split failed ({str(e)[:60]}); "
                                      "keeping single blocks")

    out = []
    for i, s in enumerate(segments):
        slots = s.get("slots") or [(float(s["start"]), float(s["end"]))]
        if len(slots) == 1:
            s["start"], s["end"] = float(slots[0][0]), float(slots[0][1])
            out.append(s)
            continue
        parts = parts_by_i.get(i) or []
        if len(parts) != len(slots) or not _split_is_faithful(s["text"], parts):
            # Could not split safely: keep one segment, but still tighten it to
            # the speech extent so it does not stretch across the silence.
            #
            # Falling back matters. A split that drops words leaves the slot
            # under-filled (audible gaps), and one that adds words injects sounds
            # the actor never said. One honest block beats either.
            s["start"], s["end"] = float(slots[0][0]), float(slots[-1][1])
            out.append(s)
            continue
        for (a, b), txt in zip(slots, parts):
            child = dict(s)
            child.pop("id", None)      # a fresh slot, not an existing render
            child.pop("slots", None)
            child["start"], child["end"] = float(a), float(b)
            child["text"] = txt
            out.append(child)
    return out


# Source characters per translation request. The whole script used to go in one
# call, which silently broke on the first long video: 146 lines of Hindi asked for
# more Telugu than the 16384-token response cap could hold, so all three models
# returned TRUNCATED JSON and the run died at "Unterminated string".
#
# The cap is on OUTPUT, and each line produces roughly twice its own length back
# ("fixed" is about as long as the source, "dst" similar, plus a short note). Indic
# scripts also tokenise close to one token per character. 2500 source characters
# therefore lands near 6-7k output tokens, comfortably inside the cap with room for
# a language that expands more than expected.
TRANSLATE_BATCH_CHARS = int(os.environ.get("VS_TRANSLATE_BATCH_CHARS", "2500"))
# Second limit, for a video of many very short lines: JSON overhead per entry is
# roughly constant, so line count can bind before character count does.
TRANSLATE_BATCH_LINES = int(os.environ.get("VS_TRANSLATE_BATCH_LINES", "40"))
# Preceding lines passed as read-only context. Batching costs the model the
# surrounding dialogue it uses to repair ASR errors and keep pronouns consistent;
# this hands back the tail of the previous batch without asking for it again.
TRANSLATE_CONTEXT_LINES = int(os.environ.get("VS_TRANSLATE_CONTEXT_LINES", "3"))


def _translate_batches(items):
    """Split the line list into requests small enough to answer in full.

    Yields (batch, context) where context is the last few source lines before the
    batch, for continuity only.
    """
    batches, cur, cur_chars = [], [], 0
    for it in items:
        n = len(it.get("src") or "")
        if cur and (cur_chars + n > TRANSLATE_BATCH_CHARS
                    or len(cur) >= TRANSLATE_BATCH_LINES):
            batches.append(cur)
            cur, cur_chars = [], 0
        cur.append(it)
        cur_chars += n
    if cur:
        batches.append(cur)

    for b in batches:
        first = b[0]["i"]
        lo = max(0, first - TRANSLATE_CONTEXT_LINES)
        context = [{"i": items[j]["i"], "src": items[j]["src"]}
                   for j in range(lo, first)]
        yield b, context


# Writing systems that identify a language on sight. Only used to replace "auto",
# never to override a language the caller stated.
_SCRIPT_RANGES = (
    ("hi", 0x0900, 0x097F),      # Devanagari: Hindi and Marathi share it, and both
                                 # sit at 11.5 chars/s, so the pace reference is the
                                 # same either way
    ("te", 0x0C00, 0x0C7F),
    ("ta", 0x0B80, 0x0BFF),
    ("kn", 0x0C80, 0x0CFF),
    ("ml", 0x0D00, 0x0D7F),
    ("bn", 0x0980, 0x09FF),
    ("gu", 0x0A80, 0x0AFF),
    ("pa", 0x0A00, 0x0A7F),
    ("or", 0x0B00, 0x0B7F),
    ("ur", 0x0600, 0x06FF),
    ("ja", 0x3040, 0x30FF),
    ("ko", 0xAC00, 0xD7AF),
    ("zh-cn", 0x4E00, 0x9FFF),
)


def detect_source_lang(segments):
    """Identify the source language from the transcript's writing system.

    Worth doing because "auto" costs a measurement: measure_source_pace needs a
    typical rate for the source language to convert this speaker's pace into a
    character budget, and with "auto" it gives up ("no reference rate for source
    language 'auto'") and falls back to the target language's constant. That is how
    every line ends up budgeted for an average talker rather than this one.

    Script is a reliable signal here and needs no extra model call. Returns None when
    the text is mostly Latin, where the script does not identify the language.
    """
    counts = {}
    for s in segments:
        for ch in (s.get("text") or ""):
            o = ord(ch)
            for code, lo, hi in _SCRIPT_RANGES:
                if lo <= o <= hi:
                    counts[code] = counts.get(code, 0) + 1
                    break
    if not counts:
        return None
    best, n = max(counts.items(), key=lambda kv: kv[1])
    return best if n >= 40 else None


def translate_with_gemini(segments, source_lang, target_lang, emit=None,
                         target_cps=None):
    """Translate with Gemini using per-line character budgets.

    This is the piece VoiceStudio does poorly. Budgeting by slot duration is
    also what stops lines ending early and leaving gaps.

    `target_cps` is the rate the cloned voice was MEASURED at, when it is known
    before translating. It overrides the estimate from the speaker's source-language
    pace, which measures the wrong thing: one job's Hindi speaker ran at 13.5 chars/s
    while his Telugu clone delivered 19.5, so every line was written two thirds full.
    """
    from gemini_audio import LANG_NAME, TRANSLATE_MODEL, translate_call

    if (source_lang or "auto") in (None, "", "auto"):
        found = detect_source_lang(segments)
        if found:
            if emit:
                emit("translate", 48,
                     f"Source language read from the transcript's script: {found}",
                     device="Cloud")
            source_lang = found

    # Budget from a MEASURED rate rather than a per-language constant, in order of
    # trustworthiness:
    #   1. the rate previous renders actually produced for this target language
    #   2. this speaker's own pace, scaled across the language pair
    #   3. the language constant
    # Seed only. The authoritative correction happens after the first render, via
    # VoiceStudio's own calibrated planner (see condense_after_render), which
    # cannot run earlier because its calibration is derived from segments this job
    # has already synthesized.
    if target_cps:
        pace_note = (f"budget at the MEASURED voice rate {target_cps:.1f} chars/s "
                     f"(language constant is {target_rate_for(target_lang)})")
    else:
        target_cps, pace_note = measure_source_pace(segments, source_lang,
                                                   target_lang)
    if emit and pace_note:
        emit("translate", 49, f"Length budget: {pace_note}", device="Cloud")

    items = []
    for i, s in enumerate(segments):
        span = max(0.2, float(s.get("end", 0)) - float(s.get("start", 0)))
        # Budget from the SLOT, bounded by what the source actually says.
        #
        # It used to budget from measured speech time inside the segment, to stop the
        # translator inventing dialogue for a 10 second slot holding three words. That
        # guard was right but the instrument was wrong: a speaker's pauses fall inside
        # his segments, so speech time is routinely a fraction of the slot, and every
        # line came out too short to cover it. Measured against the same video dubbed
        # through VoiceStudio's own UI, in target characters per second of slot:
        #
        #     their dub  17.51   ~= this voice's measured 18.5, i.e. slots full
        #     ours       12.42   71% of that, and coverage 0.69x against their 0.95x
        #
        # A short line then leaves surplus time, and surplus time is what makes the
        # engine fill the gap with its reference audio in the original language.
        #
        # So the slot sets the budget and the SOURCE caps it. Where the speaker really
        # said little, the cap holds and the slot is trimmed later instead; where he
        # spoke throughout, the line now covers him.
        src_text = (s.get("text") or "").strip()
        slot_budget = _budget_chars(span, target_lang, target_cps)
        # A faithful translation runs within about a third of its source's length.
        # Never below the source's own length either: a translation forced shorter than
        # what was said is how meaning gets dropped.
        src_cap = max(len(src_text), int(len(src_text) * SRC_EXPANSION_MAX))
        items.append({
            "i": i,
            "seconds": round(span, 2),
            "budget": max(6, min(slot_budget, src_cap) if src_text
                          else slot_budget),
            # Second, independent length signal. Measured on real lines, telling
            # the model to match the source's character count produced the most
            # conservative results of three strategies tried (61-89% of each slot,
            # zero overrun), so it is a useful cross-check on the budget.
            "src_chars": len(src_text),
            "src": src_text,
        })

    src_name = LANG_NAME.get((source_lang or "").lower(), "the source language")
    dst_name = LANG_NAME.get(target_lang, target_lang)

    def build_prompt(batch, context):
        ctx = ""
        if context:
            ctx = ("\nEarlier lines, for context only. Do NOT translate these "
                   "and do NOT return them:\n"
                   + json.dumps(context, ensure_ascii=False) + "\n")
        return f"""You are a professional dubbing script writer translating {src_name} into {dst_name}.

For each line you get its index (i), on-screen duration in seconds (sec), a character budget, and the ASR text (src) which may contain recognition errors.

For each line produce:
1. "fixed": the source line with obvious ASR errors repaired, using surrounding lines as context. Keep intent and tone. Do not invent content.
   IMPORTANT: the recogniser often leaves a CUT-OFF HALF-WORD at the end of a line (a bare syllable fragment that is not a real word, sometimes a partial repeat of a nearby word). Delete such fragments completely. Never translate them and never carry them into "dst" — spoken aloud they become a stray meaningless sound after the sentence.
2. "dst": a natural, colloquial spoken {dst_name} translation.
3. "instruct": a very short delivery note for the voice actor (e.g. "angry shout", "nervous confession", "calm narration").

Length rule — this matters as much as accuracy:
- "dst" must be sayable in `sec` seconds: aim for about `budget` characters.
- Cross-check against `src_chars`, the source line's own character count. When the two languages have comparable density, a faithful translation lands within roughly 25% of it. If your line is far longer than `src_chars` AND over `budget`, you are padding — cut it back. (`budget` wins if the two disagree, since it is measured from the actual speaking voice.)
- Do NOT go far under the budget either: a line that finishes early leaves a silent gap on screen. Use the fuller natural phrasing when you have room.
- Never pad with filler or repeat words to reach the budget.
- Never append an interjection or filler sound (nothing like "cha cha", "hmm", "achcha") that is not in the source. Every line must end on a real word of the sentence.

Return ONLY JSON, one entry for every line given below and nothing else:
{{"lines":[{{"i":0,"fixed":"...","dst":"...","instruct":"..."}}]}}
{ctx}
Lines:
{json.dumps(batch, ensure_ascii=False)}"""

    if emit:
        emit("translate", 50,
             f"Translating {len(items)} lines with {TRANSLATE_MODEL} "
             f"(length-budgeted)", device="Cloud")

    by_i = {}
    for bi, (batch, context) in enumerate(_translate_batches(items), start=1):
        data = translate_call([{"text": build_prompt(batch, context)}],
                             timeout=600, emit=emit)
        got = 0
        for L in (data.get("lines") if isinstance(data, dict) else data) or []:
            if not isinstance(L, dict):
                continue
            try:
                by_i[int(L["i"])] = L
                got += 1
            except (KeyError, TypeError, ValueError):
                continue
        if emit:
            emit("translate", 51,
                 f"Translated batch {bi}: {got}/{len(batch)} lines "
                 f"({len(by_i)}/{len(items)} done)", device="Cloud")

    missing = [i for i in range(len(items)) if i not in by_i]
    if missing:
        if emit:
            emit("translate", 52,
                 f"WARNING: {len(missing)} line(s) came back untranslated and "
                 f"will keep their source text: {missing[:12]}")

    # Enforce the budget. The first pass reliably overshoots (measured 103 chars
    # against an 80 char budget). That matters for sync: the fitter will only
    # compress up to VS_AUDIO_RATE_CAP (1.25x), so a line 1.29x over budget
    # cannot be squeezed into its slot and spills into the next one, pushing
    # every following line late.
    tightened = _tighten_over_budget(segments, items, by_i, target_lang,
                                     emit=emit)

    report = [f"TRANSLATION MODEL: {TRANSLATE_MODEL}", ""]
    if pace_note:
        report += [f"BUDGET BASIS: {pace_note}", ""]
    if tightened:
        report.append(f"TIGHTENED TO FIT: {tightened} line(s) were over budget")
        report.append("")
    for i, s in enumerate(segments):
        L = by_i.get(i) or {}
        dst = (L.get("dst") or "").strip()
        # Keep the source line. Overwriting `text` in place left nothing to
        # retranslate from, so the later fit pass could only PAD the translation,
        # and padding is invented content that stops matching the picture.
        if not s.get("source_text"):
            s["source_text"] = items[i]["src"]
        if dst:
            s["text"] = dst                      # what VoiceStudio will speak
        s["instruct"] = (L.get("instruct") or "").strip()
        b = items[i]["budget"]
        report.append(
            f"[{i:02d}] {items[i]['seconds']}s budget={b} got={len(dst)}\n"
            f"     ASR: {items[i]['src']}\n"
            f"     FIX: {(L.get('fixed') or '').strip()}\n"
            f"     DST: {dst}   [{s['instruct']}]")
    return segments, report


def _tighten_over_budget(segments, items, by_i, target_lang, tolerance=1.12,
                         emit=None):
    """Shorten lines that overshot their character budget.

    Reuses rewrite_to_fit, which is already prompted to condense wording without
    losing meaning. Only lines beyond `tolerance` are touched, and a rewrite is
    accepted only when it is genuinely shorter — so a failed or unhelpful rewrite
    leaves the original alone rather than making things worse.
    """
    from gemini_audio import rewrite_to_fit

    over = []
    for i, it in enumerate(items):
        dst = (by_i.get(i, {}).get("dst") or "").strip()
        if dst and len(dst) > it["budget"] * tolerance:
            over.append({"i": i, "seconds": it["seconds"],
                         "budget": it["budget"], "dst": dst})
    if not over:
        return 0

    if emit:
        emit("translate", 53,
             f"Tightening {len(over)} line(s) that overran their time slot",
             device="Cloud")
    try:
        shorter = rewrite_to_fit(over, target_lang)
    except Exception as e:
        if emit:
            emit("translate", 53, f"Tightening skipped ({str(e)[:60]})")
        return 0

    n = 0
    for i, new in (shorter or {}).items():
        new = (new or "").strip()
        old = (by_i.get(i, {}).get("dst") or "").strip()
        if new and old and len(new) < len(old):
            by_i[i]["dst"] = new
            n += 1
    return n


def supports_emotion(default=False):
    """Does the ACTIVE VoiceStudio TTS engine accept an `instruct` prompt?

    This matters a great deal. The default engine (omnivoice) reports
    supports_emotion=false, and sending it a per-segment `instruct` makes
    synthesis produce NOTHING — measured as `bench[generate] tts=0.00s` and a
    completely silent voice track, so the dubbed video played background music
    only. Isolation test:
        start/end/text            -> voice rms 0.0995  OK
        + instruct                -> voice rms 0.0000  SILENT
        + speaker_id              -> voice rms 0.1050  OK
    So we only send `instruct` to an engine that advertises support for it.
    """
    try:
        info = _req("/engines", timeout=60)
        tts = info.get("tts") or {}
        active = tts.get("active")
        for b in tts.get("backends", []):
            if b.get("id") == active:
                return bool(b.get("supports_emotion"))
    except Exception:
        pass
    return default


def _segment_payload(s, with_instruct=False):
    """Build one segment for /dub/generate, preserving VoiceStudio's own fields.

    Passes through `speaker_id`/`profile_id` so the cloner keeps using each
    original speaker's voice. Deliberately omits `id`/`seg_id` (they mark a
    segment as already rendered and cause synthesis to be skipped) and omits
    `instruct` unless the active engine supports it (see supports_emotion).
    """
    out = {
        "start": float(s.get("start", 0)),
        "end": float(s.get("end", 0)),
        "text": (s.get("text") or "").strip(),
    }
    if with_instruct and (s.get("instruct") or "").strip():
        out["instruct"] = s["instruct"].strip()
    # Pass through the fields that identify WHOSE voice to use.
    #
    # Deliberately NOT `id`/`seg_id`: those identify an already-rendered segment,
    # and including them makes VoiceStudio skip synthesis entirely — observed as
    # `bench[generate] tts=0.00s segs=4`, producing a completely silent voice
    # track (the user heard only background music). Omitting them makes it
    # synthesize fresh, while speaker_id still selects the cloned voice.
    for k in ("profile_id", "speaker", "speaker_id", "voice_profile_id",
              "effect_preset", "speed", "gain", "direction", "target_lang"):
        if s.get(k) not in (None, ""):
            out[k] = s[k]
    return out


# Strategy used for the first, measuring render. smart_fit computes a fit plan and
# records each line's NATURAL duration, which strict_slot does not — under
# strict_slot every clip comes back exactly slot-length, so there is no way to
# tell an over-long line from a perfectly sized one.
MEASURE_STRATEGY = os.environ.get("VS_MEASURE_STRATEGY", "smart_fit")


def natural_durations(job_id, target_lang, count):
    """Each line's duration BEFORE time-fitting, if VoiceStudio recorded it.

    The honest signal for "is this line too long for its slot". Falls back to the
    rendered clip lengths, which are only meaningful when the render did not pin
    every clip to its slot.
    """
    row = _history_row(job_id) or {}
    try:
        jd = json.loads(row.get("job_data") or "{}")
    except Exception:
        jd = {}
    by_lang = jd.get("seg_natural_durs_by_lang") or {}
    entry = by_lang.get(target_lang) or by_lang.get("und")

    # Shape is {"te": {"seg_0": {"chars": 51, "dur": 3.0}, ...}}, ordered by
    # seg_order. Values may also be bare numbers, so handle both.
    if isinstance(entry, dict):
        order = jd.get("seg_order") or sorted(entry.keys())
        out = []
        for k in order:
            v = entry.get(k)
            if isinstance(v, dict):
                v = v.get("dur")
            try:
                out.append(float(v) if v is not None else None)
            except (TypeError, ValueError):
                out.append(None)
        if len(out) >= count and any(out):
            return out[:count], "natural"
    return measure_rendered(job_id, count), "rendered"


def generate(job_id, segments, target_lang, timeout=7200, emit=None,
             timing_strategy=None, speed=None):
    """Clone + synthesize + fit, with the gap-avoiding timing controls."""
    use_instruct = supports_emotion()
    if emit and not use_instruct:
        emit("synthesize", 59,
             "Active voice engine has no emotion control; sending plain text",
             device="Cloud")
    # Send EVERY row, including ones we emptied, and name the stable ids.
    #
    # VoiceStudio maps the request onto the job's own stored segments positionally:
    #
    #     job["seg_order"] = [seg_ids[k] if k < len(seg_ids) else f"seg_{k}"
    #                         for k in range(len(req.segments))]
    #
    # and _sync_job_segments matches "by stable id (fallback: index)". So dropping or
    # merging rows silently shifts every later line onto a different stored slot.
    # That is what wrecked the last dub: 140 rows sent against 144 stored, after
    # which the export re-assembled our text on the ORIGINAL timeline, leaving long
    # slots holding one-word lines. An F5-style model asked to fill a slot far longer
    # than its words fills the surplus with the reference audio it was conditioned
    # on, so the finished video had the original Hindi speaking underneath the Telugu.
    #
    # Passing segment_ids makes the mapping explicit instead of positional, and
    # keeping empty rows keeps the positions themselves honest — VoiceStudio writes
    # silence for a segment with no text, which is what an emptied row should be.
    rows = [_segment_payload(s, with_instruct=use_instruct) for s in segments]
    ids = [s.get("id") for s in segments]
    payload = {
        "segments": rows,
        "language_code": target_lang,
        "slot_fit": SLOT_FIT,
        "timing_strategy": timing_strategy or TIMING_STRATEGY,
        "overflow_budget_s": OVERFLOW_BUDGET_S,
        "voice_match": VOICE_MATCH,
        "num_step": NUM_STEP,
        # Native synthesis speed. 1.0 leaves this engine at ~6.8 chars/s, roughly
        # half a natural speaking rate, which is what forced every downstream
        # compromise (time-stretching, then cutting text).
        "speed": float(speed if speed else (SPEED_FIXED or 1.0)),
        "fit_options": {
            "gap_guard_s": GAP_GUARD_S,
            "audio_rate_cap": AUDIO_RATE_CAP,
            "max_audio_only_rate": AUDIO_RATE_CAP,
            "video_slow_cap": VIDEO_SLOW_CAP,
            "allow_video_retime": ALLOW_VIDEO_RETIME,
        },
    }
    if all(ids):
        payload["segment_ids"] = ids
    if emit:
        spoken = sum(1 for r in rows if r.get("text"))
        emit("synthesize", 60,
             f"VoiceStudio cloning {spoken} lines of {len(rows)} rows "
             f"({payload['timing_strategy']}"
             f"{', ids mapped' if all(ids) else ', positional'})",
             device="Cloud")
    return _req(f"/dub/generate/{job_id}", data=payload, method="POST",
                timeout=timeout)


def measure_rendered(job_id, count, timeout=120):
    """Actual synthesized duration of each rendered segment, in order.

    This is the only trustworthy fit signal. VoiceStudio's own /tools/rate-fit
    reported rate_ratio 0.97-1.04 (i.e. "all fine") for segments that in reality
    needed up to 1.52x compression, because neither it nor a character budget
    knows how fast a given cloned voice speaks.
    """
    import io

    import soundfile as sf

    out = []
    for i in range(count):
        try:
            with urllib.request.urlopen(
                    f"{BASE}/dub/preview/{job_id}/{i}", timeout=timeout) as r:
                raw = r.read()
            d, sr = sf.read(io.BytesIO(raw))
            out.append(len(d) / float(sr))
        except Exception:
            out.append(None)
    return out


def _speaker_key(seg):
    return (seg.get("profile_id") or seg.get("speaker_id")
            or seg.get("speaker") or "_default")


def calibrate_rates(segments, durations, fallback):
    """Characters per second for each voice, measured from the render.

    Cloned voices inherit the pace of their reference speaker, and the spread is
    large. Measured on the user's video (Telugu output):

        Speaker 3 : 13.2 - 17.6 chars/sec
        Speaker 1 : 15.9 chars/sec
        Speaker 2 :  9.0 -  9.2 chars/sec

    A single global rate (we assumed 10.5 for Telugu) therefore under-fills the
    fast voices, leaving audible gaps, and over-fills the slow one, so its lines
    overrun and shove every later line late. On that video the damage was 1.59 s
    of gaps plus 3.58 s of overflow.
    """
    from collections import defaultdict

    acc = defaultdict(lambda: [0, 0.0])
    for seg, dur in zip(segments, durations):
        text = (seg.get("text") or "").strip()
        if not dur or dur <= 0.05 or len(text) < 4:
            continue
        a = acc[_speaker_key(seg)]
        a[0] += len(text)
        a[1] += dur
    rates = {k: (c / s) for k, (c, s) in acc.items() if s > 0.2}
    return rates, (sum(rates.values()) / len(rates) if rates else fallback)


def condense_after_render(job_id, segments, target_lang, emit=None,
                          artifact_text=None, out=None, base_cps=None,
                          speed=1.0):
    """Correct line lengths using VoiceStudio's OWN calibrated duration planner.

    This replaces a hand-rolled loop that duplicated, less well, what
    services/duration_planner.py already does:

      * Calibration    - chars/second derived from THIS job's already-synthesized
                         segments (needs MIN_CALIBRATION_SAMPLES = 3, which is why
                         it can only run after a render).
      * classify_segments - verdict per line: fits / tight / impossible, against
                         available time = the slot PLUS silence borrowable from
                         the gap to the next segment, capped at
                         GAP_BORROW_MAX_S = 3.0. My own code treated those gaps as
                         untouchable and threw that time away.
      * condense_for_slot - LLM rewrite targeting the available duration, with a
                         divergence guard, applied only to `impossible` lines.

    One subtlety from their source: the condense pass writes suggestions to
    `plan.suggested_text` and deliberately does NOT modify the row text ("the user
    applies them per segment"). So we apply the suggestions ourselves here, which
    is what the refresh icon beside each line does in the UI.

    Returns the number of lines changed.
    """
    payload = []
    ids = []
    for i, s in enumerate(segments):
        sid = str(s.get("id") or f"gen{i:05d}")
        ids.append(sid)
        payload.append({
            "id": sid,
            "start": float(s.get("start", 0)),
            "end": float(s.get("end", 0)),
            "text": (s.get("text") or "").strip(),
        })

    def classify(texts):
        """Ask the planner to judge these exact lines. Returns rows or None."""
        body = {
            "segments": [dict(p, text=t) for p, t in zip(payload, texts)],
            "target_lang": target_lang, "source_lang": target_lang,
            "job_id": job_id, "provider": "openai", "quality": "fast",
            "reflect": False, "condense": True,
        }
        try:
            req = urllib.request.Request(
                BASE + "/dub/translate", data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=900) as r:
                got = (json.loads(r.read()) or {}).get("translated") or []
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:160]
            if emit:
                emit("synthesize", 82, f"Planner unavailable ({e.code}: {detail})")
            return None
        except Exception as e:
            if emit:
                emit("synthesize", 82, f"Planner unavailable ({str(e)[:70]})")
            return None
        if len(got) != len(texts):
            if emit:
                emit("synthesize", 82,
                     f"Planner returned {len(got)} of {len(texts)} lines; skipping")
            return None

        # Re-order the response to match the order we sent, keying on id.
        #
        # The planner does NOT preserve request order. Verified on a 14-line job:
        # every row came back displaced, with the synthetic `gen*` ids grouped
        # ahead of the `s000*` ids, while the id set was identical. Pairing rows to
        # segments by position therefore attached each line's verdict to a
        # different line's text — the report claimed a 6.09s line "fits" a 1.00s
        # slot, and condensation shortened the wrong lines.
        by_id = {}
        for row in got:
            rid = row.get("id")
            if rid is not None:
                by_id[str(rid)] = row
        ordered = [by_id.get(sid) for sid in ids]
        if any(r is None for r in ordered):
            unmatched = [sid for sid, r in zip(ids, ordered) if r is None]
            if emit:
                emit("synthesize", 82,
                     f"Planner response missing ids {unmatched[:3]}; skipping "
                     f"to avoid mispairing verdicts")
            return None
        return ordered

    texts = [p["text"] for p in payload]
    rows = classify(texts)
    if rows is None:
        return 0

    def verdicts(rs):
        c = {}
        for r in rs:
            k = str((r.get("plan") or {}).get("status") or "?")
            c[k] = c.get(k, 0) + 1
        return c

    before_counts = verdicts(rows)

    # Condense anything that is not `fits`, not just `impossible`.
    #
    # Their server-side pass only targets `impossible`, so on a job where every
    # line came back `tight` nothing was condensed — and `tight` means, in their
    # own words, "audible speed-up and/or video slow-down". Intelligible, but you
    # hear it. Shortening those lines removes the speed-up entirely.
    #
    # The budget comes from the planner's OWN calibrated numbers: est_dur_s for a
    # line of known length yields this voice's real chars/second, which is
    # trustworthy here precisely because the render has already happened.
    # Never shorten a line below this fraction of what it started as.
    #
    # Without a floor this loop destroys the script. On a real job it condensed 16
    # of 18 lines, several to about 20% of their length:
    #   "Now all the tourist places will be completely empty." -> "All empty."
    #   "We'll take a cable car in Zhangjiajie city"           -> "Cable car."
    # Every line then reported `fits`, and the dub said almost nothing. A line that
    # is slightly rushed carries the meaning; a line cut to a fragment does not.
    keep_floor = float(os.environ.get("VS_CONDENSE_FLOOR", "0.6"))
    # How much predicted overrun is worth rewriting for. Condensing every `tight`
    # line was too aggressive: `tight` means a mild speed-up within the caps, which
    # is far less damaging than losing the sentence.
    act_over_s = float(os.environ.get("VS_CONDENSE_OVER_S", "0.5"))
    original = list(texts)

    # Judge overrun against the rate the audio actually measured, not the planner's
    # estimate of it.
    #
    # Their est_dur_s implied 6.6 chars/second where rendering real lines and timing
    # them gave 17.5. Every line therefore looked 2.6x too long, so almost every
    # line was rated impossible and rewritten: on one job 16 of 18 lines were cut,
    # several to about 20% ("Now all the tourist places will be completely empty."
    # -> "All empty."). The floor limited the damage but did not prevent it, because
    # the premise was wrong rather than the limit.
    #
    # available_s still comes from them: that is timeline arithmetic (slot plus
    # borrowable gap), which their planner does correctly and we do not duplicate.
    trust_cps = None
    if base_cps and base_cps > 0:
        trust_cps = cps_at_speed(base_cps, speed)

    for round_no in (1, 2):
        need = []
        for i, r in enumerate(rows):
            plan = r.get("plan") or {}
            status = str(plan.get("status") or "")
            est = float(plan.get("est_dur_s") or 0)
            avail = float(plan.get("available_s") or 0)
            t = texts[i]
            if est <= 0 or avail <= 0 or len(t) < 12:
                continue
            cps = len(t) / est
            if trust_cps:
                cps = trust_cps
                est = len(t) / trust_cps
                # Their "impossible" verdict inherits the same bad rate, so it
                # cannot be trusted on its own once we have measured the voice.
                status = "impossible" if est - avail >= act_over_s else "tight"
            overrun = est - avail
            # Act on genuinely unfittable lines, or a substantial overrun. Leave a
            # mildly tight line alone.
            if status != "impossible" and overrun < act_over_s:
                continue
            if cps < 1.0:            # not a credible rate; leave the line alone
                continue
            budget = max(10, int(avail * cps * 0.95))
            floor = int(len(original[i]) * keep_floor)
            if budget < floor:
                budget = floor       # do not cut past the meaning-preserving floor
            if budget < len(t):
                need.append({"i": i, "text": t, "budget": budget,
                             "seconds": round(avail, 2)})
        if not need:
            break
        if emit:
            emit("synthesize", 84,
                 f"Condensing {len(need)} line(s) that need audible speed-up "
                 f"(round {round_no})", device="Cloud")
        try:
            shorter = _condense_to_budget(need, target_lang, emit=emit)
        except Exception as e:
            if emit:
                emit("synthesize", 84, f"Condensation failed ({str(e)[:60]})")
            break
        applied = 0
        for i, new in shorter.items():
            if not (0 <= i < len(texts)) or not new:
                continue
            # Reject a rewrite that cut past the floor, however well it "fits".
            if len(new) < keep_floor * len(original[i]):
                continue
            if len(new) < len(texts[i]):
                texts[i] = new
                applied += 1
        if not applied:
            break
        again = classify(texts)
        if again is None:
            break
        rows = again

    # Record the rate the engine actually produced for THIS voice, so the caller
    # can set synthesis speed from a measurement rather than a constant. The
    # planner's est_dur_s is calibrated from segments this job already rendered,
    # so chars/est is the voice's real rate at the speed we used.
    if isinstance(out, dict):
        rates = []
        for r, t in zip(rows, texts):
            est = float((r.get("plan") or {}).get("est_dur_s") or 0)
            if est > 0.2 and len(t) >= 8:
                rates.append(len(t) / est)
        if rates:
            rates.sort()
            out["measured_cps"] = rates[len(rates) // 2]   # median

    after_counts = verdicts(rows)
    lines = ["VOICESTUDIO DURATION PLANNER (calibrated, with gap borrowing)",
             "",
             "'avail' is the slot PLUS silence borrowed from the gap to the next",
             "line (their GAP_BORROW_MAX_S = 3.0s). 'fits' means the line needs no",
             "audible speed-up; 'tight' means it is squeezed but within the caps.",
             "",
             f"{'#':>3} {'slot':>6} {'avail':>6} {'est':>6} {'verdict':>11} "
             f"{'chars':>5}  text"]
    changed = 0
    for i, (s, row) in enumerate(zip(segments, rows)):
        plan = row.get("plan") or {}
        status = str(plan.get("status") or "?")
        slot = float(s.get("end", 0)) - float(s.get("start", 0))
        avail = float(plan.get("available_s") or 0)
        est = float(plan.get("est_dur_s") or 0)
        # Record the planner's numbers on the segment so the final timing report
        # measures against AVAILABLE time (slot + borrowable gap) instead of the
        # raw slot. Comparing against the raw slot made the report claim 36.9s of
        # overrun on a job the planner rated fits=9, tight=2.
        s["available_s"] = avail
        s["planner_status"] = status
        s["planner_est_s"] = est
        original = payload[i]["text"]
        final = texts[i]
        lines.append(f"{i:>3} {slot:6.2f} {avail:6.2f} {est:6.2f} "
                     f"{status:>11} {len(final):5d}  {final[:60]}")
        if final != original:
            lines.append(f"      was {len(original)} chars: {original[:66]}")
            s["text"] = final
            changed += 1

    borrowed = sum(max(0.0, float((r.get("plan") or {}).get("available_s") or 0)
                       - (float(s.get("end", 0)) - float(s.get("start", 0))))
                   for s, r in zip(segments, rows))

    def fmt(c):
        return ", ".join(f"{k}={v}" for k, v in sorted(c.items()))

    lines += ["",
              f"verdicts before condensation: {fmt(before_counts)}",
              f"verdicts after  condensation: {fmt(after_counts)}",
              f"time recovered by borrowing from inter-sentence gaps: {borrowed:.2f}s",
              f"lines condensed: {changed}"]
    if emit:
        emit("synthesize", 86,
             f"Planner: {fmt(before_counts)} -> {fmt(after_counts)}; "
             f"borrowed {borrowed:.1f}s from gaps, condensed {changed}",
             device="Cloud")
    if artifact_text:
        artifact_text("\n".join(lines), "07_duration_planner.txt",
                      "Step 7: VoiceStudio duration planner verdicts + condensation")
    return changed


def _condense_to_budget(items, target_lang, emit=None):
    """Shorten lines to a hard character budget taken from the planner.

    items: [{"i", "text", "budget", "seconds"}] -> {i: shorter_text}

    Separate from rewrite_to_fit because the budget here is derived from the
    planner's calibrated estimate for this specific voice, so it must be treated
    as a hard limit rather than a hint.
    """
    from gemini_audio import LANG_NAME, call_lines_in_batches

    dst = LANG_NAME.get(target_lang, target_lang)

    def build(batch):
        return f"""These {dst} dubbing lines need to be spoken FASTER than natural to fit the time available, which makes the delivery sound rushed and artificial.

Rewrite each one so it can be said at a NORMAL, relaxed pace within `seconds` seconds. `budget` is a hard character limit measured from this specific voice's real speaking rate — going over it means the line gets sped up again.

Requirements:
- Keep the meaning and the tone. Dropping a descriptive word is fine; dropping the point is not.
- Cut politeness padding, intensifiers and filler ("very", "all the way", "actually", "right now", "currently", "we are going to get the chance to").
- Say it the short way a native {dst} speaker would say it out loud.
- Never add anything that is not already there. Keep names and numbers.
- Shorter than the budget is good.
- Return the SAME index for every line.

Return ONLY JSON: {{"lines":[{{"i":0,"dst":"..."}}]}}

Lines:
{json.dumps(batch, ensure_ascii=False)}"""

    return call_lines_in_batches(items, build, timeout=600, emit=emit)


# Merge adjacent lines of the same speaker separated by less than this. Derived
# from the ElevenLabs reference pair, whose gaps between utterance blocks are
# tight and uniform (median 0.38s, max 1.06s) — they keep real breaks and merge
# across everything shorter.
MERGE_GAP_S = float(os.environ.get("VS_MERGE_GAP_S", "0.9"))
# Longest merged block. Their median dub block is 15.5s and mean 15.5s, so long
# blocks are normal and are what gives a slow voice room.
MERGE_MAX_S = float(os.environ.get("VS_MERGE_MAX_S", "14.0"))


def merge_short_lines(segments, base_cps, speed, emit=None):
    """Merge adjacent same-speaker lines so each block can hold its own words.

    This is the fix for slots that cannot hold a clause at any sane rate. Measured
    against an ElevenLabs dub of comparable material:

        their dub blocks : median 15.48s, mean 15.54s, only 2 under 1.0s
        ours             : median  2.70s, mean  2.94s, 5 of 15 under 2.0s

    They dub at utterance scale; we were dubbing at fragment scale. At 14 chars/sec
    a 15s block holds about 217 characters, so phrasing is never constrained; a
    0.70s slot holds ten, so every line has to be rushed.

    Merging genuinely creates time, because the gap between two lines is absorbed
    into the merged span. That is the opposite of splitting, which subdivides a
    span and made compression worse (1.99x -> 3.18x when tried).

    A line is merged forward while all of these hold:
      * same speaker, so no character is ever blended into another
      * the gap is under MERGE_GAP_S, i.e. not a real pause
      * the result stays under MERGE_MAX_S
      * the merge does not itself create an over-long line for the voice's rate
    """
    if not segments:
        return segments, []
    cps = cps_at_speed(base_cps, speed)
    # Merging must not change the ROW COUNT. VoiceStudio maps a generate request onto
    # its stored segments positionally, so removing rows shifts every later line onto
    # a different slot; the last dub sent 140 rows against 144 stored and came back
    # with our text re-assembled on the original timeline. A merged-away row is
    # therefore kept and emptied: VoiceStudio writes silence for a segment with no
    # text, which is exactly right, and the positions stay aligned.
    out = [dict(segments[0])]
    notes = []
    for s in segments[1:]:
        prev = next((r for r in reversed(out) if (r.get("text") or "").strip()),
                    out[-1])
        gap = float(s.get("start", 0)) - float(prev.get("end", 0))
        same_speaker = (prev.get("speaker_id") == s.get("speaker_id")
                        and prev.get("profile_id") == s.get("profile_id"))
        merged_span = float(s.get("end", 0)) - float(prev.get("start", 0))
        merged_text = ((prev.get("text") or "").strip() + " "
                       + (s.get("text") or "").strip()).strip()
        # Only merge if the combined line still fits comfortably.
        fits_after = len(merged_text) <= merged_span * MAX_COMPRESSION * cps

        prev_short = (float(prev.get("end", 0))
                      - float(prev.get("start", 0))) * MAX_COMPRESSION * cps \
            < len((prev.get("text") or "").strip())
        this_short = (float(s.get("end", 0))
                      - float(s.get("start", 0))) * MAX_COMPRESSION * cps \
            < len((s.get("text") or "").strip())

        if (same_speaker and 0 <= gap <= MERGE_GAP_S
                and merged_span <= MERGE_MAX_S
                and (prev_short or this_short) and fits_after):
            notes.append(
                f"  merged {float(prev['start']):6.2f}-{float(prev['end']):6.2f} "
                f"+ {float(s['start']):6.2f}-{float(s['end']):6.2f} "
                f"(gap {gap:.2f}s) -> {merged_span:.2f}s, {len(merged_text)} chars")
            prev["end"] = float(s.get("end", 0))
            prev["text"] = merged_text
            prev.pop("available_s", None)   # the planner recomputes this
            # Keep the row, emptied, so positions still line up with the job.
            # Zero length, parked at the end of the merged span, so the silence it
            # stands for cannot overwrite the audio that absorbed it.
            empty = dict(s)
            empty["text"] = ""
            empty["start"] = empty["end"] = float(s.get("end", 0))
            out.append(empty)
            continue
        out.append(dict(s))

    if notes and emit:
        emit("synthesize", 86,
             f"Merged {len(notes)} short line(s) into longer blocks so the voice "
             f"has room", device="Cloud")
    return out, notes


def _split_text_parts(text, n):
    """Split text into n parts at the most natural boundaries available.

    Prefers sentence ends, then clause punctuation, then word gaps, so a split
    never lands mid-word and rarely mid-clause. Language-agnostic: it uses
    punctuation classes rather than any word list.
    """
    import re

    if n <= 1:
        return [text]
    # Candidate cut points, best first.
    for pattern in (r"(?<=[.!?\u0964\u06d4])\s+", r"(?<=[,;:\u060c])\s+", r"\s+"):
        pieces = re.split(pattern, text.strip())
        pieces = [p for p in pieces if p.strip()]
        if len(pieces) >= n:
            # Greedily group pieces into n parts of similar length.
            target = len(text) / n
            parts, cur = [], ""
            for p in pieces:
                if cur and len(cur) + len(p) > target and len(parts) < n - 1:
                    parts.append(cur.strip())
                    cur = p
                else:
                    cur = (cur + " " + p).strip() if cur else p
            if cur:
                parts.append(cur.strip())
            if len(parts) == n and all(parts):
                return parts
    return [text]


def split_overlong(segments, base_cps, speed, target_lang, emit=None):
    """Split an over-long line into parts across its own span.

    OFF BY DEFAULT (VS_SPLIT_LONG=1 to enable), because measurement showed it
    makes compression WORSE, not better.

    The reasoning that motivated it was wrong. Splitting subdivides a span; it does
    not create time. The same characters still have to be spoken inside the same
    total seconds, so the compression ratio is unchanged — and dropping
    `available_s` on the children discarded the gap time they had borrowed, which
    made it actively harmful. Measured on a real job: worst compression went from
    1.99x to 3.18x and lines above the cap from 2 to 10.

    It is kept only for the case it can genuinely help: a segment that spans a real
    pause, where the parts can be re-planned against separate gaps. That requires
    re-running the planner on the children, which the caller does not currently do.
    """
    import math

    if os.environ.get("VS_SPLIT_LONG", "0") != "1":
        return segments, []

    cps = cps_at_speed(base_cps, speed)
    out, notes = [], []
    for s in segments:
        text = (s.get("text") or "").strip()
        a = float(s.get("start", 0))
        b = float(s.get("end", 0))
        span = max(0.05, b - a)
        avail = float(s.get("available_s") or 0) or span
        allowed = avail * MAX_COMPRESSION * cps
        if not text or len(text) <= allowed:
            out.append(s)
            continue
        n = min(6, max(2, int(math.ceil(len(text) / max(allowed, 1.0)))))
        parts = _split_text_parts(text, n)
        if len(parts) < 2:
            out.append(s)          # nothing safe to split on; leave it alone
            continue
        total = sum(len(p) for p in parts) or 1
        cursor = a
        for p in parts:
            share = span * (len(p) / total)
            child = dict(s)
            child.pop("id", None)          # a new slot, not an existing render
            child.pop("available_s", None)  # recomputed by the planner
            child["start"] = round(cursor, 3)
            child["end"] = round(min(b, cursor + share), 3)
            child["text"] = p
            out.append(child)
            cursor += share
        notes.append(f"  {a:6.2f}-{b:6.2f} {len(text)} chars > allowance "
                     f"{allowed:.0f} -> {len(parts)} parts "
                     f"({', '.join(str(len(p)) for p in parts)} chars)")

    if notes and emit:
        emit("synthesize", 87,
             f"Split {len(notes)} over-long line(s) so they need no rushing",
             device="Cloud")
    return out, notes


def enforce_compression_cap(segments, base_cps, speed, target_lang, emit=None,
                            artifact_text=None):
    """Guarantee no line is compressed past MAX_COMPRESSION.

    This is the step that was missing. The order of levers matters, and each is
    tried before resorting to the next, because each costs more:

      1. faster synthesis   - free, no artefact (already applied via `speed`)
      2. borrowed gap time  - free, VoiceStudio's available_s already includes it
      3. shorter text       - costs meaning, so floored at VS_CONDENSE_FLOOR
      4. mild compression   - allowed only up to MAX_COMPRESSION

    Without step 4's ceiling the fitter compressed without limit and the delivered
    audio measured an effective 17-25 chars/second against a natural 14.
    """
    lines = [f"COMPRESSION CAP (max {MAX_COMPRESSION}x)",
             "",
             f"engine base rate {base_cps:.2f} chars/s at speed 1.0, "
             f"rendering at speed {speed:.2f} = "
             f"{cps_at_speed(base_cps, speed):.2f} chars/s",
             "",
             f"{'#':>3} {'avail':>6} {'needs':>6} {'ratio':>6} {'chars':>5}  verdict"]

    def ratio_of(s):
        avail = float(s.get("available_s") or 0) or (
            float(s.get("end", 0)) - float(s.get("start", 0)))
        need = natural_seconds(s.get("text"), base_cps, speed)
        return (need / avail if avail > 0.05 else 0.0), avail, need

    over = []
    for i, s in enumerate(segments):
        r, avail, need = ratio_of(s)
        if r > MAX_COMPRESSION:
            # Characters that WOULD fit inside the cap.
            budget = int(avail * MAX_COMPRESSION * cps_at_speed(base_cps, speed))
            over.append({"i": i, "text": (s.get("text") or "").strip(),
                         "budget": max(10, budget), "seconds": round(avail, 2)})

    if over:
        floor = float(os.environ.get("VS_CONDENSE_FLOOR", "0.6"))
        if emit:
            emit("synthesize", 87,
                 f"{len(over)} line(s) would be compressed past "
                 f"{MAX_COMPRESSION}x; shortening them instead", device="Cloud")
        for item in over:
            item["budget"] = max(item["budget"],
                                 int(len(item["text"]) * floor))
        try:
            shorter = _condense_to_budget(over, target_lang, emit=emit)
        except Exception as e:
            shorter = {}
            lines.append(f"  shortening failed: {str(e)[:80]}")
        for i, new in (shorter or {}).items():
            if 0 <= i < len(segments) and new:
                old = (segments[i].get("text") or "").strip()
                if floor * len(old) <= len(new) < len(old):
                    segments[i]["text"] = new

    worst = 0.0
    still = 0
    for i, s in enumerate(segments):
        r, avail, need = ratio_of(s)
        worst = max(worst, r)
        if r <= 1.02:
            v = "natural"
        elif r <= MAX_COMPRESSION:
            v = f"mild speed-up {r:.2f}x"
        else:
            v = f"STILL {r:.2f}x - will sound rushed"
            still += 1
        lines.append(f"{i:>3} {avail:6.2f} {need:6.2f} {r:6.2f} "
                     f"{len((s.get('text') or '')):5d}  {v}")

    lines += ["",
              f"worst compression after correction: {worst:.2f}x",
              f"lines still above the {MAX_COMPRESSION}x cap: {still}"]
    if emit:
        emit("synthesize", 87,
             f"Compression: worst {worst:.2f}x, {still} line(s) still above "
             f"{MAX_COMPRESSION}x", device="Cloud")
    if artifact_text:
        artifact_text("\n".join(lines), "11_compression.txt",
                      "Step 11: compression cap and what it required")
    return worst, still


# A line using less than this share of its slot leaves audible silence over a
# mouth that is still moving. Measured on the first full run of this pipeline: the
# character budget is seeded from the LANGUAGE's natural human rate (Telugu 10.5
# chars/s x 1.15 headroom = 12.1) while the cloned voice actually delivered 23.68
# chars/s, so every line was written at roughly half the words it had room for.
# The dub then covered 312s of the original's 537s of speech - 0.58x - with 165s
# in 53 stretches where the speaker is talking and the dub says nothing. The same
# video through VoiceStudio's own UI covered 0.95x with no such stretch, so this is
# our defect, not the engine's.
#
# 0.75 rather than something tighter because a real translation legitimately runs
# shorter than its slot sometimes, and expanding a line that does not need it is
# how padding gets in.
UNDERFILL_RATIO = float(os.environ.get("VS_UNDERFILL_RATIO", "0.75"))
# What an expanded line should aim to fill. Short of 1.0 so the expansion cannot
# create the overrun that truncation comes from.
UNDERFILL_TARGET = float(os.environ.get("VS_UNDERFILL_TARGET", "0.92"))
# Slots too short to be worth expanding: at any rate these hold a word or two.
UNDERFILL_MIN_SLOT_S = float(os.environ.get("VS_UNDERFILL_MIN_SLOT_S", "1.2"))


def expand_underfilled(segments, base_cps, speed, target_lang, emit=None,
                       artifact_text=None, source_lang=None):
    """Lengthen lines that finish well before their slot ends.

    The mirror image of enforce_compression_cap, and it has to run at the same
    point for the same reason: only after the first render is the voice's real rate
    known. Before that the budget is a guess from a language constant, and on this
    engine that guess was 2x slow.

    Expansion is asked for as natural fuller phrasing (expand_to_fit), never as
    padding, and a rewrite is accepted only when it is longer than the original AND
    still inside the compression cap, so a bad answer leaves the line alone.
    """
    from gemini_audio import expand_to_fit, translate_at_budget

    cps = cps_at_speed(base_cps, speed)

    def avail_of(s):
        return float(s.get("available_s") or 0) or (
            float(s.get("end", 0)) - float(s.get("start", 0)))

    under = []
    for i, s in enumerate(segments):
        avail = avail_of(s)
        text = (s.get("text") or "").strip()
        if avail < UNDERFILL_MIN_SLOT_S or not text:
            continue
        if natural_seconds(text, base_cps, speed) / avail < UNDERFILL_RATIO:
            src = (s.get("source_text") or "").strip()
            budget = int(avail * UNDERFILL_TARGET * cps)
            # Same honesty cap as the first translation: fill the slot where the
            # speaker gave us words to work with, never past what he said.
            if src:
                budget = min(budget, max(len(src),
                                         int(len(src) * SRC_EXPANSION_MAX)))
            under.append({"i": i, "seconds": round(avail, 2),
                          "budget": max(6, budget), "dst": text, "src": src})
    if not under:
        return 0, []

    # Retranslate from the source where we still have it, and only pad where we do
    # not. Padding a translation invents content, which is how a dub stops matching
    # the picture; translating the source again to the corrected budget says the same
    # thing more fully.
    retrans = [it for it in under if it["src"]]
    pad_only = [it for it in under if not it["src"]]
    if emit:
        emit("synthesize", 86,
             f"{len(under)} line(s) finish early and leave silence; "
             f"retranslating {len(retrans)} from the source"
             + (f", lengthening {len(pad_only)}" if pad_only else ""),
             device="Cloud")
    longer = {}
    try:
        if retrans:
            longer.update(translate_at_budget(retrans, source_lang, target_lang,
                                              emit=emit))
        if pad_only:
            longer.update(expand_to_fit(pad_only, target_lang))
    except Exception as e:
        if emit:
            emit("synthesize", 86, f"Expansion skipped ({str(e)[:70]})")
        return 0, []

    notes, changed = [], 0
    for item in under:
        i = item["i"]
        new = (longer or {}).get(i)
        old = (segments[i].get("text") or "").strip()
        if not new or len(new) <= len(old):
            continue
        avail = avail_of(segments[i])
        # Never expand past what the slot can hold at the cap, or we trade silence
        # for the truncation this whole exercise is about.
        if len(new) > avail * MAX_COMPRESSION * cps:
            continue
        notes.append(f"  #{i:<4} slot {avail:5.2f}s  {len(old):3d} -> "
                     f"{len(new):3d} chars  "
                     f"({natural_seconds(old, base_cps, speed)/avail:.2f}x -> "
                     f"{natural_seconds(new, base_cps, speed)/avail:.2f}x)")
        segments[i]["text"] = new
        changed += 1

    if artifact_text and notes:
        artifact_text(
            "LINES LENGTHENED TO FILL THEIR SLOT\n\n"
            f"The budget used for translation assumes {target_rate_for(target_lang)}"
            f" chars/s, the natural human rate for this language.\n"
            f"This voice measured {base_cps:.2f} chars/s, so the budget asked for "
            f"about half the words each slot could hold.\n"
            f"Silence over a moving mouth is what that sounds like.\n\n"
            + "\n".join(notes) + "\n",
            "09b_expanded.txt",
            "Step 9b: lines lengthened so the dub covers the speech")
    if emit:
        emit("synthesize", 86,
             f"Lengthened {changed} of {len(under)} short line(s)",
             device="Cloud")
    return changed, notes


# How much longer than its natural speaking time a slot may be before the engine is
# told to fill it.
#
# This is the fix for original-language speech appearing inside the dub. Under
# strict_slot the engine hands the SLOT length to the TTS as a target duration:
#
#     _dur_for_tts = seg_duration if strategy == "strict_slot" else None
#     backend.generate(..., duration=dur_s, ...)
#
# An F5-style model given more time than the text needs has to fill it, and what it
# fills with is the audio it was conditioned on - here 17 seconds of Hindi reference.
# Rendering the same real lines three ways through preview-segment, which takes the
# same duration parameter, separated it cleanly:
#
#     duration omitted        Hindi in 0 of 5 renders
#     duration = slot         Hindi in 1 of 5
#     duration = 2x natural   Hindi in 5 of 5
#
# and the Hindi was always the same words, the tail of that speaker's reference text.
# It is stochastic rather than a threshold, so the ceiling sits below the surplus that
# produced it: echoes appeared at ratios of 2.0 and above and not at 1.48 or 1.59.
#
# 1.50 rather than something tighter because the rate is a job-wide average and a
# single line varies around it: a line of long words runs slower than the average, and
# trimming its slot below what it needs means strict_slot cuts the end off a real word.
# Trimming too little only leaves a pause. Cutting words is the worse failure, so the
# ceiling sits between the two: clear of the ~2x where echoes appeared, clear of the
# per-line spread below.
SLOT_SURPLUS_MAX = float(os.environ.get("VS_SLOT_SURPLUS_MAX", "1.50"))
# What an over-long slot is trimmed back to. Above 1.0 so the voice is not forced to
# rush, below the ceiling so a sampling wobble cannot cross it.
SLOT_SURPLUS_TARGET = float(os.environ.get("VS_SLOT_SURPLUS_TARGET", "1.25"))
# Never trim a slot below this: very short lines measure unreliably.
SLOT_MIN_S = float(os.environ.get("VS_SLOT_MIN_S", "0.35"))


def fit_slots_to_text(segments, base_cps, speed, emit=None,
                      artifact_text=None):
    """Shorten a slot that its line cannot fill, so nothing has to be invented.

    Runs LAST, after every text change, because it is the text's final length that
    decides how much time the engine will be asked to fill.

    Only the END of a slot moves. Each line still starts exactly where the original
    speaker started, so sync is untouched; the time given back becomes silence, which
    is what a pause in the original sounds like and is a great deal better than the
    engine reciting its Hindi reference to use the time up.
    """
    cps = cps_at_speed(base_cps, speed)
    notes = []
    trimmed = 0
    for i, s in enumerate(segments):
        start, end = float(s.get("start", 0)), float(s.get("end", 0))
        slot = end - start
        text = (s.get("text") or "").strip()
        if slot <= SLOT_MIN_S or not text:
            continue
        need = natural_seconds(text, base_cps, speed)
        if need <= 0:
            continue
        if slot / need <= SLOT_SURPLUS_MAX:
            continue
        new_slot = max(SLOT_MIN_S, min(slot, need * SLOT_SURPLUS_TARGET))
        if slot - new_slot < 0.05:
            continue
        notes.append(f"  #{i:<4} {start:7.2f}s  slot {slot:5.2f}s -> "
                     f"{new_slot:5.2f}s  ({len(text):3d} chars need "
                     f"{need:4.2f}s, surplus {slot/need:4.2f}x -> "
                     f"{new_slot/need:4.2f}x)")
        s["end"] = start + new_slot
        s.pop("available_s", None)      # borrowed gap time no longer applies
        trimmed += 1

    if artifact_text and notes:
        artifact_text(
            "SLOTS TRIMMED TO WHAT THEIR LINE CAN FILL\n\n"
            "Under strict_slot the engine is given the slot length as a target\n"
            "duration for synthesis. Asked to fill much more time than the words\n"
            "need, the model fills the surplus with the reference audio it was\n"
            "conditioned on, which is the ORIGINAL language. Measured on real lines:\n"
            "Hindi appeared in 0 of 5 renders at natural length, 1 of 5 at the slot\n"
            "length, and 5 of 5 at twice natural length.\n\n"
            f"Ceiling {SLOT_SURPLUS_MAX}x, trimmed back to {SLOT_SURPLUS_TARGET}x.\n"
            "Only the end of a slot moves, so every line still starts on time.\n\n"
            + "\n".join(notes) + "\n",
            "09c_slot_trim.txt",
            "Step 9c: slots trimmed so the engine is never asked to invent audio")
    if emit:
        worst = max((float(s.get("end", 0)) - float(s.get("start", 0)))
                    / max(natural_seconds(s.get("text"), base_cps, speed), 1e-6)
                    for s in segments if (s.get("text") or "").strip()) \
            if segments else 0.0
        emit("synthesize", 87,
             f"Trimmed {trimmed} over-long slot(s); worst surplus now "
             f"{worst:.2f}x (echo risk starts near 2x)", device="Cloud")
    return trimmed, notes


def refit_after_render(job_id, segments, target_lang, emit=None,
                       over_tol=1.06, under_tol=0.90, out=None):
    """Correct line lengths using the speaking rate each voice actually used.

    One extra render. Lines that overran get shortened, lines that finished early
    get lengthened, both to a character count derived from that speaker's own
    measured pace rather than a language-wide guess.

    Returns the number of lines changed.
    """
    from gemini_audio import CHARS_PER_SEC, expand_to_fit, rewrite_to_fit

    durations, kind = natural_durations(job_id, target_lang, len(segments))
    if not any(durations):
        if emit:
            emit("synthesize", 80, "Could not read rendered clips; skipping refit")
        return 0
    if emit:
        emit("synthesize", 80, f"Using {kind} durations to judge fit",
             device="Cloud")

    rates, mean_rate = calibrate_rates(
        segments, durations, CHARS_PER_SEC.get(target_lang, 11.0))
    if emit and rates:
        emit("synthesize", 81,
             "Measured speaking rates: "
             + ", ".join(f"{k.split(':')[-1]}={v:.1f}c/s"
                         for k, v in sorted(rates.items()))[:110],
             device="Cloud")
    too_long, too_short = [], []
    for i, (seg, dur) in enumerate(zip(segments, durations)):
        text = (seg.get("text") or "").strip()
        slot = float(seg.get("end", 0)) - float(seg.get("start", 0))
        if not dur or slot <= 0.2 or len(text) < 4:
            continue
        rate = rates.get(_speaker_key(seg), mean_rate)
        # How many characters this particular voice can say in this slot.
        budget = max(4, int(slot * rate))
        item = {"i": i, "seconds": round(slot, 2), "budget": budget, "dst": text}
        if dur > slot * over_tol:
            too_long.append(item)
        elif dur < slot * under_tol:
            too_short.append(item)

    # Hand the measurements to the caller so the alignment report can use real
    # numbers instead of re-reading values the final render leaves stale.
    if isinstance(out, dict):
        out["durations"], out["rates"] = durations, rates

    if not too_long and not too_short:
        if emit:
            emit("synthesize", 82, "All lines fit their slots", device="Cloud")
        return 0

    if emit:
        emit("synthesize", 82,
             f"Refitting {len(too_long)} overrunning and {len(too_short)} "
             f"short line(s) to each voice's real pace", device="Cloud")

    changed = 0
    for items, fn in ((too_long, rewrite_to_fit), (too_short, expand_to_fit)):
        if not items:
            continue
        try:
            fixed = fn(items, target_lang) or {}
        except Exception:
            continue
        for i, new in fixed.items():
            new = (new or "").strip()
            if new and 0 <= i < len(segments) and new != segments[i].get("text"):
                segments[i]["text"] = new
                changed += 1
    return changed


def alignment_report(job_id, segments, target_lang="und", source_wav=None,
                     measured=None, rates=None):
    """Line-by-line comparison of the ORIGINAL timeline against the dub.

    Built because "it is out of sync" is not actionable. For every line this says
    where the dub sits relative to the original speech, how much it drifts, and
    whether the cause is a gap, a slow delivery or an overrun — and it accumulates
    the drift so progressive lateness is visible.
    """
    # `measured` is what the measuring render actually produced, before any text
    # correction. It must be passed in: VoiceStudio only recomputes natural
    # durations when it builds a fit plan, so after the final strict_slot render
    # the stored values still describe the OLD text and reading them back makes
    # the report describe audio that is no longer there.
    # Prefer the planner's own estimate for the FINAL text. Anything else is
    # stale: seg_natural_durs_by_lang describes the text as it was during the
    # measuring render, before condensation rewrote it, so reporting it made the
    # report claim 34.5s of overrun on a job the planner rated fits=10, tight=2.
    planner_est = [s.get("planner_est_s") for s in segments]
    if any(planner_est):
        durations = [float(d) if d else None for d in planner_est]
        kind = "planner estimate for the final text"
    else:
        durations = measured
        kind = "measured before correction"
        if not durations or not any(durations):
            durations, kind = natural_durations(job_id, target_lang,
                                                len(segments))
    basis = ("available time = slot + borrowable gap"
             if any(s.get("available_s") for s in segments) else "raw slot")
    lines = [f"ORIGINAL vs DUB, line by line  ({kind}, measured against {basis})",
             "",
             f"{'#':>3} {'orig start':>10} {'orig end':>9} {'slot':>6} "
             f"{'dub len':>8} {'diff':>7} {'drift':>7}  verdict",
             "-" * 78]
    drift = 0.0
    worst_late = 0.0
    total_gap = total_over = 0.0
    for i, (s, d) in enumerate(zip(segments, durations)):
        a = float(s.get("start", 0))
        b = float(s.get("end", 0))
        raw = b - a
        # Two DIFFERENT yardsticks, which is the distinction I got wrong before:
        #
        #   overrun is measured against AVAILABLE time (slot + borrowable pause,
        #   their GAP_BORROW_MAX_S = 3.0s), because running into the following
        #   pause is allowed and is not a defect.
        #
        #   a gap is measured against the line's OWN slot, never against available
        #   time. Available time is a ceiling, not a target: a line that ends
        #   before the ceiling is fine, and the remainder is the speaker's original
        #   pause, which must stay. Measuring shortfall against the ceiling
        #   reported 20.3s of "gaps" on a job the planner rated fits=8, tight=3.
        avail = float(s.get("available_s") or 0) or raw
        if not d:
            lines.append(f"{i:>3} {a:10.2f} {b:9.2f} {raw:6.2f} "
                         f"{'--':>8} {'--':>7} {'--':>7}  not rendered")
            continue
        over = d - avail
        short = raw - d
        drift += max(0.0, over)
        if over > 0.05:
            total_over += over
            verdict = f"OVERRUNS available time by {over:.2f}s"
            worst_late = max(worst_late, over)
        elif short > 0.35:
            total_gap += short
            verdict = f"ends {short:.2f}s before its slot (natural pause)"
        else:
            verdict = "fits"
        status = s.get("planner_status")
        if status:
            verdict = f"[{status}] {verdict}"
        lines.append(f"{i:>3} {a:10.2f} {b:9.2f} {raw:6.2f} "
                     f"{d:8.2f} {over:+7.2f} {drift:+7.2f}  {verdict}")

    src_dur = None
    if source_wav and os.path.exists(source_wav):
        try:
            import soundfile as sf
            info = sf.info(source_wav)
            src_dur = info.frames / float(info.samplerate)
        except Exception:
            pass

    lines += [
        "-" * 78,
        f"total overrun beyond available time : {total_over:.2f}s   "
        f"(this is the number that matters)",
        f"worst single overrun                : {worst_late:.2f}s",
        f"total time lines end before their own slot: {total_gap:.2f}s   "
        f"(mostly the speaker's original pauses, not a defect)",
    ]

    # What the text correction is predicted to achieve, using each voice's
    # measured speaking rate. Predicted rather than measured, because the final
    # render does not report natural durations again.
    if rates:
        lines += ["", "AFTER text correction (predicted from each voice's "
                      "measured pace)",
                  f"{'#':>3} {'slot':>6} {'pred':>6} {'diff':>7} "
                  f"{'chars':>5} {'c/s':>5}  speaker"]
        g2 = o2 = 0.0
        mean_rate = sum(rates.values()) / len(rates)
        for i, s in enumerate(segments):
            slot = float(s.get("end", 0)) - float(s.get("start", 0))
            n = len((s.get("text") or "").strip())
            rate = rates.get(_speaker_key(s), mean_rate)
            pred = n / rate if rate else 0.0
            diff = pred - slot
            if diff > 0:
                o2 += diff
            elif diff < -0.35:
                g2 += -diff
            lines.append(f"{i:>3} {slot:6.2f} {pred:6.2f} {diff:+7.2f} "
                         f"{n:5d} {rate:5.1f}  {s.get('speaker_id')}")
        lines += [f"predicted gap {g2:.2f}s, predicted overrun {o2:.2f}s "
                  f"(was gap {total_gap:.2f}s, overrun {total_over:.2f}s)"]
    if src_dur:
        last = max((float(s.get("end", 0)) for s in segments), default=0)
        lines.append(f"source audio {src_dur:.2f}s, last line ends {last:.2f}s")
    lines += [
        "",
        "Timing policy: " + TIMING_STRATEGY +
        f", overflow budget {OVERFLOW_BUDGET_S}s, "
        f"video retime {'on' if ALLOW_VIDEO_RETIME else 'OFF'}.",
        "With strict_slot every line stays on its original timestamp, so an",
        "overrun is compressed within the rate cap instead of pushing the",
        "following lines late.",
    ]
    return "\n".join(lines), {"gap": total_gap, "over": total_over}


def wait_render(job_id, timeout=7200, emit=None, poll=6):
    """Poll until the job actually has rendered audio tracks.

    The task SSE stream frequently yields no events for dub generation, so
    relying on it caused us to download the ORIGINAL video before synthesis had
    finished (the "dub" then measured identical to the source, which looked like
    cloning had silently stopped working). Polling for real output is reliable.
    """
    import time
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            tracks = _req(f"/dub/tracks/{job_id}", timeout=120)
            if tracks and tracks.get("tracks"):
                return tracks
        except Exception:
            pass
        if emit:
            emit("synthesize", 78,
                 f"VoiceStudio rendering ({int(time.time()-t0)}s)",
                 device="Cloud")
        time.sleep(poll)
    raise RuntimeError("VoiceStudio render timed out")


def wait_task(task_id, label="task", timeout=7200, emit=None, pct=70):
    """Follow a task's SSE stream until it finishes."""
    if not task_id:
        return None
    t0 = time.time()
    last = ""
    try:
        with urllib.request.urlopen(f"{BASE}/tasks/stream/{task_id}",
                                    timeout=timeout) as r:
            for line in r:
                s = line.decode("utf-8", "replace").strip()
                if not s.startswith("data:"):
                    continue
                try:
                    ev = json.loads(s[5:].strip())
                except Exception:
                    continue
                st = str(ev.get("status") or ev.get("state") or "")
                msg = str(ev.get("message") or ev.get("stage") or "")[:70]
                cur = f"{st} {msg}"
                if cur != last and emit:
                    emit("synthesize", pct, f"{label}: {msg or st}",
                         device="Cloud")
                    last = cur
                if st.lower() in ("completed", "done", "success",
                                  "failed", "error"):
                    return ev
    except Exception:
        pass
    return None


def qc(job_id, drift_threshold=0.3, timeout=1800):
    try:
        return _req(f"/dub/qc/{job_id}?drift_threshold={drift_threshold}",
                    data=None, method="POST", timeout=timeout)
    except Exception as e:
        return {"error": str(e)}


def list_tracks(job_id, timeout=120):
    """Language codes of the rendered dub tracks for this job."""
    try:
        return list((_req(f"/dub/tracks/{job_id}", timeout=timeout)
                     .get("tracks") or {}).keys())
    except Exception:
        return []


def download(job_id, out_path, preserve_bg=True, lang=None, timeout=3600):
    """Fetch the finished dubbed video (keeping the original background audio).

    `default_track`/`include_tracks` MUST be supplied. Without them the endpoint
    returns the video with its ORIGINAL audio, which is what made a working dub
    look like cloning had failed — the "dubbed" file measured byte-for-byte
    identical to the source.
    """
    # Refuse to download without naming a track.
    #
    # Omitting default_track/include_tracks does NOT fail — the endpoint quietly
    # returns the video with its ORIGINAL audio. That is exactly what shipped: a
    # delivered file containing the source speaker in the source language, while
    # every artifact reported a clean run. Silently handing back the original is
    # the worst possible outcome, so this now retries and then raises.
    if lang is None:
        tracks = []
        for attempt in range(3):
            tracks = list_tracks(job_id)
            if tracks:
                break
            time.sleep(4)
        lang = tracks[0] if tracks else None
    if not lang:
        raise RuntimeError(
            "VoiceStudio reports no rendered dub track for this job, so the only "
            "thing it can return is the ORIGINAL audio. Refusing to pass that off "
            "as a dub. The render did not complete."
        )

    q = (f"?preserve_bg={'true' if preserve_bg else 'false'}"
         f"&default_track={lang}&include_tracks={lang}")
    req = urllib.request.Request(BASE + f"/dub/download/{job_id}{q}",
                                 method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r, \
            open(out_path, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    return out_path


def extract_audio(video_path, out_wav):
    """Pull a mono 16 kHz wav out of the video for the Gemini audio pass."""
    import subprocess
    ff = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "ffmpeg7", "ffmpeg-n7.1-latest-win64-gpl-shared-7.1", "bin", "ffmpeg.exe")
    if not os.path.exists(ff):
        ff = "ffmpeg"
    subprocess.run([ff, "-y", "-i", video_path, "-vn", "-ac", "1",
                    "-ar", "16000", out_wav],
                   capture_output=True, check=True)
    return out_wav


def script_with_gemini_audio(video_path, source_lang, target_lang, work_dir,
                             emit=None):
    """Build the whole dubbing script by having Gemini LISTEN to the audio.

    This replaces VoiceStudio's ASR because its ASR was silently dropping the
    second half of the material: on a 20.2s clip it returned 3 segments ending
    at 11.24s, so the dub had 7 seconds of dead air (speech coverage 56%). The
    Gemini audio pass returns lines across the whole timeline, with speaker ids,
    gender, delivery notes and a length-budgeted translation.
    """
    from gemini_audio import build_script

    wav = os.path.join(work_dir, "vs_src_audio.wav")
    extract_audio(video_path, wav)
    if emit:
        emit("transcribe", 35,
             "Gemini listening to full audio (transcribe + translate)",
             device="Cloud")
    segs, detected, speakers, report = build_script(
        wav, source_lang, target_lang, emit=emit)

    # VoiceStudio speaks segment["text"], so put the TRANSLATION there and pass
    # the delivery note through as its per-segment `instruct`.
    for s in segs:
        s["source_text"] = s.get("text", "")
        s["text"] = (s.get("translated") or "").strip()
        s["instruct"] = (s.get("emotion") or "").strip()
    return segs, detected, report


def delete_job(job_id):
    """Remove a job from VoiceStudio's history (used to clear stale records)."""
    try:
        _req(f"/dub/history/{job_id}", method="DELETE", timeout=120)
        return True
    except Exception:
        return False


# Speaker-count hint for diarization. Left unset, pyannote auto-detects, and
# VoiceStudio's own source warns that its auto-detect "can collapse a
# multi-speaker clip to a single speaker (issue #274)".
#
# Measured on a 547s multi-character video by running pyannote directly at several
# forced counts (_sweep_speakers.sh):
#     auto -> 4 speakers, busiest holds 81% of speech (438s)
#     6    -> 6 speakers, busiest 73%
#     8    -> 8 speakers, busiest 73%, every speaker still >= 5s so all clonable
#     12   -> pyannote itself capped at 9 clusters and warned
# The dominant narrator was real at every setting, so auto was not simply wrong.
# What auto got wrong was the tail: it crushed the other voices into 3 groups and
# attributed about 43s of other people's speech to the narrator, which contaminates
# his clone reference with someone else's voice.
#
# Deliberately left at auto by default. Over-asking is NOT safely generic: forcing
# 8 on a genuine monologue would split one person across 8 clones and the voice
# would drift line to line. Set this per video when the cast size is known.
NUM_SPEAKERS = (int(os.environ["VS_NUM_SPEAKERS"])
                if os.environ.get("VS_NUM_SPEAKERS", "").strip().isdigit()
                else None)


def dub_video(video_path, out_path, source_lang, target_lang,
              num_speakers=None, emit=None, artifact_text=None,
              artifact_file=None):
    """Full VoiceStudio dub with Gemini translation. Returns out_path."""
    if num_speakers is None:
        num_speakers = NUM_SPEAKERS
    if emit:
        h = health()
        emit("start", 5,
             f"VoiceStudio {h.get('version','?')} on {h.get('device','?')}",
             device="Cloud")

    # Resume an existing job instead of uploading again.
    #
    # Transcription is by far the most expensive stage: VoiceStudio runs the ASR
    # once per segment to build each reference's text, which on a 9 minute video
    # with 146 segments took about 50 minutes of wall clock. If a run dies after
    # that (a dropped stream, a competing job on the same GPU, a local crash),
    # re-uploading throws all of it away, because upload() deliberately requests a
    # fresh job id every time.
    #
    # With VS_JOB_ID set we reuse the stored transcript, which already carries the
    # per-segment profile_id values and the speaker_clones the cloner needs, and go
    # straight to translation and rendering.
    # Reuse a transcript we saved ourselves on an earlier run of this video. Skips
    # upload and transcription and goes straight to translation and rendering, using
    # the job's existing audio and speaker clones on the server.
    resume_snapshot = None
    snap_path = (os.environ.get("VS_TRANSCRIPT_FILE") or "").strip()
    if snap_path and os.path.exists(snap_path) \
            and os.environ.get("VS_USE_TRANSCRIPT", "1") == "1":
        with open(snap_path, encoding="utf-8") as f:
            resume_snapshot = json.load(f)

    resume = (os.environ.get("VS_JOB_ID") or "").strip()
    if resume_snapshot:
        job_id = resume_snapshot.get("job_id") or resume
        segs_existing = resume_snapshot.get("segments") or []
        if not job_id or not segs_existing:
            raise RuntimeError(f"{snap_path} has no job_id or no segments")
        if emit:
            cloned = sum(1 for s in segs_existing if s.get("profile_id"))
            emit("transcribe", 35,
                 f"Reusing our saved transcript for job {job_id}: "
                 f"{len(segs_existing)} segments, {cloned} with a cloned voice "
                 f"profile", device="Cloud")
    elif resume:
        job_id = resume
        segs_existing = existing_segments(job_id)
        if not segs_existing:
            raise RuntimeError(
                f"VS_JOB_ID={job_id} has no stored transcript to resume from")
        # Resume from the ORIGINAL transcript, not from what was last synthesized.
        #
        # `text` is whatever the previous generate() call sent, so on a job that has
        # already been dubbed it holds the TARGET language. Reading it as the source
        # translated Telugu into Telugu: every one of 144 lines came back Telugu,
        # meaning drifted line by line, and the delivered dub stopped matching the
        # picture. VoiceStudio keeps the real source alongside it in
        # `text_original`, which is what a resume has to use.
        # Refuse to resume a job that has already been dubbed.
        #
        # Restoring text_original is not enough. After a dub, VoiceStudio has
        # re-synced its stored rows from that generate request, so the rows carry OUR
        # slot boundaries with whatever source text overlapped them - one job came back
        # with a 17.0s slot whose text_original was the fragment "ये तो बस गुल्ला है! और".
        # Translating that gives a slot holding one short line, and an F5-style model
        # asked to fill a slot far longer than its words fills the surplus with the
        # reference audio it was conditioned on, so the original language ends up
        # audible in the dub. Resume is for a job that stopped BEFORE rendering.
        dubbed = [s for s in segs_existing
                  if (s.get("text_original") or "").strip()
                  and (s.get("text") or "").strip()
                  and s["text"].strip() != s["text_original"].strip()]
        if len(dubbed) > len(segs_existing) // 4 and \
                os.environ.get("VS_RESUME_FORCE") != "1":
            raise RuntimeError(
                f"job {job_id} has already been dubbed ({len(dubbed)} of "
                f"{len(segs_existing)} segments hold target-language text), so its "
                f"stored transcript no longer lines up with its slots. Resume only a "
                f"job that stopped before rendering; upload again for a fresh one. "
                f"Set VS_RESUME_FORCE=1 to override.")
        restored = 0
        for s in segs_existing:
            orig = (s.get("text_original") or "").strip()
            if orig and orig != (s.get("text") or "").strip():
                s["text"] = orig
                restored += 1
        if emit:
            cloned = sum(1 for s in segs_existing if s.get("profile_id"))
            emit("transcribe", 35,
                 f"Resuming job {job_id}: {len(segs_existing)} stored segments, "
                 f"{cloned} with a cloned voice profile"
                 + (f"; restored {restored} line(s) to their original source text"
                    if restored else ""), device="Cloud")
    else:
        job_id, _ = upload(video_path)
        if not job_id:
            raise RuntimeError("VoiceStudio upload returned no job_id")
        wait_prep(job_id, emit=emit)

    work_dir = os.path.dirname(os.path.abspath(out_path)) or "."

    # Warn loudly if diarization is off: VoiceStudio then labels every turn
    # "Speaker 1", skips auto voice cloning ("speaker labels are gap-based
    # estimates"), and dubs the whole video in one default voice.
    diag = diarization_ready()
    if emit and not diag["ready"]:
        emit("transcribe", 34,
             "WARNING: speaker diarization is OFF (no HuggingFace token) - all "
             "characters will share ONE voice. Run setup_diarization.ps1 to "
             "enable per-speaker cloning.", device="Cloud")

    # ALWAYS use VoiceStudio's own transcribe. Besides the segments, it extracts
    # the per-speaker voice profiles that its cloner needs; skipping it leaves
    # no profiles and the dub loses the speakers' voices entirely.
    segs = (segs_existing if (resume or resume_snapshot)
            else transcribe(job_id, num_speakers=num_speakers, emit=emit))
    resume = resume or bool(resume_snapshot)
    if not segs and resume:
        raise RuntimeError(f"VS_JOB_ID={job_id} produced no segments")

    # Snapshot the transcript as OUR OWN record, and reuse it when asked to.
    #
    # Transcription costs about 50 minutes on a 9 minute video, because VoiceStudio
    # runs the ASR once per segment to build each reference's text. That made every
    # iteration on the stages AFTER transcription cost an hour, and the obvious
    # shortcut - resuming the job - is unsafe: a dubbed job's stored rows have been
    # re-synced to the last request, so its transcript no longer lines up with its
    # slots. A snapshot of what transcription produced has neither problem.
    snap = (os.environ.get("VS_TRANSCRIPT_FILE") or "").strip()
    if snap and not resume_snapshot:
        try:
            with open(snap, "w", encoding="utf-8") as f:
                json.dump({"job_id": job_id, "segments": segs}, f,
                          ensure_ascii=False)
            if emit:
                emit("transcribe", 38, f"Transcript saved to {snap}",
                     device="Cloud")
        except OSError as e:
            if emit:
                emit("transcribe", 38, f"Could not save the transcript: {e}")
    if not segs:
        # VoiceStudio de-duplicates by file CONTENT, so an identical upload maps
        # back to an earlier job. If that job's working files were cleaned up
        # (e.g. the container was recreated) it answers 409 with no transcript.
        # Clear the stale record and start the job fresh.
        if emit:
            emit("transcribe", 38,
                 "Stale job record found; clearing it and re-uploading",
                 device="Cloud")
        delete_job(job_id)
        job_id, _ = upload(video_path)
        wait_prep(job_id, emit=emit)
        segs = transcribe(job_id, num_speakers=num_speakers, emit=emit)
    if not segs:
        raise RuntimeError("VoiceStudio produced no segments")

    # Recover dialogue VoiceStudio's ASR never transcribed. Must run before
    # anything else, since a missing line is silence no amount of timing work can
    # fix.
    # Name the extracted audio after THIS job, and always re-extract.
    #
    # It used to be a fixed "vs_src_audio.wav" in the output directory, written only
    # when absent. That silently poisoned every audio-based check in this stage: a run
    # picked up a 20-second file left behind by a different video days earlier, so the
    # gap finder reported 1.1s of missing speech on a 9-minute video and the
    # thin-stretch repair compared the transcript against 20 seconds of unrelated
    # audio and found nothing to fix. Re-extracting costs about two seconds.
    wav = os.path.join(work_dir, f"vs_src_audio_{job_id}.wav")
    gap_notes = []
    asr_notes = []
    try:
        extract_audio(video_path, wav)
        # Replace the transcript outright when it is too sparse to be believed.
        # Measured 3.01 chars/sec of speech against an expected 10.5 on a real
        # video: about 70% of the words were missing, which sizes every slot for a
        # fragment and makes correct translations overflow.
        segs, asr_notes = rebuild_transcript_with_gemini(
            segs, wav, source_lang, emit=emit)
        # Then fill any residual holes.
        segs, gap_notes = fill_transcript_gaps(segs, wav, source_lang, emit=emit)
        # Then repair stretches that ARE covered but are missing words. The two passes
        # above only fire on holes and on a poor whole-file average, and neither sees a
        # recogniser that is fine for most of a video and drops a third of the words in
        # a few places - which is what this one was measured doing.
        segs, thin_notes = repair_thin_transcript(segs, wav, source_lang,
                                                  emit=emit)
        gap_notes = list(gap_notes) + list(thin_notes)
    except Exception as e:
        if emit:
            emit("transcribe", 40, f"Gap fill skipped ({str(e)[:60]})")

    # Drop half-words the recogniser left at segment ends before translating, so
    # they never reach the voice engine as a stray syllable.
    frag_notes = strip_asr_fragment(segs)
    if emit and frag_notes:
        emit("transcribe", 43,
             f"Removed {len(frag_notes)} cut-off word fragment(s) from the "
             f"transcript", device="Cloud")

    # Repair segment timing from the audio before anything is translated, so the
    # character budgets are derived from real speech time.
    slot_notes = []
    try:
        if not os.path.exists(wav):
            extract_audio(video_path, wav)
        segs, slot_notes = plan_slots(segs, wav, onsets=fetch_onsets(job_id),
                                      emit=emit)
    except Exception as e:
        if emit:
            emit("transcribe", 44, f"Slot analysis unavailable ({str(e)[:60]})")

    # Replace ONLY the translation. Every other field on each segment — above
    # all profile_id — is left untouched so cloning still works.
    # Time the cloned voice first, so the budget is built from what this voice will
    # actually deliver rather than from how fast the original speaker talked.
    early_cps = None
    if os.environ.get("VS_EARLY_RATE", "1") == "1":
        try:
            # If this job has rendered before - which it has whenever a transcript is
            # being reused - the engine's own records are exact and free. Probes are
            # only for a genuinely first run.
            early_cps, early_note = measure_rate_from_render(
                job_id, segs, target_lang, emit=emit)
            if not early_cps:
                early_cps, early_note = measure_voice_rate_early(
                    job_id, segs, source_lang, target_lang, emit=emit)
            if emit:
                emit("translate", 47,
                     f"Voice rate before translating: {early_note}",
                     device="Cloud")
        except Exception as e:
            if emit:
                emit("translate", 47,
                     f"Early voice measurement skipped ({str(e)[:70]})")

    segs, report = translate_with_gemini(segs, source_lang, target_lang,
                                        emit=emit, target_cps=early_cps)

    # No pre-render length enforcement here on purpose. VoiceStudio's duration
    # estimator has no calibration until this job has synthesized something
    # (MIN_CALIBRATION_SAMPLES = 3), so before the first render its numbers are
    # not speaking times — an uncalibrated run reported 8 characters as 9.02 s.
    # Length is corrected after the first render by condense_after_render, which
    # uses their calibrated planner.

    filler_notes = strip_trailing_filler(segs, target_lang)
    if emit and filler_notes:
        emit("translate", 54,
             f"Removed {len(filler_notes)} stray trailing interjection(s)",
             device="Cloud")

    # Distribute each translation across the slots where speech actually occurs.
    before = len(segs)
    segs = apply_slots(segs, target_lang, emit=emit)
    strip_trailing_filler(segs, target_lang)
    if emit and len(segs) != before:
        emit("translate", 57,
             f"Timing repair: {before} ASR segment(s) -> {len(segs)} slot(s)",
             device="Cloud")

    if artifact_text and report:
        if asr_notes:
            report += ["", "TRANSCRIPT QUALITY:"] + ["  " + n for n in asr_notes]
        if gap_notes:
            report += ["", "RECOVERED DIALOGUE (missing from VoiceStudio's ASR):"] \
                      + ["  " + n for n in gap_notes]
        if frag_notes:
            report += ["", "CUT-OFF FRAGMENTS REMOVED:"] + \
                      ["  " + n for n in frag_notes]
        if slot_notes:
            report += ["", "TIMING REPAIR (segments rebuilt from audio):"] + \
                      ["  " + n for n in slot_notes]
        report += ["", f"SEGMENTS: {before} from ASR -> {len(segs)} synthesized"]
        artifact_text("\n".join(report), "05_vs_script.txt",
                      "Step 5: Gemini script for VoiceStudio (budgeted)")

    # First render is a MEASUREMENT: smart_fit records each line's natural
    # duration, which is the only way to tell an over-long line from a well-sized
    # one. strict_slot returns every clip pinned to its slot, so it hides that.
    gen = generate(job_id, segs, target_lang, emit=emit,
                   timing_strategy=MEASURE_STRATEGY)
    # Poll for the rendered track rather than following the task's SSE stream.
    # The stream almost never emits a completion event for dub generation, so
    # waiting on it just blocked until the connection dropped — measured at ~116
    # seconds of dead time on a job whose synthesis finished in 5 seconds.
    try:
        wait_render(job_id, emit=emit)
    except Exception as e:
        if emit:
            emit("synthesize", 80, f"render wait: {e}")

    # Closed-loop timing correction. Until a line has actually been spoken we do
    # not know how fast that cloned voice is, and the spread is 2x between
    # speakers, so the first render is treated as a measurement and the lines
    # that miss their slot are rewritten to that speaker's real pace.
    # Length correction, using VoiceStudio's own calibrated planner rather than a
    # duplicate of it. It runs HERE, after the first render, because its
    # calibration is derived from segments this job has already synthesized —
    # before that its estimates are meaningless (an uncalibrated run reported 8
    # characters as 9.02 seconds, and acting on that corrupted lines).
    # Measure the voice BEFORE deciding anything, because condensation, merging and
    # the compression cap are all computed from this rate. The first render has
    # happened by now, so cloned profiles exist and can be previewed.
    # Prefer the whole render over three probes: same voice, same lines, 40x the
    # sample, and it costs nothing because the render has already happened.
    measured, rate_note = None, ""
    try:
        measured, rate_note = measure_rate_from_render(job_id, segs, target_lang,
                                                       emit=emit)
    except Exception as e:
        rate_note = f"render-based rate failed ({str(e)[:60]})"
    if not measured:
        try:
            probe_cps, probe_note = measure_engine_rate(job_id, segs, target_lang,
                                                        emit=emit)
            measured = probe_cps
            rate_note = f"{rate_note}; fell back to probes: {probe_note}"
        except Exception as e:
            rate_note = f"{rate_note}; probes failed too ({str(e)[:50]})"
    if emit:
        emit("synthesize", 82, f"Voice rate: {rate_note}", device="Cloud")
    pre_speed, _ = compute_speed(measured or FALLBACK_CPS, target_lang)

    fit_data = {}
    if os.environ.get("VS_REFIT", "1") == "1":
        try:
            n = condense_after_render(job_id, segs, target_lang, emit=emit,
                                      artifact_text=artifact_text,
                                      out=fit_data,
                                      base_cps=measured, speed=pre_speed)
            if n:
                strip_trailing_filler(segs, target_lang)
                if emit:
                    emit("synthesize", 85,
                         f"Condensed {n} line(s) to fit their slots",
                         device="Cloud")
        except Exception as e:
            if emit:
                emit("synthesize", 85, f"Planner pass skipped ({str(e)[:70]})")

    # FINAL render, locked to the original timeline. Done unconditionally so the
    # delivered audio always uses strict_slot even when no text changed: the
    # measuring pass above ran under smart_fit, which permits drift.
    # Set synthesis speed from what this voice actually measured, so the dub
    # speaks at the target language's natural rate. This is what removes the need
    # to time-stretch or cut text at all, and it adapts per video rather than
    # being tuned for one clip.
    # Time the real voice rather than trusting the planner's estimate of it. The
    # estimate read 6.6-6.8 chars/s where the audio measured 16-18, and everything
    # downstream (speed, merging, condensation, the compression cap) is computed
    # from this one number.
    rate_lines = []
    planner_cps = fit_data.get("measured_cps")
    rate_lines.append(f"rendered probe : {rate_note}")
    rate_lines.append(
        f"planner est    : {planner_cps:.2f} chars/s" if planner_cps
        else "planner est    : unavailable")
    if measured and planner_cps and planner_cps > 0:
        rate_lines.append(
            f"the planner's estimate is {measured/planner_cps:.2f}x off the "
            f"measured audio; the measurement is used")
    if not measured:
        measured = planner_cps or FALLBACK_CPS
        rate_lines.append(f"falling back to {measured:.2f} chars/s")

    speed, speed_note = compute_speed(measured, target_lang)
    if SPEED_FIXED:
        speed, speed_note = float(SPEED_FIXED), f"speed pinned to {SPEED_FIXED}"
    rate_lines += ["", speed_note,
                   f"delivering about {cps_at_speed(measured, speed):.1f} "
                   f"chars/s (ElevenLabs reference: 14.03)"]
    if emit:
        emit("synthesize", 87, f"Voice rate: {speed_note}", device="Cloud")
    if artifact_text:
        artifact_text("\n".join(rate_lines) + "\n", "10_voice_rate.txt",
                      "Step 10: synthesis speed chosen from the measured rate")

    # Nothing may be crushed past MAX_COMPRESSION. Runs after the speed decision
    # so it only shortens text for what faster synthesis and gap borrowing could
    # not absorb.
    base_cps = measured
    # Split before capping: a line that is long because several sentences were
    # merged needs more TIME, not fewer words. The allowance is derived from this
    # voice's measured rate and this line's own slot, so it generalises.
    # Merge first: a fragment-length slot cannot hold a clause at any rate, and
    # merging absorbs the gap between two lines into one longer span, which
    # genuinely creates time. This is what brings our block shape closer to the
    # 15s median measured on the ElevenLabs reference.
    # Lengthen lines that finish early, BEFORE merging. Merging exists to give a
    # cramped line more room; a line that is short because its budget was too small
    # needs more words, not a longer slot, and expanding first stops the two passes
    # working against each other.
    expand_notes = []
    try:
        _, expand_notes = expand_underfilled(segs, base_cps, speed, target_lang,
                                             emit=emit,
                                             artifact_text=artifact_text,
                                             source_lang=source_lang)
    except Exception as e:
        if emit:
            emit("synthesize", 86, f"Expansion skipped ({str(e)[:60]})")

    merge_notes = []
    try:
        segs, merge_notes = merge_short_lines(segs, base_cps, speed, emit=emit)
    except Exception as e:
        if emit:
            emit("synthesize", 86, f"Merge skipped ({str(e)[:60]})")

    split_notes = []
    try:
        segs, split_notes = split_overlong(segs, base_cps, speed, target_lang,
                                           emit=emit)
    except Exception as e:
        if emit:
            emit("synthesize", 87, f"Split skipped ({str(e)[:60]})")
    try:
        worst_ratio, still_over = enforce_compression_cap(
            segs, base_cps, speed, target_lang, emit=emit,
            artifact_text=artifact_text)
    except Exception as e:
        worst_ratio, still_over = 0.0, 0
        if emit:
            emit("synthesize", 87, f"Compression cap skipped ({str(e)[:60]})")

    # LAST text-dependent step: no slot may ask for much more audio than its words
    # need, or the engine fills the surplus with its own reference in the original
    # language. Runs after merging, expansion and the compression cap because it is
    # the final text length that decides the surplus.
    trim_notes = []
    try:
        _, trim_notes = fit_slots_to_text(segs, base_cps, speed, emit=emit,
                                          artifact_text=artifact_text)
    except Exception as e:
        if emit:
            emit("synthesize", 87, f"Slot trim skipped ({str(e)[:60]})")

    if emit:
        emit("synthesize", 88,
             f"Final render at speed {speed} locked to the original timing "
             f"({TIMING_STRATEGY})", device="Cloud")
    generate(job_id, segs, target_lang, emit=emit,
             timing_strategy=TIMING_STRATEGY, speed=speed)
    try:
        wait_render(job_id, emit=emit)
    except Exception as e:
        if emit:
            emit("synthesize", 89, f"render wait: {e}")

    # Single source of truth for timing: the compression report above, which is
    # computed from this voice's MEASURED rate and each line's available time.
    #
    # The old alignment_report is deliberately not run here. It derived its numbers
    # from planner estimates captured during the measuring render at speed 1.0, so
    # after the speed decision it described audio that no longer existed — it
    # printed "66.3s of overrun" for a render the compression report scored at
    # 1.15x or better. Two conflicting reports is worse than one.
    if artifact_text and (merge_notes or split_notes or expand_notes):
        body = []
        if expand_notes:
            body += [f"LINES LENGTHENED TO FILL THEIR SLOT: {len(expand_notes)}",
                     ""]
        if merge_notes:
            body += ["LINES MERGED SO THE VOICE HAS ROOM",
                     "",
                     "Reference: an ElevenLabs dub of comparable material has a",
                     "median utterance block of 15.5s; fragment-length slots",
                     "cannot hold a clause at any reasonable speaking rate.",
                     ""] + merge_notes + [""]
        if split_notes:
            body += ["LINES SPLIT", ""] + split_notes
        artifact_text("\n".join(body) + "\n", "09_line_shape.txt",
                      "Step 9: lines merged/split so each block fits its words")
    if emit:
        emit("mix", 90,
             f"Timing: worst compression {worst_ratio:.2f}x, "
             f"{still_over} line(s) above {MAX_COMPRESSION}x, "
             f"{len(split_notes)} line(s) split", device="Cloud")

    # QC re-transcribes the dub to measure drift. Useful, but it falls back to
    # CPU Whisper when VRAM is tight ("2.9 GB free < 5.0 GB needed"), which adds
    # roughly a minute per job. Off by default; enable with VS_QC=1.
    if os.environ.get("VS_QC", "0") == "1":
        q = qc(job_id)
        if artifact_text:
            artifact_text(json.dumps(q, ensure_ascii=False, indent=1),
                          "06_vs_qc.json", "Step 6: VoiceStudio timing QC")

    if emit:
        emit("mix", 92, "Downloading dubbed video", device="Cloud")
    download(job_id, out_path)

    # Correct the cloned voice's pitch against the real speaker. Two losses
    # multiply to leave the dub well below the original (measured 0.84x from the
    # reference clip being cut low, times 0.86x from the engine rendering below its
    # own reference = 0.72x). The engine exposes no pitch control, so the finished
    # voice stem is corrected and remixed with the untouched background.
    if os.environ.get("VS_PITCH_FIX", "1") == "1":
        try:
            from pitch_fix import correct_dub_pitch
            corrected = os.path.join(
                os.path.dirname(os.path.abspath(out_path)) or ".",
                "pitch_corrected.mp4")
            before = os.path.getsize(out_path) if os.path.exists(out_path) else 0
            got = correct_dub_pitch(BASE, job_id, video_path, out_path,
                                    corrected, emit=emit,
                                    artifact_text=artifact_text,
                                    artifact_file=artifact_file,
                                    segments=segs)
            if got and got != out_path and os.path.exists(got):
                os.replace(got, out_path)
                # Verify the replacement actually happened. A report saying
                # "rebuilt" while the delivered file is unchanged is how a broken
                # run looked clean: the artifacts claimed a correction that never
                # reached the file the user played.
                after = os.path.getsize(out_path)
                if after == before and emit:
                    emit("mix", 94,
                         "WARNING: pitch-corrected file is identical in size to "
                         "the original download; the correction may not have "
                         "been applied")
        except Exception as e:
            if emit:
                emit("mix", 94, f"Pitch step skipped ({str(e)[:70]})")
    return out_path
