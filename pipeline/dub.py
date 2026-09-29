"""
Free, local video-dubbing pipeline.

Steps:
  1. ffmpeg     -> extract audio (wav) from the input video
  2. Demucs     -> split audio into vocals + background (music/ambience)
  3. Whisper    -> transcribe the vocals with timestamps (segments)
  4. translate  -> translate each segment to the target language
  5. TTS        -> clone the original speaker voice, speak the translation
                   (XTTS v2 for its 17 langs; IndicF5 for Indian languages)
  6. ffmpeg     -> mix cloned speech over the untouched background, remux video
  7. Wav2Lip    -> (optional) lip-sync the speaker's mouth to the new audio

Progress is reported as JSON lines on stdout so the Node server can stream it:
  {"stage": "...", "pct": 0-100, "message": "..."}

Usage:
  python dub.py --input <video> --output <video> --source <lang|auto>
                --target <lang> [--lipsync]
"""

import argparse
import json
import os
import sys
import subprocess
import tempfile
import shutil
import wave
import contextlib

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Languages handled by IndicF5 (AI4Bharat). XTTS handles the rest of its set.
INDIC_LANGS = {"ta", "te", "ml", "kn", "bn", "gu", "mr", "or", "pa", "as"}

# When set (via --artifacts-dir), each stage saves its intermediate output here
# with a clear, ordered name so problems can be pinpointed stage by stage.
ARTIFACTS_DIR = None


def artifact_file(src_path, name, label):
    """Copy a produced file into the artifacts dir under a clear name and tell
    the server about it (so it appears as a download in the UI)."""
    if not ARTIFACTS_DIR or not src_path or not os.path.exists(src_path):
        return
    try:
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        dest = os.path.join(ARTIFACTS_DIR, name)
        shutil.copyfile(src_path, dest)
        print(json.dumps({"artifact": name, "label": label}), flush=True)
    except Exception:
        pass


def artifact_text(content, name, label):
    """Write a text/JSON artifact into the artifacts dir."""
    if not ARTIFACTS_DIR:
        return
    try:
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        dest = os.path.join(ARTIFACTS_DIR, name)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(content)
        print(json.dumps({"artifact": name, "label": label}), flush=True)
    except Exception:
        pass


def venv_python(venv_name):
    """Return the python executable path for a sibling venv, cross-platform."""
    if os.name == "nt":
        return os.path.join(PROJECT_ROOT, venv_name, "Scripts", "python.exe")
    return os.path.join(PROJECT_ROOT, venv_name, "bin", "python")


def emit(stage, pct, message="", device=None):
    """Print a progress event as a single JSON line."""
    evt = {"stage": stage, "pct": pct, "message": message}
    if device:
        evt["device"] = device
    print(json.dumps(evt), flush=True)


