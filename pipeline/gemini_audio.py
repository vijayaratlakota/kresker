"""
Gemini native-audio dubbing script builder (replaces Stages 3-5).

Why this replaces the previous chain
------------------------------------
Every quality complaint traced back to the text being wrong before TTS ever ran:

* Google STT was handed "auto" as the language and defaulted to en-IN, so Hindi
  speech came back romanised ("Hay Maine Apna Ghar Chhod Diya") and every
  downstream translation was built on gibberish.
* Whisper "base" on CPU hallucinated outright ("I have not pregnant for a while"
  for "मैंने थोड़ी सी प्रेग्नेंट कर दी").
* Speaker-embedding diarization collapsed 3 characters into 1 speaker.
* Pitch-based gender guessing labelled high-pitched MALE voices as female, which
  is why a male character was dubbed with a female voice.

Gemini 2.5 Pro accepts the audio directly and returns, in one call: detected
language, per-speaker identity WITH gender judged from the voice, per-line
timestamps, a delivery/emotion note, a native-script transcription, and a
translation. Measured on real material it got the language, all three speakers,
their gender, and the actual dialogue right where the previous chain failed.

A second pass enforces the per-line character budget, because the model reliably
overshoots length on the first attempt.
"""

import base64
import io
import json
import math
import os

import numpy as np
import soundfile as sf

TEXT_MODEL = os.environ.get("GEMINI_AUDIO_MODEL", "gemini-2.5-pro")
MAX_INLINE_SECONDS = float(os.environ.get("GEMINI_AUDIO_MAX_SECONDS", "600"))

# Translation gets its own model, chosen by measurement rather than by version
# number. compare_translate_models.py scored the candidates on a Hindi->Telugu
# set with per-line character budgets (budget adherence is what decides whether
# a line has to be time-compressed into robotness or leaves a silent gap):
#
#   gemini-3.1-pro-preview   mean budget error 0.047   6/6 lines in range
#   gemini-3.5-flash                            0.104   5/6
#   gemini-2.5-pro                              0.141   4/6
#   gemini-3.1-flash-lite                       0.291   1/6
#   gemini-3.6-flash                            0.376   1/6
#
# So the newest model is NOT the best one here: 3.6-flash was the worst of the
# set, consistently overshooting the budget. 3.1-pro-preview also produced the
# most colloquial Telugu.
#
# There is no `gemini-3.1-flash` text model on Vertex (404). The 3.1 family
# publishes `flash-lite` and `pro-preview`; the 3.1 "flash" seen elsewhere is
# the TTS variant.
TRANSLATE_MODEL = os.environ.get("GEMINI_TRANSLATE_MODEL",
                                 "gemini-3.1-pro-preview")
# Preview models can be withdrawn or throttled, and a failed translation kills
# the whole dub, so fall back down the measured ranking.
TRANSLATE_FALLBACKS = [m for m in os.environ.get(
    "GEMINI_TRANSLATE_FALLBACKS", "gemini-3.5-flash,gemini-2.5-pro").split(",")
    if m.strip()]

LANG_NAME = {
    "te": "Telugu", "hi": "Hindi", "ta": "Tamil", "kn": "Kannada",
    "ml": "Malayalam", "bn": "Bengali", "gu": "Gujarati", "mr": "Marathi",
    "pa": "Punjabi", "ur": "Urdu", "en": "English", "es": "Spanish",
    "fr": "French", "de": "German", "it": "Italian", "pt": "Portuguese",
    "ru": "Russian", "ja": "Japanese", "ko": "Korean", "zh-cn": "Chinese",
    "ar": "Arabic", "tr": "Turkish", "nl": "Dutch", "pl": "Polish",
}

# Comfortable speaking rate (chars/sec) used for the length budget.
CHARS_PER_SEC = {
    "te": 10.5, "hi": 11.5, "ta": 10.0, "kn": 10.0, "ml": 10.0,
    "bn": 11.0, "gu": 11.5, "mr": 11.0, "pa": 11.5, "ur": 11.5,
    "en": 14.0, "es": 14.0, "fr": 14.0, "de": 13.0, "it": 14.0,
    "pt": 14.0, "ru": 12.0, "ja": 8.0, "ko": 9.0, "zh-cn": 6.0,
    "ar": 12.0, "tr": 12.0, "nl": 13.0, "pl": 12.0,
}


