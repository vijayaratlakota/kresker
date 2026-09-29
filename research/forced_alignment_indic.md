# Forced alignment and speech-onset refinement for Indic languages

Scope: pick a tool + acoustic model that puts **line starts** inside ~100 ms for Hindi, Telugu, English, Malayalam, Kannada, Tamil, Gujarati, and build a **trustworthy "this line is misplaced" signal**. Written to extend the project's existing finding that a monotonic CTC alignment path scored 0.936 on 100 %-Hindi audio against Telugu text, i.e. path confidence is not a wrong-language detector.

---

## 0. Decision summary

1. **Nothing beats a GMM-HMM aligner with a matched language model on boundary precision.** MFA 3.0 reports mean boundary error below 15 ms on all four of its benchmarks, while MMS-based CTC alignment sits at ~43–50 ms mean and WhisperX at ~110 ms mean word-boundary error on the same data ([MFA 2026, arXiv:2606.18466](https://arxiv.org/html/2606.18466v1)).
2. **Official MFA ships no Indic acoustic model.** Its 20 core pretrained languages contain no Indian language; only English has an *India* dialect in its training mix ([MFA 2026 Table 1](https://arxiv.org/html/2606.18466v1)).
3. **The gap is filled by [AI4Bharat/IndicMFA](https://github.com/AI4Bharat/IndicMFA)**: acoustic model + grapheme-to-grapheme (G2G) dictionary for all 22 scheduled Indian languages, including all six non-English source languages here. No published boundary error, and the training corpora are read/studio speech, so it must be measured on film audio before trusting it.
4. **MMS_FA is a competent fallback but is licensed CC-BY-NC 4.0** ([torchaudio MMS_FA](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html)) and has **no word-boundary token**, so word spans are inferred rather than modelled. On unseen languages it lands ~63–77 % of word starts within 50 ms and ~76–95 % within 100 ms ([arXiv:2606.10675 Table 4](https://arxiv.org/html/2606.10675v1)) — below a 95 %-at-100 ms target for some languages.
5. **The misplacement signal must be a composite, not a confidence number.** The single most valuable primitive is **min-pooled window confidence** from CTC segmentation (min over sub-windows of mean frame probability), which is designed to penalise *localised* mismatch instead of averaging it away ([Kürzinger et al. 2020, arXiv:2007.09127v2](https://arxiv.org/pdf/2007.09127v2)). Pair it with a re-decode check and a per-line language ID, because no alignment-internal score is language-aware.

---

## 1. Tool comparison

Published word-level boundary accuracy. "Mean" = mean boundary error (ms, lower better). "t≤N" = % of boundaries within N ms. TIMIT is read speech, Buckeye conversational.

| Tool | Type | Frame/stride | Boundary accuracy (source) | Indic support | Reject / confidence output |
|---|---|---|---|---|---|
| **MFA 3.4** | GMM-HMM (Kaldi/Kalpy) | 10 ms hop, 25 ms window ([2406.19363](https://arxiv.org/html/2406.19363v1)) | TIMIT mean **19.93**, t≤10 **44.99**, t≤50 **91.61**, t≤100 **98.38**; Buckeye mean **21.75**, t≤50 **91.35** ([MFA 2026 T4](https://arxiv.org/html/2606.18466v1)). MFA 3.0 vs 1.0: TIMIT 16.4→**12.1** ms, Buckeye 17.6→**13.9**, Korean 20.7→**14.8** | Via IndicMFA (community) | **Best in class**: `alignment_analysis.csv` with log-likelihood, speech log-likelihood, phone duration deviation, max running short intervals, intensity deviation, SNR ([docs](https://montreal-forced-aligner.readthedocs.io/en/stable/user_guide/implementations/alignment_analysis.html)) |
| **MAUS** | HMM | – | TIMIT mean 17.89, t≤10 51.96; Buckeye mean 32.78 ([MFA 2026 T4](https://arxiv.org/html/2606.18466v1)) | No | – |
| **Charsiu** | neural frame classifier | – | TIMIT mean 27.18; Buckeye 29.24 ([ibid.](https://arxiv.org/html/2606.18466v1)) | No (English) | – |
| **MAPS** | neural | – | TIMIT mean 18.86, t≤10 54.77; Buckeye mean **54.44** (degrades badly) ([ibid.](https://arxiv.org/html/2606.18466v1)) | No | – |
| **BFA** | neural CTC | – | TIMIT mean 52.01; Buckeye 61.54 ([ibid.](https://arxiv.org/html/2606.18466v1)) | No | – |
| **torchaudio MMS_FA / `forced_align`** | wav2vec2 CTC + Viterbi | 20 ms (wav2vec2) | TIMIT mean **43.06**, t≤10 13.05, t≤50 63.73, t≤100 95.91; Buckeye mean **49.54**, t≤100 92.05 ([MFA 2026 T4](https://arxiv.org/html/2606.18466v1)). Independent: TIMIT 18.6/43.5/75.7/94.7, Buckeye 25.0/52.7/75.0/87.9 ([2406.19363 T1–T2](https://arxiv.org/html/2406.19363v1)) | **All 7** (1,130 languages via romanisation) | Per-token path score + `<star>` token for missing transcript ([tutorial](https://docs.pytorch.org/audio/main/tutorials/ctc_forced_alignment_api_tutorial.html)) |
| **ctc-forced-aligner** | same MMS checkpoint, leaner | 20 ms | not independently benchmarked; same model class as MMS_FA | **All 7** (`--romanize`, ISO-639-3) | per-word scores; `--star_frequency segment\|edges` ([README](https://github.com/MahmoudAshraf97/ctc-forced-aligner)) |
| **WhisperX align** | wav2vec2 CTC per language | 20 ms | TIMIT mean **110.04**, t≤100 53.98; Buckeye mean **110.90**, t≤100 57.38 ([MFA 2026 T4](https://arxiv.org/html/2606.18466v1)). Independent: TIMIT t≤10 22.4, t≤100 94.2 ([2406.19363](https://arxiv.org/html/2406.19363v1)) | hi, te, ml only (see §3) | none built in; VAD cut&merge helps long-form ([arXiv:2303.00747](https://arxiv.org/abs/2303.00747)) |
| **NeMo Forced Aligner** | any NeMo CTC or hybrid-CTC model | 40–80 ms typical (model subsampling) | TIMIT mean **78.24**, t≤100 70.03; Buckeye mean **88.62**, t≤100 63.09 ([MFA 2026 T4](https://arxiv.org/html/2606.18466v1)) | **All 7 minus English** via IndicConformer (§4) | `align_using_pred_text` = built-in second-pass verification ([docs](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/tools/nemo_forced_aligner.html)) |
| **CTC segmentation** (Kürzinger et al.) | CTC + constrained Viterbi | model-dependent | not reported as ms error; designed for utterance extraction from long audio | any CTC model | **`s_seg` = min over windows of mean frame prob**; discard below 0.22 ([paper](https://arxiv.org/pdf/2007.09127v2)) |
| **stable-ts** | Whisper + post-hoc | Whisper token grid | not benchmarked against gold boundaries | any Whisper language | `failure_threshold` (abort if % zero-duration words too high), `refine()` mute-and-probe ([README](https://github.com/jianfch/stable-ts)) |
| **aeneas** | TTS + Sakoe-Chiba DTW on MFCCs | fragment level | no acoustic model, no published ms figures | any language with an eSpeak voice | none | 
| **Gentle** | Kaldi, English only | 10 ms | – | **none** — maintainers confirm no non-English models implemented ([issue #144](https://github.com/lowerquality/gentle/issues/144)) | – |
| **Canary-1B** (as aligner) | seq2seq | – | TIMIT t≤100 **72.81**, Buckeye 63.29 ([2606.10675 T3](https://arxiv.org/html/2606.10675v1)) | no | – |
| **MWA** (research, 2026) | MMS + UnSupSeg + learned DP | 10 ms | TIMIT t≤10 **58.0**, t≤100 97.8; Buckeye t≤10 49.7, t≤100 94.2 — best published; transfers to unseen languages ([arXiv:2606.10675](https://arxiv.org/html/2606.10675v1)) | untested on Indic; no release stated | – |

MFA current version: **3.4.2** stable; 3.4 added `mfa compare_alignments`, a Hugging Face model format with `mfa align_hf`, and SNR/intensity-deviation diagnostics. MFA 4.0 (planned end-2026) makes the HF commands the defaults; MFA 5.0 (2027) plans neural acoustic models ([changelog](https://montreal-forced-aligner.readthedocs.io/en/stable/changelog/index.html), [3.4 changelog](https://montreal-forced-aligner.readthedocs.io/en/stable/changelog/changelog_3.4.html)).

---

## 2. Per-language model availability (the 7 source languages)

| Language | MFA official acoustic model | IndicMFA (AI4Bharat) acoustic + G2G dict, hours | MMS_FA / ctc-forced-aligner | WhisperX default align model | IndicConformer-600M CTC |
|---|---|---|---|---|---|
| **Hindi** | ✗ | ✓ **255.33 h** (IndicTTS, IndicVoices-R, Limmits) | ✓ (`hin`, romanised) | ✓ `theainerd/Wav2Vec2-large-xlsr-hindi` | ✓ `hi` |
| **Telugu** | ✗ | ✓ **261.77 h** (IndicTTS, IV-R, Limmits, Google CS) | ✓ (`tel`) | ✓ `anuragshas/wav2vec2-large-xlsr-53-telugu` | ✓ `te` |
| **English** | ✓ `english_mfa` / `english_us_arpa` (3.5 k h, incl. Indian English variety) | n/a | ✓ (`eng`) | ✓ `WAV2VEC2_ASR_BASE_960H` | ✗ (22 Indian languages only) |
| **Malayalam** | ✗ | ✓ **197.08 h** (IndicTTS, IV-R, Rasa) | ✓ (`mal`) | ✓ `gvs/wav2vec2-large-xlsr-malayalam` | ✓ `ml` |
| **Kannada** | ✗ | ✓ **193.81 h** (IndicTTS, IV-R, Limmits, Google CS, Rasa) | ✓ (`kan`) | ✗ **no default** → `ValueError` | ✓ `kn` |
| **Tamil** | ✗ | ✓ **300.48 h** (IndicTTS, IV-R, Rasa) | ✓ (`tam`) | ✗ **no default** | ✓ `ta` |
| **Gujarati** | ✗ | ✓ **42.9 h** (weakest — IndicTTS, IV-R) | ✓ (`guj`) | ✗ **no default** | ✓ `gu` |

Sources: [MFA 2026 Table 1 language list](https://arxiv.org/html/2606.18466v1) (Bulgarian, Czech, English, French, German, Hausa, Japanese, Korean, Mandarin, Polish, Portuguese, Russian, Serbo-Croatian, Spanish, Swahili, Swedish, Thai, Turkish, Ukrainian, Vietnamese — no Indian language); [MFA pretrained-models docs](https://montreal-forced-aligner.readthedocs.io/en/stable/user_guide/models/index.html); [IndicMFA README table](https://github.com/AI4Bharat/IndicMFA); [whisperX/alignment.py `DEFAULT_ALIGN_MODELS_*`](https://raw.githubusercontent.com/m-bain/whisperX/main/whisperx/alignment.py); [IndicConformer-600M card](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual).

Notes that matter operationally:

- MFA 3.0 dictionaries cover 22 languages plus 34 more via the [VoxCommunis](http://acl.ldc.upenn.edu/2022.lrec-1.566/) lexicons (Common Voice-derived, 36 languages at release). Indic coverage there is thin and I did not verify per-language, so treat VoxCommunis as a *dictionary* source, not an acoustic-model source.
- **IndicMFA uses G2G, not G2P**: the dictionary maps each grapheme to itself, so the "phone" set is the alphabet ([README](https://github.com/AI4Bharat/IndicMFA)). That removes G2P/OOV risk for Indic scripts and is a real advantage for messy transcripts, but it means the acoustic model must absorb all the grapheme→sound irregularity, and it will not handle Latin-script English insertions in a Devanagari transcript at all.
- **Gujarati at 42.9 h is the weak link** — an order of magnitude less than Tamil/Telugu. Expect it to be the worst of the seven and budget a manual gold set there first.
- IndicConformer-600M is gated on Hugging Face (contact info required) and has **no English**, so a code-mixed or English-source pipeline needs a second model.

### Code-mixed Hindi-English

There is **no publicly released code-mixed Hindi-English MFA model.** There is a published recipe with numbers ([arXiv:2607.25581](https://arxiv.org/html/2607.25581v1), code at [Ayushi113/mfa-hindi-code-mixed](https://github.com/Ayushi113/mfa-hindi-code-mixed)), trained on the 6,941-utterance, 113-speaker PBCM read-speech corpus with MFA v1.0:

| Training data for the acoustic model | mean abs. error of phone midpoints | <10 ms | <20 ms | <30 ms | <50 ms |
|---|---|---|---|---|---|
| **code-mixed sentences** | **4.15 ms** | 87.06 % | 98.26 % | 99.47 % | 99.78 % |
| monolingual Hindi chunks | 38.18 ms | 48.10 % | 68.71 % | 77.81 % | 83.76 % |
| isolated English words | 37.58 ms | 41.89 % | 68.29 % | 79.05 % | 84.82 % |

Two findings from that paper transfer directly:

- **Lexicon design is worth as much as the acoustic model.** Because the Devanagari *nuqta* is routinely omitted, default eSpeak G2P puts /pʰ/ where speakers produce /f/. Fixing the lexicon moved the pʰ~f F-score from 0.72 (no mapping) to 0.97 (de-aspirating pʰ→p) to 1.00 (mapping to the majority realisation). For ʤ~z, mapping both voiced targets to voiceless proxies reached F 0.74 vs 0.16 unmapped.
- **Do not port the 4.15 ms number to film audio.** It is read speech, phone *midpoints* (not line starts), and the code-mixed model was trained and evaluated on the same corpus. Treat it as evidence that *in-domain training data wins by ~10×*, not as an expected error.

### Training your own

`mfa train` runs monophone → triphone → LDA-triphone → SAT (×2, with pronunciation-probability estimation) and finishes on the full corpus, with progressively noisier data introduced at 10 k / 20 k / 50 k / 150 k utterance stages ([MFA 2026 §3.1.3 + Table 2](https://arxiv.org/html/2606.18466v1); [`mfa train` docs](https://montreal-forced-aligner.readthedocs.io/en/latest/user_guide/workflows/train_acoustic_model.html)). `mfa train_g2p` builds a G2P model from a dictionary; `mfa adapt` adapts a pretrained model. For unseen languages, **adapting a large English model can beat training from scratch** ([arXiv:2504.07315](https://arxiv.org/html/2504.07315v2)), and MFA 3.0 adds `mfa remap dictionary` / `mfa remap alignments` for cross-language phone-set remapping.

Counter-evidence worth internalising: **a mismatched MFA model fails catastrophically, not gracefully.** On the Dutch IFA corpus MFA placed only **19 %** of word boundaries within 100 ms, while MMS got 76.6 % ([arXiv:2606.10675 Table 4](https://arxiv.org/html/2606.10675v1)). Architecture is not the deciding variable; model-to-data match is.

---

## 3. torchaudio MMS_FA / CTC forced alignment vs MFA

**What it is.** `MMS_FA` is a wav2vec2 CTC model trained on 31 k hours in 1,130 languages, published under **CC-BY-NC 4.0** ([model page](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html)). `torchaudio.functional.forced_align()` is the Viterbi core, developed alongside [Scaling Speech Technology to 1,000+ Languages](https://arxiv.org/abs/2305.13516); the higher-level `Wav2Vec2FABundle` wraps model + tokenizer + aligner ([API tutorial](https://docs.pytorch.org/audio/main/tutorials/ctc_forced_alignment_api_tutorial.html)).

**Which languages actually work.** All seven are inside MMS's language set, but only *through romanisation*. The torchaudio multilingual tutorial states plainly that normalisation, which involves romanising non-English text, is language-dependent and is left to the user ([tutorial](https://docs.pytorch.org/audio/2.4.0/tutorials/forced_alignment_for_multilingual_data_tutorial.html)). In practice that means [uroman](http://www.aclweb.org/anthology/P18-4003.pdf). Two consequences:

- Romanisation is lossy for exactly the contrasts Indic languages use. Even the scholarly IAST scheme is described as losslessly reversible *except* for Dravidian scripts, which need long/short mid-vowel distinctions ([Devanagari transliteration](https://en.wikipedia.org/wiki/Devanagari_transliteration)). Aspiration and retroflexion collapse toward the same Latin graphemes, so token-level confusability rises for Hindi/Gujarati (aspirates) and Tamil/Telugu/Kannada/Malayalam (retroflex + vowel length).
- Romanised-input degradation is a measured phenomenon in Indic NLP generally (5–12 F1 points, up to 24 in some settings, for romanised vs native-script Indian-language text) ([arXiv:2512.10780](https://arxiv.org/abs/2512.10780)). Not an alignment study, but it is the same information-loss mechanism.

**Known limitations, ranked by how much they hurt this project.**

1. **No reject option.** This is the project's own finding and it is structural: CTC-family objectives tolerate grossly wrong text. Training ASR with an order-agnostic CTC variant avoids degradation with transcripts containing up to **70 %** errors, where standard CTC fails ([arXiv:2309.15796](https://arxiv.org/html/2309.15796v1)) — i.e. the CTC alignment surface is smooth enough to accommodate near-garbage. The only built-in escape is the **`<star>` token**, which `forced_align()` supports for missing transcript ([tutorial](https://docs.pytorch.org/audio/main/tutorials/ctc_forced_alignment_api_tutorial.html)) and which ctc-forced-aligner exposes as `--star_frequency segment|edges` ([README](https://github.com/MahmoudAshraf97/ctc-forced-aligner)).
2. **No word-boundary token.** The model card explicitly notes MMS_FA lacks a `|`-style word-boundary token, which changes alignment post-processing ([model page](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html)). Word starts are therefore the start of the first character token, with no learned silence/boundary model — unlike MFA, which models inter-word silence explicitly.
3. **20 ms stride** vs MFA's 10 ms hop, halving the achievable resolution before any modelling error.
4. **Licence.** CC-BY-NC 4.0 blocks commercial use of the checkpoint. If the dubbing pipeline is commercial, MMS_FA is a research/eval tool only; IndicConformer (MIT per its card) or self-trained MFA models are the shippable paths.
5. **Chunking artifacts.** ctc-forced-aligner defaults to a 30 s window with 2 s overlap; users report degraded scores on trimmed/short audio relative to the reference torchaudio implementation ([issue #62](https://github.com/MahmoudAshraf97/ctc-forced-aligner/issues/62)).

**Versus MFA.** MMS_FA wins on: zero setup, all 1,130 languages, no dictionary, works on wrong-script/dirty text without OOV failures. MFA wins on: ~2× better mean boundary error, 10 ms resolution, explicit silence modelling, per-utterance diagnostics, and adaptability. For a 7-language dubbing pipeline the pragmatic split is **MFA/IndicMFA as primary, MMS_FA as the independent second opinion** (§5-H).

---

## 4. IndicConformer-600M as an aligner

**Feasible, and there is precedent.** IndicConformer-600M-Multi is a Conformer **hybrid CTC + RNNT** model over 22 Indian languages, callable in either decoding mode ([model card](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual)). NeMo Forced Aligner explicitly accepts *CTC models, or hybrid CTC-Transducer models in CTC mode*, and rejects pure transducers ([NFA docs](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/tools/nemo_forced_aligner.html)) — so it is a drop-in.

**Precedent:** AI4Bharat's own [BhasaAnuvaad](https://github.com/AI4Bharat/BhasaAnuvaad) pipeline uses the NeMo Forced Aligner (their NeMo fork) to align sentences to audio chunks for Indian languages, then filters with SONAR text embeddings and cosine similarity. That is exactly the "align, then verify semantically" pattern §5-J recommends.

**How to extract frame-level alignment.**

1. Run NFA directly: build a NeMo manifest with `audio_filepath` + `text`, point `model_path` at the IndicConformer `.nemo` checkpoint, and take the `ctm/{tokens,words,segments}/*.ctm` outputs ([NFA docs](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/tools/nemo_forced_aligner.html)). Useful knobs: `additional_segment_grouping_separator` (default `. ? ! ...`) to control segment granularity, `use_local_attention` (sets Conformer local context to [64,64]) for long files, and `minimum_timestamp_duration` — **leave that at 0**, because non-zero values widen short intervals from the midpoint outwards and will destroy the "collapsed token" misplacement signal.
2. Or do it by hand: get the CTC head's log-probs, then `torchaudio.functional.forced_align()` over your token sequence. This gives you the frame-level posterior matrix, which you need anyway for the confidence measures in §5.
3. **Measure the frame stride empirically** before quoting any precision figure. Conformer/FastConformer encoders subsample heavily, so effective stride is typically 40 ms or 80 ms, not 10 ms. Compute it as `total_audio_frames / logprob_frames` on a known-length file. This is a hard floor: an 80 ms stride cannot deliver <100 ms line starts reliably, which is consistent with NFA's measured 78–89 ms mean word-boundary error in the MFA 2026 benchmark. If IndicConformer turns out to be 80 ms, use it for *verification and misplacement scoring*, not for final boundary placement.

Caveats: no English; gated download; NFA docs state only English has been tested so far for the aligner path.

---

## 5. How to get a trustworthy misplacement signal

The project's 0.936-on-wrong-language result is the expected behaviour of an averaged path score. Every fix below either (a) replaces averaging with a min/tail statistic, (b) gives the aligner an explicit way to say "not here", or (c) adds a second, *independent* modality. Use several and combine.

### A. Min-pooled window confidence (highest value / lowest effort)

From CTC segmentation: split the frames assigned to an utterance into parts of length *L*, take the mean frame probability *m_j* per part, and define the utterance score as **`s_seg = min_j m_j`**. The paper's stated rationale is that this penalises mismatch even when a single word is missing from a long utterance — precisely the failure that mean-pooling hides. They discarded alignments with `s_seg < 0.22` (≈ −1.5 in log space) ([arXiv:2007.09127v2](https://arxiv.org/pdf/2007.09127v2)).

Concretely for this pipeline:
```
for each line L with frame span [t0, t1]:
    p[t] = exp(logprob[t, path_token[t]])        # frame prob along the Viterbi path
    windows = chunks(p[t0:t1], L = 25 frames)    # ~0.5 s at 20 ms stride
    s_seg = min(mean(w) for w in windows)
    flag if s_seg < THRESH   # calibrate per language on a gold set; 0.22 is the published start
```
A 100 %-wrong-language line cannot keep *every* 0.5 s window plausible, whereas it can easily keep the average plausible.

### B. Entropy-based confidence with **min** aggregation

Instead of raw path probability, use per-frame entropy. NVIDIA's guidance: Tsallis/Rényi entropy beats raw probabilities, **minimum aggregation is preferred because it minimises confidence for incorrect words**, and an entropic index of 1/3 is the recommended starting point ([NVIDIA blog](https://developer.nvidia.com/blog/entropy-based-methods-for-word-level-asr-confidence-estimation/), [arXiv:2212.08703](https://arxiv.org/abs/2212.08703)). An independent evaluation found a strong baseline is temperature-scaled logits → negative entropy of the predictive distribution → sum-pooling to word level ([arXiv:2101.05525](https://arxiv.org/abs/2101.05525)). Note that entropy is *posteriorgram sharpness*, which is a different axis from path probability: wrong-language audio can produce a confident-but-wrong posteriorgram, so use A and B together, not interchangeably.

### C. `<star>` mass — give the aligner an explicit "not here"

Insert `<star>` tokens between words (or at segment edges) and measure the fraction of frames in a line's span whose Viterbi path sits on `<star>`. This converts an unfalsifiable monotonic path into a testable one: if the text is present, star mass should be near zero; if a chunk of audio has no corresponding text (or vice versa), the path routes through the star. Supported natively by `torchaudio.functional.forced_align()` ([tutorial](https://docs.pytorch.org/audio/main/tutorials/ctc_forced_alignment_api_tutorial.html)) and configurable in ctc-forced-aligner via `--star_frequency` ([README](https://github.com/MahmoudAshraf97/ctc-forced-aligner)).

```
star_mass(L) = frames_on_star_in(L) / total_frames_in(L)
flag if star_mass > 0.15    # calibrate
```

### D. Second-pass verification by re-decoding (the language-aware check)

This is the one that actually catches wrong language.

- NFA implements it as a flag: `align_using_pred_text` transcribes the audio with the ASR model and uses *that* as the reference for alignment, saving `pred_text` in the output manifest ([NFA docs](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/tools/nemo_forced_aligner.html)).
- The MFA 2026 paper recommends the same pattern in reverse: generate transcripts with WhisperX or SpeechBrain and check them against the original transcripts to discover data issues ([arXiv:2606.18466](https://arxiv.org/html/2606.18466v1)).

Algorithm:
```
for each line L:
    span = audio[start(L) - 0.2s : end(L) + 0.2s]
    hyp  = free_decode(span, model = ASR_for_declared_language)
    cer  = CER(normalise(hyp), normalise(text(L)))
    flag if cer > 0.6            # misplaced or wrong-language
    warn if 0.35 < cer <= 0.6    # partially misplaced / boundary drift
```
Free decoding has no monotonic constraint tying it to your text, so it is genuinely independent of the alignment. Cost is one extra ASR pass over flagged spans only, if you gate it on A/C.

### E. Per-line spoken language ID

Because alignment confidence provably cannot detect wrong language, detect it directly. Run a spoken-LID over each line's span and flag `argmax ≠ declared source language`. Indic-specific options exist: a VANI-based LID covering 42 Indian languages ([ARTPARK-IISc](https://huggingface.co/blog/ARTPARK-IISc/vaani-lid)), and for the text side [IndicLID](https://github.com/AI4Bharat/IndicLID) handles all 22 languages including romanised text — useful for validating the *transcript* language before you align. Note the hard part is that Indic LID suffers from heavy phonetic overlap among related varieties and scarce labels for low-resource languages ([arXiv:2606.09317](https://arxiv.org/html/2606.09317)), so use LID as a flag with a margin, not a hard gate.

### F. MFA's own diagnostics (free, if you use MFA)

Exporting TextGrids also writes `alignment_analysis.csv` ([docs](https://montreal-forced-aligner.readthedocs.io/en/stable/user_guide/implementations/alignment_analysis.html)):

| Column | What it is | How to use it |
|---|---|---|
| Alignment log-likelihood | objective optimised for that utterance | **weak signal** — the docs stress it is a *relative* measure for the best path of that utterance, distorted by speaker adaptation and train/test domain differences. Matches the project's finding. |
| Speech log-likelihood | same, with silence intervals removed, averaged per phone | better than the above; removes silence-length bias |
| Phone duration deviation | **max absolute z-score of each phone's log-duration** | strong. Docs note misalignment inflates some durations and crushes others, so mean z-scores cancel out while the max does not — same min/max logic as §A |
| **Max running short intervals** | longest run of intervals ≤10 ms | strong and cheap: long runs indicate significant parts of the transcript were not aligned or were squashed at the file edges |
| Intensity deviation, SNR | added in MFA 3.4 ([changelog](https://montreal-forced-aligner.readthedocs.io/en/stable/changelog/changelog_3.4.html)) | catches lines placed on music/noise rather than speech |

The docs also warn that duration statistics are corpus-level, not per-speaker, so false positives are expected — and explicitly prefer false positives over false negatives. That is the right trade for a dubbing QC gate.

### G. Collapsed/zero-duration token rate

The generic version of "max running short intervals". stable-ts ships it as `failure_threshold`: abort alignment when the percentage of words with zero duration exceeds the threshold ([README](https://github.com/jianfch/stable-ts)). Implement as `frac(words with duration <= 1 frame) > 0.1 → flag`.

### H. Cross-aligner / ensemble disagreement

Run two independent aligners on the same line and flag disagreement. Formal version: an ensemble of ten segment-classifier networks, boundary placed at the ensemble median, 97.85 % confidence intervals from order statistics; the authors state CI width is a useful heuristic for detecting errorful alignments and may allow scoring how well a transcription matches the acoustics ([arXiv:2506.01256](https://arxiv.org/html/2506.01256v1), also in [Phonetica](https://www.degruyterbrill.com/document/doi/10.1515/phon-2025-0039/html)).

Cheap version here: `|start_IndicMFA(L) − start_MMS_FA(L)| > 150 ms → flag`. The two systems share almost no failure modes (GMM-HMM + native-script G2G dictionary vs CTC + romanised text), so agreement is meaningful. This is also the single best way to launder the fact that neither system can self-report a wrong-language error.

### I. Alignment-vs-VAD disagreement

Flag a line if its start lands in a VAD-silent region, or if its span contains no VAD speech at all:
```
flag if vad_speech_fraction(span(L)) < 0.35
flag if distance(start(L), nearest_vad_onset) > 400 ms
```
Asymmetry to be honest about: this reliably catches *gross* misplacement (line dropped onto silence, music, or a gap) and is nearly useless for swaps between two adjacent speech regions — which is the dominant failure of a monotonic aligner. Use it as a cheap pre-filter, not as the main detector.

### J. Semantic verification

For lines that pass phonetic checks but may carry the wrong *content*, embed the re-decode (§D) and the expected line with a multilingual sentence encoder and threshold cosine similarity. This is what BhasaAnuvaad does at corpus scale with SONAR ([repo](https://github.com/AI4Bharat/BhasaAnuvaad)). It survives ASR noise better than CER and is the right check when the source transcript came from a translation/LLM step.

### K. Monotonic-drift monitor

Forced alignment is monotonic, so one misplaced line pushes its neighbours. The tell is a huge gap between mean and median error: on Buckeye, WhisperX word alignment shows mean **11,685 ms** against median **30.1 ms**, and even MFA shows mean **976.5 ms** vs median **13.6 ms** ([arXiv:2406.19363 Table 3](https://arxiv.org/html/2406.19363v1)). A handful of runaway segments dominates. Two implications:

- **Report median and P95, never mean.** A mean will hide exactly the failures you are chasing.
- Detect the runs: fit a robust (RANSAC/Theil-Sen) line to `predicted_start` vs `line_index` over trusted anchors, and flag contiguous runs whose residuals exceed a threshold with the same sign. Also re-anchor: align in windows bounded by high-confidence anchors, in the spirit of the iterative pseudo-forced-alignment approach, where temporal anchors are set from the confidence score of the last aligned utterance and low-confidence alignments are filtered out ([arXiv:2210.15226v2](https://arxiv.org/abs/2210.15226v2)).

### Recommended composite gate

```
score(L) = w1·[s_seg < 0.22]                      # A, min-pooled window confidence
         + w2·[min-aggregated entropy conf < τ]   # B
         + w3·[star_mass > 0.15]                  # C
         + w4·[re-decode CER > 0.6]               # D  ← the wrong-language catcher
         + w5·[LID ≠ declared language]           # E
         + w6·[max |z| log-duration > 4]          # F
         + w7·[collapsed-token frac > 0.10]       # G
         + w8·[cross-aligner Δstart > 150 ms]     # H
         + w9·[vad_speech_fraction < 0.35]        # I
         + w10·[drift-run residual > 500 ms]      # K
```
Calibrate on a hand-labelled set of ~200 lines per language, including deliberately poisoned cases (wrong-language head, dropped line, duplicated line, 500 ms shift). Optimise for **recall of misplacement**, accepting false positives — MFA's own documentation makes that trade explicitly. Route flagged lines to a re-align pass with a narrower window, then to human review.

---

## 6. VAD-based boundary snapping

**What is published.**

- **Silero.** On the maintainers' 17-hour multi-domain validation set, ROC-AUC (computed on 31.25 ms segments) is **0.97 for v6**, 0.96 for v5, 0.92 for v3, and **0.73 for WebRTC**; per-domain, Silero v5/v6 lead on AliMeeting (0.96 vs 0.82), MSDWild (0.79 vs 0.62) and VoxConverse (0.94 vs 0.65) ([Silero quality metrics wiki](https://github.com/snakers4/silero-vad/wiki/Quality-Metrics)). One 30+ ms chunk takes under 1 ms on a single CPU thread ([README](https://github.com/snakers4/silero-vad/blob/master/README.md)).
- **Independent confirmation of the ordering:** Silero significantly outperforms WebRTC and RMS; larger averaged windows degrade accuracy; hysteresis post-processing helps WebRTC but not Silero ([arXiv:2601.17270](https://arxiv.org/html/2601.17270v1)).
- **pyannote.** pyannote 3.1-class systems are evaluated with DER (~11–19 % on standard benchmarks per third-party comparisons), and the field's convention is to *exclude* a 500 ms collar (250 ms either side) around each speaker-turn boundary from evaluation because manual annotation is not sample-accurate ([pyannote.metrics docs](https://pyannote.github.io/pyannote-metrics/reference.html)).

**The honest gap: nobody publishes speech-onset error in milliseconds for these VADs.** Silero's headline metric is a frame classification ROC-AUC at 31.25 ms granularity; pyannote's is DER with a 500 ms collar. Neither is a boundary-precision number. So the premise "VAD onsets are accurate to X ms" is unsupported by any source I found, and a 32 ms frame grid plus the model's own smoothing is a floor, not a measured error. **Measure it yourself on your gold set before snapping anything.**

**Does snapping help or hurt?** Both, depending on the case. What the literature supports:

- VAD pre-segmentation demonstrably helps *long-form transcription*: WhisperX's VAD Cut & Merge improves transcription quality and gives a twelvefold speedup, with chunk boundaries placed in minimally active speech regions ([arXiv:2303.00747](https://arxiv.org/abs/2303.00747)).
- Silence-based timestamp adjustment is standard practice in the Whisper ecosystem: stable-ts enables `suppress_silence` and `suppress_word_ts` by default and can use Silero VAD, and its `use_word_position` logic keeps the *end* timestamp for a segment's first word and the *start* for its last ([README](https://github.com/jianfch/stable-ts)) — an implicit admission that naive snapping is directional and needs guards.
- Vocal separation before VAD is the accepted mitigation for music/background: whisper-diarization extracts vocals first to improve downstream accuracy ([README](https://github.com/MahmoudAshraf97/whisper-diarization/blob/main/README.md)).

Reasoning, flagged as reasoning rather than sourced fact: snapping systematically *late-shifts* words whose onset is a low-energy segment — word-initial fricatives, and the closure phase of stops, which a forced aligner correctly assigns to the word but which carries little energy. For a dubbing pipeline that asymmetry is the wrong direction only sometimes: see §7, where audio *leading* picture is the perceptually harsher error, so a small late bias is safer than a small early bias.

**Recommended snapping policy.**

```
snap(L):
  o = nearest VAD onset to start(L)
  if |o - start(L)| > 250 ms:           return start(L)   # different utterance; do not move
  if o < end(previous line):            return start(L)   # would cross a neighbour
  if o < start(L) - 40 ms:              return start(L)   # never pull earlier than 40 ms: audio-lead is worse
  if vad_confidence(o) < 0.7:           return start(L)
  if music_energy(span) > threshold:    return start(L)   # or re-run VAD on separated vocals
  return o
```
Then A/B it: measure %|error| ≤ 100 ms with and without snapping, per language, and keep snapping only where it wins. Given that MFA-class aligners already sit near 12–22 ms mean boundary error while VAD grids are ~32 ms, **snapping is likely to hurt a well-matched MFA alignment and to help a coarse NFA/Conformer alignment (40–80 ms stride).** That is testable in an afternoon on a gold set.

---

## 7. Sync tolerances and metric definitions used in industry

| Standard / practice | Tolerance | Source |
|---|---|---|
| **ITU-R BT.1359-1** detectability | audio advanced ~**+45 ms**, audio delayed ~**−125 ms** | [ITU-R BT.1359-1](http://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1359-1-199811-I!!PDF-E.pdf) |
| **ITU-R BT.1359** acceptability | ~**+90 ms** to **−185 ms** on average | [ITU-R BT.1359](https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1359-0-199802-S!!PDF-E.pdf) |
| **ITU-R BT.1359** studio→transmitter budget | **+22.5 ms / −30 ms** from the final programme-source selection point | [ITU-R BT.1359](https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1359-0-199802-S!!PDF-E.pdf) |
| **EBU R 037** (2007) | **+40 ms / −60 ms** at the output feeding the transmitter | recommendation exists and covers relative sound/vision timing limits through the production chain ([EBU](https://tech.ebu.ch/publications/r037)); the +40/−60 figures as reported by [TV Technology](https://www.tvtechnology.com/opinions/managing-lip-sync-267386) |
| **Netflix subtitle in-time** | on the first frame of audio, **within 1–2 frames** acceptable (≈42–83 ms at 24 fps), using the waveform as reference | [Netflix Timed Text Style Guide: Subtitle Timing](https://backlothelp.netflix.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines) |
| **Netflix subtitle out-time** | ideally ≥ half a second past the end of audio; minimum 2-frame gap between events at all frame rates | [ibid.](https://backlothelp.netflix.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines) |
| **Automatic dubbing** | *isochrony* is the governing property: the translated speech must match the source speech-and-pause structure; measured as **speech overlap** and via TTS-duration-based metrics such as IsoChronoMeter | [arXiv:2112.08548](https://arxiv.org/abs/2112.08548), [arXiv:2411.07387](https://arxiv.org/html/2411.07387v1), [arXiv:2410.11127](https://arxiv.org/html/2410.11127) |

**Recommended internal metric definitions for this pipeline.**

- `e(L) = t_pred_start(L) − t_true_start(L)`, milliseconds, signed. Report **median, P90, P95, and %|e| ≤ 100 ms per language**. Never report the mean (§5-K).
- Adopt an **asymmetric** tolerance derived from BT.1359: acceptable window ≈ **−40 ms to +120 ms** (starting the dub early is perceptually worse than starting it late). A symmetric ±100 ms target under-penalises the error that viewers actually notice.
- Add a **placement** metric distinct from precision: `%lines whose span overlaps the correct utterance by ≥50 % IoU`. Boundary precision and correct placement are different failures, and the 95 % goal in the project brief is about placement.
- Track the **flag rate** and **flag precision** of the §5 composite gate separately from alignment error; the gate's job is recall of misplacement, and it should be tuned on poisoned data.

---

## 8. Contradictions and caveats in the sources

1. **WhisperX's rank flips between papers.** MFA 2026 reports WhisperX mean word-boundary error ~110 ms with only 54–57 % of boundaries within 100 ms; the earlier comparison reports 34.3 ms mean on TIMIT and 94.2 % within 100 ms. MFA 2026 states the difference: it uses **beginning** timestamps for both word and phone boundaries, whereas the earlier work used **end** timestamps ([arXiv:2606.18466](https://arxiv.org/html/2606.18466v1)). Since a dubbing pipeline cares about line *starts*, the pessimistic MFA-2026 numbers are the relevant ones.
2. **[arXiv:2406.19363](https://arxiv.org/html/2406.19363v1) contradicts itself in one sentence.** Its abstract and tables show MFA beating MMS and WhisperX at every threshold, but the prose around Table 3 asserts the neural systems are far more accurate than any HMM-GMM model. Everything else in the paper, and MFA 2026, supports the former. Treat that sentence as an editing error.
3. **MFA is not uniformly better.** On the Dutch IFA corpus MFA reached 19 % within 100 ms vs MMS's 76.6 % ([arXiv:2606.10675](https://arxiv.org/html/2606.10675v1)). Whether a *matched* model exists dominates the architecture choice.
4. **The 4.15 ms code-mixed figure is not a field number.** Read speech, phone midpoints, in-domain train/test, MFA v1.0.
5. **IndicMFA publishes no accuracy at all.** Coverage and training hours only. Everything about its <100 ms behaviour on film audio with music beds is unverified.
6. **No VAD onset error in milliseconds is published** for Silero v5/v6, pyannote 3.x, or WebRTC. Any claim about "snapping to a 20 ms-accurate onset" is unsupported.
7. **IndicConformer's frame stride is unverified here.** If it is 80 ms, it cannot be the final boundary source.
8. **Licence asymmetry:** MMS_FA is CC-BY-NC 4.0; IndicConformer's card states MIT; IndicMFA models are released via GitHub releases without a licence statement I verified. Check before shipping.

---

## COVERAGE

- **Searches counted: 38.** MFA pretrained models/Indic; MFA version+changelog; torchaudio MMS_FA tutorial+romanisation; MMS "Scaling Speech Technology"; ctc-forced-aligner; WhisperX align models; NeMo Forced Aligner; IndicConformer-600M; forced-alignment confidence/misalignment detection; CTC-segmentation confidence threshold; Silero VAD v5 benchmarks; pyannote 3.x VAD benchmarks; EBU R37; ITU-R BT.1359 lip-sync; code-mixed Hindi-English forced alignment; aeneas DTW; stable-ts; Gentle non-English; posterior/entropy confidence + utterance verification; transcript-audio mismatch filtering via CTC score; MFA train/G2P; Charsiu boundary error; mfa-models Hindi; MFA global pretrained list; AI4Bharat IndicMFA; Indic spoken LID; Netflix timed-text/dubbing tolerances; dubbing isochrony metrics; `forced_align` `<star>` token; uroman Indic limitations; mfa-models.readthedocs; VAD boundary error/collar; VoxCommunis dictionaries; WhisperX VAD cut&merge; VAD onset clipping of low-energy onsets; IndicConformer + NFA alignment; pyannote segmentation-3.0; long-audio anchor/drift detection.
- **Pages fetched with Firecrawl: 29** (2 served from cache). arXiv 2606.18466, 2607.25581, 2406.19363, 2007.09127v2, 2210.15226v2, 2506.01256, 2606.10675, 2504.07315, 2601.17270; AI4Bharat IndicMFA (repo, releases, tags), BhasaAnuvaad; ctc-forced-aligner README; whisperX `alignment.py`; stable-ts README; aeneas HOWITWORKS; Gentle issue #144; torchaudio MMS_FA model page; NeMo Forced Aligner docs; IndicConformer-600M card; MFA changelog index + 3.4 changelog + alignment-analysis docs; Silero VAD quality-metrics wiki; Netflix subtitle timing guidelines; NVIDIA entropy-confidence blog; VoxCommunis HF dataset; EBU R037 page.
- **Credits spent: ~109–124.** Balance read 873 before the first fetch and 764 immediately after the last one (109). A follow-up read with no intervening fetch showed 749, so the counter drifts by ~15 independently of this session; the fetch-attributable figure is 109. Budget was 170.
- **Not fetched / unresolved:** per-language VoxCommunis Indic coverage; official EBU R037 PDF body (numbers taken from a trade source); IndicMFA per-language boundary error (none published); IndicConformer encoder subsampling factor; any published ms-level VAD onset error.
