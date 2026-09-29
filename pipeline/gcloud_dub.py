"""
Google Cloud Chirp3-HD dubbing backend (Stage 6).

Goal: ElevenLabs-style dubbing quality using ONLY capabilities that are
actually available on this GCP project:
  * per-speaker distinct, gender-matched Chirp3-HD voices (30 per language)
  * correct Indic pronunciation (native Google Indic voices)
  * EXACT time-slot fitting via the API's speakingRate (pace) control, which
    is far cleaner than post-hoc phase-vocoder stretching

IMPORTANT — what this is NOT
---------------------------
This does NOT clone the original speaker's voice. Google voice cloning
(Chirp 3 Instant Custom Voice AND the older brand-voices Chirp Voice Cloning)
is gated and returns 404 on this project — verified. So each detected speaker
is mapped to a DISTINCT high-quality preset voice matched on gender, which
keeps speakers distinguishable and natural, but is not the original timbre.

Timing strategy (the part that fixes "length is wrong")
------------------------------------------------------
1. Synthesize once at rate 1.0 and measure the real duration.
2. rate = natural_duration / slot_duration  (clamped to the API's 0.25-2.0).
3. If the first pass is off by more than TOLERANCE, re-synthesize at that rate.
   Because pace control is linear (verified: 4.84s @1.0 -> 3.18s @1.5), one
   correction lands within a few percent.
4. Any residual mismatch is trimmed by the caller's time_stretch.

Auth: Application Default Credentials (gcloud auth application-default login)
      or GOOGLE_APPLICATION_CREDENTIALS. Project from GOOGLE_CLOUD_PROJECT /
      CHIRP_PROJECT.
"""

import base64
import io
import json
import os

import numpy as np
import soundfile as sf

NATIVE_SR = 24000
API = "https://texttospeech.googleapis.com/v1beta1/text:synthesize"

# Gemini-TTS models accept a natural-language `prompt` that steers delivery
# (emotion, energy, pacing). This is what lifts the dub out of "robotic" and
# lets us mirror the ORIGINAL actor's performance. Verified working on this
# project: neutral 5.05s vs sad 6.29s vs cheerful 4.77s for the same sentence.
GEMINI_MODEL = os.environ.get("GEMINI_TTS_MODEL",
                              "gemini-3.1-flash-tts-preview")
USE_GEMINI = os.environ.get("GCLOUD_ENGINE", "gemini").lower() != "chirp3hd"

# Chirp3-HD voice pools (identical names across te-IN / hi-IN / ta-IN etc.).
MALE_VOICES = [
    "Achird", "Algenib", "Algieba", "Alnilam", "Charon", "Enceladus",
    "Fenrir", "Iapetus", "Orus", "Puck", "Rasalgethi", "Sadachbia",
    "Sadaltager", "Schedar", "Umbriel", "Zubenelgenubi",
]
FEMALE_VOICES = [
    "Achernar", "Aoede", "Autonoe", "Callirrhoe", "Despina", "Erinome",
    "Gacrux", "Kore", "Laomedeia", "Leda", "Pulcherrima", "Sulafat",
    "Vindemiatrix", "Zephyr",
]

# Our short language codes -> Google BCP-47 locales that have Chirp3-HD.
LOCALE = {
    "te": "te-IN", "hi": "hi-IN", "ta": "ta-IN", "kn": "kn-IN",
    "ml": "ml-IN", "bn": "bn-IN", "gu": "gu-IN", "mr": "mr-IN",
    "pa": "pa-IN", "ur": "ur-IN", "en": "en-IN",
}

# API pace limits.
RATE_MIN, RATE_MAX = 0.25, 2.0
TOLERANCE = 0.06  # re-synthesize if duration is >6% off the slot

# Gemini-TTS is billed through aiplatform and has a per-minute request quota
# per base model. The fitting loop can issue several calls per segment, which
# is enough to trip it on a short video (observed: 7 of 15 segments failed with
# HTTP 429, leaving the dub silent). We therefore self-throttle, back off on
# 429, and finally fall back to Chirp3-HD, which is served from a different
# (much larger) quota pool.
GEMINI_MIN_INTERVAL = float(os.environ.get("GEMINI_MIN_INTERVAL", "4.0"))
GEMINI_MAX_RETRIES = int(os.environ.get("GEMINI_MAX_RETRIES", "4"))
_last_call = {"t": 0.0}


def _throttle(min_interval):
    """Space out requests so we stay under the per-minute quota."""
    import time
    now = time.monotonic()
    wait = min_interval - (now - _last_call["t"])
    if wait > 0:
        time.sleep(wait)
    _last_call["t"] = time.monotonic()


def supports(target_lang):
    return target_lang in LOCALE


def _emit(stage, pct, message="", device=None):
    evt = {"stage": stage, "pct": pct, "message": message}
    if device:
        evt["device"] = device
    print(json.dumps(evt), flush=True)


