"""
Correct the dubbed voice's pitch to match the original speaker.

Why this is needed
------------------
The cloned voice comes out well below the speaker it is copying. Measured on a
real job:

    isolated source vocals   243.4 Hz
    clone reference clip     204.4 Hz   = 0.84x of the speaker
    rendered dub             175.5 Hz   = 0.86x of the reference
                                        0.84 x 0.86 = 0.72x overall

Two independent losses multiply: the reference is cut low, and the engine renders
below its own reference. Only the first is addressable upstream, and the engine
exposes no pitch parameter, so the reliable fix is to correct the finished voice
track against a measurement of the actual speaker.

Why it does not cause a chipmunk
--------------------------------
Chipmunk comes from resampling, which changes pitch AND duration together and
drags the formants with it. This uses WORLD analysis/synthesis: F0 is scaled while
the spectral envelope (which carries vowel identity and the voice's timbre) and the
duration are left untouched. So the voice keeps its identity and its timing, and
only the perceived pitch moves.

The correction factor is measured per job from that job's own audio, so it adapts
to every video, speaker and language rather than being a tuned constant.
"""

import os
import subprocess
import sys

import numpy as np
import soundfile as sf

# Leave pitch alone inside this band: below it the difference is inaudible and
# correcting would only add processing.
DEADBAND = float(os.environ.get("PITCH_DEADBAND", "0.06"))
# Refuse absurd corrections. A ratio far from 1 usually means one of the two
# measurements is wrong (wrong speaker isolated, music bleed, too little voiced
# audio) and shifting by it would wreck the voice.
MAX_SHIFT = float(os.environ.get("PITCH_MAX_SHIFT", "1.6"))
MIN_SHIFT = float(os.environ.get("PITCH_MIN_SHIFT", "0.7"))
MIN_VOICED_FRAMES = 40


def _ffmpeg():
    p = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "ffmpeg7", "ffmpeg-n7.1-latest-win64-gpl-shared-7.1", "bin", "ffmpeg.exe")
    return p if os.path.exists(p) else "ffmpeg"


def to_mono(src, dst, sr=16000, seconds=None):
    cmd = [_ffmpeg(), "-y", "-i", src, "-vn", "-ac", "1", "-ar", str(sr)]
    if seconds:
        cmd += ["-t", str(seconds)]
    subprocess.run(cmd + [dst], capture_output=True, check=True)
    return dst


def median_f0(path, seconds=None, floor=60.0, ceil=500.0):
    """Median fundamental frequency over voiced frames, or None."""
    tmp = path + ".f0.wav"
    try:
        to_mono(path, tmp, seconds=seconds)
        x, sr = sf.read(tmp)
    except Exception:
        return None
    finally:
        pass
    if x.ndim > 1:
        x = x.mean(axis=1)
    try:
        import pyworld as pw
        f0, _ = pw.dio(x.astype(np.float64), sr, f0_floor=floor, f0_ceil=ceil,
                       frame_period=10.0)
        voiced = f0[f0 > 0]
    except Exception:
        try:
            import librosa
            f0 = librosa.yin(x.astype(np.float32), fmin=floor, fmax=ceil, sr=sr)
            voiced = f0[np.isfinite(f0)]
        except Exception:
            voiced = np.array([])
    try:
        os.remove(tmp)
    except OSError:
        pass
    if voiced.size < MIN_VOICED_FRAMES:
        return None
    return float(np.median(voiced))


# Length of audio handed to WORLD at once, and the overlap crossfaded between
# blocks.
#
# A whole 9-minute track in one call crashed the interpreter outright: exit code
# 0xC0000409, STATUS_STACK_BUFFER_OVERRUN, raised inside pyworld's native code with
# no Python exception to catch. It had succeeded on the same file an hour earlier,
# so it is a resource limit rather than bad input, and the run it killed had
# already paid for two full renders.
#
# Blocking keeps peak memory roughly proportional to the block rather than the
# track. Seams are safe here because the shift is a constant multiplier: the F0
# contour is scaled identically on both sides of a boundary, so the crossfade joins
# two versions of the same signal.
PITCH_BLOCK_S = float(os.environ.get("PITCH_BLOCK_S", "45"))
PITCH_OVERLAP_S = float(os.environ.get("PITCH_OVERLAP_S", "0.5"))


