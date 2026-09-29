# Manual CSV import and dub — job `5p113y7e`

Hand-authored transcript/translation imported verbatim and rendered. The user's instruction was
"use the timestamps and text blindly": no re-transcribe, no re-time, no chirp stage, no onset
snap, no gap fill. This records what was done, what was measured, and the four places where
something had to be decided rather than simply obeyed.

Date: 20 Aug 2026. Box: `<ip-address>`, container `omnivoice`, Tesla T4.

## 1. Job

| | |
|---|---|
| job id | **`5p113y7e`** (new; nothing existing was touched) |
| source | `csv files/FILE2-Translation-Telugu.merged.csv`, 168 rows, 6 speakers, 3.120–759.200 s |
| source / target | `hi` -> `te` |
| duration | 760.0 (as instructed; the media itself is 759.989125 s) |
| timing_source | `manual-csv-v1` |
| job dir | `/root/.omnivoice/dub_jobs/5p113y7e/` |
| media | `original.mp4`, `vocals.wav`, `no_vocals.wav`, `audio.wav`, `thumb.jpg` **copied** from `uyjpfb4k` |

Existing jobs verified unchanged after the whole run: `uyjpfb4k` (139 segs, 199 files),
`0r1xzjss` (87 segs), `u6u5vrjt` (5 segs). `dub_history` went from 16 rows to 17.

### Import fidelity

Segments `c000`..`c167` in start order, `start`/`end` the CSV floats, `text` = `target_text`,
`text_original` = `source_text`, `speaker_id` = `Speaker 1..6` from `SPK1..SPK6`,
`profile_id` = `auto:speaker_N`, `asr_confidence` = 1.0 (hand-authored, so nothing can gate on
a low score).

Checked by reading the row back out of `dub_history.job_data` and comparing to the CSV cells:

```
TIMESTAMP CHECK: 168 segments, worst start delta 0.000000000s, worst end delta 0.000000000s
TEXT CHECK: all 168 target texts and source texts identical to the CSV: yes
```

Re-checked **after** the render (the render rewrites `job["segments"]` — see deviation 2):

```
POST-RENDER timestamp check: worst start delta 0.000000000s, offenders=none
POST-RENDER text check: 0 line(s) differ from the CSV
job segments now: 168
```

## 2. Knobs

Read out of the source rather than assumed. `dub_generate.py` / `dub_core.py`:

| knob | real name | state | why |
|---|---|---|---|
| chirp timing | `OMNIVOICE_CHIRP_TIMING` | irrelevant | `chirp_wire` has **no call site in the render path** — its two hooks are in `dub_core`'s transcribe endpoints. Nothing was transcribed. |
| onset snap | `OMNIVOICE_CHIRP_SNAP_ONSET` | irrelevant | same module, same reason |
| gap cover | `OMNIVOICE_CHIRP_COVER_GAPS` | irrelevant | same module, same reason |
| lead trim | `OMNIVOICE_LEAD_TRIM` | **does not exist** | no such variable anywhere in the backend. `DUB_LEAD_MIN_S` drives `_attenuate_lead`, which *attenuates* the lead-in and never changes length. |
| front_silence | `OMNIVOICE_START_ON_TIME` | **ON** (default 1) | requested |
| head language | `OMNIVOICE_HEAD_LANG` | **ON** (default 1) | requested |
| underrun fill | `OMNIVOICE_UNDERRUN_MIN_RATE` (0.85) | **neutralised via `slot_fit="off"`** | see deviation 3 |

Render request:

```
timing_strategy = "strict_slot"      slot_fit = "off"        voice_match = "per_line"
language_code   = "te"               num_step = 16           guidance_scale = 2.0   speed = 1.0
segments        = all 168            regen_only = the 50 with start < 180.0
```

`strict_slot` was chosen because it is one of only two strategies that place audio at the CSV
value: both `strict_slot` and `concise` do `place_at = start`, while `smart_fit` and
`stretch_video` lay audio on **their own cursor** and persist a video-retime plan. `strict_slot`
additionally hands the engine the slot as its synthesis target duration, so a long line is
spoken faster rather than being generated at natural length and then having its tail cut, which
is what `concise` does.