def run(cmd):
    """Run a subprocess, raising with captured output on failure."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed: {' '.join(cmd)}\n{proc.stderr[-1500:]}"
        )
    return proc


def setup_ffmpeg():
    """Locate ffmpeg. On Windows we bundle an FFmpeg 7 shared build under
    ffmpeg7/ (torchcodec needs FFmpeg 4-7 shared libs). On Linux the system
    ffmpeg (apt) is used directly.
    """
    # Prefer a system ffmpeg if present (Linux/mac, or Windows on PATH).
    found = shutil.which("ffmpeg")

    # On Windows, the bundled shared build is required for torchcodec, so it
    # takes precedence and is added to PATH.
    if os.name == "nt":
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        bundled = os.path.join(project_root, "ffmpeg7")
        if os.path.isdir(bundled):
            for root, _dirs, files in os.walk(bundled):
                if "ffmpeg.exe" in files and "bin" in root.lower():
                    os.environ["PATH"] = (
                        root + os.pathsep + os.environ.get("PATH", "")
                    )
                    return os.path.join(root, "ffmpeg.exe")
        if found:
            return found
        base = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages")
        if os.path.isdir(base):
            for root, _dirs, files in os.walk(base):
                if "ffmpeg.exe" in files:
                    return os.path.join(root, "ffmpeg.exe")
        return "ffmpeg"

    return found or "ffmpeg"


FFMPEG = setup_ffmpeg()


def extract_audio(video, out_wav):
    emit("extract", 5, "Extracting audio from video")
    run([
        FFMPEG, "-y", "-i", video,
        "-vn", "-ac", "1", "-ar", "16000",
        out_wav,
    ])
    artifact_file(out_wav, "01_extracted_audio.wav", "Step 1: Extracted audio")


def separate_audio(in_wav, work_dir):
    """Use Demucs to split into vocals and the rest (background)."""
    dev = "GPU" if gpu_available() else "CPU"
    emit("separate", 15, "Separating voice from background music", device=dev)
    # htdemucs with --two-stems=vocals gives: vocals.wav + no_vocals.wav
    cmd = [sys.executable, "-m", "demucs", "--two-stems", "vocals"]
    if gpu_available():
        cmd += ["-d", "cuda"]
    cmd += ["-o", work_dir, in_wav]
    run(cmd)
    stem = os.path.splitext(os.path.basename(in_wav))[0]
    sep_dir = os.path.join(work_dir, "htdemucs", stem)
    vocals = os.path.join(sep_dir, "vocals.wav")
    background = os.path.join(sep_dir, "no_vocals.wav")
    if not (os.path.exists(vocals) and os.path.exists(background)):
        raise RuntimeError("Demucs did not produce expected stems.")
    artifact_file(vocals, "02a_separated_vocals.wav", "Step 2: Separated vocals")
    artifact_file(background, "02b_background_music.wav",
                  "Step 2: Background music")
    return vocals, background


def gpu_available():
    """True if a CUDA GPU is usable."""
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def transcribe(vocals_wav, source_lang, original_audio=None, target_lang=None):
    # Best path: hand the AUDIO to Gemini. It detects the language itself,
    # transcribes in the native script, separates speakers, judges each
    # speaker's gender from the voice, notes the delivery, and translates — all
    # in one call. This replaced a chain that was failing badly (STT defaulted
    # Hindi to en-IN and returned romanised text; Whisper-base hallucinated;
    # embedding diarization merged 3 characters into 1; pitch labelled male
    # voices female).
    if os.environ.get("USE_GEMINI_AUDIO", "1") == "1" and target_lang:
        try:
            from gemini_audio import build_script
            # Prefer the ORIGINAL mix: Demucs separation can smear short shouts.
            src_audio = original_audio if (original_audio
                                           and os.path.exists(original_audio)) \
                else vocals_wav
            segs, detected, spk_meta, report = build_script(
                src_audio, source_lang, target_lang, emit=emit)
            n_spk = len({s["speaker"] for s in segs})
            emit("transcribe", 45,
                 f"Gemini: {len(segs)} lines, {n_spk} speaker(s), "
                 f"language {detected}", device="Cloud")
            artifact_text("\n".join(report), "03_gemini_script.txt",
                          "Step 3-5: Gemini audio script (speakers, emotion, "
                          "translation)")
            lines = [f"Detected source language: {detected} (Gemini audio)",
                     f"Segments: {len(segs)}", f"Speakers: {n_spk}", ""]
            for i, s in enumerate(segs):
                lines.append(f"[{i:02d}] {s['start']:.2f}-{s['end']:.2f}s "
                             f"spk{s['speaker']}({s['gender']}): {s['text']}")
            artifact_text("\n".join(lines), "03_transcript.txt",
                          "Step 3: Transcript (Gemini audio)")
            transcribe.gemini_done = True
            return segs, detected
        except Exception as e:
            emit("transcribe", 35,
                 f"Gemini audio failed ({e}); falling back")
    transcribe.gemini_done = False

    if os.environ.get("USE_GCLOUD_STT") == "1":
        try:
            from gcloud_stt import transcribe_diarized
            emit("transcribe", 35, "Transcribing with Google STT (diarized)",
                 device="Cloud")
            segs, detected = transcribe_diarized(vocals_wav, source_lang)
            n_spk = len({s.get("speaker", 0) for s in segs})
            emit("transcribe", 45,
                 f"Google STT: {len(segs)} segments, {n_spk} speaker(s)",
                 device="Cloud")
            lines = [f"Detected source language: {detected} (Google STT)",
                     f"Segments: {len(segs)}", f"Speakers: {n_spk}", ""]
            for i, s in enumerate(segs):
                lines.append(f"[{i:02d}] {s['start']:.2f}-{s['end']:.2f}s "
                             f"spk{s.get('speaker', 0)}: {s['text']}")
            artifact_text("\n".join(lines), "03_transcript.txt",
                          "Step 3: Transcript (Google STT + diarization)")
            return segs, detected
        except Exception as e:
            emit("transcribe", 35,
                 f"Google STT failed ({e}); using local Whisper")

    use_gpu = gpu_available()
    emit("transcribe", 35, "Transcribing speech",
         device="GPU" if use_gpu else "CPU")
    from faster_whisper import WhisperModel

    # Model size: "large-v3" gives the best accuracy and is critical because
    # transcription errors cascade into translation and synthesis. The T4 GPU
    # handles large-v3 comfortably. On CPU we fall back to "base" for speed.
    # Override with the WHISPER_MODEL env var if needed.
    if use_gpu:
        model_name = os.environ.get("WHISPER_MODEL", "large-v3")
        model = WhisperModel(model_name, device="cuda", compute_type="float16")
    else:
        model_name = os.environ.get("WHISPER_MODEL", "base")
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
    emit("transcribe", 36, f"Transcribing with Whisper {model_name}",
         device="GPU" if use_gpu else "CPU")
    lang = None if source_lang in (None, "", "auto") else source_lang
    # beam_size=5 improves accuracy over greedy decoding.
    #
    # VAD tuning: the default vad_filter settings are aggressive and silently
    # drop rapid, overlapping, or short utterances (e.g. "Papaji, papaji...").
    # We keep VAD on (it helps Whisper avoid hallucinating in music) but make
    # it far more permissive so fast dialogue survives:
    #   - min_silence_duration_ms 100 (default 2000): only a real, long pause
    #     splits/ends speech, so back-to-back lines aren't merged away.
    #   - speech_pad_ms 400: pad each detected region so soft on/offsets and
    #     overlapping starts aren't clipped.
    #   - min_speech_duration_ms 0: never discard a region for being short.
    #   - threshold 0.2 (default 0.5): trigger on quieter/faster speech.
    # Allow full override via WHISPER_VAD=off to disable VAD entirely.
    vad_off = os.environ.get("WHISPER_VAD", "").lower() in ("off", "0", "false")
    vad_params = dict(
        threshold=0.2,
        min_speech_duration_ms=0,
        min_silence_duration_ms=100,
        speech_pad_ms=400,
    )
    segments, info = model.transcribe(
        vocals_wav, language=lang, beam_size=5,
        # task MUST be explicit. Left to chance, Whisper can emit English for
        # non-English audio (observed: Hindi audio -> English transcript), which
        # silently corrupts the whole downstream translation.
        task="transcribe",
        vad_filter=(not vad_off),
        vad_parameters=(None if vad_off else vad_params),
        condition_on_previous_text=False,  # reduces runaway hallucination loops
        # Hallucination guards: drop low-confidence / silence-only output rather
        # than inventing text (observed nonsense like "I have not pregnant").
        temperature=[0.0, 0.2, 0.4],
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
    )

    seg_list = []
    for s in segments:
        text = s.text.strip()
        if text:
            seg_list.append({"start": s.start, "end": s.end, "text": text})
    detected = info.language
    emit("transcribe", 45, f"Detected language: {detected}; {len(seg_list)} segments")
    # Save the transcript for inspection.
    lines = [f"Detected source language: {detected}", f"Segments: {len(seg_list)}", ""]
    for i, s in enumerate(seg_list):
        lines.append(f"[{i:02d}] {s['start']:.2f}-{s['end']:.2f}s: {s['text']}")
    artifact_text("\n".join(lines), "03_transcript.txt",
                  "Step 3: Transcript (source language)")
    return seg_list, detected


def _normalize_for_tts(text, target_lang):
    """Spell out numbers and risky symbols BEFORE TTS so the model doesn't
    hallucinate on digits / English tokens it can't pronounce.

    TTS models (IndicF5, Svara) reliably mispronounce or garble raw digits
    ("2016") and symbols (%, &, $, +). We convert digits to words in the
    target language via num2words, and replace common symbols with their
    spoken target-language equivalent. Anything we can't convert is left as-is.
    """
    import re

    if not text:
        return text

    # num2words language code differs slightly from our short codes.
    NUM_LANG = {
        "hi": "hi", "te": "te", "ta": "ta", "kn": "kn", "ml": "ml",
        "gu": "gu", "mr": "mr", "bn": "bn", "en": "en",
    }
    nlang = NUM_LANG.get(target_lang, "en")

    # Spoken symbol words per language (fallback to a neutral word).
    SYMBOLS = {
        "%": {"te": " శాతం ", "hi": " प्रतिशत ", "ta": " சதவீதம் ",
              "en": " percent "},
        "&": {"te": " మరియు ", "hi": " और ", "ta": " மற்றும் ", "en": " and "},
        "+": {"te": " ప్లస్ ", "hi": " प्लस ", "ta": " கூட்டல் ", "en": " plus "},
        "@": {"te": " ఎట్ ", "hi": " एट ", "ta": " அட் ", "en": " at "},
    }

    def sym(ch):
        return SYMBOLS.get(ch, {}).get(nlang) or SYMBOLS.get(ch, {}).get("en") or " "

    for ch in ("%", "&", "+", "@"):
        if ch in text:
            text = text.replace(ch, sym(ch))

    # Convert standalone numbers (with optional separators) to words.
    def repl_num(m):
        raw = m.group(0)
        digits = raw.replace(",", "").replace(" ", "")
        try:
            from num2words import num2words
            # Handle decimals: speak integer + "point" + digits.
            if "." in digits:
                whole, frac = digits.split(".", 1)
                words = num2words(int(whole), lang=nlang)
                if frac:
                    point = {"te": " దశాంశం ", "hi": " दशमलव ",
                             "ta": " புள்ளி ", "en": " point "}.get(nlang, " point ")
                    words += point + " ".join(
                        num2words(int(d), lang=nlang) for d in frac)
                return f" {words} "
            return f" {num2words(int(digits), lang=nlang)} "
        except Exception:
            # num2words may not support this language; fall back to English
            # words rather than leaving raw digits the TTS will mangle.
            try:
                from num2words import num2words
                return f" {num2words(int(digits), lang='en')} "
            except Exception:
                return raw

    text = re.sub(r"\d[\d,\.]*\d|\d", repl_num, text)
    # Collapse any double spaces introduced above.
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text


def translate_segments(segments, source_lang, target_lang):
    emit("translate", 50, "Translating text")
    from deep_translator import GoogleTranslator

    src = "auto" if source_lang in (None, "", "auto") else source_lang

    # Preferred path: one LLM pass that BOTH repairs ASR errors and produces a
    # translation short enough to speak inside each slot. This attacks the two
    # biggest quality problems at their source rather than patching the audio:
    # nonsense text ("I am a saloni") and over-long lines that forced 2-3x
    # compression and made the dub robotic.
    if os.environ.get("USE_AI_SCRIPT", "1") == "1":
        try:
            from ai_script import refine_script
            report = refine_script(segments, source_lang, target_lang, emit=emit)
            for seg in segments:
                seg["translated"] = _normalize_for_tts(
                    seg.get("translated", ""), target_lang)
            artifact_text("\n".join(report), "05_ai_script.txt",
                          "Step 5: AI script (ASR repair + fitted translation)")
            lines = [f"Target language: {target_lang}", ""]
            for i, seg in enumerate(segments):
                lines.append(f"[{i:02d}] SRC: {seg.get('text','')}")
                lines.append(f"     DST: {seg.get('translated','')}")
            artifact_text("\n".join(lines), "05_translation.txt",
                          "Step 5: Translation (target language)")
            emit("translate", 56, "AI script ready")
            return segments
        except Exception as e:
            emit("translate", 50,
                 f"AI script unavailable ({e}); using plain translation")

    translator = GoogleTranslator(source=src, target=target_lang)

    for seg in segments:
        try:
            translated = translator.translate(seg["text"]) or seg["text"]
        except Exception:
            translated = seg["text"]
        seg["translated"] = translated

    # Length control: the spoken duration of a translation scales with its
    # character count. If a translation is far longer than the original, the
    # voice would need heavy speed-up to fit its time slot. We try to obtain a
    # more concise rendering by translating via a pivot and keeping whichever
    # result is closest in length to the source. This reduces the amount of
    # time-stretching the assembly stage has to do.
    _tighten_long_translations(segments, src, target_lang)

    # Normalize each translation for TTS: spell out numbers/symbols so the
    # synth engine doesn't hallucinate on digits like "2016" or stray symbols.
    for seg in segments:
        seg["translated"] = _normalize_for_tts(
            seg.get("translated", ""), target_lang)

    # Save the translation side-by-side with the source for inspection.
    lines = [f"Target language: {target_lang}", ""]
    for i, seg in enumerate(segments):
        lines.append(f"[{i:02d}] SRC: {seg.get('text','')}")
        lines.append(f"     DST: {seg.get('translated','')}")
    artifact_text("\n".join(lines), "05_translation.txt",
                  "Step 5: Translation (target language)")
    return segments


def _tighten_long_translations(segments, src, target_lang):
    """For segments whose translation is much longer than the source, try an
    alternative phrasing and keep the shorter one. Best-effort and offline-safe.
    """
    from deep_translator import GoogleTranslator

    for seg in segments:
        orig = seg.get("text", "")
        trans = seg.get("translated", "")
        if not orig or not trans:
            continue
        # Ratio of translated length to original length.
        ratio = len(trans) / max(1, len(orig))
        if ratio <= 1.35:
            continue  # already close enough in length

        # Try a round-trip via English as a pivot, which often yields a more
        # compact phrasing, then translate that to the target.
        try:
            if target_lang != "en" and src != "en":
                pivot = GoogleTranslator(source=src, target="en").translate(orig)
                alt = GoogleTranslator(source="en", target=target_lang).translate(pivot)
                if alt and len(alt) < len(trans):
                    seg["translated"] = alt
        except Exception:
            pass


def wav_duration(path):
    with contextlib.closing(wave.open(path, "rb")) as w:
        return w.getnframes() / float(w.getframerate())


def diarize_segments(segments, vocals_wav, background_wav, work_dir):
    """Assign a speaker id to each segment and build one reference clip per
    speaker (the "voice fingerprint").

    Uses Resemblyzer voice embeddings + agglomerative clustering — fully
    offline, no gated models or tokens. Falls back to a single speaker if
    anything fails. Returns a dict: speaker_id -> reference_wav_path.
    """
    emit("transcribe", 48, "Identifying speakers")
    import numpy as np
    import soundfile as sf

    # If transcription already supplied speaker tags (Google STT diarization),
    # trust them instead of re-clustering: they are derived from the full audio
    # by a purpose-built diarizer, whereas local embedding clustering has been
    # observed to collapse every character into a single speaker.
    stt_labelled = (segments and all("speaker" in s for s in segments)
                    and len({s["speaker"] for s in segments}) >= 1
                    and os.environ.get("USE_GCLOUD_STT") == "1")
    if stt_labelled:
        n = len({s["speaker"] for s in segments})
        emit("transcribe", 49, f"Using {n} speaker(s) from Google STT")
        return _refs_for_labelled(segments, vocals_wav, background_wav, work_dir)

    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
    except Exception as e:
        emit("transcribe", 48, f"Diarization unavailable ({e}); single voice")
        for seg in segments:
            seg["speaker"] = 0
        return _single_speaker_ref(vocals_wav, background_wav, work_dir)

    wav, sr = sf.read(vocals_wav, always_2d=True)
    mono = wav.mean(axis=1).astype(np.float32)

    # Load the separated background so we can measure how much non-vocal
    # energy leaked into each window (lower leakage = cleaner reference).
    try:
        bg, bsr = sf.read(background_wav, always_2d=True)
        bg_mono = bg.mean(axis=1).astype(np.float32)
        if bsr != sr and len(bg_mono):
            idx = np.linspace(0, len(bg_mono) - 1,
                              int(len(bg_mono) * sr / bsr)).astype(np.int64)
            bg_mono = bg_mono[idx]
    except Exception:
        bg_mono = np.zeros_like(mono)

    encoder = VoiceEncoder(device="cuda" if gpu_available() else "cpu", verbose=False)

    # Embed each segment's slice of the vocals.
    embeds, valid = [], []
    for i, seg in enumerate(segments):
        a = int(seg["start"] * sr)
        b = int(seg["end"] * sr)
        clip = mono[a:b]
        if len(clip) < int(0.4 * sr):  # too short to embed reliably
            continue
        try:
            pw = preprocess_wav(clip, source_sr=sr)
            embeds.append(encoder.embed_utterance(pw))
            valid.append(i)
        except Exception:
            continue

    if len(embeds) < 2:
        for seg in segments:
            seg["speaker"] = 0
        return _single_speaker_ref(vocals_wav, background_wav, work_dir)

    embeds = np.array(embeds)

    # Cluster with a cosine-distance threshold; auto-discovers speaker count.
    from sklearn.cluster import AgglomerativeClustering
    clustering = AgglomerativeClustering(
        n_clusters=None, distance_threshold=0.75,
        metric="cosine", linkage="average",
    )
    labels = clustering.fit_predict(embeds)

    # Assign labels back to segments (segments too short to embed inherit the
    # nearest labeled neighbour).
    seg_label = {}
    for idx, seg_i in enumerate(valid):
        seg_label[seg_i] = int(labels[idx])
    last = 0
    for i, seg in enumerate(segments):
        if i in seg_label:
            last = seg_label[i]
        seg["speaker"] = last

    n_speakers = len(set(labels))
    emit("transcribe", 49, f"Detected {n_speakers} speaker(s)")

    # Build references per speaker. Two kinds, because the two engines differ:
    #   - XTTS: benefits from MORE reference audio (~15-30s) and does NOT need
    #     a matching transcript, so we concatenate the cleanest segments.
    #   - IndicF5: needs the reference AUDIO and its TRANSCRIPT to align, so we
    #     use a single clean segment plus its exact transcribed text.
    # Voice cloning quality depends on reference purity, so both prefer the
    # highest-SNR (least background leakage) speech available.
    refs = {}          # speaker -> long reference wav (for XTTS)
    indic_refs = {}    # speaker -> (single-segment ref wav, matching text)
    by_speaker = {}
    for i, seg in enumerate(segments):
        by_speaker.setdefault(seg["speaker"], []).append(seg)

    def seg_snr(seg):
        a, b = int(seg["start"] * sr), int(seg["end"] * sr)
        v = mono[a:b]
        if len(v) == 0:
            return -1e9, 0.0
        v_energy = float(np.mean(v ** 2)) + 1e-9
        bseg = bg_mono[a:b] if b <= len(bg_mono) else bg_mono[a:len(bg_mono)]
        b_energy = float(np.mean(bseg ** 2)) + 1e-9 if len(bseg) else 1e-9
        snr_db = 10.0 * np.log10(v_energy / b_energy)
        return snr_db, (seg["end"] - seg["start"])

    for spk, segs in by_speaker.items():
        scored = []
        for s in segs:
            snr, dur = seg_snr(s)
            if dur >= 0.8:
                scored.append((snr, dur, s))
        if not scored:
            scored = [(seg_snr(s)[0], (s["end"] - s["start"]), s) for s in segs]
        scored.sort(key=lambda x: x[0], reverse=True)

        # --- IndicF5 reference: single cleanest segment + its text ---
        best_seg = scored[0][2]
        best_text = (best_seg.get("text") or "reference")[:200]
        a, b = int(best_seg["start"] * sr), int(best_seg["end"] * sr)
        indic_ref = _trim_silence(mono[a:b], sr)
        if len(indic_ref) == 0:
            indic_ref = mono[a:b] if b > a else mono[: int(8 * sr)]
        indic_ref = _normalize(indic_ref)
        indic_ref_path = os.path.join(work_dir, f"ref_indic_spk{spk}.wav")
        sf.write(indic_ref_path, indic_ref, sr)
        indic_refs[spk] = (indic_ref_path, best_text)
        artifact_file(indic_ref_path, f"04_voice_reference_speaker{spk}.wav",
                      f"Step 4: Voice fingerprint (speaker {spk})")

        # --- XTTS reference: concatenate cleanest segments up to ~25s ---
        # The IVC needs enough audio (~15-30s) to capture a stable voice
        # profile; too little reference yields a weaker clone.
        chunks, dur = [], 0.0
        for snr, d, s in scored:
            a2, b2 = int(s["start"] * sr), int(s["end"] * sr)
            clip = _trim_silence(mono[a2:b2], sr)
            if len(clip) == 0:
                continue
            chunks.append(clip)
            dur += len(clip) / sr
            if dur >= 25.0:
                break
        long_ref = np.concatenate(chunks) if chunks else indic_ref
        long_ref = _normalize(long_ref)
        ref_path = os.path.join(work_dir, f"ref_spk{spk}.wav")
        sf.write(ref_path, long_ref, sr)
        refs[spk] = ref_path

    # Stash IndicF5 (ref, text) pairs for synth_indic to use.
    diarize_segments.last_indic_refs = indic_refs
    return refs


def _normalize(x):
    """Peak-normalize audio to a consistent level."""
    import numpy as np
    if x is None or len(x) == 0:
        return x
    peak = float(np.max(np.abs(x)))
    return x * (0.95 / peak) if peak > 0 else x


def _trim_silence(clip, sr, thr_db=-40):
    """Trim leading/trailing samples below a relative energy threshold."""
    import numpy as np
    if len(clip) == 0:
        return clip
    win = max(1, int(0.02 * sr))
    peak = float(np.max(np.abs(clip))) + 1e-9
    # Frame energies in dB relative to peak.
    n = len(clip) // win
    active = []
    for i in range(n):
        seg = clip[i * win:(i + 1) * win]
        level = 20.0 * np.log10((np.sqrt(np.mean(seg ** 2)) + 1e-9) / peak)
        active.append(level > thr_db)
    if not any(active):
        return clip
    first = active.index(True)
    last = len(active) - 1 - active[::-1].index(True)
    return clip[first * win:(last + 1) * win]


def _refs_for_labelled(segments, vocals_wav, background_wav, work_dir):
    """Build one reference clip per speaker when labels already exist (from
    Google STT diarization). Picks each speaker's longest clean utterance."""
    import numpy as np
    import soundfile as sf

    wav, sr = sf.read(vocals_wav, always_2d=True)
    mono = wav.mean(axis=1).astype(np.float32)

    by_spk = {}
    for s in segments:
        by_spk.setdefault(s.get("speaker", 0), []).append(s)

    refs, indic_refs = {}, {}
    for spk, segs in by_spk.items():
        # Longest utterance is the most reliable voice sample.
        best = max(segs, key=lambda x: float(x["end"]) - float(x["start"]))
        a, b = int(float(best["start"]) * sr), int(float(best["end"]) * sr)
        clip = mono[a:b] if b > a else mono[: int(5 * sr)]
        if clip.size == 0:
            clip = mono[: int(5 * sr)]
        peak = float(np.max(np.abs(clip))) or 1.0
        clip = clip * (0.95 / peak)
        p = os.path.join(work_dir, f"ref_spk{spk}.wav")
        sf.write(p, clip, sr)
        refs[spk] = p
        indic_refs[spk] = (p, (best.get("text") or "reference")[:200])
        artifact_file(p, f"04_voice_reference_speaker{spk}.wav",
                      f"Step 4: Voice fingerprint (speaker {spk})")

    diarize_segments.last_indic_refs = indic_refs
    return refs