def _shift_blocks(src_wav, dst_wav, ratio):
    """The actual WORLD pass, one block at a time."""
    import pyworld as pw

    x, sr = sf.read(src_wav)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = np.ascontiguousarray(x, dtype=np.float64)

    block = max(1, int(PITCH_BLOCK_S * sr))
    over = max(1, int(PITCH_OVERLAP_S * sr))
    out = np.zeros(len(x), dtype=np.float64)
    weight = np.zeros(len(x), dtype=np.float64)

    start = 0
    while start < len(x):
        end = min(len(x), start + block + over)
        seg = np.ascontiguousarray(x[start:end])
        f0, t = pw.harvest(seg, sr)
        sp = pw.cheaptrick(seg, f0, t, sr)
        ap = pw.d4c(seg, f0, t, sr)
        y = pw.synthesize(f0 * float(ratio), sp, ap, sr)
        y = y[:len(seg)]
        if len(y) < len(seg):
            y = np.pad(y, (0, len(seg) - len(y)))
        # Ramp in and out over the overlap so neighbouring blocks sum to unity.
        w = np.ones(len(seg))
        ramp = min(over, len(seg) // 2)
        if ramp > 1:
            if start > 0:
                w[:ramp] = np.linspace(0.0, 1.0, ramp)
            if end < len(x):
                w[-ramp:] = np.linspace(1.0, 0.0, ramp)
        out[start:end] += y * w
        weight[start:end] += w
        if end >= len(x):
            break
        start += block

    nz = weight > 1e-6
    out[nz] /= weight[nz]
    peak = float(np.abs(out).max()) if out.size else 0.0
    if peak > 0.99:                     # keep headroom, never clip
        out = out * (0.99 / peak)
    sf.write(dst_wav, out.astype(np.float32), sr)
    return dst_wav


def shift_pitch_file(src_wav, dst_wav, ratio):
    """Scale F0 by `ratio`, preserving duration and spectral envelope.

    WORLD decomposes speech into F0, a spectral envelope and an aperiodicity
    component. Multiplying only F0 and resynthesising moves the perceived pitch
    without touching vowel identity or timing — unlike resampling, which moves
    everything and produces the chipmunk effect.

    Runs in a CHILD PROCESS. A native crash in pyworld cannot be caught with
    try/except, and when it happened it took the whole dub down at 93% after two
    renders had completed. In a child process the worst case is a missing pitch
    correction, which the caller already knows how to fall back from.
    """
    import subprocess

    cmd = [sys.executable, os.path.abspath(__file__), "--shift",
           src_wav, dst_wav, str(ratio)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    except Exception as e:
        raise RuntimeError(f"pitch shift could not be started: {e}") from None
    if r.returncode != 0 or not os.path.exists(dst_wav):
        raise RuntimeError(
            f"pitch shift failed (exit {r.returncode}): "
            f"{(r.stderr or r.stdout or '')[-300:]}")
    return dst_wav


def plan_correction(speaker_ref_path, dub_path, seconds=90):
    """Measure both voices and decide the correction. Returns a dict."""
    src = median_f0(speaker_ref_path, seconds=seconds)
    dub = median_f0(dub_path, seconds=seconds)
    out = {"source_f0": src, "dub_f0": dub, "ratio": None,
           "apply": False, "reason": ""}
    if not src or not dub:
        out["reason"] = ("not enough voiced audio to measure pitch reliably"
                         if not src else "could not measure the dub's pitch")
        return out
    ratio = src / dub
    out["ratio"] = ratio
    if abs(ratio - 1.0) <= DEADBAND:
        out["reason"] = (f"pitch already within {DEADBAND:.0%} "
                         f"({ratio:.2f}x); leaving it alone")
        return out
    if not (MIN_SHIFT <= ratio <= MAX_SHIFT):
        out["reason"] = (f"measured ratio {ratio:.2f}x is outside the trusted "
                         f"range {MIN_SHIFT}-{MAX_SHIFT}; refusing to shift")
        return out
    out["apply"] = True
    out["reason"] = (f"source {src:.1f} Hz vs dub {dub:.1f} Hz "
                     f"-> raising dub pitch by {ratio:.2f}x")
    return out


def fetch_stems(base_url, job_id, work_dir, timeout=1800):
    """Download the dub's separated stems.

    /dub/export-stems returns a zip containing exactly the two tracks needed to
    correct the voice without touching the music:
        vocals_dubbed_<lang>.wav   the synthesized voice alone
        background_original.wav    everything else from the source
    Correcting the mixed file instead would pitch-shift the background too.
    """
    import io
    import urllib.request
    import zipfile

    url = base_url.rstrip("/") + f"/dub/export-stems/{job_id}"
    with urllib.request.urlopen(url, timeout=timeout) as r:
        raw = r.read()
    z = zipfile.ZipFile(io.BytesIO(raw))
    voice = bg = None
    for name in z.namelist():
        low = name.lower()
        dst = os.path.join(work_dir, os.path.basename(name))
        with open(dst, "wb") as f:
            f.write(z.read(name))
        if "vocals" in low:
            voice = dst
        elif "background" in low:
            bg = dst
    return voice, bg


def mux(video_path, voice_wav, bg_wav, out_path):
    """Rebuild the video with (voice + background) as its audio.

    normalize=0 keeps each stem at its original level — amix's default would
    halve both and quietly change the mix VoiceStudio produced. alimiter then
    catches any peak the sum creates instead of letting it clip.
    """
    inputs = [_ffmpeg(), "-y", "-i", video_path, "-i", voice_wav]
    if bg_wav:
        inputs += ["-i", bg_wav]
        filt = ("[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[m];"
                "[m]alimiter=limit=0.97[a]")
    else:
        filt = "[1:a]alimiter=limit=0.97[a]"
    cmd = inputs + [
        "-filter_complex", filt,
        "-map", "0:v:0", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-shortest", out_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"mux failed: {(r.stderr or '')[-400:]}")
    return out_path


def to_mp3(src, dst, bitrate="192k"):
    """Encode a stem to mp3 so it can be downloaded and listened to directly."""
    subprocess.run([_ffmpeg(), "-y", "-i", src, "-vn", "-c:a", "libmp3lame",
                    "-b:a", bitrate, dst], capture_output=True, check=True)
    return dst


def correct_dub_pitch(base_url, job_id, source_video, dubbed_video, out_path,
                      work_dir=None, emit=None, artifact_text=None,
                      artifact_file=None, segments=None):
    """Measure the pitch gap and, if real, rebuild the dub with it corrected.

    Falls back to the original dubbed file on any problem: a deep-sounding dub is
    much better than no dub, so nothing here is allowed to break the pipeline.
    Returns the path actually produced.
    """
    work_dir = work_dir or os.path.dirname(os.path.abspath(out_path)) or "."
    report = ["PITCH CORRECTION", ""]
    try:
        voice, bg = fetch_stems(base_url, job_id, work_dir)
    except Exception as e:
        report.append(f"could not fetch stems: {str(e)[:120]}")
        if emit:
            emit("mix", 93, f"Pitch correction skipped ({str(e)[:60]})")
        if artifact_text:
            artifact_text("\n".join(report) + "\n", "12_pitch.txt",
                          "Step 12: pitch correction")
        return dubbed_video
    if not voice:
        report.append("stems contained no voice track")
        if artifact_text:
            artifact_text("\n".join(report) + "\n", "12_pitch.txt",
                          "Step 12: pitch correction")
        return dubbed_video

    # Remove breath bursts at line starts before anything else touches the voice.
    # Runs on the isolated voice stem, so the background is never affected, and it
    # only attenuates — timing stays sample-aligned.
    # Breath or false start BEFORE the words. Detected from the audio itself, so it
    # needs no segment metadata and is unaffected by a rebuilt timeline.
    try:
        _, n_lead = attenuate_line_leadins(voice, report=report)
        if emit and n_lead:
            emit("mix", 92,
                 f"Removed a breath before the words on {n_lead} line(s)",
                 device="Cloud")
    except Exception as e:
        report.append(f"lead-in pass skipped: {str(e)[:100]}")

    # Sibilant bursts at clip tails, heard as an "sss" in the gap after a line.
    try:
        _, n_burst = suppress_hiss_bursts(voice, report=report)
        if emit and n_burst:
            emit("mix", 92,
                 f"Removed {n_burst} sibilant burst(s) between lines",
                 device="Cloud")
    except Exception as e:
        report.append(f"hiss burst pass skipped: {str(e)[:100]}")

    if segments:
        try:
            _, n_hiss = suppress_onset_hiss(voice, segments, report=report)
            if emit and n_hiss:
                emit("mix", 92,
                     f"Softened a breathy onset on {n_hiss} line(s)",
                     device="Cloud")
        except Exception as e:
            report.append(f"onset hiss pass skipped: {str(e)[:100]}")

    # Publish the stems as mp3 so each stage can be listened to on its own. This
    # is how a broken run gets diagnosed by ear: if the voice-only stem is clean
    # but the final video is not, the fault is in the mix; if the voice stem
    # itself buzzes, the fault is in synthesis.
    if artifact_file:
        try:
            artifact_file(to_mp3(voice, os.path.join(work_dir,
                                                     "_voice_raw.mp3")),
                          "13_voice_only_BEFORE_pitch.mp3",
                          "Voice only, straight from VoiceStudio (before pitch)")
            if bg:
                artifact_file(to_mp3(bg, os.path.join(work_dir, "_bg.mp3")),
                              "14_background_only.mp3",
                              "Background only (should contain NO speech)")
        except Exception as e:
            report.append(f"could not publish stem mp3s: {str(e)[:100]}")

    # The SOURCE video is the reference for what the speaker sounds like. Using it
    # rather than the clone reference corrects both losses at once: the reference
    # being cut low, and the engine rendering below its own reference.
    plan = plan_correction(source_video, voice)
    report += [f"source speaker : {plan['source_f0']}",
               f"dubbed voice   : {plan['dub_f0']}",
               f"ratio          : {plan['ratio']}",
               f"decision       : {plan['reason']}"]
    if not plan["apply"]:
        if emit:
            emit("mix", 93, f"Pitch: {plan['reason']}", device="Cloud")
        if artifact_text:
            artifact_text("\n".join(report) + "\n", "12_pitch.txt",
                          "Step 12: pitch correction")
        return dubbed_video

    try:
        if emit:
            emit("mix", 93,
                 f"Correcting voice pitch by {plan['ratio']:.2f}x "
                 f"({plan['dub_f0']:.0f} Hz -> {plan['source_f0']:.0f} Hz)",
                 device="Cloud")
        shifted = os.path.join(work_dir, "voice_pitch_corrected.wav")
        shift_pitch_file(voice, shifted, plan["ratio"])
        after = median_f0(shifted)
        report.append(f"after shift    : {after} Hz "
                      f"({(after/plan['source_f0']) if after else '?'} of source)")
        if artifact_file:
            try:
                artifact_file(to_mp3(shifted,
                                     os.path.join(work_dir, "_voice_fix.mp3")),
                              "15_voice_only_AFTER_pitch.mp3",
                              "Voice only, after pitch correction")
            except Exception:
                pass
        mux(dubbed_video, shifted, bg, out_path)
        report.append(f"rebuilt        : {out_path}")
        if artifact_file:
            try:
                artifact_file(to_mp3(out_path,
                                     os.path.join(work_dir, "_final.mp3")),
                              "16_final_audio.mp3",
                              "Final mixed audio of the delivered video")
            except Exception:
                pass
        if emit:
            emit("mix", 94, f"Voice pitch corrected to {after:.0f} Hz",
                 device="Cloud")
        result = out_path
    except Exception as e:
        report.append(f"correction failed, keeping the original dub: {str(e)[:150]}")
        if emit:
            emit("mix", 94, f"Pitch correction failed ({str(e)[:60]}); "
                            f"keeping the uncorrected dub")
        result = dubbed_video

    if artifact_text:
        artifact_text("\n".join(report) + "\n", "12_pitch.txt",
                      "Step 12: pitch correction")
    return result


# ── Onset hiss suppression ──────────────────────────────────────────────────
#
# The engine sometimes emits a breathy high-frequency burst before a line's first
# phoneme. It is not deterministic (the same text and reference rendered five times
# produced the burst once) and it is worse when the clone reference was cut from
# speech sitting over music, because the separated vocals carry residue there:
#
#     per_line reference    5 of 15 renders had a hissy onset
#     consistent reference  1 of 15
#
# Choosing `consistent` removes most of it, which is why VOICE_MATCH defaults there.
# This is the second line of defence for what still gets through.
#
# It only ever ATTENUATES high frequencies inside a short window at a line's start,
# and never trims or shifts audio. An earlier attempt that cut the leading audio
# made things measurably worse: removing the quiet lead puts the speech attack
# itself at the very start, and a plosive attack is legitimately high-frequency, so
# it both sounded worse and defeated the measurement. Leaving the timing alone
# avoids that whole class of mistake.
#
# The trigger is relative to the SAME line's own body, so a line whose onset is
# normal for that line is never touched, whatever the speaker or language.

# Window at the start of a line that can contain the burst. Measured leads before
# the first phoneme ran 120-440 ms; 150 ms covers the burst without reaching into
# the first syllable's vowel.
ONSET_WIN_S = float(os.environ.get("ONSET_WIN_S", "0.15"))
# How many times hissier than its own body an onset must be before we act. Clean
# lines measured 0.2-1.6 on this ratio and bursts measured 3.8-63, so 4.0 sits in
# the empty gap between the two populations rather than being tuned to one clip.
ONSET_HISS_FACTOR = float(os.environ.get("ONSET_HISS_FACTOR", "4.0"))
# Absolute floor as well, so a line whose body is near-silent cannot trigger on a
# huge ratio built from nothing.
ONSET_HISS_FLOOR = float(os.environ.get("ONSET_HISS_FLOOR", "0.25"))
# Fallback cut depth, used only when the band energies cannot be solved.
ONSET_CUT_DB = float(os.environ.get("ONSET_CUT_DB", "-14"))
# Deepest cut allowed. A burst whose window is pure noise needs far more than the
# -14 dB that fixes a moderate one, but an unbounded cut would audibly dull a real
# consonant if the trigger ever misfires.
ONSET_CUT_MAX_DB = float(os.environ.get("ONSET_CUT_MAX_DB", "-30"))

_HF_LO, _HF_HI = 4000.0, 9000.0
_LF_LO, _LF_HI = 80.0, 1000.0


def _band_energy(x, sr, lo, hi):
    """Energy of x between lo and hi Hz."""
    if len(x) < 64:
        return 0.0
    w = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * w)) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / sr)
    m = (freqs >= lo) & (freqs < hi)
    return float(spec[m].sum())


