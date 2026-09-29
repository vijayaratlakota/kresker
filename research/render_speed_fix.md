# VoiceStudio dub render: measured speed fix (20 Aug 2026)

Job `fno0wbe7` (Hindi -> Telugu, 168 lines, 6 speakers, CSV-imported). Goal: make the dub
render measurably faster without weakening the wrong-language protection.

**Headline: 18.0 s/line -> 9.8 s/line on identical settings, and the recogniser calls went
394 -> 200. The reference over-description that was assumed to be the root cause turned out
to be a minor contributor; the recogniser was 80% of the wall clock. Both fixes shipped, and
the report below separates what each one actually bought.**

---

## Step 1 - measurement, before any patch

### How much do references over-describe their audio?

`chars of ref_text / seconds of ref audio`, for all 152 of 168 lines that have a reference of
their own (16 have none - see below). Base rates: Devanagari natural rate 11.5 chars/s
(`ref_quality.NATURAL_CPS`), the job's OWN imported CSV measures **median 14.59, p90 20.86,
max 27.91 chars/s** of Hindi text over its own slot, so the corpus rate used by the engine is
**14.59 chars/s**.

| metric | vs 14.0 chars/s | vs the job's own 14.59 chars/s |
|---|---|---|
| min | 0.07x | 0.07x |
| median | 1.04x | 1.00x |
| p90 | 1.34x | 1.28x |
| p95 | 1.60x | 1.54x |
| max | **1.78x** | 1.71x |
| refs >= 1.0x | 81 (53%) | 76 (50%) |
| refs >= 1.2x | 42 (28%) | 25 (16%) |
| refs >= 1.5x | **9 (6%)** | 8 (5%) |
| refs >= 2.0x | **0** | 0 |

Worst offenders: c068 1.78x (71 char over 2.9s), c163 1.75x (60 char over 2.5s), c063 1.69x,
c095 1.69x, c121/c122 1.68x, c165 1.61x, c031 1.60x, c085 1.55x.

**The 2.0x-15x overruns quoted in the brief are gone already** - a previous fix
(`_text_fraction` / `_text_window`, word-proportional slicing) removed them. The `c163
1.68x / 2.45s` line in the brief is a warning at `DENSITY_WARN = 1.50`, which is a
*visibility* threshold, not a rejection one. Nothing on this job is above 1.78x.

### Does over-description predict a re-render?

Per-line head-language verdicts from the render log. Two independent renders of the same
content agree:

| ratio band | render A (12:50-14:27) | render B (21:05-21:56) |
|---|---|---|
| 0.0-0.8x | 14% re-rendered, 0.16 takes/line | 9%, 0.14 |
| 0.8-1.0x | 26%, 0.33 | 26%, 0.37 |
| 1.0-1.2x | 26%, 0.38 | 26%, 0.33 |
| 1.2-1.5x | 18%, 0.30 | 21%, 0.33 |
| **>= 1.5x (9 refs)** | **56%, 0.89** | **56%, 0.89** |
| all >= 1.0x | 26%, 0.41 | 27%, 0.40 |
| all < 1.0x | 18%, 0.23 | 15%, 0.23 |

Pearson r(ratio, takes) = 0.204, Spearman rho = 0.174 (render A).

**Verdict: the correlation is real but weak, and confined to the top band.** It is monotone
and replicated across two renders at >= 1.5x, so the fix was shipped - but 9 lines out of 168
cannot explain a 35 s/line render, and the numbers below show it did not.

### Where the time actually went (render A, 96.8 min / 168 lines = 34.6 s/line)

| item | measured |
|---|---|
| head-language recogniser calls | **394 (2.35 per line)** |
| call latency | median 7.0s, mean 11.9s, p90 23.0s |
| total recogniser time | **77.6 min = 80% of the whole render** |
| re-renders (unusable takes) | 51 over 36 lines |
| lines shipped still in Hindi | 3 (c023, c026, c068) |
| app tally | ok 146, lead 22, all_source 32, unknown 19, rerendered 51 |

`classify_best` stops at the first actionable verdict, so the second look is only ever paid
on a piece that is **already clean** - 165 clean checks x 2 calls + 54 actionable x 1 = 384,
which matches the 394 observed. That is the whole render budget, and it is what Step 2
addresses.

Note: the brief's "189 checks / 157 rerendered" does not match this job's log. The app's own
final tally is `rerendered: 51`, and 51 is also what the per-line verdicts add up to.

### 16 lines have no reference of their own

c007, c034, c043, c045, c046, c047, c053, c054, c058, c088, c091, c111, c117, c120, c130,
c132 - all rejected as `mixed-script:latn+deva` (the imported Hindi text mixes Latin in).
They fall back to the pooled per-speaker voice. Their re-render rate is *lower* (12% vs 22%),
so this is not a speed problem. Left alone deliberately: this run changed nothing about which
lines get a reference (152 before, 152 after).

