# Forced alignment as the primary timing source, and Chirp 2 -> Chirp 3

2026-08-21, container `omnivoice` on the GPU box. Everything below was measured on that box;
nothing is carried over from an earlier note except the FLEURS bake-off table, which was given
and was not re-derived.

## What changed

Three things, in `/app/backend`, each backed up first with `cp -p f f.prefa.<utc>`:

| file | before | after | backup |
|---|---|---|---|
| `services/chirp_timing.py` | 17308 B | 21213 B | `chirp_timing.py.prefa.20260821092106` |
| `services/chirp_wire.py` | 75557 B | 80663 B | `chirp_wire.py.prefa.20260821092106` |
| `services/fa_timing.py` | (did not exist) | 18361 B, new | `fa_timing.py.pretrim.20260821092532` (an earlier draft of the same new file) |

Patches were applied by a script that asserts every anchor occurs **exactly once** in the live
file and refuses to write otherwise (8 anchors, all unique). Each module was then IMPORTED for
real - `python3 -c "import services.fa_timing"` etc, plus `import main` - not merely compiled.

### A. Chirp 3 (`services/chirp_timing.py`)

`LOCATION` and the features dict are now **per model**, because probing the live API from the
container proved the two models share no serving location:

```
us-central1      chirp_2  wt       hi-IN  OK words=33 timed=33
us-central1      chirp_3  wt       hi-IN  HTTP 400 model "chirp_3" does not exist in the location named "us-central1"
europe-west4     chirp_2  wt       hi-IN  OK words=33 timed=33
europe-west4     chirp_3  wt       hi-IN  HTTP 400 ... does not exist in the location named "europe-west4"
asia-southeast1  chirp_2  wt       hi-IN  OK words=33 timed=33
asia-southeast1  chirp_3  wt       hi-IN  HTTP 403 Permission denied ... on model chirp_3 locale hi-IN. It is no longer generally available.
us               chirp_2  wt       hi-IN  HTTP 400 model "chirp_2" does not exist in the location named "us"
us               chirp_3  wt       hi-IN  OK words=35 timed=35
eu               chirp_3  wt       hi-IN  OK words=35 timed=35
global           any                      HTTP 404 (not a Speech v2 host at all)
us               chirp_3  wt+conf  hi-IN  HTTP 400 Config contains unsupported fields
asia-southeast1  chirp_3  wt+conf  hi-IN  HTTP 400 Config contains unsupported fields
```

and `enableWordTimeOffsets` alone returns fully timed words on all seven bench languages from
`us` (hi 35/35, te 36/36, en 34/34, ta 34/34, ml 33/33, kn 32/32, gu 32/32 on the same 12 s clip).

So:

```python
MODEL_LOCATION = {"chirp_2": "us-central1", "chirp_3": "us"}      # env-overridable
MODEL_FEATURES = {"chirp_2": {"enableWordTimeOffsets": True, "enableWordConfidence": True},
                  "chirp_3": {"enableWordTimeOffsets": True}}
MODEL          = "chirp_3"        # the default now
FALLBACK_MODEL = "chirp_2"
```

`_recognize(wav, code, token, model=None)` takes both from the model via `location_for()` /
`features_for()`; `LOCATION` still exists as a module attribute (older probes read it) and is now
`location_for(MODEL)`. Chirp 2 stays fully working: a chunk that comes back 400/403/404 is retried
once on `FALLBACK_MODEL`, and only those codes are retried - a 5xx is a bad moment, not a bad
model, and retrying it would bill twice for the same failure.

Live proof from the real-video run: `chirp: chirp_3 hi-IN -> N word(s)` throughout, zero fallbacks.

One consequence to know about: **chirp_3 returns no per-word confidence at all** (0 of 252 words in
the smoke test carried one). Nothing breaks - the `min_conf_cut` grid points in `chirp_wire` simply
stop having an effect, and `asr_confidence` on a native line is `None`.

### B. Forced alignment first (`services/fa_timing.py`, wired from `chirp_wire._finish`)

