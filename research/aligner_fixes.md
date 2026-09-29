# Two changes to `services/aligner.py`: the `per_line` window split, and MMS star tokens

2026-08-21, container `omnivoice` on the GPU box. Follow-up to
`research/english_timing_diagnosis.md` sections 4c and 10 (fixes 2 and 3), built on the pattern in
`research/fa_backwards_fix.md`: one file, anchored patch, real imports, both corpora, medians and
p95, and a decision that comes out of the measurement rather than out of the plan.

Two results:

* **the `per_line` bug is real and is fixed.** Through `retime_segments` itself, on the production
  45 s window, it is worth **+15.0 points** of well-placed lines (57.9 -> 72.9 mean over 14
  conditions, no condition worse). It changes **nothing** on the `fa` path - the bench reproduces
  the shipped column cell for cell, refusal for refusal. It also has **no caller in the live tree
  today**, which is stated plainly below rather than buried.
* **star tokens are ON by default**, from measurement: bench 66.8 -> **68.8** on the shipped
  cascade (66.6 -> 68.0 on `fa`-only), real video 75.5 -> 75.5, i.e. flat inside a 3.6-point
  standard error. The rule set at the top of the task was "on only if it wins on the bench mean
  AND does not lose outside noise on the real video". It wins the first and does not lose the
  second, so the flag defaults to `1`. The gain is small (net 11 lines of 560) and four conditions
  lose 2.5 points each; that is set out below too.

## What changed

One file. `/app/backend/services/aligner.py`, 24677 -> 29542 -> 29885 bytes:

| step | bytes | md5 | backup taken first |
|---|---|---|---|
| as found | 24677 | `780a852b430915e1d6dde2e86c1f235e` | - |
| split fix + star flag (default `0`) | 29542 | `7af928ceeeee983ac10d4d9fb179139a` | `aligner.py.prealign.20260821135204` |
| star default flipped to `1` | 29885 | `9b8ceef388a7ef73d5f32d93f93a7348` | `aligner.py.preflip.20260821145629` |

Ten anchors, each asserted to occur **exactly once** in the live file before anything was written;
the patch script exits non-zero and writes nothing if any anchor is not unique, if the file has
CRLF, or if the patched source's count of the string `leadin` changes. That last guard fired on
the first attempt - a comment of mine contained the word "leading" - and the write was refused,
which is what it is for. `services.aligner`, `services.chirp_wire`, `services.fa_timing`,
`services.lead_trim` were then IMPORTED for real, and `main` by its exit code (it logs to stderr
on import, so "printed nothing" is the wrong test - an over-strict version of that check rolled a
good patch back once). The app was never restarted and no render was in flight.

`services/chirp_wire.py` was **not touched** (a parallel task owns it). Byte counts and md5s of
`aligner.py`, `chirp_wire.py`, `fa_timing.py`, `chirp_timing.py` and `lead_trim.py` were snapshotted
into `/tmp/_al_snap/` before any work, and re-fingerprinted at every arm boundary. That mattered:
see "the parallel task" below.

### Job 1 - the split

`align_window` returns one entry per word it **kept**. `_tokenise` drops a word whose characters all
fall outside the 29-symbol MMS label set (a bare numeral, `(2)`, `11:35`), and `align_window` also
skips a word whose span list comes back empty. `per_line` split that list by each line's
**original** word count, so one dropped word handed every later line in the same window the wrong
words.

Two shapes were available. **The `per_line` fix was chosen, not the placeholder**, because a
placeholder changes what all six `align_window` call sites see and four of them would act on it:

