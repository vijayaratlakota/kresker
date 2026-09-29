# Input file spec for VoiceStudio dubbing

Hand this whole document to whichever AI produces the transcript and translation.

## The short version

One CSV. **UTF-8. One sentence per row.** Six columns, in this order:

```csv
speaker,start,end,source_text,target_text,notes
SPK1,3.184,6.027,"कहाँ है वो?","ఎక్కడ వాడు?",
SPK1,6.213,8.446,"भाई वो झूठ बोला मुझसे","అన్నా వాడు నాతో అబద్ధం చెప్పాడు",
SPK2,11.462,14.905,"ओए क्या कर रहा है?","ఒరేయ్ ఏం చేస్తున్నావ్?",offscreen
```

**Times are seconds with exactly 3 decimals - that third decimal is milliseconds.** `6.027` means
6 seconds and 27 milliseconds. Write `3.184`, not `3.2` and not `3`. See the timestamp section
below for why the precision is requested even though I re-derive the boundaries.

Save as `<videoname>__<src>-<tgt>.csv`, e.g. `desi-friends-ep1__hi-te.csv`.

## Why the timestamps are the least important column

**Format: `SS.mmm` - seconds with exactly three decimals, the third decimal being milliseconds.**
`12.480` is 12 s 480 ms. Always write three decimals, even when the value is near-round: `9.500`,
not `9.5`. Never write bare whole seconds and never write `MM:SS`.

Ask for milliseconds **only from a tool that measured them.** A real ASR (ElevenLabs Scribe,
Deepgram, Whisper) reports millisecond offsets it actually derived from the waveform, and those are
worth having. A reasoning model reading audio invents them, and its errors grow through the file -
one measured case drifted 157 s by the end of a 12-minute clip. A fabricated millisecond is worse
than an honest whole second, because it looks authoritative.

I re-derive every boundary by forced-aligning `source_text` against the real audio, because that is
measurably the most accurate method available (see `research/timing_bakeoff_results.md`: unhinted
forced alignment beat every recogniser-hinted combination on all 7 languages). So precision in this
column is a bonus, not the thing the dub depends on - which is exactly why you should never let a
model fake it.

The times you supply are used for three things only:

1. **Ordering** - which line comes before which.
2. **A search anchor** - alignment looks near the hint, so being within a couple of seconds is
   plenty.
3. **A sanity check** - if alignment lands a line more than a few seconds from the hint, I flag it
   rather than shipping it.

Whole seconds are acceptable. Fractional seconds (3 decimals, e.g. `12.480`) are better but not
required. **What matters far more is that the rows are short and the text is verbatim.**

## The rules that actually matter

### 1. One sentence per row. This is the most important rule.

Target **2-8 seconds** of speech per row. **Hard maximum 12 seconds.**

Your last file had a median of 22s and a maximum of 57s per row. A 57-second block becomes one
synthesised utterance, and nothing can place it correctly - the voice is free to drift anywhere
inside it. 57% of that file's rows were over 15s.

If a sentence genuinely runs longer than 12s, split it at a natural clause boundary and give each
half its own row.

### 2. Verbatim source text. Never abbreviate, never use "..."

Every `source_text` cell must be exactly what is said, word for word. In your last file **9 of 30
rows had the Hindi elided with "..."**, which makes those rows unusable for alignment - I align
the source text against the audio, so missing words mean a wrong boundary.

If a word is unclear, write your best guess. A wrong guess is far better than an ellipsis.

### 3. Speaker labels, stable across the whole file

Use `SPK1`, `SPK2`, `SPK3`... or real names - either is fine, as long as **the same person always
gets the same label**. This is what binds each line to a cloned voice. Getting it wrong makes one
character speak in another's voice.

**Maximum 8 distinct speakers. Aim for 2-5.** The number is not arbitrary: the pipeline's
diarization ceiling is `MAX_SPEAKERS = 8` (`OMNIVOICE_DIAR_MAX_SPEAKERS`), so a 9th label has
nothing to bind to.