class ChirpHDVoicer:
    """Holds credentials and synthesizes segments with pace-fitted timing."""

    def __init__(self, target_lang):
        import google.auth
        from google.auth.transport.requests import Request

        self.locale = LOCALE[target_lang]
        self.lang = target_lang

        creds, proj = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"])
        self.project = (os.environ.get("CHIRP_PROJECT")
                        or os.environ.get("GOOGLE_CLOUD_PROJECT") or proj)
        if not self.project:
            raise RuntimeError(
                "No GCP project. Set GOOGLE_CLOUD_PROJECT or CHIRP_PROJECT.")
        self._creds = creds
        self._Request = Request
        self._refresh()

    def _refresh(self):
        self._creds.refresh(self._Request())
        self._headers = {
            "Authorization": f"Bearer {self._creds.token}",
            "x-goog-user-project": self.project,
            "Content-Type": "application/json; charset=utf-8",
        }

    def synth(self, text, voice, rate=1.0, prompt=None):
        """Synthesize once. Returns (float32 mono, sr).

        With Gemini-TTS we pass `prompt` to steer emotion/delivery; with
        Chirp3-HD we fall back to the plain HD voice (no prompt support).
        """
        import requests

        if USE_GEMINI:
            inp = {"text": text}
            if prompt:
                inp["prompt"] = prompt
            body = {
                "input": inp,
                "voice": {"languageCode": self.locale, "name": voice,
                          "model_name": GEMINI_MODEL},
                "audioConfig": {
                    "audioEncoding": "LINEAR16",
                    "sampleRateHertz": NATIVE_SR,
                    "speakingRate": round(float(rate), 3),
                },
            }
        else:
            body = {
                "input": {"text": text},
                "voice": {"languageCode": self.locale,
                          "name": f"{self.locale}-Chirp3-HD-{voice}"},
                "audioConfig": {
                    "audioEncoding": "LINEAR16",
                    "sampleRateHertz": NATIVE_SR,
                    "speakingRate": round(float(rate), 3),
                },
            }
        import time

        gemini_req = "model_name" in body.get("voice", {})
        if gemini_req:
            _throttle(GEMINI_MIN_INTERVAL)

        r = None
        for attempt in range(GEMINI_MAX_RETRIES):
            r = requests.post(API, headers=self._headers, json=body, timeout=120)
            if r.status_code == 200:
                break
            if r.status_code == 401:
                self._refresh()          # token expired mid-run
                continue
            if r.status_code == 429 and gemini_req:
                # Per-minute quota. Wait out the window with exponential
                # backoff, then retry the same request.
                backoff = min(60.0, GEMINI_MIN_INTERVAL * (2 ** attempt) + 5.0)
                time.sleep(backoff)
                _last_call["t"] = time.monotonic()
                continue
            raise RuntimeError(f"TTS {r.status_code}: {r.text[:200]}")

        if r is None or r.status_code != 200:
            # Still failing (almost always quota). Retry once on Chirp3-HD,
            # which uses a separate quota pool, so we produce audio rather than
            # leaving a silent gap.
            if gemini_req:
                fb = {
                    "input": {"text": body["input"]["text"]},
                    "voice": {"languageCode": self.locale,
                              "name": f"{self.locale}-Chirp3-HD-"
                                      f"{body['voice']['name']}"},
                    "audioConfig": body["audioConfig"],
                }
                r = requests.post(API, headers=self._headers, json=fb, timeout=120)
                if r.status_code != 200:
                    raise RuntimeError(
                        f"TTS fallback {r.status_code}: {r.text[:200]}")
            else:
                raise RuntimeError(
                    f"TTS {r.status_code if r else 'no response'}")

        raw = base64.b64decode(r.json()["audioContent"])
        audio, sr = sf.read(io.BytesIO(raw), always_2d=False)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        return trim_silence(audio, int(sr)), int(sr)

    def synth_fitted(self, text, voice, slot_seconds, max_passes=1, prompt=None):
        """Synthesize so the result fits `slot_seconds` as closely as possible.

        Uses the API's own pace control (clean, no stretching artifacts) rather
        than resampling/phase-vocoder after the fact.

        Chirp3-HD's speakingRate is close to linear but not exact (it also trims
        silence differently per rate), so a single correction typically lands
        ~10% short. We therefore run a small FEEDBACK loop: measure what the
        requested rate actually produced and correct from the observed ratio.
        Converges within 2-3 calls.

        Returns (audio, sr, used_rate, natural_seconds).
        """
        audio, sr = self.synth(text, voice, 1.0, prompt=prompt)
        natural = len(audio) / float(sr)

        if slot_seconds <= 0.05 or natural <= 0:
            return audio, sr, 1.0, natural

        # Already close enough at natural pace.
        if abs(natural / slot_seconds - 1.0) <= TOLERANCE:
            return audio, sr, 1.0, natural

        best = (audio, sr, 1.0, abs(natural - slot_seconds))
        rate = max(RATE_MIN, min(RATE_MAX, natural / slot_seconds))

        for _ in range(max_passes):
            try:
                cand, csr = self.synth(text, voice, rate, prompt=prompt)
            except Exception:
                break
            if not cand.size:
                break
            got = len(cand) / float(csr)
            err = abs(got - slot_seconds)
            if err < best[3]:
                best = (cand, csr, rate, err)
            # Good enough?
            if got > 0 and abs(got / slot_seconds - 1.0) <= TOLERANCE:
                return cand, csr, rate, natural
            # Feedback correction: scale the rate by how far off we landed.
            # got > slot  -> need faster (higher rate); got < slot -> slower.
            if got <= 0:
                break
            new_rate = rate * (got / slot_seconds)
            new_rate = max(RATE_MIN, min(RATE_MAX, new_rate))
            if abs(new_rate - rate) < 0.01:
                break  # at a limit or converged
            rate = new_rate

        return best[0], best[1], best[2], natural


def measure_segment(mono, sr, start, end):
    """Raw acoustic measurements for one segment of the original speech."""
    import numpy as np
    a, b = int(max(0.0, start) * sr), int(max(0.0, end) * sr)
    clip = mono[a:b] if b > a else np.zeros(0, dtype=np.float32)
    out = {"db": None, "f0": 0.0, "spread": 0.0, "rate": 0.0}
    if clip.size < int(0.12 * sr):
        return out
    rms = float(np.sqrt(np.mean(clip.astype(np.float64) ** 2))) + 1e-9
    out["db"] = 20.0 * np.log10(rms)
    try:
        import librosa
        f0 = librosa.yin(clip.astype(np.float32), fmin=60, fmax=400, sr=sr)
        f0 = f0[np.isfinite(f0)]
        if f0.size:
            out["f0"] = float(np.median(f0))
            out["spread"] = float(np.std(f0) / max(1.0, out["f0"]))
        onsets = librosa.onset.onset_detect(y=clip.astype(np.float32), sr=sr,
                                            units="time")
        out["rate"] = len(onsets) / max(0.2, (b - a) / sr)
    except Exception:
        pass
    return out