| call site | what it does with the returned list | a placeholder would |
|---|---|---|
| `lead_trim.find_lead:114` | `first = got[0][1]` - the first entry's start is the lead to cut | take a placeholder's time as the lead and cut the wrong amount |
| `fa_timing._align:169` | median of all confidences, `min(q[1])`, `max(q[2])` | pollute the median and the span |
| `fa_timing._apply:205` | `if len(got) == len(out)` -> word-for-word, else proportional | flip to the word-for-word branch and write placeholder times |
| `chirp_wire:523` | median confidence of the whole list | pollute the quality metric every split decision reads |
| `chirp_wire:1384` | emits one output word per entry | emit placeholder words into the gap fill |
| `chirp_wire:1556` | same `len(got) == len(ng)` branch as `_apply` | same as `_apply` |
| `chirp_wire:1757` | gate `len(got) >= LINES_MIN_KEPT * len(toks)` | inflate the count and pass a gate it should fail |

So the placeholder is a change to the whole timing stage dressed up as a bug fix. The `per_line`
fix is confined to the one buggy function. `align_window` gained one **optional, keyword-only in
practice** return: `with_index=True` also returns each returned word's position in the input word
list. Every existing caller passes six positional arguments and sees exactly what it saw before -
proved, not asserted: with stars off, the patched `align_window` returns results **byte-identical**
to the pre-patch module loaded from the backup and run in the same process, on 12 individual lines
and on an 8-line window of 175 words (`_al_smoke.sh`).

One thing the diagnosis did not mention and the fix has to handle: the window is aligned as the
**romanised** join of its lines, so the split boundaries have to be romanised words too.
`bounds_of` romanises each line on its own and uses those counts, but only after checking that the
parts sum to the whole; when they do not it falls back to the original word counts and counts the
window as a mismatch. Over all 14 bench conditions and both window sizes, **`count_mismatch` was
0** - uroman preserved the word count on every one of these seven scripts - so the check is cheap
insurance rather than a live code path.

`SPLIT_STATS` (windows, windows where a word vanished, words vanished, count mismatches) is
exported for measurement. On the 45 s bench windows: 2-6 windows per condition contained a
vanishing word, 2-17 words per condition vanished, English 6 windows / 11 words, Gujarati 6 / 17.

### Job 2 - stars

MMS_FA's dict on this box is 29 symbols with `*` at id 28 (`_al_snap.txt`). With
`OMNIVOICE_ALIGN_STARS` on, `align_window` puts one star at each end of the **target** so audio the
transcript does not cover is absorbed by the star instead of dumped on the first and last real
word. `merge_tokens` returns one span per target token, so the star at the front takes exactly one
span (the walk starts at index 1) and the star at the back has its span never consumed at all: the
stars **cannot** reach a caller. That is the trap the diagnosis recorded - a star span touching the
window edge makes `fa_timing._plausible` refuse every line and silently collapses the cascade to
the recogniser's own numbers - and it is closed by construction, not by a filter. Checked directly:
with stars on, no returned span touches the window boundary, no returned word is `*`, and the word
sequence is unchanged (`_al_smoke.sh`).

| flag | default | what it does |
|---|---|---|
| `OMNIVOICE_ALIGN_STARS` | `1` | `1`/`0`. Star labels at both ends of the target in every `align_window` call. `0` restores the pre-patch target exactly. |

## Bench, all 14 conditions

`/root/bench` FLEURS corpus, 7 languages x clean/music, ground truth by construction, **cached**
recogniser responses - no Speech API call was made and nothing was re-billed. `/tmp/_fa_bench.py`
reused unmodified, one arm per process, well placed = start error inside -40/+120 ms, 40 lines per
condition, 560 per arm.

### Shipped cascade (`fa_then_chirp`), well placed %

