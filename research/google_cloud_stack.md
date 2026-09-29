# A costed Google Cloud stack for >=95% line placement and >=95% dialogue coverage across 7 languages

Scope: Hindi (hi-IN), Telugu (te-IN), English (en-IN/en-US), Malayalam (ml-IN), Kannada (kn-IN), Tamil (ta-IN), Gujarati (gu-IN). Paid Google Cloud services only, plus explicitly-flagged non-Google components where Google cannot reach the target. Every factual claim below is linked to the page it came from. Established facts from prior project research (Chirp2 timings, Chirp3 diarization, Gemini MM:SS drift, MFA/MMS/WhisperX alignment numbers, 43–83% current well-placed rate) are used as given and not re-derived.

Date of retrieval: pages fetched in this session; each source link carries Google's own "Last updated" stamp where visible.

---

## 1. Google Cloud STT v2: exact API shape, regions, limits, real price

### 1.1 Getting word offsets out of `chirp_2`

There is no `enableWordTimeOffsets` at the top level in v2. In v2 the flag moved into `RecognitionFeatures`, which hangs off `RecognitionConfig`. The field is `enable_word_time_offsets` (`enableWordTimeOffsets` in REST/JSON). Per the [RecognitionFeatures reference](https://cloud.google.com/php/docs/reference/cloud-speech/1.19.1/V2.RecognitionFeatures), when it is true the top result carries a per-word list with start and end offsets; when false no word-level offset data comes back, and false is the default.

The canonical `chirp_2` shape, taken verbatim in structure (not wording) from Google's own sample on the [Chirp 2 model page](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model):

```python
from google.cloud.speech_v2 import SpeechClient
from google.cloud.speech_v2.types import cloud_speech
from google.api_core.client_options import ClientOptions

client = SpeechClient(client_options=ClientOptions(
    api_endpoint="us-central1-speech.googleapis.com"))   # endpoint MUST match the region

config = cloud_speech.RecognitionConfig(
    auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
    language_codes=["te-IN"],
    model="chirp_2",
    features=cloud_speech.RecognitionFeatures(
        enable_word_time_offsets=True,      # <- the v2 equivalent of enableWordTimeOffsets
    ),
)

request = cloud_speech.RecognizeRequest(
    recognizer=f"projects/{PROJECT_ID}/locations/us-central1/recognizers/_",
    config=config,
    content=audio_bytes,
)
```

Notes that matter operationally:

- The `_` recognizer is the inline/anonymous recognizer. Persistent recognizers are optional stored config, described on the [recognizers page](https://cloud.google.com/speech-to-text/v2/docs/recognizers); the per-region cap is 5,000 recognizers ([quotas](https://docs.cloud.google.com/speech-to-text/docs/quotas)).
- `AutoDetectDecodingConfig` removes the need to declare sample rate and channel count; v2 auto-detects format ([migration guide](https://cloud.google.com/speech-to-text/v2/docs/migration)). Use `ExplicitDecodingConfig` only for headerless PCM ([RecognitionConfig reference](https://docs.cloud.google.com/php/docs/reference/cloud-speech/latest/V2.RecognitionConfig)).
- Google's own feature table for Chirp 2 warns that enabling word timings can slightly degrade transcription quality and speed ([Chirp 2 page](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model)). That is a documented accuracy/timing trade-off, not a rumour.
- Chirp 2's unsupported list on that same page is explicit: diarization not supported, language detection not supported. This confirms the project's established fact.
- Word-level confidence is returned but Google states it is not truly a confidence score. Do not gate coverage decisions on it.

### 1.2 Which regions serve each of the 7 languages

Extracted from the [Cloud Speech-to-Text V2 supported languages](https://cloud.google.com/speech-to-text/v2/docs/speech-to-text-supported-languages) table (which is the human-readable mirror of the [locations API](https://docs.cloud.google.com/speech-to-text/docs/locations)):

| Language | BCP-47 | `chirp_2` regions | `chirp_3` regions | Diarization anywhere in v2? |
| --- | --- | --- | --- | --- |
| Hindi | `hi-IN` | us-central1, europe-west4, asia-southeast1 | us, eu | Yes — `chirp_3` only |
| English (India) | `en-IN` | us-central1, europe-west4, asia-southeast1 | us, eu | Yes — `chirp_3` only |
| English (US) | `en-US` | us-central1, europe-west4, asia-southeast1 (+`chirp_telephony`) | us, eu | Yes — `chirp_3` only |
| Tamil | `ta-IN` | us-central1, europe-west4, asia-southeast1 | us, eu | **No** |
| Telugu | `te-IN` | us-central1, europe-west4, asia-southeast1 | us, eu | **No** |
| Kannada | `kn-IN` | us-central1, europe-west4, asia-southeast1 | us, eu | **No** |
| Malayalam | `ml-IN` | us-central1, europe-west4, asia-southeast1 | us, eu | **No** |
| Gujarati | `gu-IN` | us-central1, europe-west4, asia-southeast1 | us, eu | **No** |

The Chirp 2 model page independently lists its regional availability as us-central1, europe-west4 and asia-southeast1, all marked Private GA. The Chirp 3 model page lists `us` and `eu` multi-region as GA; [release notes](https://cloud.google.com/speech-to-text/docs/release-notes) additionally announced a public preview of `chirp_3` in asia-south1, europe-west2, europe-west3 and northamerica-northeast1, but the language table does not yet show our 7 languages in those regions, so plan on `us`/`eu`.

Practical consequence for an India-facing pipeline: there is **no Indian region** for `chirp_2`. asia-southeast1 (Singapore) is the closest. Data residency in India is not achievable for this model today.

Also note the Chirp 3 language table marks all five of ta/te/kn/ml/gu as **Preview**, while hi-IN and en-IN/en-US are GA.

### 1.3 Batch vs streaming vs sync limits

From the [v2 quotas page](https://docs.cloud.google.com/speech-to-text/docs/quotas) and the [batch recognize overview](https://cloud.google.com/speech-to-text/v2/docs/batch-recognize):

| Method | Audio limit | Input source | Notes |
| --- | --- | --- | --- |
| `Recognize` (sync) | 10 MB **or** 1 minute, whichever comes first | inline bytes or GCS URI | fine for per-line calls |
| `StreamingRecognize` | stream open up to 5 min; each request <= 25 KB; must be sent at ~real time | inline only | `chirp_2` streaming supports only 16 mostly-European locales — **none of our 5 Dravidian/Gujarati languages** |
| `BatchRecognize` | up to 8 hours per file; up to 5 files per request (Google says use 1, and says the cap will drop to 1) | GCS URI only | broadest `chirp_2` language coverage |

The Chirp 2 page states plainly that `BatchRecognize` offers the most extensive language support and that streaming support is limited. Its streaming locale list contains no Indic language except `en-IN`. **So for ta/te/kn/ml/gu you must use `Recognize` or `BatchRecognize`, never streaming.**

One more limit worth knowing for `chirp_3`: its API-methods table says `BatchRecognize` is good for 1 minute to 1 hour generally, but only up to 20 minutes when word-level timestamps are enabled — which is itself evidence that some word-timestamp path exists in `chirp_3` (see 2.1 on the contradiction).

Request-rate quotas, per project, per region:

| Limit | Value |
| --- | --- |
| Synchronous recognition requests / 60 s | 300 |
| Batch recognition requests / 60 s | 150 |
| Concurrent `StreamingRecognize` sessions | 300 |
| Operation requests / 60 s | 150 |
| Resource requests / 60 s | 100 |

### 1.4 The real price per audio hour

The [Speech-to-Text pricing page](https://cloud.google.com/speech-to-text/pricing) gives, for the v2 API, recognition billed per second of audio, rounded up to the nearest second, with monthly volume tiers:

| Monthly minutes | $/minute | $/audio hour |
| --- | --- | --- |
| 0 – 500,000 | 0.016 | **0.96** |
| 500,000 – 1,000,000 | 0.010 | 0.60 |
| 1,000,000 – 2,000,000 | 0.008 | 0.48 |
| 2,000,000+ | 0.004 | 0.24 |

Dynamic batch is a separate SKU at **$0.003 / minute = $0.18 / audio hour**, flat.

Two important caveats you cannot skip:

1. **Dynamic batch is a 24-hour SLA, not a fast lane.** The [ProcessingStrategy reference](https://cloud.google.com/python/docs/reference/speech/2.24.1/google.cloud.speech_v2.types.BatchRecognizeRequest.ProcessingStrategy) says `DYNAMIC_BATCHING` runs the request during lower-utilisation periods for a discount and fulfils it within 24 hours. You set it via `BatchRecognizeRequest.processing_strategy`. For an interactive dubbing product this is unusable on the critical path; it is only viable for offline re-processing or backfills.
2. **The pricing page does not itemise `chirp_2` or `chirp_3`.** Its "Standard models include" footnote lists default, command_and_search, latest_short, latest_long, phone_call, video and `chirp` — `chirp_2` and `chirp_3` are absent from both the Standard and the dynamic-batch footnotes. Treat $0.016/min as the working figure for `chirp_2`/`chirp_3` recognition, and verify against SKU `3099-B70F-0949` in your own billing export before you commit to a unit-economics model. I could not find an official page that assigns `chirp_2` to a named SKU.

Also: each audio channel bills separately. Downmix to mono before you send anything, or you pay 2x for a stereo film mix.

---

## 2. Getting BOTH word timings AND diarization when no single Chirp gives both

### 2.1 First, the doc contradiction you need to know about

The [Chirp 3 model page](https://cloud.google.com/speech-to-text/v2/docs/chirp_3-model) contradicts itself. Word-level timestamps appear under the heading of features Chirp 3 **doesn't** support, yet the row's own description says they are optionally enabled and available in `Recognize` and `BatchRecognize`. Meanwhile the API-methods table on the same page caps `BatchRecognize` at 20 minutes "with word-level timestamp enabled". Its supported-features table lists only **utterance-level** timestamps (streaming only) and Speaker Diarization (batch only).

Read conservatively: **do not architect on `chirp_3` word timings.** They are documented as unsupported, and where the doc implies they exist it is inconsistent about the method. Probe them empirically if you want, but the design below does not depend on them. This matches the project's established fact.

Second gap, and it is the bigger one: `chirp_3` diarization covers only 14 locales, and of our seven only **hi-IN, en-IN, en-US**. Confirmed twice — on the Chirp 3 page's diarization language table, and independently in the supported-languages table where the Diarization column is populated for exactly those three of our seven and nothing else, on any model. **Google Cloud has no diarization for Tamil, Telugu, Kannada, Malayalam or Gujarati.**

Diarization config lives at `RecognitionFeatures.diarization_config`, with `min_speaker_count` / `max_speaker_count`, valid range 1–6, default min 2; set min == max to pin the count ([multiple voices guide](https://cloud.google.com/speech-to-text/v2/docs/multiple-voices), [SpeakerDiarizationConfig](https://cloud.google.com/ruby/docs/reference/google-cloud-speech-v2/0.13.1/Google-Cloud-Speech-V2-SpeakerDiarizationConfig)). 6 speakers is a real ceiling for crowd scenes.

### 2.2 Option A — dual recognition, `chirp_2` + `chirp_3` on the same audio (hi/en only)

Feasible, and this is what I recommend for Hindi and English. Both models accept the identical GCS object, so both see byte-identical audio and share one clock origin. That is the key safety property: **the two recognitions are on the same timeline, so no time warping is needed, only interval logic.**

Merge procedure that is safe:

1. **Freeze one immutable audio artefact.** One mono WAV/FLAC in GCS, one sample rate, no re-encode between passes. Both `chirp_2` (us-central1) and `chirp_3` (us) read that same object. Note the region mismatch — `chirp_2` is not in the `us` multi-region and `chirp_3` is not in us-central1 — so you will make two calls to two endpoints against one bucket. Co-locate the bucket in the US to keep egress at zero.
2. **Treat `chirp_2` as the only source of time.** Take the word list with `start_offset`/`end_offset` from `chirp_2` and nothing else. Never average timestamps between models.
3. **Treat `chirp_3` as a label track only.** Reduce its diarized output to a list of `(speaker_tag, t_start, t_end)` turn intervals. Discard `chirp_3`'s text for timing purposes.
4. **Assign labels by interval overlap, not by text matching.** For each `chirp_2` word, compute overlap with each `chirp_3` turn and take the argmax. Text matching across two different ASR models will fail on exactly the words you care about (proper nouns, code-mixed English) and will silently drop them from coverage.
5. **Reconcile the two word sequences with an alignment, not an equality test.** The two models will disagree on tokenisation and on punctuation. Use a Needleman-Wunsch/Levenshtein alignment over normalised tokens purely to detect disagreement regions, then flag those regions rather than trying to fuse them.
6. **Handle the running-aggregate quirk.** For diarization Google states the results are a running aggregate where each result repeats the previous result's words, and the final result's `words` array is the complete diarized output ([multiple voices guide](https://cloud.google.com/speech-to-text/v2/docs/multiple-voices)). If you concatenate all results you will duplicate every word. Take the last result only.
7. **Snap speaker boundaries to `chirp_2` word edges.** A diarization turn boundary that falls mid-word must be moved to the nearest `chirp_2` word boundary, otherwise you split a word across two rendered lines and both lines end up mis-placed.
8. **Record a merge-confidence per line** (fraction of the line's words whose overlap-argmax was unambiguous). Lines below threshold go to the repair path in stage 8 of the architecture rather than being shipped.

Cost of Option A: two full recognitions, so 2 x $0.016/min.

### 2.3 Option B — `chirp_2` + a separate diarizer (required for ta/te/kn/ml/gu)

For the five languages with no Google diarization, you must bring an external diarizer. Ranked:

| Diarizer | Price | Fit |
| --- | --- | --- |
| **pyannoteAI hosted API** | Starter plan quoted at €0.170 / hour in the [changelog](https://www.pyannote.ai/changelog); Developer plan €19/month including ~165 h on the [pricing page](https://www.pyannote.ai/pricing) → ~€0.115/h. 20-second minimum charge per job ([billing docs](https://docs.pyannote.ai/administration/billing)) | Language-independent (embeddings, not lexical). Best accuracy: an independent [benchmark paper](https://arxiv.org/html/2509.26177v1) puts PyannoteAI at 11.2% DER, best in its comparison, with DiariZen at 13.3% as the open-source runner-up |
| **pyannote.audio 3.1 self-hosted** | GPU only. On Cloud Run L4 at $0.0001867/s ([Cloud Run pricing](https://cloud.google.com/run/pricing)) a 3-min clip is well under a cent | Free licence, no per-minute vendor cost, but you own the ops. ~11–19% DER on standard benchmarks per [this comparison](https://brasstranscripts.com/blog/speaker-diarization-models-comparison) |
| **Amazon Transcribe batch + `ShowSpeakerLabels`** | $0.024/min for the first 250k min/month ([pricing summary](https://brasstranscripts.com/blog/amazon-transcribe-pricing-2026-cost-calculator-guide), [AWS pricing](https://aws.amazon.com/transcribe/pricing/)); 15-second minimum per request | All 7 languages are supported for batch transcription ([supported languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html)) and the [diarization doc](https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html) states no language restriction, distinguishing up to 30 speakers (spk_0..spk_29) — a real advantage over Google's cap of 6. Costs a cross-cloud hop |

Same merge procedure as 2.2, with one extra rule: an external diarizer runs on **your** audio file, so you must guarantee it is the same file, same sample rate, same start offset as the one `chirp_2` saw. If you resample for the diarizer, apply the exact inverse scaling to its boundaries, or better, don't resample.

**Recommendation:** pyannoteAI hosted for all 7 languages, uniformly. Using one diarizer everywhere removes a whole class of per-language branch bugs, is cheaper than a second `chirp_3` recognition ($0.01 vs $0.048 per 3-min clip), lifts the speaker ceiling from 6, and does not care that Chirp 3's Indic support is Preview. Keep `chirp_3` diarization as the hi/en cross-check when you want a second opinion.

---

## 3. Google Cloud TTS timepoints: does it tell you where each word landed?

**Yes — but only through a narrow door, and that door is closed for the voices you actually want to ship.**

### 3.1 The mechanism

Timepoints exist in **`v1beta1` only**. On [`text.synthesize` (v1beta1)](https://cloud.google.com/text-to-speech/docs/reference/rest/v1beta1/text/synthesize):

- Request field `enableTimePointing[]`, an array of `TimepointType`.
- The only non-unspecified enum value is `SSML_MARK`.
- Response returns `timepoints[]`, each a `{ markName, timeSeconds }` pair — `timeSeconds` being the offset from the start of the synthesized audio.
- Google states outright that timepoints are only supported via SSML `<mark>`.

So the pattern is: wrap every word in `<mark name="w0037"/>`, request `SSML_MARK`, and read back the exact second at which each word begins in the rendered audio. `<mark>` is documented as an empty marker element on the [SSML page](https://cloud.google.com/text-to-speech/docs/ssml).

And it is free: the [TTS pricing page](https://cloud.google.com/text-to-speech/pricing) says all SSML tags count toward the billed character total **except** the `<mark>` tag. Word-level marking costs nothing.

### 3.2 Which voice tiers can carry `<mark>`

| Tier | SSML input | `<mark>` / timepoints | `speakingRate` | Price / 1M chars |
| --- | --- | --- | --- | --- |
| Standard | Yes | Yes | Yes | $4 |
| WaveNet | Yes | Yes | Yes | $4 |
| Neural2 | Yes | Yes | Yes | $16 |
| Studio | Yes | Yes | Yes | $160 |
| **Chirp 3: HD** | Partial (see below) | **No** | Yes, 0.25–2.0 | $30 |
| **Gemini-TTS** | No (prompt + text only) | **No** | prompt-steered only | $0.50/M text-token in + $10/M audio-token out (2.5 Flash TTS) |
| Instant custom voice | as Chirp 3 | No | as Chirp 3 | $60 |

Prices from the [TTS pricing page](https://cloud.google.com/text-to-speech/pricing). Free tiers: 4M chars/month for Standard and WaveNet, 1M for Neural2, Studio and Chirp 3: HD.

The Chirp 3: HD story changed and needs care. The [voices overview](https://cloud.google.com/text-to-speech/docs/voices?hl=en) still carries a blanket note that Chirp 3: HD does not support SSML input, speaking rate or pitch. But the current [Chirp 3: HD page](https://cloud.google.com/text-to-speech/docs/chirp3-hd) now lists a specific set of SSML tags accepted for **synchronous** requests — `<speak>`, `<say-as>`, `<p>`, `<s>`, `<phoneme>`, `<sub>`, `<break>`, `<audio>`, `<prosody>`, `<voice>` — and states that tags not on that list are ignored during synthesis. SSML is not supported for streaming requests.

**`<mark>` is not on that list.** Therefore Chirp 3: HD silently discards your marks and returns no timepoints. That is the single most consequential finding in this section: the highest-quality Google voice, and the only tier that covers all 7 languages at premium quality, cannot tell you where its own words landed.

The same page does give Chirp 3: HD a `speaking_rate` in the 0.25x–2.0x range (narrower than the classic 0.25–4.0), plus `[pause]`, `[pause short]`, `[pause long]` tags in a `markup` input field — and explicitly warns the model may ignore pause tags and that pause durations are not fixed. Pace control is available in all locales; pause control excludes 15 locales, none of which are ours; custom pronunciation excludes `gu-in`, which does affect Gujarati.

### 3.3 Voice tiers actually available per language

Derived from the [supported voices list](https://cloud.google.com/text-to-speech/docs/list-voices-and-types) by enumerating voice-name prefixes:

| Language | Standard | WaveNet | Neural2 | Studio | Chirp3-HD | Best timepoint-capable tier |
| --- | --- | --- | --- | --- | --- | --- |
| Hindi `hi-IN` | Yes | Yes | Yes | – | Yes | **Neural2** |
| English `en-IN` | Yes | Yes | Yes | – | Yes (+Chirp-HD) | **Neural2** |
| English `en-US` | Yes | Yes | Yes | Yes | Yes | **Studio / Neural2** |
| Tamil `ta-IN` | Yes | Yes | – | – | Yes | **WaveNet** |
| Kannada `kn-IN` | Yes | Yes | – | – | Yes | **WaveNet** |
| Malayalam `ml-IN` | Yes | Yes | – | – | Yes | **WaveNet** |
| Gujarati `gu-IN` | Yes | Yes | – | – | Yes | **WaveNet** |
| **Telugu `te-IN`** | Yes | **–** | **–** | – | Yes | **Standard only** |

Telugu is the outlier: on the Google catalogue it has exactly two tiers, Standard and Chirp3-HD. So the timepoint route in Telugu costs you a drop all the way to Standard voice quality, while every other language of the seven at least keeps WaveNet. Chirp 3: HD covers all 7 ([Chirp 3: HD language table](https://cloud.google.com/text-to-speech/docs/chirp3-hd)).

Regional endpoints: TTS offers global, `us` and `eu` multi-region, plus single-region endpoints from which, per the [endpoints page](https://cloud.google.com/text-to-speech/docs/endpoints), only Neural2 voices are served.

### 3.4 Documented failure modes of timepoints

This is where the "timepoints let us verify the dub for free" idea springs a leak. Reported and unresolved:

- Timepoints come back for only a fraction of the marks in the input SSML — the reporter saw them stop after the first period ([Google developer forum thread, Mar 2023, revisited Jul 2024](https://discuss.google.dev/t/ssml-mark-timepointing-v1beta1-suddenly-only-returns-the-timepoints-until-first-period/104868)).
- `<voice>` and `<mark>` interact badly: text inside a `<voice>` element appears to be counted as zero duration, so subsequent timestamps fall progressively behind ([Google developer forum thread, Oct 2025](https://discuss.google.dev/t/voice-tag-conflicts-with-mark-timestamps-wrong/271851)). That is a cumulative drift bug, and multi-speaker dubbing is precisely the case that uses `<voice>`.
- Non-deterministic gaps by sentence, reproducible across retries ([StackOverflow, Russian voices](https://stackoverflow.com/questions/70481000/unreliable-timepoints-with-google-text-to-speech-v1beta1-russian)).
- Hyphenated tokens receiving timestamp 0 ([Google developer forum](https://discuss.google.dev/t/text-to-speech-hyphenated-words-getting-0-timestamp/127417)).

Consequence: timepoints are a useful **cross-check**, but a stack that treats them as the authoritative measurement of the dub's internal timing will silently ship drifted lines. You must validate that `len(timepoints) == len(marks)` on every request and treat any shortfall as a failed synthesis.

---

## 4. Can Google TTS hit an exact output duration, or cap speaking rate?

**No exact duration. There is no Google equivalent of Azure's `mstts:audioduration`.** What exists:

- `AudioConfig.speaking_rate`, range **[0.25, 4.0]**, 1.0 native, values outside the range return an error ([AudioConfig reference](https://cloud.google.com/python/docs/reference/texttospeech/2.23.0/google.cloud.texttospeech_v1.types.AudioConfig)). Input-only, applies to the whole request.
- Chirp 3: HD narrows this to **[0.25, 2.0]** ([Chirp 3: HD pace control](https://cloud.google.com/text-to-speech/docs/chirp3-hd)).
- SSML `<prosody>` supports **`rate`, `pitch`, `volume` and nothing else** ([SSML reference](https://cloud.google.com/text-to-speech/docs/ssml)). The W3C SSML `duration` attribute, which is the standards-track way to demand "make this span last exactly N ms", is **not** implemented by Google.
- `AudioConfig.pitch` [-20, +20] semitones and `volume_gain_db` [-96, +16] are there, but they do not affect length.
- Gemini-TTS can be told to speak at a certain pace in natural language ([Gemini-TTS docs](https://cloud.google.com/text-to-speech/docs/gemini-tts)), which is steering, not a contract. There is no duration field and no timepoints.

So fitting a dub line into a fixed source slot on Google is a **closed-loop problem, not a parameter**: synthesize, measure, adjust `speaking_rate`, re-synthesize, or post-process with time-stretching outside Google. Budget 1–2 extra synthesis calls per line that misses its slot, and note the character cost is paid again each time.

Content limit that shapes the whole design: **5,000 bytes per synthesize request** ([TTS quotas](https://cloud.google.com/text-to-speech/quotas)), and it cannot be raised. Per-line synthesis is therefore natural, not a workaround. Long Audio Synthesis handles up to 1 million bytes ([quickstart](https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-long-audio-synthesis)) but it is asynchronous and is the wrong tool when you need per-line control and per-line timing.

---

## 5. Google Cloud Translation: can we constrain output length?

**No. There is no length-control parameter anywhere in Cloud Translation.** Not in `translateText`, not in `adaptiveMtTranslate`, not in glossaries.

What is available:

- **Glossaries** ([glossary guide](https://docs.cloud.google.com/translate/docs/advanced/glossary)) pin terminology — a custom dictionary for domain-specific terms and named entities. Terminology control, not length control.
- **Adaptive translation** ([adaptive translation guide](https://cloud.google.com/translate/docs/advanced/adaptive-translation)) biases output toward the style of example sentence pairs you supply. Cloud Translation picks the five reference sentences most similar to your source, or uses all the reference sentences you pass inline. Segment pairs are capped at 512 characters. One target language per request. This is the only Google-native lever on length, and it is **indirect**: feed it example pairs whose targets are consistently short, and the output tends shorter. It is a prior, not a constraint, and it cannot be audited per line.
- Language coverage is not a problem: the [language support page](https://cloud.google.com/translate/docs/languages) lists Hindi, Telugu, Tamil, Kannada, Malayalam, Gujarati and English all under **official** support for the Translation LLM, and states that Translation-LLM languages are also supported for Adaptive Translation.

Prices, from the [Translation pricing page](https://cloud.google.com/translate/pricing):

| Method | Price |
| --- | --- |
| `translateText`, NMT | $20 / 1M characters (input) |
| `translateText`, custom AutoML | $80 / 1M characters, tiering down at volume |
| `TextTranslation` (Translation LLM) | $10 / 1M input chars **+** $10 / 1M output chars |
| `adaptiveMtTranslate` (LLM) | $25 / 1M input chars **+** $25 / 1M output chars |

Characters are counted per code point, whitespace included, untranslated characters included, and an empty request still bills one character.

**Better option for length control: Gemini on Vertex AI.** A prompt can carry a hard syllable/character budget per line, the source line's duration in ms, and the surrounding lines for context, and can return structured JSON with a per-line length field you can validate and retry on. Gemini 2.5 Flash on Vertex is **$0.30 / 1M input text tokens and $2.50 / 1M output text tokens** ([Vertex generative AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)); Flash-Lite is $0.10 / $0.40. For the ~2.5k characters of a 3-minute video, Gemini Flash costs roughly $0.004 against $0.054 for the Translation LLM — an order of magnitude cheaper **and** the only Google option where length is actually controllable. This is the recommended translation stage.

---

## 6. Vertex AI: is there a hosted forced-alignment service?

**No. Google Cloud does not sell forced alignment, and no Chirp variant accepts a given transcript to align against.**

I looked for it three ways and found nothing:

- No alignment endpoint appears in the Vertex AI product surface ([Vertex AI overview](https://cloud.google.com/vertex-ai/docs/start/introduction-unified-platform)). Vertex's "Model Alignment" is an entirely unrelated prompt-tuning library ([Responsible GenAI Toolkit](https://ai.google.dev/responsible/docs/alignment/model-alignment)).
- Neither the [Chirp 2](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model) nor the [Chirp 3](https://cloud.google.com/speech-to-text/v2/docs/chirp_3-model) page exposes any field for a reference transcript. Both take audio and produce a free recognition.
- The closest thing STT offers is **speech adaptation / biasing**: `SpeechAdaptation` with inline `PhraseSet` phrases, capped at 5,000 phrases per request, 100 characters per phrase, 100,000 characters total, boost up to 20 ([quotas](https://docs.cloud.google.com/speech-to-text/docs/quotas), sample on the Chirp 2 page). You can bias `chirp_2` toward the words you already know are in the audio, which raises the odds it emits those tokens and therefore raises coverage. But the decoder is still free to emit something else, deletions still happen, and the timestamps are still ASR timestamps, not alignment timestamps. **Biasing is not forced alignment and will not deliver sub-100 ms boundaries.**

What Google can host is *someone else's* aligner. Model Garden carries Whisper large-v3 as a [community deployment notebook](https://github.com/GoogleCloudPlatform/vertex-ai-samples/blob/main/notebooks/community/model_garden/model_garden_pytorch_whisper_large_v3_deployment.ipynb), and Cloud Run supports attached GPUs with an L4 at **$0.0001867 per second (~$0.67/hour)** and cold start to GPU-ready in about 5 seconds ([Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Run GPU docs](https://g.co/cloudrun/gpu)). That is the vehicle for MMS/MFA, and it runs *on* Google Cloud while not being *a* Google service.

The alignment accuracy numbers that justify insisting on this stage are external and unchanged: MFA 3.0 reports mean boundary error below 15 ms across four benchmarks ([arXiv 2606.18466](https://arxiv.org/html/2606.18466v1)), MFA is characterised as sub-25 ms precision ([summary](https://www.emergentmind.com/topics/montreal-forced-aligner-mfa)), and a direct comparison found MFA outperforming both WhisperX and MMS ([arXiv 2406.19363](https://arxiv.org/html/2406.19363v1)). Nothing in Google's catalogue is in this range.

---

## 7. Quotas and concurrency that bite, and the cost of one 3-minute video

### 7.1 What bites, for a 3-min video processed per line

Take a 3-minute video as ~40 dialogue lines, ~450 source words, ~2,600 characters of translated text.

| Limit | Value | Per-line impact |
| --- | --- | --- |
| STT sync requests / 60 s / region | 300 | 40 per-line `Recognize` calls = 13% of a minute's budget. One video is fine; **7 concurrent videos saturate the region.** Shard across us-central1 / europe-west4 / asia-southeast1, since the quota is per region |
| STT `Recognize` audio cap | 1 min / 10 MB | fine per line; a whole-file pass must go to `BatchRecognize` |
| STT batch requests / 60 s / region | 150 | whole-file passes: 2 per video, so ~75 videos/min ceiling |
| STT streaming, `chirp_2` | 16 locales, no ta/te/kn/ml/gu | **hard block.** Do not design a streaming path for Indic |
| **TTS bytes per request** | **5,000, cannot be raised** | forces per-line synthesis. A word-marked SSML line is ~3–5x the plain text, so long lines can hit 5,000 bytes on marks alone. Chunk on that basis |
| TTS `RequestsPerMinutePerProject` | 1,000 | 40 lines x up to 2 retries = 80 calls/video → ~12 videos/min |
| **TTS `Chirp3RequestsPerMinutePerProject`** | **200** | the real ceiling if you ship Chirp 3: HD. 40 lines/video → **5 videos/min**, and each fit-retry halves that. Request an increase before launch |
| TTS `Neural2RequestsPerMinutePerProject` | 1,000 | Neural2 path is 5x roomier than Chirp3 |
| TTS concurrent streaming sessions | 100 | not used by this design |
| Diarization speaker cap (Google) | 1–6 | crowd scenes exceed it; pyannoteAI/AWS do not have this cap |
| Translation | characters/day unlimited by default ([Translation quotas](https://cloud.google.com/translate/quotas)) | not a constraint at this volume |

All TTS request limits are from the [TTS quotas page](https://cloud.google.com/text-to-speech/quotas); the content limit there is explicitly non-increasable while request limits can be raised from the console.

The single most likely production surprise is `Chirp3RequestsPerMinutePerProject = 200`. At 40 lines a video it is a 5-videos-per-minute wall on the premium voice.

### 7.2 Cost per 3-minute video, recommended stack

Basis: 180 s of audio, ~2,600 translated characters, ~1,200 input / ~1,300 output Gemini tokens, first-tier pricing everywhere, one target language.

| Stage | Service | Unit price | Qty | Cost |
| --- | --- | --- | --- | --- |
| 1. Source ASR + word timings | STT v2 `chirp_2`, `Recognize`/`BatchRecognize` | $0.016 / min | 3 min | **$0.0480** |
| 2. Diarization | pyannoteAI hosted | ~€0.17 / h | 3 min | **$0.0100** |
| 3. Source re-anchoring | MMS forced alignment, Cloud Run L4 | $0.0001867 / s | ~40 s inc. startup | **$0.0075** |
| 4. Translation, length-constrained | Vertex Gemini 2.5 Flash | $0.30/M in, $2.50/M out | 1.2k / 1.3k tokens | **$0.0036** |
| 5. TTS synthesis | Cloud TTS Chirp 3: HD | $30 / 1M chars | 2,600 chars | **$0.0780** |
| 6. Dub self-verification | MMS forced alignment of dub vs known dub text, Cloud Run L4 | $0.0001867 / s | ~40 s | **$0.0075** |
| 7. Fit retries | Chirp 3: HD re-synthesis, ~20% of lines | $30 / 1M chars | ~520 chars | **$0.0156** |
| 8. Storage / egress | GCS same-region | negligible | | **~$0.0005** |
| | | | **Total** | **≈ $0.171** |

Variants:

- **Timepoint-verified variant** (replace stages 5–7 with WaveNet + `<mark>` SSML): TTS drops to 2,600 chars x $4/M = $0.0104, and stage 6 disappears. Total ≈ **$0.079**. You trade Chirp 3: HD quality for WaveNet, and in Telugu for Standard.
- **Chirp 3 diarization variant** (hi/en, replace stage 2 with a second `chirp_3` recognition): stage 2 becomes $0.048. Total ≈ **$0.209**.
- **Dynamic-batch variant** (stage 1 at $0.003/min): saves $0.039 but accepts up to 24 h latency. Only for backfills.
- **Non-Google ASR excluded**, non-Google diarization and alignment included. If you strip every non-Google component, the Google-only total is ≈ $0.153 — and it does not reach 95%. See section 9.

At $0.171 per 3-minute video per target language: 1,000 videos/month/language ≈ **$171**; all-7 fan-out ≈ **$1,200/month**.

---

## 8. THE RECOMMENDED STACK

One pipeline, per-language differences called out explicitly. For each stage: what it contributes to the 95% target, and how it fails.

### Stage 0 — Audio conditioning (ffmpeg, local or Cloud Run CPU)
Demux, downmix to mono, resample once, write one immutable FLAC/WAV to a US-region GCS bucket. Every later stage reads this exact object.
- **Contributes:** the single shared clock. Every timestamp in the system is an offset into this one artefact, so no stage ever has to warp another stage's time. Also halves STT cost, since Google bills per channel.
- **Fails when:** a stage silently re-encodes or resamples and introduces a fractional-second offset. Enforce by hashing the object and asserting the hash in every stage's log.

### Stage 1 — Source transcript with word timings: STT v2 `chirp_2`
`Recognize` per detected utterance for latency, or one `BatchRecognize` for cost; `features.enable_word_time_offsets = True`; `auto_decoding_config`; endpoint pinned to the region. All 7 languages, us-central1 / europe-west4 / asia-southeast1.
Add `SpeechAdaptation` inline phrase sets for character names, place names and code-mixed English terms — up to 5,000 phrases, boost <= 20.
- **Contributes:** dialogue **coverage**. This is the stage that decides whether a line exists at all. Biasing on known vocabulary is the cheapest coverage lever available and is Google-native.
- **Fails when:** deletions in noisy or musical passages drop whole lines; Chirp 2's word timings are ASR timings, and the project has already measured that they alone yield 43–83% well-placed. Google's own docs warn word timings may degrade transcription. **This stage cannot be the timing authority.**
- **Per-language:** no streaming path for ta/te/kn/ml/gu. Use `Recognize`/`BatchRecognize` only.

### Stage 2 — Speaker turns: pyannoteAI (all 7), `chirp_3` optional cross-check (hi/en only)
Diarize the same GCS object. Reduce to `(speaker, t_start, t_end)` intervals. Assign to Stage-1 words by interval overlap argmax; snap turn boundaries to nearest word boundary; take only the final result if using Google's aggregate output.
- **Contributes:** correct line **segmentation**, which is upstream of placement. A line that merges two speakers can never be correctly placed, because there is no single correct position for it.
- **Fails when:** overlapped speech. Both Google and pyannote degrade on crossfire dialogue; Google additionally caps at 6 speakers. Expect this to be the dominant residual error in crowd scenes.
- **Per-language:** Google gives you nothing for ta/te/kn/ml/gu, and only Preview-grade Chirp 3 transcription there. This is the first place where Google alone is insufficient.

### Stage 3 — Source re-anchoring: MMS or MFA forced alignment on Cloud Run GPU
Align Stage-1 text against Stage-0 audio to recover true word boundaries (MFA <15 ms mean boundary error; MMS ~43–50 ms per project's established figures). Replace Chirp 2's offsets with aligned offsets. Keep Chirp 2's offsets as a sanity bound and flag any word that moves more than a threshold.
- **Contributes:** the sub-100 ms boundaries that the 95%-well-placed target requires. This is the load-bearing stage.
- **Fails when:** the transcript is wrong. Forced alignment assumes the text is what was said; a Stage-1 hallucination gets confidently aligned to the wrong audio. Guard with a per-line alignment-score threshold and route low scores to Stage 8.
- **Per-language:** MMS covers all 7; MFA needs a language-specific acoustic model and dictionary, which is easy for hi/ta/te but thinner for kn/ml/gu. Default to MMS, use MFA where a good model exists.

### Stage 4 — Length-constrained translation: Vertex Gemini 2.5 Flash
Per line, pass source text, the slot duration in ms from Stage 3, a target character/syllable budget, and neighbouring lines for context. Require structured JSON out. Validate the returned length; retry with a tightened budget on overflow. Attach a Cloud Translation **glossary** for names if you also want terminology pinned.
- **Contributes:** placement indirectly but decisively. A translation that is 40% longer than its slot cannot be placed no matter how good the timing is. This stage is the only place where length is genuinely controllable on Google.
- **Fails when:** the model trades meaning for brevity under a tight budget. Cap the compression ratio and prefer splitting a line over over-compressing it.
- **Per-language:** all 7 have official Translation-LLM support. Dravidian and Gujarati targets expand relative to English; set per-language expansion priors rather than one global budget.

### Stage 5 — Synthesis: Cloud TTS Chirp 3: HD, per line
One request per line, under 5,000 bytes. `speaking_rate` from Stage 4's fit calculation, clamped to [0.25, 2.0]. `[pause]` markup only where a beat is needed, accepting that the model may ignore it.
- **Contributes:** delivery quality, and the only premium tier covering all 7 languages.
- **Fails when:** rendered duration misses the slot; Chirp 3: HD gives you no timepoints and no duration contract, so you cannot know until you measure. Also: 200 requests/minute project cap.
- **Per-language:** the substitution table in 3.3 applies if you choose the timepoint route instead. Telugu is the worst case — Standard voice or no timepoints, pick one.

### Stage 6 — Dub self-verification: forced-align the dub against its own known text
Run MMS/MFA on the synthesized line using the exact text you sent to TTS. Because the text is known and correct by construction, this is a pure alignment problem with no ASR error — cheaper and more reliable than an ASR pass over the dub, and it works for every voice tier including Chirp 3: HD.
- **Contributes:** the measurement that closes the loop. This is what converts "we hope it landed" into a number you can gate on.
- **Fails when:** the synthesized audio is degenerate (truncation, repeated syllables). Detect via alignment score plus a duration-ratio check against Stage 4's prediction.
- **Optional cross-check:** for WaveNet/Neural2/Standard lines, additionally request `enableTimePointing: ["SSML_MARK"]` in `v1beta1` with per-word `<mark>` tags — free, since `<mark>` is excluded from billing. **Assert `len(timepoints) == len(marks)` and reject the synthesis on any shortfall**, and never use `<voice>` in the same SSML as `<mark>`, per the drift bug in 3.4.

### Stage 7 — Fit and place
Compare measured dub word boundaries against Stage-3 source boundaries per line. If drift exceeds tolerance: adjust `speaking_rate` and re-synthesize (up to 2 attempts), then fall back to external time-stretching (WSOLA/rubberband) outside Google, which Google TTS cannot do for you.
- **Contributes:** converts measured error into corrected placement — the difference between measuring 95% and achieving it.
- **Fails when:** the required stretch exceeds what is perceptually acceptable (roughly beyond 0.85–1.15x). At that point the honest fix is upstream: re-translate shorter.

### Stage 8 — Repair queue
Any line failing a Stage 2 merge-confidence, Stage 3 alignment-score, Stage 6 verification or Stage 7 fit gate goes here. Retry with a different biasing set, a second diarizer opinion, or a shorter translation. Report per-video coverage and placement percentages as first-class metrics.
- **Contributes:** the last few points of the 95%. A pipeline without a measured repair loop plateaus wherever its weakest language plateaus.
- **Fails when:** the queue is unbounded. Cap retries and surface the residual honestly rather than shipping silently mis-placed lines.

---

## 9. Where Google alone cannot reach 95%

Stated plainly, with the specific gap in each case:

1. **Word-boundary precision.** Google sells no forced aligner, and no Chirp variant accepts a reference transcript. Chirp 2's ASR timings have already been measured in this project at 43–83% well-placed. The sub-100 ms figures exist only in forced alignment (MFA <15 ms). **Non-Google required: MMS or MFA, hosted on Cloud Run GPU.** This is the gap that alone prevents 95%.
2. **Diarization for 5 of 7 languages.** Confirmed twice in Google's own tables: no diarization for Tamil, Telugu, Kannada, Malayalam or Gujarati on any STT v2 model. **Non-Google required: pyannoteAI, pyannote.audio, or AWS Transcribe.**
3. **Verifying the premium voice's own timing.** Chirp 3: HD ignores `<mark>` and returns no timepoints, so the only tier covering all 7 languages at premium quality is unmeasurable from inside Google. **Non-Google required: forced alignment of the dub** (or accept a WaveNet/Standard downgrade, which in Telugu means Standard).
4. **Exact output duration.** No `mstts:audioduration` equivalent, no SSML `prosody duration`. Only a global `speaking_rate` and a closed loop. **Non-Google required for the residual: external time-stretching.**
5. **Length-constrained translation.** Cloud Translation has no length parameter; adaptive translation offers only an indirect stylistic prior. Google's own Gemini closes this, so it is an in-family fix rather than a third-party one, but it does mean *Cloud Translation* is the wrong product for dubbing.
6. **Speaker count above 6.** Google's diarization config is capped at 6 speakers; AWS handles 30. Matters for crowd scenes.

Everything else — transcription coverage, biasing, translation, premium multilingual synthesis, per-line orchestration — Google does well and cheaply. The 95% target is reachable at ~$0.17 per 3-minute video per language, but **only** with forced alignment and a language-independent diarizer bolted on. Google alone, at ~$0.15, does not get there.

---

## COVERAGE

### Searches counted: 30 (free web search, no Firecrawl `-Search` used)

1. Google Cloud STT v2 chirp_2 word time offsets RecognitionFeatures enable_word_time_offsets
2. Cloud Speech-to-Text V2 supported languages chirp_2 model regions table
3. Google Cloud TTS SSML mark timepoints enable_time_pointing SSML_MARK
4. Google Cloud TTS speakingRate limits AudioConfig 0.25 4.0
5. Chirp 3 HD voices SSML not supported markup limitations
6. Google Cloud TTS supported voices Telugu Malayalam Kannada Gujarati Neural2 Wavenet Standard
7. Google Cloud TTS pricing per million characters Chirp 3 HD Neural2 Standard WaveNet Studio
8. STT v2 chirp_3 model diarization word timestamps unsupported languages
9. STT V2 quotas and limits BatchRecognize concurrent requests per region
10. Cloud Translation Adaptive Translation v3 adaptiveMtTranslate glossary length control
11. Vertex AI forced alignment service word alignment given transcript
12. Google Cloud STT align audio to existing transcript forced alignment not supported
13. Chirp 3 HD voices pace control markup pause tags controllable
14. Google Cloud TTS long audio synthesis timepoints supported voices limitations
15. STT v2 BatchRecognizeRequest processing_strategy DYNAMIC_BATCHING discount
16. chirp_2 chirp_3 billing price per minute STT V2 SKU pricing tier
17. Vertex AI Model Garden Whisper large v3 deploy endpoint
18. Cloud Run GPU pricing per second nvidia L4 2026
19. Cloud Translation supported languages adaptive translation Telugu Kannada Malayalam Gujarati
20. STT v2 SpeakerDiarizationConfig min_speaker_count max_speaker_count
21. pyannote audio 3.1 speaker diarization DER benchmark
22. Google TTS timepoints only returns until first period bug SSML mark
23. STT release notes chirp_3 word level timestamps 2026
24. Vertex AI Gemini 2.5 Flash pricing per million input output tokens
25. Montreal Forced Aligner accuracy milliseconds word boundary MMS wav2vec2
26. Amazon Transcribe speaker diarization supported languages Tamil Telugu pricing
27. pyannoteAI API pricing per hour premium diarization
28. Google Cloud TTS long audio synthesis quotas 1 million bytes Chirp3
29. Chirp 3 HD voices regional availability global us eu endpoint
30. STT v2 recognizer inline default recognizer explicit_decoding_config sample rate

### Pages fetched with Firecrawl: 27 (23 billed, 4 served from local cache)

| # | File | URL |
| --- | --- | --- |
| 1 | notes_gcp_1.md | https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model (cached) |
| 2 | notes_gcp_2.md | https://cloud.google.com/speech-to-text/pricing (cached) |
| 3 | notes_gcp_3.md | https://cloud.google.com/text-to-speech/docs/reference/rest/v1beta1/text/synthesize |
| 4 | notes_gcp_4.md | https://cloud.google.com/python/docs/reference/texttospeech/2.23.0/google.cloud.texttospeech_v1.types.AudioConfig |
| 5 | notes_gcp_5.md | https://cloud.google.com/text-to-speech/docs/chirp3-hd |
| 6 | notes_gcp_6.md | https://cloud.google.com/text-to-speech/docs/list-voices-and-types |
| 7 | notes_gcp_7.md | https://cloud.google.com/text-to-speech/pricing |
| 8 | notes_gcp_8.md | https://cloud.google.com/speech-to-text/v2/docs/chirp_3-model |
| 9 | notes_gcp_9.md | https://cloud.google.com/text-to-speech/quotas |
| 10 | notes_gcp_10.md | https://cloud.google.com/speech-to-text/quotas (v1) |
| 11 | notes_gcp_11.md | https://docs.cloud.google.com/speech-to-text/docs/quotas (v2) |
| 12 | notes_gcp_12.md | https://cloud.google.com/translate/docs/advanced/adaptive-translation |
| 13 | notes_gcp_13.md | https://cloud.google.com/translate/pricing |
| 14 | notes_gcp_14.md | https://cloud.google.com/speech-to-text/v2/docs/speech-to-text-supported-languages |
| 15 | notes_gcp_15.md | https://cloud.google.com/text-to-speech/docs/ssml |
| 16 | notes_gcp_16.md | https://cloud.google.com/run/pricing |
| 17 | notes_gcp_17.md | https://cloud.google.com/text-to-speech/docs/gemini-tts |
| 18 | notes_gcp_18.md | https://cloud.google.com/speech-to-text/v2/docs/multiple-voices |
| 19 | notes_gcp_19.md | https://cloud.google.com/translate/docs/languages |
| 20 | notes_gcp_20.md | https://discuss.google.dev/t/voice-tag-conflicts-with-mark-timestamps-wrong/271851 |
| 21 | notes_gcp_21.md | https://discuss.google.dev/t/ssml-mark-timepointing-v1beta1-suddenly-only-returns-the-timepoints-until-first-period/104868 |
| 22 | notes_gcp_22.md | https://cloud.google.com/speech-to-text/docs/release-notes (cached) |
| 23 | notes_gcp_23.md | https://cloud.google.com/vertex-ai/generative-ai/pricing |
| 24 | notes_gcp_24.md | https://www.pyannote.ai/pricing |
| 25 | notes_gcp_25.md | https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html (cached) |
| 26 | notes_gcp_26.md | https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html |
| 27 | notes_gcp_27.md | https://cloud.google.com/text-to-speech/docs/endpoints |

Additional sources cited from search snippets without a full fetch: [RecognitionFeatures PHP reference](https://cloud.google.com/php/docs/reference/cloud-speech/1.19.1/V2.RecognitionFeatures), [ProcessingStrategy](https://cloud.google.com/python/docs/reference/speech/2.24.1/google.cloud.speech_v2.types.BatchRecognizeRequest.ProcessingStrategy), [SpeakerDiarizationConfig](https://cloud.google.com/ruby/docs/reference/google-cloud-speech-v2/0.13.1/Google-Cloud-Speech-V2-SpeakerDiarizationConfig), [batch-recognize overview](https://cloud.google.com/speech-to-text/v2/docs/batch-recognize), [recognizers](https://cloud.google.com/speech-to-text/v2/docs/recognizers), [v2 migration](https://cloud.google.com/speech-to-text/v2/docs/migration), [TTS voices note on Chirp 3 SSML](https://cloud.google.com/text-to-speech/docs/voices?hl=en), [long audio quickstart](https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-long-audio-synthesis), [Translation quotas](https://cloud.google.com/translate/quotas), [glossary guide](https://docs.cloud.google.com/translate/docs/advanced/glossary), [Cloud Run GPU](https://g.co/cloudrun/gpu), [Model Garden Whisper notebook](https://github.com/GoogleCloudPlatform/vertex-ai-samples/blob/main/notebooks/community/model_garden/model_garden_pytorch_whisper_large_v3_deployment.ipynb), [arXiv 2606.18466](https://arxiv.org/html/2606.18466v1), [arXiv 2406.19363](https://arxiv.org/html/2406.19363v1), [arXiv 2509.26177](https://arxiv.org/html/2509.26177v1), [pyannoteAI changelog](https://www.pyannote.ai/changelog), [pyannoteAI billing](https://docs.pyannote.ai/administration/billing), [Amazon Transcribe pricing](https://aws.amazon.com/transcribe/pricing/), [Vertex AI intro](https://cloud.google.com/vertex-ai/docs/start/introduction-unified-platform), [Model Alignment library](https://ai.google.dev/responsible/docs/alignment/model-alignment), [unreliable timepoints report](https://stackoverflow.com/questions/70481000/unreliable-timepoints-with-google-text-to-speech-v1beta1-russian), [hyphenated-word timestamp report](https://discuss.google.dev/t/text-to-speech-hyphenated-words-getting-0-timestamp/127417), [diarization model comparison](https://brasstranscripts.com/blog/speaker-diarization-models-comparison), [Amazon Transcribe price summary](https://brasstranscripts.com/blog/amazon-transcribe-pricing-2026-cost-calculator-guide), [MFA precision summary](https://www.emergentmind.com/topics/montreal-forced-aligner-mfa).

### Firecrawl credits

- Balance at start: **749**
- Balance at end: **726**
- **Credits spent: 23** (of the 200 budget; 4 pages were free cache hits). `-Search` never invoked. No PDFs fetched. Reddit not attempted.

### Verification status

- Verified against official Google docs: chirp_2/chirp_3 API shape, regions, language and feature tables; STT and TTS quotas; STT, TTS, Translation, Vertex and Cloud Run prices; timepoint API surface; SSML tag support; speakingRate ranges; voice tiers per language.
- **Not verified:** the exact billing SKU for `chirp_2` and `chirp_3` (the pricing page does not name them). Chirp 3's word-timestamp status is self-contradictory in Google's own doc and is treated as unsupported here. Latency figures for Cloud Run GPU alignment (~40 s per 3-min clip) are estimates, not measurements — benchmark before committing to the cost table. Per-language AWS Transcribe diarization support is inferred from the absence of a language restriction in the diarization doc, not from an explicit support matrix.