def build_expression_plan(segments, mono, sr):
    """Describe each segment's delivery RELATIVE to this video's own baseline.

    Absolute thresholds do not work: the separated vocal stem is loudness-
    normalised, so on real material every segment read as "loud and fast" and
    every line got the same "high intensity" instruction (observed on this
    project — all 15 segments identical). Comparing each segment against the
    median of the same video is mix- and speaker-independent, so the contrast
    between a shout and a whisper survives.

    Returns {index: (prompt, measurements)}.
    """
    import numpy as np
    meas = {}
    for i, seg in enumerate(segments):
        meas[i] = measure_segment(mono, sr, float(seg["start"]), float(seg["end"]))

    dbs = [m["db"] for m in meas.values() if m["db"] is not None]
    spreads = [m["spread"] for m in meas.values() if m["spread"] > 0]
    rates = [m["rate"] for m in meas.values() if m["rate"] > 0]
    db_med = float(np.median(dbs)) if dbs else -20.0
    sp_med = float(np.median(spreads)) if spreads else 0.25
    rt_med = float(np.median(rates)) if rates else 4.0

    plan = {}
    for i, m in meas.items():
        if m["db"] is None:
            plan[i] = ("Speak naturally and conversationally.", m)
            continue
        # Relative deltas against this video's own typical delivery.
        d_db = m["db"] - db_med
        d_sp = (m["spread"] - sp_med) / max(0.05, sp_med)
        d_rt = (m["rate"] - rt_med) / max(0.5, rt_med)

        louder, softer = d_db > 3.0, d_db < -4.0
        animated, flat = d_sp > 0.25, d_sp < -0.25
        faster, slower = d_rt > 0.25, d_rt < -0.25

        if louder and (animated or faster):
            style = ("Speak with raised intensity and urgency, forceful and "
                     "emotionally charged")
        elif softer and not animated:
            style = ("Speak softly and gently, subdued and intimate, almost "
                     "under your breath")
        elif animated:
            style = "Speak expressively with lively pitch variation, warm and engaged"
        elif flat:
            style = "Speak calmly and evenly, measured and matter-of-fact"
        elif faster:
            style = "Speak briskly and eagerly with quick pacing"
        elif slower:
            style = "Speak slowly and deliberately, with weight and pauses"
        else:
            style = "Speak naturally and conversationally with normal expressiveness"

        m["style"] = style
        plan[i] = (style + ". Match the emotion of the original performance and "
                           "sound like a real person, not a narrator.", m)
    return plan


def analyze_expression(mono, sr, start, end):
    """Read the ORIGINAL actor's delivery for one segment and describe it as a
    natural-language style prompt for Gemini-TTS.

    We can't clone the timbre (cloning is gated), but we CAN transfer the
    *performance*: loudness, pitch movement and speaking speed are what make
    delivery read as angry / sad / excited / calm. Measuring them from the
    source segment and instructing Gemini accordingly is what stops the dub
    sounding flat and robotic.

    Returns (prompt_string, debug_dict).
    """
    import numpy as np
    a, b = int(max(0.0, start) * sr), int(max(0.0, end) * sr)
    clip = mono[a:b] if b > a else np.zeros(0, dtype=np.float32)
    dbg = {}
    if clip.size < int(0.15 * sr):
        return "Speak naturally, matching a normal conversational tone.", dbg

    # Loudness (RMS in dBFS) -> intensity of delivery.
    rms = float(np.sqrt(np.mean(clip.astype(np.float64) ** 2))) + 1e-9
    db = 20.0 * np.log10(rms)
    dbg["rms_db"] = round(db, 1)

    # Pitch: median + variability -> emotional arousal / monotone vs animated.
    med_f0, f0_spread = 0.0, 0.0
    try:
        import librosa
        f0 = librosa.yin(clip.astype(np.float32), fmin=60, fmax=400, sr=sr)
        f0 = f0[np.isfinite(f0)]
        if f0.size:
            med_f0 = float(np.median(f0))
            # Relative spread is speaker-independent, so it compares fairly
            # across a deep male voice and a high female voice.
            f0_spread = float(np.std(f0) / max(1.0, med_f0))
    except Exception:
        pass
    dbg["f0"] = round(med_f0, 1)
    dbg["f0_spread"] = round(f0_spread, 3)

    # Speaking speed proxy: onset density (syllable-ish events per second).
    rate = 0.0
    try:
        import librosa
        onsets = librosa.onset.onset_detect(y=clip.astype(np.float32), sr=sr,
                                            units="time")
        dur = max(0.2, (b - a) / sr)
        rate = len(onsets) / dur
    except Exception:
        pass
    dbg["onset_rate"] = round(rate, 2)

    # Map measurements -> a delivery instruction.
    loud = db > -18.0
    quiet = db < -30.0
    animated = f0_spread > 0.28
    monotone = f0_spread < 0.14
    fast = rate > 4.2
    slow = rate < 2.0

    if loud and (animated or fast):
        style = ("Speak with high intensity and urgency, energetic and forceful, "
                 "as if emotionally charged")
    elif quiet and not animated:
        style = ("Speak softly and gently, subdued and intimate, with a quiet "
                 "restrained delivery")
    elif animated and not loud:
        style = ("Speak expressively with lively pitch variation, warm and "
                 "engaged")
    elif monotone:
        style = "Speak calmly and evenly, measured and matter-of-fact"
    elif fast:
        style = "Speak briskly and eagerly, with quick lively pacing"
    elif slow:
        style = "Speak slowly and deliberately, with weight and pauses"
    else:
        style = "Speak naturally and conversationally with normal expressiveness"

    prompt = (style + ". Match the emotion of the original performance and "
              "sound like a real person, not a narrator.")
    dbg["style"] = style
    return prompt, dbg


