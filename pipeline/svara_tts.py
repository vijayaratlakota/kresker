"""
Svara-TTS voice worker for Indian languages (kenpath/svara-tts-v1).

Svara is an Orpheus-style model (LLaMA-3.2-3B + SNAC 24kHz codec). It runs on
the GPU instance in the existing .venv_indic (transformers + torch.cuda) plus
the small `snac` package. We do plain transformers generation (NOT vLLM) to
keep the disk/footprint small.

Two modes per segment:
  - Zero-shot voice cloning: pass a reference WAV (+ optional transcript) so the
    output keeps the ORIGINAL speaker's voice.
  - Preset speaker: pass a speaker id like "Telugu (Male)".

Reuses the official engine modules (token format / SNAC decode) from the cloned
repo at SVARA_REPO so the token math matches upstream exactly.

CLI (batch, like indic_tts.py):
  python svara_tts.py --batch segs.json --outdir <dir> [--lang te] [--nfe ...]
segs.json: [{"index": i, "text": str, "ref": wav, "ref_text": str,
             "speaker": id, "voice": "Telugu (Male)", "emotion": "<happy>"}]
Prints JSON lines: {"index": i, "path": "...", "sr": 24000} or {"error": "..."}.

Output clips are written at the model's native 24000 Hz and the header is
verified on readback (same discipline as indic_tts.py) to prevent speed/pitch
distortion downstream.
"""

import argparse
import json
import os
import sys

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# Make the official engine importable.
SVARA_REPO = os.environ.get("SVARA_REPO", "/tmp/svara-tts-inference")
if SVARA_REPO and SVARA_REPO not in sys.path:
    sys.path.insert(0, SVARA_REPO)

import numpy as np
import soundfile as sf

NATIVE_SR = 24000
MODEL_REPO = os.environ.get("SVARA_REPO_ID", "kenpath/svara-tts-v1")

# Default preset voice per IndicF5 short code (used when no reference cloning).
DEFAULT_VOICE = {
    "hi": "Hindi (Male)", "te": "Telugu (Male)", "ta": "Tamil (Male)",
    "kn": "Kannada (Male)", "ml": "Malayalam (Male)", "bn": "Bengali (Male)",
    "gu": "Gujarati (Male)", "mr": "Marathi (Male)", "pa": "Punjabi (Male)",
    "as": "Assamese (Male)",
}


def _load():
    import torch
    from transformers import AutoModelForCausalLM
    from tts_engine.codec import SNACCodec, get_or_load_tokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(json.dumps({"info": f"device={device}"}), flush=True)

    tokenizer = get_or_load_tokenizer(MODEL_REPO)
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_REPO, torch_dtype=dtype, low_cpu_mem_usage=True,
    ).to(device).eval()
    codec = SNACCodec(device=device)
    return model, tokenizer, codec, device


def _ref_to_audio_tokens(codec, ref_wav):
    """Encode a reference WAV into Svara audio tokens (WITH offsets)."""
    import torch
    data, sr = sf.read(ref_wav, always_2d=True)
    mono = data.mean(axis=1).astype(np.float32)
    audio = torch.from_numpy(mono)
    return codec.encode_audio(audio, input_sample_rate=sr, add_token_offsets=True)


