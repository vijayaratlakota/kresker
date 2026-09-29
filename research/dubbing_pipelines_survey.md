# How dubbing pipelines actually place speech on the timeline

Survey of open-source projects, commercial products and the research literature, focused on four
mechanisms only: **the unit of timing**, **what happens when the translation does not fit**,
**whether anything re-aligns after TTS**, and **what accuracy is actually claimed and how it is measured**.
Source-audio-bed handling is recorded where disclosed.

Every claim carries an inline link. Sources were paraphrased; no passage of more than 25 consecutive
words is reproduced. Labels: `[CODE]` read from source code, `[DOC]` vendor/project documentation,
`[PAPER]` peer-reviewed or arXiv, `[VENDOR]` marketing, `[SNIPPET]` search-result snippet only
(page itself not fetched — weaker evidence).

---

## (a) The big table

### A.1 Open source

| Project | Unit of timing | Duration-mismatch strategy | Post-TTS realignment | Claimed accuracy | Audio bed |
|---|---|---|---|---|---|
| [SoniTranslate](https://github.com/R3gm/SoniTranslate) | Diarised WhisperX segment (`start`/`end`) `[CODE]` | `acc = tts_dur / slot_dur`, clamped to `max_accelerate_audio` (default 2.1), dead-zone 0.8–1.15 → 1.0, applied as ffmpeg `atempo`; optional "smooth" mode extends the slot into the following gap by 0.5× (same speaker) or 0.7× (speaker change) ([text_to_speech.py](https://raw.githubusercontent.com/R3gm/SoniTranslate/main/soni_translate/text_to_speech.py)) | No. Clips are overlaid at `start` on a silent bed sized to the last segment `end`; `avoid_overlap` instead *pushes the start later* (last_end −0.5 s / −0.2 s), which accumulates drift ([audio_segments.py](https://raw.githubusercontent.com/R3gm/SoniTranslate/main/soni_translate/audio_segments.py)) | None published | Optional vocal separation / "Overlap Reduction" flags ([README](https://github.com/R3gm/SoniTranslate)) |
| [VideoLingo](https://github.com/Huanshere/VideoLingo) | WhisperX word-level → NLP/LLM subtitle split → merged "dub chunks" ([docs/tech](https://docs.videolingo.io/en-US/docs/tech)) | Four-layer: (1) LLM **trims the translated text** against an estimated duration (`_8_1_audio_task`, `estimate_duration.py` — syllable counts + punctuation pauses); (2) `_8_2_dub_chunks` picks cut points from gaps and speaking rate; (3) ffmpeg speed factor with `min 1 / accept 1.2 / max 1.4`; (4) `tolerance: 1.5` s of extension into the next subtitle, `min_subtitle_duration: 2.5` s force-extended ([config.yaml](https://raw.githubusercontent.com/Huanshere/VideoLingo/main/config.yaml)) | `_10_gen_audio` validates duration and re-speeds; `_11_merge_audio` re-lays segments with silences from subtitle timings ([docs/tech](https://docs.videolingo.io/en-US/docs/tech)) | None. README concedes dubbing "may not be 100% perfect" due to speech-rate differences ([README](https://github.com/Huanshere/VideoLingo)) | Demucs `htdemucs` split; background re-mixed in `_12_dub_to_vid` ([docs/tech](https://docs.videolingo.io/en-US/docs/tech)) |
| [open-dubbing](https://pypi.org/project/open-dubbing/) (Softcatalà) | Utterance from pyannote diarisation + faster-whisper, stored as editable JSON with `start`/`end`/`speed` ([PyPI](https://pypi.org/project/open-dubbing/)) | **Slot = this utterance's start → next utterance's start**, i.e. the following pause is treated as usable headroom; `speed = dubbed_dur / slot`, rounded up to 0.1, capped at `MAX_SPEED = 1.3`; trailing TTS silence stripped first ([text_to_speech.py](https://raw.githubusercontent.com/Softcatala/open-dubbing/main/open_dubbing/text_to_speech.py)) | Yes — **re-synthesises** at the computed speed when the voice supports a rate parameter, else falls back to ffmpeg `adjust_audio_speed` ([same file](https://raw.githubusercontent.com/Softcatala/open-dubbing/main/open_dubbing/text_to_speech.py)) | None published | Demucs separates vocals ([PyPI](https://pypi.org/project/open-dubbing/)) |
| [Auto-Synced-Translated-Dubs](https://github.com/ThioJoe/Auto-Synced-Translated-Dubs) | **Human-authored SRT cue** — the cue timings *are* the spec ([README](https://github.com/ThioJoe/Auto-Synced-Translated-Dubs/blob/main/README.md)) | Stretch/shrink each clip to exactly the cue length (ffmpeg or rubberband); **two-pass mode** (default on) instead re-synthesises at the rate measured in pass 1; with Azure the desired duration is requested up front so no stretching is needed | Clips inserted at their cue time points, so sync is structurally preserved | None published. Notes that SRT exported from Descript preserves inter-sentence pauses, which matters for dub quality | Not handled (produces a dub track; separate SFX track merged by `TrackAdder.py`) |
| [pyVideoTrans](https://github.com/jianchang512/pyvideotrans) | Subtitle line; explicitly four operating modes ([blog 3](https://en.pyvideotrans.com/blog/audio-subtitles-video-sync-3)) | Modes: audio speed-up only / video slow-down only / both / pure concatenation. Decision rule: if factor ≤ 1.5 speed the audio; if > 1.5 add the following silent gap to the slot (`total_a`) and re-test; video slow-down via `setpts` hard-capped at PTS 10; last resort is trimming the dub or freezing the final frame ([blog 3](https://en.pyvideotrans.com/blog/audio-subtitles-video-sync-3), [align guide](https://en.pyvideotrans.com/align)) | Yes — a distinct `_finalize_files()` stage pads with silence or freezes the last frame so total audio equals total video ([blog 3](https://en.pyvideotrans.com/blog/audio-subtitles-video-sync-3)) | **Rare concrete number**: a 23-minute video went from visible drift of over ten seconds to roughly 200 ms residual ([blog 3](https://en.pyvideotrans.com/blog/audio-subtitles-video-sync-3)) | Not described in the sync articles |
| [Voxa](https://github.com/akshinmrv/Voxa) | Slot = a line's own onset → **the next line's onset**; segment starts tightened to the first word's timestamp ([README](https://github.com/akshinmrv/Voxa)) | Translator is given a **character budget** per line so it fits at a natural pace; audio is **only ever sped up, never slowed**; over-run is trimmed, short clips padded | The cursor is *assigned*, never accumulated — the README's stated design goal is that drift is structurally impossible. A **quality gate re-transcribes every clip** and scores WER, clipping, silence and pacing; flagged segments are re-synthesised up to twice and the best take kept | Demo claims 0.0 s drift against a naive concatenation drifting ~18 s (self-published) | Dub mixed over the original as a faint ambience bed; two-pass loudnorm |
| [Subdub](https://github.com/lukaszliniewicz/Subdub) (for Pandrator) | Subtitle block, with `-merge_threshold` 250 ms merging ([README](https://github.com/lukaszliniewicz/Subdub)) | `--speed_up` max 115 % during alignment; `--delay_start` allows up to 2000 ms of per-block delay | Dedicated `sync` task realigns already-generated speech with the video; `equalize` reflows line lengths | None published | FFmpeg mix; not detailed |
| [Edge-TTS-Subtitle-Dubbing](https://github.com/fr0stb1rd/Edge-TTS-Subtitle-Dubbing) | SRT cue, enforced as a **fixed time slot** ("Time-Slot Filling") | Time-stretch via `audiostretchy`; if the clip is short, silence fills the rest of the slot so the slot length is exact | Sample-accurate numpy concatenation at 24 kHz, then exact trim/pad to the reference video's sample count "to prevent drift" ([README](https://github.com/fr0stb1rd/Edge-TTS-Subtitle-Dubbing)) | Claims every block occupies exactly its SRT duration (self-published) | Optional `--ref_video` padding only |
| [Linly-Dubbing](https://github.com/Kedreamix/Linly-Dubbing) | WhisperX/FunASR segment; derived from YouDub-webui ([README](https://github.com/Kedreamix/Linly-Dubbing)) | README documents adjusting **overall playback speed** plus background-music volume as user controls; per-segment fitting not documented in the README (source file `tools/step042_tts.py` could not be fetched — **unverified**) | Not documented | None published | Demucs and UVR5 vocal separation |
| [KrillinAI / KlicStudio](https://github.com/krillinai/KlicStudio) | Word-level ASR → subtitle; repo history contains a commit titled "新版时间戳匹配算法" (new timestamp-matching algorithm) ([repo](https://github.com/krillinai/KlicStudio)) | Not documented at README level | Not documented | None published | Not documented |
| [ViDubb](https://github.com/medahmedkrichen/ViDubb) | Sentence/segment with diarisation ([README](https://github.com/medahmedkrichen/ViDubb)) | Relies on Wav2Lip to fix the *picture* rather than the audio length; ships "with background" and "without background" variants | Wav2Lip re-renders mouths against the new audio | "Perfect lip-sync" claimed, no measurement `[VENDOR]` | Background separation, both modes shipped |
| [WeeaBlind](https://github.com/FlorianEagox/WeeaBlind) | Subtitle-driven dub/voice-over of existing media ([repo](https://github.com/FlorianEagox/WeeaBlind)) `[SNIPPET]` | Not documented | Not documented | None | Ducking of original audio is the tool's premise |
| [AutoDub](https://github.com/frrobledo/AutoDub) | Segment | **Dynamically adjusts video speed** to fit the dub, rather than only the audio ([repo](https://github.com/frrobledo/AutoDub)) | Not documented | None | Not documented |
| [Ai-Vedio-Dubbing](https://github.com/DjebrilSVN/Ai-Vedio-Dubbing) | Segment (Whisper + pyannote) | Describes "mathematically" timing dialogue to the original pacing ([repo](https://github.com/DjebrilSVN/Ai-Vedio-Dubbing)) `[SNIPPET]` | Not documented | None | Demucs isolation plus explicit **ducking** of the bed |
| [youtube-auto-dub](https://github.com/mangodxd/youtube-auto-dub) (mangodxd) | Whisper segment → Edge-TTS | "Smart audio-video synchronization" (unspecified) ([repo](https://github.com/mangodxd/youtube-auto-dub)) `[SNIPPET]` | Not documented | None | Background music preservation claimed |
| [youtube-auto-dub](https://github.com/mazzasaverio/youtube-auto-dub) (mazzasaverio) | Downloaded subtitles as the timing spec ([repo](https://github.com/mazzasaverio/youtube-auto-dub)) `[SNIPPET]` | Not documented | Not documented | None | OpenVoice timbre match |
| [videodubber](https://github.com/am-sokolov/videodubber) | Whole-file transcribe → translate → single TTS pass → merge ([repo](https://github.com/am-sokolov/videodubber)) `[SNIPPET]` | None — this is the naive architecture that drifts | None | None | Replaces the track |
| [openclaw-skill-videotranslate](https://github.com/zbjincheng/openclaw-skill-videotranslate) | Subtitle cue | "Automatically aligns and stretches audio clips to fit the original timeline"; muxes dual audio/subtitle tracks ([repo](https://github.com/zbjincheng/openclaw-skill-videotranslate)) `[SNIPPET]` | Not documented | None | Dual-track output keeps the original available |
| [videoTranslator](https://github.com/Felixdiamond/videotranslator) (Felixdiamond) | Segment | Not documented | Not documented | None | Explicitly preserves background SFX/music and re-muxes ([repo](https://github.com/Felixdiamond/videotranslator)) `[SNIPPET]` |
| [AI-Powered-Video-Dubbing-Platform](https://github.com/VikasRathore162/AI-Powered-Video-Dubbing-Platform) | Diarised segment; per-speaker voices; outputs "time-synced" video plus SRT `[SNIPPET]` | Not documented | Not documented | None | Not documented |
| [DubFlow](https://github.com/Badri467/DubFlow) | YouTube transcript cue `[SNIPPET]` | Not documented | Not documented | None | Not documented |
| [Video_Dubbing_with_ML_driven_Lip_Synchronization](https://github.com/Syedjunaid30/Video_Dubbing_with_ML_driven_Lip_Synchronization) | Segment; Wav2Lip fixes the picture; Hindi/French/German/Spanish `[SNIPPET]` | Visual re-render instead of audio fitting | Wav2Lip | None | Not documented |
| [Modablag](https://github.com/ElsebaiyMohamed/Modablag) | Study + system; states synchronisation between lip movement and dubbed speech as the objective `[SNIPPET]` | Not documented | Not documented | None | Not documented |
| [NERV-TRANSLATE](https://github.com/Hrishikesh-Gavai/NERV-TRANSLATE) | Dubbing system, no timing detail published `[SNIPPET]` | — | — | None | — |
| [Srt-AI-Voice-Assistant](https://github.com/YYuX-1145/Srt-AI-Voice-Assistant) | SRT cue, multi-engine TTS `[SNIPPET]` | Not documented | Not documented | None | — |
| [AutoSubReTimer](https://github.com/AndryOut/AutoSubReTimer) | Existing subtitle lines re-timed against detected speech onsets/offsets in the audio track `[SNIPPET]` | n/a (retimes the *cues*, not the speech) | This **is** a realignment tool — useful as a pre-pass | None | — |
| [ffsubsync](https://github.com/smacke/ffsubsync) | Whole-file: VAD + FFT cross-correlation to recover a global offset **and a time-scale factor**, framerate-ratio inference by golden-section search ([README](https://github.com/smacke/ffsubsync/blob/master/README.md), [releases](https://github.com/smacke/ffsubsync/releases)) | n/a | Global re-anchor; used as an "AutoSync" step by e.g. [anime_translation](https://github.com/tekakutli/anime_translation/) | None | — |
| [aeneas](https://github.com/readbeyond/aeneas) | Text fragment → audio interval (forced alignment) ([site](https://www.readbeyond.it/aeneas/)) | n/a | Produces the sync map others place against | None | — |
| [seamless_communication](https://github.com/facebookresearch/seamless_communication) (SeamlessExpressive / SeamlessStreaming) | End-to-end S2ST, **no explicit slot** — UnitY2's non-autoregressive text-to-unit decoder predicts the duration of each segment; an expressivity encoder guides unit generation with rhythm, speaking rate and pauses ([Meta blog](https://ai.meta.com/blog/seamless-communication/)) | Duration is *modelled*, not corrected: speech rate and pauses are transferred from source to target rather than fitted to a slot | None needed — durations come out of the model | Claims content quality maintained while better preserving style and speech rate; SeamlessStreaming claimed SOTA latency/quality ([blog](https://ai.meta.com/blog/seamless-communication/)) `[VENDOR/PAPER]` | n/a (speech-to-speech, no bed) |
| [sievesync](https://github.com/sieve-community/sievesync/blob/main/README.md) | Zero-shot lipsync over MuseTalk + LivePortrait + CodeFormer — fixes the picture to the audio | n/a | n/a | None | n/a |
| Time-scaling libraries used as the actual "fit" step | Sample-level | [rubberband](https://breakfastquay.com/rubberband/), ffmpeg `atempo`, [audiostretchy](https://github.com/fr0stb1rd/Edge-TTS-Subtitle-Dubbing), [audiotsm](https://github.com/Muges/audiotsm), [sonic](https://github.com/waywardgeek/sonic) and **[google/speedy](https://github.com/google/speedy)**, which speeds each part of a word at a *different* rate to preserve intelligibility | — | — | — |
| [google/ai_video_dubbing](https://github.com/google/ai_video_dubbing) | Spreadsheet-row-driven Google TTS localisation, Terraform-deployed; includes a "no separate base audio" mode ([repo](https://github.com/google/ai_video_dubbing)) | Not documented | Not documented | None | Base-audio handling is an explicit switch |
| [Ariel](https://github.com/google-marketing-solutions/ariel) / [ariel_on_sheets](https://github.com/google-marketing-solutions/ariel_on_sheets) (Google Marketing Solutions) | Utterance; notebook workflow exposes an **interactive "tune" step** that the Sheets front-end deliberately omits ([ariel_on_sheets](https://github.com/google-marketing-solutions/ariel_on_sheets)) | Not documented publicly | Human tune loop is the mechanism | None | Supports scripted dubbing for silent sources |

### A.2 Commercial

| Product | Unit of timing | Duration-mismatch strategy | Post-TTS realignment | Claimed accuracy | Audio bed |
|---|---|---|---|---|---|
| [ElevenLabs Dubbing Studio](https://elevenlabs.io/docs/creative-platform/products/dubbing) | Per-speaker **clip on a timeline**; exports AAF timeline data and per-speaker WAVs. API `manual` mode accepts a **CSV of timecodes** with an explicit `csv_fps` ([API](https://elevenlabs.io/docs/api-reference/dubbing/create)) | Studio: manual clip editing, "stale" regeneration. Dubbing v2 is fully automatic with **no editing** ([docs FAQ](https://elevenlabs.io/docs/creative-platform/products/dubbing)) | v2 is described as a **sync-aware translation system that aligns starts, stops and pacing automatically** ([blog](https://elevenlabs.io/blog/introducing-dubbing-v2)) — i.e. re-timing is folded into translation, not a post-pass | No sync number published. TTS side exposes character-level timestamps for building your own alignment ([convert-with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)) | API takes separate `foreground_audio_file` and `background_audio_file` in CSV mode ([API](https://elevenlabs.io/docs/api-reference/dubbing/create)); no lip sync offered |
| [HeyGen Video Translate](https://developers.heygen.com/docs/video-translation-precision) | Segment; Enterprise can supply an `srt` with `srt_role` = input or output; proofread loop downloads/uploads SRT before final render | **`enable_dynamic_duration` (default true) lets the output duration vary to match natural speech pacing** — i.e. the video is re-timed to the speech, not the reverse ([docs](https://developers.heygen.com/docs/video-translation-precision)) | Precision mode re-renders the mouth with avatar inference against the translated audio | No number. Marketing tiers "Quality" as better timing and lip-sync ([academy](https://www.heygen.com/en-ca/academy/localization/how-to-translate-your-video)) `[VENDOR]` | `disable_music_track` strips background; `enable_speech_enhancement` optional |
| [Descript](https://help.descript.com/repurpose/translate-overview) | **Chunk sized to be a reasonable timing unit** while staying semantically whole ([OpenAI case study](https://openai.com/index/descript/)) | Two named styles: **Match timing** (translation is rewritten — including adding descriptive words — to hit the duration, slower to process) vs **Direct translation** (literal, then audio is sped/slowed) ([docs](https://help.descript.com/repurpose/translate-overview)). The engine counts syllables per chunk and, using language-specific speaking-rate assumptions, sets a target syllable count; neighbouring chunks are passed as context | Lip sync optionally re-renders mouths | **The best-quantified commercial claim found**: duration adherence improved by **13 to 43 percentage points** depending on language, and dubbed exports rose 15 % in the first 30 days, after moving duration optimisation into generation instead of post-correction ([OpenAI case study](https://openai.com/index/descript/)) | Not documented in these pages |
| [Google Aloud](https://www.blog.google/technology/area-120/aloud/) / [YouTube auto-dubbing](https://support.google.com/youtube/answer/15569972?hl=en-IN) | **Subtitle cue** — you supply video plus subtitles, or review the generated transcript ([blog](https://www.blog.google/technology/area-120/aloud/)) | Named components are audio separation, MT and speech synthesis. YouTube's own help states videos are **ineligible when the speech is too fast to dub without an unlistenable sped-up result** — an explicit admission that speech rate is the binding constraint | Auto dubs cannot be edited, only accepted or rejected ([YouTube Help](https://support.google.com/youtube/answer/15569972?hl=en-IN)) | Aloud claimed a 5-minute video dubbed in ~10 minutes ([Voicebot](https://voicebot.ai/2022/03/10/googles-area-120-lab-rolls-out-free-ai-powered-video-dubbing-translator-tool/)); no sync figure | Audio separation is named as a core component |
| [Synthesia](https://www.synthesia.io/post/how-to-translate-your-videos-into-any-language) | Scene/script block on a timeline ([timeline help](https://help.synthesia.io/en/articles/11498916-how-do-i-use-the-timeline-in-synthesia)) | **"Adaptive" vs "Original" video duration** — Adaptive lets the dubbed video's length change to fit the translation ([post](https://www.synthesia.io/post/how-to-translate-your-videos-into-any-language)); per-voice speed slider is bounded 0.8×–1.2× ([help](https://help.synthesia.io/en/articles/13770160-how-do-i-change-an-avatar-s-voice)) | Lip movements synced to the new voiceover ([docs](https://docs.synthesia.io/docs/video-dubbing)) | None | Not documented |
| [Kapwing](https://www.kapwing.com/help/advanced-dubbing-tips/) | Subtitle segment | A "Timing toggle" / video-speed permission: when enabled Kapwing adjusts **both audio and video speed** for a more natural pace ([tips](https://www.kapwing.com/help/advanced-dubbing-tips/), [how-to](https://www.kapwing.com/help/how-to-dub-on-kapwing/)) `[SNIPPET]` | Optional automatic lip sync; re-editing subtitles forces a full re-lip-sync ([lip-sync help](https://kapwing.com/help/how-to-apply-lip-syncing/)) | States generative AI adjusts timing "as closely as possible" ([FAQ](https://kapwing.com/help/dubbing-faqs/)) `[VENDOR]` | Not documented |
| [Vozo](https://vozo.ai/docs/translate_dub/auto_align_audio_video) | Speech block on a timeline with drag handles that stretch/compress ([editor docs](https://docs.vozo.ai/edit_script_dub/get_started)) `[SNIPPET]` | **"Auto Align Audio & Video" adjusts both video and audio speed segment by segment**, within a bounded range ([docs](https://vozo.ai/docs/translate_dub/auto_align_audio_video), [get started](https://vozo.ai/docs/translate_dub/get_started)) | Manual speed/volume/pitch panel per block | None | Original audio not modifiable |
| [Maestra](https://maestra.ai/solutions/video-dubbing) | Individual dubbed **line** | Stretch or compress each line to the original timing while avoiding voice distortion ([solutions page](https://maestra.ai/solutions/video-dubbing)) `[SNIPPET]` | Not documented | None | Not documented |
| [Dubverse](https://dubverse.ai/blog/product-update-resync-mode/) | Segment on a timeline; "Resync Mode" with timeline + slider + **CPS (characters-per-second) readout that turns red when a slot is squeezed too hard** ([blog](https://dubverse.ai/blog/product-update-resync-mode/)) | Per-segment speed slider, guided by CPS; Studio also surfaces source vs target word counts so users can see over-long translations ([Studio blog](https://dubverse.ai/blog/introducing-studio/)) | Human-in-the-loop resync is the mechanism | Translation accuracy only: >95 % for English/Spanish, ~85 % for other languages ([FAQs](https://dubverse.ai/faqs/)) `[VENDOR]` — no sync figure | Not documented |
| [Rask AI](https://docs.api.rask.ai/workflow/lipsync) | Segment; lip-sync billed separately from dubbing and applied to the whole video length ([API docs](https://docs.api.rask.ai/workflow/lipsync)) | Lip-sync is offered as the **remedy for sync problems the user notices** ([help centre](https://help.rask.ai/hc/the-lip-sync-feature-rask-help-center)) — i.e. visual correction rather than temporal fitting | Multi-speaker lip-sync re-renders each speaker's mouth ([blog](https://www.rask.ai/blog/rask-ai-launches-a-lip-sync-multi-speaker-feature)) | Described qualitatively: refined phonetic matching, improved naturalness ([ML lab interview](https://www.rask.ai/blog/behind-the-scenes-our-ml-lab)) `[VENDOR]` | Not documented |
| [Papercup](https://staging.papercup.com/) | Not disclosed | Not disclosed. Positioning is AI voices **perfected by humans** ([site](https://staging.papercup.com/)); third-party description is that the pipeline analyses source speech patterns then generates matched voiceovers ([Speechify guide](https://speechify.com/blog/the-ultimate-guide-to-papercup-dubbing/)) `[SNIPPET]` | Human QC pass | None | Not disclosed |
| [Deepdub](https://deepdub.ai/technology) | Line-by-line; publishes a glossary entry defining **"Beat Sync"** as aligning the rhythm, pauses and emotional beats of the original with the dub ([glossary](http://deepdub.ai/glossary/beat-sync)) | Not disclosed; eTTS with accent/style control plus human QC ([FAQs](https://deepdub.ai/faqs)) | Not disclosed | Voice-latency numbers only (sub-250 ms TTFA for the agent API) ([voice API](https://deepdub.ai/voice-api-for-agents)) | Music and effects split out during dubbing ([M&E page](https://deepdub.ai/solution/media-entertainment)) |
| [Respeecher](https://www.respeecher.com/blog/speech-to-speech-vs-text-to-speech-guide) | n/a — **speech-to-speech**: the actor's real performance is retained and only the voice identity is changed, so timing is inherited rather than constructed ([guide](https://www.respeecher.com/blog/speech-to-speech-vs-text-to-speech-guide)) | Structurally avoided: a human voice actor already fitted the timing | n/a | None | n/a |
| [Camb.ai](https://www.camb.ai/blog-post/how-to-add-ai-dubbing-integration) | BOLI (speech-to-text-translation) → MARS8 TTS as separate API stages ([integration post](https://www.camb.ai/blog-post/how-to-add-ai-dubbing-integration)) | Not disclosed. Their own buyer's checklist names timing synchronisation as one of five pipeline stages that each degrade the result ([checklist](https://www.camb.ai/blog-post/ai-dubbing-quality-buyers-checklist)) | Not disclosed | None for sync | Not disclosed |
| [Sieve](https://sync.so/blog/sync-x-sieve-partnership/) | Composable video-AI functions; partners with sync.so for the lipsync layer ([sync.so blog](https://sync.so/blog/sync-x-sieve-partnership/)) | Pipeline parameters exposed for cost/quality trade-offs ([overview](https://www.aitoolnet.com/sieve)) `[SNIPPET]` | Lipsync stage | None | Not documented |
| [sync.so](https://sync.so/docs/tutorials/translation-dubbing) | Video + generated audio; the model re-renders mouths to the new track ([tutorial](https://sync.so/docs/tutorials/translation-dubbing)) | Visual correction, not temporal fitting | This *is* the realignment step for other pipelines | None | n/a |
| [Speechify Studio](https://speechify.com/blog/tts-for-video-dubbing-and-localization/) | Their own write-up names **script segmentation, time-code alignment and lip-sync trade-offs** as the required workflow ([blog](https://speechify.com/blog/tts-for-video-dubbing-and-localization/)) | Not disclosed | Not disclosed | None | Not disclosed |
| [Vidby](https://vidby.com/video-translation) | Not disclosed | Not disclosed; human review is an option | Not disclosed | 99–100 % **translation** accuracy widely repeated ([tech.eu](https://tech.eu/2023/05/03/vidby-is-bridging-vidby-bridging-language-barriers-with-ai-powered-video-translation-and-dubbing-across-70-languages/), [Wikipedia](https://en.wikipedia.org/wiki/Vidby)) — not a sync claim | Not disclosed |
| [Wavel AI](https://wavel.ai/solutions/dubbing/auto-dubbing) | Segment | Separate "video speed controller" tool that re-syncs audio to the new video speed ([tool](https://wavel.ai/studio/video-speed-controller)) `[SNIPPET]` | Not documented | None | Not documented |
| [Adobe Premiere Pro](https://helpx.adobe.com/premiere-pro/using/translate-captions.html) | Caption track. Adobe ships **caption translation only** (Google/Microsoft models, new timeline track), not native dubbing ([help](https://helpx.adobe.com/premiere-pro/using/translate-captions.html)) | Relevant adjacent tool: **Generative Extend** generates additional length for video *and audio* clips ([Adobe blog](https://blog.adobe.com/en/publish/2025/04/02/introducing-new-ai-powered-features-workflow-enhancements-premiere-pro-after-effects)) — the "grow the picture to fit the dub" primitive. Dubbing itself arrives via plugins such as [Perso Dubbing](https://exchange.adobe.com/apps/cc/0ed2d668/perso-dubbing) | Text-Based Editing aligns clip timing to spoken words ([docs](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/overview-of-text-based-editing.html)) | None | AI classifies dialogue vs music vs SFX per clip ([audio page](https://www.adobe.com/products/premiere/edit-audio)) |
| [VideoDubber.ai](https://videodubber.ai/docs/) | Segment; "synchronized subtitles" plus optional lip sync ([docs](https://videodubber.ai/docs/)) `[SNIPPET]` | Not disclosed | Lip sync | None | Not disclosed |
| [RWS](https://www.rws.com/localization/services/translation-services/video-and-audio-translation/ai-dubbing-and-vo/) | Editable transcript + translation, with human validation | Their differentiator is **cross-lingual prosody transfer (XLPT)** preserving tone and pacing, plus editing to refine synchronisation ([service page](https://www.rws.com/localization/services/translation-services/video-and-audio-translation/ai-dubbing-and-vo/)) | Human audio engineering pass | None | Professional mixing stage |
| Azure Speech (used as the fitting primitive by others) | Per-`<voice>` block | **`mstts:audioduration` requests an exact output duration**, one per voice block ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/1662493/how-to-have-multiple-mstts-audioduration-in-a-sing)); the older recipe is synthesise-at-default-then-recompute `prosody rate` ([Azure samples wiki](https://github.com/Azure-Samples/Cognitive-Speech-TTS/wiki/How-to-scale-TTS-output-duration-to-a-given-length)) | This is why Auto-Synced-Translated-Dubs skips stretching entirely on Azure | — | — |

**Pattern across the whole table.** Four families, and almost everyone picks from them:

1. **Fit the audio to a fixed slot** (time-stretch or re-synthesise faster) — the default everywhere, with the cap sitting between 1.15× and 2.1× depending on how much the project cares about quality.
2. **Fit the text to the slot** (length-budgeted or LLM-rewritten translation) — VideoLingo, Voxa, Descript, ElevenLabs v2, and the entire Amazon research line.
3. **Fit the picture to the audio** (re-time video, freeze frames, or re-render mouths) — pyVideoTrans, HeyGen `enable_dynamic_duration`, Synthesia Adaptive, Kapwing, Vozo, AutoDub, plus every Wav2Lip/sync.so integration.
4. **Avoid the problem** — speech-to-speech (Respeecher), or end-to-end duration modelling (SeamlessExpressive).

Only three projects in the survey treat **drift as a structural property to be designed out** rather than a bug to be patched: Voxa (cursor assigned, never accumulated), Edge-TTS-Subtitle-Dubbing (exact sample-count trim/pad) and pyVideoTrans (a dedicated finalise stage). Everyone else lays clips end-to-end somewhere in the pipeline and accumulates error.

---

## (b) Isochrony and prosodic alignment: the research, with numbers

This body of work is mostly Amazon/AWS AI (Federico, Virkar, Lakew, Mathur, Thompson) and it is the
most directly applicable material in the survey, because it targets exactly the question of where a
dialogue line goes and how long it is allowed to be.

### b.1 The vocabulary, and why it matters

Dubbing synchrony has three levels, in priority order: **isochrony** (utterance-level start/stop
match), **lip synchrony**, and **kinesic synchrony** (body movement)
([Lakew et al. 2021](https://arxiv.org/pdf/2110.03847v1.pdf), citing Chaume). Essentially all
automatic-dubbing research targets isochrony only. A **pause** is conventionally defined as ≥ 300 ms
of silence between two words, and a **phrase**/segment is the text between two pauses
([Tam et al. 2022](https://arxiv.org/pdf/2112.08548v2); the 300 ms figure recurs across
[Federico et al. 2020](https://www.isca-archive.org/interspeech_2020/federico20_interspeech.pdf),
[Virkar et al. 2022](https://arxiv.org/pdf/2204.02530v1.pdf) and
[Pal et al. 2023](https://arxiv.org/html/2305.13204v1)).

**Isometry ≠ isochrony.** Matching character counts is the cheap proxy nearly everyone uses, and the
literature has now measured how bad it is (see b.5). Pal et al. state plainly that isometry is only
weakly correlated with isochrony ([2305.13204](https://arxiv.org/html/2305.13204v1)).

### b.2 The reference architecture

The Amazon pipeline is ASR → **MT with verbosity control** → **prosodic alignment (PA)** → **TTS with
precise duration control** → **audio rendering** that re-inserts the original background (extracted
with deep U-Nets) and re-applies reverberation estimated from the source
([Lakew et al. 2021](https://arxiv.org/pdf/2110.03847v1.pdf)). Note that the *bed* is treated as a
first-class stage, not an afterthought: separate, then re-add noise **and room reverb** so the
synthetic voice sits in the same space.

### b.3 Prosodic alignment — the mechanism worth copying

**Öktem, Farrús & Bonafonte, Interspeech 2019** introduced prosodic phrase alignment for machine
dubbing, using the neural MT model's own attention weights to project source phrase boundaries onto
the target ([arXiv 1908.07226](https://arxiv.org/html/1908.07226v1)).

**Federico, Virkar, Enyedi & Barra-Chicote, Interspeech 2020** replaced that with a language-agnostic
formulation. Given a source sentence segmented at *k* breakpoints with known time intervals, find the
*k* breakpoints in the **target** that maximise a log-linear model, solved by dynamic programming
over a Markov factorisation. Four features
([paper](https://www.isca-archive.org/interspeech_2020/federico20_interspeech.pdf)):

1. **Speaking-rate variation** between consecutive target segments (penalise a dub that lurches between fast and slow).
2. **Speaking-rate match** between corresponding source and target segments — where a segment's rate is the ratio of *TTS-at-normal-speed duration* to the interval length. Source rate is clipped to 60–140 %.
3. **Isochrony score** for boundary **relaxation**: each target segment may extend left by δ_l and right by δ_r, each drawn from {0, ¼, ½, ¾, 1} of the minimum silence interval Δε (300 ms), with the constraint δ_r ≤ 1 − δ_l so neighbours cannot overlap. Crucially the weighting is asymmetric — α > 4/5 — because **running late past the actor's mouth closing is far more tolerable than starting early**.
4. **Language-model score** of the candidate target break point, computed over a part-of-speech 3-gram LM with the break mapped to a punctuation class.

Metrics defined in the same paper: **Accuracy** (% of sentences whose segmentation exactly matches a
human reference — one missed breakpoint fails the whole sentence), **Fluency** (% of sentences where
*every* segment's TTS rate lands in 60–140 %), **Smoothness** (mean stability of TTS rate across
adjacent segments).

Results on 120 annotated English→Italian TED clips (187 breakpoints, 307 segments, 5-fold CV):

| | A = prior work | B = new model, no relaxation | C = new model + relaxation | R = human reference |
|---|---|---|---|---|
| Accuracy | 49.17 % | 65.83 % | **71.67 %** | 100 % |
| Fluency | 54.17 % | 71.67 % | **89.17 %** | 68.33 % |
| Smoothness | 65.74 % | 81.33 % | **87.40 %** | 73.15 % |

Relative to A: **+45.8 % accuracy, +64.6 % fluency, +32.9 % smoothness**, all p < 0.01. In a 50-clip
subjective test model C beat A on wins 45.6 % vs 28.5 % (+60 % relative) and on 0–10 score 5.10 vs
4.72. Against the human reference C lost only 3.5 % on score. Two findings from their mixed-effects
analysis matter operationally: **Accuracy is the only automatic metric with a statistically
significant effect on human score** (p < 0.001) — Fluency has none — and the amount of relaxation
used had **no significant negative effect** on perceived quality. The relaxation is close to free.

**Virkar, Federico, Enyedi & Barra-Chicote, Interspeech 2022 — off-screen relaxation.** The same PA
model, extended so that on-screen sentences get **local** relaxation inside the sentence while
off-screen sentences get a **global** relaxation optimised across all off-screen sentences by dynamic
programming, using the entire inter-phrase and inter-sentence intervals rather than a capped
fraction. Scoring saturates: target rate below 1.0 scores maximally (you can always contract), above
2.0 scores minimally (unintelligible) ([arXiv 2204.02530](https://arxiv.org/pdf/2204.02530v1.pdf)).
On four directions (En→Fr/It/De/Es), 15 four-sentence clips per condition: Smoothness **+9.9 % to
+28.3 %**, Fluency **+6.1 % to +17.1 %**, Intelligibility **+0.6 % to +14.5 %** over isochrone-only PA.

### b.4 Making the translation the right length

**Lakew, Federico, Wang, Hoang, Virkar, Barra-Chicote, Enyedi 2021 — "Machine Translation Verbosity
Control for Automatic Dubbing"** ([arXiv 2110.03847](https://arxiv.org/pdf/2110.03847v1.pdf)).
Target: translations within **±10 % of source length in characters** (characters empirically beat
syllables for this). Methods compared, with verbosity measured as % of outputs inside the ±10 % band
and quality as SacreBLEU on 620 human post-edited sentences (En→It/Fr/De/Es, MuST-C):

- **Length penalty** at search time (α = 0.5) — small gains on both axes.
- **Verbosity token** prepended to the source, trained by bucketing training pairs on target/source length ratio: Short < 0.97, Normal 0.97–1.05, Long > 1.05. Two-stage fine-tuning of the token puts compliance **above 70 % in every pair**.
- **Verbosity embeddings** (summed into encoder/decoder embeddings, or as an output-layer bias) — inconsistent; embeddings hurt quality on De/Es, the bias helped nothing.
- **N-best rescoring** over a beam of 50 with a synchrony sub-score. Their contribution is a **unidirectional** score, `S_p = (1 + len(t)/len(s))^-1`, replacing the symmetric `(1 + |len(t) − len(s)|)^-1`, on the reasoning that translating out of English you almost always need to *shorten*, never lengthen — so a symmetric score fights itself.

Best system = verbosity token + two-stage fine-tuning + ratio rescoring: **length compliance above
90 % for three of four pairs, 89.9 % for Italian**, with BLEU *up* in three (+1.4 It, +1.5 Fr,
+0.70 De) and −2.5 % relative on Spanish. Subjective head-to-head on dubbed clips (40 subjects,
~2,000 judgments per variant): Italian 38.7 % wins vs 32.45 % (p < 0.01), German 40.0 % vs 33.64 %
(p < 0.02).

**Lakew, Virkar, Mathur, Federico — "Isometric MT / NMT for Automatic Dubbing"**
([arXiv 2112.08682](https://arxiv.org/html/2112.08682v2)) generalises the ±10 %-in-characters target
and shows that the two-step generate-n-best-then-rerank approach costs quality, which single-model
control avoids.

**Tam, Lakew, Virkar, Mathur, Federico 2022 — Isochrony-Aware MT** ([arXiv
2112.08548](https://arxiv.org/pdf/2112.08548v2)) asks the MT model to emit `[pause]` tokens itself,
collapsing MT + PA into one model. Metrics: **SA** (segmentation accuracy — % of sentences where the
target has the same number of pauses as the source) and **PhraseLC** (% of sentences where *every*
target phrase is within 10 % of its corresponding source phrase in characters).

| En→De | BLEU | ChrF-Phrase | SA | PhraseLC | Acceptability |
|---|---|---|---|---|---|
| MT + separate PA (cascade baseline) | 27.5 | 58.5 | 100 | 16.1 | 9.6 |
| Lakew et al. verbosity-control MT + PA | 38.4 | 60.0 | 100 | 43.1 | 25.8 |

The simple `[pause]`-token model (B) beat the cascade (A) on Smoothness (De +8.5 %, Fr +18.5 %) and
on subjective wins (De +28.1 %, Fr +3.5 %, p < 0.01 for De). The *aggressive* phrase-level length
control variant (C) had better smoothness but B beat it on wins by **+57.1 % (De) and +137.9 % (Fr)**
— over-tightening length is worse than mild mistiming. Two structural notes: **disentangled/factored
pause features collapsed segmentation accuracy from ~99 to 30.1**, and once the relaxation mechanism
from Federico 2020 is applied, the cascade with verbosity control catches back up because it
produces more acceptable translations. Their headline caution: `PhraseLC` at 16 % for a plain
cascade means **a phrase-level length constraint is violated five times out of six by default**.

### b.5 Predicting duration instead of guessing it

**Chronopoulou, Thompson, Mathur, Virkar, Lakew, Federico 2023 — "Jointly Optimizing Translations and
Speech Timing"** ([arXiv 2302.12979](https://arxiv.org/html/2302.12979v1)). The model emits **target
phonemes *and* their durations** directly (the representation FastSpeech-style TTS wants), taking
desired segment durations as input. Metric: **speech overlap = 1 − |source dur − dub dur| / source dur**.

- Baselines StdMT, IsoMT and Txt2Phn all land at **SO ≈ 0.5**, because FastSpeech2 predicts target durations with no knowledge of the source timing.
- Their joint model reaches **+55 % relative speech overlap** over both Txt2Phn and StdMT, costing 2.7 % and 9 % of translation quality respectively.
- **Isometric MT is indistinguishable from standard MT on isochrony** when both are fed to the same TTS. That is a direct empirical attack on the character-count approach.
- Gaussian noise on the input durations trades overlap back for BLEU monotonically — an explicit tuning knob.

**Pal, Thompson, Virkar, Mathur, Chronopoulou, Federico, Interspeech 2023 — "Target Factors and
Auxiliary Counters"** ([arXiv 2305.13204](https://arxiv.org/html/2305.13204v1)). Durations become a
**target factor** predicted alongside phonemes, plus **auxiliary counters** fed back into the decoder
so it tracks total/pause/segment duration remaining. De→En, CoVoST-2:

| Model | BLEU | Speech Overlap |
|---|---|---|
| Text-to-text MT | 38.0 | – |
| Interleaved phonemes+durations, no noise | 32.0 | 0.8702 |
| Single target factor, no noise | 33.8 | 0.8931 |
| **+ all counters, no noise** | 34.0 | **0.9887** |
| + all counters, noise 0.1 | 35.6 | 0.8649 |

Correctly recomputing counter values before feeding them back moved overlap **0.9181 → 0.9972**.
Data prep is worth copying wholesale: run **MFA** on the target audio, mark ≥ 300 ms silences as
`[pause]`, tag word ends, sum phoneme durations between pauses to get segment durations, and **bin
those durations into 100 equal-frequency buckets** used as source-side tags to avoid sparsity.

**Isochrony-Controlled Speech Translation** ([arXiv 2411.07387](https://arxiv.org/html/2411.07387v1))
applies the same idea to Zh→En and reports **0.92 speech overlap at 8.9 BLEU, only 1.4 BLEU below the
unconstrained ST baseline**.

**VideoDubber (Wu et al., AAAI 2023)** ([arXiv 2211.16934](https://arxiv.org/abs/2211.16934)) makes
the same argument from Microsoft: control the **speech duration of each token**, guiding each word's
prediction with its own duration and the duration remaining for the rest of the sentence. Four
directions (De→En, Es→En, Zh↔En) plus a real-film test set they built because public data lacked one.

**IsoChronoMeter (ICM)** ([arXiv 2410.11127](https://arxiv.org/html/2410.11127)) is the cheap
measurement tool this survey was missing: run an **MMS-TTS duration predictor** over the source text
and the candidate translation and take the relative squared error. ICM = 0 is perfect; ICM = 0.5
means one prediction is half the other. No gold data, no audio, no reference needed — it works as a
pre-synthesis gate. They also define **A-ICM = (1 − ICM) × QE** to combine isochrony with
Blaser-2.0 quality estimation, and note the metric needs ~20+ tokens to be reliable. Their headline
finding: normal translations, including LLM and *human* translations produced without isochrony in
mind, do not reach a good isochrony level.

**PS-TTS (Hong et al., ICPR 2026)** ([arXiv 2604.09111](https://arxiv.org/abs/2604.09111v1)) adds the
next layer: first paraphrase the translation with an LM to hit the source duration, then apply
**phonetic synchronisation via DTW over vowel-distance local costs** so target vowels look like
source vowels. The PS-Comet variant balances phonetic and semantic similarity and is reported to beat
human voice actors on objective metrics for Ko↔En.

**DubWise (Sony Research India, Interspeech 2024)** ([arXiv 2406.08802](https://arxiv.org/html/2406.08802v1))
controls TTS duration from **video tokens** — cross-modal attention in a GPT-based TTS with a duration
controller network, aligning to the speaker's visible lip movements even across languages. Notable
because it is Indian-authored and duration is conditioned on the picture, not on text length.

Datasets and related: **Anim-400K** ([arXiv 2401.05314](https://arxiv.org/html/2401.05314v1/)), 425K+
aligned Ja/En video segments for end-to-end dubbing; **StyleDubber / multi-scale style learning for
movie dubbing** ([arXiv 2402.12636](https://arxiv.org/html/2402.12636v1)), which frames V2C as
aligning speech to video in both time and emotion.

### b.6 The most important paper for setting targets

**Brannon, Virkar & Thompson, TACL 2023 — "Dubbing in Practice: A Large Scale Study of Human
Localization"** ([ACL Anthology](https://aclanthology.org/2023.tacl-1.25), [PDF](https://aclanthology.org/2023.tacl-1.25.pdf)).
319.57 hours, 54 professionally produced titles, 201,246 dialogue lines after filtering, En→De/Es.
This is what professional human dubbing actually achieves:

- **Mean speech-overlap fraction 0.658, median 0.731.** In **4.3 % of lines overlap is exactly zero** — the dub and the source speech do not co-occur at all.
- On-screen 0.684 vs off-screen 0.662 — statistically significant at α = 0.01 but **tiny**, which undermines the usual assumption that on-screen lines need much tighter timing.
- **Isometry is a weak proxy for isochrony**: character-length ratio correlates r = 0.279 (r² = 0.078) with overlap fraction, and only r = 0.620 (r² = 0.385) with the duration ratio. Duration ratio itself correlates r = 0.877 with overlap.
- Most human dub lines differ from the source by **more than 10 % in character length** in both directions.
- **Human dubbers do not vary speaking rate to hit timing.** Standard deviation of dub speaking rate is *lower* than the source: 1.25 vs 1.47 w/s (Spanish), 1.26 vs 1.46 w/s (German), both rejected against the null by percentile bootstrap. Forced to choose, they **break timing rather than change pace**.
- Lip sync barely happens: only about **12.4 % of on-screen speech time shares the same viseme** between source and dub; within-viseme co-occurrence is 1.613× chance on-screen vs 1.463× off-screen.
- Source audio leaks into the dub through non-lexical channels: source→target speaking-rate correlation r = 0.439 (r² = 0.193), pitch mean r = 0.381, energy sd r = 0.366.
- Pipeline hygiene datum: MFA successfully aligned **87.37 % of English lines, 89.35 % German, 80.81 % Spanish**; ~12 % of words in a hand-audited sample had some phone-level problem.

Two consequences for any ">= 95 % of lines placed correctly" target. First, **"correct" must be
defined against a tolerance, not against exactness** — humans sit near 0.73 overlap and zero-overlap
lines are a normal 4 % of professional output. Second, **speeding up TTS to hit a slot is the thing
human dubbers explicitly refuse to do**, so a pipeline whose main lever is `atempo` is optimising a
constraint that professionals trade away first.

---

## (c) Techniques we are not using that credibly improve placement

Ranked by expected gain against the specific goal (≥ 95 % of dialogue lines placed correctly, in all
seven source languages, on every video). Current pipeline context is taken from
[CLAUDE.md](../CLAUDE.md): word-level Chirp ASR, a partition optimiser over the word stream, MMS
forced-alignment re-anchoring, an ITU-aware onset bias, gap recovery, a per-language chars-per-second
table with +40 % p90 error, and blocks with a median around 15 s that are never re-timed against the
picture.

### 1. Prosodic alignment *inside* each block — split the translation at the source's own pauses

The single largest structural gap. Blocks are median ~15 s and the placement metric explicitly "says
nothing about drift inside a line" (CLAUDE.md). Every one of those blocks contains multiple ≥ 300 ms
source pauses that currently carry no constraint, so the dub is free to say the second half of the
line while the actor's mouth is shut. Federico 2020's model is directly implementable: dynamic
programming over target break points, scored by speaking-rate match, speaking-rate variation, a
POS-LM break probability, and asymmetric boundary relaxation of up to 300 ms (penalising early starts
~4× harder than late ends). Measured gain in the source paper: **segmentation accuracy 49.17 % →
71.67 %, fluency 54.17 % → 89.17 %**, with Accuracy the only metric that predicted human score
([paper](https://www.isca-archive.org/interspeech_2020/federico20_interspeech.pdf)). MMS alignment is
already in the pipeline, which is the expensive prerequisite.

### 2. Replace the chars-per-second table with a duration predictor or a TTS dry run

CLAUDE.md records that the CPS table is right at the median but has +40 % p90 error, and concludes
"a character count cannot predict duration. Do not fix the table." The literature agrees and supplies
the replacement. IsoChronoMeter shows an **MMS-TTS duration predictor** gives a reference-free,
audio-free per-language duration estimate that is cheap enough to run on every candidate translation
([arXiv 2410.11127](https://arxiv.org/html/2410.11127)). Chronopoulou et al. showed that
character-matched (isometric) translation is **indistinguishable from unconstrained MT on actual
isochrony** ([arXiv 2302.12979](https://arxiv.org/html/2302.12979v1)), and Brannon et al. measured
the correlation at r² = 0.078 ([TACL](https://aclanthology.org/2023.tacl-1.25.pdf)). Every
"does this fit?" decision currently made on characters is being made on a variable that explains
under 10 % of the variance.

### 3. Harden slot arithmetic: slot = own onset → next onset, and no degenerate slots

CLAUDE.md's own diagnosis was that overflow was a *distribution* failure: zero-length slots holding
text, 34 rows with `end` before `start`, and slots under 0.5 s carrying 0.7 % of the text but
producing every impossible fit. Two projects solve this by construction. open-dubbing defines the
slot as **this utterance's start to the next utterance's start**, so the following pause is
automatically available headroom ([text_to_speech.py](https://raw.githubusercontent.com/Softcatala/open-dubbing/main/open_dubbing/text_to_speech.py)).
Voxa does the same and additionally **assigns the cursor rather than accumulating it**, so drift
cannot compound ([README](https://github.com/akshinmrv/Voxa)). pyVideoTrans formalises the fallback
ladder: try the slot, then slot + following gap, then trim ([blog 3](https://en.pyvideotrans.com/blog/audio-subtitles-video-sync-3)).
Cheap to implement, and it removes an entire class of impossible-fit decisions.

### 4. Two-pass synthesis at the measured rate, instead of post-hoc time-stretching

Compute the required rate from a first synthesis, then **re-synthesise** at that rate rather than
applying `atempo`. open-dubbing does exactly this whenever the voice exposes a rate parameter
([code](https://raw.githubusercontent.com/Softcatala/open-dubbing/main/open_dubbing/text_to_speech.py));
Auto-Synced-Translated-Dubs ships it as the default and calls it a substantial quality improvement
([README](https://github.com/ThioJoe/Auto-Synced-Translated-Dubs/blob/main/README.md)). Where the
engine supports a duration request directly — Azure's `mstts:audioduration`
([reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice)) —
the fitting step disappears entirely. Cost is one extra synthesis per line.

### 5. Length-budgeted translation with a verify-and-retry loop

Give the translator a per-line budget and check compliance before accepting. Descript's production
numbers are the best available evidence: moving duration optimisation **into** generation (syllable
count per chunk against language-specific speaking-rate assumptions, neighbouring chunks as context)
improved duration adherence by **13–43 percentage points** ([OpenAI case study](https://openai.com/index/descript/)).
The research equivalent is verbosity control, which pushed length compliance **above 90 %** while
*improving* BLEU in three of four language pairs ([arXiv 2110.03847](https://arxiv.org/pdf/2110.03847v1.pdf)).
Two cautions from the same literature: Lakew's **unidirectional** synchrony score (only ever shorten)
outperforms the symmetric one, and Tam et al. found over-aggressive phrase-level length control was
beaten on subjective wins by **+57 % to +138 %** by a gentler model — so budget, then stop.

### 6. On-screen / off-screen relaxation

Detect whether a mouth is visible and relax the timing constraint when it is not: local relaxation
inside on-screen sentences, **global** relaxation pooled across off-screen sentences. Reported gains:
Smoothness +9.9–28.3 %, Fluency +6.1–17.1 %, Intelligibility +0.6–14.5 %
([arXiv 2204.02530](https://arxiv.org/pdf/2204.02530v1.pdf)). Sobering counterweight: Brannon et al.
measured the human on/off gap at only 0.684 vs 0.662 overlap
([TACL](https://aclanthology.org/2023.tacl-1.25.pdf)), so the *timing* benefit is modest — the value
is that it buys slack for free where nobody can see it. Needs face/mouth detection, so this is real
engineering for a second-order gain.

### 7. A round-trip ASR quality gate with automatic regeneration

Re-transcribe every synthesised clip, score WER plus clipping, silence and pacing, and re-synthesise
flagged segments up to twice keeping the best take — Voxa ships this
([README](https://github.com/akshinmrv/Voxa)). This catches the failure mode that placement metrics
structurally cannot see: a clip that is in the right slot but says the wrong thing, or has been
stretched into unintelligibility. It is the machine version of the human QC pass that Papercup,
Deepdub, Camb.ai, RWS and Amazon Prime Video all keep in the loop.

### 8. Bounded picture re-timing as a last-resort escape valve

The pipeline holds total duration to +0.07 s and never re-times the video. Almost every commercial
product allows the opposite: HeyGen's `enable_dynamic_duration` defaults to **true**
([docs](https://developers.heygen.com/docs/video-translation-precision)), Synthesia offers
"Adaptive" duration ([post](https://www.synthesia.io/post/how-to-translate-your-videos-into-any-language)),
Kapwing and Vozo adjust **video speed segment by segment**
([Kapwing](https://www.kapwing.com/help/advanced-dubbing-tips/), [Vozo](https://vozo.ai/docs/translate_dub/auto_align_audio_video)),
and pyVideoTrans documents the exact engineering limits — `setpts` becomes slideshow-like above
factor 10, so cap it and trim instead ([blog 3](https://en.pyvideotrans.com/blog/audio-subtitles-video-sync-3)).
A ±2 % per-segment budget on a handful of genuinely impossible lines would remove the cases where
nothing else can work. Ranked low because it changes the deliverable's duration contract.

### 9. Adopt speech overlap as the headline KPI, calibrated to human dubbing

Switch the primary number to **SO = 1 − |source dur − dub dur| / source dur** per line
([definition](https://arxiv.org/html/2302.12979v1)), which is comparable across configurations in a
way "well placed on 15 s blocks vs 3 s blocks" is not — a problem CLAUDE.md already identifies. Then
set the target from measured human performance rather than from 1.0: **median 0.731, mean 0.658, and
4.3 % of lines at exactly zero** ([TACL](https://aclanthology.org/2023.tacl-1.25.pdf)). Systems in the
literature that hit 0.99 overlap do so by degrading translation quality
([Pal et al.](https://arxiv.org/html/2305.13204v1)). No gain in output quality by itself, but it stops
the project chasing a target stricter than professional dubbing.

### 10. Non-linear time-scaling instead of uniform `atempo`

If audio must be compressed, compress non-uniformly. [google/speedy](https://github.com/google/speedy)
speeds different parts of a word at different rates specifically to preserve intelligibility, versus
a flat rate change; rubberband and audiostretchy are the higher-quality drop-ins that
Auto-Synced-Translated-Dubs and Edge-TTS-Subtitle-Dubbing respectively use. Small, cheap, and it
raises the usable speed cap — which matters, since caps across this survey range from 1.15× (Subdub)
to 1.3× (open-dubbing) to 1.4× (VideoLingo) to 2.1× (SoniTranslate).

### Explicitly not recommended

- **Joint duration+translation modelling** (target factors, phoneme durations, auxiliary counters). It is the strongest result in the literature — 0.9887 speech overlap ([Pal et al.](https://arxiv.org/html/2305.13204v1)) — but it needs MFA-aligned parallel dubbing data per language pair, and this project has seven source languages including four with thin resources. The *inference-time* trick worth stealing is cheaper: bin source segment durations into equal-frequency buckets and pass them as tags.
- **Lip-sync re-rendering** (Wav2Lip, sync.so, HeyGen precision). It hides timing error rather than fixing it, and Brannon et al. measured human dubs at only ~12.4 % viseme agreement, so audiences plainly tolerate its absence ([TACL](https://aclanthology.org/2023.tacl-1.25.pdf)). ElevenLabs does not offer lip sync at all ([docs](https://elevenlabs.io/docs/creative-platform/products/dubbing)).
- **Global cross-correlation re-sync** (ffsubsync-style). Useful for fixing a constant offset in third-party subtitles, but the failure mode here is per-line distribution, not a global shift.

---

## COVERAGE

Counted, not estimated.

- **Projects / products / systems examined: 63.** 35 open source or open research systems (SoniTranslate, VideoLingo, open-dubbing, Auto-Synced-Translated-Dubs, pyVideoTrans, Voxa, Subdub/Pandrator, Edge-TTS-Subtitle-Dubbing, Linly-Dubbing, KrillinAI/KlicStudio, ViDubb, WeeaBlind, AutoDub, Ai-Vedio-Dubbing, youtube-auto-dub ×2, videodubber, openclaw-skill-videotranslate, videoTranslator, AI-Powered-Video-Dubbing-Platform, DubFlow, Video_Dubbing_with_ML_driven_Lip_Synchronization, Modablag, NERV-TRANSLATE, Srt-AI-Voice-Assistant, AutoSubReTimer, ffsubsync, aeneas, seamless_communication, sievesync, google/ai_video_dubbing, Ariel, ariel_on_sheets, time-scaling libraries as one group, anime_translation) and 28 commercial products or platform features (ElevenLabs Dubbing Studio + Dubbing v2, HeyGen, Descript, Google Aloud, YouTube auto-dubbing, Synthesia, Kapwing, Vozo, Maestra, Dubverse, Rask AI, Papercup, Deepdub, Respeecher, Camb.ai, Sieve, sync.so, Speechify, Vidby, Wavel AI, Adobe Premiere Pro, Perso Dubbing, VideoDubber.ai, RWS, Azure Speech duration control, Dubbing AI SDK, Panjaya-adjacent lipsync vendors already covered in the earlier survey — excluded here to avoid double counting, Google Cloud TTS as an infrastructure row). Depth varies and is labelled: **9 systems were read at source-code or config level**, ~20 at documentation level, the remainder at README or search-snippet level only.
- **Research papers summarised with methods and numbers: 14** (Öktem 2019; Federico 2020; Lakew 2021 verbosity control; Isometric MT 2021; Tam 2022 isochrony-aware MT; Virkar 2022 off-screen PA; Brannon 2023 TACL; Chronopoulou 2023; Pal 2023; VideoDubber AAAI 2023; IsoChronoMeter 2024; Isochrony-Controlled ST 2024; DubWise 2024; PS-TTS 2026 — plus Anim-400K and StyleDubber referenced without full extraction).
- **Distinct web searches run: 41.**
- **Pages fetched with Firecrawl: 55 fetches** (`notes_pipe_1` … `notes_pipe_55`), of which **5 yielded nothing usable** — 404s or JS-only shells: Linly-Dubbing `step042_tts.py`, YouDub-webui `step042_tts.py`, arXiv 2212.12137 HTML, and both Kapwing help pages. So **50 useful pages**.
- **Credits spent: 124** (873 → 749 on the shared balance), against a 260 budget. PDFs cost ~5–20 credits each rather than 1, which is why arXiv HTML versions were preferred.

### Verification gaps

- **Linly-Dubbing and KrillinAI**: per-segment fitting logic not verified — the relevant source files 404'd and the READMEs describe only global playback-speed and timestamp-matching features.
- **Papercup, Deepdub, Camb.ai, Speechify, Vidby, VideoDubber.ai**: none publishes a timing mechanism or a sync figure. Their entries are documentation-level or third-party.
- **Kapwing**: help pages are client-rendered and returned 538 characters; those claims rest on search snippets.
- **No vendor in this survey publishes a sync-accuracy number with a methodology.** The only quantified figures anywhere are pyVideoTrans' ~200 ms residual on one 23-minute video (self-reported), Descript's 13–43 pp duration-adherence delta (self-reported, no absolute baseline), and the research speech-overlap figures.
