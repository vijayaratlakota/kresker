# ASR engines with accurate WORD-LEVEL timestamps for 7 Indian source languages

Scope: Hindi (hi-IN), Telugu (te-IN), English (en-IN/en-US), Malayalam (ml-IN), Kannada (kn-IN), Tamil (ta-IN), Gujarati (gu-IN).
Target: ≥95% of dialogue lines placed correctly in a dubbing timeline.
Research date: 2026-08-20. All vendor docs read on that date.

---

## 1. Comparison table

Legend for languages: H=Hindi, T=Telugu, E=English, M=Malayalam, K=Kannada, Ta=Tamil, G=Gujarati. ✓ = documented support, ✗ = documented non-support.

| Engine / model | Word offsets? | Diarization? | Which of the 7 languages | Price / audio hour |
|---|---|---|---|---|
| **Google STT V2 `chirp_2`** | ✓ optional, doc warns quality+speed may degrade slightly ([doc](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model)) | ✗ "Not supported" ([doc](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model)) | **all 7** (H,T,E,M,K,Ta,G) in `us-central1`/`europe-west4`/`asia-southeast1` ([locations matrix](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)) | $0.96/hr standard; $0.18/hr dynamic batch ([pricing](https://cloud.google.com/speech-to-text/pricing)) |
| **Google STT V2 `chirp_3`** | Listed **under "doesn't support"** — but same page's API table references a 20-min batch cap "with word-level timestamp enabled" (self-contradictory) ([doc](https://cloud.google.com/speech-to-text/v2/docs/chirp-model)) | ✓ but only in `BatchRecognize`/`Recognize`, and only for 14 locales: of ours **only hi-IN, en-IN, en-US** ([doc](https://cloud.google.com/speech-to-text/v2/docs/chirp-model)) | all 7 for transcription (H,E GA; T,M,K,Ta,G Preview) ([doc](https://cloud.google.com/speech-to-text/v2/docs/chirp-model)) | same Google STT V2 pricing |
| **Google STT `chirp` (v1 USM)** | ✗ — model doc page is now **404**; feature row absent from current model list ([404](https://docs.cloud.google.com/speech-to-text/docs/models/chirp), [current model list](https://docs.cloud.google.com/speech-to-text/docs/transcription-model)) | ✗ (blank in locations matrix for all Indic locales) | Still listed in locations matrix for all 7 in `us-central1`/`europe-west4`/`asia-southeast1` ([matrix](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)) | same |
| **Google `long` (= V1 `latest_long`)** | ✓ via `enableWordTimeOffsets` ([doc](https://cloud.google.com/speech-to-text/docs/async-time-offsets)); doc calls timing "experimental", accuracy can vary ([WordInfo ref](https://cloud.google.com/php/docs/reference/cloud-speech/1.15.0/V2.WordInfo)) | ✗ for our Indic locales (blank in matrix) | H,T,M,K,Ta,E — **no Gujarati** ([matrix](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)) | $0.96/hr; not in current V2 model list |
| **Google `telephony`** | ✓ (same V1/V2 flag) | ✗ for Indic; ✓ only en-US-type locales | Of ours: **H and E only** ([matrix](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)) | $0.96/hr |
| **Gemini 2.5 / 3.x audio** | ✗ — docs only document `MM:SS` segment references ([doc](https://ai.google.dev/gemini-api/docs/audio)) | ✓ prompt-level, not a guaranteed API feature ([doc](https://ai.google.dev/gemini-api/docs/audio)) | all 7 in practice (no published per-language list) | audio input tokens: 32 tok/s → ~115k tok/hr; e.g. Gemini 3 Flash audio in $1.00/1M ≈ $0.12/hr input ([audio doc](https://ai.google.dev/gemini-api/docs/audio), [pricing](https://ai.google.dev/gemini-api/docs/pricing)) |
| **ElevenLabs Scribe v2** | ✓ per-word `start`/`end` in ms, plus `spacing`/`audio_event` types ([doc](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)) | ✓ up to 32 speakers ([doc](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)) | **all 7**: K,M,E ≤5% WER tier; G,H,Ta,T in 5–10% tier ([doc](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)) | from $0.40/hr ([FAQ](https://elevenlabs.io/speech-to-text)) |
| **AssemblyAI Universal-2** | ✓ word timings standard | ✓ +$0.02/hr ([pricing](https://www.assemblyai.com/pricing/)) | all 7 present, but vendor's own WER tiers put **G, K, M, T above 50% WER**, Ta 25–50%, H 10–25% ([doc](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)) | $0.15/hr (U-2), $0.21/hr (U-3.5 Pro) ([pricing](https://www.assemblyai.com/pricing/)) |
| **AssemblyAI Universal-3.5 Pro** | ✓ | ✓ | 18 languages only: **H, E** of ours; others fall back to U-2 ([doc](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)) | $0.21/hr |
| **Deepgram Nova-3** | ✓ `words[]` with `start`/`end` ([utterances doc](https://developers.deepgram.com/docs/utterances)) | ✓ (`diarize`) | H, T, Ta, K, G, E — **no Malayalam** ([model/language list](https://developers.deepgram.com/docs/models-languages-overview)) | pre-recorded Nova-3 mono $0.0043/min ≈ **$0.26/hr**; multilingual $0.0052/min ≈ $0.31/hr ([pricing](https://deepgram.com/pricing)) |
| **Azure AI Speech (batch)** | ✓ word-level; display-form word timings only in Batch, lexical-only in real-time ([MS answer](https://learn.microsoft.com/en-us/answers/questions/2142206/does-real-time-azure-speech-to-text-support-provid)) | ✓ included free in batch ([pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)) | **all 7** STT locales ([language support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)) | Batch **$0.18/hr**, real-time $1/hr; diarization free in batch ([pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)) |
| **AWS Transcribe** | ✓ per-item `start`/`end` times ([Item ref](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_streaming_Item.html)) | ✓ `ShowSpeakerLabels` ([diarization output](https://docs.aws.amazon.com/transcribe/latest/dg/diarization-output-batch.html)) | **all 7** in batch (T,Ta,K,M,G marked streaming-caveat `*`) ([supported languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html)) | batch $0.006/min = **$0.36/hr**; streaming $0.01/min = $0.60/hr ([pricing](https://aws.amazon.com/transcribe/pricing/)) |
| **OpenAI `whisper-1`** | ✓ only model with `timestamp_granularities:["word"]` ([guide](https://developers.openai.com/api/docs/guides/speech-to-text)) | ✗ | Whisper's 98-language set covers all 7, accuracy varies ([guide](https://developers.openai.com/api/docs/guides/speech-to-text)) | $0.006/min = $0.36/hr (widely reported; OpenAI pricing page is JS-rendered) |
| **OpenAI `gpt-transcribe`** | ✗ — docs tell you to switch models if you need word timestamps ([guide](https://developers.openai.com/api/docs/guides/speech-to-text)) | ✗ (separate `gpt-4o-transcribe-diarize`, segment-level only) | multi-language via `languages` | ~$0.0045/min per model page (secondary sources) |
| **Sarvam AI (saaras v3 / saarika)** | ✗ **explicitly not supported** — chunk-level only, in every transport ([batch doc](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/batch-api), [transport matrix](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/which-api-to-use)) | ✓ batch only | 22 Indian languages + English → all 7 | ₹30/hr; ₹45/hr with diarization ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)) |
| **AI4Bharat IndicConformer-600M** | Not exposed by the shipped API (CTC head makes frame alignment derivable) ([model card](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual)) | ✗ | 22 Indic languages incl. H,T,M,K,Ta,G — **English not included** ([model card](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual)) | self-host (MIT license) |
| **AI4Bharat IndicWhisper** | Whisper-family; word timings only via DTW or external aligner | ✗ | 12 Indic languages incl. all 6 of ours ([paper](https://arxiv.org/html/2305.15386v2)) | self-host |
| **WhisperX (Whisper + phoneme forced alignment)** | ✓ and measurably better than Whisper's own ([paper](https://arxiv.org/pdf/2303.00747v2)) | via pyannote | any Whisper language + an alignment model per language | self-host |

---

## 2. Per-engine notes

### Google Cloud Speech-to-Text

**Current model inventory.** The V2 "compare models" page now lists exactly three: `chirp_3`, `chirp_2`, `telephony` ([transcription-model](https://docs.cloud.google.com/speech-to-text/docs/transcription-model)). The original `chirp` model page 404s ([link](https://docs.cloud.google.com/speech-to-text/docs/models/chirp)), although `chirp` and the V1-era `long`/`short`/`telephony_short` identifiers still appear in the machine-generated locations matrix ([matrix](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)). Practical read: `chirp_2` and `chirp_3` are the supported paths; `latest_long` survives as `long` but is not being promoted.

**Which Chirp variants drop word timings / diarization — the exact answer.**

- `chirp_2` **supports** word-level timestamps (optionally enabled, with a documented caveat that transcription quality and speed may degrade slightly) and **does not support diarization or language detection** — both are in an explicit "not supported" table ([chirp_2 doc](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model)).
- `chirp_3` is the inverse: diarization is GA (BatchRecognize/Recognize only), utterance-level timestamps exist in streaming, and **word-level timestamps appear in the "Chirp 3 doesn't support the following features" table** ([chirp_3 doc](https://cloud.google.com/speech-to-text/v2/docs/chirp-model)). Caution: the same page's API-methods table says batch is good to ~1 hour "but up to 20 minutes with word-level timestamp enabled", and the "unsupported" row carries a description that reads like a supported feature. This is a live documentation contradiction; the GA release note for `chirp_3` lists diarization and language detection and says nothing about word timings ([release notes](https://cloud.google.com/speech-to-text/docs/release-notes)). Treat `chirp_3` word timings as unreliable-until-measured on your own audio.
- Original `chirp`: the doc used to state it lacks several Google Speech features; the page is gone, and the locations matrix shows only automatic punctuation for every Indic `chirp` row — no diarization, no word-level confidence ([matrix](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)).

**Language reality for our 7.** From the locations matrix:

- `chirp_2` (in `us-central1`, `europe-west4`, `asia-southeast1`): hi-IN, gu-IN, kn-IN, ml-IN, ta-IN, te-IN all present, diarization column blank for every one.
- `chirp_3` (in `us`, `eu` multi-region): all 7 present; **Speaker diarization** appears only on en-IN, en-US and hi-IN among ours.
- `long`: hi-IN, kn-IN, ml-IN, ta-IN, te-IN — **Gujarati absent**.
- `telephony`: of ours only hi-IN and English locales.
- Regionality note: `asia-south1` (Mumbai) shows only `telephony_short`/en-US in the matrix, but a release note announced `chirp_3` public preview in `asia-south1` ([release notes](https://cloud.google.com/speech-to-text/docs/release-notes)) — another place where docs lag.

**Timing-accuracy caveat straight from Google.** The `WordInfo.start_offset` reference states the field is set only when `enable_word_time_offsets` is true, that it is experimental, and that offset accuracy can vary ([WordInfo](https://cloud.google.com/php/docs/reference/cloud-speech/1.15.0/V2.WordInfo)). Google publishes no ms-level accuracy figure anywhere I could find.

**Cost.** $0.016/min ($0.96/hr) for V2 standard recognition, dropping to $0.003/min ($0.18/hr) with dynamic batch, plus volume tiers ([pricing](https://cloud.google.com/speech-to-text/pricing)).

### Gemini audio understanding (2.5 / 3.x)

**Granularity is seconds, not words.** The official audio guide's only timestamp mechanism is `MM:SS` references, and its structured-output example asks for one timestamp per *segment* ([audio doc](https://ai.google.dev/gemini-api/docs/audio)). Audio is tokenized at 32 tokens/second with a 9.5-hour ceiling per prompt — 31 ms of audio per token, so word-level precision is not architecturally impossible, just not exposed or promised.

**Measured failure modes.** The most useful public data point is a benchmark posted on Google's own forum: one 11:49 Arabic clip, 11 traced phrases, four models compared against a 2.5-Flash baseline ([thread](https://discuss.ai.google.dev/t/bug-gemini-3-flash-and-3-1-pro-progressive-timestamp-drift-in-audio-transcription/129501)):

| Model | mean abs drift | max abs drift | progressive? |
|---|---|---|---|
| Gemini 3.1 Flash Lite (high thinking) | 1.25 s | 4.75 s | no |
| Gemini 3.1 Flash Lite (medium) | 1.80 s | 8.57 s | no |
| Gemini 3.1 Flash Lite (minimal) | 2.09 s | 8.46 s | no |
| Gemini 3.1 Pro (low thinking) | 6.26 s | 17.42 s | yes |
| Gemini 3 Flash (minimal thinking) | 78.67 s | 157.0 s | yes, catastrophic |

Gemini 3 Flash compressed 11:49 of audio into a 0:00–9:14 span — an internal clock running roughly 22% fast, per the reporter's analysis. Note that the "ground truth" here is another Gemini model, so absolute error is uncertain; the *relative* finding (linear drift proportional to position) is the robust part, and it is the failure mode that destroys dubbing.

Other documented modes:
- Long-standing complaints that GA 2.0 models produce unusable timestamps while preview models were fine ([thread](https://discuss.ai.google.dev/t/timestamp-generation-forced-alignment-on-2-0-production-models-is-still-broken/79553)).
- Sudden regressions with no prompt/model change ([Dec 2025 thread](https://discuss.ai.google.dev/t/gemini-api-srt-transcription-suddenly-broken-timestamps-are-wildly-inaccurate-since-yesterday-despite-no-prompt-model-change/111846)).
- Chunk-boundary corruption in real pipelines: malformed `[100:XX:XX]` stamps from Flash 3, hour-digit dropped on 16+ entries from Pro 2.5 so chunk-2 content lands in chunk-1's timeline, and a ~12-minute window where dialogue collapsed into on-screen markers on politically sensitive content ([engineering write-up](https://github.com/dzivkovi/video-intel/blob/main/docs/solutions/integration-issues/gemini-flash3-vs-pro25-chunked-transcription-20260427.md)).
- Timestamp *format* instability across models (whole seconds vs fractional seconds) breaks naive parsers — same source.

Conclusion: Gemini is a text/semantics engine for this pipeline, not a timing engine. Use it for transcript quality, speaker naming, or translation; never as the source of cue points.

### ElevenLabs Scribe v2

Word-level `start`/`end` at millisecond resolution, typed tokens (`word`, `spacing`, `audio_event`), diarization to 32 speakers, 10-hour file limit, 3 GB ([doc](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)). The vendor's own per-language WER bands are the most favourable published numbers for our set: Kannada, Malayalam and English in the ≤5% band; Gujarati, Hindi, Tamil, Telugu in the >5–10% band ([same doc](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)). These are vendor self-reported (largely FLEURS/Common Voice style corpora — the marketing pages cite 3.1% FLEURS / 5.5% Common Voice for Kannada and identical figures for Telugu, which suggests those two landing pages share boilerplate and should not be trusted as per-language measurements: [Kannada page](https://elevenlabs.io/speech-to-text/kannada), [Telugu page](https://elevenlabs.io/speech-to-text/telugu)). Price from $0.40/hr ([FAQ](https://elevenlabs.io/speech-to-text)). No published word-boundary error figure.

### AssemblyAI

Word timings and diarization are standard, and pricing is the lowest of the hosted options at $0.15/hr for Universal-2 plus $0.02/hr for diarization ([pricing](https://www.assemblyai.com/pricing/)). But the vendor publishes accuracy bands, and four of our seven languages sit in the worst band: **Gujarati, Kannada, Malayalam, Telugu are grouped as >50% WER**; Tamil is 25–50%; Hindi is 10–25%; only English is ≤10% ([supported languages](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)). Universal-3.5 Pro covers only 18 languages — Hindi and English of our set — and silently falls back to Universal-2 otherwise ([same doc](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)). At >50% WER the word stream is wrong often enough that timestamps are moot.

### Deepgram Nova-3

Word-level `start`/`end` with confidence in the standard response ([utterances](https://developers.deepgram.com/docs/utterances)); Flux only gained word-level timings in mid-2026 ([changelog](https://developers.deepgram.com/changelog/2026/6/30)). Language list includes Gujarati, Hindi, Kannada, Tamil, Telugu — but **Malayalam is absent** from Nova-3, Nova-2 and Flux lists ([models & languages](https://developers.deepgram.com/docs/models-languages-overview)). The `multi` code-switching mode covers only 10 languages, of which Hindi is the only Indic one. Cheapest credible hosted option for pre-recorded audio at ~$0.26/hr ([pricing](https://deepgram.com/pricing)). No published Indic WER.

### Azure AI Speech

All 7 locales supported for speech to text ([language support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)). Word timings exist, with a wrinkle worth planning for: Batch lets you choose display-form or lexical-form word timings, while the real-time API returns lexical-form only ([MS Q&A](https://learn.microsoft.com/en-us/answers/questions/2142206/does-real-time-azure-speech-to-text-support-provid)). Batch is $0.18/hr with diarization at no extra charge; real-time is $1/hr with $0.30/hr per enhanced feature ([pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)). Independent Indic WER evidence exists but is dated — see §3.

### AWS Transcribe

Every pronunciation item carries `start_time`/`end_time` ([Item](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_streaming_Item.html)), diarization output is documented ([example](https://docs.aws.amazon.com/transcribe/latest/dg/diarization-output-batch.html)). All 7 are supported in batch; Gujarati, Kannada, Malayalam, Tamil, Telugu carry the `*` streaming caveat, and per-language feature columns (numbers, acronyms, custom language models) are mostly "no" for them ([supported languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html)). Batch $0.006/min = $0.36/hr per AWS's own worked example ([pricing](https://aws.amazon.com/transcribe/pricing/)).

### OpenAI

Clean split in the docs: `gpt-transcribe` is the recommended transcription model, and the guide explicitly says to pick a specialised model if you need speaker labels, word timestamps or subtitle formats. `whisper-1` is that model — it is the one that accepts `timestamp_granularities:["word"]`. Diarization is a third model, `gpt-4o-transcribe-diarize`, returning `diarized_json` with segment-level `speaker`/`start`/`end` only ([guide](https://developers.openai.com/api/docs/guides/speech-to-text)). 25 MB upload cap is a hard operational constraint for long-form video. Known bug class: multi-element `timestamp_granularities` arrays silently honour only the last element in some proxies ([issue](https://github.com/BerriAI/litellm/issues/35938/linked_closing_reference?reference_location=REPO_ISSUES_INDEX)).

### Sarvam AI

Best-in-class Indic text quality claims and India-local, but **word-level timestamps are explicitly not available**. The batch guide states it returns chunk-level timestamps covering a sentence or phrase, and says per-word timing is not currently available; the transport comparison table lists "chunk-level" for REST and Batch, "segment-level" for Realtime, and "No" for legacy WebSocket ([batch API](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/batch-api), [which API](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/which-api-to-use)). ₹30/hr, ₹45/hr with diarization ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)). Usable as a transcript source feeding an external aligner, not as a timing source.

### AI4Bharat (IndicConformer / IndicWhisper)

`indic-conformer-600m-multilingual` is a hybrid CTC + RNNT model over all 22 scheduled Indian languages — Gujarati, Hindi, Kannada, Malayalam, Tamil, Telugu all included, English not — MIT licensed, ~69k downloads/month, with a Vaani-benchmark Hindi WER of 13.2 on its model card ([card](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual)). The shipped `AutoModel` call returns text only, but the CTC head is exactly what a forced aligner needs, which makes it the most interesting *alignment* asset for Indic in this list.

IndicWhisper (Vistaar) fine-tunes Whisper on 10.7k hours across 12 Indian languages and had the lowest WER on 39 of 59 benchmarks ([paper](https://arxiv.org/html/2305.15386v2)).

---

## 3. Published numbers

### Word-boundary error (the numbers that actually matter for placement)

| Number | What it measures | Source |
|---|---|---|
| **mean boundary error < 15 ms** | MFA 3.0 across four benchmark datasets (English, Japanese, Korean) vs classic and neural aligners | [arXiv 2606.18466](https://arxiv.org/html/2606.18466v1) |
| **4.15 ms** mean error (code-mixed acoustic model) vs **38.18 ms** (monolingual Hindi) and **37.58 ms** (isolated English) | MFA phoneme-boundary error on Hindi–English code-mixed speech; the code-mixed-trained model is ~10× better | [arXiv 2607.25581](https://arxiv.org/html/2607.25581v1) |
| **20–120 ms** timestamp prediction error, **80–90%** precision/recall, across 4 languages; **~200 ms** when extended to speech translation | direct word-timestamp prediction inside an ASR model | [arXiv 2505.15646](https://arxiv.org/abs/2505.15646) |
| ~**20 ms** of human benchmark boundaries for a well-configured aligner | forced-alignment validation study | [Journal of Cognition PDF](https://journalofcognition.org/articles/416/files/677d04cd98c2e.pdf) |

### Word-segmentation precision/recall at a 200 ms collar (WhisperX paper)

A true positive requires the predicted word segment to overlap ground truth within 200 ms **and** be an exact string match, so recall is jointly penalised by WER ([paper](https://arxiv.org/pdf/2303.00747v2)):

| System | AMI precision | AMI recall | SWB precision | SWB recall |
|---|---|---|---|---|
| wav2vec2.0 | 81.8 | 45.5 | 92.9 | 54.3 |
| Whisper (word times via attention DTW) | 78.9 | 52.1 | 85.4 | 62.8 |
| **WhisperX** (Whisper + phoneme forced alignment) | **84.1** | **60.3** | **93.2** | **65.4** |

The paper's own conclusion is that using Whisper alone for word timings underperforms even wav2vec2.0 on AMI and SWB — i.e. an LLM-ish decoder is the wrong tool for boundaries, which is the same lesson as the Gemini drift data. Best phoneme-model choice moved AMI precision from 83.7 to 87.7 in their ablation, so the aligner matters as much as the ASR.

### Indic WER (context for "will the word stream even be right?")

Vistaar benchmark averages (2023 paper, so the Google column predates Chirp) ([paper](https://arxiv.org/html/2305.15386v2)):

| Language | Google STT | Azure STT | IndicWav2Vec | IndicWhisper |
|---|---|---|---|---|
| Hindi | 23.9 | 20.0 | 21.0 | **13.8** |
| Gujarati | 36.5 | 31.6 | 23.4 | **22.8** |
| Kannada | 31.5 | 26.4 | 22.3 | **18.3** |
| Malayalam | 47.9 | 41.8 | 45.7 | **32.3** |
| Tamil | 33.6 | 31.5 | 34.4 | **25.3** |
| Telugu | 42.4 | 31.4 | 30.2 | **28.8** |

Malayalam was the hardest language for every system tested. Vendor self-reported numbers today (ElevenLabs ≤5% for Malayalam) are an order of magnitude better than this independent 2023 measurement — that gap is unresolved and should be treated as a red flag until measured in-house.

### Gemini drift

See the table in §2 — mean absolute drift from 1.25 s (Flash Lite) to 78.67 s (Gemini 3 Flash) on an 11:49 clip ([thread](https://discuss.ai.google.dev/t/bug-gemini-3-flash-and-3-1-pro-progressive-timestamp-drift-in-audio-transcription/129501)).

**Gap I could not close:** no vendor — Google, ElevenLabs, Deepgram, AssemblyAI, Azure, AWS — publishes a word-boundary MAE or a "% of words within 100 ms" figure for any language, let alone Indic. Every hard millisecond number above comes from academic forced-alignment work, none of it covering Telugu, Kannada, Malayalam or Gujarati.

---

## 4. Price per audio hour, credible options only

| Engine | Batch / pre-recorded | Notes |
|---|---|---|
| Azure AI Speech (batch) | **$0.18/hr** | diarization free in batch ([src](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)) |
| Google STT V2 (dynamic batch) | **$0.18/hr** | $0.96/hr without dynamic batch ([src](https://cloud.google.com/speech-to-text/pricing)) |
| AssemblyAI Universal-2 | **$0.15/hr** (+$0.02 diarization) | but >50% WER band for 4 of our 7 ([src](https://www.assemblyai.com/pricing/)) |
| Deepgram Nova-3 mono | **~$0.26/hr** ($0.0043/min) | multilingual ~$0.31/hr ([src](https://deepgram.com/pricing)) |
| Sarvam | **₹30/hr** (₹45 with diarization) | no word timings ([src](https://docs.sarvam.ai/api/getting-started/pricing)) |
| AWS Transcribe | **$0.36/hr** batch | $0.60/hr streaming ([src](https://aws.amazon.com/transcribe/pricing/)) |
| OpenAI whisper-1 | **$0.36/hr** ($0.006/min) | 25 MB cap ([guide](https://developers.openai.com/api/docs/guides/speech-to-text)) |
| ElevenLabs Scribe v2 | **from $0.40/hr** | word timings + 32-speaker diarization ([src](https://elevenlabs.io/speech-to-text)) |
| Gemini 3 Flash (audio in) | ~$0.12/hr input equivalent | 32 tok/s × 3600 ≈ 115k tok/hr at $1.00/1M audio input, plus output text tokens ([audio](https://ai.google.dev/gemini-api/docs/audio), [pricing](https://ai.google.dev/gemini-api/docs/pricing)) |
| Self-host IndicConformer / IndicWhisper / WhisperX | GPU cost only | MIT / research licences |

---

## 5. What I would use for each of the 7 languages and why

**Architectural recommendation first, because it dominates the per-language choice.** No hosted engine publishes word-boundary accuracy, and the only sub-100 ms numbers in the literature come from forced alignment, not from ASR decoders ([MFA 3.0 <15 ms](https://arxiv.org/html/2606.18466v1); [WhisperX beats Whisper's own timings](https://arxiv.org/pdf/2303.00747v2)). So: **pick the engine for transcript quality, then re-derive timings with a forced-alignment pass against the accepted transcript.** That decouples "is the text right" from "is the cue point right", and it is the only path I can defend to ≥95% correctly-placed lines in Telugu, Kannada, Malayalam and Gujarati.

| Language | Primary ASR | Timing source | Why |
|---|---|---|---|
| **English** (en-IN) | ElevenLabs Scribe v2, or Google `chirp_3` if you need Google-native diarization | engine word timings, spot-checked; WhisperX/MFA if a line fails a 200 ms check | Scribe's ≤5% WER band ([src](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)); `chirp_3` is one of only 3 of our locales with Google diarization ([src](https://cloud.google.com/speech-to-text/v2/docs/chirp-model)); MFA/WhisperX English aligners are the best-validated ([src](https://arxiv.org/html/2606.18466v1)) |
| **Hindi** | ElevenLabs Scribe v2 primary; Sarvam saaras v3 as a second opinion for heavy Hindi–English code-mixing | MFA with a **code-mixed-trained** acoustic model | Scribe 5–10% band; Sarvam is built for code-mixing but gives no word timings ([src](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/batch-api)); the code-mixed aligner is 4.15 ms vs 38.18 ms for monolingual Hindi — a 10× win on exactly our content type ([src](https://arxiv.org/html/2607.25581v1)) |
| **Telugu** | ElevenLabs Scribe v2; Google `chirp_2` as fallback | IndicConformer-600M CTC alignment | Scribe 5–10% band vs AssemblyAI's own >50% band ([src](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)); `chirp_2` is the only Google model with both Telugu and word timings ([src](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model)); IndicConformer covers Telugu ([src](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual)) |
| **Tamil** | ElevenLabs Scribe v2; Deepgram Nova-3 as a cheap second pass | IndicConformer CTC alignment | Scribe 5–10%; Deepgram has `ta` at ~$0.26/hr ([src](https://developers.deepgram.com/docs/models-languages-overview)); AssemblyAI Tamil is 25–50% WER ([src](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)) |
| **Kannada** | ElevenLabs Scribe v2; Google `chirp_2` fallback | IndicConformer CTC alignment | Scribe claims ≤5% ([src](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)) — verify, since Vistaar measured 26–31% for hosted engines ([src](https://arxiv.org/html/2305.15386v2)); Deepgram also has `kn` |
| **Malayalam** | ElevenLabs Scribe v2; Google `chirp_2` fallback. **Do not** plan on Deepgram | IndicConformer CTC alignment; budget for the most manual QC here | Malayalam is absent from every Deepgram model list ([src](https://developers.deepgram.com/docs/models-languages-overview)) and is AssemblyAI's >50% band ([src](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)); it was the worst language for every Vistaar system, best-case 32.3% WER ([src](https://arxiv.org/html/2305.15386v2)) |
| **Gujarati** | ElevenLabs Scribe v2; Google `chirp_2` or `chirp_3` (NOT `long` — Gujarati is missing from it) | IndicConformer CTC alignment | Scribe 5–10% band; Gujarati has only `chirp_3` in `us`/`eu` and `chirp`/`chirp_2` in the single-region zones, with no `long`/`short` row at all ([src](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)); AssemblyAI >50% ([src](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)) |

**Explicit rejections and why**

- **Gemini for cue points — rejected.** Only `MM:SS` granularity is documented ([src](https://ai.google.dev/gemini-api/docs/audio)) and measured drift reaches 157 s on a 12-minute file with linear growth ([src](https://discuss.ai.google.dev/t/bug-gemini-3-flash-and-3-1-pro-progressive-timestamp-drift-in-audio-transcription/129501)). Progressive drift is the single worst failure mode for dubbing because it passes early QC and breaks late in the file.
- **Google `chirp_3` as the word-timing source — rejected until measured.** Its own doc lists word-level timestamps as unsupported while another table on the same page implies a 20-minute batch limit when they are enabled ([src](https://cloud.google.com/speech-to-text/v2/docs/chirp-model)).
- **Sarvam as the timing source — rejected by documentation**, not by measurement: no word timings in any transport ([src](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/which-api-to-use)). Still valuable as a transcript source for code-mixed Hindi/Indic.
- **AssemblyAI for the 4 South/West Indian languages — rejected on the vendor's own accuracy bands** (>50% WER for Gujarati, Kannada, Malayalam, Telugu) ([src](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)).
- **Google `long`/`latest_long`** — usable for 6 of 7 but has no Gujarati and no diarization for Indic, and its word timings are documented as experimental with variable accuracy ([src](https://cloud.google.com/php/docs/reference/cloud-speech/1.15.0/V2.WordInfo)).

**Validation protocol I would insist on**, since no vendor number exists to lean on: hand-label word boundaries on ~20 minutes per language, then score each candidate with the WhisperX metric — precision/recall of word segments at a 200 ms collar with exact string match ([definition](https://arxiv.org/pdf/2303.00747v2)) — plus a drift check comparing error in the first and last 10% of each file, which is the only way to catch the Gemini-class clock-rate bug.

---

## COVERAGE

- **Searches run: 26** (free web search tool, distinct queries).
- **Pages fetched with Firecrawl: 33** successful scrapes (one additional attempt on `assemblyai.com/pricing` failed with exit code 1 and was retried successfully at `assemblyai.com/pricing/`). Raw markdown saved to `_research_raw/notes_asr_1.md` … `notes_asr_33.md`.
- **Credits spent: 38** (911 remaining before, 873 remaining after; verified with `.\fc.ps1 -Credits` at both ends). One arXiv PDF fetch cost 6 credits on its own; all other pages cost 1.
- Budget was 170 credits; 38 used.
