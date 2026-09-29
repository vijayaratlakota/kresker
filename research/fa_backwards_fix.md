# The `backwards` refusal: moving the monotonic veto from ENDS to STARTS

2026-08-21, container `omnivoice` on the GPU box. Follow-up to `research/fa_primary_timing.md`,
which shipped forced alignment as the primary timing source and left one known limitation:

> `backwards` being the largest bucket is a known limitation: an accepted line whose end
> stretches forward pushes the cursor past the next line's true start, and the next line is
> then refused.

On the real video (`faprim01`, 118 blocks) the refusal histogram was
`backwards 40, drift 20, length 14, window 6, conf 1, no alignment 1` - 82 of 118 blocks kept
Chirp's times and `backwards` alone was half of the refusals. This note builds the alternative,
measures it on both corpora, and **recommends leaving the default alone**. It is a negative
result.

## What changed

One file, `/app/backend/services/fa_timing.py`, 18361 -> 21470 bytes, backed up first as
`fa_timing.py.preback.20260821110108`. Ten anchors, each asserted to occur EXACTLY ONCE in the
live file before anything was written (the patch restores the backup and exits non-zero if any
anchor is not unique). `services.fa_timing`, `services.chirp_wire`, `services.chirp_timing` and
`main` were then IMPORTED for real, not compiled. The app was never restarted and no render was
in flight.

Pass 2 previously tangled two jobs into one `cursor`:

* the search WINDOW - `lo = cursor - LOOKBEHIND_S`, `hi = cursor + ahead` - which has to sit near
  the previous line's accepted END or the next line is looked for in the wrong place;
* the VETO - `na < cursor - BACK_TOL_S` -> `backwards`.

`_plausible()` now takes a `floor` (the earliest start this line may have) instead of computing
one from a cursor, and `OMNIVOICE_FA_BACK_MODE` decides what the caller passes:

| mode | floor passed to `_plausible` |
|---|---|
| `end` (**default**) | `cursor - BACK_TOL_S`, i.e. previous accepted END minus 0.25 s - the shipped test, unchanged |
| `start` | previous accepted **START** + `MIN_ADVANCE_S` + `ADVANCE_FRAC` x previous line's **Chirp** duration |

Nothing else moved. The window construction is untouched (the previous accepted end still bounds
`lo` and `hi`, it just no longer vetoes), every other refusal reason is untouched, and the hinted
second choice uses the same floor it always did. In `start` mode the floor comes only from lines
that were ACCEPTED - a line that fell back to Chirp does not raise it - which is what makes the
two arms differ only in the one thing being tested. `prev_take` is `None` until the first
acceptance, so the first line has no floor at all rather than a floor of 0.05 s.

Default `end` is byte-identical in behaviour to the shipped code: `na < floor` with
`floor = cursor - BACK_TOL_S` is the same expression as `na < cursor - BACK_TOL_S`, and pass 1
passes `0.0`, which can never veto. The bench arm below reproduces the shipped column exactly,
which is the evidence for that claim rather than the argument.

### Env flags

| flag | default | what it does |
|---|---|---|
| `OMNIVOICE_FA_BACK_MODE` | `end` | `end` / `start`. An unrecognised value logs a warning and uses `end`. |
| `OMNIVOICE_FA_MIN_ADVANCE_S` | `0.05` | `start` only: fixed part of the required advance on the previous accepted start |
| `OMNIVOICE_FA_ADVANCE_FRAC` | `0.0` | `start` only: plus this fraction of the previous line's Chirp duration |

`back_mode`, `min_advance_s` and `advance_frac` are also written into the existing `timing`
report dict, so a saved artefact cannot be mistaken for the other arm.

## Bench, all 14 conditions

`/root/bench` FLEURS corpus, 7 languages x clean/music, ground truth by construction, **cached**
recogniser responses - nothing was re-billed. `chirp_3` word times, `fa_then_chirp` cascade, well
placed = start error inside -40/+120 ms. 40 lines per condition, 560 in total.