| condition | shipped (recorded) | baseline (pre-patch) | split fix, stars off | split fix on the new `chirp_wire` | stars ON | deployed default |
|---|---|---|---|---|---|---|
| hi clean | 62.5 | 62.5 | 62.5 | 62.5 | **70.0** | 70.0 |
| hi music | 77.5 | 77.5 | 77.5 | 77.5 | 77.5 | 77.5 |
| te clean | 65.0 | 65.0 | 65.0 | 65.0 | **75.0** | 75.0 |
| te music | 65.0 | 65.0 | 65.0 | 65.0 | **70.0** | 70.0 |
| en clean | 55.0 | 55.0 | 55.0 | 55.0 | **60.0** | 60.0 |
| en music | 67.5 | 67.5 | 67.5 | 67.5 | *65.0* | 65.0 |
| ta clean | 75.0 | 75.0 | 75.0 | 75.0 | 75.0 | 75.0 |
| ta music | 72.5 | 72.5 | 72.5 | 72.5 | **80.0** | 80.0 |
| ml clean | 55.0 | 55.0 | 55.0 | 55.0 | 55.0 | 55.0 |
| ml music | 55.0 | 55.0 | 55.0 | 55.0 | **57.5** | 57.5 |
| kn clean | 65.0 | 65.0 | 65.0 | 65.0 | *62.5* | 62.5 |
| kn music | 67.5 | 67.5 | 67.5 | 67.5 | 67.5 | 67.5 |
| gu clean | 75.0 | 75.0 | 75.0 | 75.0 | *72.5* | 72.5 |
| gu music | 77.5 | 77.5 | 77.5 | 77.5 | *75.0* | 75.0 |
| **mean** | **66.8** | **66.8** | **66.8** | **66.8** | **68.8** | **68.8** |

The baseline column reproduces the shipped column cell for cell, so the harness measures the same
thing it measured before. The split-fix column is identical to the baseline column - **the bug fix
does not move the `fa` path at all**, which is what the task required before shipping it. The
"deployed default" column was re-run with **no environment variable set at all** after the default
was flipped, and reproduces the star arm exactly, so what is deployed is what was measured.

`fa`-only mode, same arms: baseline 60.0 / 75.0 / 65.0 / 70.0 / 55.0 / 67.5 / 77.5 / 75.0 / 52.5 /
52.5 / 67.5 / 67.5 / 72.5 / 75.0, mean **66.6**; stars 70.0 / 75.0 / 75.0 / 70.0 / 60.0 / 65.0 /
77.5 / 72.5 / 52.5 / 55.0 / 62.5 / 70.0 / 72.5 / 75.0, mean **68.0**.

Against the figures the diagnosis asked me to reproduce or refute, measured as a real patch instead
of an in-process monkey-patch: en/clean 55.0 -> 60.0 **reproduced**, hi/clean 60.0 -> 70.0
**reproduced** (`fa` mode), te/clean 65.0 -> 75.0 **reproduced**, hi/music and te/music unchanged
**reproduced**, en/music 67.5 -> 65.0 - the one regression - **reproduced**. Three losses the
diagnosis never saw, because it only ran en/hi/te: kn/clean, gu/clean and gu/music, -2.5 each.

### Medians and p95 |error|, ms, shipped cascade

| condition | baseline median | stars median | baseline p95 | stars p95 |
|---|---|---|---|---|
| hi clean | -18.1 | -9.8 | 1664.0 | 1558.1 |
| hi music | +5.7 | -1.2 | 157.1 | 140.6 |
| te clean | -21.8 | -16.1 | 1094.1 | **869.1** |
| te music | -0.7 | +3.5 | 1866.8 | **869.1** |
| en clean | +0.1 | +3.5 | 597.6 | 596.6 |
| en music | +0.0 | +0.0 | 629.6 | 628.6 |
| ta clean | +11.3 | +9.9 | 1760.4 | 1760.4 |
| ta music | +9.1 | +16.3 | 1534.7 | 1233.6 |
| ml clean | -21.1 | -21.1 | 1063.4 | 1063.4 |
| ml music | -17.2 | -17.2 | 1230.0 | 1230.0 |
| kn clean | +8.1 | +9.3 | 864.9 | *1261.6* |
| kn music | +0.0 | +0.0 | 3274.7 | 3274.7 |
| gu clean | +6.2 | +6.2 | 647.4 | *696.4* |
| gu music | -3.8 | +0.1 | 627.4 | *696.4* |

