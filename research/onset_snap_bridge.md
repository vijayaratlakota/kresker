# Band-limiting the onset snap, and letting it bridge one pause

2026-08-21, container `omnivoice` on the T4 box. Follow-up to
`research/english_timing_diagnosis.md` section 10 fix 1, which measured a post-hoc snap on
oracle-window starts and priced the available gain at +12.5 points on en/clean. This note
implements the fix in the pipeline, env-gated, and measures both halves separately.

Two results, and they point in opposite directions:

* **band-limiting the voiced gate to 300-3400 Hz is a large win and is now the default.**
  Against the snap as shipped it is worth **+15.5 points** of bench mean (43.4 -> 58.9) and
  **+18.6 points** of oracle mean (43.9 -> 62.5), it wins in all 7 languages, it halves the
  number of starts the snap moves at all, and it costs nothing measurable on the real video
  (76.3 -> 75.5, SE 3.6).
* **bridging a pause is refused as a default.** It loses 1.6 points of bench mean on its own
  (43.4 -> 41.8) and 5.9 points when combined with the band gate (58.9 -> 53.0). It is a clear
  win on English alone (bench en mean 71.2 -> 80.0, oracle en 62.5 -> 77.5, oracle en p95
  537 -> 149 ms) and it is the only thing that fixes the failure the diagnosis described, but
  the rule set for this task was "wins the bench mean or it stays off", and it does not.
  `OMNIVOICE_SNAP_BRIDGE=1` is there for English-primary jobs and is documented, not defaulted.

**Zero previous-line crossings in 1,626 moved starts**, across every arm, both corpora and the
real video. That was the measurement that mattered most and it is clean.

No recogniser call was made: cached chirp_3 responses in `/root/bench/cache` and the job's own
cache. Nothing was re-billed.

## 1. What was measured, and against which aligner

A parallel task is patching `services/aligner.py`. Before anything else, the four timing
modules were snapshotted inside the container to `/tmp/_sn_snap/services/` and **every
measurement imported the snapshot aligner**, not the live file:

| file | snapshot bytes | md5 |
|---|---|---|
| `aligner.py` | 24677 | `780a852b430915e1d6dde2e86c1f235e` |
| `chirp_wire.py` | 84906 | `be76c39d96fede3b6846f9ddde2d4fb4` (already carrying this patch) |
| `chirp_timing.py` | 21213 | `666b37ae06e0dfef60e9ef3e66144933` |
| `fa_timing.py` | 21470 | `7f299ff33429339396788535f2447e28` (the BACK_MODE build) |

**All figures in this note are against the 24677-byte `aligner.py`**, md5
`780a852b430915e1d6dde2e86c1f235e` - the same file `research/english_timing_diagnosis.md` and
`research/fa_backwards_fix.md` used.

That precaution earned its keep. The live `services/aligner.py` was **replaced by the parallel
task while this work was finishing**: at 14:28 UTC it is 29542 bytes, md5
`7af928ceeeee983ac10d4d9fb179139a`. Every arm here had already run against the pinned 24677-byte
snapshot, so nothing in the tables below moved underneath the measurement - but a re-run of these
harnesses today will be measuring a different aligner unless it pins the same snapshot.
`services/aligner.py` was not written by this work at any point.

## 2. The mechanism, restated from the code

`chirp_wire._snap_onsets` runs on the separated vocals stem after `resolve_timeline` and before
`breathe` (`chirp_wire.py` around line 358): resolve has already fixed the line before, so a
start can be clamped against it, and breathe then extends ends toward the moved onsets.

As shipped it had two limits, and the English failure needs both lifted:

1. **The gate is broadband.** `_voiced_mask` frames the stem at 20 ms and thresholds RMS at
   `min(P97 - 35 dB, -45 dBFS)`. On a separated stem, everything outside the speech band is
   separation residue, and that residue clears the threshold - so `_run_onset` walks back
   through it and reports an "onset" that is not speech. This is visible in the measurement
   below as the shipped snap moving 231 of 560 bench starts back by a median 456 ms, 80 of them
   sitting exactly on the 600 ms cap, and driving ml/clean's median start error to **-401 ms**.
2. **It only walks inside the voiced run the aligned start already sits in.** The English
   failure is precisely a start that sits in the *wrong run*: the aligner abandons a
   sentence-initial monosyllable ("The", "But", "As", "All"), parks its two or three letters in
   an 80-120 ms sliver immediately before the second word, and leaves the real onset 350-911 ms
   earlier on the other side of a pause. `_run_onset` cannot cross that pause, and the 0.60 s
   cap would clip the 0.911 s case even if it could.

## 3. The patch

One file, `/app/backend/services/chirp_wire.py`, 80663 -> 84906 bytes. Four anchors, each
asserted to occur **exactly once** in the live file before anything was written, read off the
box, never reconstructed; the patch script restores the backup and exits non-zero if any anchor
is not unique, if the forbidden substring count changes, or if any new symbol is missing. The
module was then IMPORTED for real (`services.chirp_wire`, `services.fa_timing`,
`services.chirp_timing`, `main`), not compiled. The app was not restarted and no render was in
flight.

Backups on the box, both 80663 bytes, md5 `055f93c31ed0e41bed98e7d27a63f993`:
`chirp_wire.py.presnap.20260821121905` (the one the revert script is pinned to) and
`chirp_wire.py.presnap.20260821121938` (byte-identical; the patch script's first pass backed up
before it refused on an anchor check). A third backup,
`chirp_wire.py.presnap.20260821140137` (84906 bytes), is the patched file *before* the
`SNAP_BAND` default was flipped in section 7.