**Every label needs at least 3 seconds of speech across at least 2 rows.** A voice reference is cut
from that speaker's own audio, and the minimum usable reference is 3s (`MIN_SEGMENT_REF_DURATION_S`,
padded toward 5s). A speaker with one short line gets no reference and falls back to the pooled
voice, which is the "why does this character sound like someone else" symptom.

So do not give a label to a one-off background shout, a crowd voice or an announcer heard once.
Either attribute it to the nearest main speaker, or put all such incidental voices under one shared
label, `SPKX`. If a file would exceed 8, merge the least important voices into `SPKX` rather than
adding a 9th.

An AI asked to diarize a 12-minute comedy sketch produced **16** labels on its first attempt. That
is over-splitting - the same person given several labels - and it is the single most common defect
in a generated file. Fewer, stable labels beat more, precise-looking ones.

If two people talk over each other, give each their own row and let the times overlap. That is the
one place overlap is allowed.

### 4. Make the translation fit the time available

The dub has to fit roughly the same span as the original speech. Rough budget per second of slot:

| target language | characters per second |
|---|---|
| Telugu, Kannada, Malayalam | about 13 |
| Hindi, Gujarati, Tamil | about 14 |
| English | about 15 |

So a 5-second Telugu line should be about 65 characters, not 130. If the natural translation is
much longer, **shorten the wording** rather than letting it overflow - a shorter, natural sentence
beats a complete one that gets sped up to fit. In your last file 5 of 30 rows needed up to 1.39x
their slot.

Do not pad short lines. Silence is fine.

### 5. Order and overlap

Rows in increasing `start` order. Do not overlap rows for the *same* speaker.

### 6. Encoding and quoting

- UTF-8 (a byte-order mark is fine, I strip it).
- Any cell containing a comma or quote must be double-quoted, `""` for a literal quote. Your last
  file did this correctly.
- Blank `notes` is fine. Do not add extra columns; do not reorder them.

### Optional `notes` values

Free text, but these are recognised and used:

- `offscreen` - nobody's mouth is visible, so I can relax the timing and gain quality.
- `song` / `music` - sung, so it should be left as original audio rather than dubbed.
- `shout`, `whisper`, `laugh` - delivery hints; also stops a laugh being used as a voice reference.

## What I do with the file

1. Validate it (see below) and reject it loudly rather than silently dubbing something broken.
2. Forced-align `source_text` against the original audio to get real boundaries, discarding your
   time hints except as anchors.
3. Bind each `speaker` to a cloned voice cut from that speaker's own cleanest audio.
4. Synthesise `target_text` per line, verify each rendered line, re-render any line that comes back
   wrong, and mix over the music-and-effects bed.
5. Report placement and coverage percentages measured the same way as everything else, so this run
   is comparable to the 72.5% baseline instead of being a guess.

## Check the file before you send it

```
python validate_input.py path\to\yourfile.csv
```

It prints row count, line-length distribution, overflow rows, truncation, speaker consistency and
ordering problems, and exits non-zero if anything would break the dub. It prints no Indic text, so
it is safe in a Windows console.

## Which AI to use

Based on `research/asr_word_timestamps.md`:

**Transcription.** ElevenLabs Scribe v2 is the only hosted engine covering all 7 languages with
word timings and speaker diarization, self-reporting under 10% WER (Kannada and Malayalam under
5%). For heavily Hindi-English code-mixed dialogue, Sarvam's Indic models are worth a second pass -
they have no word timings, but under this spec that does not matter. Avoid AssemblyAI for Telugu,
Kannada, Malayalam and Gujarati - its own docs put those above 50% WER. Deepgram has no Malayalam.

**Translation.** Gemini 2.5 or 3.x Flash, prompted with the per-row character budget from rule 4
and the source line, and told to return a translation that fits. Ask it to prefer natural
shortening over completeness. Give it the neighbouring lines as context so pronouns and names stay
consistent.

**Whatever you use, ask for: verbatim text, one sentence per row, speaker labels. Not timestamps.**
