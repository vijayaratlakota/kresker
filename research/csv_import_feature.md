# CSV import in the live app — user-supplied transcript and translation

The Transcribe and Translate stages can now be replaced by two file uploads. Everything
downstream (voice clones, Generate Dub, render, export) is the existing pipeline, unchanged.

Date: 20 Aug 2026. Box `<ip-address>`, container `omnivoice`, Tesla T4.
Test job **`a2a1615a`** (created through the normal `/dub/upload` path from a copy of the 760 s
source). Nothing in `uyjpfb4k`, `0r1xzjss`, `u6u5vrjt` or `5p113y7e` was touched — proved by
`job_data` md5 before and after (see §7).

## 1. What the user does

1. Upload the video as normal (Upload → Prepare runs; separation gives `vocals.wav`).
2. Click **Import Transcript CSV** in the Transcribe-stage panel. The timeline is built from the
   file exactly: same timestamps, same text, same speakers. Voice clones are cut automatically,
   one per speaker, from that speaker's own audio. Nothing is re-transcribed.
3. Click **Import Translation CSV**. Target text is joined on `line_id` and written verbatim; the
   target language is set from the file, and the app moves to the Edit stage.
4. **Generate Dub** as usual, then Export.

## 2. Endpoints

All three live in `api/routers/dub_csv_import.py`, mounted by `main.py`. Additive: the transcribe
and translate endpoints are untouched and still present (`/dub/transcribe/{job_id}`,
`/dub/transcribe-stream/{job_id}`, `/dub/translate`, `/dub/import-srt/{job_id}`; 243 paths before
and after).

### `POST /dub/import/transcript/{job_id}`  (multipart)

| field | |
|---|---|
| `file` | CSV: `line_id,speaker,start,end,source_text` + optional `word_times`, `notes` |
| `source_lang` | optional, e.g. `hi`. Falls back to the filename, then to the script in `source_text` |
| `build_clones` | optional, default true |

Writes each row as a segment:

```
id            c000..           (index in start order)
line_id       the CSV line_id  (the join key for the translation file)
start / end   the exact CSV floats - no alignment, no de-overlap, no clamping
text_original source_text
text          source_text      (so the Edit grid is not blank before the translation)
speaker_id    "Speaker N" from SPKN
profile_id    "auto:speaker_N"
asr_confidence 1.0             (hand-authored; nothing downstream may gate on a low score)
csv_notes     notes
```

and on the job: `timing_source="manual-csv-v1"`, `source_lang`, `labels_source="manual"`,
`per_segment_refs=True`, `speaker_clones`, `cast_sources`, and the placement defaults
`timing_strategy="strict_slot"`, `slot_fit="off"`.

Then it **re-reads the persisted `dub_history.job_data` row** and compares every start/end to the
original CSV cell text (0.0005 s) and every text byte-for-byte. A mismatch is a 500 with the
offending line ids — the import never half-succeeds.

Response: `rows`, `source_lang`, `speakers[]` (per speaker: CSV speech seconds, cloned yes/no,
reference seconds, slices, ref-text chars, chars/s, reference file), `speaker_labels`,
`clones_built`/`clones_expected`, `verification{worst_start_delta_s, worst_end_delta_s,
text_byte_identical}`, `defaults`, `segments[]` (so the UI can fill its grid), `warnings[]`,
`next_step`.

Idempotent: a second upload replaces the timeline, and a translation imported earlier is
re-applied if — and only if — its `line_id` set still matches. If it does not, it is dropped and
said so, rather than pairing the wrong text with the wrong line.

### `POST /dub/import/translation/{job_id}`  (multipart)

| field | |
|---|---|
| `file` | CSV: `line_id,start,end,target_text,notes` |
| `language_code` | optional, e.g. `te`. Falls back to filename, then to the script in `target_text` |

Joins on `line_id` against the stored import. Sets `text` and `csv_notes` only; `start`, `end` and
`text_original` are not touched. Where the translation echoes `start`/`end` they must still agree
within 0.002 s. Same read-back assertion. 409 with `joined_on: "line_id"` on any join problem.

