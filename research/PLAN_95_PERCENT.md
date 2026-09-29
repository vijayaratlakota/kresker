# Getting to 95% well-placed and 95% covered, in 7 source languages, on every video

Consolidates four research streams (19-20 Aug) with the measurements taken on our own jobs.
Detail lives in `asr_word_timestamps.md`, `forced_alignment_indic.md`,
`dubbing_pipelines_survey.md`, `google_cloud_stack.md`.

---

## 1. Where we actually are

Measured per **rendered line** (the unit that gets dubbed and placed), source text aligned
against source audio, `WELL = 0.45`, weighted by lines:

| source | jobs | lines | well placed | dialogue covered | raw covered |
|---|---|---|---|---|---|
| Hindi | 5 | 354 | **43.5%** | 98.5% | 96.1% |
| English | 2 | 46 | **50.0%** | 99.2% | 95.6% |
| Telugu | 3 | 75 | **78.7%** | 99.2% | 96.2% |

Coverage is already at target. **Placement is the entire problem.**

### The 88.5% we have been quoting is measured on the wrong unit

`chirp_wire` computes `well` on `groups` - the merged **blocks** - and the speaker split into
**parts** runs afterwards in `retime_job`. Same threshold (0.45), same aligner, same audio; the
only difference is the partition. `dq1g7fxj` records `blocks: 26, parts: 31`, reports 88.5%, and
its 31 rendered lines score 53.3%.

Re-merging parts into 12s block-sized windows recovers 70.1% for Hindi, so the unit explains
about 7 points of the 24-point gap. The rest is instrument difference: the pipeline scores its
own Chirp word groups, this scorer re-aligns the window. **Both numbers were honest; only one
describes what ships.** Fix: publish per-part quality, keep per-block as a secondary.

### A scorer bug found and fixed on the way

`score_job.sh` aligned `s["text"]` - the **translation** - against the source audio. Hindi read
12.3%. The tell: `j64scz9x` is the only job where `text == text_original` (translation never
ran) and it was the only job that scored well, 82.3%. Now uses `text_original`. Anything
measured with the old scorer before 19 Aug 12:45 UTC is void.

---

## 2. Your "starts a few frames too late" theory - tested, and the verdict is split

Measured on 8 jobs, per line: distance from the stored start to the first voiced frame.

| source | median front slack | p90 | lines over 200ms | well placed if snapped to speech |
|---|---|---|---|---|
| Hindi | **0.00s** | 0.08-0.25s | 3-13% | 63.2% -> **60.3%** (worse) |
| English | 0.02s | 0.06-0.12s | 4-5% | 50.0% -> 50.0% (no change) |
| Telugu | 0.02s | 0.08s | 0% | 83.3% -> 78.8% (worse) |

**The timeline is not late.** Line starts sit on the speech onset within 20ms, and snapping them
to the measured onset makes placement *worse* - it late-shifts words whose onset is a low-energy
fricative or stop closure, which the aligner had correctly included.

**But the conclusion you drew is still right, by a different route.** Two things stop the
original from playing in a gap: the original vocals are separated out and absent from the export,
and the background bed sits at a median of **-54.2 dB** at line fronts. There is nothing there to
play. What is audible as Hindi *is the dub speaking Hindi*, because the clone was conditioned on a
reference clip cut from a neighbouring window - `_widen_short_refs` was appending a partially
covered neighbour's **entire** transcript (c004: 6.00s of audio carrying an 11.86s transcript).

So timing accuracy really does cause the Hindi you hear, just not by leaving a playable hole:
**loose line windows produce contaminated reference clips.** That is why tightening placement is
the right target, and why it will fix the symptom.

---

## 3. Why 95% needs a definition before it needs an engineer

