# Copy-paste prompts for producing a VoiceStudio dubbing file

Two prompts, run in order. Keep them separate - asking one model to transcribe *and* translate in
one pass reliably degrades both, because it starts translating while it is still deciding what was
said.

Validate the result before sending it to me:

```
python validate_input.py path\to\yourfile.csv
```

---

## What to ask for, and what NOT to ask for

| thing | needed? | why |
|---|---|---|
| Verbatim source text | **essential** | I align this against the real audio to find each boundary. Missing words = wrong boundary. |
| One sentence per row | **essential** | Rows over 12s cannot be placed. This is the single biggest quality lever. |
| Speaker label per row | **essential** | Binds each line to a cloned voice. Wrong label = wrong character's voice. |
| Sentence start/end times | rough is fine | Used only for ordering, as a search anchor, and as a sanity check. Whole seconds are acceptable. |
| **Word-level timestamps** | **optional bonus** | Useful ONLY if the ASR emits them natively from the audio. Never let a model guess them. |
| Millisecond precision | **not needed** | I re-derive boundaries by forced alignment, which is more accurate than any ASR or LLM timing. |

**The rule on timings:** a model that *listens* (ElevenLabs Scribe, Deepgram, Whisper) produces
real timings accurate to tens of milliseconds - include them. A model that *reasons* over audio
(Gemini, GPT) produces timings that drift progressively and can be minutes out by the end of a long
file - exclude them. If in doubt, leave the times rough and let alignment do the work.

---

## PROMPT 1 - Transcription

Use with an ASR-first tool (ElevenLabs Scribe v2 preferred; Sarvam for heavy Hindi-English
code-mixing). Attach the video or its audio.

```
Transcribe the attached audio into a CSV. Follow every rule exactly.

OUTPUT FORMAT
Return ONLY a CSV, no commentary, no code fences. UTF-8. Exactly these columns in this order:

speaker,start,end,source_text,word_times

RULES

1. ONE SENTENCE PER ROW. Each row must be a single spoken sentence, ideally 2-8 seconds of
   speech. A row must NEVER exceed 12 seconds. If a sentence runs longer, split it at a natural
   clause boundary and give each part its own row.

2. VERBATIM. source_text must be exactly what is said, word for word, in the original language and
   its native script. Do not clean up, do not summarise, do not paraphrase, do not skip filler
   words or repetitions. NEVER use "..." or "[inaudible]" or any placeholder. If a word is
   unclear, write your single best guess - a wrong guess is far more useful to me than an omission.
   Keep English words that the speakers actually use in English (code-mixing is normal and must be
   preserved as spoken).

3. SPEAKER LABELS - HARD LIMIT OF 8. Use SPK1, SPK2 ... up to SPK8. You must NOT invent more than
   8 distinct labels for the whole file, no matter how long it is. Aim for the smallest number that
   is actually true - most content has 2 to 5 real speakers.

   The same human voice must get the same label for the entire file. Never create a second label
   for a voice that already has one. If you are unsure whether two lines are the same person,
   REUSE the existing label - merging two people by mistake is much less damaging than splitting
   one person across two labels.

   Every label you use must have at least 3 seconds of speech in total, across at least 2 rows.
   A label with one short line cannot be used and will be rejected. So:
     - a one-off background shout, a crowd voice, an announcer heard once: do NOT give it its own
       label. Attribute it to the nearest main speaker, or use the single shared label SPKX for all
       such incidental voices.
     - if you would exceed 8 labels, merge the least important voices into SPKX rather than adding
       a 9th.

   If two people speak at once, give each their own row; their times may overlap.

4. TIMES - MILLISECOND PRECISION. Format start and end as seconds with EXACTLY three decimal
   places, SS.mmm, where the third decimal is milliseconds. Examples: 3.184, 12.480, 106.905.
   Always write three decimals even when the value looks round: write 9.500, never 9.5, never 9.
   Do NOT use MM:SS or HH:MM:SS. Do NOT round to the nearest second, tenth or half second.
   Report only times you actually measured from the audio waveform. Do not estimate, interpolate,
   or evenly space rows. If your system genuinely cannot measure to the millisecond, give your
   most accurate real value and say so at the end - an honest coarse time is far better than a
   fabricated precise one, because I verify these against the audio. Rows in increasing start order.

5. WORD TIMES. Only fill word_times if your system produces word-level timings natively from the
   audio. Format: word:start:end separated by | for example
   kahaan:3.010:3.240|hai:3.240:3.380|vo:3.380:3.620
   If you do not have real per-word timings from the audio, leave this cell EMPTY. Do not
   fabricate, interpolate or evenly distribute word times. An empty cell is correct and expected;
   a guessed one is harmful.

6. COVERAGE. Cover every spoken line in the file, start to finish. Do not stop early, do not
   summarise the later part of the file, do not skip quiet or overlapping speech. If a stretch is
   sung rather than spoken, still transcribe it and I will handle it separately.

7. CSV HYGIENE. Any cell containing a comma or a quote must be wrapped in double quotes, with a
   literal quote written as "". No extra columns. No blank rows. No trailing commentary.

Before you answer, check: is any row longer than 12 seconds? Does any source_text contain "..."?
Is any speaker label used only once? Fix those, then output the CSV.
```