Response: `rows`, `joined`, `language_code`, `language`, `fit_warnings[]` (worst 40),
`fit_over_budget`, `chars_per_s_budget`, `verification`, `defaults`, `segments[]`, `warnings[]`,
`next_step`.

### `GET /dub/import/status/{job_id}`

What has been imported, whether the media is ready, segment counts, cloned speakers, the stored
defaults, and `next_step` (`transcript` → `translation` → `generate`).

## 3. Validation — what blocks, what warns

Ported from `validate_input.py` / `merge_pair.py`. **Block** = HTTP 400/409, nothing written, the
job is left byte-identical. **Warn** = imported, message returned in `warnings[]`.

| check | severity | why |
|---|---|---|
| missing required column | block | nothing to import |
| not valid UTF-8 | block | the text would be mangled silently |
| empty file / over 8 MB | block | |
| duplicate `line_id` | block | the join key must be unique or the wrong text lands on the wrong line |
| empty `line_id` / empty `speaker` / empty `source_text` | block | |
| unreadable `start`/`end` | block | |
| `end <= start` | block | a zero or negative slot has nothing to place |
| ellipsis in `source_text` | block | the text must be verbatim |
| a speaker overlapping itself | block | one person cannot talk over themselves; it also breaks reference cutting |
| more than 8 distinct speakers | block | `MAX_SPEAKERS` (`OMNIVOICE_DIAR_MAX_SPEAKERS`) is 8, so a 9th label has nothing to bind to |
| a speaker under 3.0 s total | block | `MIN_SEGMENT_REF_DURATION_S`: below it the speaker silently falls back to the pooled voice |
| translation: empty `target_text` (not a song/music row) | block | |
| translation: duplicate `line_id` | block | |
| translation: any id on one side only | block | reported both ways, with the ids |
| translation: `start`/`end` drift over 0.002 s | block | ids can line up while the files disagree |
| translation: target rows still in the source script | block | that dubs the source language back at the user |
| **row longer than 12 s** | **warn** | deliberate downgrade: the reference transcript has one 28.7 s row (L0168), and the user's timeline is authoritative |
| 7–8 speakers | warn | under the ceiling, but usually one voice under two labels |
| a speaker in only one row | warn | enough to clone, but often a label typo |
| rows not in increasing `start` order | warn | imported in start order |
| `word_times` malformed or evenly spaced (i.e. generated) | warn | this import ignores that column entirely, so it cannot do harm |
| over-budget lines at the chars/s proxy | warn | character count explains under 10 % of real duration variance — 5p113y7e measured 31 of 50 lines filling their slot where the proxy predicted 8 |
| unexpected columns | warn | ignored |
| language guessed from script | warn | |
| a speaker that got no clone | warn | it will use the stock voice |

## 4. Files edited, with backups

Backend, patched in place inside the container:

| file | backup | change |
|---|---|---|
| `/app/backend/api/routers/dub_csv_import.py` | `.precsvimport.20260820114743` (this run) | `text` = `source_text` on transcript import (was empty); the same on a dropped re-import; `segments[]` added to both responses so the UI can fill its grid; `segments_with_target_text` now counts "differs from the source" |
| `/app/backend/main.py` | `.precsvimport.20260820102117` | two lines: import and `include_router(dub_csv_import.router)` |
| `/app/backend/api/routers/dub_generate.py` | `.precsvimport.20260820102117` | two guarded hunks: for `timing_source == "manual-csv-v1"` only, upgrade the frontend's default `concise` → the job's `strict_slot`, and `time_stretch` → the job's `slot_fit="off"`. An explicit client choice still wins |

`dub_csv_import.py` did not exist before this feature, so a full revert moves it aside rather than
restoring it.

Frontend — the app ships a built Vite bundle (`/app/frontend/dist`), no sources on the box, so the
three minified modules were spliced at anchors that were each asserted to occur exactly once:

