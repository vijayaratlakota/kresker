"""
IndicF5 voice-cloning TTS worker for Indian languages
(Tamil, Telugu, Malayalam, and other AI4Bharat-supported languages).

Runs in its own virtual environment (.venv_indic) because IndicF5 needs a
newer transformers than the XTTS environment.

Called as a CLI:
  python indic_tts.py --ref <ref_wav> --ref-text <txt> --text <txt> --out <wav>

It loads the model once if given a batch JSON via --batch, to avoid paying the
model-load cost per segment.

Batch mode:
  python indic_tts.py --ref <wav> --ref-text <txt> --batch <segments.json> --outdir <dir>
where segments.json is a list of {"index": int, "text": str}.
Prints JSON lines: {"index": i, "path": "...", "sr": 24000} or {"error": "..."}.

SAMPLE-RATE CONTRACT
--------------------
IndicF5 / F5-TTS generate at a single native rate (vocos vocoder = 24000 Hz).
The public model(...) call returns a BARE sample array with NO sample-rate
metadata, so this worker must label every file with the model's *authoritative*
rate, not a guessed literal. We read that rate from
``f5_tts.infer.utils_infer.target_sample_rate`` (the exact constant
``infer_process`` uses to synthesise) and write/verify every clip against it.
A wrong rate here is what causes the "chipmunk" speed/pitch distortion.
"""

import argparse
import json
import os
import sys

# Force UTF-8 so printing Indic text doesn't crash on Windows cp1252 consoles.
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import numpy as np
import soundfile as sf


def _patch_f5tts():
    """IndicF5's bundled code calls f5-tts load_model() without ckpt_path,
    and loads its own weights afterwards. Newer f5-tts made ckpt_path
    required and always tries to read it. We patch both so the redundant
    checkpoint read is skipped; IndicF5 then applies its real weights.
    """
    from f5_tts.infer import utils_infer

    orig_load_model = utils_infer.load_model
    orig_load_ckpt = utils_infer.load_checkpoint

    def patched_load_checkpoint(model, ckpt_path, device, dtype=None, use_ema=True):
        if not ckpt_path:
            return model  # skip; weights applied by IndicF5 separately
        return orig_load_ckpt(model, ckpt_path, device, dtype=dtype, use_ema=use_ema)

    def patched_load_model(model_cls, model_cfg, ckpt_path="", *args, **kwargs):
        return orig_load_model(model_cls, model_cfg, ckpt_path, *args, **kwargs)

    utils_infer.load_checkpoint = patched_load_checkpoint
    utils_infer.load_model = patched_load_model


# Filled in at runtime by the infer_process wrapper with the rate the model
# ACTUALLY generated at, captured straight from infer_process's return value.
# This is the ground truth and beats any config constant or hardcoded literal.
_OBSERVED_SR = {"value": None}


def native_sample_rate():
    """The authoritative rate the model synthesises at, from the config.

    This is the SAME constant ``infer_process`` uses internally, so the array
    returned by ``model(...)`` is at this rate. We read it instead of
    hardcoding 24000 so a future model/vocoder/checkpoint change cannot
    silently desync the file header from the data (the chipmunk bug). The
    runtime-observed rate (see ``effective_sample_rate``) takes precedence
    when available.
    """
    from f5_tts.infer import utils_infer

    sr = int(getattr(utils_infer, "target_sample_rate", 24000))
    if sr <= 0:
        raise RuntimeError(f"Invalid native sample rate from f5_tts: {sr!r}")
    return sr


def effective_sample_rate(config_sr):
    """Prefer the rate observed from infer_process at runtime over the config
    constant. If they disagree, the runtime value is the one the samples were
    actually produced at, so trust it (and surface the mismatch)."""
    obs = _OBSERVED_SR["value"]
    if obs and int(obs) != int(config_sr):
        print(json.dumps({
            "info": f"sr override: observed={obs} config={config_sr}"
        }), flush=True)
        return int(obs)
    return int(config_sr)


def load_model():
    _patch_f5tts()
    import torch
    from transformers import AutoModel

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(json.dumps({"info": f"device={device}"}), flush=True)

    # IndicF5 ships custom code; trust_remote_code is required.
    # The official ai4bharat/IndicF5 repo is gated; this is a public mirror.
    repo = os.environ.get("INDICF5_REPO", "AbhishekDelMundu/IndicF5")
    model = AutoModel.from_pretrained(repo, trust_remote_code=True)
    return model


def synth(model, ref_wav, ref_text, text, sr):
    """Synthesise one segment and return (float32_mono, sr).

    The model returns a bare sample array (int16-scaled, via pydub) at the
    native rate `sr`. We convert to float32 in [-1, 1] WITHOUT touching the
    length or rate, so duration/pitch are preserved exactly.
    """
    audio = model(
        text,
        ref_audio_path=ref_wav,
        ref_text=ref_text,
    )

    audio = np.asarray(audio).squeeze()
    if audio.ndim > 1:
        # Defensive: collapse any accidental channel dim to mono.
        audio = audio.mean(axis=tuple(range(1, audio.ndim)))

    audio = audio.astype(np.float32)
    # pydub's get_array_of_samples() yields int16-scaled values; integer dtypes
    # or any abs>1.0 mean it's still in int scale -> normalise to [-1, 1].
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / 32768.0

    if audio.size == 0:
        raise RuntimeError("model returned empty audio")

    # After the model has run, infer_process has reported the rate it really
    # generated at. Prefer it over the config constant so a hardcoded literal
    # inside the model can't desync the header from the data.
    return audio, effective_sample_rate(sr)