def _single_speaker_ref(vocals_wav, background_wav, work_dir):
    """Fallback: one reference clip, choosing the cleanest ~25s window."""
    import soundfile as sf
    ref_path = os.path.join(work_dir, "ref_spk0.wav")
    make_reference_clip(vocals_wav, ref_path, max_seconds=25.0,
                        background_wav=background_wav)
    # IndicF5 fallback uses the same audio with a generic ref text.
    diarize_segments.last_indic_refs = {0: (ref_path, "reference")}
    artifact_file(ref_path, "04_voice_reference_speaker0.wav",
                  "Step 4: Voice fingerprint (speaker 0)")
    return {0: ref_path}


def split_long_segments(segments, max_chars=300):
    """Split segments whose translated text is long into sub-segments.

    The doc warns that feeding very long text to the TTS (beyond ~800-900
    chars) induces accent drift and unnatural pacing. We use a conservative
    cap and split on sentence boundaries, dividing the original time slot
    proportionally by character count so timing stays aligned.
    """
    import re

    out = []
    for seg in segments:
        text = (seg.get("translated") or seg.get("text") or "").strip()
        if len(text) <= max_chars:
            out.append(seg)
            continue

        # Split into sentences; group them into chunks under max_chars.
        sentences = re.split(r"(?<=[.!?।])\s+", text)
        chunks, cur = [], ""
        for s in sentences:
            if not s:
                continue
            if len(cur) + len(s) + 1 <= max_chars:
                cur = (cur + " " + s).strip()
            else:
                if cur:
                    chunks.append(cur)
                # A single sentence longer than max_chars: hard-split it.
                while len(s) > max_chars:
                    chunks.append(s[:max_chars])
                    s = s[max_chars:]
                cur = s
        if cur:
            chunks.append(cur)
        if not chunks:
            out.append(seg)
            continue

        # Divide the original time slot proportionally to chunk length.
        start, end = seg["start"], seg["end"]
        total_len = sum(len(c) for c in chunks) or 1
        t = start
        for c in chunks:
            frac = len(c) / total_len
            sub_end = min(end, t + (end - start) * frac)
            sub = dict(seg)
            sub["start"] = t
            sub["end"] = sub_end
            sub["translated"] = c
            sub["text"] = c
            out.append(sub)
            t = sub_end
    return out