def estimate_gender(ref_wav):
    """Guess speaker gender from median pitch of their reference clip.

    Used only to pick a gender-matched preset voice so a male character doesn't
    get a female voice. Falls back to 'male' when pitch can't be measured.
    """
    try:
        data, sr = sf.read(ref_wav, always_2d=True)
        mono = data.mean(axis=1).astype(np.float32)
        if mono.size < sr // 4:
            return "male"
        import librosa
        f0 = librosa.yin(mono, fmin=60, fmax=400, sr=sr)
        f0 = f0[np.isfinite(f0)]
        if f0.size == 0:
            return "male"
        med = float(np.median(f0))
        # ~165 Hz is the conventional male/female split for speech F0.
        return "female" if med >= 165.0 else "male"
    except Exception:
        return "male"


def assign_voices(speaker_ids, refs_by_speaker):
    """Map each detected speaker to a DISTINCT, gender-matched voice."""
    male_i, fem_i = 0, 0
    mapping = {}
    for spk in sorted(speaker_ids):
        ref = refs_by_speaker.get(spk)
        gender = estimate_gender(ref) if ref else "male"
        if gender == "female":
            voice = FEMALE_VOICES[fem_i % len(FEMALE_VOICES)]
            fem_i += 1
        else:
            voice = MALE_VOICES[male_i % len(MALE_VOICES)]
            male_i += 1
        mapping[spk] = voice
    return mapping


def segment_pitch(mono, sr, start, end):
    """Median F0 of one segment of the ORIGINAL speech, or 0.0 if unmeasurable."""
    try:
        import librosa
        a, b = int(max(0.0, start) * sr), int(max(0.0, end) * sr)
        clip = mono[a:b]
        if clip.size < int(0.12 * sr):
            return 0.0
        f0 = librosa.yin(clip.astype(np.float32), fmin=60, fmax=400, sr=sr)
        f0 = f0[np.isfinite(f0)]
        return float(np.median(f0)) if f0.size else 0.0
    except Exception:
        return 0.0


def match_voices(voicer, segments, src_mono, src_sr, emit=None,
                 candidates_per_gender=int(
                     os.environ.get("VOICE_AUDITIONS", "8"))):
    """Audition candidate voices and keep the closest match per speaker.

    For each detected speaker we build an acoustic profile from their real
    speech, synthesize one of their own lines with several same-gender preset
    voices, profile each result, and keep whichever is nearest. We also compute
    a pitch ratio so the chosen voice can be nudged toward the original
    speaker's pitch, closing most of the remaining gap in perceived tone.

    Returns {speaker: {"voice": name, "pitch_ratio": float, "dist": float}}.
    """
    import numpy as np

    if src_mono is None or src_sr in (None, 0):
        return {}

    by_spk = {}
    for seg in segments:
        by_spk.setdefault(seg.get("speaker", 0), []).append(seg)

    chosen = {}
    for spk, segs in by_spk.items():
        # Longest line gives the most reliable profile and the best audition text.
        best_seg = max(segs, key=lambda s: float(s["end"]) - float(s["start"]))
        a = int(float(best_seg["start"]) * src_sr)
        b = int(float(best_seg["end"]) * src_sr)
        ref = src_mono[a:b]
        target = voice_profile(ref, src_sr)
        if not target.get("f0"):
            continue

        gender = str(best_seg.get("gender", "")).strip().lower()
        pool = FEMALE_VOICES if gender == "female" else MALE_VOICES
        used = {c["voice"] for c in chosen.values()}
        pool = [v for v in pool if v not in used] or list(pool)
        pool = pool[:max(1, candidates_per_gender)]

        text = (best_seg.get("translated") or "").strip()
        if len(text) < 4:
            text = (segs[0].get("translated") or "").strip()
        if len(text) < 4:
            continue

        if emit:
            emit("synthesize", 60,
                 f"Matching voice for speaker {spk} ({gender}) — "
                 f"auditioning {len(pool)}", device="Cloud")

        results = []
        for cand in pool:
            try:
                audio, sr = voicer.synth(text, cand, 1.0)
                if audio.size < sr // 8:
                    continue
                prof = voice_profile(audio, sr)
                d = profile_distance(target, prof)
                # Gender legibility outranks numeric pitch similarity. Some
                # originals here sit around 205 Hz (comedic high-pitched male),
                # and the nearest match by pitch alone was a 237 Hz voice that
                # reads as female to a listener. Penalise candidates that stray
                # out of their gender's normal range so a male character always
                # sounds male.
                cf = prof.get("f0", 0.0)
                if cf > 0:
                    if gender == "male" and cf > 185.0:
                        d += 1.5 * ((cf - 185.0) / 100.0 + 0.5)
                    elif gender == "female" and cf < 155.0:
                        d += 1.5 * ((155.0 - cf) / 100.0 + 0.5)
                results.append((d, cand, prof))
            except Exception:
                continue

        if not results:
            continue
        results.sort(key=lambda x: x[0])
        dist, voice, prof = results[0]

        # Nudge pitch toward the original speaker, but only mildly: large shifts
        # sound synthetic. +/- ~3 semitones is a safe, natural-sounding range.
        ratio = 1.0
        if prof.get("f0", 0) > 0 and target.get("f0", 0) > 0:
            ratio = float(target["f0"]) / float(prof["f0"])
            ratio = float(np.clip(ratio, 0.84, 1.19))
        chosen[spk] = {"voice": voice, "pitch_ratio": round(ratio, 3),
                       "dist": round(float(dist), 3),
                       "target_f0": round(target["f0"], 1),
                       "voice_f0": round(prof.get("f0", 0.0), 1)}
    return chosen