def budget_for(seconds, lang, headroom=1.15):
    return max(6, int(seconds * CHARS_PER_SEC.get(lang, 11.0) * headroom))


def _project():
    proj = (os.environ.get("GEMINI_PROJECT")
            or os.environ.get("CHIRP_PROJECT")
            or os.environ.get("GOOGLE_CLOUD_PROJECT"))
    if proj:
        return proj
    import google.auth
    _, p = google.auth.default()
    if not p:
        raise RuntimeError("No GCP project for Gemini audio")
    return p


def _headers():
    import google.auth
    from google.auth.transport.requests import Request

    creds, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(Request())
    return {
        "Authorization": f"Bearer {creds.token}",
        "x-goog-user-project": _project(),
        "Content-Type": "application/json; charset=utf-8",
    }


def _url(model=None):
    proj = _project()
    return (f"https://aiplatform.googleapis.com/v1/projects/{proj}"
            f"/locations/global/publishers/google/models/"
            f"{model or TEXT_MODEL}:generateContent")


def _audio_b64(wav_path):
    """16 kHz mono WAV, base64 encoded. Returns (b64, duration_seconds)."""
    data, sr = sf.read(wav_path, always_2d=True)
    mono = data.mean(axis=1).astype(np.float32)
    if sr != 16000:
        try:
            import librosa
            mono = librosa.resample(mono, orig_sr=sr, target_sr=16000)
        except Exception:
            idx = np.linspace(0, len(mono) - 1, int(len(mono) * 16000 / sr))
            mono = np.interp(idx, np.arange(len(mono)), mono).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, np.clip(mono, -1, 1), 16000, format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode("ascii"), len(mono) / 16000.0


def _call(parts, timeout=900, model=None, max_tokens=16384):
    import requests
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "maxOutputTokens": max_tokens,
        },
    }
    r = requests.post(_url(model), headers=_headers(), json=body, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"Gemini audio {r.status_code}: {r.text[:220]}")
    payload = r.json()
    cands = payload.get("candidates") or []
    if not cands:
        raise RuntimeError("Gemini audio returned no candidates")
    txt = cands[0]["content"]["parts"][0]["text"]
    return json.loads(txt)


def translate_call(parts, timeout=600, max_tokens=16384, emit=None):
    """_call, but on the translation model with automatic fallback.

    Used for every text-only translation/length pass. Kept separate from _call
    so the audio-listening pass and the translation pass can use different
    models: the audio pass needs native audio understanding, the translation
    pass needs tight length control (see TRANSLATE_MODEL).
    """
    last = None
    for model in [TRANSLATE_MODEL] + TRANSLATE_FALLBACKS:
        try:
            return _call(parts, timeout=timeout, model=model.strip(),
                         max_tokens=max_tokens)
        except Exception as e:
            last = e
            if emit:
                emit("translate", 50,
                     f"{model.strip()} failed ({str(e)[:70]}); trying next model")
    raise RuntimeError(f"All translation models failed: {last}")


# Source characters per request for any pass that sends a LIST of lines.
#
# The response cap is 16384 tokens and Indic scripts tokenise at close to one
# token per character, so a long video can ask for more output than a single call
# can return. When that happens the model does not error: it stops mid-string and
# the JSON parse fails with "Unterminated string". Measured on a 9 minute video,
# 146 Hindi lines to Telugu broke all three translation models this way.
BATCH_CHARS = int(os.environ.get("GEMINI_BATCH_CHARS", "2500"))
BATCH_LINES = int(os.environ.get("GEMINI_BATCH_LINES", "40"))


def call_lines_in_batches(items, build_prompt, timeout=300, emit=None,
                          key="dst"):
    """Run a list-of-lines prompt in batches and merge the answers by index.

    build_prompt(batch) -> prompt string. Every pass here returns
    {"lines":[{"i":int, <key>:str}]}, so merging is by the model's own index and
    batch boundaries cannot reorder anything.
    """
    if not items:
        return {}
    batches, cur, chars = [], [], 0
    for it in items:
        n = len(str(it.get("dst") or it.get("src") or it.get("text") or ""))
        if cur and (chars + n > BATCH_CHARS or len(cur) >= BATCH_LINES):
            batches.append(cur)
            cur, chars = [], 0
        cur.append(it)
        chars += n
    if cur:
        batches.append(cur)

    out = {}
    for n, batch in enumerate(batches, start=1):
        try:
            data = translate_call([{"text": build_prompt(batch)}],
                                  timeout=timeout, emit=emit)
        except Exception as e:
            if emit:
                emit("translate", 52,
                     f"batch {n}/{len(batches)} failed ({str(e)[:70]}); "
                     f"those lines keep their current text")
            continue
        for L in (data.get("lines") if isinstance(data, dict) else data) or []:
            if not isinstance(L, dict):
                continue
            try:
                i = int(L["i"])
            except (KeyError, TypeError, ValueError):
                continue
            t = (L.get(key) or "").strip()
            if t:
                out[i] = t
    return out