## 3. Speaker references

All six speakers cloned from their own audio in `vocals.wav`, using the pipeline's own
`extract_speaker_clones`:

| speaker | CSV speech | reference | slices | ref transcript density |
|---|---|---|---|---|
| Speaker 1 (SPK1) | 172.2 s | 11.82 s | 3 | 14.0 chars/s |
| Speaker 2 (SPK2) | 111.2 s | 9.39 s | 4 | 13.5 chars/s |
| Speaker 3 (SPK3) | 42.0 s | 12.68 s | 5 | 13.9 chars/s |
| Speaker 4 (SPK4) | 165.8 s | 8.89 s | 2 | 9.8 chars/s |
| Speaker 5 (SPK5) | 46.1 s | 8.92 s | 2 | 10.8 chars/s |
| Speaker 6 (SPK6) | 12.7 s | 9.72 s | 4 | 11.9 chars/s |

`speaker voices: 6 of 6 speaker(s) cloned from the video`. No speaker uses the stock voice.
Reference densities sit at or below the ~14 chars/s natural Hindi rate, so no reference carries
a transcript longer than its audio — the leak bug class the brief warned about.

Per-line references were left to the render's own `ensure_segment_refs`:

```
segment refs: 152 of 168 line(s) have a reference of their own (90%) - was 0%,
rebuilt 63 reference(s), widened 89 short one(s)
```

16 lines cannot be their own reference. The reason is logged per line:
`cannot be its own reference (mixed-script:latn+deva)` — those rows' Hindi text mixes Latin
words with Devanagari, and `segref_defect` rejects a mixed-script reference transcript. Six of
them are in the rendered window (`c007 c034 c043 c045 c046 c047`); they fall back to their own
speaker's pooled clone, so they are still the right actor, just not that line's own delivery.

## 4. Render

50 lines (`c000`..`c049`, every row with `start < 180.0`), 789 s wall clock, 0 warnings,
0 errors. The other 118 rows were laid down as silence.

Of the two allowed automatic behaviours:

* **front_silence fired on 39 of 50 lines**, trimming 0.08–0.15 s of leading near-silence so the
  first syllable lands on the stated start.
* **head_language re-rendered 10 lines** that came back in the source language
  (`{'ok': 41, 'lead': 9, 'all_source': 4, 'unknown': 6, 'cut_s': 0.0, 'rerendered': 10}`).
  `cut_s: 0.0` — it re-rendered, it never cut, so no line lost audio to it.

## 5. Placement verification

Each rendered clip's 5 ms energy envelope cross-correlated against `dubbed_te.wav` over a
±2 s search window around the CSV start, then confirmed in the sample domain.

```
lines measured                50 of 50
median signed delta          +0.0 ms
P95 signed delta             +0.0 ms
max |delta|                   0.0 ms
lines off by more than 100 ms 0
local envelope correlation at the best lag   median 1.000, min 0.572
sample-domain correlation at the position    median 1.000, min 0.727
```

Every one of the 50 lines starts at exactly its CSV value. Nothing in the pipeline moved
anything.

Per-line table (delta in ms, `local_r` = properly normalised envelope correlation at the chosen
lag, `sample_r` = raw-sample correlation of clip against track at that position):

