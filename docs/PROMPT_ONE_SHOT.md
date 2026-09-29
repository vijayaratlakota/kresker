# One-shot prompt: transcript + translation, two CSV files

Attach the video (or its audio) and paste everything in the box below. Replace the three
placeholders first:

- `<SOURCE LANGUAGE>` - e.g. Hindi
- `<TARGET LANGUAGE>` - e.g. Telugu
- `<CPS>` - characters per second for the target: **13** Telugu / Kannada / Malayalam,
  **14** Hindi / Gujarati / Tamil, **15** English

Then save the two outputs as:

- `<video>__<src>.transcript.csv` - e.g. `desi-friends-ep1__hi.transcript.csv`
- `<video>__<src>-<tgt>.translation.csv` - e.g. `desi-friends-ep1__hi-te.translation.csv`

Join and check them before sending:

```
python merge_pair.py desi-friends-ep1__hi.transcript.csv desi-friends-ep1__hi-te.translation.csv
```

---

```
You are preparing a video for professional DUBBING. Do the work in two passes and return TWO
separate CSV files. Accuracy of the text and of the speaker labels matters more than anything else.

Attached is a video in <SOURCE LANGUAGE>. It will be dubbed into <TARGET LANGUAGE>.


==================== PASS 1: TRANSCRIPT ====================

FILE 1 - output a CSV with EXACTLY these columns, in this order:

line_id,speaker,start,end,source_text

RULES FOR FILE 1

R1. LINE_ID. Sequential, zero-padded, starting at L0001: L0001, L0002, L0003 ... Never reuse or
    skip an id. This is the key that links the two files, so it must be stable.

R2. ONE SENTENCE PER ROW. Each row is a single spoken sentence, ideally 2-8 seconds of speech.
    A row must NEVER exceed 12 seconds. If a sentence runs longer, split it at a natural clause
    boundary and give each part its own row and its own line_id.

R3. MILLISECOND TIMESTAMPS. start and end are seconds with EXACTLY three decimal places - the
    format is SS.mmm and the third decimal is milliseconds. Examples: 3.184, 12.480, 106.905.
    - Always write three decimals, even when the value looks round: 9.500, never 9.5, never 9.
    - Do NOT use MM:SS or HH:MM:SS.
    - Do NOT round to the nearest second, tenth, or half second.
    - start is the moment the FIRST sound of the first word begins. end is the moment the LAST
      sound of the last word finishes. Do not include the silence before or after.
    - Measure these from the audio. Do not estimate, do not interpolate, do not evenly space rows.
      I will verify them against the waveform, so a fabricated precise time is worse than an
      honest approximate one.
    Rows in increasing start order.

R4. VERBATIM SOURCE TEXT. source_text is exactly what is said, word for word, in <SOURCE LANGUAGE>
    in its native script. Do not clean up, summarise, paraphrase, or fix grammar. Keep filler
    words, stutters and repetitions. Keep any English words the speakers actually use in English -
    code-mixing is normal and must be preserved exactly as spoken.
    NEVER write "...", "[inaudible]", "[music]" or any placeholder. If a word is unclear, write
    your single best guess. A wrong guess is far more useful to me than an omission, because I
    align this text against the audio and missing words break the alignment.

R5. SPEAKERS - MAXIMUM 6, THIS IS A HARD LIMIT.
    Use only these labels: SPK1, SPK2, SPK3, SPK4, SPK5, SPK6.
    - Never output SPK7 or beyond, no matter how long the video is or how many people you hear.
    - Assign consistently: one human voice keeps the same label for the whole file.
    - IF THE VIDEO HAS MORE THAN 6 DISTINCT VOICES: do not create a 7th label. Assign each extra
      voice to whichever of the 6 existing labels sounds MOST SIMILAR to it - match on gender
      first, then approximate age, then pitch and speaking style. Reuse rather than invent.
    - Give the 6 labels to the 6 voices with the MOST speech. Minor voices - a one-off shout, a
      crowd, an announcer heard once - get folded into the most similar main speaker.
    - Every label you use must total at least 3 seconds of speech across the whole file. A label
      with less than that cannot be used; fold it into the most similar speaker instead.
    - If unsure whether two lines are the same person, REUSE the existing label. Splitting one
      person across two labels is much more damaging than merging two people.
    - If two people speak at the same time, give each its own row; their times may overlap.

R6. COVERAGE. Cover every spoken line from the start of the video to the end. Do not stop early,
    do not summarise the later part, do not skip quiet, overlapping or shouted speech. If a passage
    is sung, still transcribe it.

R7. CSV HYGIENE. UTF-8. Any cell containing a comma or a double quote must be wrapped in double
    quotes, with a literal quote written as "". No extra columns. No blank rows. No commentary
    before or after the CSV. No markdown code fences.


==================== PASS 2: TRANSLATION ====================

Only after File 1 is complete, translate it.

FILE 2 - output a SECOND, SEPARATE CSV with EXACTLY these columns, in this order:

line_id,start,end,target_text,notes

RULES FOR FILE 2

R8. ONE ROW PER LINE_ID FROM FILE 1. Same ids, same order, same count. Do not add rows, do not
    drop rows, do not merge rows, do not reorder. Copy line_id, start and end across UNCHANGED,
    character for character - I use them to verify the two files still line up.

R9. Translate into <TARGET LANGUAGE>, written in its native script.

R10. LENGTH BUDGET - A HARD CONSTRAINT. For each row:
        budget_characters = (end - start) * <CPS>
     For example a 5.000 to 9.000 row is 4.000s, which at <CPS> characters per second is a budget
     of 4.000 * <CPS> characters. len(target_text) must be AT OR UNDER that budget.
     If a faithful translation is too long, SHORTEN IT: use a shorter synonym, drop a redundant
     word, use the natural spoken contraction, or restructure the sentence. Preserve the MEANING
     and the TONE; sacrifice literal completeness. A short natural line is far better than a
     complete line that has to be sped up to fit.
     Never pad a short line to reach the budget. Silence is fine.

R11. SPOKEN, NOT WRITTEN. Translate the way a real person would say it in <TARGET LANGUAGE>,
     matching the register of the original: slang stays slang, rude stays rude, formal stays
     formal, and the comic timing of a joke must survive. Do not sanitise or soften anything.

R12. NAMES AND LOANWORDS. Keep personal names, brand names and place names as they are, written in
     the target script. Keep English words that a <TARGET LANGUAGE> speaker would naturally use in
     English, written in the target script.

R13. CONSISTENCY. Use the surrounding lines as context. A character's name, how people address each
     other, and any running joke must be translated identically every time.

R14. NOTES. Normally leave empty. Where it applies, use exactly ONE of these words:
        offscreen   the speaker is not visible on screen
        song        this is sung rather than spoken
        shout       shouted delivery
        whisper     whispered delivery
        laugh       mostly laughter rather than words

R15. Same CSV hygiene as R7. No commentary, no code fences.


==================== BEFORE YOU ANSWER ====================

Check all of this and fix anything that fails, then output the two CSVs:

C1. Is any row longer than 12.000 seconds?
C2. Does every start and end have exactly three decimal places?
C3. Does any source_text contain "..." or a placeholder?
C4. Are there more than 6 distinct speaker labels? Is any label outside SPK1..SPK6?
C5. Does every speaker label total at least 3 seconds across the file?
C6. Do File 1 and File 2 have the same number of rows and the same line_id values in the same
    order?
C7. For every row, is len(target_text) <= (end - start) * <CPS>?
C8. Does the transcript run to the end of the video?

Output File 1 in full first, then File 2 in full. Label them clearly as FILE 1 and FILE 2. Nothing
else.
```

---

## What happens next

I take those two files, join them on `line_id`, and use your `start`/`end` **exactly as given -
unchanged** - to place, clone and render. Then I report the measured placement and coverage
percentages for that render, so we can compare your timings against the forced-alignment path
(which measured 72.5% on Telugu) on evidence rather than opinion.

If `merge_pair.py` reports problems, fix them in the source files and re-run it - a file that fails
the join is the one thing I cannot work around, because a mismatched pair silently puts the wrong
translation on the wrong line.