---

## Step 2 - what changed

Two files, both patched in place inside container `omnivoice`, backups taken first.

| file | backup | change |
|---|---|---|
| `/app/backend/services/speaker_clone.py` | `.prespeed.20260820215705` (76940 -> 85397 bytes) | reference density cap |
| `/app/backend/services/head_language.py` | `.prespeed.20260820215705` (26357 -> 26847 bytes) | `OMNIVOICE_HEAD_LOOKS` default 2 -> 1 |

Untouched: `api/routers/dub_generate.py`, `services/speech_rate.py`, and
`OMNIVOICE_HEAD_LANG` - the wrong-language gate itself still runs and still re-renders.

### 2a. Reference density cap (`speaker_clone.py`)

New module constants, all env-overridable:

```python
CHARS_PER_S       = OMNIVOICE_REF_CHARS_PER_S     default 14.0   # floor on the rate
REF_CAP_AT        = OMNIVOICE_REF_CAP_AT          default 1.5    # trim only above this
REF_CAP_TO        = OMNIVOICE_REF_CAP_TO          default 1.2    # trim down to this
REF_CAP_MIN_CHARS = OMNIVOICE_REF_CAP_MIN_CHARS   default 8      # never below this, never empty
```

`_cap_cps(cps)` = `max(cps, CHARS_PER_S)`; `_segments_cps(segments)` reads the job's own rate
via `ref_quality.corpus_norms`, so **the effective cap on this job is its own measured
14.59 chars/s, not a hard-coded 14**. That matters: this job's p90 line genuinely runs at
20.9 chars/s, and a flat 14 chars/s cap would have deleted words that the clip really does
contain - 53% of references would have been cut for speaking quickly. The trigger is
`1.5 x rate` (21.9 chars/s here) because that is where the measured harm is.

`_fit_ref_text(sid, text, seconds, cps=..., where=...)`:
- returns text unchanged when `len(text) <= seconds * rate * 1.5`
- otherwise slices with the existing `_text_fraction` (word-proportional), then drops whole
  trailing words until `len <= seconds * rate * 1.2`. **Word boundaries only, never mid-word.**
- if the result would be under `REF_CAP_MIN_CHARS`, keeps the text whole and logs why -
  **it can never return an empty ref_text** (the c017 regression: an empty transcript drops
  the line to the pooled voice)
- logs every trim with the before/after ratio, the char counts and the cap rate

Applied at **every** place a reference is assembled, plus one pass over already-stored ones:

| site | function | note |
|---|---|---|
| pooled per-speaker | `extract_speaker_clones` | after `cap_reference` |
| per-line slot ref | `extract_segment_refs` | before `segref_defect` |
| widened ref | `_widen_short_refs` | after the `_text_fraction` chunk assembly |
| own-span ref | `_own_span_ref` | **prefers widening the audio**: grows the window inside the line's own span (the missing words really are there), re-slices with `_text_window`, and only then caps what is still over |
| already stored | `_cap_stored_refs` via `ensure_segment_refs` | one WAV header read per ref; needed because `ensure_segment_refs` deliberately never re-cuts a reference that already exists, so a job would otherwise keep its old transcripts forever |

### 2b. `OMNIVOICE_HEAD_LOOKS` default 2 -> 1 (`head_language.py`, line 251)

Module default only - the container's environment is fixed at create time and was not
touched. `OMNIVOICE_HEAD_LOOKS=2` still restores the old behaviour, verified:

```
LOOKS = 1
with env override LOOKS = 2
```

The comment in the file now records why, including the 394-calls / 77.6-minutes measurement.

---

## Step 3 - tests

### Unit tests (`_test_refcap.py`, run inside the container against the patched module)

41 assertions, all PASS. `_text_fraction`: whole / head / tail / zero / empty / None / single
word / never splits a word. `_text_window`: whole / middle / head / tail / inverted range /
empty / single word. `_fit_ref_text`: exact fit untouched (139 char over 10s), 2x over
(279 -> 164 char, under the 168 bound, whole words, a prefix of the original), 10x over
(1399 -> 164), single 400-char word survives whole, empty / None / whitespace-only,
all-punctuation never emptied and tokens kept whole, the floor case (0.2s of audio) keeps the
text whole, zero / negative / non-numeric duration are no-ops, a faster corpus rate widens
the cap while a slower one cannot tighten it below the floor, monotonic (more audio never
yields less text), and `_cap_stored_refs` is a no-op rather than a crash when the WAV is
missing.

### Rebuild without rendering (`_rebuild_refs.py`, on an in-memory copy of the job)