# Audio per transcription request.
#
# A whole 9-minute video in one call does not fit the 16384-token response cap: the
# transcript alone runs about 10000 Devanagari characters, which tokenise near one
# token each, and the model stops mid-string ("Unterminated string starting at: line 1
# column 153"). Same failure the translation passes had, same fix. 120 seconds is also
# the chunk size measured best for the streaming transcriber.
TRANSCRIBE_WINDOW_S = float(os.environ.get("GEMINI_TRANSCRIBE_WINDOW_S", "120"))


def transcribe_lines(wav_path, source_lang="auto", timeout=900, emit=None):
    """Transcribe audio to source-language lines with timings and speaker labels.

    Transcription only — no translation. Exists to REPAIR another recogniser's
    output rather than replace it: VoiceStudio's ASR produces the speaker
    identities its cloner needs, but it also silently stops early (measured: a
    transcript ending at 7.66 s on a 20.27 s video, leaving 65% of the speech with
    no dubbed voice at all). This supplies the missing lines while VoiceStudio
    keeps ownership of who is speaking.

    Long audio is transcribed in windows and stitched, because one call cannot answer
    for a whole video (see TRANSCRIBE_WINDOW_S).
    """
    import io as _io

    import soundfile as _sf

    total = _sf.info(wav_path).duration
    if total > TRANSCRIBE_WINDOW_S * 1.2:
        x, sr = _sf.read(wav_path, always_2d=True)
        mono = x.mean(axis=1)
        out = []
        n = int(math.ceil(total / TRANSCRIBE_WINDOW_S))
        for k in range(n):
            a = k * TRANSCRIBE_WINDOW_S
            b = min(total, a + TRANSCRIBE_WINDOW_S)
            piece = mono[int(a * sr):int(b * sr)]
            buf = _io.BytesIO()
            _sf.write(buf, np.clip(piece, -1, 1), sr, format="WAV",
                      subtype="PCM_16")
            tmp = wav_path + f".w{k}.wav"
            with open(tmp, "wb") as f:
                f.write(buf.getvalue())
            try:
                if emit:
                    emit("transcribe", 39,
                         f"Gemini transcribing {a:.0f}-{b:.0f}s "
                         f"(window {k+1} of {n})", device="Cloud")
                part = transcribe_lines(tmp, source_lang, timeout=timeout)
            except Exception as e:
                if emit:
                    emit("transcribe", 39,
                         f"window {k+1} of {n} failed ({str(e)[:60]})")
                part = []
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            # Shift into the file's own timeline, and clamp to the window: the
            # recogniser sometimes returns times past the audio it was given, which
            # would overlap the next window's first line.
            span = b - a
            for L in part:
                L["start"] = a + min(float(L["start"]), span)
                L["end"] = a + min(float(L["end"]), span)
                if L["end"] > L["start"]:
                    out.append(L)
        out.sort(key=lambda x: x["start"])
        return out

    b64, dur = _audio_b64(wav_path)
    hint = ("" if not source_lang or source_lang == "auto" else
            f"The spoken language is {LANG_NAME.get(source_lang, source_lang)}. ")
    prompt = f"""Transcribe this {dur:.1f} second audio completely and verbatim.

{hint}Requirements:
- Cover the ENTIRE duration, from 0.0 to {dur:.1f} seconds. Do not stop early.
- One entry per continuous utterance. Split when the speaker changes or after a clear pause.
- "start" and "end" in seconds, accurate to about 0.1 s, and they must not overlap.
- "speaker": a stable label per voice ("S1", "S2", ...). Use the same label whenever the same voice returns.
- "text": exactly the words spoken, in the ORIGINAL language and its native script. Do not translate. Do not clean up grammar.
- Skip music, noise and silence. Only actual speech.

Return ONLY JSON: {{"lines":[{{"start":0.0,"end":1.5,"speaker":"S1","text":"..."}}]}}"""
    if emit:
        emit("transcribe", 39,
             f"Gemini transcribing {dur:.0f}s of audio to fill transcript gaps",
             device="Cloud")
    data = _call([{"inlineData": {"mimeType": "audio/wav", "data": b64}},
                  {"text": prompt}], timeout=timeout)
    # The model sometimes answers with a bare JSON array instead of the requested
    # {"lines": [...]} object. Treating that as a failure wasted a whole retry.
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = data.get("lines") or data.get("segments") or []
    else:
        rows = []
    out = []
    for L in rows:
        if not isinstance(L, dict):
            continue
        try:
            a, b = float(L["start"]), float(L["end"])
            t = (L.get("text") or "").strip()
        except Exception:
            continue
        if t and b > a:
            out.append({"start": a, "end": min(b, dur),
                        "speaker": str(L.get("speaker") or "S1"), "text": t})
    out.sort(key=lambda x: x["start"])

    # Drop repeated lines. The model sometimes emits the same utterance twice at
    # different timestamps — a real job came back with "Just swatting flies." and
    # "They added me to their group..." each appearing twice, so the dub said them
    # twice. Only near-in-time repeats are removed, since a speaker genuinely
    # repeating themselves much later is legitimate.
    deduped = []
    for L in out:
        dup = False
        for prev in reversed(deduped):
            if L["start"] - prev["end"] > 8.0:
                break
            if prev["text"].strip() == L["text"].strip():
                dup = True
                break
        if not dup:
            deduped.append(L)
    return deduped