Before: Chirp gave the word times and MMS re-anchored each line inside `max(0.60s, 0.50 x length)`
of them. Now the placement of a line is decided by alignment in a window bounded by trusted
neighbours; Chirp's position is not consulted. The cascade per line is

1. **FA-wide** - align the line's text in `[previous accepted end - 1.5s, cursor + max(8s, 1.6 x
   line length)]`, further bounded by the next trusted anchor. Only the line's LENGTH is taken from
   Chirp, to keep the window (and the cost) finite; its position is not.
2. **FA-hinted** - the old narrow-pad re-anchor, as second choice.
3. **Chirp** - the times as they arrived.

`OMNIVOICE_TIMING_SOURCE` decides how far a line may fall: `fa` = step 1 only, `fa_then_chirp` =
1 -> 2 -> 3 (**default**), `chirp` = none of it, which restores exactly the previous behaviour
(Chirp's times, MMS re-anchored inside them).

Refusals, all measured failure modes, all counted and logged: `window edge` (CTC dumping unmatched
tokens at the boundary - the artefact that once produced 88 s and 108 s "relocations"), `length`
(span more than 2.5x or less than 0.35x the line), `backwards` (would start before the previous
line's accepted end, tolerance 0.25 s), `>6.0s from chirp`, `conf` (median per-word confidence
below 0.35), `collapsed`.

A milder form of the same artefact is handled rather than refused: CTC parks unmatched audio on the
first and last word, so a line's span is taken over the words scoring at least 0.20 and the
outliers are clamped into it. Without that, 4 of 14 smoke blocks had a confident interior
(median 0.79-0.89) with one edge word thrown 2.9-5.0 s into the pad.

### The drift guard

`_drift_flags` fits a robust line (Theil-Sen: median of pairwise slopes, then median intercept) to
the **trusted anchors' aligned starts against line index**, takes every accepted line's residual
from that line, and flags contiguous runs of same-sign residuals over `DRIFT_TOL_S` (1.5 s) at
least `DRIFT_RUN_MIN` (3) long. Flagged lines revert to Chirp's times.

One extra condition, because a straight line is a crude model of real pacing: the run must ALSO
disagree with Chirp by more than `DRIFT_DELTA_TOL_S` (1.0 s). If alignment and Chirp agree there is
no drift, whatever a fitted line says, and reverting would throw away a correct answer. Fewer than
`DRIFT_MIN_ANCHORS` (4) anchors means "not fitted" and nothing is reverted - reported as such,
never silently.

Everything is reported as **median and p95**, never the mean.

### C. Per-part quality (`chirp_wire._add_part_quality`)

`_quality` still runs on the merged BLOCKS. It now also runs on the PARTS the speaker split
produces - the lines that actually render - and both go into `timing_quality`, labelled:
`well_blocks` / `bad_blocks` / `median_conf_blocks` and `well_parts` / `bad_parts` /
`median_conf_parts`, with `blocks` and `parts` counts. `well` / `bad` keep their old meaning
(blocks) so nothing that already reads them changes. Measurement only; no line moves because of it.
Off switch: `OMNIVOICE_CHIRP_PART_QUALITY=0`.

On the real video it published `per BLOCK well 80.5% badly 11.9% (118 blocks); per rendered PART
well 78.4% badly 10.8% (139 parts)` - the gap the brief asked to make visible.

Also added: `chirp_wire` dumps the transcriber's own lines to `pre_retime_segments.json` in the job
dir before touching them (measurement only). That is what made the A/B below honest - every arm re-ran
the timing stage on the identical Gemini transcript instead of on a fresh Gemini pass.

## Env flags

| flag | default | what it does |
|---|---|---|
| `OMNIVOICE_TIMING_SOURCE` | `fa_then_chirp` | `fa` / `fa_then_chirp` / `chirp` (off switch, no revert needed) |
| `OMNIVOICE_CHIRP_MODEL` | `chirp_3` | recogniser for word times |
| `OMNIVOICE_CHIRP_FALLBACK_MODEL` | `chirp_2` | retried once on 400/403/404 |
| `OMNIVOICE_CHIRP3_LOCATION` / `OMNIVOICE_CHIRP2_LOCATION` | `us` / `us-central1` | per-model location |
| `OMNIVOICE_CHIRP_LOCATION` | (unset) | overrides both, for pinning by hand |
| `OMNIVOICE_FA_ANCHOR_CONF` | 0.60 | bar for a line to be a trusted anchor |
| `OMNIVOICE_FA_MIN_CONF` | 0.35 | bar for accepting an alignment at all |
| `OMNIVOICE_FA_LOOKAHEAD_S` / `_LOOKBEHIND_S` | 8.0 / 1.5 | the unhinted window |
| `OMNIVOICE_FA_MAX_DELTA_S` / `_MAX_STRETCH` / `_MIN_STRETCH` | 6.0 / 2.5 / 0.35 | plausibility bounds |
| `OMNIVOICE_FA_TRIM_CONF` | 0.20 | edge-spill trim |
| `OMNIVOICE_FA_DRIFT_TOL_S` / `_DRIFT_RUN` / `_DRIFT_DELTA_S` / `_DRIFT_MIN_ANCHORS` | 1.5 / 3 / 1.0 / 4 | drift guard |
| `OMNIVOICE_CHIRP_PART_QUALITY` | 1 | per-part metric |

The container's environment is fixed at create time (it holds only `OMNIVOICE_SERVER_MODE=1`), so
these are module defaults. Changing behaviour for one run is `docker exec -e FLAG=value`, which is
how every arm below was measured.

## Bench re-score, through the shipped module

`/root/bench` FLEURS corpus, 7 languages x clean/music, ground truth by construction, **cached**
recogniser responses (nothing re-billed). The ground-truth lines are the transcript,
`chirp_timing.retime_by_words` maps them onto the cached chirp_3 word stream (that is the recorded
`chirp_3` arm), each line becomes a block, and `fa_timing.retime_blocks` re-times it. Well placed =
start error inside -40/+120 ms, exactly as recorded.

The harness reproduces the recorded chirp_3 column almost exactly (hi/clean 42.5 vs 42.5, te/clean
52.5 vs 52.5, ta/clean 60.0 vs 60.0, kn/clean 35.0 vs 35.0, gu/clean 47.5 vs 47.5), which is the
evidence that it measures the same thing.

| condition | chirp_3 only | `fa` | `fa_then_chirp` | guard OFF | lines the guard reverted (of 40) |
|---|---|---|---|---|---|
| hi clean | 42.5 | 60.0 | 62.5 | 70.0 | 6 |
| hi music | 57.5 | 75.0 | 77.5 | 77.5 | 0 |
| te clean | 52.5 | 65.0 | 65.0 | 80.0 | 17 |
| te music | 62.5 | 70.0 | 65.0 | 65.0 | 6 |
| en clean | 52.5 | 55.0 | 55.0 | 55.0 | 0 |
| en music | 60.0 | 67.5 | 67.5 | 67.5 | 0 |
| ta clean | 60.0 | 77.5 | 75.0 | 82.5 | 11 |
| ta music | 55.0 | 75.0 | 72.5 | 77.5 | 8 |
| ml clean | 40.0 | 52.5 | 55.0 | 82.5 | 23 |
| ml music | 52.5 | 52.5 | 55.0 | 75.0 | 25 |
| kn clean | 35.0 | 67.5 | 65.0 | 67.5 | 3 |
| kn music | 45.0 | 67.5 | 67.5 | 72.5 | 8 |
| gu clean | 47.5 | 72.5 | 75.0 | 75.0 | 0 |
| gu music | 40.0 | 75.0 | 77.5 | 77.5 | 0 |
| **mean** | **50.2** | **66.6** | **66.8** | **73.2** | 107 of 560 |

Median start error moves from -34.4/-16.4/-28.0 ms (hi/te/ml clean, chirp_3) to -18.1/-21.8/-21.1 ms,
and p95 |error| falls in 11 of 14 conditions (hi clean 2210 -> 1664 ms, gu clean 2577 -> 647 ms,
ta clean 2417 -> 1760 ms). Two conditions have a worse p95 tail (kn music 1730 -> 3275 ms).

Read this honestly:

* forced alignment as the primary source is worth **+16.6 points** of well-placed lines over
  chirp_3's own word times, on every one of the 14 conditions bar one tie.
* the **drift guard costs 6.4 points** on this corpus (66.8 vs 73.2), concentrated on ml
  (55.0 vs 82.5) and te clean (65.0 vs 80.0), where it reverted 17-25 of 40 lines that ground
  truth says were right. That is the price of the protection: the bench transcript is PERFECT, so
  drift cannot happen here and the guard can only ever cost. In production the transcript is
  Gemini's, which is the case the guard exists for.
* guard OFF (73.2) lands where the recorded bespoke forced-alignment arm did (mean of the given
  table's MMS column, 74.8), which says the shipped module reproduces the bake-off rather than
  approximating it.
* the guard is three env vars away from being loosened (`OMNIVOICE_FA_DRIFT_TOL_S`,
  `_DRIFT_RUN`, `_DRIFT_DELTA_S`) if a later measurement on imperfect transcripts says it is too
  eager. It is deliberately left eager for now.

## Real video

New job `faprim01`, the same 760 s "Desi Friends" source as history, uploaded and transcribed
through the real endpoints: Gemini (`openai-compat-asr`, `gemini-3.7-flash`) produced the
transcript, pyannote diarized, chirp_3 supplied word times, `fa_timing` placed the lines. **The
four CSV-imported jobs were not touched.** 148 Gemini lines -> 118 blocks -> 139 rendered parts.

Then the timing stage alone was re-run five ways on that identical Gemini transcript and identical
cached word stream (`chirp_2` arms got their own cache dir, because the word cache is keyed on the
audio and does not record the model - reusing the job's cache would have silently measured chirp_3
twice). Scored with the bench metric on the FINAL saved segments, i.e. after resolve/snap/breathe:
each line's own source text forced-aligned inside its own slot, well = median per-word confidence
>= 0.45, badly < 0.25.

| arm | well placed / line | badly / line | well_parts (pipeline) | dialogue covered | raw speech covered | median conf |
|---|---|---|---|---|---|---|
| recorded baseline (given) | 43.5 | - | - | 98.5 | - | - |
| chirp_2 + hinted re-anchor (the previous pipeline) | **78.4** | 12.2 | 80.6 | 87.8 | 90.8 | 0.654 |
| chirp_3 + hinted re-anchor | 72.1 | 16.4 | 75.0 | 85.3 | 89.6 | 0.637 |
| chirp_3 + FA primary (`fa`) | 76.3 | 12.2 | 77.0 | 85.3 | 89.0 | 0.657 |
| chirp_3 + FA primary (`fa_then_chirp`, shipped) | **76.3** | **12.2** | 78.4 | 85.3 | 89.0 | 0.657 |
| chirp_2 + FA primary | 74.8 | 12.9 | 82.0 | 87.8 | 90.6 | 0.646 |

The HTTP transcribe itself produced exactly the `fa_then_chirp` row (139 parts, well_parts 78.4,
bad_parts 10.8, dialogue 85.3), so the offline A/B reproduces the live pipeline.

What this says, without decoration:

* against the recorded 43.5% baseline every arm is far ahead. That baseline is old enough that the
  pipeline has changed underneath it in several other ways, so it is a weak comparison.
* **the like-for-like comparison is within noise.** n = 139 lines, so one standard error on a 76%
  proportion is 3.6 points. chirp_2+hinted (78.4), chirp_3+FA (76.3) and chirp_2+FA (74.8) are
  indistinguishable; only chirp_3+hinted (72.1, badly placed 16.4%) is clearly the worst.
* on chirp_3 word times, FA primary is a real improvement: 72.1 -> 76.3 well, 16.4 -> 12.2 badly.
  On chirp_2 word times it is neutral-to-slightly-worse on the final lines (78.4 -> 74.8) while the
  pipeline's own per-part figure moved the other way (80.6 -> 82.0); the two disagree because the
  pipeline scores parts BEFORE resolve/snap/breathe and this table scores what is saved.
* **coverage did not improve and chirp_3 cost 2.5 points of it**: dialogue covered 87.8% (chirp_2)
  vs 85.3% (chirp_3), raw speech covered 90.8% vs 89.0%. Both are far below the recorded 98.5%, and
  forced alignment is not the cause - it does not decide which speech gets a line, only where the
  line sits. Coverage is decided earlier, by what the recogniser hears and by gap recovery
  (`72.9% -> 82.9%` after recovering 64 of 65 gaps; 12 gaps totalling 10.9 s neither source could
  read). Closing the 85 -> 98 coverage gap is a separate piece of work.
* the drift guard **did fire on real material**: 20 of 118 blocks reverted in 3 runs
  (`fa_then_chirp`), 7 in 2 runs (`fa`). Refusals for the shipped arm:
  `backwards 40, drift 20, length 14, window 6, conf 1, no alignment 1` - so 82 of 118 blocks kept
  Chirp's times and 36 were placed by alignment. `backwards` being the largest bucket is a known
  limitation: an accepted line whose end stretches forward pushes the cursor past the next line's
  true start, and the next line is then refused. Worth revisiting; not touched here because the
  measurement above was already running against this code.

English: **no English real video is available on the box.** All five job dirs hold the same two
Hindi sources (the 760 s "Desi Friends" and a 546 s clip whose language probes as `hi`, 331
Devanagari codepoints in a 30 s sample). The English figures above are FLEURS read speech only.

## Invariants

Checked before every write and after every write, and again at the end:

```
docker exec CT grep -c 'lead_in\|leadin\|sibilant\|_LEAD_IN' /app/backend/api/routers/dub_generate.py  -> 5
docker exec CT stat -c %s /app/backend/services/speech_rate.py                                         -> 13073
```

Both held throughout. No identifier containing `leadin` was introduced: `grep -c leadin` is 0 in
`chirp_timing.py` and `fa_timing.py`, and 1 in `chirp_wire.py` - which is the pre-existing phrase
"the leading (or trailing) frac" in `_fill_fraction`, present in the `.prefa` backup too.
The container was never recreated; only files inside it were written.

## How to revert

`revert_fa.ps1` + `_revert_fa_tmpl.sh`, built on the `revert_csvimport.ps1` pattern. It copies the
current file to `.prerevert.<utc>` first (so the revert is itself reversible), imports every touched
module for real, re-checks both invariants, reloads the app and waits for `/sysinfo` 200, and
refuses to run while a render looks to be in flight.

```
.\revert_fa.ps1 -Status                 what is live: model, location, timing source, invariants, backups
.\revert_fa.ps1 -Level fa               forced alignment OFF - pins fa_timing's default to 'chirp'.
                                        No file restored; chirp_3 and the per-part metric stay.
                                        (OMNIVOICE_TIMING_SOURCE=chirp does the same with no edit.)