Medians were already tens of milliseconds and stay there. Nine p95 tails improve or hold, three get
worse (kn clean the only large one, +397 ms), and te music halves. This is the opposite shape to
the `back_mode=start` result in `fa_backwards_fix.md`, where every changed p95 blew out.

### Refusals and drift reversions, summed over 560 lines

| arm | mode | fa | hinted | chirp kept | drift lines / runs reverted | refusals |
|---|---|---|---|---|---|---|
| baseline | `fa_then_chirp` | 356 | 34 | 170 | **107 / 20** | `backwards 44, drift 107, conf 8, length 5, window 5, -7.3s 1` |
| split fix | `fa_then_chirp` | 356 | 34 | 170 | **107 / 20** | identical to baseline |
| split fix, new `chirp_wire` | `fa_then_chirp` | 356 | 34 | 170 | **107 / 20** | identical to baseline |
| stars ON | `fa_then_chirp` | 414 | 12 | 134 | **110 / 20** | `drift 110, conf 15, length 6, backwards 2, -7.9s 1` |
| baseline | `fa` | 365 | 0 | 195 | 98 / 18 | `backwards 61, drift 98, window 16, conf 11, length 6, +3 far-from-chirp` |
| stars ON | `fa` | 412 | 0 | 148 | 110 / 20 | `drift 110, conf 19, window 8, backwards 5, length 5, -7.9s 1` |

This is the mechanism, and it is the same one `fa_backwards_fix.md` diagnosed from the other side:
stars stop CTC dumping unmatched audio at the window edges, so spans stop touching the boundary and
stop looking like they start before the previous line ended. `backwards` 44 -> 2, `window` 5 -> 0,
lines placed by alignment 356 -> 414, lines kept on Chirp's times 170 -> 134.

**The drift guard is not the explanation this time.** Reversions are 107 -> 110 lines and 20 -> 20
runs; per condition:

| condition | baseline lines / runs | stars lines / runs |
|---|---|---|
| hi clean | 6 / 2 | 10 / 2 |
| te clean | 17 / 3 | 12 / 2 |
| ta clean | 11 / 3 | 14 / 4 |
| ml clean | 23 / 3 | 23 / 3 |
| ml music | 25 / 3 | 23 / 3 |
| kn clean | 3 / 1 | 6 / 2 |
| kn music | 8 / 2 | 7 / 1 |
| te music | 6 / 1 | 7 / 1 |
| ta music | 8 / 2 | 8 / 2 |
| hi/en/gu music, en/gu clean | 0 / 0 | 0 / 0 |

The diagnosis warned its cascade cells mixed two effects, and named te/clean reverting 12 lines and
hi/clean 10 in its star runs. Both are reproduced exactly (12 and 10) - and now the baseline
counts sit beside them (17 and 6), so the two effects are separable: te/clean gains 10 points
**with fewer** reversions, hi/clean gains 7.5 **with more**. Neither gain is a drift-guard artefact.

## The buggy path itself: `retime_segments`

`_fa_bench.py` never calls `retime_segments`, so job 1 needed its own harness
(`/tmp/_al_rt.py`, new): the ground-truth lines are the transcript, the "transcriber's" times are
chirp_3's mapped on by `chirp_timing.retime_by_words` from the same cached responses,
`retime_segments` is asked to refine them, and a line's placement is its decision if it got one and
the time it came in with otherwise - which is what production would do with it.

### Production window (45 s), chirp times