| condition | shipped (recorded) | `back_mode=end` | `back_mode=start` | `start` + `ADVANCE_FRAC=0.30` | delta start-end |
|---|---|---|---|---|---|
| hi clean | 62.5 | 62.5 | 50.0 | 50.0 | **-12.5** |
| hi music | 77.5 | 77.5 | 52.5 | 52.5 | **-25.0** |
| te clean | 65.0 | 65.0 | 65.0 | 65.0 | 0.0 |
| te music | 65.0 | 65.0 | 65.0 | 65.0 | 0.0 |
| en clean | 55.0 | 55.0 | 47.5 | 47.5 | -7.5 |
| en music | 67.5 | 67.5 | 57.5 | 57.5 | -10.0 |
| ta clean | 75.0 | 75.0 | 72.5 | 72.5 | -2.5 |
| ta music | 72.5 | 72.5 | 70.0 | 70.0 | -2.5 |
| ml clean | 55.0 | 55.0 | 55.0 | 55.0 | 0.0 |
| ml music | 55.0 | 55.0 | 55.0 | 55.0 | 0.0 |
| kn clean | 65.0 | 65.0 | 65.0 | 65.0 | 0.0 |
| kn music | 67.5 | 67.5 | 67.5 | 67.5 | 0.0 |
| gu clean | 75.0 | 75.0 | 70.0 | 70.0 | -5.0 |
| gu music | 77.5 | 77.5 | 67.5 | 67.5 | -10.0 |
| **mean** | **66.8** | **66.8** | **61.4** | **61.4** | **-5.4** |

The `end` column reproduces the recorded column exactly, condition by condition, so the harness is
measuring the same thing it measured before (`/tmp/_fa_bench.py`, unmodified, one arm per process
with only the two new env vars differing).

`ADVANCE_FRAC=0.30` is identical to `ADVANCE_FRAC=0.0` on all 14 conditions. On read speech the
lines are far enough apart that the fixed 0.05 s floor is the only part that ever binds, so tying
the required advance to pacing does nothing here. It is not "safe", it is inert.

Median start error and p95 |error|, which is where the damage is clearest:

| condition | end median / p95 (ms) | start median / p95 (ms) |
|---|---|---|
| hi clean | -18.1 / 1664 | -32.4 / 2792 |
| hi music | +5.7 / **157** | -26.5 / **2573** |
| te clean | -21.8 / 1094 | -21.8 / 1094 |
| te music | -0.7 / 1867 | +3.1 / 2300 |
| en clean | +0.1 / **598** | -3.4 / **1894** |
| en music | +0.0 / **630** | +0.0 / **3093** |
| ta clean | +11.3 / 1760 | +14.4 / 1793 |
| ta music | +9.1 / 1535 | +2.8 / 2834 |
| ml clean | -21.1 / 1063 | -21.1 / 1063 |
| ml music | -17.2 / 1230 | -17.2 / 1230 |
| kn clean | +8.1 / 865 | -2.2 / 865 |
| kn music | +0.0 / 3275 | +0.0 / 3275 |
| gu clean | +6.2 / **647** | -0.8 / **2230** |
| gu music | -3.8 / **627** | -12.2 / **2231** |

Medians barely move (they were already tens of milliseconds). Every p95 that changes gets worse,
by up to a factor of 16 (hi music 157 -> 2573 ms). That shape - median flat, tail blown out - is
the same signature the drift guard exists for.

### Refusal histograms, bench (summed over 560 lines)

| arm | fa | fa_hinted | chirp_kept | drift reverted | refusals |
|---|---|---|---|---|---|
| `end` | 356 | 34 | 170 | 107 | `backwards 44, drift 107, conf 8, length 5, window 5, -7.3s from chirp 1` |
| `start` | 370 | 16 | 174 | 149 | `drift 149, conf 17, length 6, window 1, -7.9s from chirp 1` |
| `start` + frac 0.30 | 370 | 16 | 174 | 149 | same as `start` |

`backwards` does go to zero, exactly as intended. It buys 14 more lines placed by wide alignment -
and 42 more lines reverted by the drift guard, 9 more refused on confidence, and 4 fewer points of
well-placed lines. Removing the veto did not free correct placements; it admitted wrong ones, and
the drift guard then caught some of them.

### Where the loss comes from, line by line

`hi/music` (-25.0, the worst condition) and `hi/clean` (-12.5), both modes run in one process so
the inputs are provably identical (`/tmp/_bw_diag.py`):

| condition | lines placed differently | better | worse | end median / p95 \|err\| | start median / p95 \|err\| |
|---|---|---|---|---|---|
| hi music | 14 of 40 | 2 | 10 | 0.021 s / 0.141 s | 0.397 s / 2.792 s |
| hi clean | 15 of 40 | 3 | 10 | 0.028 s / 1.664 s | 0.752 s / 2.792 s |

The individual lines say what happened. In `start` mode, hi/music line 29 is placed at 253.90 s
against a true start of 258.64 s (4.7 s early), line 12 at 104.09 vs 106.88, line 11 at 97.88 vs
100.21, line 32 at 287.75 vs 290.33, line 1 at 6.78 vs 9.21. All five are alignments that latch
onto the tail of the PREVIOUS line's audio, and all five are exactly what the end-based veto was
refusing. The diagnosis in the shipped note - "an accepted line whose end stretches forward pushes
the cursor past the next line's true start" - describes a real failure mode, but it is not what
most of the `backwards` bucket was: on this corpus the bucket was mostly the veto working.