def build_voice_plan(segments, src_mono, src_sr, speaker_voices):
    """Choose a voice for EVERY segment, using measured pitch as the authority
    on gender.

    Why not rely on diarization alone: on real material the speaker-embedding
    clustering frequently collapses everyone into one cluster (verified on this
    project's own sample — 1 cluster at the default threshold), which then gives
    a male character a female voice. Pitch is a far more robust gender signal,
    so we group segments into pitch bands per diarization cluster and assign a
    distinct, gender-correct voice to each group.

    Returns {segment_index: voice_name}.
    """
    male_pool, fem_pool = list(MALE_VOICES), list(FEMALE_VOICES)
    assigned = {}
    group_voice = {}
    m_i = f_i = 0

    for i, seg in enumerate(segments):
        spk = seg.get("speaker", 0)

        # If the audio model already told us the gender, TRUST IT. Pitch alone
        # is unreliable: on real material high-pitched young male characters
        # measured 195-346 Hz and were wrongly voiced as female. Gemini judges
        # from the voice itself and got those right.
        stated = str(seg.get("gender", "")).strip().lower()
        if stated in ("male", "female"):
            key = (spk, stated == "female")
            if key not in group_voice:
                if stated == "female":
                    group_voice[key] = fem_pool[f_i % len(fem_pool)]
                    f_i += 1
                else:
                    group_voice[key] = male_pool[m_i % len(male_pool)]
                    m_i += 1
            assigned[i] = group_voice[key]
            continue

        f0 = 0.0
        if src_mono is not None:
            f0 = segment_pitch(src_mono, src_sr, float(seg["start"]),
                               float(seg["end"]))

        if f0 <= 0:
            # Unmeasurable: fall back to the speaker-level voice if we have one.
            assigned[i] = speaker_voices.get(spk, male_pool[0])
            continue

        female = f0 >= 165.0
        # Key on (diarization cluster, gender) ONLY — deliberately not on pitch
        # bands. One actor's pitch swings a lot with emotion (measured 195-346 Hz
        # for a single character), so banding would hand the same person several
        # different voices mid-scene. Gender still comes from pitch, which is
        # what fixes male lines getting a female voice.
        key = (spk, female)

        if key not in group_voice:
            if female:
                group_voice[key] = fem_pool[f_i % len(fem_pool)]
                f_i += 1
            else:
                group_voice[key] = male_pool[m_i % len(male_pool)]
                m_i += 1
        assigned[i] = group_voice[key]

    return assigned


def shift_pitch(audio, sr, ratio):
    """Shift pitch by `ratio` WITHOUT changing duration, via the WORLD vocoder.

    Used to move a preset voice toward the original speaker's pitch. WORLD
    rescales the F0 track and resynthesises from the spectral envelope, so the
    voice keeps its natural quality — unlike resampling (which also changes
    duration and formants) or a phase vocoder (which sounds robotic).
    """
    import numpy as np
    if audio is None or audio.size == 0 or abs(ratio - 1.0) < 0.01:
        return audio
    try:
        import pyworld as pw
        x = np.ascontiguousarray(audio, dtype=np.float64)
        if x.size < sr // 50:
            return audio
        fp = 5.0
        f0, t = pw.dio(x, sr, frame_period=fp)
        f0 = pw.stonemask(x, f0, t, sr)
        sp = pw.cheaptrick(x, f0, t, sr)
        ap = pw.d4c(x, f0, t, sr)
        y = pw.synthesize(np.ascontiguousarray(f0 * float(ratio)), sp, ap, sr, fp)
        y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
        peak = float(np.max(np.abs(y))) if y.size else 0.0
        if peak > 1.0:
            y = y / peak * 0.99
        return np.ascontiguousarray(y, dtype=np.float32)
    except Exception:
        return audio


def align_pitch_to(audio, sr, target_f0, max_ratio=1.22):
    """Shift this clip so its median pitch approaches `target_f0`.

    Measured per clip because the generative model's pitch drifts line to line;
    reusing a single ratio from an audition sample overshot by ~18 Hz in testing.
    The shift is capped: beyond roughly a 3-semitone move a preset voice starts
    to sound synthetic, so we accept an imperfect match over an unnatural one.
    """
    import numpy as np
    if audio is None or audio.size == 0 or not target_f0:
        return audio
    prof = voice_profile(audio, sr)
    cur = prof.get("f0", 0.0)
    if cur <= 0:
        return audio
    ratio = float(target_f0) / float(cur)
    ratio = float(np.clip(ratio, 1.0 / max_ratio, max_ratio))
    if abs(ratio - 1.0) < 0.02:
        return audio
    return shift_pitch(audio, sr, ratio)


def voice_profile(mono, sr):
    """Acoustic fingerprint of a voice: pitch and timbre descriptors.

    Used to choose which preset voice sounds most like the original speaker.
    True cloning is unavailable on this project (Google's cloning endpoints
    return 404 — the feature is safety-gated), so the next best thing is to
    audition the available voices and keep the closest match, then pitch-align
    it. These descriptors are deliberately simple and robust: median F0 plus
    spectral shape, which together capture "how high and how bright" a voice is.
    """
    import numpy as np
    out = {"f0": 0.0, "centroid": 0.0, "bandwidth": 0.0, "rolloff": 0.0}
    if mono is None or mono.size < sr // 4:
        return out
    try:
        import librosa
        y = np.ascontiguousarray(mono, dtype=np.float32)
        f0 = librosa.yin(y, fmin=60, fmax=400, sr=sr)
        f0 = f0[np.isfinite(f0)]
        if f0.size:
            out["f0"] = float(np.median(f0))
        out["centroid"] = float(np.median(
            librosa.feature.spectral_centroid(y=y, sr=sr)))
        out["bandwidth"] = float(np.median(
            librosa.feature.spectral_bandwidth(y=y, sr=sr)))
        out["rolloff"] = float(np.median(
            librosa.feature.spectral_rolloff(y=y, sr=sr, roll_percent=0.85)))
    except Exception:
        pass
    return out


def profile_distance(a, b):
    """Perceptual-ish distance between two voice profiles (lower = closer)."""
    import numpy as np
    if not a.get("f0") or not b.get("f0"):
        return 1e9
    # Pitch compared in octaves so it is scale-free; timbre in log ratios.
    d_pitch = abs(np.log2(max(1e-6, a["f0"]) / max(1e-6, b["f0"])))
    def lr(k):
        av, bv = a.get(k, 0.0), b.get(k, 0.0)
        if av <= 0 or bv <= 0:
            return 0.0
        return abs(np.log2(av / bv))
    # Pitch dominates identity, timbre refines it.
    return 2.0 * d_pitch + 1.0 * lr("centroid") + 0.5 * lr("rolloff") \
        + 0.3 * lr("bandwidth")


