"""
Google Speech-to-Text transcription WITH speaker diarization (Stage 3 upgrade).

Why this exists
---------------
Two problems in the local pipeline were traced to Stage 3, not to the TTS:

1. Whisper "base" (the CPU default) mis-transcribed Hindi speech into English
   nonsense ("I have not pregnant for a while", "I am a saloni"), so the dub was
   faithfully speaking garbage.
2. Speaker-embedding diarization (Resemblyzer + clustering) collapsed every
   character into one speaker on real material, so a male character was voiced
   by a female voice.

Google STT fixes both at once: it returns accurate Devanagari for Hindi AND
per-word `speakerTag` values, which is real diarization.

Note on Video Intelligence: its speech transcription supports English (US) only,
so it cannot transcribe Hindi/Telugu material. Google's own documentation
directs non-English work to Speech-to-Text, which is what we use here.

Speaker gender is NOT provided by the API, so the caller still derives it from
measured pitch per speaker (see gcloud_dub.build_voice_plan).
"""

import base64
import io
import json
import os

import numpy as np
import soundfile as sf

STT_SYNC = "https://speech.googleapis.com/v1p1beta1/speech:recognize"
STT_LONG = "https://speech.googleapis.com/v1p1beta1/speech:longrunningrecognize"

# Sync recognize is limited to about a minute of audio; longer goes async.
SYNC_LIMIT_SECONDS = 55.0

# Our short codes -> STT BCP-47 codes.
STT_LANG = {
    "hi": "hi-IN", "te": "te-IN", "ta": "ta-IN", "kn": "kn-IN", "ml": "ml-IN",
    "bn": "bn-IN", "gu": "gu-IN", "mr": "mr-IN", "pa": "pa-IN", "ur": "ur-IN",
    "en": "en-IN", "es": "es-ES", "fr": "fr-FR", "de": "de-DE", "ru": "ru-RU",
    "ja": "ja-JP", "ko": "ko-KR", "zh-cn": "zh", "ar": "ar-XA", "pt": "pt-BR",
    "it": "it-IT", "nl": "nl-NL", "tr": "tr-TR", "pl": "pl-PL",
}


def _auth_headers():
    import google.auth
    from google.auth.transport.requests import Request

    creds, proj = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(Request())
    project = (os.environ.get("CHIRP_PROJECT")
               or os.environ.get("GOOGLE_CLOUD_PROJECT") or proj)
    return {
        "Authorization": f"Bearer {creds.token}",
        "x-goog-user-project": project or "",
        "Content-Type": "application/json; charset=utf-8",
    }


def _to_16k_mono_b64(wav_path):
    """STT wants 16 kHz mono LINEAR16. Returns (b64_content, duration_seconds)."""
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


def _secs(v):
    """Parse STT duration ('1.200s' or {'seconds':1,'nanos':...}) to float."""
    if v is None:
        return 0.0
    if isinstance(v, dict):
        return float(v.get("seconds", 0)) + float(v.get("nanos", 0)) / 1e9
    s = str(v)
    return float(s[:-1]) if s.endswith("s") else float(s)


def _request_body(content, lang_code, max_speakers):
    return {
        "config": {
            "encoding": "LINEAR16",
            "sampleRateHertz": 16000,
            "languageCode": lang_code,
            "enableAutomaticPunctuation": True,
            "enableWordTimeOffsets": True,
            "diarizationConfig": {
                "enableSpeakerDiarization": True,
                "minSpeakerCount": 1,
                "maxSpeakerCount": int(max_speakers),
            },
            "model": "latest_long",
        },
        "audio": {"content": content},
    }


def _collect_words(payload):
    """Flatten words (with speakerTag) from an STT response.

    With diarization enabled, STT repeats the full word list — annotated with
    speaker tags — in the FINAL result. Naively taking the longest list can drop
    speakers, so we prefer the list that carries the most DISTINCT speaker tags
    and only fall back to length as a tie-break.
    """
    best, best_key = [], (-1, -1)
    for res in payload.get("results", []):
        alts = res.get("alternatives") or []
        if not alts:
            continue
        words = alts[0].get("words") or []
        if not words:
            continue
        distinct = len({int(w.get("speakerTag", 0) or 0) for w in words})
        key = (distinct, len(words))
        if key > best_key:
            best, best_key = words, key
    return best