| file | backup | change |
|---|---|---|
| `assets/dub-Z3w7xV4B.js` (api) | `.precsvimport.20260820114743` | two functions posting multipart to the new endpoints via the app's own `postForm` (so base URL, PIN and API-key headers are handled exactly as everywhere else), exported as `csvT` / `csvX` |
| `assets/main-app-D1VIs8oe.js` | `.precsvimport.20260820114743` | imports them; two `useCallback` handlers modelled line-for-line on the existing SRT-import handler; both returned from the dub hook, destructured at the call site and passed into `DubTab` |
| `assets/DubTab-DiAV3WAr.js` | `.precsvimport.20260820114743` | the two props threaded into the Transcribe-stage panel, and two `<label>` + hidden `<input type=file accept=.csv>` controls spliced next to the existing **Import SRT** control, same classes, same dark theme |

Both bundles parse under a real JS engine (`node --check`, all three files) and the patched python
was **imported for real** (`api.routers.dub_csv_import`, `api.routers.dub_generate`, `main`) — not
just `py_compile`d. The app was reloaded and `/sysinfo` answered 200.

## 5. Frontend behaviour

* Buttons appear once a job exists, in the same row as *Change file* / *Import SRT*:
  **Import Transcript CSV**, **Import Translation CSV**.
* On success after the transcript: a toast with the row count, the speaker count, each speaker's
  CSV speech seconds and reference length, and the worst timestamp delta; the segments are pushed
  into the store. The stage is deliberately **not** advanced, so the second button stays on screen.
* On success after the translation: a toast with rows joined on `line_id`, the segment count and
  the target language; `dubLangCode` / `dubLang` are set from the response, so the *Dub into*
  selector matches the file rather than leaving the user to align it by hand; the app moves to
  Edit, where **Generate Dub** works unchanged.
* On failure: the message and every `problems[]` entry are shown verbatim, both in the panel's
  error banner (`setDubError`) and in an error toast. Nothing is swallowed.
* Warnings are shown as separate toasts (first 8).

Honest limitation: the button labels and tooltips are hardcoded English. Every other string in
this app comes from `i18n-C9BPIV9I.js`, and adding keys to the built locale bundle for 30-plus
languages was out of scope.

## 6. End-to-end test through HTTP

`csv files\FILE1-Transcript-Hindi.csv` (168 rows) and `csv files\FILE2-Translation-Telugu.csv`
(168 rows), on a fresh job `a2a1615a`.

```
POST /dub/upload                       -> job a2a1615a, media_ready in 20s
POST /dub/import/transcript/a2a1615a   -> 200 in 18.8s  (the clone extraction)
   rows 168, source_lang hi, clones 6 of 6
   worst start delta 0.000000000s, worst end delta 0.000000000s
   1 warning: L0168 is 28.7s long (imported as given)
POST /dub/import/translation/a2a1615a  -> 200 in 0.03s
   rows 168, joined 168, te / Telugu
   worst timestamp move 0.000000000s
   1 warning: 40 of 168 lines over the 13.0 chars/s budget (worst 2.00x on L0164)
```

Independent assertion, reading the persisted DB row and comparing to the CSV cells (not the
endpoint's own claim):

```
segments 168, ids c000..c167, line_id order identical to the CSV
worst start delta 0.000000000s   worst end delta 0.000000000s
168 of 168 source texts byte-identical
168 of 168 target texts byte-identical
join key: every segment carries its CSV line_id
timing_source manual-csv-v1   strict_slot / off
speaker_ids Speaker 1..6, profile_ids auto:speaker_1..6, asr_confidence 1.0
```

Speakers cloned from their own audio, all six, reference transcripts in Devanagari (i.e. the
source language — the leak bug class the shadow-segment trick prevents):

| speaker | CSV speech | reference | slices | ref density | scripts in ref_text |
|---|---|---|---|---|---|
| Speaker 1 | 172.2 s | 11.82 s | 3 | 14.0 c/s | deva 110, ascii 56 |
| Speaker 2 | 111.2 s | 9.39 s | 4 | 13.5 c/s | deva 89, ascii 38 |
| Speaker 3 | 42.0 s | 12.68 s | 5 | 13.9 c/s | deva 121, ascii 55 |
| Speaker 4 | 165.8 s | 8.89 s | 2 | 9.8 c/s | deva 71, ascii 16 |
| Speaker 5 | 46.2 s | 8.92 s | 2 | 10.8 c/s | deva 55, ascii 41 |
| Speaker 6 | 12.7 s | 9.72 s | 4 | 11.9 c/s | deva 88, ascii 28 |

No reference carries more transcript than its audio can hold, and every `voice_speaker_N.wav`
lives in this job's own directory.

### Render — first 3 minutes

All 168 segments sent, `regen_only` = the 50 with `start < 180`, and **`timing_strategy` and
`slot_fit` deliberately absent from the body** — exactly what the built frontend sends. The
imported job's own defaults had to win, and they did (`strict_slot` / `off` on the job after the
render). 1616 s wall clock, 0 errors, 50 clips written, `dubbed_te.wav` 759.989 s.