| condition | input | buggy | fixed | delta | stars ON | fixed median ms | fixed p95 ms | windows/words dropped |
|---|---|---|---|---|---|---|---|---|
| hi clean | 42.5 | 65.0 | **77.5** | +12.5 | 77.5 | -5.5 | 156.7 | 3 / 5 |
| hi music | 57.5 | 62.5 | **72.5** | +10.0 | 72.5 | -5.5 | 755.0 | 3 / 5 |
| te clean | 52.5 | 62.5 | **72.5** | +10.0 | 72.5 | +5.0 | 559.8 | 3 / 5 |
| te music | 62.5 | 62.5 | **75.0** | +12.5 | 75.0 | +5.0 | 550.1 | 3 / 5 |
| en clean | 52.5 | 47.5 | **57.5** | +10.0 | 57.5 | -3.5 | 692.0 | 6 / 11 |
| en music | 60.0 | 62.5 | 62.5 | 0.0 | 62.5 | +0.0 | 881.6 | 6 / 11 |
| ta clean | 60.0 | 60.0 | **87.5** | +27.5 | 87.5 | +18.0 | 1034.7 | 5 / 10 |
| ta music | 55.0 | 55.0 | **80.0** | +25.0 | 80.0 | +19.8 | 525.1 | 5 / 10 |
| ml clean | 40.0 | 70.0 | **77.5** | +7.5 | 77.5 | +4.3 | 98.4 | 2 / 2 |
| ml music | 52.5 | 67.5 | **75.0** | +7.5 | 75.0 | +5.7 | 98.4 | 2 / 2 |
| kn clean | 35.0 | 60.0 | **70.0** | +10.0 | 70.0 | +18.2 | 864.9 | 4 / 7 |
| kn music | 45.0 | 52.5 | **67.5** | +15.0 | 67.5 | +0.0 | 1349.8 | 4 / 7 |
| gu clean | 47.5 | 42.5 | **72.5** | +30.0 | 72.5 | +0.7 | 1163.6 | 6 / 17 |
| gu music | 40.0 | 40.0 | **72.5** | +32.5 | 72.5 | +1.0 | 1620.8 | 6 / 17 |
| **mean** | **50.2** | **57.9** | **72.9** | **+15.0** | **72.9** | | | |

Not one condition is worse and eleven are better by 7.5 points or more. Two things worth naming:
the buggy version was *below the times it was given* on en/clean (52.5 -> 47.5) and gu/clean
(47.5 -> 42.5) - i.e. refinement was destroying placements - and **stars change nothing at all on
this path** (identical in all 14 conditions, to 0.1 ms of median and p95). Stars only pay when the
window is much wider than the text, which is the wide/padded case, exactly as the diagnosis said.

### Whole-file window with true input times - the diagnosis's worst case

| condition | buggy | fixed | delta |
|---|---|---|---|
| hi clean | 42.5 | **87.5** | +45.0 |
| hi music | 55.0 | **87.5** | +32.5 |
| te clean | 77.5 | **92.5** | +15.0 |
| te music | 77.5 | **92.5** | +15.0 |
| en clean | 32.5 | **72.5** | +40.0 |
| en music | 5.0 | 7.5 | +2.5 |
| ta clean | 7.5 | *5.0* | -2.5 |
| ta music | 7.5 | *5.0* | -2.5 |
| ml clean | 45.0 | **90.0** | +45.0 |
| ml music | 55.0 | **95.0** | +40.0 |
| kn clean | 32.5 | **82.5** | +50.0 |
| kn music | 32.5 | **77.5** | +45.0 |
| gu clean | 35.0 | **85.0** | +50.0 |
| gu music | 32.5 | **85.0** | +52.5 |
| **mean** | **38.4** | **68.9** | **+30.5** |

Input is the true times here, so 100.0 is the ceiling and every point lost is damage done by
refining. en/music, ta/clean and ta/music are **not** the split bug: at whole-file scale the window's
median confidence is 0.01, the wide +/-30 s search fires, and `_coherent_shift` finds agreement on a
bogus -29.9 s block move for 37 of 40 lines. That is the wide-search artefact `aligner.py`'s own
docstring warns about, at a window size production never uses; the fix cannot help it and does not
claim to. The production-shaped table above is the one to read.

**One discarded arm, for honesty.** The first attempt at this whole-file table (`P2`) reported
100.0 in all 14 conditions with every line "kept" in about 1 s per condition - i.e. `align_window`
returning nothing at all. It ran while the parallel task held 5.4 GB of the T4, and whole-file
alignment needs far more memory than a 45 s window; re-run with the GPU free, the identical code
aligns normally and gives the table above. The arm was thrown away rather than reported. It is a
reminder that "everything was kept" is what a silently disabled aligner looks like.