The rest of the loss is smaller and indirect: with more early placements accepted, the drift line
fits worse, more runs get flagged (hi/music 12 lines reverted vs 0 in `end` mode), and a reverted
line goes back to Chirp's times - which are systematically 20-70 ms early, i.e. just outside the
-40/+120 ms window. So a drift reversion costs a well-placed line even when it only moves it by
30 ms (hi/music lines 3, 15, 16, 17: `d|err|` of +0.01 to +0.05 s, each one flipping out of the
window).

## Real video

Job `faprim01` (760 s Hindi "Desi Friends"), timing stage only, re-run on the identical cached
Gemini transcript (`pre_retime_segments.json`, 148 transcriber lines) and the identical cached
chirp_3 word stream, through the existing `/tmp/_fa_ab.py` harness. Only `OMNIVOICE_FA_BACK_MODE`
and `OMNIVOICE_FA_ADVANCE_FRAC` differ between arms. Scored on the FINAL saved segments (after
resolve/snap/breathe): each line's own source text forced-aligned in its own slot, well = median
per-word confidence >= 0.45, badly < 0.25.

| arm | lines | well / line | badly / line | median conf | p5 conf | p95 conf | well_parts (pipeline) | bad_parts | parts | \|move\| median | \|move\| p95 | dialogue covered | raw speech covered |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `back_mode=end` (shipped) | 139 | **76.3** | **12.2** | 0.657 | 0.115 | 0.903 | 78.4 | 10.8 | 139 | 0.064 s | 1.732 s | 85.3 | 89.0 |
| `back_mode=start` | 141 | 75.9 | 12.8 | 0.653 | 0.090 | 0.900 | 80.9 | 8.5 | 141 | 0.378 s | 4.971 s | 85.3 | 88.5 |
| `start` + `ADVANCE_FRAC=0.30` | 140 | 75.7 | 12.1 | 0.653 | 0.115 | 0.900 | 80.0 | 8.6 | 140 | 0.367 s | 4.880 s | 85.1 | 88.5 |

The `end` arm reproduces the recorded row exactly: well 76.3, badly 12.2, `well_parts` 78.4,
`bad_parts` 10.8, dialogue 85.3, and the same refusal histogram
(`backwards 40, drift 20, length 14, window 6, conf 1, no alignment 1`).

n is 139-141 parts, so one standard error on a 76% proportion is 3.6 points. Every difference in
the table is a fraction of that. Read plainly: **on the real video the three arms are
indistinguishable.** -0.4 and -0.6 points of well-placed lines are not a loss, +2.5 points of
`well_parts` is not a win, and the two metrics disagreeing in direction (final lines slightly
down, pipeline parts slightly up) is the same before/after-resolve disagreement the shipped note
already recorded.

### Refusal histograms, real video (118 blocks)

| arm | fa | fa_hinted | chirp_kept | anchors | refusals |
|---|---|---|---|---|---|
| `end` | 20 | 16 | **82** | 30 | `backwards 40, drift 20, length 14, window 6, conf 1, no alignment 1` |
| `start` | 34 | 23 | **61** | 30 | `drift 41, length 10, conf 4, window 3, -6.7s from chirp 1, 7.1s from chirp 1, no alignment 1` |
| `start` + frac 0.30 | 32 | 24 | 62 | 30 | `drift 42, length 10, conf 3, backwards 3, window 2, 9.0s from chirp 1, no alignment 1` |

This is the interesting part of the whole exercise. The patch does exactly what it was designed to
do on real material: `backwards` 40 -> 0, blocks kept on Chirp's times 82 -> 61, blocks placed by
wide alignment 20 -> 34. **And the output quality does not move.** Half of the freed lines are
then reverted by the drift guard instead (20 -> 41 lines, 3 -> 7 runs), and the lines that survive
move much further from Chirp (|move| p95 1.73 s -> 4.97 s) without scoring better.

`ADVANCE_FRAC=0.30` reintroduces 3 `backwards` refusals and changes nothing else worth naming.

So the `backwards` bucket was not 40 lines of lost quality. It was 40 lines where alignment and
Chirp disagreed and one of the two had to be picked; the veto picked Chirp, and picking alignment
instead is a wash on this video and a clear loss on the bench.

## Decision

**Do not flip the default. `OMNIVOICE_FA_BACK_MODE` stays `end`.** The default was not touched by
this work and the shipped code path is unchanged.

The rule set at the top of the task was: flip only if `start` wins on BOTH the bench mean and the
real video, outside noise. It wins on neither.