---

## PROMPT 2 - Translation

Run on the CSV from prompt 1. Use Gemini 2.5/3.x Flash or similar. Replace `<TARGET LANGUAGE>` and
the characters-per-second figure from the table.

Characters per second: Telugu / Kannada / Malayalam **13**, Hindi / Gujarati / Tamil **14**,
English **15**.

```
You are translating a video for DUBBING, not for subtitles. The translated speech has to fit in
the same time as the original speech, so length matters as much as meaning.

INPUT: a CSV with columns speaker,start,end,source_text,word_times
OUTPUT: the same CSV with two changes - add a target_text column and a notes column:

speaker,start,end,source_text,target_text,notes

RULES

1. Translate source_text into <TARGET LANGUAGE>, in its native script.

2. LENGTH BUDGET - this is a hard constraint. For each row compute
      budget = (end - start) * <CPS>          e.g. a 5.0s row at 13 chars/s = 65 characters
   target_text must be AT OR UNDER that budget. If a faithful translation is too long, shorten it:
   use a shorter synonym, drop a redundant word, split a long clause, use the natural spoken
   contraction. Preserve the MEANING and the TONE; sacrifice literal completeness. A short natural
   line is much better than a complete line that has to be sped up to fit.
   Never pad a short line to fill the budget.

3. SPOKEN, NOT WRITTEN. Translate how a person would actually say it in <TARGET LANGUAGE>, matching
   the register of the original - slang stays slang, rude stays rude, formal stays formal. Keep the
   comic timing of jokes. Do not sanitise.

4. NAMES AND ENGLISH WORDS. Keep personal names, brand names and place names as they are, written
   in the target script. Keep English loanwords that the target audience would naturally use in
   English, written in the target script.

5. CONSISTENCY. Use the surrounding rows as context. A character's name, the way people address
   each other, and any running joke must be translated the same way every time. Track who is
   speaking via the speaker column so pronouns and gender agreement stay correct.

6. NOTES column. Leave empty normally. Use exactly one of these words where it applies:
      offscreen  - the speaker is not visible on screen
      song       - this is sung, not spoken
      shout      - shouted delivery
      whisper    - whispered delivery
      laugh      - mostly laughter rather than words

7. Do NOT change speaker, start, end or source_text. Do not reorder rows. Do not drop rows. Every
   input row must appear in the output exactly once.

8. Output ONLY the CSV. No commentary, no code fences. UTF-8. Quote any cell containing a comma or
   quote.

Before answering, check every row: is len(target_text) <= (end - start) * <CPS>? For any row that
fails, rewrite it shorter. Then output.
```

---

## PROMPT 3 - Optional QC pass

Run this on the finished file to catch what the first two passes miss. Cheap and it has caught real
problems.

```
Check this dubbing CSV and report problems only - do not rewrite it.

For every row verify:
1. len(target_text) <= (end - start) * <CPS>. List every row that exceeds it, with by how much.
2. (end - start) <= 12 seconds. List every row that exceeds it.
3. source_text contains no "...", no "[inaudible]", no placeholder.
4. target_text contains no leftover text in the SOURCE script (i.e. nothing untranslated).
5. Speaker labels: list each label and its row count. Flag any label used only once, and any two
   labels that look like they are the same person.
6. Rows are in increasing start order and no speaker overlaps itself.
7. Any row where the translation loses a joke, a name, or the tone of the original.

Output a short numbered list of problems with row numbers. If there are none, say "clean".
```

---

## Filename

Save as `<videoname>__<src>-<tgt>.csv`, for example `desi-friends-ep1__hi-te.csv`.
The validator reads the target language from the filename to pick the right character budget.

Language codes: `hi` Hindi, `te` Telugu, `en` English, `ta` Tamil, `ml` Malayalam, `kn` Kannada,
`gu` Gujarati.