Post-render, after `_sync_job_segments` rewrote `job["segments"]` from the request:

```
segments still 168
worst timestamp delta vs the CSV 0.000000000s
text mismatches none (source and target)
fit_plans absent, video_stretch_plans absent  ->  the video was not retimed
```

### Placement (cross-correlation)

Each rendered clip's 5 ms energy envelope correlated against `dubbed_te.wav` in a ±2 s window
around the CSV start, normalised over the overlapping slice, then confirmed in the sample domain:

```
lines measured                50 of 50
median signed delta          +0.0 ms
P95 signed delta             +0.0 ms
P95 |delta|                   0.0 ms
max |delta|                   0.0 ms      (45 of 50 bit-exact 0; the rest under 0.05 ms
                                           of envelope-grid quantisation)
lines off by more than 100 ms 0
local envelope correlation    median 1.000, min 0.824
sample-domain correlation     median 1.000, min 0.811
```

Every line starts where the CSV says. The two sub-1.0 correlations are the CSV's own deliberate
overlap (c027 runs to 94.200 while c028 starts at 93.100), where the track holds two speakers at
once — preserved exactly as authored, as on 5p113y7e.

Fit, under `strict_slot` with `slot_fit="off"` (no time-stretch in either direction):

```
clips filling their whole slot   27 of 50
  ...still loud at the cut       12   (cut mid-speech: the cost of holding the user's `end`)
slot fill ratio                  median 1.00, min 0.32, max 1.00
under 70% of their slot          4
own per-line reference           44 of 50
pooled per-speaker clone          6   (c007 c034 c043 c045 c046 c047 - mixed-script source text,
                                       rejected as its own reference by segref_defect)
```

### Export

`GET /dub/download/a2a1615a?preserve_bg=true&default_track=te` → 200, 52,927,547 bytes,
759.979 s, h264 + two AAC tracks, written to the job's own `exports/` directory. The full
Upload → Import → Import → Generate → Export path works on an imported job.

## 7. Failure paths

Each bad file was built from the real one so only the defect under test differs. The job's
`job_data` md5 was `b484006cb41bb15e5b708c1fbb8cd195` before the first rejection and identical
after the last.

| case | endpoint | status | message shown |
|---|---|---|---|
| duplicate `line_id` | transcript | **400** | `row 9: duplicate line_id L0007 (first seen on row 8)` |
| 10 speakers (round-robin SPK1..SPK10) | transcript | **400** | `10 distinct speakers, but the diarization ceiling is 8. Merge the least important voices into one shared label.` |
| not UTF-8 (0xFF at offset 148) | transcript | **400** | `the file is not valid UTF-8 ('utf-8' codec can't decode byte 0xff in position 148: invalid start byte). Re-save it as UTF-8 - not ANSI, not UTF-16.` |
| `end <= start` | transcript | **400** | `row 5 (L0004): end (14.550) is not after start (14.550)` |
| missing `source_text` column | transcript | **400** | `the transcript CSV is missing required column(s): source_text. Found: line_id, speaker, start, end` |
| mismatched `line_id` set (L0001 → L9999) | translation | **409** | `1 transcript line(s) have no translation row: ['L0001']` **and** `1 translation row(s) have no transcript line: ['L9999']` |
| empty `target_text` on a non-song row | translation | **409** | `row 11 (L0010): empty target_text (allowed only on a song/music row)` |

Every rejection also carries the same header message: *"This file was not imported. Fix the
problem(s) below and upload it again - nothing on the job was changed."*

