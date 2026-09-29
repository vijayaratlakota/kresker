"""
Google Cloud TTS voice-cloning backend (Chirp 3: Instant Custom Voice).

This is an optional Stage-6 backend that can replace IndicF5 for Indian
languages when the project is allow-listed for Chirp 3: Instant Custom Voice.
It runs in the MAIN .venv (which has google-cloud-texttospeech installed), so
dub.py imports it directly instead of spawning a separate venv.

Output contract (identical to synth_indic / synth_xtts):
  produces seg_XXXX.wav clips and returns [(start, end, path), ...]
  Every clip is written at the native rate the API returns (24000 Hz) and the
  header is verified, mirroring the sample-rate hardening in indic_tts.py.

CONSENT REQUIREMENT (read this)
-------------------------------
Instant Custom Voice legally and technically requires a recorded consent
statement spoken by the voice talent (the person whose voice is cloned), using
Google's exact consent script for the language. This backend will NOT clone a
voice without that consent clip. For a dubbing pipeline this means you must
have the speaker's consent recording; you cannot clone an arbitrary speaker
from a downloaded video. Provide it via:
  - env CHIRP_CONSENT_WAV=<path>            (one consent clip for all speakers)
  - env CHIRP_CONSENT_WAV_SPK<N>=<path>     (per-speaker override, N = speaker id)

Auth: Application Default Credentials, or a service-account key via
  env GOOGLE_APPLICATION_CREDENTIALS=<path>.
Project: env GOOGLE_CLOUD_PROJECT or CHIRP_PROJECT.

Tunables:
  CHIRP_PROJECT          GCP project id (else ADC/key default)
  CHIRP_CONSENT_SCRIPT   override consent text (defaults to en-US script)
  CHIRP_CONSENT_LANG     language_code used when generating the cloning key
                         (must match the consent recording; default en-US)
"""

import json
import os
import wave

import numpy as np
import soundfile as sf


# IndicF5 short codes -> Chirp 3 Instant Custom Voice BCP-47 locales.
# Only languages Instant Custom Voice actually supports are listed; anything
# else should fall back to IndicF5 (handled by the caller).
CHIRP_LANG = {
    "hi": "hi-IN",   # Hindi
    "te": "te-IN",   # Telugu
    "ta": "ta-IN",   # Tamil
    "kn": "kn-IN",   # Kannada
    "ml": "ml-IN",   # Malayalam
    "bn": "bn-IN",   # Bengali
    "gu": "gu-IN",   # Gujarati
    "mr": "mr-IN",   # Marathi
    # NOT supported by Instant Custom Voice (fall back to IndicF5):
    #   or (Odia), pa (Punjabi), as (Assamese)
}

NATIVE_SR = 24000  # Chirp 3 outputs LINEAR16 @ 24kHz.

DEFAULT_CONSENT_SCRIPT = (
    "I am the owner of this voice and I consent to Google using this voice to "
    "create a synthetic voice model."
)


def supports(target_lang):
    """True if Instant Custom Voice supports this target language."""
    return target_lang in CHIRP_LANG


def _emit(stage, pct, message="", device=None):
    evt = {"stage": stage, "pct": pct, "message": message}
    if device:
        evt["device"] = device
    print(json.dumps(evt), flush=True)


def _read_wav_bytes_linear16(path):
    """Read any WAV/audio into mono 16-bit PCM LINEAR16 bytes the API expects.
    Returns raw PCM frame bytes (not a WAV container)."""
    data, sr = sf.read(path, always_2d=True)
    mono = data.mean(axis=1)
    # Clamp to [-1, 1] then to int16.
    mono = np.clip(mono, -1.0, 1.0)
    pcm16 = (mono * 32767.0).astype("<i2")
    return pcm16.tobytes(), sr


def _wav_container_linear16(path):
    """Return a full LINEAR16 WAV container (bytes) at the source sample rate.
    The generateVoiceCloningKey API accepts LINEAR16 content as a WAV file."""
    pcm, sr = _read_wav_bytes_linear16(path)
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


def _consent_path_for(spk):
    """Resolve the consent WAV for a speaker (per-speaker, then global)."""
    per = os.environ.get(f"CHIRP_CONSENT_WAV_SPK{spk}")
    if per and os.path.exists(per):
        return per
    glob = os.environ.get("CHIRP_CONSENT_WAV")
    if glob and os.path.exists(glob):
        return glob
    return None


