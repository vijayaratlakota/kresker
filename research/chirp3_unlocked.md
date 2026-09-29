# chirp_3 is available after all - measured 20 Aug

`services/chirp_timing.py` carries a docstring saying chirp_3 is unusable:

> `403 PERMISSION_DENIED ... model chirp_3 locale hi-IN. It is no longer generally available.`
> ... `Recognizer does not support feature: word_level_confidence`

Both errors were real, and both were caused by our own request, not by Google withdrawing the
model. Swept region x model x feature-set on a 5 s clip of real Hindi speech:

| location | model | features | result |
|---|---|---|---|
| **us** | **chirp_3** | `enableWordTimeOffsets` only | **OK, words=16, timed=16** |
| **eu** | **chirp_3** | `enableWordTimeOffsets` only | **OK, words=16, timed=16** |
| us | chirp_3 | + `enableWordConfidence` | 400 `Config contains unsupported fields` |
| eu | chirp_3 | + `enableWordConfidence` | 400 `Config contains unsupported fields` |
| us-central1 | chirp_3 | either | 400 `model "chirp_3" does not exist in the location named "us-central1"` |
| europe-west4 | chirp_3 | either | 400 same |
| global | chirp_3 | either | 400 same |
| asia-southeast1 | chirp_3 | `enableWordTimeOffsets` only | **403** `no longer generally available` |
| us / eu | chirp_2 | either | 400 `model "chirp_2" does not exist in the location named "us"` |
| us-central1 / europe-west4 / asia-southeast1 | chirp_2 | + word confidence | OK |

## The two root causes

1. **Wrong region.** `LOCATION` defaults to `us-central1` (`OMNIVOICE_CHIRP_LOCATION`). chirp_3 is
   served only from the `us` and `eu` **multi-regions**. chirp_2 is the exact inverse - it exists
   in us-central1 / europe-west4 / asia-southeast1 and *not* in us / eu / global. The two models
   share no location, so any single hardcoded `LOCATION` can serve only one of them. Whatever
   region the original attempt used, one of the two models was guaranteed to 403.
2. **One unsupported field.** `_recognize` always sends
   `{"enableWordTimeOffsets": True, "enableWordConfidence": True}`. chirp_3 rejects the whole
   config over `enableWordConfidence`. Removing that single key turns 400 into OK.
   The old note read this as "chirp_3 rejects the feature we need" - but the feature we need is
   word **timestamps**, and those work. Word **confidence** is what it refuses.

The 403 at asia-southeast1 is genuine and separate: chirp_3 really is withdrawn there, which is
presumably where the original probe ran.

## Word-level timestamps DO come back from chirp_3

This contradicts Google's own documentation, which lists word-level timestamps under Chirp 3's
unsupported features while its API table simultaneously mentions a 20-minute batch cap "with
word-level timestamp enabled" (noted as a doc self-contradiction in `google_cloud_stack.md`).
Empirically: **16 words requested, 16 words returned, all carrying `startOffset`.** The doc is
wrong; the ambiguity is resolved in our favour.

## Availability across the 7 languages

`chirp_3` returned OK with fully timed words for **hi-IN, te-IN, en-US, ta-IN, ml-IN, kn-IN,
gu-IN**, in both `us` and `eu`.

**Do not read the word counts as a quality signal.** Every call in that sweep used the same
Hindi clip, so a Malayalam-locale response is Malayalam-shaped nonsense produced from Hindi
audio. The sweep establishes permission and feature support only. Transcription quality per
language has to be measured on audio actually in that language - that is what the ground-truth
benchmark is for.

## What this changes

- chirp_3 becomes a real candidate arm in the timing bake-off, for all 7 languages.
- Its diarization (GA per Google, `Recognize`/`BatchRecognize` only) is now worth probing; if it
  works for the Dravidian languages it removes the external-diarizer requirement that
  `google_cloud_stack.md` concluded was unavoidable.
- `LOCATION` must become **per-model**, not a single constant, or enabling chirp_3 breaks chirp_2.
  Suggested shape: `MODEL_LOCATION = {"chirp_2": "us-central1", "chirp_3": "us"}`, and build the
  features dict per model so `enableWordConfidence` is sent only to models that accept it.

## Cost note

Same SKU either way: $0.016 per minute at first tier. Running both models on the same audio to
merge timings and diarization doubles recognition cost to ~$0.032/min, which is still under 10
cents for a 3-minute video.