def synthesize(segments, vocals_wav, background_wav, target_lang, work_dir):
    """Route to the right voice-cloning engine based on target language."""
    seg_dir = os.path.join(work_dir, "segments")
    os.makedirs(seg_dir, exist_ok=True)

    # Per-speaker voice fingerprints (built from the original segments).
    speaker_refs = diarize_segments(segments, vocals_wav, background_wav, work_dir)

    # Guard against accent drift / pacing issues on very long segments.
    segments = split_long_segments(segments, max_chars=300)

    # Optional cloud backend (Chirp 3: Instant Custom Voice). Opt-in via
    # USE_CHIRP_CLOUD=1 and only for languages it supports + when a consent
    # recording is configured. Any failure falls back to the local engines so
    # the pipeline never hard-depends on cloud access.
    if os.environ.get("USE_CHIRP_CLOUD") == "1":
        try:
            from cloud_tts import supports as _chirp_supports, synth_cloud
        except Exception as e:
            _chirp_supports = lambda _l: False
            emit("synthesize", 60, f"Cloud TTS unavailable ({e}); using local engine")
        if _chirp_supports(target_lang):
            try:
                indic_refs = getattr(diarize_segments, "last_indic_refs", {}) or {}
                pieces = synth_cloud(segments, speaker_refs, indic_refs,
                                     target_lang, seg_dir)
                return build_voice_track(pieces, background_wav, work_dir)
            except Exception as e:
                emit("synthesize", 60,
                     f"Cloud TTS failed ({e}); falling back to local engine")

    # Preferred backend: Google Chirp3-HD (distinct gender-matched voice per
    # detected speaker + exact slot fitting via the API's pace control).
    # Opt-in with USE_GCLOUD_TTS=1. Falls back to the local engines on failure.
    if os.environ.get("USE_GCLOUD_TTS") == "1":
        try:
            from gcloud_dub import supports as _g_supports, synth_gcloud
        except Exception as e:
            _g_supports = lambda _l: False
            emit("synthesize", 60,
                 f"Google TTS unavailable ({e}); using local engine")
        if _g_supports(target_lang):
            try:
                indic_refs = getattr(diarize_segments, "last_indic_refs", {}) or {}
                pieces = synth_gcloud(segments, speaker_refs, indic_refs,
                                      target_lang, seg_dir,
                                      vocals_wav=vocals_wav)
                # Surface the per-segment voice/timing decisions and each
                # synthesized clip so silent gaps are always diagnosable.
                artifact_file(os.path.join(seg_dir, "gcloud_tts_report.txt"),
                              "06_tts_report.txt",
                              "Step 6: Voice assignment + timing per segment")
                for _i, (_s, _e, _p) in enumerate(pieces):
                    artifact_file(_p, f"06_segment_{_i:02d}_voiced.wav",
                                  f"Step 6: Voiced segment {_i}")
                return build_voice_track(pieces, background_wav, work_dir)
            except Exception as e:
                emit("synthesize", 60,
                     f"Google TTS failed ({e}); falling back to local engine")

    if target_lang in INDIC_LANGS:
        if os.environ.get("USE_SVARA") == "1":
            try:
                pieces = synth_svara(segments, target_lang, seg_dir)
                return build_voice_track(pieces, background_wav, work_dir)
            except Exception as e:
                emit("synthesize", 60,
                     f"Svara TTS failed ({e}); falling back to IndicF5")
        pieces = synth_indic(segments, speaker_refs, seg_dir)
    else:
        pieces = synth_xtts(segments, speaker_refs, target_lang, seg_dir)

    return build_voice_track(pieces, background_wav, work_dir)