### 3a. `_band_pass`, and the gate

```python
def _band_pass(audio, sr):
    """The speech band, zero-phase. Zero-phase matters: a causal filter would delay every
    onset by its own group delay, which is the thing being measured. Returns the input
    unchanged if scipy is unavailable, so the gate can never fail because of this."""
    ...
    sos = butter(4, [lo, hi], btype="band", output="sos")
    return sosfiltfilt(sos, np.asarray(audio, dtype="float64")).astype("float32")
```

and inside `_voiced_mask`, the only line that changed:

```python
    sig = _band_pass(audio[:usable], sr) if SNAP_BAND else audio[:usable]
    rms = np.sqrt((sig.reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
```

With `SNAP_BAND=0` this is the shipped expression, term for term. `scipy` is 1.17.1 in the
container and the filter was verified on the box rather than assumed: a 60 Hz tone at RMS
0.3536 comes out at 0.0001, a 1 kHz tone comes out at 0.3536.

### 3b. `_bridge_run`, one pause and no more

```python
def _bridge_run(voiced, hop, a, o, floor, look=3.0):
    """Start of the voiced run ONE pause before `a`, when that pause is short enough to
    bridge and the run is not the previous line's own audio. None when there is nothing
    to bridge - one pause, never two."""
    head = o if (o is not None and o < a) else a
    i = int(round(head / hop))
    ...
    while j > lim and voiced[j]:            # step off the run `head` opens, if any
        j -= 1
    gap_end = j
    while j > lim and not voiced[j]:        # back across the pause
        j -= 1
    if j <= lim or not voiced[j]:
        return None
    if (gap_end - j) * hop > SNAP_BRIDGE_GAP_S:
        return None                         # too long a pause to be one word's own
    k = j
    while k > 0 and voiced[k - 1]:
        k -= 1
    start, end = k * hop, (j + 1) * hop
    if end - start < SNAP_MIN_S:
        return None                         # a click, not a word
    if start < floor:
        return None                         # the line before has a claim on this run
    if a - start > SNAP_BACK_MAX_S + SNAP_LEAVE_S:
        return None
    return start
```

It walks off the current run, across exactly one gap, and onto the previous run. Four ways to
refuse: the pause is longer than `SNAP_BRIDGE_GAP_S`, the run is shorter than `SNAP_MIN_S` (a
click), the run starts before `floor` (the previous line's end plus `SNAP_GUARD_S` - the guard
the diagnosis insisted on keeping), or the move would exceed `SNAP_BACK_MAX_S`.

`_snap_onsets` tries the bridge first, then falls through to the shipped in-run cases, and the
budgets stay separate: **the bridged case may go back `SNAP_BACK_MAX_S` (1.0 s), the in-run
backward case still stops at `SNAP_MAX_S` (0.60 s), and the forward case is untouched.** Every
candidate is clamped with `max(..., floor)`, so no path can produce a start before
`previous end + SNAP_GUARD_S`. The report dict gained a `bridged` counter and the log line
gained one `%d`; nothing else in the file moved.

**The signal did not change.** The call site is still

```python
                    _ax, _asr = _load_audio(vocals)
                    _sn = _snap_onsets(rows, _ax, _asr)
```

with `vocals = job.get("vocals_path") or job.get("audio_path")` - the separated stem. That
matters: on the music mix the same detector is median -267.6 ms wrong for English
(`english_timing_diagnosis.md` section 2), and section 6 below prices it again here.

### 3c. Flags

| flag | default | what it does |
|---|---|---|
| `OMNIVOICE_SNAP_BAND` | **`1`** (flipped from `0` by the measurement, section 7) | band-limit the voiced gate |
| `OMNIVOICE_SNAP_BAND_LO_HZ` / `_HI_HZ` | `300` / `3400` | the band |
| `OMNIVOICE_SNAP_BRIDGE` | `0` | bridge one pause. Off by measurement, section 7 |
| `OMNIVOICE_SNAP_BRIDGE_GAP_S` | `0.40` | longest pause that may be bridged |
| `OMNIVOICE_SNAP_BACK_MAX_S` | `1.00` | backward budget for a **bridged** start only |
| `OMNIVOICE_CHIRP_SNAP_ONSET` (pre-existing) | `1` | the whole snap |
| `OMNIVOICE_CHIRP_SNAP_MAX_S` / `_LEAVE_S` (pre-existing) | `0.60` / `0.05` | in-run budget, and the margin left before the onset |

The container's environment is fixed at create time, so these are module defaults; one run is
changed with `docker exec -e FLAG=value`, which is how every arm below was measured.

The two halves are independently switchable on purpose, and it paid: they turn out to disagree.

## 4. Bench, all 14 conditions

`/root/bench` FLEURS corpus, 7 languages x clean/music, ground truth by construction, cached
chirp_3 responses, `fa_then_chirp` cascade, well placed = start error inside -40/+120 ms, 40
lines per condition, 560 in all.

**The bench harness does not exercise `_snap_onsets` on its own** - `/tmp/_fa_bench.py` stops at
`fa_timing.retime_blocks`, which is exactly what the recorded 66.8 mean is. Rather than pretend
the bench covers the snap, the harness here reproduces that baseline first and then runs the
pipeline's next two stages explicitly: `aligner.resolve_timeline`, then `_snap_onsets`, four arms
from the **same** resolve output in **one** process, so the arms cannot differ in their input.
The stem the snap is given is the **clean** wav for both variants, because production snaps on
the separated vocals and never on the mix; the last column breaks that rule deliberately as a
control.