Job after all seven: 168 segments, `timing_source manual-csv-v1`, 6 clones, `job_data` md5
unchanged.

## 8. Protected jobs and invariants

```
uyjpfb4k 139 segs  c0bfafcb3885461590ac566489bfca34   (199 files)   unchanged
0r1xzjss  87 segs  4ed9b38a7ec9b0a504248fa587abf35e                 unchanged
u6u5vrjt   5 segs  3ecab46bab380ac1464ec7d6c0bd2bbf                 unchanged
5p113y7e 168 segs  c1f355888d4021cf3ba4e3360f8320f0   (230 files)   unchanged
```

Guarded invariants, checked before the patch, after the patch, after the reload and after the
render:

```
grep -c 'lead_in\|leadin\|sibilant\|_LEAD_IN' /app/backend/api/routers/dub_generate.py  ->  5
stat -c %s /app/backend/services/speech_rate.py                                        ->  13073
```

No identifier containing `leadin` was introduced. `dub_history` went from 18 rows to 19 (the one
new test job).

## 9. How to revert

`revert_csvimport.ps1` (logic in `_revert_csvimport_tmpl.sh`, same shape as
`revert_today.ps1` / `_revert_tmpl.sh`):

```
.\revert_csvimport.ps1 -Status              live files, endpoints, buttons, invariants, backups
.\revert_csvimport.ps1 -Level ui            remove the two buttons only; endpoints keep working
.\revert_csvimport.ps1 -Level router        undo this run's router edits, keep the endpoints
.\revert_csvimport.ps1 -Level all           remove the feature entirely
.\revert_csvimport.ps1 -Level all -WhatIf   print the plan, change nothing
```

It refuses to run while a render looks to be in flight, copies each current file to
`.prerevert.<utc>` first (so the revert is itself reversible), **imports** every restored python
module rather than compiling it, re-checks both invariants, reloads the app, waits for
`/sysinfo` 200, and prints which routes survived. `-Level all` also moves `dub_csv_import.py`
aside, because it did not exist before this feature. `-Status` and `-Level all -WhatIf` were both
run and behave as described.

## 10. Honest gaps

* **No button was clicked.** There is no browser on the box and none of this was driven through
  a real UI session. What is proved: the three patched bundles parse under `node --check`; the
  wiring chain exists link by link in the served files (api export → main-app import → two
  handlers → hook return → call-site destructure → DubTab props → panel props → the two labels
  and their hidden file inputs); the served `/assets/...` responses are the patched bytes; and the
  endpoints the buttons post to are the ones tested above through HTTP. Runtime behaviour in a
  browser — that the toasts read well, that the grid repaints — is unverified.
* `text` is pre-filled with the **source** text on transcript import, as asked, so the Edit grid
  is not blank. The cost: pressing Generate between the two imports would dub the source language
  back at the user. Nothing prevents that; the success toast tells them to import the translation
  next.
* 12 of the 50 rendered lines are cut mid-speech at the slot edge. That is the direct cost of
  holding the user's `end` values with no compression, and it is a property of the render
  configuration, not of the import.
* 6 of the 50 lines use their speaker's pooled clone rather than their own delivery, because their
  source text mixes Latin and Devanagari and `segref_defect` rejects a mixed-script reference.
  Unchanged from 5p113y7e; fixable only by relaxing that check, which was not touched.
* Button labels are hardcoded English (see §5).
* Only the first 3 minutes were rendered. To finish the file: same request, `regen_only` = the ids
  with `start >= 180.0`; the first 50 then reuse their cached `seg_te_*.wav`.
* Verification covers placement, fidelity, fit and voice source. Whether the Telugu is
  intelligible on the 27 lines that filled their slot still needs a listen.

## 11. Scripts

Host: `_ci01_survey.sh` … `_ci23_final.sh` (survey, anchor assertions, the patch, reload, new job,
transcript import, translation import, rejections, render, poll, placement verification, closing
checks), `revert_csvimport.ps1` + `_revert_csvimport_tmpl.sh`. On the box:
`/tmp/render_a2a1615a.jsonl`, `/tmp/verify_a2a1615a.json`, `/tmp/export_a2a1615a.mp4`.