def _script_prompt(src_hint, dst_name):
    hint = ("The spoken language is expected to be "
            f"{LANG_NAME.get(src_hint, src_hint)}. "
            if src_hint and src_hint != "auto" else
            "Identify the spoken language yourself. ")
    return f"""You are a professional dubbing director. LISTEN to this audio carefully.

{hint}Produce a precise dubbing script.

For EVERY distinct utterance — including short exclamations, repeated calls, and shouted or overlapping lines — output:
- "start","end": accurate timestamps in seconds, taken from the audio
- "speaker": stable id per distinct voice ("S1","S2",...)
- "gender": "male" or "female", judged from the ACTUAL VOICE you hear. Do not guess from the name or the content. Note that young or excited male voices can be high pitched; still label them male if the voice is male.
- "emotion": short delivery note (e.g. "angry shout", "nervous confession", "soft worried", "excited")
- "src": exact transcription in the language's NATIVE script of what is actually said
- "{dst_name.lower()}": natural spoken {dst_name} translation of that line

Rules:
- Transcribe what you HEAR. Never romanise; always use the native script. Never invent, censor or paraphrase.
- Split at natural sentence or breath boundaries. Keep every line under about 6 seconds.
- Do not merge different speakers into one line.
- Cover the whole audio; do not skip quiet or shouted parts.

Return ONLY JSON:
{{"language":"<iso code>",
  "speakers":[{{"id":"S1","gender":"male","note":"short description"}}],
  "lines":[{{"start":0.0,"end":0.5,"speaker":"S1","gender":"male","emotion":"...","src":"...","{dst_name.lower()}":"..."}}]}}"""


def _shrink_prompt(items, dst_name):
    return f"""These {dst_name} dubbing lines are TOO LONG to speak inside their time slots.

Rewrite each so it means the same thing but fits within `budget` characters. Use shorter, colloquial spoken {dst_name}. Keep names, exclamations and emotional force. Do not add anything. Do not pad.

Return ONLY JSON: {{"lines":[{{"i":0,"dst":"..."}}]}}

Lines:
{json.dumps(items, ensure_ascii=False)}"""