def synth_svara(segments, target_lang, seg_dir):
    """Clone/voice each translated segment with Svara-TTS (kenpath/svara-tts-v1).

    Runs in .venv_indic (transformers + torch.cuda + snac) as a batch
    subprocess, like synth_indic. Each item carries its own speaker reference
    clip + transcript for zero-shot cloning; if SVARA_PRESET=1, uses preset
    speaker voices instead. Returns [(start, end, wav_path), ...].
    """
    emit("synthesize", 60, "Loading voice model (Svara-TTS)")

    indic_refs = getattr(diarize_segments, "last_indic_refs", {}) or {}
    preset = os.environ.get("SVARA_PRESET") == "1"

    def ref_for(spk):
        if spk in indic_refs:
            return indic_refs[spk]
        if indic_refs:
            return next(iter(indic_refs.values()))
        return (None, "reference")

    batch = []
    for i, seg in enumerate(segments):
        spk = seg.get("speaker", 0)
        ref_wav, ref_text = ref_for(spk)
        item = {
            "index": i,
            "text": (seg.get("translated") or seg["text"]),
            "speaker": spk,
        }
        # Zero-shot cloning unless preset mode is requested.
        if not preset and ref_wav:
            item["ref"] = ref_wav
            item["ref_text"] = ref_text
        batch.append(item)

    batch_file = os.path.join(seg_dir, "batch_svara.json")
    with open(batch_file, "w", encoding="utf-8") as f:
        json.dump(batch, f, ensure_ascii=False)

    indic_python = venv_python(".venv_indic")
    worker = os.path.join(PROJECT_ROOT, "pipeline", "svara_tts.py")
    if not os.path.exists(indic_python):
        raise RuntimeError(".venv_indic not found for Svara-TTS. See README.")

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

    proc = subprocess.Popen(
        [indic_python, worker, "--batch", batch_file,
         "--outdir", seg_dir, "--lang", target_lang],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", env=env,
    )

    import soundfile as sf
    starts = {i: seg["start"] for i, seg in enumerate(segments)}
    ends = {i: seg["end"] for i, seg in enumerate(segments)}
    pieces = []
    total = len(segments)
    done = 0
    device = "GPU"
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "info" in evt and "device=" in evt["info"]:
            device = "GPU" if "cuda" in evt["info"] else "CPU"
            emit("synthesize", 60, "Loading voice model (Svara-TTS)", device=device)
        if "path" in evt and "index" in evt:
            i = evt["index"]
            reported_sr = evt.get("sr")
            try:
                file_sr = int(sf.info(evt["path"]).samplerate)
            except Exception:
                continue
            if reported_sr is not None and int(reported_sr) != file_sr:
                raise RuntimeError(
                    f"Svara segment {i} sample-rate desync: worker {reported_sr} "
                    f"vs file {file_sr}.")
            pieces.append((starts.get(i, 0.0), ends.get(i, 0.0), evt["path"]))
            artifact_file(evt["path"], f"06_segment_{i:02d}_cloned.wav",
                          f"Step 6: Svara segment {i}")
            done += 1
            pct = 60 + int(25 * done / max(1, total))
            emit("synthesize", min(pct, 85),
                 f"Voiced segment {done}/{total}", device=device)
    proc.wait()
    if not pieces:
        raise RuntimeError("Svara-TTS produced no audio.")
    return pieces


def synth_xtts(segments, speaker_refs, target_lang, seg_dir):
    """Clone each speaker's voice and speak the translation with XTTS v2."""
    import torch
    from TTS.api import TTS

    use_gpu = torch.cuda.is_available()
    emit("synthesize", 60, "Loading voice cloning model (XTTS)",
         device="GPU" if use_gpu else "CPU")
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=False)
    if use_gpu:
        tts = tts.to("cuda")

    xtts_lang = map_xtts_lang(target_lang)
    total = len(segments)
    pieces = []  # (start_seconds, end_seconds, wav_path)
    for i, seg in enumerate(segments):
        text = seg.get("translated") or seg["text"]
        out_path = os.path.join(seg_dir, f"seg_{i:04d}.wav")
        # Use this segment's speaker fingerprint as the cloning reference.
        ref = speaker_refs.get(seg.get("speaker", 0)) or next(iter(speaker_refs.values()))
        try:
            tts.tts_to_file(
                text=text,
                speaker_wav=ref,
                language=xtts_lang,
                file_path=out_path,
            )
            pieces.append((seg["start"], seg["end"], out_path))
            artifact_file(out_path, f"06_segment_{i:02d}_cloned.wav",
                          f"Step 6: Cloned segment {i} ({seg.get('translated','')[:40]})")
        except Exception as e:
            emit("synthesize", 60, f"Segment {i} skipped: {e}")
        pct = 60 + int(25 * (i + 1) / max(1, total))
        emit("synthesize", min(pct, 85), f"Voiced segment {i + 1}/{total}")
    return pieces