def hiss_ratio(x, sr):
    """Fraction of voice-band-plus-breath energy that sits in the breath band.

    Near 0 for voiced speech, near 1 for pure broadband noise.
    """
    lo = _band_energy(x, sr, _LF_LO, _LF_HI)
    hi = _band_energy(x, sr, _HF_LO, _HF_HI)
    return hi / (lo + hi) if (lo + hi) > 0 else 0.0


def _shelf_attenuate(seg, sr, cut_db):
    """Pull the high band of one short segment down by cut_db, via FFT.

    Applied to a 150 ms window, so an FFT-domain shelf is cheap and phase-safe
    enough; the window is faded in and out by the caller.
    """
    if len(seg) < 64:
        return seg
    spec = np.fft.rfft(seg)
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    gain = np.ones_like(freqs)
    g = 10.0 ** (cut_db / 20.0)
    # Smooth transition from 2 kHz to 4 kHz so the cut cannot sound like a filter
    # switching on mid-word.
    ramp = (freqs >= 2000.0) & (freqs < _HF_LO)
    gain[ramp] = np.interp(freqs[ramp], [2000.0, _HF_LO], [1.0, g])
    gain[freqs >= _HF_LO] = g
    return np.fft.irfft(spec * gain, n=len(seg))


def suppress_onset_hiss(wav_path, segments, out_path=None, report=None):
    """Attenuate breath bursts at line starts. Returns (path, lines_treated).

    `segments` supplies the start time of each line. Timing is never altered, so
    this is safe to run after fitting: the file that comes out is sample-aligned
    with the file that went in.
    """
    x, sr = sf.read(wav_path)
    mono_in = getattr(x, "ndim", 1) == 1
    data = x if mono_in else x.mean(axis=1)
    data = np.asarray(data, dtype=np.float64)
    out = np.array(x, dtype=np.float64, copy=True)

    win = max(1, int(ONSET_WIN_S * sr))
    treated, checked = 0, 0
    worst_before, worst_after = 0.0, 0.0
    for s in segments or []:
        try:
            start = float(s.get("start", 0.0))
        except (AttributeError, TypeError, ValueError):
            continue
        a = int(start * sr)
        b = min(len(data), a + win)
        if a < 0 or b - a < 64:
            continue
        # The same line's body, for comparison. Skip if the line is too short to
        # have one; there is then nothing to judge the onset against.
        ba = min(len(data), a + int(0.40 * sr))
        bb = min(len(data), a + int(1.50 * sr))
        if bb - ba < int(0.20 * sr):
            continue
        checked += 1
        h_on = hiss_ratio(data[a:b], sr)
        h_body = hiss_ratio(data[ba:bb], sr)
        worst_before = max(worst_before, h_on / max(h_body, 1e-6))
        if h_on < ONSET_HISS_FLOOR or h_on < ONSET_HISS_FACTOR * max(h_body, 1e-6):
            continue

        seg = data[a:b]
        # Size the cut to this line rather than using one fixed depth. A fixed
        # -14 dB fixed the moderate cases but barely moved an onset that was
        # ENTIRELY noise (measured 1.000 -> 0.995), because there was no voice
        # band left for the shelf to spare. Solving for the gain that lands the
        # onset near its own body's hissiness handles both ends.
        #
        #   want:  hi*g^2 / (lo + hi*g^2) = t     ->   g = sqrt(t*lo / (hi*(1-t)))
        lo_e = _band_energy(seg, sr, _LF_LO, _LF_HI)
        hi_e = _band_energy(seg, sr, _HF_LO, _HF_HI)
        target = min(0.5, max(0.12, 2.0 * h_body))
        cut_db = ONSET_CUT_DB
        if hi_e > 0 and lo_e > 0 and 0 < target < 1:
            g = np.sqrt(target * lo_e / (hi_e * (1.0 - target)))
            if g > 0:
                cut_db = float(np.clip(20.0 * np.log10(g), ONSET_CUT_MAX_DB, 0.0))
        fixed = _shelf_attenuate(seg, sr, cut_db)
        # Fade the correction in and out so the treated window cannot click or
        # sound like a gate opening.
        m = max(1, int(0.02 * sr))
        m = min(m, len(fixed) // 2)
        ramp = np.linspace(0.0, 1.0, m)
        blend = np.ones(len(fixed))
        blend[:m] = ramp
        blend[-m:] = ramp[::-1]
        mixed = seg * (1.0 - blend) + fixed * blend
        if mono_in:
            out[a:b] = mixed
        else:
            for ch in range(out.shape[1]):
                out[a:b, ch] = mixed
        worst_after = max(worst_after,
                          hiss_ratio(mixed, sr) / max(h_body, 1e-6))
        treated += 1

    dest = out_path or wav_path
    sf.write(dest, out, sr)
    if report is not None:
        report.append(f"onset hiss: checked {checked} line start(s), "
                      f"treated {treated}")
        report.append(f"worst onset/body ratio before {worst_before:.2f}")
        if treated:
            report.append(f"worst treated ratio after  {worst_after:.2f}")
    return dest, treated


# ── Line lead-in removal ────────────────────────────────────────────────────
#
# The engine often emits a short sound before a line's actual words: a breath or
# false start in the speaker's own voice. Measured on a delivered 546.7s dub, 10 of
# 29 line onsets began with a lead-in of 40-450 ms, median 150 ms, before speech
# became sustained.
#
# It is NOT a copy of the clone reference, which was the obvious suspect. Log-mel
# similarity of those lead-ins to the reference was 0.753 against 0.603 for a
# frame-shuffled control, a margin of only 0.136, and the best match landed
# scattered over the whole 14s reference (spread 3.68s) instead of clustering at one
# place. Nor is it one repeated clip: the lead-ins matched each other at 0.624,
# about the control baseline. The model simply generates a fresh breath each time,
# which is why it sounds like the same noise while measuring as different audio.
#
# So it cannot be fixed by cleaning the reference, and it is not deterministic
# enough to predict. It can be removed after the fact.
#
# This ATTENUATES the lead-in rather than cutting it out. Cutting would pull every
# following sample earlier and break the sync the rest of the pipeline works to
# hold; attenuation leaves the file sample-aligned. An earlier attempt that cut the
# lead inside the engine was reverted for exactly this reason.

# Longest lead-in to treat. Beyond this the quiet stretch is a real pause and the
# line simply starts late, which is a timing matter, not an artifact.
LEAD_MAX_S = float(os.environ.get("LEAD_MAX_S", "0.45"))
# Shortest lead-in worth touching. Below this it is the natural attack of the first
# consonant.
LEAD_MIN_S = float(os.environ.get("LEAD_MIN_S", "0.04"))
# Speech counts as sustained once this many consecutive 10 ms frames are above the
# level threshold. 12 frames = 120 ms, longer than any plosive burst but shorter
# than a syllable.
LEAD_SUSTAIN_FRAMES = int(os.environ.get("LEAD_SUSTAIN_FRAMES", "12"))
# How far to pull the lead-in down. -22 dB puts a breath below the noise floor of
# the surrounding speech without leaving a hole that reads as a cut.
LEAD_CUT_DB = float(os.environ.get("LEAD_CUT_DB", "-22"))


def _frame_rms(x, sr, frame_s=0.01):
    hop = max(1, int(sr * frame_s))
    n = len(x) // hop
    if n < 1:
        return np.zeros(0), hop
    trimmed = x[:n * hop].reshape(n, hop)
    return np.sqrt((trimmed ** 2).mean(axis=1) + 1e-12), hop


def find_line_leadins(x, sr):
    """Locate onsets whose speech does not start immediately.

    Returns [(onset_s, lead_s), ...]. Works off the audio alone, so it does not
    depend on segment metadata that the mixer may have rebuilt.
    """
    f, hop = _frame_rms(x, sr)
    if len(f) < 40:
        return []
    peak = float(np.percentile(f, 95))
    floor = float(np.percentile(f, 10))
    if peak <= floor * 1.5:
        return []
    thr = floor + 0.08 * (peak - floor)
    on = f >= thr

    out = []
    last = -1e9
    for i in range(30, len(on)):
        if not on[i] or on[max(0, i - 30):i].mean() >= 0.10:
            continue
        t = i * hop / sr
        if t - last <= 1.0:
            continue
        last = t
        # Walk forward to where speech becomes sustained.
        j = i
        limit = i + int(LEAD_MAX_S * sr / hop) + LEAD_SUSTAIN_FRAMES
        while j < min(len(on) - LEAD_SUSTAIN_FRAMES, limit):
            if on[j:j + LEAD_SUSTAIN_FRAMES].all():
                break
            j += 1
        lead = (j - i) * hop / sr
        if LEAD_MIN_S <= lead <= LEAD_MAX_S:
            out.append((t, lead))
    return out


def attenuate_line_leadins(wav_path, out_path=None, report=None):
    """Pull down the breath before each line's words. Returns (path, count).

    Timing is preserved exactly: the output is sample-aligned with the input, so
    this is safe to run after fitting.
    """
    x, sr = sf.read(wav_path)
    mono_in = getattr(x, "ndim", 1) == 1
    data = np.asarray(x if mono_in else x.mean(axis=1), dtype=np.float64)
    out = np.array(x, dtype=np.float64, copy=True)

    leads = find_line_leadins(data, sr)
    g = 10.0 ** (LEAD_CUT_DB / 20.0)
    for t, lead in leads:
        a = int(t * sr)
        b = min(len(data), int((t + lead) * sr))
        if b - a < 8:
            continue
        # Ramp back up to unity over the last 25% so the first phoneme is not
        # clipped if the sustain detector was a frame or two late.
        n = b - a
        gain = np.full(n, g)
        tail = max(1, n // 4)
        gain[-tail:] = np.linspace(g, 1.0, tail)
        if mono_in:
            out[a:b] *= gain
        else:
            for ch in range(out.shape[1]):
                out[a:b, ch] *= gain

    dest = out_path or wav_path
    sf.write(dest, out, sr)
    if report is not None:
        report.append(f"line lead-ins attenuated: {len(leads)}")
        if leads:
            report.append(
                f"lead length median "
                f"{float(np.median([l for _, l in leads]))*1000:.0f} ms, "
                f"longest {max(l for _, l in leads)*1000:.0f} ms")
    return dest, len(leads)


# ── Pure-hiss burst removal ─────────────────────────────────────────────────
#
# The engine leaves a sibilant burst at the tail of many generated clips: a run of
# audio whose energy is almost entirely above 4 kHz, at full speech loudness. It is
# heard as an "sss" after the words stop, which reads as a sound sitting in the gap
# before the next line.
#
# Measured on a delivered 546.7s dub of 176 lines: 103 such bursts totalling 21.8s,
# 120-360 ms each at -13 to -21 dB with a high-frequency fraction of 0.986-0.999.
# Two user-marked spots both fell inside detected bursts.
#
# The thresholds were calibrated against the SEPARATED ORIGINAL HUMAN VOICE from the
# same video, which contains real Telugu sibilants, so the detector had to tell a
# generated hiss from a genuine /s/:
#
#     fraction >= 0.97, >= 120 ms, >= -30 dB
#         103 bursts in the dub
#           2 in the human original          (51:1)
#
# Looser settings caught more of the dub but started taking real speech: at 0.90 and
# 80 ms the human original produced 39 hits. This is the setting where the two
# populations separate, rather than one tuned to a single clip.
#
# Like every other pass here it ATTENUATES and never cuts, so the output stays
# sample-aligned and the sync is untouched.

HISS_FRAC = float(os.environ.get("HISS_FRAC", "0.97"))
HISS_MIN_S = float(os.environ.get("HISS_MIN_S", "0.12"))
HISS_MIN_DB = float(os.environ.get("HISS_MIN_DB", "-30"))
HISS_CUT_DB = float(os.environ.get("HISS_CUT_DB", "-25"))
HISS_FRAME_S = 0.02


def _hf_fraction_frames(x, sr, frame_s=HISS_FRAME_S):
    """Per-frame (level_dB, high-frequency fraction)."""
    n = max(1, int(sr * frame_s))
    cnt = len(x) // n
    if cnt < 1:
        return np.zeros(0), np.zeros(0), n
    w = np.hanning(n)
    fr = np.fft.rfftfreq(n, 1.0 / sr)
    hi_m = (fr >= 4000) & (fr < 9000)
    lo_m = (fr >= 80) & (fr < 1000)
    lvl = np.empty(cnt)
    frac = np.empty(cnt)
    for i in range(cnt):
        seg = x[i * n:(i + 1) * n]
        lvl[i] = 20 * np.log10(
            max(float(np.sqrt(np.mean(seg ** 2) + 1e-12)), 1e-12))
        S = np.abs(np.fft.rfft(seg * w)) ** 2
        hi, lo = float(S[hi_m].sum()), float(S[lo_m].sum())
        frac[i] = hi / (lo + hi) if (lo + hi) > 0 else 0.0
    return lvl, frac, n


def find_hiss_bursts(x, sr):
    """Runs of near-pure high-frequency energy. Returns [(start_s, end_s), ...]."""
    lvl, frac, n = _hf_fraction_frames(x, sr)
    if not len(lvl):
        return []
    mask = (frac >= HISS_FRAC) & (lvl >= HISS_MIN_DB)
    min_frames = max(1, int(round(HISS_MIN_S / HISS_FRAME_S)))
    out = []
    i = 0
    while i < len(mask):
        if mask[i]:
            j = i
            while j < len(mask) and mask[j]:
                j += 1
            if j - i >= min_frames:
                out.append((i * n / sr, j * n / sr))
            i = j
        else:
            i += 1
    return out


def suppress_hiss_bursts(wav_path, out_path=None, report=None):
    """Attenuate sibilant bursts. Returns (path, count).

    Sample count is preserved, so this is safe to run after fitting.
    """
    x, sr = sf.read(wav_path)
    mono_in = getattr(x, "ndim", 1) == 1
    data = np.asarray(x if mono_in else x.mean(axis=1), dtype=np.float64)
    out = np.array(x, dtype=np.float64, copy=True)

    bursts = find_hiss_bursts(data, sr)
    g = 10.0 ** (HISS_CUT_DB / 20.0)
    total = 0.0
    for a_s, b_s in bursts:
        a, b = int(a_s * sr), min(len(data), int(b_s * sr))
        if b - a < 8:
            continue
        total += (b - a) / sr
        n = b - a
        gain = np.full(n, g)
        # 10 ms ramps so the removal cannot click or sound like a gate.
        m = min(max(1, int(0.010 * sr)), n // 2)
        if m > 0:
            gain[:m] = np.linspace(1.0, g, m)
            gain[-m:] = np.linspace(g, 1.0, m)
        if mono_in:
            out[a:b] *= gain
        else:
            for ch in range(out.shape[1]):
                out[a:b, ch] *= gain

    dest = out_path or wav_path
    sf.write(dest, out, sr)
    if report is not None:
        report.append(f"hiss bursts attenuated: {len(bursts)} "
                      f"({total:.2f}s of audio)")
    return dest, len(bursts)


if __name__ == "__main__":
    # Child-process entry point for the pitch shift. See shift_pitch_file: pyworld
    # can abort the interpreter natively, and running it here means that takes down
    # a throwaway process instead of a dub that is 93% finished.
    if len(sys.argv) == 5 and sys.argv[1] == "--shift":
        _shift_blocks(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    else:
        raise SystemExit("usage: pitch_fix.py --shift <src.wav> <dst.wav> <ratio>")