def _write_clip(path, audio, sr):
    """Write a clip with the EXACT matching sample-rate header, then verify
    the header on readback. Any divergence is the speed/pitch bug, so we fail
    loudly instead of shipping a broken clip.
    """
    # PCM_16 keeps files small and is what every downstream reader expects.
    sf.write(path, audio, sr, subtype="PCM_16")

    info = sf.info(path)
    if int(info.samplerate) != int(sr):
        raise RuntimeError(
            f"sample-rate header mismatch for {path}: "
            f"wrote {sr} but file reports {info.samplerate}"
        )
    return info.samplerate, info.frames


def _install_sr_capture():
    """Wrap infer_process so we record the sample rate it ACTUALLY returns.

    infer_process returns ``(wave, sample_rate, spec)`` (or yields it in the
    streaming path). The IndicF5 model discards that rate and writes its buffer
    with a hardcoded literal, so capturing it here is our only runtime-truthful
    source. Stored into the module-level _OBSERVED_SR slot.
    """
    from f5_tts.infer import utils_infer
    import sys

    orig = utils_infer.infer_process

    def _record(result):
        # Non-streaming path returns a tuple; be defensive about shape.
        try:
            if isinstance(result, tuple) and len(result) >= 2:
                sr = result[1]
                if isinstance(sr, (int, np.integer)) and int(sr) > 0:
                    _OBSERVED_SR["value"] = int(sr)
        except Exception:
            pass
        return result

    def patched(*args, **kwargs):
        return _record(orig(*args, **kwargs))

    utils_infer.infer_process = patched
    for mod in list(sys.modules.values()):
        if mod and getattr(mod, "__name__", "").endswith("model") \
                and hasattr(mod, "infer_process"):
            mod.infer_process = patched


def _patch_nfe(nfe_step):
    """Reduce the number of flow-matching denoising steps for speed.

    IndicF5/F5-TTS default to nfe_step=32. Lowering it (e.g. 16) roughly
    halves synthesis time with a modest quality cost. We wrap infer_process
    so the model's internal call uses our nfe_step without editing its code.
    This composes with _install_sr_capture (each wraps the current callable).
    """
    from f5_tts.infer import utils_infer

    orig = utils_infer.infer_process

    def patched(*args, **kwargs):
        kwargs.setdefault("nfe_step", nfe_step)
        return orig(*args, **kwargs)

    utils_infer.infer_process = patched
    # The model module imported infer_process by name, so patch it there too.
    import sys
    for mod in list(sys.modules.values()):
        if mod and getattr(mod, "__name__", "").endswith("model") \
                and hasattr(mod, "infer_process"):
            mod.infer_process = patched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--ref-text", required=True)
    ap.add_argument("--text")
    ap.add_argument("--out")
    ap.add_argument("--batch")
    ap.add_argument("--outdir")
    ap.add_argument("--nfe", type=int, default=16,
                    help="Flow-matching steps; lower is faster (default 16).")
    args = ap.parse_args()

    model = load_model()

    # Capture the rate infer_process actually returns (ground truth), and
    # resolve the config rate as a fallback. Install capture before the nfe
    # wrapper so the two compose cleanly.
    try:
        _install_sr_capture()
    except Exception as e:
        print(json.dumps({"info": f"sr capture install failed: {e}"}), flush=True)

    sr = native_sample_rate()
    print(json.dumps({"info": f"native_sr={sr}"}), flush=True)

    if args.nfe and args.nfe > 0:
        try:
            _patch_nfe(args.nfe)
            print(json.dumps({"info": f"nfe_step={args.nfe}"}), flush=True)
        except Exception as e:
            print(json.dumps({"info": f"nfe patch failed: {e}"}), flush=True)

    if args.batch:
        with open(args.batch, "r", encoding="utf-8") as f:
            segments = json.load(f)
        os.makedirs(args.outdir, exist_ok=True)
        for seg in segments:
            i = seg["index"]
            out_path = os.path.join(args.outdir, f"seg_{i:04d}.wav")
            # Each item may carry its own speaker reference; fall back to the
            # CLI-provided default ref/ref-text.
            ref = seg.get("ref", args.ref)
            ref_text = seg.get("ref_text", args.ref_text)
            try:
                audio, clip_sr = synth(model, ref, ref_text, seg["text"], sr)
                written_sr, frames = _write_clip(out_path, audio, clip_sr)
                print(json.dumps({
                    "index": i, "path": out_path,
                    "sr": int(written_sr), "frames": int(frames),
                }), flush=True)
            except Exception as e:
                print(json.dumps({"index": i, "error": str(e)}), flush=True)
    else:
        audio, clip_sr = synth(model, args.ref, args.ref_text, args.text, sr)
        written_sr, frames = _write_clip(args.out, audio, clip_sr)
        print(json.dumps({
            "path": args.out, "sr": int(written_sr), "frames": int(frames),
        }), flush=True)


if __name__ == "__main__":
    main()