| id | csv start | delta | local_r | sample_r | | id | csv start | delta | local_r | sample_r |
|---|---|---|---|---|---|---|---|---|---|---|
| c000 | 3.120 | +0.0 | 1.000 | 1.000 | | c025 | 81.950 | +0.0 | 0.995 | 0.999 |
| c001 | 11.240 | +0.0 | 1.000 | 1.000 | | c026 | 85.350 | +0.0 | 0.999 | 1.000 |
| c002 | 13.050 | +0.0 | 1.000 | 1.000 | | c027 | 90.550 | +0.0 | 0.915 | 0.903 |
| c003 | 14.550 | +0.0 | 1.000 | 1.000 | | c028 | 93.100 | +0.0 | 0.572 | 0.727 |
| c004 | 16.950 | +0.0 | 1.000 | 1.000 | | c029 | 97.200 | +0.0 | 1.000 | 1.000 |
| c005 | 20.500 | +0.0 | 1.000 | 1.000 | | c030 | 101.650 | +0.0 | 1.000 | 1.000 |
| c006 | 22.150 | +0.0 | 0.998 | 0.892 | | c031 | 106.050 | +0.0 | 1.000 | 1.000 |
| c007 | 24.250 | +0.0 | 1.000 | 1.000 | | c032 | 109.950 | +0.0 | 1.000 | 1.000 |
| c008 | 28.020 | +0.0 | 1.000 | 1.000 | | c033 | 112.500 | +0.0 | 1.000 | 1.000 |
| c009 | 29.800 | +0.0 | 1.000 | 1.000 | | c034 | 114.200 | +0.0 | 0.997 | 0.997 |
| c010 | 34.350 | +0.0 | 1.000 | 1.000 | | c035 | 116.200 | +0.0 | 1.000 | 1.000 |
| c011 | 39.250 | +0.0 | 1.000 | 1.000 | | c036 | 118.000 | +0.0 | 1.000 | 1.000 |
| c012 | 44.100 | +0.0 | 1.000 | 1.000 | | c037 | 125.100 | +0.0 | 1.000 | 1.000 |
| c013 | 46.950 | +0.0 | 1.000 | 1.000 | | c038 | 130.200 | +0.0 | 1.000 | 1.000 |
| c014 | 49.350 | +0.0 | 1.000 | 1.000 | | c039 | 135.650 | +0.0 | 1.000 | 1.000 |
| c015 | 52.300 | +0.0 | 0.991 | 0.998 | | c040 | 140.350 | +0.0 | 1.000 | 1.000 |
| c016 | 54.050 | +0.0 | 1.000 | 1.000 | | c041 | 147.350 | +0.0 | 1.000 | 1.000 |
| c017 | 55.750 | +0.0 | 0.998 | 1.000 | | c042 | 150.200 | +0.0 | 1.000 | 1.000 |
| c018 | 62.200 | +0.0 | 1.000 | 1.000 | | c043 | 153.000 | +0.0 | 1.000 | 1.000 |
| c019 | 64.650 | +0.0 | 0.999 | 0.998 | | c044 | 156.650 | +0.0 | 1.000 | 1.000 |
| c020 | 67.250 | +0.0 | 1.000 | 1.000 | | c045 | 159.350 | +0.0 | 1.000 | 1.000 |
| c021 | 69.950 | +0.0 | 1.000 | 1.000 | | c046 | 163.950 | +0.0 | 1.000 | 1.000 |
| c022 | 72.450 | +0.0 | 1.000 | 1.000 | | c047 | 168.350 | +0.0 | 1.000 | 1.000 |
| c023 | 76.950 | +0.0 | 1.000 | 1.000 | | c048 | 171.650 | +0.0 | 1.000 | 1.000 |
| c024 | 79.250 | +0.0 | 1.000 | 1.000 | | c049 | 177.950 | +0.0 | 1.000 | 1.000 |

**Note on the two sub-1.0 rows, `c027` and `c028`.** Not a placement error. The CSV deliberately
overlaps them — `c027` runs to 94.200 while `c028` starts at 93.100, a 1.100 s overlap — so in
those 1.1 s the track holds the sum of two speakers. Residual analysis confirms it: subtracting
`c028`'s own clip from the track at its position leaves −17.1 dB of *other* audio, against
−83 dB for a clean line like `c000`. The other CSV overlap (`c133`/`c134`, 1.300 s at 602–603 s)
is outside this render. Both overlaps were kept exactly as authored.

`c006`'s 0.892 was an artefact of my own probe quantising the position to the 5 ms envelope grid;
its residual against the track is −63.8 dB, i.e. the same audio.

