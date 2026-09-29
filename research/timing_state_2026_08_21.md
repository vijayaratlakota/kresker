# The timing stage as deployed, 2026-08-21: audit and one combined measurement

Container `omnivoice` on the T4 box. This note exists because four changes went into the timing
stage today from three tasks working in parallel, each measured against its own baseline and its
own file fingerprints, and **no measurement had ever scored the combined, as-deployed state with
no environment variables set**. That is the number here.

Nothing was patched. No Speech API call was made: every recogniser response came from
`/root/bench/cache` or the job's own `chirp_words_cache.json`. Nothing was re-billed. The box was
idle for the whole exercise and one arm ran at a time; the GPU-contention failure that spoiled an
arm earlier today (`research/aligner_fixes.md`, `research/onset_snap_bridge.md` section 6) is why
that matters, and every figure below was reproduced on a second run.

Verdict up front: **the as-deployed state is exactly what the four notes describe, every expected
figure reproduced, and there are zero previous-line crossings.** Two bookkeeping errors in the
notes are corrected in section 2b. The bench mean is 68.8 and the real video is 75.5% well placed.

## 1. State audit

Read from the box at 17:56 UTC, re-read after all measurement at 18:48 UTC: identical.

| file | bytes | md5 | mtime UTC | expected by |
|---|---|---|---|---|
| `services/aligner.py` | 29885 | `9b8ceef388a7ef73d5f32d93f93a7348` | 14:56:30 | `aligner_fixes.md` (star default flipped) |
| `services/chirp_wire.py` | 84906 | `15df408cc9771e4876c1220618050712` | 14:01:38 | `onset_snap_bridge.md` section 10 |
| `services/chirp_timing.py` | 21213 | `666b37ae06e0dfef60e9ef3e66144933` | 09:21:07 | `fa_primary_timing.md` |
| `services/fa_timing.py` | 21470 | `7f299ff33429339396788535f2447e28` | 11:01:09 | `fa_backwards_fix.md` |
| `services/speech_rate.py` | 13073 | `54115ab11927dc80c8fa1aa45b603748` | Aug 14 21:00 | guarded invariant, untouched |
| `services/lead_trim.py` | 8880 | `70f9cdf935f4cb580c20dd0fa08dfbe4` | Aug 18 22:22 | untouched today |

All four match the deployed fingerprints their own notes record. Every module imports for real
(`services.aligner`, `services.chirp_wire`, `services.chirp_timing`, `services.fa_timing`,
`services.lead_trim`), and `import main` exits 0.

### Live flag values, fresh interpreter inside the container, no variable set

| flag | module | live value |
|---|---|---|
| `MODEL` | `chirp_timing` | `chirp_3` |
| `MODEL_LOCATION` | `chirp_timing` | `{'chirp_2': 'us-central1', 'chirp_3': 'us'}` |
| `MODEL_FEATURES` | `chirp_timing` | chirp_2 word times + confidence; **chirp_3 word times only** |
| `FALLBACK_MODEL` | `chirp_timing` | `chirp_2` |
| `LOCATION` | `chirp_timing` | `us` (i.e. `location_for(MODEL)`) |
| `TIMING_SOURCE` | `fa_timing` | `fa_then_chirp` |
| `BACK_MODE` | `fa_timing` | `end` (`MIN_ADVANCE_S` 0.05, `ADVANCE_FRAC` 0.0, both inert in `end`) |
| `STARS` | `aligner` | `True` |
| `SNAP_BAND` | `chirp_wire` | `True` |
| `SNAP_BRIDGE` | `chirp_wire` | `False` |
| `SNAP_ONSET` | `chirp_wire` | `True` |
| `REANCHOR` | `chirp_wire` | `True` |
| `ENABLED` | `aligner` / `chirp_wire` / `chirp_timing` / `lead_trim` | `True` / `True` / `True` / **`False`** |

`ENABLED` is the one name that exists in four modules with four meanings, so all four are given.
`lead_trim.ENABLED` is `False`, which is what `aligner_fixes.md` relies on when it says stars
cannot reach that caller.