## Real video

Job `faprim01` (760 s Hindi), timing stage only, re-run on the identical cached Gemini transcript
(`pre_retime_segments.json`, 148 lines) and identical cached chirp_3 word stream through
`/tmp/_fa_ab.py`, unmodified. Scored on the FINAL saved segments: each line's own source text
forced-aligned in its own slot, well = median per-word confidence >= 0.45, badly < 0.25.
n = 139 parts, so one standard error on a 76% proportion is **3.6 points**.

| arm | well | badly | median conf | well_parts | bad_parts | parts | dialogue | raw speech | span s | fa | hinted | chirp kept | drift lines/runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline, pre-patch tree | **76.3** | **12.2** | 0.657 | 78.4 | 10.8 | 139 | 85.3 | 89.0 | 633.4 | 20 | 16 | 82 | 20 / 3 |
| control: pre-patch aligner, new `chirp_wire` | 75.5 | 12.9 | 0.657 | 78.4 | 10.8 | 139 | 85.3 | 88.6 | 631.1 | 20 | 16 | 82 | 20 / 3 |
| split fix, stars off | 75.5 | 12.9 | 0.657 | 78.4 | 10.8 | 139 | 85.3 | 88.6 | 631.1 | 20 | 16 | 82 | 20 / 3 |
| split fix, **stars ON** (deployed) | 75.5 | **12.2** | 0.646 | 77.0 | 10.8 | 139 | 85.3 | 87.5 | 619.3 | 46 | 4 | 70 | **49 / 5** |

Refusals: baseline, control and stars-off are all
`backwards 40, drift 20, length 14, window 6, conf 1, no alignment 1` - byte-identical. Stars ON:
`drift 49, conf 9, length 7, backwards 3, window 1, collapsed 1`.

The baseline row reproduces the recorded row exactly (76.3 / 12.2 / `well_parts` 78.4 /
`bad_parts` 10.8 / dialogue 85.3 / the same refusal histogram), which is the evidence that the
harness measures the shipped pipeline.

**The 76.3 -> 75.5 step is not mine.** A parallel task rewrote `services/chirp_wire.py` at
14:04:37 UTC, between my stars-off and stars-on arms. The control arm - the **pre-patch** aligner
loaded from the backup and injected into an otherwise untouched process, harness not edited - gives
75.5 / 12.9 / 631.1 s on the new `chirp_wire`, identical to my stars-off arm in every field. So the
split fix changes literally nothing on the real video (as it must: see the next section), and the
0.8-point step belongs to the other change. Every arm's file fingerprints are in `_al_ph3.log`.

Stars on the real video: well placed identical (75.5), badly placed slightly better (12.9 -> 12.2),
`well_parts` slightly worse (78.4 -> 77.0), median confidence 0.657 -> 0.646, all far inside 3.6
points. The internals move a lot for that flat result - `backwards` 40 -> 3, blocks placed by
alignment 20 -> 46, blocks kept on Chirp 82 -> 70 - and **the drift guard picks up the slack: 20
lines in 3 runs -> 49 lines in 5 runs**. That is the same shape `fa_backwards_fix.md` found when it
freed the `backwards` bucket, and it is the thing to watch if the guard is ever loosened.

## The part that has to be said plainly: `retime_segments` has no caller

`grep -rn retime_segments /app --include='*.py'` finds its own definition and nothing else. The
live callers of `services.aligner` are `chirp_wire` (5 x `align_window`, plus `resolve_timeline`
and `breathe`), `fa_timing` and `lead_trim`; the pre-FA re-anchor path uses `chirp_wire._reanchor`,
which handles the count mismatch itself, and `fa_timing._apply` handles it explicitly too. So:

* the bug is real, the fix is right, and the +15.0 points is what the function does with it - but
  **the production effect today is zero**, because nothing calls the function. The bench proves
  that from the other side: the `fa` path is identical cell for cell.
* it matters the moment anything calls it again. Two of the three arms in the diagnosis's bake-off
  (D/E) went through it, so any future re-anchor experiment starts from a correct split instead of
  from a 15-to-30-point hole. That is worth 30 lines of code and it is why it was still shipped.
* `lead_trim`, the one `align_window` caller neither corpus exercises, has `ENABLED=False` in the
  deployed module, so stars cannot reach it. Forced on for a probe (34 constructed clips per
  language, known lead by construction) stars are inert there too: te median -4.3 ms / p95 78.5 ms
  and en -9.7 / 901.5 with stars off, identical with stars on; ta p95 160.9 -> 161.4 ms.

## Decision

**Job 1: shipped.** It is a bug, the direction is measured (+15.0 points on the production-shaped
window, +30.5 on the pathological one, nothing worse anywhere), and it provably does not move the
`fa` path - bench identical cell for cell and refusal for refusal, real video identical in every
field against a control that isolates the parallel task's change.

**Job 2: `OMNIVOICE_ALIGN_STARS` defaults to `1`.** Bench 66.8 -> 68.8 on the shipped cascade and
66.6 -> 68.0 on `fa`; real video flat. Read the size honestly: +2.0 points is **net 11 lines of
560** (15 net gains against 4 net losses across conditions; a sign test on those net counts gives
p ~ 0.02, and one standard error on the bench mean is itself about 2 points, so the paired,
same-lines nature of the comparison is doing the work here, not the sample size). Four conditions
lose 2.5 points each, including the en/music regression the diagnosis predicted. The reason to take
it anyway is that the mechanism is understood and visible in the refusal histogram - edge dumping
stops, `backwards` collapses from 44 to 2, 58 more lines get placed by alignment - and nothing
regressed on the real video. The reason it is a flag with a one-word off switch is that the margin
is thin: `OMNIVOICE_ALIGN_STARS=0` restores the pre-patch target with no edit and no revert.

What I would measure next, in order: (1) stars with the drift guard loosened, since the guard now
reverts 49 of 118 real blocks and `fa_primary_timing.md` already prices the guard at 6.4 bench
points; (2) why kn/clean and gu lose 2.5 points with stars - the only conditions where the p95 tail
also worsens; (3) whether anything should call `retime_segments` again now that it works.

## Invariants

Checked before the first write, after every write, and again at the end:

```
docker exec CT grep -c 'lead_in\|leadin\|sibilant\|_LEAD_IN' /app/backend/api/routers/dub_generate.py  -> 5
docker exec CT stat -c %s /app/backend/services/speech_rate.py                                         -> 13073
docker exec CT grep -c leadin /app/backend/services/aligner.py                                         -> 1
```

All three held throughout, and `/sysinfo` answers 200. The third is 1, not 0: `aligner.py` line 346
has always contained the word "leading" ("audio leading the picture") inside a docstring, and the
patch script refuses to write if that count changes at all - which is how the first attempt was
caught and refused. No identifier containing `leadin` was introduced. Only `services/aligner.py`
was written; the container was not recreated and the app was not restarted.

## How to revert

**A new script, `revert_alignsplit.ps1` + `_revert_alignsplit_tmpl.sh`.** Not `revert_aligner.ps1`,
which already exists and reverts the whole MMS timing stage - a much bigger hammer that would take
`fa_timing` and the rest with it. Not a new level in `revert_fa.ps1` either: that script owns the
forced-alignment-primary deployment and every level is pinned to that deployment's `.prefa` /
`.preback` stamps, none of which include `aligner.py`. Adding a third file and a third stamp to it
would make both scripts harder to reason about, so this one owns `aligner.py` and its `.prealign`
stamp alone. It follows the same pattern: `.prerevert.<utc>` backup first, real imports (plus
`main` by exit code), invariant re-check, app reload with `/sysinfo` 200 confirmed, refuses to run
mid-render, `-Status` and `-WhatIf`.