`blocks_only` reproduces the recorded column **exactly, all 14 conditions**, which is the
evidence that this harness measures the same thing as before. `resolved` is identical to it:
`resolve_timeline` moves no start on this corpus.

| condition | recorded | blocks_only | resolved | snap as shipped | band | bridge | both | both on the MIX |
|---|---|---|---|---|---|---|---|---|
| hi clean | 62.5 | 62.5 | 62.5 | 42.5 | 42.5 | 42.5 | 47.5 | 47.5 |
| hi music | 77.5 | 77.5 | 77.5 | 50.0 | 55.0 | 47.5 | 55.0 | 52.5 |
| te clean | 65.0 | 65.0 | 65.0 | 52.5 | 67.5 | 52.5 | 65.0 | 65.0 |
| te music | 65.0 | 65.0 | 65.0 | 47.5 | 67.5 | 47.5 | 65.0 | 57.5 |
| en clean | 55.0 | 55.0 | 55.0 | 65.0 | 70.0 | 70.0 | **75.0** | 75.0 |
| en music | 67.5 | 67.5 | 67.5 | 77.5 | 80.0 | 82.5 | **85.0** | 67.5 |
| ta clean | 75.0 | 75.0 | 75.0 | 57.5 | 62.5 | 52.5 | 57.5 | 57.5 |
| ta music | 72.5 | 72.5 | 72.5 | 57.5 | 65.0 | 55.0 | 57.5 | 40.0 |
| ml clean | 55.0 | 55.0 | 55.0 | 20.0 | 50.0 | 10.0 | 27.5 | 27.5 |
| ml music | 55.0 | 55.0 | 55.0 | 17.5 | 47.5 | 7.5 | 27.5 | 20.0 |
| kn clean | 65.0 | 65.0 | 65.0 | 30.0 | 55.0 | 32.5 | 45.0 | 45.0 |
| kn music | 67.5 | 67.5 | 67.5 | 30.0 | 60.0 | 30.0 | 50.0 | 45.0 |
| gu clean | 75.0 | 75.0 | 75.0 | 30.0 | 50.0 | 27.5 | 42.5 | 42.5 |
| gu music | 77.5 | 77.5 | 77.5 | 30.0 | 52.5 | 27.5 | 42.5 | 25.0 |
| **mean** | **66.8** | **66.8** | **66.8** | **43.4** | **58.9** | **41.8** | **53.0** | **47.7** |

Median start error / p95 |error| in ms, which is where the mechanism shows:

| condition | blocks_only | snap as shipped | band | bridge | both |
|---|---|---|---|---|---|
| hi clean | -18 / 1664 | -45 / 1664 | -40 / 1664 | -55 / 1664 | -40 / 1664 |
| hi music | +6 / 157 | -22 / 607 | -19 / 575 | -30 / 607 | -19 / 575 |
| te clean | -22 / 1094 | -35 / 1094 | -22 / 1094 | -35 / 1224 | -24 / 1094 |
| te music | -1 / 1867 | -36 / 1974 | -1 / 1974 | -36 / 1974 | -9 / 1974 |
| en clean | +0 / 598 | +0 / 537 | +0 / 494 | +0 / 253 | **+0 / 151** |
| en music | +0 / 630 | +0 / 494 | +0 / 179 | +0 / 179 | **+0 / 133** |
| ta clean | +11 / 1760 | -2 / 1760 | +1 / 1760 | -6 / 1587 | -5 / 1587 |
| ta music | +9 / 1535 | -10 / 1145 | -5 / 1305 | -16 / 1145 | -14 / 1185 |
| ml clean | -21 / 1063 | **-401** / 780 | -28 / 1035 | **-423** / 873 | -163 / 1230 |
| ml music | -17 / 1230 | **-383** / 1115 | -26 / 1230 | **-453** / 1115 | -109 / 1405 |
| kn clean | +8 / 865 | -49 / 772 | +6 / 773 | -49 / 772 | -15 / 772 |
| kn music | +0 / 3275 | -41 / 3275 | +0 / 3500 | -41 / 3275 | -8 / 3500 |
| gu clean | +6 / 647 | -116 / 658 | -20 / 658 | -185 / 658 | -56 / 910 |
| gu music | -4 / 627 | -116 / 650 | -24 / 649 | -184 / 650 | -47 / 910 |

Inside 200 ms, %:

| condition | blocks_only | snap as shipped | band | bridge | both |
|---|---|---|---|---|---|
| hi clean | 82.5 | 57.5 | 57.5 | 57.5 | 62.5 |
| hi music | 95.0 | 62.5 | 67.5 | 60.0 | 65.0 |
| te clean | 82.5 | 75.0 | 85.0 | 75.0 | 85.0 |
| te music | 85.0 | 75.0 | 87.5 | 75.0 | 87.5 |
| en clean | 80.0 | 87.5 | 92.5 | 92.5 | **97.5** |
| en music | 82.5 | 90.0 | 95.0 | 95.0 | **100.0** |
| ta clean | 77.5 | 57.5 | 67.5 | 52.5 | 65.0 |
| ta music | 80.0 | 60.0 | 70.0 | 57.5 | 70.0 |
| ml clean | 82.5 | 35.0 | 67.5 | 20.0 | 45.0 |
| ml music | 80.0 | 35.0 | 65.0 | 20.0 | 45.0 |
| kn clean | 85.0 | 47.5 | 75.0 | 45.0 | 67.5 |
| kn music | 85.0 | 50.0 | 75.0 | 45.0 | 67.5 |
| gu clean | 90.0 | 47.5 | 65.0 | 45.0 | 62.5 |
| gu music | 90.0 | 47.5 | 65.0 | 45.0 | 62.5 |