def rewrite_to_fit(items, target_lang):
    """Shorten dubbing lines that overran their slot when actually spoken.

    This closes the loop that makes stretching unnecessary: we measured the real
    synthesized duration, so we know exactly which lines are too long and by how
    much. Rewriting the words is what keeps the delivery natural — compressing
    the audio instead is what made earlier dubs sound robotic.

    items: [{"i":int, "seconds":float, "budget":int, "dst":str}]
    Returns {index: new_text}.
    """
    dst_name = LANG_NAME.get(target_lang, target_lang)

    def build(batch):
        return f"""These {dst_name} dubbing lines are TOO LONG: when spoken aloud they overrun the time available on screen.

For each line, rewrite it so a voice actor can say it comfortably in `seconds` seconds. Aim for at most `budget` characters.

Requirements:
- Keep the same meaning, tone and emotional force.
- Use short, natural, colloquial spoken {dst_name} — contract and simplify.
- Drop filler words, honorifics and repetition before losing meaning.
- Keep names and interjections.
- Never pad. Shorter than the budget is fine.
- Return the SAME index for each line.

Return ONLY JSON: {{"lines":[{{"i":0,"dst":"..."}}]}}

Lines:
{json.dumps(batch, ensure_ascii=False)}"""

    return call_lines_in_batches(items, build, timeout=300)


def expand_to_fit(items, target_lang):
    """Lengthen dubbing lines that came out too SHORT for their slot.

    The counterpart to rewrite_to_fit. A shrink-only loop overshoots and leaves
    dead air where the character is still visibly speaking (measured 0.59x of the
    slot on a real line, i.e. a 1.2 s hole). Expanding uses natural fuller
    phrasing rather than padding, so the line covers the mouth movement.

    items: [{"i":int, "seconds":float, "budget":int, "dst":str}]
    Returns {index: new_text}.
    """
    dst_name = LANG_NAME.get(target_lang, target_lang)

    def build(batch):
        return f"""These {dst_name} dubbing lines are TOO SHORT: spoken aloud they finish well before the character stops speaking on screen, leaving silence.

For each line, rewrite it so a voice actor naturally fills about `seconds` seconds. Aim for roughly `budget` characters.

Requirements:
- Keep exactly the same meaning, tone and emotional force.
- Expand naturally: use the fuller, more conversational way a native {dst_name} speaker would say it, add natural connectives or a natural interjection that fits the emotion.
- Do NOT invent new facts, and do NOT repeat words mechanically or pad with filler.
- Keep names and interjections.
- Return the SAME index for each line.

Return ONLY JSON: {{"lines":[{{"i":0,"dst":"..."}}]}}

Lines:
{json.dumps(batch, ensure_ascii=False)}"""

    return call_lines_in_batches(items, build, timeout=300)


def translate_at_budget(items, source_lang, target_lang, emit=None):
    """Translate source lines again, to a corrected character budget.

    Exists because the first translation has to guess how fast the voice will speak.
    The budget is seeded from the language's natural human rate, and on a cloned
    voice measured at 24 chars/second against Telugu's 10.5 that guess asked for
    about half the words each slot could hold.

    Lengthening the TRANSLATION to fix that is the wrong move: there is nothing more
    to say, so the model pads, and padding is content the picture does not show.
    Translating the SOURCE again with the right budget produces a fuller rendering
    of what was actually said.

    items: [{"i":int, "seconds":float, "budget":int, "src":str}]
    Returns {index: translation}.
    """
    src_name = LANG_NAME.get((source_lang or "").lower(), "the source language")
    dst_name = LANG_NAME.get(target_lang, target_lang)

    def build(batch):
        return f"""You are writing a dubbing script, translating {src_name} into {dst_name}.

Each line gives its index (i), the seconds available on screen, a character budget, and the source line (src).

For each line produce "dst": a natural, colloquial spoken {dst_name} translation of that source line.

Length rule:
- Aim for about `budget` characters. The budget is measured from the actual speaking voice, so a line well under it leaves the character's mouth moving in silence.
- Use the fuller, more natural phrasing a native speaker would use out loud, rather than the shortest possible wording.
- Do NOT add facts, jokes, names or sentences that are not in the source. If the source is short, the translation stays short.
- Never repeat words or add filler to reach the budget.
- Return the SAME index for every line.

Return ONLY JSON: {{"lines":[{{"i":0,"dst":"..."}}]}}

Lines:
{json.dumps(batch, ensure_ascii=False)}"""

    return call_lines_in_batches(items, build, timeout=600, emit=emit)