* bench: 66.8 -> 61.4, **-5.4 points**, losing on 7 of 14 conditions and winning on none, with
  every changed p95 tail worse. This is not noise: it is 560 lines with ground truth by
  construction, and the per-line diagnostic names the specific lines that land 2-5 s early.
* real video: -0.4 points of well-placed lines with a standard error of 3.6. Noise.
* `ADVANCE_FRAC=0.30`: inert on the bench (identical on all 14 conditions), and on the real video
  it only trades 3 refusals back. There is no evidence tying the required advance to pacing helps.

What the measurement actually taught, which is worth more than the patch:

1. The end-based veto is doing useful work, not just blocking. Most of the `backwards` bucket is
   alignments that latched onto the previous line's audio, and the veto is currently the only
   guard that catches them - `length`, `conf` and `window` all pass them.
2. The size of a refusal bucket is not evidence of lost quality. `backwards 40` looked like the
   biggest available win in the shipped note; measured, it is worth nothing on the real video and
   is actively load-bearing on the bench. That is three-for-three with the other "obvious" fixes
   refuted by measurement today.
3. If the end-based veto is ever loosened, it needs a REPLACEMENT guard against latching onto the
   previous line's tail, not just a weaker floor. The obvious candidate, and the thing to measure
   next, is a veto on overlap with the previous line's accepted span as a FRACTION of the new
   line's own length, which would still admit a line whose predecessor merely over-stretched.
4. The drift guard is now the dominant refusal reason in `start` mode on both corpora (149 of 560
   bench lines, 41 of 118 blocks). Any future work here has to be measured with the guard's own
   cost in view - `research/fa_primary_timing.md` records it costing 6.4 points on the bench.

The flag is kept rather than reverted: it costs nothing at its default, the code is simpler with
the floor separated from the window than it was with both in one `cursor`, and the next attempt at
this problem starts from a measured baseline instead of from scratch.

## How to revert

`revert_fa.ps1` grew one level, following the existing pattern (`.prerevert.<utc>` backup first,
real imports, invariant re-check, app reload with `/sysinfo` 200 confirmed, refuses to run
mid-render, `-Status` and `-WhatIf` supported):

```
.\revert_fa.ps1 -Status                   now also prints BACK_MODE / MIN_ADVANCE_S / ADVANCE_FRAC
                                          and lists the .preback.* backups
.\revert_fa.ps1 -Level backmode           restores services/fa_timing.py from
                                          .preback.20260821110108, removing the flag entirely
.\revert_fa.ps1 -Level backmode -WhatIf   print the plan, change nothing
```

Nothing needs reverting for behaviour: the default is `end`, which is the pre-flag code path, so
`-Level backmode` is only for removing the flag itself. The other levels are unchanged and still
work; `-Status`, `-Level backmode -WhatIf` and `-Level all -WhatIf` were all run against the box
and behave. `-Level all` already moves `fa_timing.py` aside, so it removes the flag too.

## Invariants

Checked before the write, after the write, and again at the end:

```
docker exec CT grep -c 'lead_in\|leadin\|sibilant\|_LEAD_IN' /app/backend/api/routers/dub_generate.py  -> 5
docker exec CT stat -c %s /app/backend/services/speech_rate.py                                         -> 13073
docker exec CT grep -c leadin /app/backend/services/fa_timing.py                                       -> 0
```

All three held throughout, and `/sysinfo` answers 200. No identifier containing `leadin` was
introduced (the patch script refuses to write if the patched source contains the string at all).
Only `services/fa_timing.py` was written; the container was not recreated and the app was not
restarted.

## Artefacts

On the box, staged in `/home/ubuntu/_fa_out_bw/` and copied to `_fa_out/` locally:

```
_fa_bench_bw_end.json  _fa_bench_bw_start.json  _fa_bench_bw_s030.json     bench, 14 conditions each
_fa_ab_faprim01_bwend.json  _fa_ab_faprim01_bwstart.json  _fa_ab_faprim01_bws030.json   real video
_fa_bench_bw_diag.json      the per-line hi clean/music diagnostic
_bw_bench.log  _bw_ab.log   the detached run logs
fa_timing_backmode.py       the patched module as deployed (also `_fa_timing_backmode.py` locally)
```

Backup on the box: `/app/backend/services/fa_timing.py.preback.20260821110108`.
Scripts: `_bw_patch.sh` (the patch, with the anchor assertions), `_bw_bench_go.sh`,
`_bw_bench_table.sh`, `_bw_ab_go.sh`, `_bw_diag.sh`, `_bw_collect.sh`, `_bw_poll*.sh`.
Harnesses reused unmodified: `/tmp/_fa_bench.py`, `/tmp/_fa_ab.py`.