Professional human dubbing, measured over 319 hours and 201,246 lines
([Brannon, Virkar & Thompson, TACL 2023](https://aclanthology.org/2023.tacl-1.25.pdf)):

- median speech overlap **0.731**, mean 0.658
- **4.3% of lines have exactly zero overlap** with the source speech
- human dubbers **refuse to vary speaking rate** to hit timing - dub rate SD is *lower* than
  source (1.25 vs 1.47 w/s Spanish, 1.26 vs 1.46 German). Forced to choose, they break timing.

Systems in the literature that reach 0.99 overlap do it by degrading translation quality
([Pal et al. 2023](https://arxiv.org/html/2305.13204v1)).

Consequences we should accept openly:
1. **95% must be "95% of lines inside a tolerance", not 95% exact.** Adopt the broadcast
   asymmetry: audio leading picture is far worse than lagging. ITU-R BT.1359 detectability is
   about **+45ms early / -125ms late**; EBU R37 allows **+40/-60ms**. Use a window of about
   **-40ms to +120ms** and never snap a line earlier.
2. `atempo` time-stretching is the lever professionals give up first. It should be our last
   resort, not our first.
3. Report **median and P95, never the mean**. Forced alignment is monotonic, so a handful of
   runaway lines dominates a mean: on Buckeye, WhisperX shows mean 11,685ms against median
   30.1ms ([arXiv 2406.19363](https://arxiv.org/html/2406.19363v1)).

---

## 4. The ceiling of our current instrument

No ASR vendor - Google, ElevenLabs, Deepgram, AssemblyAI, Azure, AWS - publishes a word-boundary
error figure for any language. Every sub-100ms number in the literature comes from forced
alignment:

| aligner | mean word-boundary error | within 100ms |
|---|---|---|
| MFA 3.0 | **12-22ms** | 98.4% (TIMIT) |
| MMS / `torchaudio.forced_align` (what we use) | **43-50ms** | 92-96% |
| NeMo / Conformer CTC | 78-89ms | 63-70% |
| WhisperX | 110ms | 54-57% |

On *unseen* languages MMS lands only **63-77% of word starts within 50ms**
([arXiv 2606.10675](https://arxiv.org/html/2606.10675v1)). Against a 95%-inside-tolerance goal,
MMS is marginal - which matches Hindi sitting at 43.5%.

Two hard constraints nobody told us:

- **`MMS_FA` is CC-BY-NC 4.0** ([model page](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html)).
  It cannot ship in a commercial product. This is a licensing problem in the load-bearing stage.
- MMS_FA has **no word-boundary token** and a 20ms stride against MFA's 10ms hop, so it models
  no inter-word silence at all.

### The Indic aligner that exists

Official MFA ships **no Indian language**. [AI4Bharat/IndicMFA](https://github.com/AI4Bharat/IndicMFA)
covers all 22 with acoustic model + grapheme dictionary: Tamil 300h, Telugu 262h, Hindi 255h,
Malayalam 197h, Kannada 194h, **Gujarati only 43h**. It publishes no accuracy and is trained on
read/TTS speech, so it must be measured on film audio before being trusted. Caution: a
*mismatched* MFA model fails catastrophically, not gracefully - on Dutch IFA it placed 19% of
boundaries within 100ms where MMS got 76.6%. Match to domain beats architecture.

---

## 5. The misplacement signal we do not have

Our detector cannot tell us a line is misplaced, and we proved why: a monotonic CTC path scored
**0.936** on 100%-Hindi audio against Telugu text - its best score. The fix is not a better
threshold, it is **not averaging**.

Ranked, cheapest first:

1. **Min-pooled window confidence.** Split a line's frames into ~0.5s windows, take the mean
   frame probability of each, and score the line as the **minimum**. Published discard threshold
   0.22 ([CTC segmentation, arXiv:2007.09127](https://arxiv.org/pdf/2007.09127v2)). A wrong-language
   line can keep its *average* plausible; it cannot keep *every* window plausible.
2. **`<star>` mass.** `torchaudio.functional.forced_align` supports a star token. Measure the
   fraction of a line's frames whose path sits on it. This gives the aligner an explicit way to
   say "the text is not here", which it currently lacks.
3. **Re-decode CER** - free-decode the line's span and compare to its expected text. The only
   genuinely language-aware check, and the one that catches our exact failure.
4. **Cross-aligner disagreement** - IndicMFA (native script, GMM-HMM) vs MMS (romanised, CTC)
   share almost no failure modes. Flag `|start_A - start_B| > 150ms`.
5. **Collapsed-token rate** and MFA's own `alignment_analysis.csv` (max |z| log-duration, longest
   run of <=10ms intervals) - free diagnostics if we move to MFA.

Calibrate on ~200 hand-labelled lines per language including deliberately poisoned cases
(wrong-language head, dropped line, 500ms shift). Optimise for **recall of misplacement** and
accept false positives - a false re-render costs GPU seconds, a false cut deletes words.

---

## 6. Techniques the field uses that we do not

From 63 projects and 14 papers. Ranked by expected gain against our specific gap.

1. **Prosodic alignment inside each block.** Our blocks are ~12-15s and nothing constrains drift
   *inside* a line, so the dub is free to speak the second half while the mouth is shut. Federico
   2020 solves it with dynamic programming over target break points, scored on speaking-rate
   match, rate variation, a POS-LM break probability, and asymmetric boundary relaxation up to
   300ms - early starts penalised ~4x harder than late ends. Measured: segmentation accuracy
   **49.2% -> 71.7%**, fluency **54.2% -> 89.2%**, and Accuracy was the *only* automatic metric
   that predicted human score
   ([paper](https://www.isca-archive.org/interspeech_2020/federico20_interspeech.pdf)).
   Forced alignment is the expensive prerequisite and we already have it.
2. **Drop the chars-per-second table for a duration predictor.** Character length explains under
   10% of overlap variance (r2 = 0.078, TACL 2023), and isometric MT is indistinguishable from
   plain MT on isochrony. Use an MMS-TTS duration predictor
   ([IsoChronoMeter](https://arxiv.org/html/2410.11127)) - reference-free, no audio needed.
3. **Slot = own onset -> next onset, cursor assigned not accumulated.** open-dubbing and Voxa make
   drift structurally impossible this way, and it removes zero-length and inverted slots outright.
4. **Two-pass synthesis at the measured rate** instead of post-hoc `atempo`.
5. **Length-budgeted translation with verify-and-retry.** Descript measured +13-43 percentage
   points of duration adherence by moving the constraint into generation; Amazon's verbosity
   control exceeded 90% compliance with BLEU *up* in 3 of 4 pairs. But budget then stop -
   over-tightening lost subjective wins by +57% to +138%.
6. Round-trip ASR quality gate with automatic regeneration (this is what we built for
   `head_language`; the field agrees it belongs there).

Explicitly not recommended: lip-sync re-rendering (hides timing error; human dubs share a viseme
only ~12.4% of on-screen time), and global cross-correlation re-sync (our failure is per-line
distribution, not a constant offset).

---

## 7. Google Cloud: what it can and cannot do

| need | Google's answer |
|---|---|
| word timings, all 7 languages | **`chirp_2`**, `features.enable_word_time_offsets=True`. us-central1 / europe-west4 / asia-southeast1. No Indian region. |
| diarization | **`chirp_3`** - but only hi-IN, en-IN, en-US of our 7. **Nothing for te/ta/kn/ml/gu on any model.** Caps at 6 speakers. |
| both at once | No single model. Merge two recognitions of one immutable audio object: `chirp_2` is the only source of time, `chirp_3` is a label track, assign by interval overlap - never by text matching. |
| forced alignment | **Does not exist anywhere in Google Cloud.** No Chirp accepts a reference transcript. Speech adaptation biases the decoder; it is not alignment. |
| where each dub word landed | `v1beta1` `enableTimePointing: ["SSML_MARK"]`, and `<mark>` is excluded from billing. **But Chirp 3: HD ignores `<mark>`** - the only premium tier covering all 7 returns no timepoints. Telugu has no WaveNet or Neural2 at all, only Standard and Chirp3-HD. Known drift bug: `<voice>` plus `<mark>` counts text as zero duration. Always assert `len(timepoints) == len(marks)`. |
| exact output duration | No equivalent of Azure's `mstts:audioduration`, no SSML `prosody duration`. Only global `speaking_rate` (Chirp3-HD 0.25-2.0). Closed loop required. |
| length-controlled translation | Cloud Translation has none. Use **Gemini on Vertex** - also ~10x cheaper. |
| timestamps from Gemini audio | **Do not.** MM:SS only, with progressive drift measured up to 157s on a 12-minute file. |

Recommended stack, about **$0.171 per 3-minute video per target language** (~$1,200/month for
1,000 videos x 7 languages): one immutable mono object in GCS -> `chirp_2` word timings with
speech adaptation -> pyannoteAI diarization for all 7 uniformly -> MMS/MFA re-anchoring on Cloud
Run L4 -> Gemini 2.5 Flash length-budgeted translation -> Chirp 3: HD per line -> forced-align the
dub against its own known text (no ASR error by construction, and it works for Chirp3-HD) -> fit
retries -> repair queue.

**Google alone reaches about $0.153 and does not reach 95%**, for three specific reasons: no
forced aligner, no diarization for 5 of our 7 languages, and no way to verify the premium voice's
own timing.

---

## 8. What I would do next, in order

1. **Publish per-part timing quality** alongside per-block, so the number we optimise is the
   number that ships. Measurement only; no behaviour change. (Instrument already written:
   `_score_all.sh`.)
2. **Add the min-pooled + `<star>` misplacement signal** and calibrate it against the lines we
   have already hand-labelled. This is the gate everything else needs.
3. **Bench IndicMFA against MMS** on our own film audio for hi/te/en, scoring % of line starts
   inside -40/+120ms. Decide the aligner on measured numbers, not on the papers - and resolve the
   MMS_FA CC-BY-NC licence question, which blocks commercial shipping either way.
4. **Harden slot arithmetic** (own onset -> next onset, assigned cursor). Cheap, structural.
5. **Then** prosodic alignment inside blocks. Highest expected gain, and the only intervention
   with a published accuracy number on exactly our problem.

Steps 1-4 are measurement and plumbing; step 5 is the one that should move Hindi off 43.5%.

---

## 9. Research method and honest coverage

| stream | searches | pages fetched | credits |
|---|---|---|---|
| ASR word timestamps | 26 | 33 | 38 |
| Forced alignment (Indic) | 38 | 29 | 109 |
| Dubbing pipelines (63 projects, 14 papers) | 41 | 55 (50 useful) | 124 |
| Google Cloud stack | 30 | 27 (23 billed) | 23 |
| **total** | **135** | **144** | **294** of 1000 |

**Reddit was not covered, and I am not going to pretend otherwise.** Firecrawl refuses
reddit.com by policy - www, old.reddit, and the stealth proxy all return HTTP 403 "we do not
support this site". Direct fetching from this machine returns 403 and the native fetcher returns
an empty page. Firecrawl's `/v2/search` does surface Reddit threads with titles and snippets, but
snippets cannot answer whether anyone has a better method.

`reddit_research.py` is written and ready: app-only OAuth (`client_credentials`), which reads
public posts, comments and search **without an account password**, self-throttled to ~96
requests/minute, resumable, and it records counted coverage rather than claimed coverage. It
needs two lines in `_reddit_key.txt` - client id, then secret - from
https://www.reddit.com/prefs/apps ("create another app", type **script**).

Cost note: Firecrawl `-Search` costs ~80 credits per call because it scrapes every result;
`-Url` costs 1. Discovery therefore uses free web search and Firecrawl only fetches chosen URLs.
`fc.ps1` enforces this - `-Search` is gated behind `-AllowSearch`.