Split English out and the two flags separate cleanly:

| group | no snap | snap as shipped | band | bridge | both | both on the MIX |
|---|---|---|---|---|---|---|
| all 14 conditions | 66.8 | 43.4 | **58.9** | 41.8 | 53.0 | 47.7 |
| en clean+music | 61.2 | 71.2 | 75.0 | 76.2 | **80.0** | 71.2 |
| the other six, 12 conditions | 67.7 | 38.8 | **56.2** | 36.0 | 48.5 | 43.8 |

Read honestly, three things are true at once:

1. **The band gate is a large, uniform win over the shipped snap** - +15.5 mean, and it wins or
   ties in every one of the 14 conditions. It works by *not* moving starts it has no business
   moving: 153 moves instead of 255, and ml/clean's median start error goes from -401 ms back to
   -28 ms. The broadband gate really was reading separation residue as voice.
2. **The bridge is an English fix and only an English fix.** +5.0 on en/clean and +2.5 on
   en/music over the band gate alone, and en/clean's p95 |error| falls 494 -> 151 ms; -7.7 mean
   on the other twelve conditions, worst on ml (50.0 -> 27.5). On FLEURS read speech in the
   other six languages the run before a line's start is usually the *previous sentence*, not an
   abandoned first word, and a 0.40 s pause gate is not enough to tell those apart.
3. **On this corpus the snap as a whole is a net loss** (66.8 without it, 58.9 with the best
   arm). That is a statement about FLEURS, not about the snap: these are isolated clips laid out
   with silence between them, the recorded start *is* the clip onset, and `blocks_only` is
   already within 80-90% of it inside 200 ms. There is nothing for the snap to recover and every
   move it makes is a move away. The real video (section 6) is the corpus that can answer
   whether the snap earns its place, and it says yes, on coverage.

## 5. Oracle window - the arm the +12.5 was originally measured on

One `aligner.align_window` per line over `[true_start - 0.75, true_end + 0.75]`: no Chirp, no
cascade, no window search. Clean audio, 40 lines per language.

| lang | metric | oracle | snap as shipped | band | bridge | both |
|---|---|---|---|---|---|---|
| en | well % | 50.0 | 62.5 | 72.5 | 67.5 | **77.5** |
| en | median ms | -9.1 | -9.1 | -9.0 | -9.1 | -9.0 |
| en | p95 abs ms | 691.1 | 537.4 | 492.0 | 252.9 | **148.6** |
| en | inside 200 ms % | 80.0 | 87.5 | 92.5 | 92.5 | **97.5** |
| hi | well % | 72.5 | 45.0 | 50.0 | 42.5 | 50.0 |
| hi | median ms | -8.6 | -38.9 | -29.2 | -48.6 | -29.2 |
| hi | p95 abs ms | 132.1 | 608.6 | 575.1 | 608.6 | 575.1 |
| hi | inside 200 ms % | 97.5 | 65.0 | 70.0 | 62.5 | 67.5 |
| te | well % | 75.0 | 55.0 | 75.0 | 55.0 | 72.5 |
| te | median ms | -8.4 | -28.7 | -8.4 | -28.7 | -18.4 |
| te | p95 abs ms | 129.1 | 287.0 | 89.4 | 287.0 | 89.4 |
| te | inside 200 ms % | 95.0 | 85.0 | 95.0 | 85.0 | 95.0 |
| ta | well % | 87.5 | 62.5 | 72.5 | 57.5 | 65.0 |
| ta | median ms | +10.8 | -8.9 | -8.6 | -9.3 | -9.2 |
| ta | p95 abs ms | 170.8 | 628.8 | 628.8 | 815.8 | 628.8 |
| ml | well % | 77.5 | 17.5 | 60.0 | 7.5 | 37.5 |
| ml | median ms | -9.2 | -383.2 | -18.7 | -423.4 | -88.7 |
| ml | p95 abs ms | 88.9 | 648.7 | 629.2 | 818.2 | 649.3 |
| kn | well % | 72.5 | 37.5 | 62.5 | 37.5 | 55.0 |
| kn | median ms | -8.1 | -49.0 | -8.1 | -49.0 | -8.7 |
| kn | p95 abs ms | 128.7 | 608.6 | 498.9 | 608.6 | 500.0 |
| gu | well % | 70.0 | 27.5 | 45.0 | 25.0 | 37.5 |
| gu | median ms | +1.3 | -148.8 | -29.2 | -191.2 | -59.1 |
| gu | p95 abs ms | 693.3 | 693.3 | 693.3 | 693.3 | 910.5 |
| **mean well %** | **72.1** | **43.9** | **62.5** | **41.8** | **56.4** |

Against the claims in `english_timing_diagnosis.md` section 10 fix 1:

| claim | claimed | shipped snap | band | bridge | both |
|---|---|---|---|---|---|
| en/clean oracle well % | 50.0 -> 62.5 | **62.5** | 72.5 | 67.5 | **77.5** |
| en/clean oracle p95 abs ms | 691 -> 314 | 537.4 | 492.0 | 252.9 | **148.6** |
| en/clean oracle inside 200 ms % | 80.0 -> 92.5 | 87.5 | 92.5 | 92.5 | **97.5** |
| hi/clean oracle well % | 72.5 -> 75.0 | 45.0 | 50.0 | 42.5 | 50.0 |
| te/clean oracle well % | 75.0 -> 77.5 | 55.0 | 75.0 | 55.0 | 72.5 |