def synth_indic(segments, speaker_refs, seg_dir):
    """Clone each speaker's voice and speak the translation with IndicF5.

    IndicF5 lives in a separate venv (.venv_indic) with its own deps, so we
    invoke it as a subprocess in batch mode (loads the model once). Each batch
    item carries its own speaker reference clip + reference transcript.
    """
    import soundfile as sf

    emit("synthesize", 60, "Loading voice cloning model (IndicF5)")

    # IndicF5 needs the reference AUDIO and its TRANSCRIPT to align, so use the
    # single-segment references built during diarization (not the long XTTS
    # ones). Each entry is (ref_wav_path, matching_ref_text).
    indic_refs = getattr(diarize_segments, "last_indic_refs", {}) or {}

    def ref_for(spk):
        if spk in indic_refs:
            return indic_refs[spk]
        if indic_refs:
            return next(iter(indic_refs.values()))
        # Last-resort fallback to the XTTS ref with a generic transcript.
        return (speaker_refs.get(spk) or next(iter(speaker_refs.values())), "reference")

    batch = []
    for i, seg in enumerate(segments):
        spk = seg.get("speaker", 0)
        ref_wav, ref_text = ref_for(spk)
        batch.append({
            "index": i,
            "text": (seg.get("translated") or seg["text"]),
            "ref": ref_wav,
            "ref_text": ref_text,
        })

    batch_file = os.path.join(seg_dir, "batch.json")
    with open(batch_file, "w", encoding="utf-8") as f:
        json.dump(batch, f, ensure_ascii=False)

    indic_python = venv_python(".venv_indic")
    worker = os.path.join(PROJECT_ROOT, "pipeline", "indic_tts.py")
    if not os.path.exists(indic_python):
        raise RuntimeError(
            "IndicF5 environment (.venv_indic) not found. See README setup."
        )

    # A default ref/ref-text for the worker (overridden per-item in the batch).
    _first = next(iter(indic_refs.values())) if indic_refs else (
        next(iter(speaker_refs.values())), "reference")
    any_ref, any_text = _first

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["WANDB_MODE"] = "disabled"
    env["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

    proc = subprocess.Popen(
        [
            indic_python, worker,
            "--ref", any_ref,
            "--ref-text", any_text,
            "--batch", batch_file,
            "--outdir", seg_dir,
            "--nfe", os.environ.get("INDICF5_NFE", "16"),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        env=env,
    )

    starts = {i: seg["start"] for i, seg in enumerate(segments)}
    ends = {i: seg["end"] for i, seg in enumerate(segments)}
    pieces = []
    total = len(segments)
    done = 0
    device = "GPU"  # updated from the worker's info line
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        # The worker reports its device once at startup.
        if "info" in evt and "device=" in evt["info"]:
            device = "GPU" if "cuda" in evt["info"] else "CPU"
            emit("synthesize", 60, "Loading voice cloning model (IndicF5)",
                 device=device)
        if "path" in evt and "index" in evt:
            i = evt["index"]
            # Trust the file's OWN header, not any assumed rate. The worker
            # also reports the rate it wrote; if the on-disk header disagrees,
            # the clip would play at the wrong speed/pitch, so we reject it.
            reported_sr = evt.get("sr")
            try:
                info = sf.info(evt["path"])
                file_sr = int(info.samplerate)
            except Exception as e:
                emit("synthesize", min(60 + int(25 * done / max(1, total)), 85),
                     f"Skipped segment {i}: unreadable ({e})", device=device)
                continue
            if reported_sr is not None and int(reported_sr) != file_sr:
                raise RuntimeError(
                    f"IndicF5 segment {i} sample-rate desync: worker wrote "
                    f"{reported_sr} Hz but file header says {file_sr} Hz. "
                    "This would cause sped-up/chipmunk audio; aborting."
                )
            pieces.append((starts.get(i, 0.0), ends.get(i, 0.0), evt["path"]))
            artifact_file(evt["path"], f"06_segment_{i:02d}_cloned.wav",
                          f"Step 6: Cloned segment {i}")
            done += 1
            pct = 60 + int(25 * done / max(1, total))
            emit("synthesize", min(pct, 85),
                 f"Voiced segment {done}/{total}", device=device)
    proc.wait()
    if not pieces:
        raise RuntimeError("IndicF5 produced no audio.")
    return pieces


def make_reference_clip(src_wav, out_wav, max_seconds=10.0, background_wav=None):
    """Pick the cleanest (highest-SNR) ~max_seconds window of the vocals as a
    voice-cloning reference.

    Voice cloning quality is fundamentally dependent on the purity of the
    reference: background leakage and reverb corrupt the voice embedding. We
    score each candidate window by vocal energy relative to the leaked
    background energy in the same window (an SNR proxy) and pick the best,
    rather than simply the loudest.
    """
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(src_wav, always_2d=True)
    mono = data.mean(axis=1)
    limit = int(max_seconds * sr)
    if len(mono) <= limit:
        sf.write(out_wav, data, sr)
        return

    # Optional background stem to measure leakage in each window.
    bg = None
    if background_wav:
        try:
            bgd, bsr = sf.read(background_wav, always_2d=True)
            bg = bgd.mean(axis=1)
            if bsr != sr and len(bg):
                idx = np.linspace(0, len(bg) - 1,
                                  int(len(bg) * sr / bsr)).astype(np.int64)
                bg = bg[idx]
        except Exception:
            bg = None

    win = limit
    step = max(1, sr // 2)
    best_pos, best_score = 0, -1e18
    for pos in range(0, len(mono) - win, step):
        v = mono[pos:pos + win]
        v_energy = float(np.mean(v ** 2)) + 1e-9
        if bg is not None and pos + win <= len(bg):
            b_energy = float(np.mean(bg[pos:pos + win] ** 2)) + 1e-9
            # SNR-like score, but require enough vocal energy so we don't pick
            # a silent window that happens to have near-zero background.
            score = 10.0 * np.log10(v_energy / b_energy) + 2.0 * np.log10(v_energy)
        else:
            score = np.log10(v_energy)
        if score > best_score:
            best_score, best_pos = score, pos

    ref = mono[best_pos:best_pos + win]
    peak = float(np.max(np.abs(ref))) if len(ref) else 0.0
    if peak > 0:
        ref = ref * (0.95 / peak)
    sf.write(out_wav, ref, sr)


def _world_stretch(mono, sr, rate, pitch_ratio=1.0):
    """Time-stretch (and optionally pitch-shift) speech with the WORLD vocoder.

    WORLD decomposes speech into F0, a spectral envelope and aperiodicity, then
    resynthesises. Because duration is changed by resampling those parameter
    tracks rather than by manipulating STFT phase, the result keeps natural
    voice quality instead of the "phasey"/robotic tone a phase vocoder gives.

    rate > 1.0 shortens (speaks faster); pitch_ratio > 1.0 raises pitch.
    """
    import numpy as np
    import pyworld as pw

    x = np.ascontiguousarray(mono, dtype=np.float64)
    if x.size < sr // 50:
        return np.ascontiguousarray(mono, dtype=np.float32)

    frame_ms = 5.0
    f0, t = pw.dio(x, sr, frame_period=frame_ms)
    f0 = pw.stonemask(x, f0, t, sr)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)

    n_out = max(2, int(round(f0.shape[0] / float(rate))))
    src_idx = np.linspace(0, f0.shape[0] - 1, n_out)
    lo = np.floor(src_idx).astype(int)
    hi = np.minimum(lo + 1, f0.shape[0] - 1)
    frac = (src_idx - lo)[:, None]

    # F0 must be interpolated in voiced regions only, otherwise unvoiced frames
    # (f0 == 0) bleed in and create warbling.
    f0_out = np.zeros(n_out, dtype=np.float64)
    voiced = f0 > 0
    if voiced.any():
        idxv = np.where(voiced)[0]
        f0_out = np.interp(src_idx, idxv, f0[idxv])
        # keep unvoiced frames unvoiced
        near = np.rint(src_idx).astype(int).clip(0, f0.shape[0] - 1)
        f0_out[~voiced[near]] = 0.0
    if pitch_ratio != 1.0:
        f0_out = f0_out * float(pitch_ratio)

    sp_out = sp[lo] * (1.0 - frac) + sp[hi] * frac
    ap_out = ap[lo] * (1.0 - frac) + ap[hi] * frac

    y = pw.synthesize(np.ascontiguousarray(f0_out),
                      np.ascontiguousarray(sp_out),
                      np.ascontiguousarray(ap_out), sr, frame_ms)
    y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > 1.0:
        y = y / peak * 0.99
    return np.ascontiguousarray(y, dtype=np.float32)


def time_stretch(mono, sr, rate):
    """Stretch/compress mono audio by `rate` while preserving pitch.
    Operates at the audio's OWN sample rate `sr`. Uses rubberband (best),
    falling back to librosa's phase-vocoder. Returns 1-D float32.

    rate > 1.0 makes it faster/shorter; rate < 1.0 slower/longer.
    """
    import numpy as np

    mono = np.ascontiguousarray(
        mono.mean(axis=1) if getattr(mono, "ndim", 1) > 1 else mono,
        dtype=np.float32,
    )
    if abs(rate - 1.0) < 0.02:
        return mono

    # Clamp so speech never sounds like a chipmunk or a drawl.
    # Heavy compression is exactly what made earlier dubs sound robotic, so the
    # ceiling is deliberately modest now: the AI script stage budgets each
    # translation to its slot, so most lines need <=1.2x (measured). When a line
    # still runs long we prefer a small overflow with natural delivery — the
    # placement logic nudges it and never drops it — over squeezing it 2x.
    rate = max(0.75, min(1.6, rate))

    # 1) WORLD vocoder (pyworld) — analysis/synthesis built for SPEECH. It
    #    resynthesises from pitch + spectral envelope, so changing duration does
    #    not smear phase. librosa's phase vocoder (the old fallback here) is
    #    what produced the metallic, robotic artefact, because rubberband was
    #    not installed on this machine.
    try:
        return _world_stretch(mono, sr, rate)
    except Exception:
        pass
    try:
        import pyrubberband as prb
        return prb.time_stretch(mono, sr, rate).astype(np.float32)
    except Exception:
        pass
    try:
        import librosa
        return librosa.effects.time_stretch(mono, rate=rate).astype(np.float32)
    except Exception:
        pass
    # Last resort: linear-interp resample (slightly changes pitch).
    new_len = max(1, int(len(mono) / rate))
    idx = np.linspace(0, len(mono) - 1, new_len)
    return np.interp(idx, np.arange(len(mono)), mono).astype(np.float32)


def resample_audio(mono, src_sr, dst_sr):
    """Proper, pitch-preserving sample-rate conversion. Uses librosa (soxr/
    kaiser) — NOT nearest-neighbour indexing, which would alias and raise
    the perceived pitch ('chipmunk' effect)."""
    import numpy as np
    if src_sr == dst_sr:
        return np.ascontiguousarray(mono, dtype=np.float32)
    try:
        import librosa
        return librosa.resample(
            np.ascontiguousarray(mono, dtype=np.float32),
            orig_sr=src_sr, target_sr=dst_sr,
        ).astype(np.float32)
    except Exception:
        # High-quality fallback: linear interpolation (still pitch-correct,
        # unlike nearest-neighbour).
        n = max(1, int(len(mono) * dst_sr / src_sr))
        idx = np.linspace(0, len(mono) - 1, n)
        return np.interp(idx, np.arange(len(mono)), mono).astype(np.float32)


# How far a clip may be nudged later when the previous one overran. Bounded so
# one long line cannot cascade the whole timeline out of sync (or off the end).
MAX_NUDGE_SECONDS = 0.6


def build_voice_track(pieces, background_wav, work_dir):
    """Lay translated segments onto a track the length of the background,
    fitting each segment to its ORIGINAL time slot with pitch-preserving
    time-stretching (sync-aware timing).

    Each piece is (start_seconds, end_seconds, wav_path). The translated clip
    is stretched/compressed so it occupies roughly the same span as the
    original speech, landing on the same cuts as the source video. A small
    overflow is allowed (pushing the next clip later) rather than overlapping.
    """
    emit("mix", 88, "Aligning speech to original timing")
    import numpy as np
    import soundfile as sf

    bg, sr = sf.read(background_wav, always_2d=True)
    total_len = bg.shape[0]
    channels = bg.shape[1]
    voice = np.zeros((total_len, channels), dtype=np.float32)

    pieces = sorted(pieces, key=lambda p: p[0])
    cursor = 0  # earliest sample the next clip may start at
    dropped = []    # segments that produced no usable audio
    overflows = []  # segments that couldn't fully fit their slot
    late = []       # segments pulled back because they'd land past the end
    truncated = []  # segments clipped by the end of the track

    for idx, (start, end, path) in enumerate(pieces):
        # A missing or empty clip means the TTS engine failed on this segment.
        # Do NOT silently leave dead air — record it loudly so it surfaces in
        # logs and the UI, and so the gap is explainable.
        if not path or not os.path.exists(path) or os.path.getsize(path) <= 44:
            dropped.append((idx, start, end, "missing/empty file"))
            emit("mix", 88,
                 f"WARNING: segment {idx} ({start:.2f}-{end:.2f}s) produced no "
                 "audio; leaving a gap")
            continue

        clip, dsr = sf.read(path, always_2d=True)
        mono = clip.mean(axis=1).astype(np.float32)  # work in mono at native sr

        if len(mono) == 0:
            dropped.append((idx, start, end, "zero-length audio"))
            emit("mix", 88,
                 f"WARNING: segment {idx} ({start:.2f}-{end:.2f}s) decoded to "
                 "zero samples; leaving a gap")
            continue

        # 1) Time-stretch at the clip's OWN sample rate so pitch is preserved.
        slot = max(0.0, end - start)
        slot_samples_native = int(slot * dsr)
        # Any stretching costs voice quality, so skip it when the clip already
        # fits within a small tolerance. The synthesis stage now rewrites long
        # lines so they fit naturally, which means most clips land here and are
        # passed through completely untouched.
        fit_ratio = (len(mono) / slot_samples_native) if slot_samples_native else 1.0
        # Only ever COMPRESS an over-long clip. A clip shorter than its slot is
        # fine as-is: it simply leaves a natural pause. Stretching it longer to
        # fill the slot buys nothing and costs voice quality, so we pass it
        # through untouched.
        if slot_samples_native > dsr * 0.3 and len(mono) > 0 \
                and fit_ratio > 1.12:
            rate = fit_ratio  # >1 => compress to fit
            if rate > 1.6:
                # Translation is much longer than its slot. time_stretch clamps
                # at 1.6x to protect quality, so flag the residual overflow —
                # the clip will run past its slot and push later clips back.
                overflows.append((idx, round(rate, 2)))
            mono = time_stretch(mono, dsr, rate)

        # 2) Properly resample from the clip's native rate to the track rate.
        #    (Nearest-neighbour indexing here was causing the chipmunk effect.)
        mono = resample_audio(mono, dsr, sr)

        # 3) To stereo to match the background track.
        data = np.repeat(mono.reshape(-1, 1), channels, axis=1)

        # Placement: stay locked to the ORIGINAL timestamp so the dub keeps
        # lip/scene sync. Previously we pushed each clip to start after the
        # previous one ended (cursor), which cascaded: one over-long clip
        # delayed every later clip, and once the cursor passed the end of the
        # track the remaining segments were silently dropped (this is what
        # caused ~10s of dead air). Now we only allow a small, bounded nudge,
        # and we never drop a segment for being late.
        want = int(start * sr)
        max_nudge = int(MAX_NUDGE_SECONDS * sr)
        pos = want if cursor <= want else min(cursor, want + max_nudge)
        if pos >= total_len:
            # Would land past the end: pull it back so it is still audible.
            pos = max(0, total_len - data.shape[0])
            late.append(idx)

        seg_end = min(pos + data.shape[0], total_len)
        if seg_end > pos:
            voice[pos:seg_end] += data[: seg_end - pos].astype(np.float32)
            cursor = seg_end + int(0.04 * sr)  # tiny gap between clips
            if data.shape[0] > seg_end - pos:
                truncated.append(idx)
        else:
            dropped.append((idx, start, end, "no room left in track"))
            emit("mix", 88,
                 f"WARNING: segment {idx} ({start:.2f}-{end:.2f}s) had no room "
                 "in the track; dropped")

    # Normalize the voice track to a consistent, audible peak.
    peak = float(np.max(np.abs(voice))) if voice.size else 0.0
    if peak > 0:
        voice = voice * (0.89 / peak)

    voice_path = os.path.join(work_dir, "voice_track.wav")
    sf.write(voice_path, voice, sr)
    artifact_file(voice_path, "06_cloned_voice_track.wav",
                  "Step 6-7: Cloned voice, timing-aligned (no music)")

    # Loudly report any dropped or overflowing segments so silent gaps and
    # timeline drift are explainable rather than mysterious dead air.
    if dropped or overflows or late or truncated:
        report = ["TIMING / SYNTHESIS ISSUES", ""]
        if dropped:
            report.append(f"DROPPED ({len(dropped)}) — these left a gap:")
            for idx, s, e, why in dropped:
                report.append(f"  seg {idx}: {s:.2f}-{e:.2f}s — {why}")
        if overflows:
            report.append("")
            report.append(f"OVERFLOWED ({len(overflows)}) — clamped to 2.2x, "
                          "ran past slot:")
            for idx, r in overflows:
                report.append(f"  seg {idx}: needed {r}x compression")
        if late:
            report.append("")
            report.append(f"PULLED BACK ({len(late)}) — would have landed past "
                          f"the end of the track: {late}")
        if truncated:
            report.append("")
            report.append(f"TRUNCATED ({len(truncated)}) — tail cut by end of "
                          f"track: {truncated}")
        artifact_text("\n".join(report), "06_timing_issues.txt",
                      "Step 6-7: Dropped/overflowed segment report")
        emit("mix", 92,
             f"{len(dropped)} segment(s) dropped, {len(overflows)} overflowed "
             "(see 06_timing_issues.txt)")
    return voice_path


def mix_and_mux(video, voice_wav, background_wav, output):
    """Mix voice + background, then attach to the original video stream.

    The background music is ducked (sidechain-compressed) whenever the voice
    is speaking, so the translated voice is always clearly audible while the
    music still fills the gaps.
    """
    emit("mix", 93, "Mixing voice with background music")
    work = os.path.dirname(voice_wav)
    mixed = os.path.join(work, "final_audio.wav")
    # [0]=voice, [1]=background. The voice is used twice (as the sidechain key
    # to duck the music, and in the final mix), so it must be split with
    # asplit — a label can only be consumed once in ffmpeg.
    filter_complex = (
        "[0:a]aformat=channel_layouts=stereo,volume=2.0,asplit=2[vox1][vox2];"
        "[1:a]aformat=channel_layouts=stereo[bg];"
        "[bg][vox1]sidechaincompress=threshold=0.03:ratio=12:attack=20:"
        "release=300[bgduck];"
        "[vox2][bgduck]amix=inputs=2:duration=longest:weights=1 0.7[mix];"
        "[mix]dynaudnorm[a]"
    )
    run([
        FFMPEG, "-y",
        "-i", voice_wav,
        "-i", background_wav,
        "-filter_complex", filter_complex,
        "-map", "[a]",
        mixed,
    ])
    artifact_file(mixed, "07_final_mixed_audio.wav",
                  "Step 7: Final audio (voice + ducked music)")

    emit("mux", 97, "Rebuilding video with new audio")
    # Replace the video's audio, keep original video frames.
    run([
        FFMPEG, "-y",
        "-i", video,
        "-i", mixed,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        output,
    ])


# XTTS supports a fixed set of language codes.
XTTS_LANGS = {
    "en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru", "nl",
    "cs", "ar", "zh-cn", "ja", "hu", "ko", "hi",
}


def map_xtts_lang(code):
    if code == "zh":
        return "zh-cn"
    if code in XTTS_LANGS:
        return code
    # Fall back to English voice model if target isn't supported by XTTS.
    return "en"


def lipsync(video, output, work_dir):
    """Run Wav2Lip to align the speaker's lips to the new audio.

    Wav2Lip lives in its own venv (.venv_lip). It is research/non-commercial
    licensed. It needs a visible face; if none is found it raises and the
    caller keeps the non-lip-synced video.
    """
    emit("lipsync", 90, "Lip-syncing the speaker to the new audio")
    lip_python = venv_python(".venv_lip")
    inference = os.path.join(PROJECT_ROOT, "wav2lip", "inference.py")
    checkpoint = os.path.join(
        PROJECT_ROOT, "wav2lip", "checkpoints", "wav2lip_gan.pth"
    )
    if not os.path.exists(lip_python) or not os.path.exists(checkpoint):
        raise RuntimeError("Wav2Lip environment or checkpoint not found.")

    env = dict(os.environ)
    # Ensure ffmpeg (shared build) is on PATH for Wav2Lip's final mux.
    env["PATH"] = os.path.dirname(FFMPEG) + os.pathsep + env.get("PATH", "")

    # Wav2Lip runs with cwd in the wav2lip dir (for its temp/ output), so all
    # input/output paths must be absolute.
    face = os.path.abspath(video)
    lip_out = os.path.abspath(output) + ".lip.mp4"

    # Wav2Lip needs temp/ to exist, and converting a non-wav audio source uses
    # an unquoted ffmpeg call that breaks on spaced paths. Avoid both by
    # extracting the dubbed audio to a .wav ourselves and passing that.
    wav2lip_dir = os.path.join(PROJECT_ROOT, "wav2lip")
    os.makedirs(os.path.join(wav2lip_dir, "temp"), exist_ok=True)
    audio_wav = os.path.join(work_dir, "lip_audio.wav")
    run([FFMPEG, "-y", "-i", os.path.abspath(output), "-ar", "16000", audio_wav])

    # Wav2Lip writes to temp/ relative to cwd, so run from the wav2lip dir.
    proc = subprocess.run(
        [
            lip_python, inference,
            "--checkpoint_path", checkpoint,
            "--face", face,
            "--audio", os.path.abspath(audio_wav),
            "--outfile", lip_out,
            "--nosmooth",
            "--pads", "0", "20", "0", "0",
        ],
        cwd=wav2lip_dir,
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0 or not os.path.exists(lip_out):
        raise RuntimeError(
            "Wav2Lip failed (no face detected?). "
            + proc.stderr[-800:]
        )
    # Replace the dubbed video with the lip-synced version.
    shutil.move(lip_out, output)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--source", default="auto")
    ap.add_argument("--target", required=True)
    ap.add_argument("--lipsync", action="store_true",
                    help="Also lip-sync the speaker to the new audio (Wav2Lip).")
    ap.add_argument("--artifacts-dir", default=None,
                    help="If set, save each stage's output here for download.")
    ap.add_argument("--engine", default="google",
                    choices=["google", "voicestudio"],
                    help="Dubbing engine: 'google' (Gemini TTS pipeline) or "
                         "'voicestudio' (real voice cloning on the GPU box).")
    args = ap.parse_args()

    global ARTIFACTS_DIR
    if args.artifacts_dir:
        ARTIFACTS_DIR = args.artifacts_dir
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)

    work_dir = tempfile.mkdtemp(prefix="dub_")
    try:
        emit("start", 1, "Starting dubbing pipeline")

        # Engine 2: VoiceStudio on the GPU box. It does real zero-shot voice
        # cloning (the strongest clone quality we have), while our Gemini pass
        # supplies the script — its own ASR/translation engines are weaker and
        # its bundled translators do not know how long a line may be.
        if args.engine == "voicestudio":
            from voicestudio_dub import dub_video
            # Passing a speaker count helps diarization commit to multiple
            # speakers instead of collapsing every character into one voice.
            n_spk = os.environ.get("VS_NUM_SPEAKERS")
            dub_video(args.input, args.output, args.source, args.target,
                      num_speakers=int(n_spk) if n_spk else None,
                      emit=emit, artifact_text=artifact_text,
                      artifact_file=artifact_file)
            artifact_file(args.output, "08_final_dubbed_video.mp4",
                          "Step 8: Final dubbed video (VoiceStudio)")
            emit("done", 100, "Dubbing complete")
            return

        raw_wav = os.path.join(work_dir, "audio.wav")
        extract_audio(args.input, raw_wav)

        vocals, background = separate_audio(raw_wav, work_dir)
        segments, detected = transcribe(vocals, args.source,
                                        original_audio=raw_wav,
                                        target_lang=args.target)

        if not segments:
            raise RuntimeError("No speech detected in the video.")

        src = args.source if args.source not in ("", "auto") else detected
        # Gemini already produced the translation while listening, so only run
        # the separate translation stage when it did not.
        if getattr(transcribe, "gemini_done", False):
            for seg in segments:
                seg["translated"] = _normalize_for_tts(
                    seg.get("translated", ""), args.target)
            lines = [f"Target language: {args.target}", ""]
            for i, seg in enumerate(segments):
                lines.append(f"[{i:02d}] SRC: {seg.get('text','')}")
                lines.append(f"     DST: {seg.get('translated','')}")
            artifact_text("\n".join(lines), "05_translation.txt",
                          "Step 5: Translation (target language)")
            emit("translate", 56, "Script ready (from Gemini audio pass)")
        else:
            segments = translate_segments(segments, src, args.target)

        voice_track = synthesize(
            segments, vocals, background, args.target, work_dir
        )
        mix_and_mux(args.input, voice_track, background, args.output)

        if args.lipsync:
            try:
                lipsync(args.input, args.output, work_dir)
            except Exception as e:
                # Lip-sync is best-effort; keep the dubbed video on failure.
                emit("lipsync", 96, f"Lip-sync skipped: {e}")

        artifact_file(args.output, "08_final_dubbed_video.mp4",
                      "Step 8: Final dubbed video")
        emit("done", 100, "Dubbing complete")
    except Exception as e:
        emit("error", 0, str(e))
        sys.exit(1)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