.\revert_fa.ps1 -Level chirp3           back to chirp_2 (restores chirp_timing.py)
.\revert_fa.ps1 -Level metric           restores chirp_wire.py - removes the per-part metric AND the
                                        fa wiring, since both live in that file
.\revert_fa.ps1 -Level all              both files restored, fa_timing.py moved aside
.\revert_fa.ps1 -Level all -WhatIf      print the plan, change nothing
```

`-Status`, `-Level all -WhatIf` and `-Level fa -WhatIf` were all run against the box and behave.

## Artefacts

On the box: `/tmp/_fa_bench_rescore.json`, `/tmp/_fa_bench_noguard.json`,
`/tmp/_fa_ab_faprim01_{chirp,fa,fa_then_chirp,chirp2_ref,chirp2_fa}.json`,
`/tmp/_fa_real_faprim01.json`, `/root/.omnivoice/dub_jobs/faprim01/pre_retime_segments.json`.
Copies of the JSON under `_fa_out/`. Harness scripts: `_fa_patch.py`, `_fa_apply.sh`,
`_fa_timing_new.py`, `_chirp3_probe.py`, `_fa_smoke.py`, `_fa_diag.py`, `_fa_diag2.py`,
`_fa_realrun.py`, `_fa_ab.py`, `_fa_bench.py`.