Supporting constants, same interpreter: `chirp_wire.PART_QUALITY True`; drift guard
`DRIFT_TOL_S 1.5 / DRIFT_RUN_MIN 3 / DRIFT_DELTA_TOL_S 1.0 / DRIFT_MIN_ANCHORS 4`;
`fa_timing.ANCHOR_CONF 0.60 / MIN_CONF 0.35 / LOOKAHEAD_S 8.0 / LOOKBEHIND_S 1.5 /
MAX_DELTA_S 6.0 / MAX_STRETCH 2.5 / MIN_STRETCH 0.35 / TRIM_CONF 0.20 / BACK_TOL_S 0.25`;
`chirp_wire.SNAP_MAX_S 0.60 / SNAP_LEAVE_S 0.05 / SNAP_GUARD_S 0.05 / SNAP_MIN_S 0.04 /
SNAP_BAND_LO_HZ 300 / SNAP_BAND_HI_HZ 3400 / SNAP_BRIDGE_GAP_S 0.40 / SNAP_BACK_MAX_S 1.00`.
`aligner.align_window` carries the `with_index` keyword and `retime_segments` still exists.

The container's environment holds `OMNIVOICE_SERVER_MODE=1` and `HF_HOME` and nothing else, so
every value above is a module default - which is the point of the measurement in section 3.

### Backups present, timing modules only

| backup | bytes | md5 |
|---|---|---|
| `aligner.py.prealign.20260821135125` | 24677 | `780a852b430915e1d6dde2e86c1f235e` |
| `aligner.py.prealign.20260821135204` | 24677 | `780a852b430915e1d6dde2e86c1f235e` |
| `aligner.py.preflip.20260821145629` | 29542 | `7af928ceeeee983ac10d4d9fb179139a` |
| `chirp_timing.py.prefa.20260821092106` | 17308 | `89c3be08ff74f5f7a661e1fd925e96a6` |
| `chirp_wire.py.prefa.20260821092106` | 75557 | `6bf3b7d5cbb96d31e5f06abfa0e4e0cb` |
| `chirp_wire.py.presnap.20260821121905` | 80663 | `055f93c31ed0e41bed98e7d27a63f993` |
| `chirp_wire.py.presnap.20260821121938` | 80663 | `055f93c31ed0e41bed98e7d27a63f993` |
| `chirp_wire.py.presnap.20260821140137` | 84906 | `be76c39d96fede3b6846f9ddde2d4fb4` |
| `fa_timing.py.preback.20260821110108` | 18361 | `3b62f5e7350053050074e0b291873cfd` |
| `fa_timing.py.pretrim.20260821092534` | 17185 | `7e0447f3113899e91aee51332791dc50` |

`aligner.py.prebreathecap` (24054) and about 150 other `.pre*` copies of unrelated modules are
also present and predate today. **Every stamp a revert script is pinned to exists**: checked
directly against the `$suffix` values in the three scripts - `.prefa.20260821092106`,
`.preback.20260821110108`, `.prealign.20260821135204`, `.presnap.20260821121905`.

### Invariants and health

```
grep -c 'lead_in\|leadin\|sibilant\|_LEAD_IN' api/routers/dub_generate.py   -> 5    (expected 5)
stat -c %s services/speech_rate.py                                         -> 13073 (expected 13073)
grep -c leadin services/aligner.py                                         -> 1    (expected 1)
grep -c leadin services/chirp_wire.py                                      -> 1    (expected 1)
grep -c leadin services/fa_timing.py                                       -> 0
grep -c leadin services/chirp_timing.py                                    -> 0
/sysinfo                                                                   -> 200
```