def trim_silence(audio, sr, thresh_db=-42.0, keep_ms=40):
    """Strip leading/trailing silence from synthesized speech.

    The generative TTS models pad utterances with silence and dramatic pauses —
    measured on real output, a 13-character exclamation came back as 4.24s of
    audio, most of it padding. Left in place that silence gets counted as speech
    duration, so the fitting logic then compresses the actual words far too hard
    (4.5x) and the result sounds rushed and robotic. Trimming first means we
    only ever time-fit real speech.
    """
    import numpy as np
    if audio is None or audio.size == 0:
        return audio
    win = max(1, int(sr * 0.01))          # 10 ms frames
    n = audio.size // win
    if n < 2:
        return audio
    frames = audio[: n * win].reshape(n, win)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)) + 1e-12
    peak = float(rms.max())
    if peak <= 1e-9:
        return audio
    db = 20.0 * np.log10(rms / peak)
    voiced = np.where(db > thresh_db)[0]
    if voiced.size == 0:
        return audio
    pad = max(1, int(keep_ms / 10))
    a = max(0, voiced[0] - pad) * win
    b = min(n, voiced[-1] + 1 + pad) * win
    out = audio[a:b]
    return out if out.size else audio


def _write_clip(path, audio, sr):
    sf.write(path, audio, sr, subtype="PCM_16")
    info = sf.info(path)
    if int(info.samplerate) != int(sr):
        raise RuntimeError(
            f"sample-rate header mismatch for {path}: wrote {sr} "
            f"but file reports {info.samplerate}")
    return int(info.samplerate), int(info.frames)


def _synth_phrases(voicer, parts, slots, voice, prompt):
    """Synthesize each phrase and reassemble with the ORIGINAL pause timing.

    Each phrase is placed at its own source offset, so the gaps between phrases
    are exactly the gaps the original actor left. Every phrase only needs a small
    rate correction of its own, which keeps the voice natural — far better than
    compressing one long blob.
    """
    import numpy as np

    base = float(slots[0][0])
    total = float(slots[-1][1]) - base
    sr_out = None
    rendered = []

    for text, (ps, pe) in zip(parts, slots):
        want = max(0.12, float(pe) - float(ps))
        a, sr = voicer.synth(text, voice, 1.0, prompt=prompt)
        sr_out = sr_out or sr
        got = len(a) / float(sr) if sr else 0.0
        # Gentle per-phrase pace correction only (never harsh).
        if got > want * 1.12 and got > 0:
            need = min(1.35, got / want)
            try:
                a2, sr2 = voicer.synth(text, voice, need, prompt=prompt)
                if a2.size:
                    a, sr = a2, sr2
            except Exception:
                pass
        rendered.append((float(ps) - base, a, sr))

    if sr_out is None:
        raise RuntimeError("no phrase audio")

    # Canvas long enough for the utterance plus any final overrun.
    tail = max((off + (len(a) / float(sr)) for off, a, sr in rendered),
               default=total)
    canvas = np.zeros(int(max(total, tail) * sr_out) + sr_out // 20,
                      dtype=np.float32)
    for off, a, sr in rendered:
        if sr != sr_out and a.size:
            idx = np.linspace(0, len(a) - 1, int(len(a) * sr_out / sr))
            a = np.interp(idx, np.arange(len(a)), a).astype(np.float32)
        p = int(max(0.0, off) * sr_out)
        end = min(canvas.size, p + a.size)
        if end > p:
            canvas[p:end] += a[: end - p]
    peak = float(np.max(np.abs(canvas))) if canvas.size else 0.0
    if peak > 1.0:
        canvas = canvas / peak * 0.99
    return canvas, sr_out