**One correction to my own first pass, recorded so it is not repeated.** The first placement
script normalised the correlation by the norm of the whole search window instead of the
overlapping slice, so it reported peaks of 0.27–0.50 and flagged 34 "low-confidence" lines. The
argmax — the number the placement result rests on — was unaffected, but the confidence figures
were meaningless. `_m13_corr.py` recomputes them locally; the real median is 1.000.

## 6. Fit and stretch

There is **no time-stretching in this configuration at all**, by design: `slot_fit="off"` turns
off the mix loop's atempo resize in both directions, and in `strict_slot` the compression branch
is unreachable anyway (the generation loop has already clamped the clip to the slot, so
`wl > slot_samples` can never hold). Fitting is done at synthesis time by the duration
conditioning, and whatever still overruns is hard-trimmed at the slot edge.

Measured over the 50 rendered lines:

| | |
|---|---|
| clips filling their whole slot (engine hit the ceiling) | **31 of 50** |
| ...of which the last 25 ms is still loud, i.e. **cut mid-speech** | **15 of 50 (30%)** |
| lines using under 70% of their slot | 5 |
| slot fill ratio | median 1.00, min 0.45, max 1.00 |
| the app's own `fit_status` | `{'fits': 50}` — uninformative here, see below |

The 15 truncated lines, worst first by how loud the audio still was at the cut:
`c025 (3.25 s), c034 (0.90), c015 (1.58), c017 (2.15), c026 (5.05), c019 (2.45), c040 (6.85),
c043 (3.50), c047 (3.15), c016 (1.57), c021 (2.35), c027 (3.65), c009 (4.40), c006 (1.95),
c010 (4.77)`.

Two things worth flagging:

* **The app's `fit_status` badge reads `fits` for all 50 and is wrong-by-omission.** With
  `slot_fit="off"` the `strict_slot` branch appends `{"status": "fits"}` unconditionally, because
  the clip was clamped upstream and the mix loop can no longer see that anything overran. The
  measurement above supersedes it.
* **Text density under-predicts the problem.** By the validator's own proxy (Telugu 14.0 chars/s)
  only 8 of these 50 lines (16.0%) need more than the natural rate — worst `c016` at 1.50x —
  yet 31 filled their slot completely and 15 were cut. That is the +40% p90 error in the
  chars-per-second table showing up on real audio, and it is the reason to trust the rendered
  lengths over the character count.

`sync_ratio` (clip length / slot) over the 50: min 0.449, median 1.000, max 1.000; 31 at exactly
1.000; 5 below 0.70 (lines that finish early and leave the slot's tail silent — left alone,
because filling it would be the underrun behaviour the brief rules out).

## 7. Output

| | |
|---|---|
| dub track | `/root/.omnivoice/dub_jobs/5p113y7e/dubbed_te.wav` (760.000 s, 24 kHz mono, 36.5 MB) |
| full exported video | `/root/.omnivoice/dub_jobs/5p113y7e/exports/dubbed_video_20260820T094501-cc7da2f6.mp4` (52,948,999 bytes) |
| 3-minute cut on the box | `/tmp/first3min_5p113y7e.mp4` (11,952,672 bytes, exactly 180.000 s) |
| local copy | `c:\video translator\_incoming\FILE2_manual_csv_te_first3min_5p113y7e.mp4` |

Exported through the app's own `GET /dub/download/{job}?preserve_bg=true&default_track=te`, so
the music/effects bed is the same `no_vocals.wav` mix production uses. `fit_plans` and
`video_stretch_plans` are both absent on the job, which is the check that the **video was not
retimed** — the export stream-copied it and only the first-180 s cut re-encoded.

## 8. Deviations from "use it blindly", and why

1. **Reference transcripts were fed the source text, not the CSV's `text`.** `extract_speaker_clones`
   reads `seg["text"]` for its reference transcript, which is correct in the normal pipeline
   because it runs *before* translation. Here `text` is Telugu while the reference audio is
   Hindi. Handing it the CSV as-is would pair Hindi audio with a Telugu transcript — the exact
   (audio, ref_text) mismatch that causes source-language leakage. It was given a shadow copy of
   the segment list with `text = text_original`. Nothing in the job itself was altered.