```
.\revert_alignsplit.ps1 -Status              signature, star default, whether per_line splits by
                                             position or by word count, invariants, backups
.\revert_alignsplit.ps1 -Level stars         star tokens OFF: pins the OMNIVOICE_ALIGN_STARS
                                             default to 0. No file restored, the bug fix stays.
                                             (OMNIVOICE_ALIGN_STARS=0 does the same with no edit.)
.\revert_alignsplit.ps1 -Level split         restores services/aligner.py from
                                             .prealign.20260821135204 - this puts the per_line
                                             window-split BUG back and removes the flag with it
.\revert_alignsplit.ps1 -Level all           the same as split: both changes live in one file
.\revert_alignsplit.ps1 -Level all -WhatIf   print the plan, change nothing
```

`-Status`, `-Level stars -WhatIf` and `-Level all -WhatIf` were all run against the box and behave.
Reach for `-Level stars` first - it is the reversible one, and it is the only one that does not
reintroduce a measured 15-to-30-point regression. Backups on the box:
`aligner.py.prealign.20260821135204` (the state before this work),
`aligner.py.preflip.20260821145629` (split fix with the star default still 0), and a redundant
`aligner.py.prealign.20260821135125` left by the attempt that was rolled back by the over-strict
import check - byte-identical to the first, and unused.

## Artefacts

On the box, staged in `/home/ubuntu/_al_out/` and copied to `_fa_out/` locally:

```
_al_bench_base.json  _al_bench_fix.json  _al_bench_fix2.json  _al_bench_star.json
_al_bench_default.json                       the deployed default, no env var set
_al_rt_base_w45.json  _al_rt_fix_w45.json  _al_rt_star_w45.json      45s window arms
_al_rt_base_full.json  _al_rt_fix_full2.json  _al_rt_fix_full3.json  whole-file arms
_al_rt_fix_full.json                         the DISCARDED arm (GPU contention), kept for the record
_fa_ab_faprim01_albase.json  _fa_ab_faprim01_alctl.json
_fa_ab_faprim01_alfix.json   _fa_ab_faprim01_alstar.json             real video
_al_lead.json                                lead_trim probe
_al_base.log  _al_post.log  _al_ph3.log  _al_ph4.log                 detached run logs
aligner_alignsplit.py                        the patched module as deployed (also
                                             _al_aligner_patched.py locally)
```

On the box, `/tmp/_al_snap/` holds the measured-against files. The final fingerprint re-run
refreshed it with the current copies, so the pre-work state is recorded there explicitly as
`MANIFEST_PREWORK.md5` plus `aligner.py.prework` (a copy of the `.prealign` backup); the
authoritative pre-state for the only file this task wrote is that backup.

Scripts (local, run through `rsh.ps1`): `_al_snap.sh` (fingerprints + the MMS dict),
`_al_read2.sh`, `_al_callers.sh` (the caller audit), `_al_mkrt.sh` (writes `/tmp/_al_rt.py`),
`_al_base_go.sh`, `_al_patch.sh` (the anchored patch), `_al_smoke.sh` (the identical-output proof),
`_al_post_go.sh`, `_al_ph3_go.sh` (controls), `_al_ph4_go.sh`, `_al_flip.sh` (the default flip),
`_al_tables.sh`, `_al_who.sh`, `_al_lead.sh`, `_al_poll.sh`, `_al_kill.sh`.
Harnesses reused unmodified: `/tmp/_fa_bench.py` (md5 `4147bde04f3fd9f4c38349569767135f`),
`/tmp/_fa_ab.py` (md5 `27b8f4b44a7f4532c4de595ddc0d1b11`). New harness: `/tmp/_al_rt.py`.

No Speech API call was made in any arm; every recogniser response came from `/root/bench/cache` or
the job's own cache. Nothing was re-billed and no new recognition pass is needed for anything above.