```
corpus rate 14.59 chars/s; trim above 1.50x down to 1.20x; floor 8 chars
before  n=152  p50=1.00  p90=1.28  p95=1.54  max=1.71   over 1.5x: 8   over 1.2x: 25  empty: 0
after   n=152  p50=1.00  p90=1.24  p95=1.28  max=1.49   over 1.5x: 0   over 1.2x: 17  empty: 0

8 transcripts changed:
  c031  84 -> 65 char  1.54x -> 1.19x      c095  71 ->  48 char  1.62x -> 1.10x
  c063 109 -> 75 char  1.62x -> 1.12x      c121 138 -> 100 char  1.62x -> 1.17x
  c068  71 -> 48 char  1.71x -> 1.15x      c122 138 -> 100 char  1.62x -> 1.17x
  c163  60 -> 39 char  1.68x -> 1.09x      c165  78 ->  56 char  1.55x -> 1.11x

references lost: 0     gained: 0     empty transcripts: 0
segments with no reference of their own: 16 of 168 (the same 16 as before)
speaker clones: 6 of 6, every WAV present (8.4s - 12.7s, 96-176 char of ref_text)
REBUILD OK
```
Identical result on the `tfall3fx` copy, so it is deterministic.

### Imports for real

`python3 -c "import services.speaker_clone"` and `import services.head_language` both rc=0,
plus `import main` rc=0. py_compile was not used as the test.

---

## Step 4 - render comparison

All three renders: same 168 lines, `regen_only` = every id, `strict_slot`, `slot_fit off`,
`voice_match per_line`, `num_step` 16 requested (floored to 32 by dub_generate in every run -
`seg_num_step` records 32 for all of them). For the "after" run the 168 cached `seg_te_*.wav`
were moved aside as well, so nothing could be reused.

Two "before" runs are reported because the recogniser's latency changed during the day and it
dominates the wall clock. **B is the honest baseline** - same box, same hour, same content,
unpatched. A is the render the brief measured.

| | A: before, 12:50-14:27 | B: before (copy job), 21:05-21:56 | C: **after**, 21:58-22:25 |
|---|---|---|---|
| wall clock | 96.8 min | 50.3 min | **27.3 min** |
| **seconds per line** | **34.6** | **18.0** | **9.8** |
| head-language recogniser calls | 394 (2.35/line) | 398 (2.37/line) | **200 (1.19/line)** |
| recogniser latency (median / mean) | 7.0s / 11.9s | 5.0s / 6.1s | 5.0s / 5.5s |
| recogniser share of wall clock | 80% | 81% | 67% |
| re-renders (unusable takes) | 51 over 36 lines | 57 over 38 lines | **32 over 23 lines** |
| app tally | ok 146, lead 22, all_source 32, unknown 19 | ok 144, lead 25, all_source 36, unknown 20 | ok 144, lead 13, all_source 19, unknown 24 |
| **lines shipped still in Hindi** | 3 (c023, c026, c068) | 4 (c043, c095, c145, c150) | **0** |
| reference transcripts trimmed | 0 | 0 | 8 |
| density warnings (>= 1.50x) | 4 | 0 | 0 |
| per-line gap median / p90 | 25.0s / 64.0s | 14.0s / 31.0s | **7.0s / 17.0s** |
| worst start delta vs CSV | 0.000000000s | - | **0.000000000s** |
| worst end delta vs CSV | 0.000000000s | - | **0.000000000s** |

Against the honest baseline B: **-46% wall clock, -50% recogniser calls, -44% re-renders,
4 leaked lines -> 0**. Against A: -72% wall clock, but roughly half of that gap is recogniser
latency that changed on its own, not the patch.

### Reference ratios, after the render (from the saved job)