def group_words_to_segments(words, max_gap=0.45, max_chars=140,
                            max_seconds=7.0):
    """Turn diarized words into caption-like segments.

    A new segment starts when the speaker changes, on a pause longer than
    `max_gap`, at sentence-ending punctuation, or when the line grows past
    `max_chars` / `max_seconds`. The duration cap matters for dubbing: a single
    13-second block cannot be pace-fitted to picture, whereas short lines can.
    """
    enders = ("।", ".", "?", "!", "|")
    segments = []
    cur = None
    for w in words:
        txt = w.get("word", "")
        if not txt:
            continue
        st, en = _secs(w.get("startTime")), _secs(w.get("endTime"))
        spk = int(w.get("speakerTag", 0) or 0)
        if cur is None:
            cur = {"start": st, "end": en, "text": txt, "speaker": spk}
            continue

        gap = st - cur["end"]
        too_long = (en - cur["start"]) > max_seconds
        too_wide = len(cur["text"]) + 1 + len(txt) > max_chars
        ended = cur["text"].rstrip().endswith(enders)

        if spk != cur["speaker"] or gap > max_gap or too_long or too_wide or ended:
            segments.append(cur)
            cur = {"start": st, "end": en, "text": txt, "speaker": spk}
        else:
            cur["text"] += " " + txt
            cur["end"] = en
    if cur is not None:
        segments.append(cur)

    # Normalise speaker ids to 0..N-1 in order of first appearance.
    order, remap = [], {}
    for s in segments:
        if s["speaker"] not in remap:
            remap[s["speaker"]] = len(order)
            order.append(s["speaker"])
        s["speaker"] = remap[s["speaker"]]
    return segments


def transcribe_diarized(vocals_wav, source_lang, max_speakers=6, timeout=900):
    """Transcribe with speaker diarization.

    Returns (segments, language_code) where each segment is
    {"start", "end", "text", "speaker"}. Raises on failure so the caller can
    fall back to local Whisper.
    """
    import requests
    import time

    lang = STT_LANG.get((source_lang or "").lower())
    if not lang:
        # STT needs an explicit language; guess Indian English if unknown.
        lang = "en-IN"

    content, dur = _to_16k_mono_b64(vocals_wav)
    headers = _auth_headers()
    body = _request_body(content, lang, max_speakers)

    if dur <= SYNC_LIMIT_SECONDS:
        r = requests.post(STT_SYNC, headers=headers, json=body, timeout=300)
        if r.status_code != 200:
            raise RuntimeError(f"STT {r.status_code}: {r.text[:250]}")
        payload = r.json()
    else:
        r = requests.post(STT_LONG, headers=headers, json=body, timeout=300)
        if r.status_code != 200:
            raise RuntimeError(f"STT long {r.status_code}: {r.text[:250]}")
        op = r.json().get("name")
        if not op:
            raise RuntimeError("STT long: no operation name returned")
        url = f"https://speech.googleapis.com/v1/operations/{op}"
        waited = 0.0
        while waited < timeout:
            time.sleep(5.0)
            waited += 5.0
            pr = requests.get(url, headers=headers, timeout=120)
            if pr.status_code != 200:
                continue
            pj = pr.json()
            if pj.get("done"):
                if "error" in pj:
                    raise RuntimeError(f"STT long failed: {pj['error']}")
                payload = pj.get("response", {})
                break
        else:
            raise RuntimeError("STT long: timed out")

    words = _collect_words(payload)
    if not words:
        # No word-level data: fall back to plain transcripts without diarization.
        segs = []
        for res in payload.get("results", []):
            alts = res.get("alternatives") or []
            if alts and alts[0].get("transcript"):
                segs.append({"start": 0.0, "end": dur,
                             "text": alts[0]["transcript"].strip(),
                             "speaker": 0})
        if not segs:
            raise RuntimeError("STT returned no transcript")
        return segs, lang.split("-")[0]

    segments = group_words_to_segments(words)
    if not segments:
        raise RuntimeError("STT produced no segments")
    return segments, lang.split("-")[0]