* **The English gain reproduces and then some.** en/clean 50.0 -> 77.5, p95 691 -> 149 ms,
  inside 200 ms 80.0 -> 97.5 - better than the claimed 62.5 / 314 / 92.5. The diagnosis
  predicted part of its own headline would already be captured by the shipped snap, and that is
  exactly what happened: the shipped snap alone lands on 62.5, the claimed figure. The two new
  halves are what carry it to 77.5.
* **"Nothing lost" is refuted.** hi 72.5 -> 50.0, te 75.0 -> 72.5, ta 87.5 -> 65.0,
  ml 77.5 -> 37.5, kn 72.5 -> 55.0, gu 70.0 -> 37.5. Most of that loss is the snap the pipeline
  already ships (hi 45.0, ml 17.5, gu 27.5 with both flags off) rather than anything added here,
  and the band gate recovers a large part of it - but the honest statement is that on this corpus
  every language except English is better off with no snap at all, and the post-hoc measurement
  in the diagnosis did not see this because it compared against a differently-guarded snap.

## 6. Real video

Job `faprim01` (760 s Hindi "Desi Friends"), timing stage only, re-run on the identical cached
Gemini transcript (`pre_retime_segments.json`, 148 transcriber lines) and the identical cached
chirp_3 word stream, through `/tmp/_fa_ab.py` unmodified. Only the env flags differ between
arms. Scored on the FINAL saved segments (after resolve/snap/breathe): each line's own source
text forced-aligned in its own slot, well = median per-word confidence >= 0.45, badly < 0.25.
n = 139 parts, so one standard error on a 76% proportion is **3.6 points**.

| metric | recorded | snap OFF entirely | snap as shipped | band | bridge | both |
|---|---|---|---|---|---|---|
| well / line | **76.3** | 74.8 | **76.3** | 75.5 | 75.5 | 74.8 |
| badly / line | 12.2 | 12.2 | 12.2 | 12.9 | 12.2 | 12.2 |
| well_parts (pipeline) | 78.4 | 78.4 | 78.4 | 78.4 | 78.4 | 78.4 |
| bad_parts | 10.8 | 10.8 | 10.8 | 10.8 | 10.8 | 10.8 |
| median conf | 0.657 | 0.668 | 0.657 | 0.657 | 0.655 | 0.654 |
| parts / blocks | 139 / 118 | 139 / 118 | 139 / 118 | 139 / 118 | 139 / 118 | 139 / 118 |
| dialogue covered | 85.3 | 85.3 | 85.3 | 85.3 | 85.3 | 85.3 |
| raw speech covered | - | **87.2** | 89.0 | 88.6 | **89.4** | 89.2 |
| span total s | - | 625.0 | 633.4 | 631.1 | 640.9 | 639.2 |
| starts moved | - | 0 | 38 | 32 | 53 | 50 |
| **previous-line crossings** | - | 0 | **0** | **0** | **0** | **0** |

The shipped-snap arm reproduces the recorded row exactly - well 76.3, badly 12.2, well_parts
78.4, bad_parts 10.8, dialogue 85.3, median conf 0.657 - and the recorded refusal histogram
exactly: `backwards 40, drift 20, length 14, window 6, conf 1, no alignment 1`, `chirp_kept 82`,
`fa 20`, `fa_hinted 16`, `anchors 30`, 20 lines reverted by the drift guard. Every arm has the
same histogram, which is the proof that the snap changes nothing upstream of itself.

Read plainly: **on the real video the arms are indistinguishable.** -0.8 points (band, bridge)
and -1.5 (both) against an SE of 3.6 is noise, in the same direction and the same size as the
`fa_backwards_fix` arms were. Two things are worth naming anyway:

* the one metric that does move consistently is **raw speech covered**: 87.2% with the snap off,
  88.6-89.4% with it on. The snap's job is to stop a slot clipping the front of a line, and that
  is what coverage measures. It earns its place here even though `well` cannot see it.
* the first attempt at the baseline arm was contaminated and was thrown away: it overlapped
  another task's GPU job and came out with 116 blocks / 138 parts / well 72.5 and a different
  refusal histogram (`drift 14, window 5, anchors 29`). Re-run alone it reproduced 118 / 139 /
  76.3 exactly. A repeat of the `both` arm was **bit-identical** to the first (50 moves, 43 back,
  26 bridged, 16.42 s recovered), so the harness is deterministic when it has the box to itself,
  and any arm measured against a busy box is not a measurement.

### The wrong-signal control

Same flags, snap fed the music MIX instead of the vocals stem, music conditions only (on the
clean conditions the two signals are the same file):

| condition | both (stem) | both (mix) | delta |
|---|---|---|---|
| en music | 85.0 | 67.5 | **-17.5** |
| hi music | 55.0 | 52.5 | -2.5 |
| te music | 65.0 | 57.5 | -7.5 |
| ta music | 57.5 | 40.0 | -17.5 |
| ml music | 27.5 | 20.0 | -7.5 |
| kn music | 50.0 | 45.0 | -5.0 |
| gu music | 42.5 | 25.0 | -17.5 |
| **mean** | **54.6** | **43.9** | **-10.7** |

The stem requirement from the diagnosis holds and is worth 10.7 points of bench mean, 17.5 of
them on English. The patch does not change which signal the snap sees; this control exists so
that claim is measured rather than asserted.

## 7. The safety measurement, which matters more than the gain