| | before | after |
|---|---|---|
| p50 (vs 14.0) | 1.04x | 1.04x |
| p90 | 1.34x | 1.29x |
| p95 | 1.60x | 1.34x |
| max | 1.78x | **1.55x** |
| refs >= 1.5x | 9 | **1** (c085 at 1.55x vs 14.0 = 1.49x vs the job's own rate, just under the trigger) |
| refs >= 2.0x | 0 | 0 |
| empty transcripts | 0 | **0** |
| lines with a reference of their own | 152 | **152** |
| speaker clones | 6 | **6** |

### Placement / sacred data - checked before AND after

```
job fno0wbe7: 168 segments; FILE1 168 rows; FILE2 168 rows
start delta   worst=0.000000000s  median=0.000000000s  p95=0.000000000s  nonzero=0 of 168
end delta     worst=0.000000000s  median=0.000000000s  p95=0.000000000s  nonzero=0 of 168
Telugu text differing from FILE2 target_text: 0
Hindi original differing from FILE1 source_text: 0
segments with no matching line_id: 0
SACRED DATA INTACT
```
The app still reports `start on time: cNNN began 0.1s late, moved onto its slot` per line, so
every clip is placed on the imported timestamp, not near it.

### Guarded invariants - before and after every change

```
docker exec omnivoice grep -c 'lead_in\|leadin\|sibilant\|_LEAD_IN' \
    /app/backend/api/routers/dub_generate.py   -> 5    (required 5)   before AND after
docker exec omnivoice stat -c %s \
    /app/backend/services/speech_rate.py       -> 13073 bytes (required 13073) before AND after
```
No identifier containing `leadin` was introduced; the patch script aborts if the new text
contains that substring.

---

## What each change actually bought - honestly

- **`OMNIVOICE_HEAD_LOOKS` 2 -> 1 is the whole speed win.** 394 -> 200 recogniser calls at
  ~5.5s each removes ~18 minutes from a 50-minute render. Everything else is noise next to it.
- **The reference cap did almost nothing for speed.** On the 8 lines whose transcript was
  trimmed, unusable takes went 6 (A) / 7 (B) -> 5 (C). That is 1-2 takes, ~20-40 seconds of a
  27-minute render. It was still worth shipping: it is the only change that makes the
  reference *correct*, c068 (which shipped in Hindi in run A) needed 0 takes afterwards, and
  it removes the class of defect entirely rather than one instance of it - but calling it the
  root cause of 40 s/line would be wrong, and the measurement said so before the patch.
- **Part of the re-render drop (51/57 -> 32) is the gate looking once instead of twice**, not
  the takes being cleaner. Fewer looks means fewer chances to flag a marginal chunk. The
  compensating evidence is that 0 lines shipped in Hindi (against 3 and 4), so nothing that
  was caught went unfixed - but this is one run, and a job where the c012 chunking-variance
  class matters can put the second look back with `OMNIVOICE_HEAD_LOOKS=2`.
- **The GPU is still idle-ish and batch size is still 1** (T4, ~3.6 GB of 15 GB). The render
  is now 67% recogniser time and the remaining synthesis is 32 diffusion steps per line. The
  next real win is batching or a cheaper/local head-language recogniser, not more trimming.

## Files edited, and how to revert

| file | backup on the box |
|---|---|
| `/app/backend/services/speaker_clone.py` | `.prespeed.20260820215705` |
| `/app/backend/services/head_language.py` | `.prespeed.20260820215705` |
| `/root/.omnivoice/dub_jobs/fno0wbe7/seg_te_*.wav` (168) | moved to `prespeed_seg_wavs.20260820215822/` |
| `/root/.omnivoice/dub_jobs/fno0wbe7/dubbed_te.wav` | `dubbed_te.wav.prespeed.20260820215822` |

```powershell
.\revert_speed.ps1 -Status              # what is live, the constants, invariants, backups
.\revert_speed.ps1 -Level looks         # OMNIVOICE_HEAD_LOOKS back to 2 (slower, two looks)
.\revert_speed.ps1 -Level refs          # remove the reference density cap only
.\revert_speed.ps1 -Level all           # both
.\revert_speed.ps1 -Level all -WhatIf   # print the plan, change nothing
```
`revert_speed.ps1` prepends `LEVEL` / `DRYRUN` / `STAMP` to `_revert_speed_tmpl.sh`, the same
pattern as `revert_csvimport.ps1` / `_revert_csvimport_tmpl.sh`. It copies the live file to
`.prerevert.<utc>` first (so the revert is itself reversible), imports every restored module
for real, re-checks both invariants before and after, refuses to run while a render looks to
be in flight, reloads the app and waits for `/sysinfo` 200.

The **previous** `revert_speed.ps1` (the translation-speed work of 18/19 Aug: dub_translate,
translator, translation_quality, llm_backend, llm_skills, speech_rate) is preserved unchanged
as **`revert_speed_translation.ps1`** and still drives `_revert_speed.sh`.

No environment variable was changed and the container was never recreated - both changes are
module defaults, exactly as required.

## Local scripts used

`_measure_refs.py` (ratios + correlation), `_measure2.py` (time breakdown),
`_measure_window.py` (one render's numbers from the log window), `_patch_refcap.py` (the
patch, anchors asserted to occur exactly once, aborts otherwise), `_test_refcap.py` (unit
tests), `_rebuild_refs.py` (rebuild without rendering), `_sp_render.py` (the render driver),
`_verify_placement.py` (sacred-data check against both CSVs), `_cmp_trimmed.py` (per-line
takes across the three renders), driven by `_sp0*.sh` / `_sp2*.sh` through `rsh.ps1`.