2. **All 168 segments are sent on every render, with `regen_only` naming the 50 to render.**
   `_sync_job_segments` rebuilds `job["segments"]` from the request, so sending only the 50
   in-window rows would have silently truncated the imported job from 168 rows to 50. Segments
   outside the allow-list have no cached WAV and are laid down as silence, which is exactly the
   requested "first three minutes only". Verified after the render: still 168 rows, still
   bit-identical to the CSV.

3. **The underrun fill was switched off, via `slot_fit="off"`.** `OMNIVOICE_UNDERRUN_MIN_RATE`
   defaults to 0.85 and is live in the server, and in `strict_slot` the fill is reachable: a line
   that finishes early gets slowed toward its slot. That is an automatic audio change outside the
   two the brief allows, so it was disabled. `slot_fit="off"` was the lever because it gates both
   the fill and the compression branch, and needs no restart.

4. **Env vars could not be set on the render process.** The render runs inside the already-running
   uvicorn process; container env is fixed at create time and changing it means `docker rm`, which
   would destroy the writable layer holding every patch. Instead the four knobs were resolved by
   reading the source: `OMNIVOICE_LEAD_TRIM` does not exist, and the three chirp knobs have no
   call site in the render path (`grep` for `chirp|retime_job|snap_segment_starts|onset_align` in
   `dub_generate.py` returns nothing). They are still `1` in the live process and still could not
   have run. `START_ON_TIME` and `HEAD_LANG` default to on, which is what was wanted.

5. **`duration` was set to 760.0 as instructed**, though the media is 759.989125 s. An 11 ms
   difference; it only affects the tail slack given to the final segment.

Not a deviation, but worth stating: the **two CSV overlaps were preserved**, so at 93.1–94.2 s
two speakers talk over each other in the dub exactly as the CSV specifies.

## 9. Honest weaknesses

* 15 of 50 lines (30%) are cut mid-speech at the slot edge. That is the direct cost of holding
  the user's `end` values with no compression: those lines' last syllables are not in the dub.
  The alternatives all break a stated rule — compressing needs `smart_fit` (which retimes the
  timeline) or the mix-loop atempo (unreachable under `strict_slot`), and letting them run over
  needs `concise` with an overflow budget, which bleeds into the next line's start.
* 6 of the 50 lines use their speaker's pooled clone rather than their own delivery, because
  their source text is mixed-script. Fixable only by relaxing `segref_defect`, which was not
  touched.
* Verification covers placement, fit and voice source. It says nothing about whether the Telugu
  is intelligible at the compressed rate on the 31 lines that filled their slot — that needs a
  listen.

## 10. Invariants

Checked before, during and after. Unchanged throughout:

```
grep -c 'lead_in\|leadin\|sibilant\|_LEAD_IN' /app/backend/api/routers/dub_generate.py  ->  5
stat -c %s /app/backend/services/speech_rate.py                                        ->  13073
```

No file under `/app/backend` was edited. Everything was achieved through request parameters.

## 11. Scripts

Host: `_m7_import.py` (import + clones), `_m9_render.py` (render driver),
`_m11_verify.py` (placement/fit/voice), `_m13_corr.py` (refined correlation),
`_m11_sum.py` (SSE summary). Runners: `_m7_run.sh`, `_m9_start.sh`, `_m10_poll.sh`,
`_m11_run.sh`, `_m12_export.sh`, `_m13_run.sh`, `_m14_fetch.sh`, `_m15_final.sh`.
Logs on the box: `/tmp/render_5p113y7e.jsonl`, `/tmp/verify_5p113y7e.json`,
`/tmp/export_5p113y7e.log`.

To render the remaining 118 lines: same request, `regen_only` = the ids with `start >= 180.0`
(the first 50 then reuse their cached `seg_te_*.wav`).