def _generate(model, tokenizer, codec, device, seg, lang):
    """Synthesise one segment -> (float32_mono, sr)."""
    import torch
    from tts_engine.encoder import svara_text_to_tokens
    from tts_engine.mapper import SvaraMapper
    from tts_engine.constants import END_OF_SPEECH, END_OF_AI, PAD_TOKEN

    text = seg["text"]
    emotion = seg.get("emotion")
    if emotion:
        text = f"{text} {emotion}"

    ref = seg.get("ref")
    audio_tokens = None
    transcript = None
    speaker = None
    if ref and os.path.exists(ref):
        audio_tokens = _ref_to_audio_tokens(codec, ref)
        transcript = seg.get("ref_text") or None
    else:
        speaker = seg.get("voice") or DEFAULT_VOICE.get(lang, "Hindi (Male)")

    input_ids = svara_text_to_tokens(
        text=text, speaker_id=speaker, audio_tokens=audio_tokens,
        transcript=transcript, tokenizer=tokenizer, return_decoded=False,
    )
    ids = torch.tensor([input_ids], dtype=torch.int64, device=device)

    with torch.inference_mode():
        out = model.generate(
            ids,
            max_new_tokens=int(os.environ.get("SVARA_MAX_NEW_TOKENS", "1200")),
            do_sample=True, temperature=0.6, top_p=0.95, repetition_penalty=1.1,
            eos_token_id=END_OF_SPEECH, pad_token_id=PAD_TOKEN,
        )
    gen = out[0, ids.shape[1]:].tolist()

    # Map generated audio token IDs -> raw SNAC codes, then SNAC-decode.
    mapper = SvaraMapper(window_size=7)  # full decode, frame by frame
    codes = []
    for tid in gen:
        if tid in (END_OF_SPEECH, END_OF_AI, PAD_TOKEN):
            break
        # Generated audio tokens are custom_token_N with id = 128256 + N;
        # audio codes start at N=10 (AUDIO_TOKENS_START=128266). Convert each
        # to a raw SNAC code using the band-offset rule (same as SvaraMapper).
        n = tid - 128256
        if n <= 0:
            continue
        code = n - 10 - ((mapper.good % 7) * 4096)
        if code <= 0:
            continue
        codes.append(code)
        mapper.good += 1

    if len(codes) < 7:
        raise RuntimeError("no audio tokens generated")

    audio = _full_snac_decode(codec, codes)
    if audio.size == 0:
        raise RuntimeError("empty decode")
    return audio, NATIVE_SR


def _full_snac_decode(codec, codes):
    """Decode ALL frames at once and keep the FULL waveform.

    codec.decode_window() is for streaming: it slices the stable middle
    (samples 2048:4096) of a tiny 4-frame window, so it can't reconstruct a
    whole utterance. For offline synthesis we rebuild the 3 hierarchical SNAC
    code streams from every frame and decode in one pass, keeping all samples.
    """
    import torch
    F = len(codes) // 7
    frame = codes[: F * 7]
    t = torch.tensor(frame, dtype=torch.int32, device=codec.device).view(F, 7)

    # Validate code range [0, 4096]; drop trailing if any frame is corrupt.
    if torch.any((t < 0) | (t > 4096)):
        # Keep the longest valid prefix of frames.
        valid = ((t >= 0) & (t <= 4096)).all(dim=1)
        if not bool(valid.any()):
            return np.zeros(0, dtype=np.float32)
        last = int(torch.where(valid)[0].max().item()) + 1
        t = t[:last]

    codes_0 = t[:, 0].reshape(1, -1)
    codes_1 = t[:, [1, 4]].reshape(1, -1)
    codes_2 = t[:, [2, 3, 5, 6]].reshape(1, -1)

    with torch.inference_mode():
        wav = codec.model.decode([codes_0, codes_1, codes_2])  # [1,1,T]
    x = wav.detach().float().cpu().numpy().reshape(-1)
    return np.clip(x, -1.0, 1.0).astype(np.float32)


def _write_clip(path, audio, sr):
    sf.write(path, audio, sr, subtype="PCM_16")
    info = sf.info(path)
    if int(info.samplerate) != int(sr):
        raise RuntimeError(
            f"sample-rate header mismatch for {path}: wrote {sr} "
            f"but file reports {info.samplerate}")
    return int(info.samplerate), int(info.frames)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--lang", default="hi")
    args = ap.parse_args()

    model, tokenizer, codec, device = _load()

    with open(args.batch, "r", encoding="utf-8") as f:
        segments = json.load(f)
    os.makedirs(args.outdir, exist_ok=True)

    for seg in segments:
        i = seg["index"]
        out_path = os.path.join(args.outdir, f"seg_{i:04d}.wav")
        try:
            audio, sr = _generate(model, tokenizer, codec, device, seg, args.lang)
            written_sr, frames = _write_clip(out_path, audio, sr)
            print(json.dumps({"index": i, "path": out_path,
                              "sr": written_sr, "frames": frames}), flush=True)
        except Exception as e:
            print(json.dumps({"index": i, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