def synth_gcloud(segments, speaker_refs, indic_refs, target_lang, seg_dir,
                 vocals_wav=None):
    """Stage-6 backend: per-speaker voices, emotion transferred from the
    original performance, and exact slot fitting.

    Mirrors synth_indic's contract: returns [(start, end, wav_path), ...].
    `vocals_wav` (the separated original speech) is used to measure each
    segment's delivery so Gemini-TTS can mirror it.
    """
    os.makedirs(seg_dir, exist_ok=True)
    voicer = ChirpHDVoicer(target_lang)

    # Load the original vocals once so we can analyse delivery per segment.
    src_mono, src_sr = None, None
    if vocals_wav and os.path.exists(vocals_wav) and USE_GEMINI:
        try:
            d, src_sr = sf.read(vocals_wav, always_2d=True)
            src_mono = d.mean(axis=1).astype(np.float32)
        except Exception:
            src_mono, src_sr = None, None

    # Reference clip per speaker (used only for gender estimation).
    refs = {}
    for spk, val in (indic_refs or {}).items():
        refs[spk] = val[0] if isinstance(val, (tuple, list)) else val
    for spk, p in (speaker_refs or {}).items():
        refs.setdefault(spk, p)

    speakers = sorted({seg.get("speaker", 0) for seg in segments})
    voices = assign_voices(speakers, refs)

    # Per-segment voice plan: pitch decides gender (diarization alone is not
    # reliable enough and was giving male characters female voices).
    if src_mono is None and vocals_wav and os.path.exists(vocals_wav):
        try:  # needed for pitch even when Chirp3-HD engine is selected
            _d, src_sr = sf.read(vocals_wav, always_2d=True)
            src_mono = _d.mean(axis=1).astype(np.float32)
        except Exception:
            pass
    seg_voice = build_voice_plan(segments, src_mono, src_sr, voices)

    # Tone matching: audition voices against each speaker's real voice and keep
    # the closest, plus a mild pitch alignment. This is how we get as near to the
    # original timbre as possible without true cloning (unavailable on GCP here).
    matched = {}
    if src_mono is not None and os.environ.get("MATCH_VOICES", "1") == "1":
        try:
            matched = match_voices(voicer, segments, src_mono, src_sr, emit=_emit)
        except Exception:
            matched = {}
    if matched:
        for i, seg in enumerate(segments):
            m = matched.get(seg.get("speaker", 0))
            if m:
                seg_voice[i] = m["voice"]

    # Delivery instructions computed relative to this video's own baseline.
    expr_plan = {}
    if src_mono is not None and USE_GEMINI:
        try:
            expr_plan = build_expression_plan(segments, src_mono, src_sr)
        except Exception:
            expr_plan = {}

    engine = f"Gemini-TTS ({GEMINI_MODEL})" if USE_GEMINI else "Chirp3-HD"
    shown = {s: (matched.get(s, {}).get("voice") or seg_voice.get(0)
                 or voices.get(s)) for s in speakers}
    _emit("synthesize", 62,
          f"Google {engine}: {len(speakers)} speaker(s) -> "
          + ", ".join(f"spk{s}:{shown.get(s)}" for s in speakers),
          device="Cloud")

    # ------------------------------------------------------------------
    # Fit by REWRITING, not by stretching.
    #
    # Time-stretching is what makes a dub sound robotic. So instead of forcing
    # over-long speech into a slot, we synthesize at natural pace, measure the
    # real duration, and ask the language model to shorten the specific lines
    # that overran — then re-synthesize those. After a couple of rounds almost
    # every line fits on its own and needs no stretching at all, which is what
    # keeps the voice natural.
    # ------------------------------------------------------------------
    rounds = int(os.environ.get("FIT_ROUNDS", "3"))
    tol = float(os.environ.get("FIT_TOLERANCE", "1.08"))  # allow 8% overrun
    # Aim comfortably UNDER the slot when rewriting: asking for exactly the slot
    # leaves no margin, and the synthesizer's duration varies run to run.
    aim = float(os.environ.get("FIT_AIM", "0.92"))
    cache = {}      # index -> (audio, sr)
    prompts = {}    # index -> delivery prompt

    # ---------- Prosodic alignment ----------
    # Match the ORIGINAL speech-pause arrangement, not just total duration. We
    # find the pauses inside each source utterance, have the model split the
    # translation into the same number of phrases, then synthesize and place each
    # phrase at its own source time. This is what the dubbing literature calls
    # prosodic alignment, and it is the difference between "roughly the right
    # length" and actually being in sync.
    phrase_plan = {}
    phrase_parts = {}
    if src_mono is not None and os.environ.get("USE_PROSODIC", "1") == "1":
        try:
            from prosodic import build_phrase_plan
            from gemini_audio import split_into_phrases, budget_for
            phrase_plan = build_phrase_plan(segments, src_mono, src_sr)
            multi = []
            for i, seg in enumerate(segments):
                ph = phrase_plan.get(i) or []
                text = (seg.get("translated") or "").strip()
                if len(ph) > 1 and text:
                    multi.append({
                        "i": i, "text": text,
                        "phrases": [
                            {"seconds": round(b - a, 2),
                             "budget": budget_for(b - a, target_lang)}
                            for (a, b) in ph],
                    })
            if multi:
                _emit("synthesize", 61,
                      f"Prosodic alignment: splitting {len(multi)} line(s) "
                      "to match original pauses", device="Cloud")
                got = split_into_phrases(multi, target_lang)
                for i, parts in got.items():
                    ph = phrase_plan.get(i) or []
                    # Only use the split when the model returned one part per slot.
                    if len(parts) == len(ph):
                        phrase_parts[i] = parts
        except Exception as e:
            _emit("synthesize", 61, f"Prosodic alignment skipped ({e})")

    pieces = []
    total = len(segments)
    report = []
    if matched:
        report.append("VOICE MATCHING (closest preset + pitch alignment)")
        for s in sorted(matched):
            m = matched[s]
            report.append(
                f"  spk{s}: {m['voice']}  original_f0={m['target_f0']}Hz "
                f"voice_f0={m['voice_f0']}Hz pitch_ratio={m['pitch_ratio']} "
                f"distance={m['dist']}")
        report.append("")
    # --- Round 0: synthesize everything at natural pace (no fitting) ---
    for i, seg in enumerate(segments):
        spk = seg.get("speaker", 0)
        voice = seg_voice.get(i) or voices.get(spk, MALE_VOICES[0])
        text = (seg.get("translated") or seg.get("text") or "").strip()
        if not text:
            continue
        stated_emotion = (seg.get("emotion") or "").strip()
        if stated_emotion:
            prompts[i] = (f"Deliver this line as: {stated_emotion}. Match the "
                          "emotion and energy of the original performance and "
                          "sound like a real person, not a narrator.")
        else:
            prompts[i] = expr_plan.get(i, (None, {}))[0]
        try:
            parts = phrase_parts.get(i)
            slots = phrase_plan.get(i)
            if parts and slots and len(parts) == len(slots) > 1:
                a, sr = _synth_phrases(voicer, parts, slots, voice, prompts[i])
            else:
                a, sr = voicer.synth(text, voice, 1.0, prompt=prompts[i])
            cache[i] = (a, sr)
        except Exception as e:
            print(json.dumps({"index": i, "error": str(e)}), flush=True)
        done = i + 1
        _emit("synthesize", min(62 + int(12 * done / max(1, total)), 74),
              f"Voicing {done}/{total}", device="Cloud")

    # --- Rounds 1..N: shorten the lines that overran, then re-synthesize ---
    # Lines shorter than this fraction of their slot leave an audible hole, so
    # they get EXPANDED. Fitting has to work in both directions: a shrink-only
    # loop overshoots and produces dead air (measured 0.59x on a real line).
    short_floor = float(os.environ.get("FIT_SHORT_FLOOR", "0.85"))

    for rnd in range(rounds):
        over, under = [], []
        for i, seg in enumerate(segments):
            if i not in cache:
                continue
            slot = max(0.05, float(seg["end"]) - float(seg["start"]))
            a, sr = cache[i]
            got = len(a) / float(sr)
            cur = (seg.get("translated") or "").strip()
            if not cur:
                continue
            if got > slot * tol:
                # Scale the character target by the measured overrun, aiming
                # under the slot so there is margin for synthesis variance.
                tgt = max(3, int(len(cur) * (slot * aim) / got))
                over.append({"i": i, "seconds": round(slot, 2),
                             "budget": tgt, "dst": cur})
            elif got < slot * short_floor and slot >= 0.7:
                # Too short: ask for a slightly fuller, still-natural rendering
                # so the line covers the on-screen mouth movement.
                tgt = max(len(cur) + 3, int(len(cur) * (slot * 0.97) / max(0.05, got)))
                under.append({"i": i, "seconds": round(slot, 2),
                              "budget": tgt, "dst": cur})
        if not over and not under:
            break
        _emit("synthesize", 76,
              f"Refitting {len(over)} long / {len(under)} short line(s) "
              f"(round {rnd + 1}/{rounds})", device="Cloud")
        fixes = {}
        try:
            from gemini_audio import rewrite_to_fit, expand_to_fit
            if over:
                fixes.update(rewrite_to_fit(over, target_lang))
            if under:
                fixes.update(expand_to_fit(under, target_lang))
        except Exception:
            fixes = fixes or {}
        if not fixes:
            break
        for i, new_text in fixes.items():
            if not (0 <= i < len(segments)) or not new_text:
                continue
            segments[i]["translated"] = new_text
            spk = segments[i].get("speaker", 0)
            voice = seg_voice.get(i) or voices.get(spk, MALE_VOICES[0])
            # A rewritten line invalidates its old phrase split.
            phrase_parts.pop(i, None)
            try:
                a, sr = voicer.synth(new_text, voice, 1.0, prompt=prompts.get(i))
                cache[i] = (a, sr)
            except Exception:
                pass

    for i, seg in enumerate(segments):
        spk = seg.get("speaker", 0)
        voice = seg_voice.get(i) or voices.get(spk, MALE_VOICES[0])
        text = (seg.get("translated") or seg.get("text") or "").strip()
        out_path = os.path.join(seg_dir, f"seg_{i:04d}.wav")
        slot = max(0.0, float(seg["end"]) - float(seg["start"]))

        if not text:
            report.append(f"seg {i}: SKIPPED (empty text)")
            continue

        # Delivery instruction. Prefer the audio model's own description of how
        # the line was performed — it heard the original, whereas the acoustic
        # heuristic only measures loudness/pitch and previously labelled every
        # line identically.
        stated_emotion = (seg.get("emotion") or "").strip()
        if stated_emotion:
            prompt = (f"Deliver this line as: {stated_emotion}. Match the "
                      "emotion and energy of the original performance and "
                      "sound like a real person, not a narrator.")
            dbg = {"style": stated_emotion}
        else:
            prompt, dbg = expr_plan.get(i, (None, {}))

        try:
            if i in cache:
                # Natural-pace audio whose TEXT was already rewritten to fit.
                audio, sr = cache[i]
                natural = len(audio) / float(sr)
                rate = 1.0
                # Only if it still overruns do we apply a gentle pace nudge.
                if slot > 0.05 and natural > slot * tol:
                    need = natural / slot
                    # A modest pace nudge is much less noticeable than a line
                    # running 50% past its slot, so allow up to 1.45x here.
                    if need <= 1.45:
                        audio, sr = voicer.synth(text, voice,
                                                 min(1.45, need), prompt=prompt)
                        rate = round(min(1.45, need), 2)
                        natural = len(audio) / float(sr)
            else:
                audio, sr, rate, natural = voicer.synth_fitted(
                    text, voice, slot, prompt=prompt)
            # Pitch shifting is OFF by default. Moving a preset voice's pitch
            # without moving its formants makes it sound synthetic and
            # androgynous — it was a contributor to the "robotic / wrong gender"
            # complaint. Voice SELECTION (auditioning) gets us similarity
            # without touching the signal. Enable with MATCH_PITCH=1 if wanted.
            m = matched.get(spk)
            if (m and m.get("target_f0")
                    and os.environ.get("MATCH_PITCH", "0") == "1"):
                audio = align_pitch_to(audio, sr, m["target_f0"])
            _write_clip(out_path, audio, sr)
            got = len(audio) / float(sr)
            pieces.append((float(seg["start"]), float(seg["end"]), out_path))
            from prosodic import speech_overlap
            so = speech_overlap(slot, got)
            nph = len(phrase_parts.get(i) or phrase_plan.get(i) or [1])
            report.append(
                f"seg {i}: spk{spk} {voice} slot={slot:.2f}s "
                f"natural={natural:.2f}s rate={rate:.2f} got={got:.2f}s "
                f"SO={so:.2f} phrases={nph}"
                + (f"\n        style={dbg.get('style','-')} "
                   f"[db={round(dbg['db'],1) if dbg.get('db') is not None else '-'} "
                   f"f0={round(dbg.get('f0',0),1)} "
                   f"spread={round(dbg.get('spread',0),3)} "
                   f"rate={round(dbg.get('rate',0),2)}]"
                   if dbg else ""))
            done = i + 1
            pct = 60 + int(25 * done / max(1, total))
            _emit("synthesize", min(pct, 85),
                  f"Voiced segment {done}/{total}", device="Cloud")
        except Exception as e:
            report.append(f"seg {i}: FAILED {e}")
            print(json.dumps({"index": i, "error": str(e)}), flush=True)

    if not pieces:
        raise RuntimeError("Google Chirp3-HD produced no audio.")

    # Leave a trace of voice assignment + timing decisions for inspection.
    try:
        with open(os.path.join(seg_dir, "gcloud_tts_report.txt"), "w",
                  encoding="utf-8") as f:
            f.write("\n".join(report))
    except Exception:
        pass
    return pieces
