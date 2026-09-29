# Competitive research: how AI dubbing / localisation / STT vendors achieve transcript coverage and timing accuracy

Scope: 60+ commercial products and models across three layers — (a) dubbing/localisation platforms, (b) India-focused speech AI, (c) ASR APIs used as the transcription layer. Focus question: how do they get *near-complete* dialogue coverage and accurate timing/sync, especially Hindi and Telugu.

Every substantive claim below has a URL. **Vendor marketing is labelled `[VENDOR]`. Independent or third-party measurement is labelled `[INDEP]`. Inference from documentation is labelled `[INFERRED]`.** A closing section lists what could not be verified.

Content from sources was paraphrased, not quoted at length, for licensing compliance.

---

## Executive answer up front

Nobody sells 100% word coverage. Not one vendor in this survey publishes a coverage guarantee. What they actually sell is one of four things:

1. **A WER percentage on a public benchmark** (ElevenLabs, Deepgram, AssemblyAI, Speechmatics, Sarvam, Smallest.ai).
2. **An editable transcript** — the vendor's real answer to missed dialogue is "you fix it" (ElevenLabs Dubbing Studio, Dubverse, Vidby, Rask).
3. **Human-in-the-loop review**, sold as the quality differentiator (Papercup, Dubformer, Deepdub, Verbit, Rev human tier, Amazon Prime Video's own pilot).
4. **Nothing measurable at all** — most dubbing platforms publish no accuracy figure of any kind.

The only *stated numeric timestamp accuracy* I found from any major ASR API is AssemblyAI's, and it is far looser than people assume: word timestamps accurate to roughly 400 ms ([AssemblyAI FAQ](https://assemblyai.com/docs/faq/does-your-api-return-timestamps-for-individual-words)). That is *outside* the ITU broadcast lip-sync detectability window (+45 / −125 ms). This is the single most important finding in this document: **raw ASR word timestamps are not accurate enough for dubbing sync, which is why forced alignment exists as a separate stage.**

---

## Part 1 — Dubbing and localisation platforms

### ElevenLabs (Dubbing + Scribe)
- **Accuracy claims** `[VENDOR]`: Scribe marketed as most accurate ASR; language pages cite 3.1% WER on FLEURS and 5.5% on Common Voice — note the *identical* figure appears on the [Hindi](https://elevenlabs.io/speech-to-text/hindi), [Telugu](https://elevenlabs.io/speech-to-text/telugu), [English](https://elevenlabs.io/speech-to-text/english) and even [Lingala](https://elevenlabs.io/speech-to-text/lingala) pages, so it is a global average templated across language pages, **not a Hindi or Telugu measurement**. Treat those two pages as marketing, not data.
- Launch post claims dramatic error reduction in underserved languages where rivals exceed 40% WER ([blog](https://elevenlabs.io/blog/meet-scribe)). Scribe v2 Realtime claimed lowest WER of low-latency models on FLEURS across 30 languages ([blog](https://elevenlabs.io/blog/scribe-v2-realtime-in-elevenlabs-agents)).
- **Pipeline (disclosed)**: transcribe → translate → TTS, with 90+ languages ([docs](https://www.elevenlabs.io/docs/capabilities/dubbing)). Background audio can be dropped via a `drop_background_audio` flag, which implies an internal **source-separation / M&E stage** ([API ref](https://elevenlabs.io/docs/api-reference/dubbing/create)). Speaker-level segmentation with per-speaker cards and SFX tracks in Dubbing Studio ([docs](https://elevenlabs.io/docs/product-guides/products/dubbing/dubbing-studio)).
- **Human-in-the-loop is explicit and architectural.** The API exposes endpoints to edit a source segment's text, speaker *and timing*, plus a batch variant — both Enterprise-only ([update segment](https://elevenlabs.io/docs/api-reference/dubbing/source-transcript/update-source-segment), [batch update](https://elevenlabs.io/docs/api-reference/dubbing/source-transcript/batch-update-source-segments)). Their own guidance is to fix the source transcript *before* generating languages, because edits downstream mark languages stale ([refine guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/dubbing/refine-and-regenerate)). They also support bring-your-own-transcript, explicitly framed as the path when you already have an accurate script ([BYO transcript](https://elevenlabs.io/docs/eleven-api/guides/how-to/dubbing/bring-your-own-transcript)).
- **Read this as an admission**: ElevenLabs' own recommended workflow assumes the machine transcript will need correction.
- Timeline editing down to individual sentences and typed exact timestamps ([Transcripts guide](https://elevenlabs.io/docs/creative-platform/products/transcripts), [Studio](https://elevenlabs.io/docs/product-guides/products/studio)).
- TTS side exposes **character-level** timing for audio-text sync ([convert-with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)) — useful for building your own alignment.
- Hindi/Telugu: both supported in STT and Dubbing v2 language list ([dubbing languages](https://help.elevenlabs.io/hc/en-us/sections/23795005622929-Dubbing)).
- **Independent**: Scribe v2 measured at 2.2% AA-WER, 2nd of 55 models, on English-centric datasets ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)). No independent Hindi/Telugu figure found.

### HeyGen
- **Claims** `[VENDOR]`: 175+ languages, voice cloning, lip sync; blog asserts the category delivers 95–98% accuracy ([blog](https://www.heygen.com/blog/10-best-ai-video-translators-i-tested-in-2025-free-paid-tools-reviewed)). That 95–98% is a self-published marketing range covering competitors too — no methodology, treat as unsupported.
- **Pipeline (disclosed)**: video-translate API has explicit modes, including a no-lip-sync mode that only swaps the audio track ([docs](https://developers.heygen.com/docs/video-translate)) and a `precision` mode positioned for talking-head content where lip-sync accuracy matters ([docs](https://developers.heygen.com/docs/video-translation-precision) — page did not render for full extraction; claim taken from search snippet).
- Pricing: Free / Creator $29/mo / Pro $49/mo, credit-based ([FAQ](https://www.heygen.com/faq)).
- No published WER, no timestamp accuracy, no coverage claim. Not verified: whether HeyGen does source separation or diarisation.

### Papercup
- **The clearest human-in-the-loop pitch in the category.** Third-party reviews consistently describe a network of human translators reviewing and refining AI output ([DittoDub comparison](https://dittodub.com/articles/heygen-vs-papercup)), professional review of every translation and voiceover ([Softonic listing](https://papercup.en.softonic.com/web-apps)), and human QA layered on synthetic voices ([CompleteAITraining](https://completeaitraining.com/ai-tools/papercup/)).
- I could **not** fetch papercup.com/how-it-works directly (extraction failed), so the human-review description here rests on third-party write-ups rather than Papercup's own page. Flagging that as a verification gap.
- No published WER, no timestamp figures, no Hindi/Telugu confirmation found.

### Deepdub
- **Pipeline (disclosed, unusually detailed for this category)**: they state that music and effects are split out during dubbing, producing a line-by-line transcription, and that you can supply your own script ([FAST channels page](https://deepdub.ai/solution/fast-channels)). That is **source separation + human script override**, both confirmed.
- They maintain a glossary entry on dialog isolation as a prerequisite for dubbing and localisation ([glossary](https://deepdub.ai/glossary/dialog-isolation)).
- ASR positioned as capturing inflection for precise transcription ([technology](https://deepdub.ai/technology)) — marketing language, no number.
- eTTS with 80+ performance styles, with continuity reviewed as part of the production workflow ([media & entertainment](https://deepdub.ai/solution/media-entertainment)) — i.e. **human QC is in the loop**. Positioned to LSPs as a voice layer with professional quality control at scale ([LSP page](https://deepdub.ai/solution/language-service-providers)).
- Only hard number published is TTS-side, not transcript-side: top-tier expressivity, ~125 ms latency in a blind English TTS test ([benchmark](https://deepdub.ai/model-benchmark/etts-benchmark-english)).
- Hindi/Telugu: not verified.

### Camb.ai (MARS / DEEP-DUB / BOLI)
- **Claims** `[VENDOR]`: 140–150+ languages; MARS-Pro reported at 0.87 WavLM speaker similarity on a MAMBA benchmark ([blog](https://www.camb.ai/blog-post/ai-for-dubbing-movies)). Note that is a **speaker-similarity** metric, not transcript coverage or timing.
- Pipeline described as ingestion → voice cloning → real-time dubbing → quality control → delivery ([sports commentary post](https://www.camb.ai/fr/blog-post/generate-multilingual-sports-commentary-at-scale)) — **QC stage explicitly named**. API exposes separate transcription, translation, TTS, voice cloning and dubbing endpoints ([integration post](https://www.camb.ai/blog-post/how-to-add-ai-dubbing-integration)); dubbing runs as async submit-and-poll jobs ([SDK tutorial](https://cambai.mintlify.app/tutorials/dubbing-with-sdk)).
- Their own framing of the category is the same three-step flow everyone uses: transcribe, translate, synthesise ([comparison post](https://www.camb.ai/blog-post/ai-dubbing-softwares-to-automate-localization)).
- No WER, no timestamp accuracy published. Telugu/Hindi presence implied by the 150+ count but I found no per-language quality data.

### Panjaya (BodyTalk)
- Differentiator is visual: lip *and body* movement sync, using controllable facial geometry ([about](https://www.panjaya.ai/about)), announced Nov 2024 with $9.5M ([TechCrunch](https://techcrunch.com/2024/11/08/led-by-a-founder-who-sold-a-video-startup-to-apple-panjaya-uses-deepfake-techniques-to-bite-into-video-dubbing/), [BusinessWire](https://www.businesswire.com/news/home/20241107698148/en/Panjaya.ai-Unveils-BodyTalk-Worlds-first-AI-Powered-Dubbing-Platform-Combining-Lip-and-Body-Movement-for-Seamless-Multilingual-Sync-Led-by-Apple-and-Vimeo-Alums)).
- **Most useful disclosure in the whole survey on timing**: their help docs tell users that if you supply SRT subtitles per language, Panjaya adjusts alignment to the original speech for dubbing and lip-sync, and warns that **because subtitle cues follow reading pace you may need a timing check afterwards** ([Getting Started](https://intercom.help/panjaya/en/articles/10447927-getting-started-ai-workflow-tools)). That is a vendor openly conceding that subtitle timings ≠ dubbing timings and a human pass is advisable.
- No WER, no ms tolerance published.

### Dubformer
- Positions itself explicitly *against* fully automated tools: argues that no-human-touch platforms lack professional oversight and approval ([AI voice-over page](https://dubformer.ai/ai-voice-over)).
- Claims broadcast quality in 70+ languages ([Nebius case study](https://nebius.com/customer-stories/dubformer)).
- IBC session description says they hold output to long-standing professional dubbing criteria — synchrony, coherence with picture, fidelity, credible dialogue, sound quality, performance ([IBC 2026](https://show.ibc.org/ibc2026/dubbing-the-undubbable-ai-takes-on-dramas-hardest-scenes)). Those are the classic dubbing QC axes; **synchrony is named as a criterion but no ms tolerance is given.**
- Platform API for automated localisation ([docs](https://docs.dubformer.ai/platform/overview)).

### Rask AI
- 130–135+ languages, voice cloning in ~32 ([Perso review](https://perso.ai/blog/rask-ai-dubbing-review-2026-features-pricing-how-it-compares)); lip-sync gated behind a higher tier per a competitor's comparison ([HeyGen blog](https://www.heygen.com/blog/heygen-vs-elevenlabs-vs-rask-ai-vs-dubverse) — competitor source, treat with caution).
- Pricing: plans up to 2000 min/month, extra minutes at $3/min on Business ([pricing](https://www.rask.ai/pricing)); Creator from $60/mo for 25 minutes ([ToolsForHumans](https://www.toolsforhumans.ai/ai-tools/rask-ai)).
- No accuracy or timing figures published.

### Dubverse.ai (India-focused)
- Credit pricing is unusually transparent: 4 credits per minute of dub, 2 per minute of TTS, 1 per minute of subtitling ([FAQs](https://dubverse.ai/faqs/)); INR and USD plans ([pricing](https://dubverse.ai/pricing/)); free tier and paid from ~$15/mo ([third-party](https://www.challengingvoice.com/tools/dubverse/)).
- Telugu TTS and Hindi dubbing are first-class products ([Telugu TTS](https://dubverse.ai/text-to-speech/telugu/), [Hindi dubbing](https://dubverse.ai/online-video-dubbing-hindi/)).
- Khan Academy case study: 120 hours localised in 4 weeks, with pacing and tone preserved ([case study](https://dubverse.ai/case-study/khan-academy-case-study-ai-dubbing/)) — a throughput claim, not an accuracy claim.
- **No WER, no coverage, no timing figure published.** Editable transcript/translation is the quality mechanism `[INFERRED]`.

### Neural Garage / VisualDub (India)
- Solves the *visual* half of sync, not transcript coverage: generative AI reconstructs lip and facial movement to match dubbed audio ([visualdub.ai](https://visualdub.ai/), [Inc42](https://inc42.com/startups/how-neuralgarage-is-fixing-the-dubbing-conundrum-for-otts-like-netflix-hotstar/)).
- Real production credit: used on Rajinikanth's *Coolie* ([Variety](https://variety.com/2025/film/news/rajinikanth-coolie-ai-lip-sync-tech-neuralgarage-1236489179/)); founder claims dubbed content can look and sound as if shot in the dub language ([Forbes](https://www.forbes.com/sites/swetakaushal/2025/06/15/this-indian-genai-startup-is-reshaping-dubbing-and-lip-sync/)).
- **Strategically important**: if the picture is re-rendered to the dub, the audio-video offset problem is partly *moved* rather than solved by timing precision. No ms figures published.

### Vidby
- Notable because it is the one vendor whose *marketing* flirts with 100%. A third-party review reports accuracy said to reach 99–100% ([SaaSGenius](https://saasgenius.com/new-tools/vidby)) and the homepage carries a "100% automated" badge ([vidby.com](https://vidby.com/)) — **"100% automated" is a process claim, not an accuracy claim; do not conflate them.**
- Vidby's own pages consistently offer human review as an *option*, not a default ([video translation](https://vidby.com/video-translation), [subtitles](https://vidby.com/subtitles)).
- Pricing: free tier, Starter $35/mo, Pro $75/mo, credit based; includes transcription and translation editors ([SaaSWorthy](https://www.saasworthy.com/product/vidby-software/pricing), [prices](https://vidby.com/prices)).

### Synthesia
- AI Dubbing across 139–140+ languages, syncing voiceover to lip movement and matching original tone ([docs](https://docs.synthesia.io/docs/video-dubbing), [feature page](https://www.synthesia.io/features/ai-dubbing)); auto-generated subtitles for dubs ([feature page](https://www.synthesia.io/features/ai-dubbing)); workflow is target-language selection per tag ([help](https://help.synthesia.io/en/articles/10054222-how-do-i-dub-a-video)).
- No accuracy, coverage or timing figures.

### Speechify Dubbing
- Has dedicated Telugu dubbing and Telugu video-translator surfaces ([Telugu dubbing](https://speechify.com/ai-dubbing/telugu/), [Telugu video translator](https://speechify.com/video-translator/telugu/)).
- No WER, coverage or timing data published.

### Descript
- Translation + dubbing with lip sync; a reviewer's investigation concluded Descript uses generative AI rather than rotoscoping for lip sync ([ProVideo Coalition](https://www.provideocoalition.com/descript-a-v-translation-dubbing-with-lip-sync-beyond-rotoscoping/)).
- Publishes editorial guidance on cleaning up overlapping speech / crosstalk in the editor ([Descript blog](https://www.descript.com/blog/article/how-to-edit-crosstalk-in-video)) — i.e. **overlap is treated as an editing problem for the user, not a solved model problem.**

### Respeecher / Resemble.ai / Play.ht / Murf
- These are **voice layers, not transcript layers**. Respeecher does speech-to-speech voice transformation ([overview](https://speechify.com/ca/blog/respeecher/)); Resemble spans cloning and speech-to-speech ([overview](https://speechify.com/blog/ultimate-guide-to-resemble-ai/)); Murf's Falcon API covers 150+ voices / 35 languages with code-mixing ([Murf API](https://murf.ai/api)); Play.ht is high-volume TTS ([context](https://murf.ai/alternative/play-ht)).
- None publishes transcript coverage, WER or timestamp accuracy. They are downstream of the coverage problem.

### Krisp
- Adjacent but the numbers are unusually well-documented. Voice Translation v3 claims 96% accuracy from live enterprise calls with real accents and noise ([API page](https://krisp.ai/developers/voice-translation-api/)), tested across 30 languages and 6 domains with 870 conversations, using automated metrics, AI scoring **and independent bilingual human review**, with QA scores landing 93–97 ([v3 launch](https://krisp.ai/blog/krisp-launches-v3-real-time-voice-translation/)).
- **This is the most methodologically transparent accuracy claim I found from any vendor in the survey** — and it still tops out at 96%, and it is translation quality, not word coverage.
- Accent conversion SDK with India→US, Philippines→US, LatAm→US models ([SDK docs](https://sdk-docs.krisp.ai/), [blog](https://krisp.ai/blog/accent-conversion-sdk/)).

### Sanas / Supertone
- Accent conversion and voice/audio processing respectively. **Not verified in this pass** — no citations gathered; neither is a transcript-coverage player.

### Sieve
- **Not verified.** I could not surface Sieve's own dubbing pipeline documentation in search results; the queries returned generic third-party pipeline explainers instead. Do not treat any Sieve claim as established here.

### Voiseed / Verbalate / Blabel
- **Not verified.** No primary-source pages retrieved for these three. Voiseed's emotion-modelling positioning and Verbalate's/Blabel's feature sets could not be confirmed with citations in this pass.

### Lelapa AI (Vulavula)
- Included as the low-resource-language comparator. STT with code-switching for multilingual contact centres, built for noisy real-world audio and multiple speakers ([lelapa.ai](http://www.lelapa.ai/)); supports isiZulu, Sesotho, Afrikaans, SA English, African French, plus code-switched isiZulu in alpha ([API](https://docs.lelapa.ai/api/transcribe/transcription), [intro](https://docs.lelapa.ai/overview/introduction)).
- **Refreshingly honest model cards**: the Afrikaans and African French models state they are call-centre-domain, not suitable for general conversation, and should be used with extreme caution in high-risk settings ([Afrikaans](https://docs.lelapa.ai/transcribe/model/afrikaans), [African French](https://docs.lelapa.ai/transcribe/model/african-french)).
- No WER published; no Indian languages.

### Platform-scale players worth benchmarking against

**YouTube auto-dubbing** — the most instructive admission in the industry. Google's own help page states dubs may contain errors from mispronunciations, accents, dialects or background noise, and lists proper nouns, idioms and jargon as translation challenges; it also says **auto dubs cannot be edited**, only reviewed and accepted or rejected before publication, and that videos are ineligible if speech is too fast to dub without an unlistenable sped-up result ([YouTube Help](https://support.google.com/youtube/answer/15569972?co=GENIE.Platform%3DDesktop&hl=en)). That last point is a direct statement that **speech rate breaks the isochrony constraint**, from the largest deployment of automatic dubbing on earth.

**Amazon Prime Video** — March 2025 pilot on 12 licensed titles, English and LatAm Spanish, described by Amazon itself as a hybrid approach where localisation professionals collaborate with AI for quality control ([About Amazon](https://www.aboutamazon.com/news/entertainment/prime-video-ai-dubbing-english-spanish?amp), [TechCrunch](https://techcrunch.com/2025/03/05/prime-video-tests-ai-dubbing-for-select-movies-and-tv-series/)), reported identically elsewhere ([TVTech](https://www.tvtechnology.com/news/amazon-prime-testing-ai-translated-closed-captioning), [Economic Times](https://economictimes.indiatimes.com/tech/artificial-intelligence/amazon-prime-video-tests-ai-assisted-dubbing/articleshow/118751913.cms)). **This is the strongest single piece of evidence that human-in-the-loop is the professional norm** — the company with the most automation incentive on the planet chose not to remove the humans.

---

## Part 2 — India-specific players (Hindi / Telugu)

### Sarvam AI — the most substantive Indian evidence
- **Published WER, on an Indian benchmark**: Saaras V2-class models achieved ~22% WER on IndicVoices across 11 Indian languages; **Saaras V3 reaches ~19% WER on the same IndicVoices benchmark** ([Sarvam ASR blog](https://www.sarvam.ai/blogs/asr)).
- Read that against English: the best English models sit at 1.7–2.6% AA-WER ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)). **The Indian-language state of the art is roughly an order of magnitude worse than English.** Any "near-complete coverage" ambition for Hindi/Telugu has to start from that gap.
- **Timestamps**: their dubbing page states Saaras transcribes and extracts dialogue with accurate timestamps ([dubbing page](https://www.sarvam.ai/text-to-speech/dubbing)) — claim made, no ms figure.
- Output modes include **verbatim**, transliterate and codemix, alongside transcribe/translate ([ASR quickstart](https://docs.sarvam.ai/api-reference-docs/asr/quickstart), [Saaras model card](https://docs.sarvam.ai/api-reference-docs/models/saaras)). A dedicated verbatim mode is the closest thing in this survey to a *coverage-oriented* feature.
- Diarisation and code-mixing supported; 11 languages on Saarika 2.5, 23 on Saaras v3 ([building for India](https://docs.sarvam.ai/api/building-for-india), [STT page](https://www.sarvam.ai/speech-to-text)).
- **They also argue WER is the wrong metric for Indic languages** ([evaluation blog](https://www.sarvam.ai/blogs/evaluating-indian-language-asr)) — as does Deepgram ([why WER fails Indian languages](http://deepgram.com/learn/why-wer-fails-indian-languages-bridge-7-metric-framework)). Both are self-interested, but the underlying point about spelling variation and code-mixing is legitimate and independently supported (see OIWER paper below).
- Built **Indic DiarBench** with AI4Bharat: first open speaker-attributed ASR benchmark across all 22 scheduled Indian languages, evaluating transcription and speaker attribution jointly ([blog](https://www.sarvam.ai/blogs/indic-diarbench)). This is the benchmark to test against for multi-speaker Telugu/Hindi coverage.

### Bhashini / ULCA + AI4Bharat
- Government open infrastructure chaining STT → translation → TTS for Indian languages ([TechTimes overview](https://www.techtimes.com/articles/324582/20260815/india-deploys-homegrown-ai-red-fort-pledges-ai-training-ten-million-youth.htm)); ULCA standardises data and model contributions for benchmarking ([GitHub](https://github.com/bhashini-dibd/ulca)).
- IndicConformer: multilingual ASR across all 22 official Indian languages ([GitHub](https://github.com/AI4Bharat/IndicConformerASR), [AIKosh listing](https://aikosh.indiaai.gov.in/home/models/details/indic_conformer_model_for_asr.html)).
- **IndicWhisper / Vistaar** `[INDEP]`: lowest WER in 39 of 59 benchmarks, average 4.1 WER reduction, across Kathbath, FLEURS, CommonVoice, IndicTTS, MUCS, GramVaani in 12 languages ([arXiv 2305.15386](https://arxiv.org/abs/2305.15386), [repo](https://github.com/AI4Bharat/vistaar)).
- **LAHAJA**: 12.5h Hindi accent benchmark, 132 speakers, 83 districts ([HF dataset](https://huggingface.co/datasets/ai4bharat/Lahaja)) — the right test set for Hindi accent robustness.

### Smallest.ai (India)
- Pulse Pro claims tied #2 on the public Open ASR Leaderboard at 5.42% average WER, ahead of Scribe v2, Universal-3 Pro and Speechmatics Enhanced ([model card](https://docs.smallest.ai/models/model-cards/speech-to-text/pulse-pro)) — English batch.
- Publishes its evaluation walkthrough and datasets (FLEURS, ESB, WildASR + internal perturbation suite) ([benchmarks](https://docs.smallest.ai/models/documentation/speech-to-text-pulse/benchmarks/performance), [walkthrough](https://docs.smallest.ai/models/documentation/speech-to-text-pulse/benchmarks/evaluation-walkthrough)).
- **Independently corroborated**: Pulse Pro at 2.4% AA-WER, top-5 of 55 models, and 266x speed factor ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)). Rare case where an Indian vendor's claim survives third-party measurement.

### Simplismart (India)
- Claims Indic-Conformer achieves 7.05% lower WER and 94.45% lower latency than Gemini 2.5 Flash on IndicVoices ([blog](https://simplismart.ai/blog/open-source-indic-ai-models-gemini)). Vendor-run comparison; useful signal that tuned open Indic models can beat frontier multimodal models on Indian audio.

### Rephrase.ai
- Acquired by Adobe (reported Nov 2023) ([Economic Times](http://economictimes.indiatimes.com/tech/startups/ettech-exclusive-in-a-first-adobe-acquires-indian-generative-ai-startup-rephrase-ai/articleshow/105411574.cms), [Inc42](https://inc42.com/buzz/adobe-acquires-bengaluru-based-ai-video-creation-platform-rephrase-ai/), [LiveMint](https://www.livemint.com/companies/news/adobe-enters-into-indian-generative-ai-space-by-taking-over-rephrase-ai-all-you-need-to-know-about-the-deal-11700706574825.html)). No longer an independent competitor in dubbing; technology folded toward Adobe's video roadmap.

### Gan.ai, Vodex, CoRover, Reverie
- **Not verified.** My searches did not return usable primary sources for these four on transcript coverage, timing accuracy or Hindi/Telugu WER. They should be treated as unresearched in this document, not as absent from the market.

### Independent measurement for Indian languages — the number that matters
- `[INDEP]` A benchmark of 10,934 recordings across Indian languages, each transcribed by up to 10 ASR models: **best Hindi WER 16.2%**; worst case Odia at 35.1%, achieved only with speaker diarisation ([arXiv 2602.03868](https://arxiv.org/html/2602.03868v2)). I could not extract the per-language Telugu figure (page extraction failed) — **Telugu-specific WER is a gap in this research.**
- `[INDEP]` Indian-language WER remains far above the single-digit English figures ([arXiv 2603.00941](https://arxiv.org/html/2603.00941v1)). The same paper proposes OIWER to account for permissible orthographic variation, improving pessimistic error rates by ~6.3 points on average and narrowing an 18.1-point Gemini–Canary gap to 11.5 ([PDF](https://arxiv.org/pdf/2603.00941)). **Implication: some of the apparent Hindi/Telugu error is metric artefact, but not most of it.**
- `[INDEP]` Existing Indic benchmarks over-rely on scripted clean speech and single-reference WER penalises natural spelling variation ([arXiv 2604.19151](https://arxiv.org/html/2604.19151v2)).

---

## Part 3 — ASR APIs as the transcription layer

### The one vendor that states timestamp accuracy in ms
**AssemblyAI**: word, phrase and sentence timestamps returned in milliseconds and stated as accurate to within about 400 ms ([FAQ](https://assemblyai.com/docs/faq/does-your-api-return-timestamps-for-individual-words)). Accuracy claims: Universal-2 built on Universal-1's 6.68% WER ([blog](https://www.assemblyai.com/blog/universal-2-delivers-accuracy-where-it-matters)), with a claimed 21% improvement on numeric data like phone numbers and zip codes ([Universal-2 page](https://www.assemblyai.com/universal-2)); Universal-3.5 Pro at 5.6% mean / 4.9% median WER on English benchmarks ([benchmarks](https://assemblyai-fff14a6f.mintlify.app/pre-recorded-audio/benchmarks)). Independently: Universal-3 Pro 3.1% AA-WER ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)).

**Take this seriously**: 400 ms is 3–9x the ITU detectability window. If you build dubbing sync directly off ASR word timestamps, you are outside broadcast tolerance before you start.

### Deepgram (Nova-3)
- Claims 54.3% streaming / 47.4% batch relative WER reduction vs competitors, with batch WER of 5.26% vs a next-best 10% ([Nova-3 intro](http://www.deepgram.com/learn/introducing-nova-3-speech-to-text-api), [award post](https://deepgram.com/learn/deepgram-receives-2025-voice-ai-technology-excellence-award), [model docs](https://developers.deepgram.com/docs/model)). Third-party summary puts streaming at 8.4% → 6.84% ([Vapi](https://vapi.ai/blog/deepgram-nova-3-vs-nova-2)).
- Multilingual update: ~34% relative batch and ~21% streaming WER reduction, with explicit gains on code-switching and **reduced word drops when languages are mixed** ([multilingual post](https://deepgram.com/learn/nova-3-multilingual-major-wer-improvements-across-languages), [changelog](https://deepgram.com/changelog/introducing-improved-diarization/)). Word drops on code-mixing are exactly the Hinglish/Tenglish coverage failure mode.
- Word-level timestamps as doubles with per-word confidence, now also in Flux ([changelog](https://developers.deepgram.com/changelog/2026/7/2)); utterances + diarisation ([guide](https://deepgram.com/learn/working-with-timestamps-utterances-and-speaker-diarization-in-deepgram)). **No stated ms accuracy.**
- Independently: Nova-3 5.2% AA-WER but fastest measured at 517x real-time ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)).
- Notably, Deepgram publishes its own argument that WER misrepresents Indian-language performance because of word boundaries, multiple scripts and multiple valid transcriptions ([post](http://deepgram.com/learn/why-wer-fails-indian-languages-bridge-7-metric-framework)).

### Speechmatics
- **The only major API in this survey with an explicit forced-alignment product**: submit audio plus a text file, get back word-level speech timing ([Alignment docs](https://docs.speechmatics.com/speech-to-text/batch/alignment)). For a dubbing pipeline where you already have or can correct a script, this is the direct route to tight timing.
- Ursa 2: 18% WER reduction across 50 languages vs prior Ursa ([announcement](https://www.speechmatics.com/company/articles-and-news/ursa-2-elevating-speech-recognition-across-52-languages)); Ursa claimed 22% and 25% relative gains over Microsoft and Whisper ([Ursa page](https://www.speechmatics.com/ursa)).
- **Directly relevant to your sung-audio question**: on the Ursa page they state they found Ursa transcribes singing well despite not training for it ([Ursa page](https://www.speechmatics.com/ursa)). Vendor claim, unquantified, but it is the only singing claim any ASR vendor makes here.
- **Hindi**: their Hindi page advertises 90% accuracy with sub-second latency ([Hindi STT](https://www.speechmatics.com/speech-to-text/hindi)). 90% accuracy ≈ 10% WER — i.e. **the vendor itself is telling you 1 word in 10 is wrong in Hindi.** No Telugu page found.
- They publish a scepticism piece on 99% accuracy claims ([article](https://www.speechmatics.com/company/articles-and-news/assessing-speech-to-text-accuracy-for-sceptics)) while also claiming to be most accurate 93.73% of the time across vendors and languages — read both with equal salt.
- Independently: Enhanced 4.0%, Melia 4.9%, Standard 5.1% AA-WER ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)).

### Gladia (Solaria)
- Claims 29% lower average WER on conversational speech and 3x lower diarisation error rate vs alternatives, benchmarked over 7 datasets / 74+ hours with stated open methodology ([comparison](https://www.gladia.io/blog/assemblyai-vs-deepgram-vs-gladia-which-speech-to-text-api-should-you-choose-in-2026)), and says providers were tested on identical audio via production APIs with default settings, using a human-annotated internal production dataset ([Solaria-3](https://www.gladia.io/solaria-3)).
- Pricing bundles diarisation, translation and sentiment from ~$0.20/hr on Growth ([Solaria post](http://gladia.io/blog/introducing-solaria-the-first-truly-universal-speech-to-text-model), [pricing](https://www.gladia.io/pricing)).
- Independently: Solaria-3 3.2%, Solaria-1 4.1% AA-WER, but the priciest of the batch at ~$10/1000 min ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)).

### Soniox
- Claims 1.25% semantic WER and **84.1% perfect transcripts** on its own benchmark ([benchmarks](https://soniox.com/benchmarks)). "Perfect transcripts" is the closest anyone comes to a coverage metric — and **it is 84%, not 100%**, on the vendor's own favourable test.
- 60+ languages ([v5 post](https://soniox.com/blog/soniox-v5-async)); ~$0.10/hr async, ~$0.12/hr real-time, flat-rate with diarisation and translation included ([pricing](https://soniox.com/pricing)).
- Independently: Soniox v5 Async 3.8%, V4 3.9% AA-WER — i.e. **the independent figure is ~3x the vendor's self-reported semantic WER**, which is a clean illustration of why you separate the two ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text/models/soniox)).

### OpenAI Whisper — the coverage cautionary tale
- `[INDEP]` **Hallucination**: 2024 FAccT study over ~13,140 short English segments found hallucinated phrases or sentences in about 1.4% of segments, and 38% of hallucinations contained explicit harms ([ACM](https://dl.acm.org/doi/10.1145/3630106.3658996), [PDF](https://aphasia.talkbank.org/publications/2024/Koenecke24.pdf), [Cornell](https://news.cornell.edu/stories/2024/06/ai-speech-text-can-hallucinate-violent-language)). Study used ~40 hours including 23 hours of aphasic speech ([Becker's](https://www.beckershospitalreview.com/quality/patient-safety-outcomes/study-finds-hallucinations-in-hospital-used-ai-tool/)). One engineer reported hallucinations in roughly half of 100+ hours he analysed ([TechXplore](https://techxplore.com/news/2024-10-ai-powered-transcription-tool-hospitals.pdf)). OpenAI has improved the model since and the rate has fallen ([Cornell](https://news.cornell.edu/stories/2024/06/ai-speech-text-can-hallucinate-violent-language)).
- `[INDEP]` **Whisper omits by design**: research indicates Whisper removes filler words and recurring utterances as an intended transcription style ([arXiv 2408.16589](https://arxiv.org/html/2408.16589v1)). **If you need verbatim coverage, Whisper is actively working against you.**
- `[INDEP]` **Whisper timestamps are not usable raw**: timestamps are utterance-level, no word-level out of the box, and can be off by several seconds ([WhisperX repo](https://github.com/jeffh/whisperX)); WhisperX fixes this with VAD + forced phoneme alignment ([arXiv 2303.00747](https://arxiv.org/abs/2303.00747), [HTML](https://arxiv.org/html/2303.00747)).
- Independently: Whisper Large v3 ranges 4.1%–10.1% AA-WER depending on provider/implementation ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)) — same weights, 2.5x spread. Implementation matters as much as the model.

### Cloud providers
- **Google**: word time offsets behind `enableWordTimeOffsets` ([v1 docs](https://docs.cloud.google.com/speech-to-text/docs/v1/async-time-offsets)); Chirp 2 added word-level timestamps, model adaptation and speech translation ([Chirp 2](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model)); Chirp 3 adds diarisation and automatic language detection ([Chirp 3](https://cloud.google.com/speech-to-text/v2/docs/chirp-model), [comparison](https://cloud.google.com/speech-to-text/docs/transcription-model)). No stated ms accuracy. Independently, Gemini 2.5 Pro / 3.x sit at 2.8–2.9% AA-WER but with very low speed factors (6.7–13.3x) ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)).
- **Azure**: fast transcription supports both segment-level and word-level timestamps plus diarisation, in display form only; LLM Speech variant adds translation and custom prompting ([docs](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create)). TTS side exposes WordBoundary events for per-word offsets ([Q&A](https://learn.microsoft.com/en-us/answers/questions/531771/text-to-speech-with-timestamp-in-json-format)). Independently, MAI-Transcribe-1.5 at 2.4% AA-WER, third overall ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)).
- **AWS Transcribe**: 4.1% AA-WER, 17.8x speed, ~$6/1000 min; Nova 2 Pro via Bedrock 4.9% ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)). No vendor timestamp-accuracy statement found.

### Rev
- **The clearest articulation of the accuracy tier structure in the industry.** AI transcription marketed at 95–96%+; human transcription at 99%+ *guaranteed* in 12 hours or less ([services](https://webflow.rev.com/services), [locations page](https://www.rev.com/locations/new-jersey-transcription-services), [vs TranscribeMe](https://www.rev.com/blog/rev-vs-transcribeme)). Pricing: AI from $0.20–0.25/min, human $1.02–1.99/min ([vs GoTranscript](https://www.rev.com/blog/rev-vs-gotranscript), [third-party](https://sonix.ai/resources/de/rev-pricing/)).
- **Even the human-guaranteed tier is 99%, not 100%.** That is the ceiling the industry is willing to put its name to.
- Independently, Rev AI's model measures 5.9% AA-WER ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)).

### Verbit / Sonix / Trint / Happy Scribe / Otter / Fireflies
- Verbit: hybrid AI + human, up to 99% with human assistance, SLA-backed for regulated industries ([Rev comparison](https://www.rev.com/blog/verbit-vs-rev), [Sonix comparison](https://sonix.ai/resources/sonix-vs-verbit/)); from $29/mo self-service, enterprise contracts averaging ~$33k/yr per a third-party estimate ([Sonix](https://sonix.ai/resources/nl/verbit-pricing/versterker/)).
- Sonix: markets up to 99% across 53+ languages at $10/hr PAYG, but its own cost guide states 85–98% accuracy ([pricing guide](https://sonix.ai/how-much-does-transcription-cost), [Verbit review](https://sonix.ai/resources/verbit-review-pricing/)). **Their two pages disagree with each other** — an example of how soft these numbers are.
- Fireflies ~90% and Otter ~83% per a competitor's comparison ([Sonix](https://sonix.ai/resources/fireflies-vs-otter/)) — competitor-sourced, low confidence. Fireflies pricing from $10/user/mo annual ([pricing](https://fireflies.ai/pricing)).
- Trint and Happy Scribe: appear in category round-ups ([Sonix](https://sonix.ai/resources/transcription-tools-earnings-calls/)) but **I found no first-party accuracy or timestamp figures. Unverified.**
- **Voicegain: not verified.** No usable primary source retrieved.

### Independent leaderboard, all providers
`[INDEP]` Artificial Analysis AA-WER v2, audio-duration-weighted across AA-AgentTalk (50%), VoxPopuli-Cleaned-AA (25%), Earnings22-Cleaned-AA (25%), ~8 hours total ([methodology](https://artificialanalysis.ai/speech-to-text/methodology)). Selected results ([leaderboard](https://artificialanalysis.ai/speech-to-text)):

| Model | AA-WER | Speed factor | $/1000 min |
|---|---|---|---|
| Fun-Realtime-ASR-preview | 1.7% | – | – |
| ElevenLabs Scribe v2 | 2.2% | 56.9x | 3.67 |
| Azure MAI-Transcribe-1.5 | 2.4% | 183.3x | 6.00 |
| Smallest.ai Pulse Pro | 2.4% | 266.3x | 4.00 |
| Voxtral Small (open) | 2.8% | 65.9x | 4.00 |
| Gemini 3.1 Pro (High) | 2.8% | 6.7x | 18.15 |
| AssemblyAI Universal-3 Pro | 3.1% | 111.0x | 3.50 |
| Gladia Solaria-3 | 3.2% | 62.2x | 10.16 |
| Soniox v5 Async | 3.8% | 18.0x | 1.66 |
| Speechmatics Enhanced | 4.0% | 70.7x | 12.50 |
| Amazon Transcribe | 4.1% | 17.8x | 6.00 |
| Deepgram Nova-3 | 5.2% | 517.0x | 4.30 |
| Rev AI | 5.9% | 13.4x | 3.33 |

**Two things to note.** First, these are English-centric datasets — they tell you nothing about Telugu. Second, **the best model on earth still misses ~1.7 words in 100 on clean-ish English.** That is the realistic ceiling.

---

## The five questions, answered

### 1. Does anyone claim or achieve 100% word coverage?

**No. Not one vendor in 60+ makes a 100% coverage claim, and I would not believe it if they did.**

What they promise instead, in descending order of rigour:

- **A benchmark WER**: best independently measured is 1.7–2.2% on English ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text)). Best Indian-language published figure is ~19% WER on IndicVoices ([Sarvam](https://www.sarvam.ai/blogs/asr)); independent Indian benchmarking puts best Hindi at 16.2% ([arXiv 2602.03868](https://arxiv.org/html/2602.03868v2)).
- **A "perfect transcript" rate**: Soniox claims 84.1% of transcripts perfect on its own benchmark ([Soniox](https://soniox.com/benchmarks)). This is the only coverage-shaped metric published by anyone, and it is 84%.
- **A human-guaranteed accuracy tier**: Rev guarantees 99%+ with human transcribers ([Rev](https://webflow.rev.com/services)); Verbit up to 99% with human assistance ([comparison](https://www.rev.com/blog/verbit-vs-rev)). **99% is where the industry's contractual courage stops.**
- **An editable transcript**: ElevenLabs makes source-transcript correction the recommended step and exposes segment text/speaker/timing edit APIs ([refine guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/dubbing/refine-and-regenerate), [API](https://elevenlabs.io/docs/api-reference/dubbing/source-transcript/update-source-segment)). Vidby ships transcription and translation editors ([pricing](https://www.saasworthy.com/product/vidby-software/pricing)).
- **Nothing at all**: HeyGen, Synthesia, Rask, Dubverse, Camb.ai, Panjaya, Speechify publish no transcript accuracy or coverage figure I could find.

The nearest thing to a 100% claim is Vidby, where a third-party review cites 99–100% ([SaaSGenius](https://saasgenius.com/new-tools/vidby)) and the homepage says "100% automated" ([vidby.com](https://vidby.com/)). The second is a process claim. The first is third-party, unmethodologised, and contradicted by Vidby's own decision to sell human review as an add-on.

Meanwhile the counter-evidence on coverage is strong: Whisper *deletes* fillers and repeated utterances by design ([arXiv 2408.16589](https://arxiv.org/html/2408.16589v1)) and *invents* content at measurable rates ([FAccT 2024](https://dl.acm.org/doi/10.1145/3630106.3658996)). Google's own dubbing docs concede errors from accents, dialects and noise, and refuse videos whose speech is too fast ([YouTube Help](https://support.google.com/youtube/answer/15569972?co=GENIE.Platform%3DDesktop&hl=en)).

**Blunt version: 100% word coverage is not a product anyone sells. It is not a benchmark anyone reports. The honest target is "high recall plus a review surface", and every serious player builds the review surface.**

### 2. What do the best ones do about overlapping speech and shouted/sung audio?

Three real mechanisms, and a lot of avoidance.

**Mechanism 1 — source separation before ASR.** This is the strongest and best-evidenced technique.
- AudioShake separates dialogue from music and effects and reports **customer-observed transcription accuracy increases of 25% or more** ([AudioShake](https://audioshake-2023-cf.webflow.io/)) `[VENDOR, customer-reported]`. They position it as feeding clean speech into downstream AI ([developer docs](https://developer.audioshake.ai/remove-dialogue-for-dubbing)) and note prior approaches failed on poor-quality, low-fidelity or noisy archive audio ([press release](https://www.audioshake.ai/press-releases/audioshake-expands-into-dialogue-music-and-effects-separation-for-production-studios-and-dubbing-services)). Also available for live ([Live launch](https://www.audioshake.ai/post/launching-dialogue-and-music-effects-separation-on-live)) and on-device via SDK ([SDK](https://audioshake-2023-cf.webflow.io/sdk)).
- Deepdub splits music and effects during dubbing to produce line-by-line transcription ([FAST channels](https://deepdub.ai/solution/fast-channels)) and treats dialog isolation as foundational ([glossary](https://deepdub.ai/glossary/dialog-isolation)).
- ElevenLabs exposes a background-audio drop flag ([API](https://elevenlabs.io/docs/api-reference/dubbing/create)).
- Gaudio Lab makes the sharpest point: the goal is total dialogue removal without residue, because leftover original dialogue becomes obvious once new voices are layered on ([Gaudio](https://www.gaudiolab.com/blog/241)).
- `[INDEP]` Research confirms the direction: music source separation improves automatic lyrics transcription with Whisper ([arXiv 2506.15514](https://arxiv.org/html/2506.15514v1)), and ASR foundation models degrade on singing voice, especially with accompaniment ([Interspeech 2025](https://www.isca-archive.org/interspeech_2025/huang25_interspeech.pdf)).

**Mechanism 2 — diarisation and speaker-attributed ASR.** Deepgram ships diarisation with utterances and timestamps ([guide](https://deepgram.com/learn/working-with-timestamps-utterances-and-speaker-diarization-in-deepgram)); Azure fast transcription supports diarisation ([docs](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create)); Chirp 3 adds it ([docs](https://cloud.google.com/speech-to-text/v2/docs/chirp-model)); Sarvam supports it and co-built Indic DiarBench to evaluate transcription and attribution jointly across 22 Indian languages ([Sarvam](https://www.sarvam.ai/blogs/indic-diarbench)).

**But diarisation does not solve overlap.** `[INDEP]` Overlap-handling research reports diarisation error rates of 20.8% on AMI and 29.0% on DISPLACE 2024 ([Springer](https://link.springer.com/article/10.1007/s42979-025-04468-2)); multi-speaker WER of 21.2% on AMI-SDM ([arXiv 2103.16776](https://arxiv.org/pdf/2103.16776v2)); and the literature states plainly that transcribing overlapped speech remains a significant challenge ([arXiv 2506.05796](http://www.arxiv.org/pdf/2506.05796)). Recent work still frames complex overlap as the hard case even for Gemini and Qwen-Omni class models ([arXiv 2601.06896](https://arxiv.org/html/2601.06896v1)) and conversational ASR robustness in multi-speaker settings as unresolved ([arXiv 2603.22709](https://arxiv.org/html/2603.22709v1)).

**Mechanism 3 — punt to the human.** Descript publishes a guide on editing crosstalk ([Descript](https://www.descript.com/blog/article/how-to-edit-crosstalk-in-video)); GoTranscript documents crosstalk attribution rules because overlap hides words and confuses speaker labels ([GoTranscript](https://gotranscript.com/en/blog/edit-crosstalk-in-transcripts-overlapping-speakers-attribution-rules)). Where multi-channel capture is available, the industry sidesteps overlap entirely by transcribing per-participant streams and merging by timestamp — not an option for finished film/TV mixes.

**Shouted and sung audio specifically**: near-total silence from vendors. The only claim I found is Speechmatics saying Ursa transcribes singing well despite not being trained for it ([Ursa](https://www.speechmatics.com/ursa)) — unquantified. `[INDEP]` Research shows sung lyrics are much harder than the same words spoken: one study transcribed spoken versions of song lyrics at 0.14 WER, versus much worse on the sung recordings ([NLP4MusA 2024](https://aclweb.org/anthology/2024.nlp4musa-1.3.pdf)). **No vendor in this survey publishes a shouted-speech or Lombard-speech figure. That is an unaddressed gap across the entire market.**

### 3. Does anyone expose word-level timestamps with stated accuracy in ms?

**Word-level timestamps: yes, nearly everyone. Stated accuracy in ms: essentially one vendor.**

- **AssemblyAI — the only clear statement**: ms-valued timestamps accurate to within about 400 ms ([FAQ](https://assemblyai.com/docs/faq/does-your-api-return-timestamps-for-individual-words)).
- Deepgram: word start/end as doubles with confidence, including in Flux ([changelog](https://developers.deepgram.com/changelog/2026/7/2)) — **no accuracy stated**.
- Google: `enableWordTimeOffsets`; Chirp 2 added word-level timestamps ([docs](https://docs.cloud.google.com/speech-to-text/docs/v1/async-time-offsets), [Chirp 2](https://cloud.google.com/speech-to-text/v2/docs/chirp_2-model)) — **no accuracy stated**.
- Azure: word-level timestamps across fast transcription variants ([docs](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create)) — **no accuracy stated**.
- Speechmatics: a dedicated **Alignment** endpoint that returns when each word was spoken given audio + text ([docs](https://docs.speechmatics.com/speech-to-text/batch/alignment)) — no accuracy stated, but this is forced alignment as a product.
- ElevenLabs: character-level timing on the TTS side ([API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)); segment timing editable on the dubbing side ([API](https://elevenlabs.io/docs/api-reference/dubbing/source-transcript/update-source-segment)) — no accuracy stated.
- Sarvam: claims accurate timestamps for dubbing ([page](https://www.sarvam.ai/text-to-speech/dubbing)) — no number.

**Where real ms numbers do exist, they come from the forced-alignment literature, not from vendors** `[INDEP]`:
- MFA 3.0 reports mean boundary errors below 15 ms across four benchmark datasets ([arXiv 2606.18466](https://arxiv.org/html/2606.18466v1)).
- Under a strict 10 ms tolerance on TIMIT, MFA achieves 41.6% word-level accuracy versus 22.4% for WhisperX ([arXiv 2509.23147](https://arxiv.org/html/2509.23147v1)) — **HMM-GMM alignment still beats ASR-derived alignment at tight tolerances.**
- Aligner boundaries commonly evaluated against a 20 ms human-agreement gold standard ([Journal of Cognition](https://journalofcognition.org/articles/416/files/677d04cd98c2e.pdf)).
- WhisperX exists precisely because Whisper's utterance timestamps can be seconds off ([repo](https://github.com/jeffh/whisperX), [paper](https://arxiv.org/abs/2303.00747)).

**Practical conclusion for your pipeline**: ASR gives you words; forced alignment gives you time. Anyone claiming dubbing-grade sync from raw ASR timestamps is either using a very forgiving definition of sync or hasn't measured. A dedicated alignment pass (MFA-class, or Speechmatics Alignment) buys you roughly an order of magnitude in timing precision over AssemblyAI's stated 400 ms.

### 4. Is human-in-the-loop review standard in professional dubbing?

**Yes. Unambiguously, and the evidence is strong on multiple independent axes.**

- **Amazon Prime Video**, describing its own March 2025 pilot: a hybrid approach where localisation professionals collaborate with AI for quality control ([About Amazon](https://www.aboutamazon.com/news/entertainment/prime-video-ai-dubbing-english-spanish?amp)), corroborated independently ([TechCrunch](https://techcrunch.com/2025/03/05/prime-video-tests-ai-dubbing-for-select-movies-and-tv-series/), [TVTech](https://www.tvtechnology.com/news/amazon-prime-testing-ai-translated-closed-captioning), [TechXplore](https://techxplore.com/news/2025-03-amazon-prime-video-ai-dubbing.pdf)). And when AI dubs went out without sufficient oversight, they were pulled after industry backlash ([AnimeMojo](https://animemojo.com/shonen/amazon-removes-no-game-no-life-vinland-saga-banana-fish-ai-dubs-after-intense-industry-anger-a19643)) — low-confidence source, but directionally consistent.
- **ElevenLabs' own recommended workflow** puts a human on the source transcript before language generation, and ships Enterprise APIs for editing segment text, speaker and timing ([refine guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/dubbing/refine-and-regenerate), [batch update](https://elevenlabs.io/docs/api-reference/dubbing/source-transcript/batch-update-source-segments)).
- **Papercup** markets human translator review as the core differentiator ([DittoDub](https://dittodub.com/articles/heygen-vs-papercup), [Softonic](https://papercup.en.softonic.com/web-apps)).
- **Dubformer** argues fully automated output lacks professional oversight and approval ([page](https://dubformer.ai/ai-voice-over)) and holds to traditional dubbing QC criteria ([IBC](https://show.ibc.org/ibc2026/dubbing-the-undubbable-ai-takes-on-dramas-hardest-scenes)).
- **Deepdub** reviews continuity as part of the production workflow and sells professional QC to LSPs ([M&E](https://deepdub.ai/solution/media-entertainment), [LSP](https://deepdub.ai/solution/language-service-providers)).
- **Camb.ai** names quality control as a pipeline stage ([post](https://www.camb.ai/fr/blog-post/generate-multilingual-sports-commentary-at-scale)).
- **Panjaya** tells users to do a timing check after SRT-driven alignment ([help](https://intercom.help/panjaya/en/articles/10447927-getting-started-ai-workflow-tools)).
- **Vidby** sells human review as an option ([page](https://vidby.com/video-translation)).
- **Krisp** used independent bilingual human review in its accuracy evaluation ([v3](https://krisp.ai/blog/krisp-launches-v3-real-time-voice-translation/)).
- **Transcription tier structure** proves the economics: AI ~95–96% vs human-guaranteed 99%+, at roughly 8–10x the price ([Rev](https://webflow.rev.com/services), [Rev vs GoTranscript](https://www.rev.com/blog/rev-vs-gotranscript)). Verbit sells SLA-backed human-assisted accuracy for regulated work ([comparison](https://sonix.ai/resources/sonix-vs-verbit/)).
- **The counter-example is instructive**: YouTube's fully automatic dubbing forbids editing entirely and can only be reviewed and accepted or rejected ([YouTube Help](https://support.google.com/youtube/answer/15569972?co=GENIE.Platform%3DDesktop&hl=en)) — and it is not used for professional broadcast dubbing.

`[INDEP]` Academic work on dubbing quality assessment continues to organise around the same professional criteria — synchrony, cohesion, sound design, language and translation ([Paralleles / Spiteri Miggiani](https://www.um.edu.mt/library/oar/bitstream/123456789/128948/1/Paralleles-36-2_Spiteri-Miggiani.pdf)), which are human judgements.

**Where vendors differ is not *whether* humans review, but who pays for it: the vendor (Papercup, Dubformer, Deepdub, Verbit) or you (ElevenLabs, Dubverse, Rask, Vidby).**

### 5. What is the industry-standard sync tolerance in ms?

**Primary sources, ITU-R BT.1359-1** ([official PDF](http://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1359-1-199811-I!!PDF-E.pdf), [BT.1359-0](https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1359-0-199802-S!!PDF-E.pdf)). Positive = sound advanced relative to vision:

| Threshold | Sound early | Sound late |
|---|---|---|
| **Detectability** | +45 ms | −125 ms |
| **Acceptability** | +90 ms | −185 ms |
| **Overall end-to-end tolerance (BT.1359-1)** | +90 ms | −185 ms |
| **Producer control zone, source → zero reference** | +25 ms | −100 ms |
| **Zero reference → transmitter (BT.1359-0)** | +22.5 ms | −30 ms |

Corroborated independently ([TVTechnology](https://www.tvtechnology.com/opinions/managing-lip-sync-265013), [NAB](http://www.nab.org/xert/scitech/pdfs/tv100509.pdf), [ITE Japan study reporting the same 45/125 and 90/185 figures](https://www.jstage.jst.go.jp/article/tvtr/20/50/20_KJ00001961606/_article/-char/ja/), [ForaSoft summary](https://www.forasoft.com/learn/audio-for-video/articles-audio/lip-sync-itu-r-bt-1359-tolerance-windows), [ResearchGate](https://www.researchgate.net/publication/220902540_Audio-video_synchronization)).

**EBU R37**: specifies **+40 ms to −60 ms**, measured at the output feeding the transmitter ([TVTechnology, citing R37-2007](https://www.tvtechnology.com/opinions/managing-lip-sync-267386)). I attempted to fetch tech.ebu.ch/docs/r/r037.pdf directly and **could not** (PDF content type rejected; the publications page also failed extraction), so this figure rests on a secondary but reputable trade source. **Verify against the EBU original before quoting it in anything external.**

Related standard: ITU-T J.100 covers vision/sound transmission time difference tolerances ([ITU](https://www.itu.int/rec/dologin_pub.asp?id=T-REC-J.100-199006-I!!PDF-E&lang=e&type=items)).

**Perceptual research context** `[INDEP]`: natural audiovisual speech spans roughly 40 ms audio lead to 200 ms audio lag, with an asymmetric temporal integration window ([PLoS Comput Biol 2014](https://pmc.ncbi.nlm.nih.gov/articles/PMC4117430/), [PubMed](https://pubmed.ncbi.nlm.nih.gov/25079216/)). Older measurements found detection thresholds as tight as 30 ms for audio advance and 85 ms for delay ([TVTechnology](https://www.tvtechnology.com/miscellaneous/watermarking-technology-in-av-delay-correction)).

**The asymmetry is the actionable engineering fact**: audio *late* is tolerated 2–3x better than audio *early*, because distant events are naturally seen before heard ([Video StackExchange discussion](https://video.stackexchange.com/questions/25064/by-how-much-can-video-and-audio-be-out-of-sync)). If your dubbing pipeline must err, err late.

**Design target for your pipeline**: keep per-line audio-video offset inside **+40 / −60 ms (EBU R37)** to be broadcast-safe, and never exceed **+90 / −185 ms** (ITU acceptability). Note this makes AssemblyAI's ~400 ms stated word-timestamp accuracy unusable as a direct sync source, and makes a forced-alignment pass (sub-15 ms mean boundary error for MFA-class aligners) the correct architecture.

---

## What I could not verify

Be explicit about these before relying on anything above.

1. **Telugu-specific WER from any source.** ElevenLabs' Telugu page reuses a global figure. Speechmatics has a Hindi page (90% accuracy) but no Telugu equivalent. The independent Indian agricultural benchmark's per-language table would not extract. **Telugu remains a measurement blind spot.**
2. **EBU R37 primary text.** Both the PDF and the publications page failed to fetch. The +40/−60 ms figure is from a reputable trade source, not the standard itself.
3. **Papercup's own description of its human-in-the-loop process.** papercup.com/how-it-works failed extraction; the claim rests on third-party reviews.
4. **Sieve, Voiseed, Verbalate, Blabel, Sanas, Supertone, Voicegain, Gan.ai, Vodex, CoRover, Reverie** — no usable primary sources retrieved. Treat as unresearched, not as non-existent.
5. **Trint and Happy Scribe** first-party accuracy claims — only category round-ups found.
6. **Whether HeyGen, Synthesia, Rask, Dubverse or Speechify perform source separation or diarisation.** Not disclosed; not inferable with confidence.
7. **Any vendor figure for shouted, screamed or Lombard speech.** None exists in this survey.
8. **Deepdub, Camb.ai and Panjaya Hindi/Telugu quality.** Language counts published; per-language quality not.
9. **Cross-vendor comparisons sourced from competitors** (HeyGen on Rask/Dubverse; Sonix on Verbit/Fireflies/Otter; Rev on Verbit) are inherently biased. Flagged inline; do not treat as measurement.
10. **Accuracy figures on non-English languages generally.** The Artificial Analysis leaderboard is English-centric by its own methodology. There is no equivalent independent multilingual leaderboard covering Indian languages that I could locate.

---

## The three findings that should change your pipeline

1. **Timing and recognition are separate problems, and the market solves them separately.** Best-in-class ASR word timestamps are stated at ~400 ms (AssemblyAI, the only vendor honest enough to publish a number). Broadcast tolerance is +40/−60 ms. Forced aligners hit sub-15 ms mean boundary error. **You need an alignment stage; no ASR gives you dubbing-grade timing.**

2. **Source separation before ASR is the highest-leverage coverage intervention anyone has quantified.** AudioShake reports 25%+ transcription accuracy gains from clean dialogue stems; Deepdub builds it into the pipeline; research confirms it for sung audio. If dialogue is buried under Indian film music, separation is not optional.

3. **Coverage is a recall-plus-review problem, and Indian languages start ~10x behind English.** Best Indian-language WER published is ~19% (Sarvam on IndicVoices) against ~2% for English. Overlap pushes multi-speaker WER above 20% even in research systems. **Any product promise of complete Hindi/Telugu dialogue coverage without a human review surface is a promise nobody in this market is willing to make — including the vendors with the most to gain from making it.**