def split_into_phrases(items, target_lang):
    """Split each translation into phrases that match the source pause structure.

    items: [{"i":int, "text":str,
             "phrases":[{"seconds":float,"budget":int}, ...]}]
    Returns {index: [part, ...]}.
    """
    from prosodic import split_prompt
    dst_name = LANG_NAME.get(target_lang, target_lang)
    data = translate_call([{"text": split_prompt(items, dst_name)}], timeout=300)
    out = {}
    for L in data.get("lines", []):
        try:
            i = int(L["i"])
            parts = [str(p).strip() for p in (L.get("parts") or []) if str(p).strip()]
            if parts:
                out[i] = parts
        except Exception:
            continue
    return out


def build_script(audio_wav, source_lang, target_lang, emit=None):
    """Listen to `audio_wav` and return (segments, detected_lang, speakers, report).

    segments: [{"start","end","text","translated","speaker","gender","emotion"}]
    """
    dst_name = LANG_NAME.get(target_lang, target_lang)
    dst_key = dst_name.lower()

    b64, dur = _audio_b64(audio_wav)
    if dur > MAX_INLINE_SECONDS:
        raise RuntimeError(
            f"audio {dur:.0f}s exceeds inline limit {MAX_INLINE_SECONDS:.0f}s")

    if emit:
        emit("transcribe", 36,
             f"Gemini listening to {dur:.0f}s of audio", device="Cloud")

    data = _call([
        {"inlineData": {"mimeType": "audio/wav", "data": b64}},
        {"text": _script_prompt(source_lang, dst_name)},
    ])

    detected = (data.get("language") or source_lang or "auto").split("-")[0]
    speakers_meta = {}
    for s in data.get("speakers", []):
        sid = str(s.get("id", "")).strip()
        if sid:
            speakers_meta[sid] = {
                "gender": (s.get("gender") or "male").strip().lower(),
                "note": s.get("note", ""),
            }

    raw_lines = data.get("lines") or []
    if not raw_lines:
        raise RuntimeError("Gemini audio produced no lines")

    # Stable numeric speaker ids in order of first appearance.
    order, remap = [], {}
    segments = []
    for L in raw_lines:
        try:
            st, en = float(L["start"]), float(L["end"])
        except Exception:
            continue
        if en <= st:
            en = st + 0.4
        sid = str(L.get("speaker", "S1")).strip() or "S1"
        if sid not in remap:
            remap[sid] = len(order)
            order.append(sid)
        gender = (L.get("gender")
                  or speakers_meta.get(sid, {}).get("gender") or "male")
        segments.append({
            "start": st, "end": en,
            "text": (L.get("src") or "").strip(),
            "translated": (L.get(dst_key) or L.get("dst") or "").strip(),
            "speaker": remap[sid],
            "speaker_label": sid,
            "gender": str(gender).strip().lower(),
            "emotion": (L.get("emotion") or "").strip(),
        })

    segments.sort(key=lambda s: s["start"])

    # Enforce the length budget: the first pass reliably overshoots.
    over = []
    for i, seg in enumerate(segments):
        b = budget_for(seg["end"] - seg["start"], target_lang)
        if len(seg["translated"]) > b:
            over.append({"i": i, "budget": b, "dst": seg["translated"]})
    if over:
        if emit:
            emit("translate", 52,
                 f"Tightening {len(over)} long line(s) to fit timing")
        try:
            shrunk = call_lines_in_batches(
                over, lambda batch: _shrink_prompt(batch, dst_name),
                timeout=300, emit=emit)
            for i, new in shrunk.items():
                if 0 <= i < len(segments):
                    segments[i]["translated"] = new
        except Exception:
            pass

    report = [f"LANGUAGE: {detected}", "", "SPEAKERS:"]
    for sid in order:
        meta = speakers_meta.get(sid, {})
        report.append(f"  {sid} -> spk{remap[sid]}: "
                      f"{meta.get('gender', '?')} — {meta.get('note', '')}")
    report += ["", "LINES:"]
    for i, seg in enumerate(segments):
        b = budget_for(seg["end"] - seg["start"], target_lang)
        n = len(seg["translated"])
        report.append(
            f"[{i:02d}] {seg['start']:.2f}-{seg['end']:.2f}s "
            f"spk{seg['speaker']}({seg['gender']}) {seg['emotion']} "
            f"budget={b} got={n}{'  OVER' if n > b else ''}")
        report.append(f"     SRC: {seg['text']}")
        report.append(f"     DST: {seg['translated']}")

    return segments, detected, speakers_meta, report