class ChirpCloner:
    """Creates and caches one voice cloning key per speaker, then synthesizes."""

    def __init__(self, project=None):
        from google.cloud import texttospeech_v1beta1 as tts
        import google.auth

        self._tts = tts
        if project is None:
            project = os.environ.get("CHIRP_PROJECT") \
                or os.environ.get("GOOGLE_CLOUD_PROJECT")
        if not project:
            # Fall back to whatever ADC / the key file reports.
            try:
                _, project = google.auth.default()
            except Exception:
                project = None
        if not project:
            raise RuntimeError(
                "No GCP project. Set CHIRP_PROJECT or GOOGLE_CLOUD_PROJECT.")
        self.project = project
        self.client = tts.TextToSpeechClient(
            client_options={"quota_project_id": project}
        )
        self._keys = {}  # spk -> voice_cloning_key
        self.consent_lang = os.environ.get("CHIRP_CONSENT_LANG", "en-US")
        self.consent_script = os.environ.get(
            "CHIRP_CONSENT_SCRIPT", DEFAULT_CONSENT_SCRIPT)

    def _cloning_key(self, spk, ref_wav):
        if spk in self._keys:
            return self._keys[spk]

        consent_wav = _consent_path_for(spk)
        if not consent_wav:
            raise RuntimeError(
                f"No consent recording for speaker {spk}. Instant Custom Voice "
                "requires the voice talent's recorded consent. Set "
                "CHIRP_CONSENT_WAV (or CHIRP_CONSENT_WAV_SPK"
                f"{spk}) to a WAV of the consent statement.")

        tts = self._tts
        req = tts.GenerateVoiceCloningKeyRequest(
            reference_audio=tts.InputAudio(
                audio_config=tts.AudioConfig(
                    audio_encoding=tts.AudioEncoding.LINEAR16),
                content=_wav_container_linear16(ref_wav),
            ),
            voice_talent_consent=tts.InputAudio(
                audio_config=tts.AudioConfig(
                    audio_encoding=tts.AudioEncoding.LINEAR16),
                content=_wav_container_linear16(consent_wav),
            ),
            consent_script=self.consent_script,
            language_code=self.consent_lang,
        )
        resp = self.client.generate_voice_cloning_key(request=req)
        self._keys[spk] = resp.voice_cloning_key
        return self._keys[spk]

    def synth(self, spk, ref_wav, text, language_code):
        """Return (float32_mono, sr) for one segment."""
        tts = self._tts
        key = self._cloning_key(spk, ref_wav)

        voice = tts.VoiceSelectionParams(
            language_code=language_code,
            voice_clone=tts.VoiceCloneParams(voice_cloning_key=key),
        )
        request = tts.SynthesizeSpeechRequest(
            input=tts.SynthesisInput(text=text),
            voice=voice,
            audio_config=tts.AudioConfig(
                audio_encoding=tts.AudioEncoding.LINEAR16,
                sample_rate_hertz=NATIVE_SR,
            ),
        )
        resp = self.client.synthesize_speech(request=request)
        # audio_content is a LINEAR16 WAV container.
        import io
        audio, sr = sf.read(io.BytesIO(resp.audio_content), always_2d=False)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        return audio, int(sr)


def _write_clip(path, audio, sr):
    """Write and verify the header rate, same discipline as indic_tts.py."""
    sf.write(path, audio, sr, subtype="PCM_16")
    info = sf.info(path)
    if int(info.samplerate) != int(sr):
        raise RuntimeError(
            f"sample-rate header mismatch for {path}: wrote {sr} but file "
            f"reports {info.samplerate}")
    return int(info.samplerate)


def synth_cloud(segments, speaker_refs, indic_refs, target_lang, seg_dir):
    """Stage-6 backend using Chirp 3 Instant Custom Voice.

    Mirrors synth_indic's signature/return so dub.py can swap it in:
      returns [(start, end, wav_path), ...]

    speaker_refs : {spk: ref_wav_path}        (from diarize_segments)
    indic_refs   : {spk: (ref_wav_path, text)} (cleaner single-segment refs)
    """
    os.makedirs(seg_dir, exist_ok=True)
    language_code = CHIRP_LANG[target_lang]
    _emit("synthesize", 60, "Loading voice cloning model (Chirp 3 cloud)")

    cloner = ChirpCloner()

    def ref_for(spk):
        if indic_refs and spk in indic_refs:
            return indic_refs[spk][0]
        if speaker_refs and spk in speaker_refs:
            return speaker_refs[spk]
        if indic_refs:
            return next(iter(indic_refs.values()))[0]
        return next(iter(speaker_refs.values()))

    pieces = []
    total = len(segments)
    for i, seg in enumerate(segments):
        spk = seg.get("speaker", 0)
        text = (seg.get("translated") or seg["text"])
        out_path = os.path.join(seg_dir, f"seg_{i:04d}.wav")
        try:
            audio, sr = cloner.synth(spk, ref_for(spk), text, language_code)
            _write_clip(out_path, audio, sr)
            pieces.append((seg["start"], seg["end"], out_path))
            done = i + 1
            pct = 60 + int(25 * done / max(1, total))
            _emit("synthesize", min(pct, 85),
                  f"Voiced segment {done}/{total}", device="Cloud")
        except Exception as e:
            print(json.dumps({"index": i, "error": str(e)}), flush=True)

    if not pieces:
        raise RuntimeError("Chirp cloud TTS produced no audio.")
    return pieces