Every start the snap moved was recorded: how far, and whether the new start lands inside the
previous line's accepted span (`new start < previous line's end`, the ends being the ones
`resolve_timeline` fixed, which the snap never touches). "Margin" is the distance from the new
start to that previous end, so a negative margin would be a crossing.

| where | arm | moves | of which bridged | back | fwd | \|move\| median ms | \|move\| p95 ms | max backward ms | **crossings** | min margin ms |
|---|---|---|---|---|---|---|---|---|---|---|
| bench, 14 cond, 560 lines | shipped | 255 | 0 | 231 | 24 | 450 | 600 | 600 | **0** | 50 |
| bench | band | 153 | 0 | 129 | 24 | 372 | 600 | 600 | **0** | 50 |
| bench | bridge | 282 | 53 | 258 | 24 | 452 | 642 | 878 | **0** | 50 |
| bench | both | 215 | 80 | 191 | 24 | 363 | 600 | 878 | **0** | 50 |
| oracle, 7 langs, 280 lines | shipped | 131 | 0 | 123 | 8 | 460 | 600 | 600 | **0** | 116 |
| oracle | band | 79 | 0 | 67 | 12 | 365 | 600 | 600 | **0** | 96 |
| oracle | bridge | 144 | 26 | 136 | 8 | 450 | 694 | 880 | **0** | 116 |
| oracle | both | 107 | 36 | 95 | 12 | 365 | 600 | 880 | **0** | 96 |
| faprim01, 139 lines | shipped | 38 | 0 | 31 | 7 | 275 | 600 | 600 | **0** | 50 |
| faprim01 | band | 32 | 0 | 23 | 9 | 265 | 600 | 600 | **0** | 70 |
| faprim01 | bridge | 53 | 22 | 48 | 5 | 370 | 650 | 760 | **0** | 50 |
| faprim01 | both | 50 | 26 | 43 | 7 | 370 | 690 | 760 | **0** | 70 |

**1,626 moved starts across every arm, corpus and repeat; 0 crossings.** The minimum margin seen
anywhere is 50 ms, which is `SNAP_GUARD_S` binding exactly as designed - those are lines whose
onset really does sit inside the previous line's span and which were therefore clamped to
`previous end + 0.05 s` instead of being moved to it. For completeness: 0 bench rows were still
overlapping after `resolve_timeline`, so no crossing could have been inherited and then blamed on
the snap.

The backward budget behaves as specified - the bridged case is the only one that goes past
0.60 s, and it does so rarely:

| where | arm | backward moves | sitting on the 600 ms cap | past 600 ms (bridged budget only) | median back ms | p95 back ms |
|---|---|---|---|---|---|---|
| bench | shipped | 231 | 80 | 0 | 456 | 600 |
| bench | band | 129 | 40 | 0 | 419 | 600 |
| bench | bridge | 258 | 76 | 17 | 474 | 643 |
| bench | both | 191 | 40 | 11 | 379 | 610 |
| oracle | shipped | 123 | 39 | 0 | 470 | 600 |
| oracle | band | 67 | 20 | 0 | 406 | 600 |
| oracle | bridge | 136 | 37 | 10 | 477 | 694 |
| oracle | both | 95 | 20 | 5 | 379 | 600 |

The other half of safety is whether a move helps or hurts the line it moves. Counting lines that
cross the -40/+120 ms window in either direction:

| where | arm | rescued | broken | net |
|---|---|---|---|---|
| bench | shipped | 17 | 148 | -131 |
| bench | band | 17 | 61 | **-44** |
| bench | bridge | 24 | 164 | -140 |
| bench | both | 24 | 101 | -77 |
| oracle | shipped | 8 | 87 | -79 |
| oracle | band | 10 | 37 | **-27** |
| oracle | bridge | 11 | 96 | -85 |
| oracle | both | 14 | 58 | -44 |

Every arm breaks more bench lines than it rescues, for the reason given in section 4 - and the
band gate breaks the fewest by a factor of two and a half.

### The English lines, one by one

The moves the fix exists for, bench en/clean under `both` (`err before` is the start error the
aligner left, `err after` what the snap made of it):

| line | from | to | move ms | err before ms | err after ms | prev end | margin ms |
|---|---|---|---|---|---|---|---|
| 1 | 9.009 | 8.630 | -379 | +352 | **-27** | 8.084 | 546 |
| 3 | 29.040 | 29.390 | +350 | +579 | +929 | 29.020 | 370 |
| 4 | 33.197 | 32.597 | -600 | +694 | **+94** | 31.675 | 922 |
| 6 | 56.468 | 55.590 | **-878** | +910 | **+32** | 51.300 | 4290 |
| 13 | 112.551 | 112.110 | -441 | +494 | **+53** | 110.984 | 1126 |
| 18 | 152.830 | 152.230 | -600 | +598 | **-2** | 151.368 | 862 |
| 22 | 185.991 | 186.090 | +99 | -42 | **+57** | 184.924 | 1166 |
| 27 | 226.822 | 226.450 | -372 | +417 | **+45** | 225.055 | 1395 |
| 31 | 261.570 | 261.210 | -360 | +400 | **+40** | 259.945 | 1265 |
| 39 | 328.063 | 328.330 | +267 | -134 | +133 | 325.513 | 2817 |

Seven of the eight tail lines the diagnosis identified (1, 4, 6, 13, 18, 27, 31) come back inside
the window, including **line 6, the 0.911 s case - moved 878 ms, which the 0.60 s in-run cap
could not have reached**. That is the single measurement that justifies a separate, larger budget
for the bridged case.

Two moves make things worse and both are FORWARD moves, i.e. the pre-existing "slot opens on
silence" case, not the new code: line 3 was already 579 ms late and the snap pushed it to 929 ms
(the run it found was the *next* word), and line 39 went from -134 ms to +133 ms, 13 ms outside
the window. Neither is a crossing and neither is caused by the bridge; they are the reason the
forward budget was left at 0.60 s rather than widened.

## 8. Decision

The rule set for this task: default a flag ON only if it wins on the bench mean AND does not lose
outside noise on the real video AND introduces zero previous-line crossings.

| flag | bench mean | real video | crossings | decision |
|---|---|---|---|---|
| `OMNIVOICE_SNAP_BAND` | 43.4 -> **58.9** (+15.5), wins or ties 14/14 | 76.3 -> 75.5, SE 3.6 | 0 in 264 moves | **default ON** |
| `OMNIVOICE_SNAP_BRIDGE` | 43.4 -> 41.8 alone (-1.6); 58.9 -> 53.0 on top of the band gate (-5.9) | 76.3 -> 75.5 / 74.8, SE 3.6 | 0 in 479 moves | **stays OFF** |

**`OMNIVOICE_SNAP_BAND` is now `1`.** One default was flipped in the live file
(`"OMNIVOICE_SNAP_BAND", "0"` -> `"1"`, the anchor asserted unique, backup
`.presnap.20260821140137` taken first, all four modules imported for real afterwards, invariants
re-checked, app not restarted). It passes all three tests, it is the half that addresses the
diagnosis's actual complaint about the gate, and it makes the snap *more* conservative - fewer
moves (255 -> 153 on the bench, 38 -> 32 on the real video), smaller moves, and two and a half
times fewer broken lines. A fresh interpreter reports `SNAP_BAND True`; `OMNIVOICE_SNAP_BAND=0`
was verified to put the broadband gate back.

**`OMNIVOICE_SNAP_BRIDGE` stays `0`.** It fails the first test outright. What it does is
narrower than the bench mean can express, and worth recording precisely:

* on English it is the fix the diagnosis said it was - bench en mean 71.2 -> 80.0 with the band
  gate, oracle en 62.5 -> 77.5, oracle en p95 537 -> 149 ms, en/clean p95 494 -> 151 ms, seven of
  eight abandoned-first-word lines recovered, and the 0.911 s case only reachable with its wider
  budget;
* on the other six bench languages it costs 7.7 points of mean, because on FLEURS read speech the
  voiced run one 0.40 s pause behind a line's start is usually the previous sentence rather than
  an abandoned first word, and a pause-length gate cannot tell those apart;
* on real Hindi material it is neutral (75.5 vs 76.3, SE 3.6) with 22 bridges taken and 0
  crossings, so it is not dangerous - it is unproven.

So: **set `OMNIVOICE_SNAP_BRIDGE=1` for English-primary jobs** (with `SNAP_BAND` on, which is now
the default), and leave it off elsewhere until there is real English video to measure on. There is
none on the box; `english_timing_diagnosis.md` section 11 says the same thing.

That the two halves disagree is the reason they were built as two flags. Had they shipped as one
"fix the English onset" switch, the +15.5 of the gate and the -5.9 of the bridge would have
cancelled to a +9.6 that looked like a modest win and was in fact two different effects.

One thing this measurement turned up that was not asked for and should not be buried: **the snap
as shipped costs the non-English bench 28.9 points** (67.7 without it, 38.8 with it) and the band
gate only recovers 17.4 of them. On the real video the snap is worth +1.5 points of `well` (74.8
-> 76.3, noise) and +1.8 of raw speech covered (87.2 -> 89.0, not noise). The bench is read
speech with clip-onset ground truth and cannot be trusted to price a lead-in recovery, but the
gap between the two corpora is large enough that "should the snap run at all on non-English
material" is now a fair question, and the next measurement worth doing is a no-snap arm on real
non-English video rather than another parameter on the snap.

## 9. How to revert

**A new script, `revert_snap.ps1` + `_revert_snap_tmpl.sh`**, rather than a new level on
`revert_fa.ps1`. Two reasons: `revert_fa.ps1` pins every level to the `.prefa.20260821092106`
stamp, and its `metric` and `all` levels restore `chirp_wire.py` from it - which would take the
fa wiring and the per-part metric out along with this work. `revert_aligner.ps1` is a different
piece of work again and was not touched, as instructed.

Same pattern as the others: `.prerevert.<utc>` backup first, real imports (not `py_compile`),
invariants re-checked, app reloaded and `/sysinfo` confirmed 200, refuses to run while a render
looks to be in flight, `-Status` and `-WhatIf` supported.

```
.\revert_snap.ps1 -Status                what is live: file, flags, invariants, backups
.\revert_snap.ps1 -Level gate            band-limited gate OFF: pins OMNIVOICE_SNAP_BAND's
                                         default back to 0, i.e. the broadband gate the snap
                                         shipped with. No file restored. Reach for this first.
