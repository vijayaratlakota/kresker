# Render speed: taking the per-line ASR call out of the render loop

**What changed:** the per-line head-language check (`services/head_language.py`) is now
**off by default**. One line moved - the default in `ENABLED = os.environ.get(
"OMNIVOICE_HEAD_LANG", "1")` became `"0"`. Nothing was deleted, nothing was commented
out, no threshold or function was removed, and `api/routers/dub_generate.py` was not
edited at all.

**What it bought:** median **13.77 -> 2.44 seconds per line**, measured as a paired A/B on
job `vmtzgy00`. About 82% of each rendered line was this one network call.

**What it cost:** head-located source-language leaks are no longer detected or cut. On the
one job where the tally is on record that was about **30 of 168 lines**. This is a real
loss of a safeguard, not a free win. See [What it costs](#4-what-it-costs).

Turn it back on with `OMNIVOICE_HEAD_LANG=1` (no code change) or
`.\revert_headlang.ps1 -Level headlang`.

---

## 1. What the call was costing, and how that was measured

`classify_best` takes up to `LOOKS` (default 2) **independent** recogniser looks at every
rendered line, and stops early only when a look finds something actionable. A clean line -
which is most of them - therefore pays *both* calls. Each look is a remote round trip:

```
INFO [omnivoice.asr] OpenAI-compat ASR transcribing /tmp/_hl_1.wav
     (base_url=http://172.17.0.1:8900/v1, model=gemini-3.7-flash)
```

From the live logs before the change:

| Evidence | Source |
|---|---|
| one look, 6.8s end to end (ASR 22:23:45.4 -> tally 22:23:52.2) | job `fno0wbe7`, line c158 |
| two looks, 11.5s (ASR 22:24:13.5 and 22:24:19.6 -> tally 22:24:25.1) | job `fno0wbe7`, line c162 |
| line-to-line spacing 5.6-8.3s | job `fno0wbe7` steady state |
| two ASR calls per line (19:35:06.3, 19:35:11.1 -> tally 19:35:14.7) | job `vmtzgy00`, cancelled attempt |
| GPU at 0% utilisation in 9 of 10 samples | 20s sample while rendering |

That last row is the reason this was worth doing: the render was **latency-bound on a
network call**, not compute-bound. The T4 was idle waiting for it.

In the fresh A/B below, phase A made **71 ASR calls over 34 lines - 2.09 per line**, which
confirms directly that most lines pay both looks rather than one.

## 2. Code reading, before changing any default

### Does `ENABLED` actually stop the network call, or only gate the caller?

It stops it, inside the module. `classify` checks it as its **third statement**, long
before any backend is resolved (`head_language.py`, lines 319-323):

```python
    out = {"verdict": UNKNOWN, "cut_s": 0.0, "note": "", "chunks": 0, "judged": 0,
           "content_evidence": False}
    if not ENABLED:
        out["note"] = "disabled"
        return out
```

The network work is much further down the same function, lines 353-357:

```python
    if backend is None:
        from services import asr_backend as B
        backend = B.get_active_asr_backend()
    try:
        res = transcribe_piece(wav_path, backend)
```

`transcribe_piece` is what reaches the wire, at line 158: `return backend.transcribe(tmp)`.
`head_seconds` has the same guard at lines 168-169 (`if not ENABLED: return 0.0,
"disabled"`). `classify_best` only loops over `classify`, so it inherits the guard.

So no code change was needed to make the switch effective, and the `if _HL.ENABLED` at
`dub_generate.py:1470` is a second, redundant gate rather than the only one. **This is why
`dub_generate.py` - the file the marker invariant guards - did not have to be touched.**

### What does the second call site do?

`dub_generate.py:1636` imports the same module as `_HLS`, but only for the leading-silence
trim:

```python
                    from services import head_language as _HLS
                    _sil = _HLS.front_silence(audio_tensor, backend.sample_rate)
                    if _sil > 0:
                        audio_tensor = _HLS.trim_tensor(audio_tensor,
                                                        backend.sample_rate, _sil)
```

`front_silence` is pure local numpy - an RMS envelope, a run-length test and a verify-then-
walk-back loop. **No network, no GPU, no recogniser.** It is gated by its own separate flag
(`START_ON_TIME`), so it is unaffected by this change and the "start on time" behaviour
still works exactly as before.

### Is there any other per-line network call in the render loop?

No. In `dub_generate.py`:

- `get_active_asr_backend` - **0 occurrences**
- `.transcribe(` - **0 occurrences**
- the only `from services import` / `import services` lines in the whole file are
  `gpu_gateway` (line 19), `head_language` (1469), `head_language` (1636)

So `head_language` was the single per-line network call, and it is now off.

### The `speech-rate provider attempt 2 failed` warnings

**Per job, during translation - not per line, and not in the render loop.**
`dub_generate.py` never imports `speech_rate`; its only mention is a comment on line 46.
The real callers are `api/routers/dub_translate.py` (lines 1408, 1443), `api/routers/
tools.py:137`, `services/duration_planner.py` and `engines/indextts`. The warning comes
from the retry loop at `speech_rate.py:189` inside `for attempt in range(1, MAX_ATTEMPTS
+ 1)`.

The log timeline confirms it: the warnings land at 19:32:39 and 19:32:50, immediately
before `POST /dub/translate -> 200 OK` at 19:32:50, and roughly 90 seconds *before* the
render starts at 19:34:18. Three warnings against 156 lines. Nothing to fix here for
render speed.

## 3. The measurement

### A real paired A/B, not a comparison against old logs

Both phases ran back to back on the same idle box, against the same job, with the same
40-line request body, and **both in a freshly restarted app process** so neither got a
`torch.compile` or model-load advantage over the other:

- **Phase A** - default pinned back to `"1"`, app restarted, 34 lines rendered, cancelled.
- **Phase B** - default `"0"` (the shipped state), app restarted, same body, 34 lines,
  cancelled.

The ruler is the per-segment SSE `progress` event yielded at the top of every iteration of
the render loop (`dub_generate.py:1040`). It fires unconditionally, which `start on time`
does not - that one only logs when it actually trims something, so it would have silently
dropped lines from the sample.

Job `vmtzgy00` had no translated text anywhere on the box (the Telugu track lived only in
the desktop client; `dub_history.tracks` is `[]`), so the first 40 lines were re-translated
hi -> te through `POST /dub/translate` (provider `openai`, quality `fast`, 193s) and that
one body was reused by both phases.

### Warmup, excluded explicitly

The first five line-gaps of each phase are dropped. They hold model load and inductor
compilation, and they are obvious in the raw numbers:

| | gap 1 | gap 2 | gap 3 | gap 4 | gap 5 |
|---|---|---|---|---|---|
| Phase A | 121.02s | 20.42s | 10.96s | 11.89s | 12.68s |
| Phase B | 54.75s | 12.09s | 1.73s | 1.80s | 1.90s |

Everything reported below is the **28 lines after that**.

### Result

| | n | median | p95 | mean | min | max |
|---|---|---|---|---|---|---|
| **A - head-language ON** (before) | 28 | **13.77s** | 25.02s | 14.59s | 8.62s | 28.68s |
| **B - head-language OFF** (after) | 28 | **2.44s** | 4.53s | 2.94s | 1.65s | 4.75s |

- median **5.65x faster**, 11.34s saved per line
- p95 **5.53x faster** (25.02 -> 4.53)
- the check was **82%** of each line's wall clock
- extrapolated over the full 156 lines at steady state: **35.8 min -> 6.3 min**, saving
  about 29.5 minutes

Per-line detail, post-warmup seconds:

```
A: 16.0 14.9 15.7 13.7 10.9 14.8  8.6 27.0 21.4 10.0 16.6 11.8 16.4 11.1
    9.3 28.7 13.9 12.7 11.8 20.0 14.7 11.5 11.3 14.4 11.1 13.1 16.1 11.1
B:  3.6  4.6  4.0  2.1  2.1  3.7  1.6  2.1  3.4  2.3  4.8  2.3  3.4  2.5
    1.9  2.2  4.1  2.3  2.2  3.3  1.8  2.0  2.1  3.1  2.3  3.8  4.4  4.0
```

### Zero API calls in the render, confirmed from the log

Counted over the log slice each phase produced:

| | head-language ASR calls | `head language tally` lines |
|---|---|---|
| Phase A (ON) | **71** over 34 lines | 33 |
| Phase B (OFF) | **0** | **0** |

Not one `OpenAI-compat ASR transcribing /tmp/_hl` line appears during the phase B render.

Confirmed a second, independent way, by timestamp over the whole log rather than by the
per-phase offsets above:

```
head-language ASR calls in the log today: 76
first: 19:35:06    LAST: 20:32:28
during PHASE A (20:22:34 - 20:32:20, check ON) : 70
during PHASE B (20:32:57 - 20:35:33, check OFF): 0
anywhere at or after phase B started           : 0
```

The last such call in the entire log predates the start of the phase B render by 29
seconds - it is phase A's loop winding down after the cancel. And the local path is
demonstrably still alive: `start on time` logged **33 times during phase B**, which is
`front_silence` doing its leading-silence trim with no recogniser involved.

Two counting traps worth recording, since both produced a wrong number first:

- a `tail -200` window over the log still reaches back into phase A, so a tail-based count
  reports calls that belong to the *previous* phase. `revert_headlang.ps1 -Status` prints
  such a count (labelled "in the last 500 log lines") and it will look non-zero for a while
  after any run with the check on. Count by timestamp, not by tail depth.
- an `awk '/ASR transcribing \/tmp\/_hl/ && $2 >= "20:32:50"'` written through
  `bash -lc "..."` reported **714** against a true total of 76: the regex was mangled in
  transit and only the time condition survived. Redone in python, where the pattern is a
  plain string, it returns 0. Same lesson as the invariant grep in section 6.

### How this relates to the older "before" figures

The earlier log numbers (6.8s for one look, 11.5s for two, 5.6-8.3s line spacing) come
from lines c157-c167 of job `fno0wbe7`. The A/B above uses lines c000-c039 of `vmtzgy00`,
which are different, mostly longer lines - so the absolute s/line is higher in both phases
than the old spacing figures. That is expected and does not matter: **the A/B is internally
paired**, same lines, same body, same box, minutes apart, so the 5.65x is a like-for-like
comparison. The older figures are quoted only as the independent corroboration that a look
costs 2.5-5.5s and that clean lines pay two of them.

One residual asymmetry, stated rather than hidden: a fresh process recompiles CUDA graphs
for input shapes it has not seen, and 28 lines is not enough to be sure both phases had hit
the same set of shapes. That noise shows up as the occasional spike (A's 27.0s and 28.7s,
B's 4.8s), which is exactly why median and p95 are reported and not just the mean.

### Housekeeping

- disk unchanged at 77% used, 34 GB free, before and after. A partial render writes ~40 KB
  per line, so there was never a fill risk; a *full* 156-line render of this job lands
  around 500-750 MB based on the existing job directories, which also fits.
- **nothing was left running.** Both phases were cancelled cleanly through
  `POST /tasks/cancel/{task_id}`; render-ish process count is 0 and `/sysinfo` answers 200.

## 4. What it costs

Plainly: **head-located source-language leaks are no longer detected or cut.** The user
asked for speed "without decreasing the quality", and this change does not meet that bar -
it trades a safeguard for speed. On job `fno0wbe7` the final tally was:

```
{'ok': 138, 'lead': 12, 'all_source': 18, 'babble': 0, ...}   of 168 lines
```

so about **30 lines of 168 were being acted on** - 12 trimmed of a source-language head, 18
flagged as entirely source-language and re-rendered or reported. Those 30 lines will now
ship as the engine produced them. The tail-source detection (`TAIL_SOURCE`, the "original
audio just before every dubbed line" complaint) goes with it, since it rides on the same
recogniser call.

That is the user's call to make, and it is one flag away from coming back. But it should not
be described as a free speedup.

### Pricing the alternative that keeps the safeguard

The GPU is idle at 0% while the remote check runs and `faster_whisper` 1.2.1 is already
installed, so a **local** recogniser for the head check is the obvious way to keep the
safeguard without the network latency. Measured on the box, on a real `/tmp/_hl_628.wav`
clip (3.61s, the exact clip class the check is handed), Tesla T4, GPU otherwise idle:

| model | compute_type | load | cold | **warm median** | detected language |
|---|---|---|---|---|---|
| tiny | float16 | 0.77s | 1.18s | 1.15s | `ml` - **wrong** |
| tiny | int8_float16 | 0.48s | 0.84s | 1.08s | `ml` - **wrong** |
| base | float16 | 3.78s | 2.14s | 1.98s | `te` |
| base | int8_float16 | 0.63s | 1.94s | **1.85s** | `te` |
| small | float16 | 0.72s | 4.42s | 4.76s | `te` |
| small | int8_float16 | 1.24s | 5.13s | 5.18s | `te` |

**The "roughly 0.3s per look" assumption does not hold on this hardware.** The cheapest
model that even identifies the language correctly is `base`, at **1.85s per look** - so
about **3.7s for the two looks** `classify_best` takes on a clean line. That would turn a
2.44s line into roughly 6s rather than 13.77s: a real improvement over the remote call,
but nowhere near free, and still more than double the cost of leaving the check off.
`tiny` is fast enough to be tempting and must not be used - it read this Telugu clip as
Malayalam.

Two further caveats before anyone builds on this:

- **it is unmeasured whether a local recogniser reproduces the remote verdicts.** The whole
  detector is tuned on chunk timestamps and script/content coverage thresholds that were
  calibrated against `gemini-3.7-flash` output. A different recogniser chunks differently,
  and the module's own comments record that chunking differences are exactly what makes
  look 1 and look 2 disagree. This would have to be checked on the known-bad lines (c010,
  c012, c018, c029) before it could replace anything.
- a local recogniser **contends with TTS for the same GPU** (5147 of 15360 MiB already in
  use), whereas the remote call at least leaves the GPU free. The 1.85s measured above was
  on an idle GPU and would degrade under a live render.

Not implemented. This section exists so the number in the decision is a real one.

## 5. How to revert

Nothing was deleted, so reverting is a one-line flip.

| Want | Do |
|---|---|
| the check back on for one run, no edit | set `OMNIVOICE_HEAD_LANG=1` in the container environment |
| the default itself back on | `.\revert_headlang.ps1 -Level headlang` |
| the whole pre-change file back | `.\revert_headlang.ps1 -Level file` (restores `.prehl.20260821200746`) |
| see what is live first | `.\revert_headlang.ps1 -Status` |
| see the plan without touching anything | add `-WhatIf` |
| half the cost, half the coverage | leave it on but set `OMNIVOICE_HEAD_LOOKS=1` |

`revert_headlang.ps1` is a **new** script - `revert_aligner.ps1`, `revert_fa.ps1`,
`revert_alignsplit.ps1` and `revert_snap.ps1` were not touched or reused, since each owns a
different piece of work. It backs the current file up to `.prerevert.<utc>` first, imports
every touched module for real rather than byte-compiling it, re-checks both guarded
invariants, refuses to run while a render is in flight, and reloads the app and waits for
`/sysinfo` 200 - `ENABLED` is read once at import time, so without the reload a revert
would appear to have done nothing.

## 6. Invariants

Checked before the patch, after the patch, before each A/B phase and at the end:

| | required | before | after |
|---|---|---|---|
| `grep -cE 'lead_in\|leadin\|sibilant\|_LEAD_IN' dub_generate.py` | 5 | 5 | 5 |
| `stat -c %s services/speech_rate.py` | 13073 | 13073 | 13073 |

`api/routers/dub_generate.py` was never written to - its mtime is still 2026-08-19
08:52:26 and no backup of it was taken today. No new identifier containing `leadin` was
introduced; the only file changed is `services/head_language.py`.

One trap worth recording, because it cost a scare: a version of the invariant check
assembled inside a PowerShell string reported the marker count as **0**. PowerShell does
not treat `\` as an escape, so `'lead_in\\|leadin'` reached `grep` with doubled
backslashes and the alternation became a literal. Re-run from a `.sh` written directly to
disk, both `grep -c` (BRE) and `grep -cE` return 5. This is the same class of failure
`rsh.ps1` exists to prevent - do not build the check inside PowerShell.