Both `leadin` hits are the pre-existing prose the notes name: `aligner.py:430` ("audio leading the
picture", inside the BT.1359-1 comment) and `chirp_wire.py:1319` ("The leading (or trailing)
`frac`"). No render was in flight at any point; the app was never restarted.

## 2b. What is inconsistent with the four notes

Two things, both bookkeeping. Nothing about the deployed behaviour is wrong.

1. **`fa_primary_timing.md` records the wrong `fa_timing` backup.** It lists
   `fa_timing.py.pretrim.20260821092532` at 18361 bytes. On the box that stamp does not exist:
   there is `fa_timing.py.pretrim.20260821092534` (last digit 4) at **17185** bytes, and the
   18361-byte copy is `fa_timing.py.preback.20260821110108`, taken later by the BACK_MODE work.
   No revert script references `.pretrim` (`revert_fa.ps1 -Level all` moves `fa_timing.py` aside
   rather than restoring it), so nothing is broken - but the stamp as written cannot be used.
2. **The real video has 120 blocks in the as-deployed state, not 118.** `aligner_fixes.md` says
   "the guard now reverts 49 of 118 real blocks", and `onset_snap_bridge.md` reports 139 parts /
   118 blocks. 118 is the pre-star figure. With star tokens on, the merge produces **120** blocks:
   measured directly here (`blocks 120`, drift `of_lines 120`), and consistent with
   `aligner_fixes.md`'s own cascade counts for that same arm, which sum to 46 + 4 + 70 = 120. The
   correct statement is **49 of 120**. The percentages in that note are unaffected because they
   are per part (139), not per block.

Everything else lines up: every deployed fingerprint, every flag default, both guarded invariants,
both `leadin` counts, and every pinned backup.

## 3. Every change deployed today, its own measured effect, and its off switch

Each effect is the figure the owning note measured against its own baseline. They are not
additive and were not measured in combination until section 4.

| # | file | change | measured effect (its own note) | off switch | revert script |
|---|---|---|---|---|---|
| 1 | `chirp_timing.py` | chirp_3 as the recogniser, per-model `MODEL_LOCATION`, `enableWordConfidence` dropped for chirp_3 | bench chirp-only column mean 50.2; real video **cost** 6.3 points of well placed (78.4 chirp_2 -> 72.1 chirp_3, hinted re-anchor) and 2.5 points of dialogue coverage (87.8 -> 85.3). Side effect: no per-word confidence at all from chirp_3 | `OMNIVOICE_CHIRP_MODEL=chirp_2` | `revert_fa.ps1 -Level chirp3` |
| 2a | `fa_timing.py` | forced alignment primary, `fa_then_chirp` cascade | bench **+16.6** over chirp_3's own word times (50.2 -> 66.8); real video 72.1 -> 76.3 well, 16.4 -> 12.2 badly on chirp_3 word times | `OMNIVOICE_TIMING_SOURCE=chirp` | `revert_fa.ps1 -Level fa` |
| 2b | `fa_timing.py` | the drift guard | **costs 6.4 bench points** (66.8 with, 73.2 without) on a perfect transcript; fires on real material | `OMNIVOICE_FA_DRIFT_TOL_S` / `_DRIFT_RUN` / `_DRIFT_DELTA_S` (loosen), no clean full off switch | - |
| 2c | `fa_timing.py` | `OMNIVOICE_FA_BACK_MODE`, default `end` | default is the pre-flag code path, byte-identical in behaviour. The alternative (`start`) loses **5.4 bench points** and is neutral on the real video: a measured negative result | already off; `=start` to enable | `revert_fa.ps1 -Level backmode` (removes the flag) |
| 3a | `aligner.py` | the `per_line` window-split bug fix | **+15.0 points** through `retime_segments` on the production 45 s window (57.9 -> 72.9), +30.5 whole-file. **Zero effect in production today: `retime_segments` has no caller** | none (bug fix) | `revert_alignsplit.ps1 -Level split` (puts the bug back) |
| 3b | `aligner.py` | `OMNIVOICE_ALIGN_STARS`, default flipped to `1` | bench **66.8 -> 68.8** on the shipped cascade (66.6 -> 68.0 on `fa`); real video flat, 76.3 -> 75.5 against SE 3.6. Net 11 lines of 560; four conditions lose 2.5 each | `OMNIVOICE_ALIGN_STARS=0` | `revert_alignsplit.ps1 -Level stars` |
| 4a | `chirp_wire.py` | per-part quality metric (`well_parts` / `bad_parts` / `median_conf_parts`) | measurement only, no line moves | `OMNIVOICE_CHIRP_PART_QUALITY=0` | `revert_fa.ps1 -Level metric` (also removes the fa wiring) |
| 4b | `chirp_wire.py` | fa wiring in `_finish`, plus the `pre_retime_segments.json` dump | enables 2a; the dump is what makes every A/B honest | - | `revert_fa.ps1 -Level metric` |
| 4c | `chirp_wire.py` | `OMNIVOICE_SNAP_BAND`, default flipped to `1` (300-3400 Hz voiced gate) | **+15.5** bench mean over the shipped broadband snap (43.4 -> 58.9), wins or ties 14/14; real video 76.3 -> 75.5 (noise); halves the moves | `OMNIVOICE_SNAP_BAND=0` | `revert_snap.ps1 -Level gate` |
| 4d | `chirp_wire.py` | `OMNIVOICE_SNAP_BRIDGE`, default `0` | English-only win, unshipped: bench en 71.2 -> 80.0, oracle en 62.5 -> 77.5, en p95 537 -> 149 ms; **-5.9 bench mean overall**, -7.7 on the other six languages | already off; `=1` for English-primary jobs | `revert_snap.ps1 -Level bridge` |

## 4. The as-deployed bench, no environment variables set

`/root/bench` FLEURS corpus, 7 languages x clean/music, ground truth by construction, 40 lines per
condition, 560 per arm, cached chirp_3 responses, `/tmp/_fa_bench.py`
(md5 `4147bde04f3fd9f4c38349569767135f`) reused unmodified. Well placed = start error inside
-40/+120 ms. The only variables passed were the harness's own `BENCH_OUT`; `env | grep -c
OMNIVOICE_` inside the run was **1**, i.e. `OMNIVOICE_SERVER_MODE` alone.

**Read the caveat first.** `/tmp/_fa_bench.py` stops at `fa_timing.retime_blocks`: it contains no
reference to `_snap_onsets`, `resolve_timeline` or `breathe` (checked by grep, 0 hits each). So the
bench figure below prices changes 1, 2 and 3 and **does not exercise the snap at all** - neither
4c's band gate nor the snap it modifies. It is the number for the recogniser-plus-alignment part of
the stage, not for the stage.

| condition | chirp_3 only | `fa` | **as deployed (`fa_then_chirp`)** | median ms | p95 \|err\| ms |
|---|---|---|---|---|---|
| hi clean | 42.5 | 70.0 | **70.0** | -9.8 | 1558.1 |
| hi music | 57.5 | 75.0 | **77.5** | -1.2 | 140.6 |
| te clean | 52.5 | 75.0 | **75.0** | -16.1 | 869.1 |
| te music | 62.5 | 70.0 | **70.0** | +3.5 | 869.1 |
| en clean | 52.5 | 60.0 | **60.0** | +3.5 | 596.6 |
| en music | 60.0 | 65.0 | **65.0** | +0.0 | 628.6 |
| ta clean | 60.0 | 77.5 | **75.0** | +9.9 | 1760.4 |
| ta music | 55.0 | 72.5 | **80.0** | +16.3 | 1233.6 |
| ml clean | 40.0 | 52.5 | **55.0** | -21.1 | 1063.4 |
| ml music | 52.5 | 55.0 | **57.5** | -17.2 | 1230.0 |
| kn clean | 35.0 | 62.5 | **62.5** | +9.3 | 1261.6 |
| kn music | 45.0 | 70.0 | **67.5** | +0.0 | 3274.7 |
| gu clean | 47.5 | 72.5 | **72.5** | +6.2 | 696.4 |
| gu music | 40.0 | 75.0 | **75.0** | +0.1 | 696.4 |
| **mean** | **50.2** | **68.0** | **68.8** | | |
| **median of the 14 conditions** | **52.5** | **70.0** | **70.0** | | |
| p95 of the 14 conditions | 60.0 | 75.0 | 77.5 | | |
| min / max | 35.0 / 62.5 | 52.5 / 77.5 | 55.0 / 80.0 | | |

Across the 14 conditions the as-deployed median start error is **+0.1 ms**, the median p95 \|error\|
is **966.2 ms**, and the worst p95 tail is **3274.7 ms** (kn music, unchanged from every earlier
arm).

**Every expected figure reproduced exactly**: mean **68.8** (68.75 unrounded), hi clean 70.0,
te clean 75.0, en clean 60.0, en music 65.0, gu music 75.0. So did the two columns nobody asked
for: the chirp_3-only column reproduces the recorded 50.2 mean cell for cell, and the `fa`-only
column reproduces `aligner_fixes.md`'s star arm (68.0) cell for cell. The harness is measuring the
same thing it measured this morning.

### Refusals and the cascade, summed over 560 lines

| fa | fa_hinted | chirp kept | anchors | refusals |
|---|---|---|---|---|
| 414 | 12 | 134 | 505 | `drift 110, conf 15, length 6, backwards 2, -7.9s 1` |

Identical to the stars-ON row in `aligner_fixes.md`. The drift guard reverted **110 lines of 560
in 20 runs of 32 seen**, and the per-condition split reproduces that note's table cell for cell:
hi clean 10/2, te clean 12/2, te music 7/1, ta clean 14/4, ta music 8/2, ml clean 23/3,
ml music 23/3, kn clean 6/2, kn music 7/1, and 0/0 for hi music, en clean, en music, gu clean,
gu music.

### The repeat

Run A 18:07-18:14 UTC, run B 18:16-18:23 UTC, same invocation, box to itself. A field-by-field
comparison of every recorded value in both JSON files - `n`, `well_pct`, `median_ms`,
`p95_abs_ms`, the whole report dict including refusals and drift, `matched_pct`, `token_hit_pct`,
for all 14 conditions and all three modes - gives **0 differing fields**. A third run, launched by
mistake before A and whose log was overwritten, printed the same 14-condition summary table, so the
figure held three times.

## 5. The as-deployed real video, no environment variables set

Job `faprim01` (760 s Hindi "Desi Friends"), timing stage only, on the identical cached Gemini
transcript (`pre_retime_segments.json`, md5 `61499d9ac4ae5b3bac69473e91cf7efd`, 148 transcriber
lines, 7565 chars) and the identical cached chirp_3 word stream (`chirp_words_cache.json`, md5
`5d3c82ce79e685e29804777ae434b5a0`), through `/tmp/_fa_ab.py`
(md5 `27b8f4b44a7f4532c4de595ddc0d1b11`) **unmodified**. Scored on the FINAL saved segments after
resolve/snap/breathe: each line's own source text forced-aligned in its own slot, well = median
per-word confidence >= 0.45, badly < 0.25. n = 139 parts, so one standard error on a 76%
proportion is **3.6 points**.

The run went through a preamble (`/tmp/_v2_ab_pre.py`) that wraps `_snap_onsets` to record every
moved start and then execs `/tmp/_fa_ab.py` unmodified. Unlike the preamble
`onset_snap_bridge.md` used, it **pins nothing**: the live 29885-byte `aligner.py` is what ran,
which the log records by md5. `OMNIVOICE_*` in the process environment was
`{'OMNIVOICE_SERVER_MODE': '1'}` and the log prints that too.

| metric | run 1 | run 2 | expected |
|---|---|---|---|
| well placed / line | **75.5** | **75.5** | 75.5 |
| badly placed / line | **12.2** | **12.2** | 12.2 |
| `well_parts` (pipeline) | **77.0** | **77.0** | 77.0 |
| `bad_parts` | 10.8 | 10.8 | 10.8 |
| `well_blocks` / `bad_blocks` | 80.0 / 10.8 | 80.0 / 10.8 | - |
| median conf (p5 / p95) | 0.646 (0.123 / 0.900) | 0.646 (0.123 / 0.900) | 0.646 |
| parts | 139 | 139 | 139 |
| blocks | **120** | **120** | notes say 118, see 2b |
| lines in -> out | 148 -> 139 | 148 -> 139 | 148 -> 139 |
| dialogue covered | 85.3 | 85.3 | 85.3 |
| raw speech covered | 87.5 | 87.5 | 87.5 |
| pipeline `speech_covered` | 85.4 | 85.4 | - |
| span total | 619.3 s | 619.3 s | 619.3 s |
| speaker purity / part purity | 84.2 / 100.0 | 84.2 / 100.0 | - |
| chars in -> out | 7565 -> 9079 | 7565 -> 9079 | - |

Line buckets, run 1: 105 lines well placed, 17 in the middle band, 17 badly placed.

### Cascade, refusals and the drift guard

| fa | fa_hinted | chirp kept | anchors | \|move\| from chirp median / p95 |
|---|---|---|---|---|
| 46 | 4 | 70 | 65 | 0.047 s / 0.990 s |

Refusals, both runs: **`drift 49, conf 9, length 7, backwards 3, collapsed 1, window 1`** -
identical to the stars-ON row in `aligner_fixes.md`.

Drift guard: **49 lines of 120 reverted, in 5 runs of 8 seen**, fitted = true, residual median
5.259 s, residual p95 13.969 s, fitted slope 6.497 s per line. The expected "49 lines / 5 runs"
reproduced; the denominator is 120, not 118 (section 2b).

### The repeat

Run 1 18:26-18:33 UTC, run 2 18:39-18:46 UTC, both 431 s of `retime_job`. Every field above is
equal, the two `timing_report` dicts serialise identically, the 139 per-line confidences are the
same list, and the 139 saved start/end pairs are the same list. `pre_retime_segments.json` is
re-dumped by `retime_job` on each run and its md5 was unchanged after both, so the input the second
run read is byte-identical to the input the first run read. **Bit-identical on repeat.**

## 6. The safety check, which outranks the score

Method from `research/onset_snap_bridge.md` section 7: for every start `_snap_onsets` moves, does
the new start land inside the previous line's accepted span - the ends being the ones
`resolve_timeline` fixed, which the snap never touches. Margin is new start minus previous end, so
a negative margin is a crossing. Adjacent pairs are also counted before and after the snap, so an
inherited overlap cannot be blamed on the snap or hidden by it.

| run | lines | moved | back | fwd | bridged | \|move\| median | \|move\| p95 | max back | on the 600 ms cap | past 600 ms | **crossings** | min margin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 139 | 35 | 27 | 8 | 0 | 286.0 ms | 600.0 ms | 600.0 ms | 13 | 0 | **0** | **150.0 ms** |
| 2 | 139 | 35 | 27 | 8 | 0 | 286.0 ms | 600.0 ms | 600.0 ms | 13 | 0 | **0** | **150.0 ms** |

**0 crossings in 70 moved starts across the two runs. The minimum margin is 150.0 ms**, the 5th
percentile margin is 400.0 ms and the median margin is 1390.0 ms. Overlapping adjacent pairs were
**0 before and 0 after** the snap in both runs, and the line order was stable. No move exceeded
the 600 ms in-run backward budget, which is correct: `SNAP_BRIDGE` is off, so the 1.0 s bridged
budget is unreachable and `bridged` is 0.

Two figures differ from `onset_snap_bridge.md`'s band-gate row on this video (32 moves, min margin
70 ms), and the reason is stated there: that note pinned the 24677-byte pre-star `aligner.py`. With
the deployed aligner the snap moves 35 starts and the tightest margin is wider, not narrower. The
result that matters is the same and is now measured on the live tree: zero crossings.

The largest backward moves are all clamped at the 600 ms cap with room to spare (`c001`
3.880 -> 3.280 s, margin 1560 ms; `c053` 278.654 -> 278.054 s, margin 2109 ms). The tightest
margin, `c109` at 566.070 s with 150 ms of daylight, is a 90 ms move, not a clamped one.

## 7. Per-language well placed, as deployed

Bench only. Percentages are the mean of the clean and music conditions.

| language | clean | music | mean |
|---|---|---|---|
| Tamil | 75.0 | 80.0 | **77.5** |
| Hindi | 70.0 | 77.5 | **73.8** |
| Gujarati | 72.5 | 75.0 | **73.8** |
| Telugu | 75.0 | 70.0 | **72.5** |
| Kannada | 62.5 | 67.5 | **65.0** |
| **English** | **60.0** | **65.0** | **62.5** |
| Malayalam | 55.0 | 57.5 | **56.2** |
| all 14 conditions | | | mean 68.8, median 70.0 |
| the six non-English languages | | | mean 69.8 |

**English is second from bottom, 7.3 points below the non-English mean, and its figures are FLEURS
read speech.** There is no English source video on the box. Three separate probes have said so
already (`fa_primary_timing.md`, `onset_snap_bridge.md` section 11,
`research/english_timing_diagnosis.md` section 11) and a fourth was run here: the eight job
directories hold exactly **two** distinct `original.mp4` files by md5 - `23cbe5580b99...`, 760 s,
in six directories, and `fd575e2525c9...`, 546.7 s, in two - one directory is empty, the only
transcript on disk is `faprim01`'s at 5890 Devanagari codepoints against 24 Latin, and all five
`dub_history` rows point at the same "Desi Friends" source. So no English figure in this note or
any of the four is measured on real English video, and the 546 s clip was not re-classified here
(the earlier probe records it as `hi`, 331 Devanagari codepoints in a 30 s sample).

## 8. What is still open

* **The drift guard reverts 49 of 120 real blocks and costs 6.4 bench points.** On the bench the
  transcript is perfect, so drift cannot happen and the guard can only ever cost: 110 of 560 lines
  reverted, and `fa_primary_timing.md` prices that at 66.8 against 73.2 with the guard off. On the
  real video it reverted 49 lines in 5 runs, up from 20 in 3 before star tokens - freeing the
  `backwards` bucket handed the work to the guard rather than to the output. Its fitted slope on
  `faprim01` is 6.497 s per line with a residual p95 of 13.969 s, so a straight line is a poor
  model of this video's pacing and the guard is being asked to judge against it. Three env vars
  loosen it. Nobody has yet measured the guard on an imperfect transcript, which is the case it
  exists for.
* **Dialogue coverage is 85.3% against a recorded 98.5%.** Reproduced twice here. Forced alignment
  is not the cause - it decides where a line sits, not which speech gets a line - and chirp_3 cost
  2.5 points of it against chirp_2. Coverage is decided earlier, by what the recogniser hears and
  by gap recovery. Raw speech covered is 87.5% and the pipeline's own `speech_covered` is 85.4%.
  Closing this is separate work and has not started.
* **`OMNIVOICE_SNAP_BRIDGE` is an unshipped English-only win.** It is worth bench en 71.2 -> 80.0,
  oracle en 62.5 -> 77.5, en/clean p95 494 -> 151 ms, and it is the only thing that recovers the
  0.911 s abandoned-first-word case. It costs 7.7 points of mean on the other six languages and
  5.9 on the bench mean, so it stays off. It cannot be validated where it would be used until
  there is English video on the box.
* **The snap costs the non-English bench 28.9 points and nobody has explained it.** 67.7 without
  the snap against 38.8 with it as shipped; the band gate recovers 17.4 of those. On the real video
  the same snap is worth +1.8 points of raw speech coverage and nothing measurable in `well`. The
  bench is read speech whose ground-truth start *is* the clip onset, so it may simply be unable to
  price a lead-in recovery - but that is a hypothesis, not a finding, and the disagreement is large
  enough that "should the snap run at all on non-English material" is still open. The next
  measurement worth doing is a no-snap arm on real non-English video, n > 1.
* **`retime_segments` still has no caller.** The +15.0 point bug fix is live and inert.
* Smaller and unexplained: kn/clean and both gu conditions lose 2.5 points with star tokens on, and
  kn/clean is the only condition whose p95 tail also worsens.

## 9. Revert scripts, consolidated

Four scripts touch this area and they are **not** interchangeable. All four take `-Status`; the
three from today also take `-WhatIf`, back the current file up to `.prerevert.<utc>` first, import
every touched module for real, re-check both invariants, reload the app and confirm `/sysinfo` 200,
and refuse to run while a render looks to be in flight.

| script | owns | level | what it does | pinned backup |
|---|---|---|---|---|
| `revert_fa.ps1` | `chirp_timing.py`, `chirp_wire.py`, `fa_timing.py` | `fa` | pins `fa_timing`'s default to `chirp`. No file restored; chirp_3 and the per-part metric stay | - |
| | | `chirp3` | restores `chirp_timing.py`, i.e. back to chirp_2 | `.prefa.20260821092106` (17308 B) |
| | | `metric` | restores `chirp_wire.py` - removes the per-part metric **and** the fa wiring **and** the snap band gate, because all three live in that file | `.prefa.20260821092106` (75557 B) |
| | | `backmode` | restores `fa_timing.py`, removing `OMNIVOICE_FA_BACK_MODE`. Behaviour does not change; the default is the pre-flag path | `.preback.20260821110108` (18361 B) |
| | | `all` | `chirp_timing.py` and `chirp_wire.py` restored, `fa_timing.py` moved aside | `.prefa.20260821092106` |
| `revert_alignsplit.ps1` | `aligner.py` only | `stars` | pins `OMNIVOICE_ALIGN_STARS` to `0`. No file restored, the bug fix stays. **Reach for this first** | - |
| | | `split` | restores `aligner.py` - puts the `per_line` window-split **bug** back and removes the flag with it | `.prealign.20260821135204` (24677 B) |
| | | `all` | the same as `split`: both changes are in one file | `.prealign.20260821135204` |
| `revert_snap.ps1` | `chirp_wire.py`, snap only | `gate` | pins `OMNIVOICE_SNAP_BAND` to `0`, i.e. the broadband gate the snap shipped with. **Reach for this first** | - |
| | | `bridge` | pins `OMNIVOICE_SNAP_BRIDGE` to `0` (already 0) | - |
| | | `file` | restores `chirp_wire.py` - removes `_band_pass`, `_bridge_run` and all four snap flags, keeping the fa wiring and the per-part metric | `.presnap.20260821121905` (80663 B) |
| `revert_aligner.ps1` | **pre-existing, much bigger** | (no levels) | **undoes the whole MMS forced-alignment timing stage** and hands timing back to Gemini's own timestamps. Not a level of anything above and not scoped to today's work; on a real 197-line Hindi job those timestamps had two stretches placed on audio that did not contain their text (median alignment confidence 0.01 and 0.09) including 15 lines sitting 10-14 s late. `-Status` only, otherwise it reverts everything | - |

Two overlaps to keep in mind. `revert_fa.ps1 -Level metric` and `-Level all` restore
`chirp_wire.py` from the 75557-byte `.prefa` copy, which silently undoes the snap work as well; if
both need reverting, run `revert_fa.ps1` last. And `revert_aligner.ps1` is a different animal
entirely - do not reach for it when `revert_alignsplit.ps1` is what is meant.

For one run and no edit at all: `OMNIVOICE_TIMING_SOURCE=chirp`, `OMNIVOICE_ALIGN_STARS=0`,
`OMNIVOICE_SNAP_BAND=0`, `OMNIVOICE_CHIRP_SNAP_ONSET=0`, `OMNIVOICE_CHIRP_MODEL=chirp_2`.

## 10. What was verified, and what was not

Verified on the box: every fingerprint and flag in section 1; both guarded invariants and both
`leadin` counts, before and after all measurement, unchanged; `/sysinfo` 200; the presence of every
backup each revert script is pinned to; the bench table twice with 0 differing fields, plus a third
consistent run; the real video twice, bit-identical, on inputs whose md5s were unchanged by the
runs; the crossing count and margins on the live tree; that the bench harness contains no reference
to `_snap_onsets`, `resolve_timeline` or `breathe`; that only two distinct source videos exist on
the box.

**Not checked.** No revert script was executed, at any level, in any mode - not even `-WhatIf`; the
descriptions in section 9 come from reading the scripts and their templates and from the notes that
built them. The oracle-window arm, the `retime_segments` arm and the whole-file arm were not re-run;
their figures in section 3 are quoted from their notes, not reproduced here. No no-snap or
snap-variant arm was run, so nothing here re-measures the band gate or the bridge - the bench cannot
see the snap and the real-video arm ran the snap only in its deployed configuration. Nobody listened
to any audio: the real-video score is a forced-alignment confidence proxy, and the 35 moved starts
were not auditioned. Only line starts were measured, never ends. The 546 s clip was not
re-classified for language. `n` is one video for every real-material figure in this note.

## 11. Artefacts

On the box, staged in `/home/ubuntu/_v2_out/`:

```
_v1_audit.txt                        the full state audit, as read
_v2_bench_A.json  _v2_bench_A.log    bench, 14 conditions x 3 modes, as deployed
_v2_bench_B.json  _v2_bench_B.log    the repeat
_v2_bench_tab.txt                    the tables in section 4, plus the field-by-field A/B diff
_fa_ab_faprim01_run1.json            real video, as deployed
_fa_ab_faprim01_run2.json            the repeat
_v2_ab_run1.log  _v2_ab_run2.log     the run logs, including the live md5s and the env dump
_v2_moves_faprim01_run1.json         every moved start, margin and crossing check
_v2_moves_faprim01_run2.json         the repeat
_v2_sum.txt                          the tables in sections 5 and 6
_v2_ab_pre.py                        the instrumenting preamble (pins nothing)
```

Harnesses reused unmodified: `/tmp/_fa_bench.py` (md5 `4147bde04f3fd9f4c38349569767135f`),
`/tmp/_fa_ab.py` (md5 `27b8f4b44a7f4532c4de595ddc0d1b11`). New: `/tmp/_v2_ab_pre.py`,
`/tmp/_v2_tab.py`, `/tmp/_v2_sum.py`. Local drivers, run through `rsh.ps1`: `_v1_audit.sh`,
`_v2_read.sh`, `_v2_pre.sh`, `_v2_bench_a.sh`, `_v2_bench_b.sh`, `_v2_poll.sh`, `_v2_check.sh`,
`_v2_real1.sh`, `_v2_real2.sh`, `_v2_bench_tab.sh`, `_v2_sum.sh`, `_v3_read.sh`, `_v3_lang2.sh`,
`_v3_mp4.sh`.