.\revert_snap.ps1 -Level bridge          pins OMNIVOICE_SNAP_BRIDGE's default to 0 (already 0)
.\revert_snap.ps1 -Level file            services/chirp_wire.py <- .presnap.20260821121905,
                                         removing _band_pass, _bridge_run and all four flags
.\revert_snap.ps1 -Level file -WhatIf    print the plan, change nothing
```

For one run and no edit at all: `docker exec -e OMNIVOICE_SNAP_BAND=0 ...` restores the shipped
gate, and `OMNIVOICE_CHIRP_SNAP_ONSET=0` turns the whole snap off, as it always did.

`-Status`, `-Level gate -WhatIf` and `-Level file -WhatIf` were run against the box and behave;
the destructive levels were not run, because the default state is the one the measurement chose.

## 10. Invariants

Checked before the patch, after the patch, before and after the default flip, and again at the
end:

```
docker exec CT grep -c 'lead_in\|leadin\|sibilant\|_LEAD_IN' /app/backend/api/routers/dub_generate.py  -> 5
docker exec CT stat -c %s /app/backend/services/speech_rate.py                                         -> 13073
docker exec CT grep -c leadin /app/backend/services/chirp_wire.py                                      -> 1
```

All three held throughout and `/sysinfo` answers 200. Live file states at 14:28 UTC:
`chirp_wire.py` 84906 bytes md5 `15df408cc9771e4876c1220618050712`, `aligner.py` 29542 bytes md5
`7af928ceeeee983ac10d4d9fb179139a` - the aligner having been rewritten by the parallel task at
some point after 14:00, which is why every number here is against the pinned snapshot and not
against the live file. The single `leadin` hit in `chirp_wire.py`
is the pre-existing prose at line 1319, `"""The leading (or trailing) `frac` of a transcript, by
word count."""`, present in the `.presnap` backup too; the patch script refuses to write if that
count changes. No new identifier contains the forbidden substring - the new names are
`_band_pass`, `_bridge_run`, `SNAP_BAND*`, `SNAP_BRIDGE*`, `SNAP_BACK_MAX_S`, `bridged`.
`services/aligner.py` was never written and its md5 is unchanged from the snapshot.

Only `services/chirp_wire.py` was written (twice: the patch, then the one-token default flip).
The container was not recreated and the app was not restarted.

## 11. What was not checked

* **No English real video exists on the box**, so the bridge's English gain is FLEURS read speech
  and oracle windows only. That is the same gap `english_timing_diagnosis.md` records, and it is
  why the bridge is documented rather than defaulted for English.
* The bench arms run the snap on the **clean** wav as a stand-in for the separated vocals stem.
  Production separates the stem with the real separator; a stem with separation artefacts may
  gate differently from clean speech, and the band gate is exactly the part of the change that
  interacts with those artefacts. The real-video arms do use the job's actual vocals path.
* The no-snap-at-all arm was run on the real video (74.8 well, 87.2 raw speech covered) but on
  **one** Hindi video. The bench-vs-video disagreement about whether the snap helps at all is not
  resolved by n=1.
* `SNAP_BRIDGE_GAP_S` (0.40) and `SNAP_BACK_MAX_S` (1.00) were taken from the diagnosis's
  measurement and **not swept**. A gap sweep is the obvious next experiment for the bridge, since
  the non-English loss is a false-positive problem and 0.40 s is the knob that controls it.
* Only the start of a line was measured. The same abandonment happens at line ends (end error
  median +94 ms, p95 1192 ms on English per the diagnosis); `breathe` is the code that would have
  to change and it was not touched.
* Scoring on the real video is the forced-alignment confidence proxy, not listening. No one
  listened to the 26 bridged lines on `faprim01`.
* A parallel task held the GPU for part of the afternoon. One arm (the first baseline) was
  measurably contaminated and was re-run; every other arm ran with the box to itself, and the
  `both` repeat came out bit-identical, but that is evidence rather than proof for the arms that
  were not repeated.

## 12. Artefacts

On the box, staged in `/home/ubuntu/_fa_out_sn/` and copied to `_fa_out/` locally:

```
_sn_bench.json          bench, 14 conditions x 7 arms, with every move recorded
_sn_oracle.json         oracle window, 7 languages x 5 arms, with every move recorded
_sn_summary.md          the tables in this note, as generated
_fa_ab_faprim01_snapoff.json    the contaminated baseline (kept, and marked as such)
_fa_ab_faprim01_snapoff2.json   the baseline re-run alone - reproduces 76.3 / 12.2 / 78.4
_fa_ab_faprim01_band.json  _fa_ab_faprim01_bridge.json  _fa_ab_faprim01_both.json
_fa_ab_faprim01_both2.json      the bit-identical repeat
_sn_ab_moves_faprim01_*.json    per-line moves, margins and crossing checks, one per arm
_sn_bench.log  _sn_oracle.log  _sn_ab.log  _sn_ab2.log     the detached run logs
chirp_wire_snapbridge.py        the module as deployed (84906 B, md5 15df408cc9771e4876c1220618050712)
chirp_wire_presnap.py           the pre-patch copy   (80663 B, md5 055f93c31ed0e41bed98e7d27a63f993)
```

`_fa_ab_faprim01_nosnap.json` and `_sn_ab3.log` (the snap-off-entirely arm, section 6) are in
`_fa_out/` too - they were collected in a second pass because that arm had to wait for the
parallel task to give the GPU back.

Backups on the box: `services/chirp_wire.py.presnap.20260821121905` and `.20260821121938`
(pre-patch, identical), `.presnap.20260821140137` (patched, `SNAP_BAND` default still 0).

Harnesses: `/tmp/_sn_bench.py`, `/tmp/_sn_oracle.py`, `/tmp/_sn_ab_pre.py` (a preamble that pins
the snapshot aligner and instruments `_snap_onsets`, then execs `/tmp/_fa_ab.py` **unmodified**),
`/tmp/_sn_sum.py`. Local drivers: `_sn0_read.sh`, `_sn0b_pull.sh`, `_sn1_probe.sh`, `_sn2_patch.sh`,
`_sn3_bench_go.sh`, `_sn4_oracle_go.sh`, `_sn5_ab_go.sh`, `_sn6_summary.sh`, `_sn8_absum.sh`,
`_sn9_diff.sh`, `_sn11_ab_base.sh`, `_sn12_extra.sh`, `_sn14_ab_nosnap.sh`,
`_sn17_default_band.sh`, `_sn18_collect.sh`, plus the pollers `_sn_poll.sh`, `_sn10_wait.sh`,
`_sn13_poll2.sh`, `_sn19_wait_nosnap.sh`, `_sn20_nosnap_read.sh`.
