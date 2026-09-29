# Why English sits at 50-55% well placed, and what is actually wrong

2026-08-21, container `omnivoice` on the T4 box. **Nothing under `/app/backend` was written.**
Every number below was measured on that box from the cached recogniser responses in
`/root/bench/cache` and the local T4. **No Speech API call was made; nothing was re-billed.**

## Verdict, in one paragraph

English is not a placement problem, not a mapping problem, and not a broken ground truth.
The English ground truth is the **best** of the seven languages when verified independently
(median +2.5 ms, p95 |error| 12.6 ms, 95% of onsets inside 20 ms, and every source clip located
in the assembled timeline to within 0.1 ms). Line-to-word mapping on the clean variant is as
good as Hindi's (97.5% matched, 85.3% of transcript tokens found, mapping purity 1.000). The
deficit survives every stage being removed: with an **oracle window** (the aligner is handed the
true span padded by 0.75 s, so window choice and Chirp cannot be blamed) English still reaches
only 50.0% against Hindi 72.5% and Telugu 75.0%, at a **higher** median confidence (0.986 vs
0.964/0.967). What is left is the aligner itself, and the failure has a precise shape: for
**7-8 of the 40 English lines the aligned span does not cover the speech** - it starts 350-900 ms
late and ends 600-1770 ms early, leaving up to 63% of the line's in-band speech energy outside
it, at per-word confidence 0.99-1.00. Those lines all begin with a **short sentence-initial
function word followed by a pause** ("The …", "But …", "As …", "All …"); CTC parks the two or
three letters of that word at the *end* of the leading region, immediately before the second
word, and abandons the first word plus its pause. An independent local ASR puts the same word
at the start of that region, where the ground truth says it is. 7 of the 17 English male lines and
1 of the 23 female lines are affected, which is why the effect looks like "English is harder": the
English male lines are the slow ones (0.399 s per word against 0.281 s for the female lines), so
there is more slack for the CTC path to take. On top of that the corpus has **3 defective English
lines and zero defective lines in the other six languages** - the builder's end-trim cut 7.88 s,
5.58 s and 3.46 s of speech off three clips, leaving 29, 29 and 14 words to be carried by 1.68 s,
3.11 s and 2.03 s of audio. They cost about 2 points and can never be placed.

The corrected English number is therefore **not materially different from the recorded one**:
re-scored against an independently measured onset, `fa` on en/clean moves 55.0 -> 52.5 and the
whole-file forced-alignment arm 60.0 -> 57.5. Dropping the three defective lines moves the
oracle arm 50.0 -> 51.4 and the whole-file arm 60.0 -> 62.2. **English really is at 50-60%, and
the reason is the aligner's treatment of a leading monosyllable before a pause, not the metric.**

Three fixes were measured, not just proposed (section 10): bridging one pause in the onset snap
(+12.5 points on en/clean), MMS star tokens at the window edges with the star spans stripped
(+7.5 en, +17.5 hi, +12.5 te on a wide window; +5/+10/+10 through the shipped cascade), and a
genuine bug in `aligner.retime_segments` that desynchronises every line after the first
digit-bearing word in a window (priced at -57 points when the window is the whole file).

## 1. What was measured, and against what code

At the start of the run `services/fa_timing.py`, `services/chirp_timing.py` and
`services/aligner.py` were copied to `/tmp/_en_snap/` and **every measurement imported the
snapshot**, not the live files:

| file | snapshot bytes | md5 |
|---|---|---|
| `fa_timing.py` | 18361 | `3b62f5e7350053050074e0b291873cfd` |
| `chirp_timing.py` | 21213 | `666b37ae06e0dfef60e9ef3e66144933` |
| `aligner.py` | 24677 | `780a852b430915e1d6dde2e86c1f235e` |

That precaution paid off. **The live `fa_timing.py` was replaced at 11:01 UTC while this work was
running** (18361 -> 21470 bytes, live md5 now `7f299ff33429339396788535f2447e28`, with the
parallel task's own backup `fa_timing.py.preback.20260821110108` holding the 18361-byte file my
snapshot matches). Every figure in this document is against the 18361-byte `fa_timing.py`, the
24677-byte `aligner.py` and the 21213-byte `chirp_timing.py`, and none of them shifted underneath
the measurement.

The harness reproduces the shipped numbers exactly, which is the evidence that it measures the
same thing: hi/clean chirp_3 42.5 (recorded 42.5), te/clean 52.5 (52.5), en/clean 51.3 (51.3),
ta/clean 60.0 (60.0), kn/clean 35.0 (35.0), gu/clean 47.5 (47.5), and `fa` on en/clean 55.0
(recorded 55.0), en/music 67.5 (67.5), hi/clean 60.0 (60.0), te/clean 65.0 (65.0).

Arms used below:

| arm | what it is |
|---|---|
| `chirp_2` / `chirp_3` | cached word times mapped onto the lines by `chirp_timing.retime_by_words` |
| `fa` / `fa_then_chirp` | the shipped cascade, `fa_timing.retime_blocks`, chirp_3 word times for the length bound |
| `oracle` | one `aligner.align_window` per line over `[true_start-0.75, true_end+0.75]`. No Chirp, no cascade, no window search - the cleanest measurement of the aligner alone |
| `wide` | the same, `[true_start-3.0, true_end+3.0]` |
| `armC` | one monotonic forced alignment of the whole transcript over the whole file, emissions in 30 s chunks, split back onto lines by the tokens each line contributed (the bake-off's arm C, done correctly) |
| `armC buggy split` | the same alignment, split by each line's ORIGINAL word count - what `aligner.retime_segments` does today |

## 2. Hypothesis 1 - bad English ground truth. REFUTED, and English is the best of the seven

Two independent checks. First, a band-limited energy detector re-derived every onset **on the
assembled timeline** (10 ms frames, 300-3400 Hz, threshold `max(P95_in_span - 20 dB, floor + 8 dB)`
held for 50 ms, searched from the previous line's end), over nine parameter settings
(15/20/25 dB x 30/50/80 ms):

| lang | detected | median err ms | p95 abs ms | \|e\| <= 20 ms | \|e\| > 100 ms | (music) median | (music) \|e\|<=20ms |
|---|---|---|---|---|---|---|---|
| hi | 40/40 | +2.8 | 1483.1 | 85.0% | 15.0% | -0.9 | 67.5% |
| te | 40/40 | +3.7 | 640.2 | 87.5% | 10.0% | +3.2 | 75.0% |
| **en** | 40/40 | **+1.9** | 1419.7 | 77.5% | 20.0% | **-267.6** | **42.5%** |
| ta | 40/40 | +2.7 | 1490.6 | 75.0% | 25.0% | +0.8 | 62.5% |
| ml | 40/40 | +2.4 | 25.4 | 90.0% | 2.5% | +2.2 | 75.0% |
| kn | 40/40 | +3.2 | 1493.1 | 77.5% | 20.0% | +2.1 | 60.0% |
| gu | 40/40 | +4.7 | 713.1 | 87.5% | 12.5% | +4.0 | 80.0% |

Second, and this is the decisive one: each FLEURS **source clip** was located inside the
assembled wav by normalised cross-correlation of its first 0.75 s, and the onset was then
measured on the isolated clip, exactly as the corpus builder did but independently:

| lang | clips found | xcorr r median / min | placement error median / max abs | independent onset vs `true_start`: median | p95 abs | \|e\| <= 20 ms | \|e\| > 100 ms |
|---|---|---|---|---|---|---|---|
| hi | 40 | 1.0000 / 0.9999 | +0.0 / 0.1 ms | +2.5 ms | 22.5 ms | 92.5% | 0.0% |
| te | 40 | 1.0000 / 1.0000 | +0.0 / 0.0 ms | +2.5 ms | 22.5 ms | 87.5% | 0.0% |
| **en** | 40 | 0.9999 / 0.9484 | **+0.0 / 0.1 ms** | **+2.5 ms** | **12.6 ms** | **95.0%** | **0.0%** |
| ta | 40 | 1.0000 / 1.0000 | +0.0 / 0.0 ms | +2.5 ms | 42.5 ms | 87.5% | 2.5% |
| ml | 40 | 1.0000 / 1.0000 | +0.0 / 0.1 ms | +2.5 ms | 27.5 ms | 90.0% | 0.0% |
| kn | 40 | 1.0000 / 1.0000 | +0.0 / 0.1 ms | +2.5 ms | 22.5 ms | 92.5% | 0.0% |
| gu | 40 | 1.0000 / 1.0000 | +0.0 / 0.1 ms | +2.5 ms | 12.5 ms | 97.5% | 0.0% |

Every clip is where the corpus says it is to within 0.1 ms, and English has the **tightest**
onset agreement of the seven (p95 12.6 ms, no line beyond 100 ms). The constant +2.5 ms is the
10 ms frame grid, not a bias worth correcting. English `true_start` is right.

Re-scoring every arm against the independent onset instead of the recorded one (en, clean):

| arm | as recorded | vs independent onset | median ms |
|---|---|---|---|
| chirp_2 | 37.1% | 31.4% | -28.2 -> -32.3 |
| chirp_3 | 51.3% | 41.0% | -18.9 -> -27.8 |
| `fa` | 55.0% | 52.5% | +0.1 -> -6.2 |
| oracle | 50.0% | 50.0% | -9.1 -> -11.8 |
| armC | 60.0% | 57.5% | +17.6 -> +11.7 |

The other languages move the same way and by the same amount (hi/clean `fa` 60.0 -> 55.0,
te/clean `fa` 65.0 -> 57.5). **There is no corrected English number to report: the ground truth
was not at fault, and if anything the recorded English figures are 0-3 points generous, not
harsh.**

One real finding hides in the music column of the first table: under the music bed the
band-limited detector finds the English onsets far less reliably than any other language
(median -267.6 ms, only 42.5% within 20 ms, 55% beyond 100 ms, against 20-35% elsewhere). That
is a property of the English speech against that bed, and it is the reason any onset-snap fix
has to run on the separated vocals stem rather than the mix (which the pipeline already does).

## 3. Hypothesis 2 - mapping failure rather than placement failure. HALF TRUE, and only under music

`retime_by_words` was re-run and its internal difflib matching re-derived so each line's assigned
word indices could be inspected. `purity` is the share of the words assigned to a line whose
midpoint falls inside the line's true span (+/-150 ms); `lead missed` counts lines whose first
matched token is not the line's first token.

| lang | variant | model | matched % | token hit % | purity median | lines with leading words missed | well % | median ms | p95 abs ms |
|---|---|---|---|---|---|---|---|---|
| en | clean | chirp_2 | 87.5 | 76.5 | 1.000 | 6 | 37.1 | -28.2 | 927.6 |
| en | clean | chirp_3 | **97.5** | **85.3** | **1.000** | 5 | 51.3 | -18.9 | 881.6 |
| en | music | chirp_2 | 72.5 | 61.1 | 1.000 | 9 | 31.0 | +4.7 | 2509.5 |
| en | music | chirp_3 | **70.0** | **57.7** | 1.000 | 2 | 42.9 | -25.6 | 1130.5 |
| hi | clean | chirp_3 | 100.0 | 86.3 | 1.000 | 5 | 42.5 | -34.4 | 2210.3 |
| hi | music | chirp_3 | 97.5 | 85.2 | 1.000 | 6 | 56.4 | -19.0 | 690.0 |
| te | clean | chirp_3 | 100.0 | 83.7 | 1.000 | 5 | 52.5 | -21.8 | 1738.4 |
| te | music | chirp_3 | 100.0 | 83.7 | 1.000 | 5 | 62.5 | -15.8 | 1927.4 |
| ta | clean | chirp_3 | 100.0 | 79.0 | 1.000 | 7 | 60.0 | -1.3 | 2417.1 |
| ta | music | chirp_3 | 100.0 | 77.9 | 1.000 | 12 | 55.0 | +3.2 | 1534.7 |
| ml | clean | chirp_3 | 97.5 | 82.1 | 1.000 | 6 | 38.5 | -29.0 | 1514.4 |
| ml | music | chirp_3 | 97.5 | 81.2 | 1.000 | 7 | 51.3 | -22.6 | 1393.7 |
| kn | clean | chirp_3 | 100.0 | 86.4 | 1.000 | 10 | 35.0 | -16.3 | 1534.9 |
| kn | music | chirp_3 | 80.0 | 62.3 | 1.000 | 7 | 31.2 | -23.2 | 1730.0 |
| gu | clean | chirp_3 | 100.0 | 86.3 | 1.000 | 9 | 47.5 | -11.4 | 2577.1 |
| gu | music | chirp_3 | 100.0 | 85.2 | 1.000 | 11 | 40.0 | -11.8 | 1763.4 |

Read this honestly:

* **On clean audio English mapping is fine** - 97.5% matched, 85.3% token hit, purity 1.000,
  the same as Hindi. Mapping cannot explain en/clean 51-55%.
* **On the music variant English mapping collapses** and is the worst of the seven except
  Kannada: 70.0% matched, 57.7% token hit for chirp_3. Chirp mis-hears English under this bed
  much more than it mis-hears Hindi. That is why the chirp-derived arms (A/B/D/E of the bake-off)
  look so bad for en/music and why their brackets read `[70]`. It is a recogniser-under-noise
  problem, not a placement problem.
* Mapping **purity is 1.000 at the median in every language**: when a line is matched, the words
  assigned to it really are its words. The failure mode "wrong words assigned to the line" does
  not happen in this corpus.
* The arms that use no mapping at all - `oracle`, `wide`, `armC` - still put English 20-30 points
  behind Hindi and Telugu (section 5). **The error does not live in mapping.**

## 4. Hypothesis 3 - the aligner handles English differently. TRUE about the code path, FALSE as a cause

### 4a. The actual code path

`services/aligner.py` has exactly one language-dependent step and one text-dependent step.

Romanisation, `aligner.py` lines 118-126:

```python
def _romanise(text, lang):
    try:
        return _state["uro"].romanize_string(text, lcode=(lang or None))
    except Exception:
        ...
```

Tokenisation, lines 105-116:

```python
def _tokenise(words):
    """Words -> token ids. Index 0 is the CTC blank ('-'), and romanisation emits hyphens
    freely, so anything mapping to 0 must be dropped or forced_align refuses the target."""
    d = _state["dict_"]
    out, kept = [], []
    for w in words:
        ids = [d[c] for c in w.lower() if c in d and d[c] != 0]
        if ids:
            out.append(ids)
            kept.append(w)
    return out, kept
```

The MMS_FA label set is 29 symbols and was dumped from the live bundle:
`-` (id 0, blank), `a i e n o u t s r m k l d g h y b p w c v j z f`, `'` (25), `q x` and
`*` (28, the star). No digits, no punctuation, no uppercase - `w.lower()` handles case, everything
else is dropped character by character, and a word left with no ids is dropped **from both `tok`
and `kept`**.

Measured consequences, per language:

| lang | romanised words | words dropped by `_tokenise` | drop % | lines affected | lines with a digit | `romanize_string` changed the text |
|---|---|---|---|---|---|---|
| hi | 810 | 5 | 0.62 | 3/40 | 3/40 | yes |
| te | 539 | 5 | 0.93 | 4/40 | 7/40 | yes |
| **en** | 843 | 11 | 1.30 | 8/40 | 9/40 | **no - identity** |
| ta | 543 | 10 | 1.84 | 9/40 | 9/40 | yes |
| ml | 457 | 2 | 0.44 | 2/40 | 3/40 | yes |
| kn | 471 | 7 | 1.49 | 4/40 | 3/40 | yes |
| gu | 738 | 17 | 2.30 | 12/40 | 14/40 | yes |

So English **is** on a different code path - it is the one language for which uroman is the
identity, verified line by line (`romanise_changed_text=False` for en, `True` for hi/te; the
Hindi line 0 becomes `kuch annuom mem asthir kemdrak hotaa hai, ...`). English is aligned on its
own orthography while the other six are aligned on a near-phonemic transliteration. Token
dropping is **not** English-specific (gu 2.30% > ta 1.84% > kn 1.49% > en 1.30%), and the words
dropped are digits and bare punctuation: en drops `25 30 3:2. 1940 ...`, hi `70 100 1963`,
gu `). 70 100 6`.

### 4b. Is the identity romanisation the cause? No - tested directly

English was re-aligned on a **CMUdict phonemic respelling** (ARPAbet mapped onto the MMS letter
set: `AA->a AE->a DH->dh IY->ii SH->sh ...`; 96.9% of the corpus's English words found in
CMUdict, 11438 of 11802). If deep orthography were the cause, this should have moved the numbers.
It moved nothing at all:

| en clean, oracle window | well % | median ms | p95 abs ms | <=50 ms | <=100 | <=200 | conf median |
|---|---|---|---|---|---|---|---|
| own spelling (shipped) | 50.0 | -9.1 | 691.1 | 50.0 | 65.0 | 80.0 | 0.986 |
| CMUdict respelling | 50.0 | -9.1 | 691.1 | 52.5 | 65.0 | 80.0 | 0.599 |
| own spelling + star tokens | 50.0 | -9.1 | 691.1 | 52.5 | 65.0 | 80.0 | 0.986 |
| respelling + star tokens | 50.0 | -9.1 | 691.1 | 55.0 | 65.0 | 80.0 | 0.599 |

Confidence falls (0.986 -> 0.599, as expected, the model was trained on romanised orthography)
and the **times are identical**. Whatever is wrong with English alignment, the spelling is not it.

A related check kills the other obvious "English gives the aligner less to work with" story.
Token density per second of speech is the same in every language:

| lang | tokens | speech s | tokens/s | tokens per word | MMS frames (20 ms) per token |
|---|---|---|---|---|---|
| en | 4031 | 293.7 | **13.73** | 4.84 | 3.64 |
| hi | 4288 | 318.0 | 13.49 | 5.33 | 3.71 |
| te | 4632 | 325.9 | 14.21 | 8.67 | 3.52 |
| ta | 4668 | 346.7 | 13.47 | 8.76 | 3.71 |
| ml | 5232 | 390.0 | 13.42 | 11.50 | 3.73 |
| kn | 4431 | 368.4 | 12.03 | 9.55 | 4.16 |
| gu | 4950 | 341.4 | 14.50 | 6.87 | 3.45 |

English words are shorter (4.84 letters per word against Telugu's 8.67) but English speaks more
of them, so the aligner receives 13.7 tokens per second either way.

### 4c. A real bug found by reading the code: `retime_segments` splits by the wrong count

`align_window` returns one entry per **kept** word. `retime_segments` splits that list back onto
lines by each line's **original** word count (`aligner.py` line 238, in `per_line`):

```python
    def per_line(words, group):
        """Split a window's word list back onto its lines, by word count."""
        res, k = [], 0
        for s in group:
            n = len([w for w in text_of(s).split() if w])
            sub = words[k:k + n]
            k += n
```

Any word `_tokenise` drops - a bare numeral, `(2)`, `11:35` - shortens `words` without shortening
`n`, so every following line in that 45 s window is handed the wrong words. Priced by running the
whole-file alignment both ways (the window is the whole file, so this is the worst case):

| lang | variant | correct split, well % | median ms | buggy split, well % | median ms |
|---|---|---|---|---|---|
| en | clean | 60.0 | +17.6 | **2.5** | +1702.1 |
| en | music | 52.5 | +19.1 | 5.0 | +1525.7 |
| hi | clean | 80.0 | -3.2 | 10.0 | +999.0 |
| hi | music | 70.0 | -2.9 | 7.5 | +1064.4 |
| te | clean | 82.5 | +10.0 | 47.5 | +58.7 |
| te | music | 80.0 | +10.0 | 47.5 | +58.7 |

English is hit hardest because its **very first line** contains `25` and `30`, so the desync
starts at line 0; Telugu's first dropped word is at line 20, so half its lines survive. In
production the windows are 45 s (5-8 lines), so the damage is bounded to the rest of the window
after the first digit - but 8 of 40 English lines contain a word that drops, against 2-4 for
hi/ml/kn. This affects `retime_segments`, i.e. the pre-FA re-anchor path and bake-off arms D/E.
`fa_timing.retime_blocks` is immune: it aligns one line at a time and handles the count mismatch
explicitly in `_apply`.

## 5. Hypothesis 4 - error shape. A wide core plus an 8-line late tail, and the tail is nearly all male

### 5a. Full distributions (share of lines with \|start error\| inside each window)

en, hi, te, clean and music, all arms:

| lang | variant | arm | n | median ms | p95 abs ms | early < -40 | late > +120 | well (-40/+120) | <=50 | <=100 | <=200 | <=500 | <=1000 | <=2000 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| en | clean | chirp_2 | 35 | -28.2 | 927.6 | 40.0 | 22.9 | 37.1 | 37.1 | 62.9 | 71.4 | 85.7 | 94.3 | 94.3 |
| en | clean | chirp_3 | 39 | -18.9 | 881.6 | 28.2 | 20.5 | 51.3 | 56.4 | 66.7 | 71.8 | 82.1 | 94.9 | 100.0 |
| en | clean | `fa` | 40 | +0.1 | 597.6 | 25.0 | 20.0 | 55.0 | 57.5 | 72.5 | 80.0 | 90.0 | 100.0 | 100.0 |
| en | clean | oracle | 40 | -9.1 | 691.1 | 32.5 | 17.5 | 50.0 | 50.0 | 65.0 | 80.0 | 90.0 | 100.0 | 100.0 |
| en | clean | wide | 40 | -17.7 | 2959.9 | 35.0 | 15.0 | 50.0 | 45.0 | 60.0 | 67.5 | 77.5 | 82.5 | 82.5 |
| en | clean | armC | 40 | +17.6 | 700.3 | 15.0 | 25.0 | 60.0 | 55.0 | 65.0 | 72.5 | 82.5 | 97.5 | 97.5 |
| en | music | chirp_2 | 29 | +4.7 | 2509.5 | 34.5 | 34.5 | 31.0 | 34.5 | 51.7 | 58.6 | 75.9 | 86.2 | 89.7 |
| en | music | chirp_3 | 28 | -25.6 | 1130.5 | 35.7 | 21.4 | 42.9 | 50.0 | 64.3 | 71.4 | 82.1 | 92.9 | 96.4 |
| en | music | `fa` | 40 | +0.0 | 629.6 | 15.0 | 17.5 | 67.5 | 70.0 | 77.5 | 82.5 | 92.5 | 100.0 | 100.0 |
| en | music | oracle | 40 | -9.0 | 691.1 | 30.0 | 20.0 | 50.0 | 57.5 | 70.0 | 77.5 | 90.0 | 100.0 | 100.0 |
| en | music | armC | 40 | +19.1 | 3263.9 | 20.0 | 27.5 | 52.5 | 47.5 | 55.0 | 60.0 | 72.5 | 90.0 | 90.0 |
| hi | clean | chirp_3 | 40 | -34.4 | 2210.3 | 45.0 | 12.5 | 42.5 | 47.5 | 70.0 | 70.0 | 75.0 | 87.5 | 92.5 |
| hi | clean | `fa` | 40 | -19.3 | 1554.1 | 32.5 | 7.5 | 60.0 | 62.5 | 82.5 | 85.0 | 87.5 | 92.5 | 95.0 |
| hi | clean | oracle | 40 | -8.6 | 132.1 | 22.5 | 5.0 | 72.5 | 77.5 | **92.5** | **97.5** | 97.5 | 97.5 | 100.0 |
| hi | clean | armC | 40 | -3.1 | 164.6 | 15.0 | 5.0 | 80.0 | 72.5 | 87.5 | 95.0 | 95.0 | 95.0 | 97.5 |
| hi | music | oracle | 40 | -8.6 | 132.1 | 22.5 | 5.0 | 72.5 | 77.5 | 92.5 | 97.5 | 97.5 | 97.5 | 100.0 |
| hi | music | armC | 40 | -2.9 | 766.6 | 25.0 | 5.0 | 70.0 | 65.0 | 87.5 | 90.0 | 92.5 | 95.0 | 97.5 |
| te | clean | chirp_3 | 40 | -21.8 | 1738.4 | 32.5 | 15.0 | 52.5 | 60.0 | 70.0 | 70.0 | 75.0 | 85.0 | 100.0 |
| te | clean | `fa` | 40 | -21.8 | 1094.1 | 27.5 | 7.5 | 65.0 | 72.5 | 80.0 | 82.5 | 85.0 | 92.5 | 100.0 |
| te | clean | oracle | 40 | -8.4 | 129.1 | 20.0 | 5.0 | 75.0 | 82.5 | **92.5** | **95.0** | 95.0 | 100.0 | 100.0 |
| te | clean | armC | 40 | +10.1 | 155.3 | 10.0 | 7.5 | 82.5 | 75.0 | 90.0 | 95.0 | 95.0 | 100.0 | 100.0 |
| te | music | oracle | 40 | -8.0 | 109.1 | 27.5 | 5.0 | 67.5 | 77.5 | 92.5 | 95.0 | 95.0 | 100.0 | 100.0 |
| te | music | armC | 40 | +10.1 | 155.3 | 12.5 | 7.5 | 80.0 | 72.5 | 90.0 | 95.0 | 95.0 | 100.0 | 100.0 |

The brief's diagnosis of the shape is right and now has a mechanism. Look at the oracle rows:
English **80.0%** within 200 ms against Hindi **97.5%** and Telugu **95.0%**, and English needs
1000 ms to reach 100%. Loosening the window does lift English (50 -> 65 -> 80 across
50/100/200 ms) but it runs into a hard 8-line block that only clears at 500-1000 ms.

### 5b. Bimodality, counted (signed error, lines of 40)

| arm | < -2000 | -2000..-1000 | -1000..-500 | -500..-200 | -200..-100 | -100..-40 | **-40..+120** | +120..200 | 200..500 | 500..1000 | 1000..2000 | > 2000 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| en clean oracle | 0 | 0 | 1 | 0 | 6 | 6 | **20** | 0 | 4 | 3 | 0 | 0 |
| en clean `fa` | 0 | 0 | 0 | 0 | 3 | 7 | **22** | 0 | 4 | 4 | 0 | 0 |
| en clean armC | 0 | 0 | 1 | 0 | 2 | 3 | **24** | 0 | 4 | 5 | 0 | 1 |
| en music oracle | 0 | 0 | 1 | 0 | 3 | 8 | **20** | 0 | 5 | 3 | 0 | 0 |
| hi clean oracle | 0 | 0 | 0 | 0 | 1 | 8 | **29** | 1 | 0 | 0 | 1 | 0 |
| te clean oracle | 0 | 0 | 0 | 0 | 1 | 7 | **30** | 0 | 0 | 2 | 0 | 0 |

Two modes, and the sizes are: a **core of 32 lines** (80%) inside 200 ms whose median error is
-9 ms, and a **tail of 7-8 lines** at +200 to +1000 ms - almost all LATE. Hindi's tail is 1 line,
Telugu's is 2.

### 5c. What the tail lines have in common: speaker, and only speaker

Tail = \|oracle error\| > 200 ms. Everything measurable was compared between tail and core:

| feature | en tail (n=8) | en core (n=32) | hi tail (n=1) | te tail (n=2) |
|---|---|---|---|---|
| words per line, median | 20.5 | 19.0 | 19 | 16.0 |
| duration s, median | 8.41 | 7.71 | 8.22 | 10.55 |
| words per second | 2.50 | 2.78 | 2.31 | 1.54 |
| first-word letters | 3.0 | 3.0 | 0 | 3.5 |
| first word is a function word | 75.0% | 71.9% | - | - |
| contains a digit | 12.5% | 25.0% | 100% | 100% |
| clip SNR dB, median | 48.95 | 44.55 | 24.3 | 41.0 |
| ground-truth check error, median | 2.5 ms | 7.55 ms | 12.5 ms | 2.5 ms |
| onset flagged ambiguous | 0.0% | 18.8% | 0.0% | 50.0% |
| **female speaker** | **12.5%** | **68.8%** | 0.0% | 0.0% |
| tail line indices | 1, 4, 6, 9, 13, 18, 27, 31 | | 20 | 32, 37 |

Length, duration, digits, acronyms, proper nouns, position in the file and ground-truth
uncertainty all fail to separate the two groups. **Speaker gender separates them completely.**
Rank correlations of \|error\| with the obvious features confirm there is nothing else there
(en/clean: words -0.02, duration -0.11, index -0.09, words/s +0.12, digits -0.26, mid-sentence
capitals -0.20, acronyms -0.16, clip SNR +0.35 - the only non-trivial one, and it is a proxy for
the male clips, which were recorded a little cleaner).

Split every arm by gender:

| lang | corpus | arm | MALE | FEMALE |
|---|---|---|---|---|
| en | 17 M / 23 F, male 8.18 s at 2.27 w/s, female 6.84 s at 3.39 w/s | chirp_3 clean | 29.4% well, median -12.6, w200 58.8% | 68.2% well, median -22.8, w200 81.8% |
| en | | `fa` clean | **41.2%** well, median +30.5, w200 **58.8%** | **65.2%** well, median -9.7, w200 **95.7%** |
| en | | oracle clean | 41.2%, median +71.7, w200 58.8% | 56.5%, median -27.7, w200 95.7% |
| en | | armC clean | 47.1%, median +88.3, w200 58.8% | 69.6%, median +1.9, w200 82.6% |
| en | | `fa` music | 41.2%, median +20.7, w200 58.8% | **87.0%**, median +0.0, w200 **100.0%** |
| hi | 25 M / 15 F | oracle clean | 72.0%, median -8.3, w200 96.0% | 73.3%, median -28.8, w200 100.0% |
| hi | | armC clean | 76.0%, median -2.5, w200 96.0% | 86.7%, median -20.9, w200 93.3% |
| te | 31 M / 9 F | oracle clean | 77.4%, median -8.0, w200 93.5% | 66.7%, median -28.1, w200 100.0% |

**The English female lines behave like Hindi and Telugu** (`fa` music 87.0% well, 100% inside
200 ms). The English male lines are where the whole deficit lives, and they are late
(median +20 to +88 ms, w200 58.8%). Hindi and Telugu show no such split - so this is not "MMS is
worse on male voices"; it is specific to what these English male readers do.

### 5d. What they do: the leading word is abandoned

Two more measurements. First, both boundaries, oracle window:

| lang | variant | start median | start p95 abs | start well % | **end median** | **end p95 abs** | end \|e\|<=200 ms | first word dur | interior word dur | last word dur |
|---|---|---|---|---|---|---|---|---|---|---|
| en | clean | -9.1 | 691.1 | 50.0 | **+94.4** | **1191.5** | **45.0%** | 0.120 s | 0.200 s | 0.381 s |
| en | music | -9.0 | 691.1 | 50.0 | +68.8 | 1191.5 | 47.5% | 0.110 s | 0.201 s | 0.371 s |
| hi | clean | -8.6 | 132.1 | 72.5 | +28.4 | 309.0 | 85.0% | 0.321 s | 0.260 s | 0.140 s |
| te | clean | -8.4 | 129.1 | 75.0 | -11.2 | 132.7 | 95.0% | 0.441 s | 0.420 s | 0.541 s |

English is loose at **both** ends, and its first word is abnormally short (0.6x an interior word,
where Hindi's is 1.23x and Telugu's 1.05x). Second, how much of the line's speech the aligned
span actually covers:

| lang | span ratio (aligned/true) median | p05 | speech energy left OUTSIDE the aligned span, median | p95 | lines losing > 10% of their energy |
|---|---|---|---|---|---|
| en | 1.025 | **0.791** | 0.0% | **63.1%** | **7 / 40** |
| hi | 1.003 | 0.942 | 0.0% | 1.1% | 1 / 40 |
| te | 1.000 | 0.975 | 0.1% | 1.9% | 1 / 40 |
| en MALE (17) | 0.991 | - | 0.7% | - | start err median +71.7, end err median +8.3 |
| en FEMALE (23) | 1.051 | - | 0.0% | - | start err median -27.7, end err median +309.5 |

Then the per-word dump. For each of these lines the level trace is in dB relative to the line's
own P95, in 20 ms steps, starting 0.2 s before `true_start`; `ASR` is faster-whisper small run
locally on the isolated source clip, mapped into timeline time.

```
line  6 MALE true 55.558..66.368  start_err +911.3 ms  end_err -1772.0 ms
    MMS : The@56.470 | aspect@56.670 | ratio@57.090 | of@57.451 | this@57.531 | format@57.731
    ASR : The@55.388 | aspect@56.528 | ratio@56.908 | of@57.388 | this@57.528 | format,@57.668
    level: -207 -207 -207 -207 -207 -207 -207 -207 -207 -69 -12 -11 -9 -12 -12 -12 -12 -11 ...

line  4 MALE true 32.503..43.713  start_err +691.1 ms  end_err -1191.5 ms
    MMS : The@33.194 | hospital@33.314 | has@33.775 | followed@33.955 | protocol@34.275
    ASR : The@32.303 | hospital@33.283 | has@33.583 | followed@33.883 | protocol@34.163
    level: -210 -210 -210 -210 -210 -210 -45 -56 -45 -22 -16 -13 -14 -12 -10 -9 -6 -7 ...

line 13 MALE true 112.057..116.887  start_err +492.0 ms  end_err -832.5 ms
    MMS : But@112.549 | there@112.709 | are@112.889 | a@113.150 | lot@113.230
    ASR : But@111.887 | there@112.667 | are@112.847 | a@113.027 | lot@113.107
    level: -212 x10 then -14 -3 -2 -0 0 -1 -0 -0 -0 -1 -0 -3 -5 ...

line  0 MALE true 0.500..8.090  start_err +1.1 ms (a line that works)
    MMS : However,@0.501 | due@1.503 | to@1.644 | the@1.744 | slow@1.884
    ASR : However,@0.170 | due@1.530 | to@1.590 | the@1.710 | slow@1.830
```

The picture is unambiguous. Real speech starts at `true_start` at only 12-14 dB below the line's
own peak level - it is not a breath and not room tone. The independent ASR puts the transcript's
first word there. MMS_FA agrees with the ASR on the **second** word (`aspect` 56.670 vs 56.528,
`hospital` 33.314 vs 33.283, `there` 112.709 vs 112.667 - all within 150 ms) and puts the
**first** word in an 80-120 ms sliver immediately before it, abandoning the 0.4-0.9 s in which
that word was actually spoken. Every affected line begins with a monosyllable - `The`, `But`,
`As`, `All` - which these readers lengthen or follow with a pause. CTC is free to emit two or
three letters anywhere in that stretch and prefers the frames adjacent to the strongly modelled
following word, so the entire leading word plus its pause falls outside the line. The same
happens in reverse at the end of the line (end error median +94 ms, p95 1191 ms, and the tail
lines end 600-1770 ms early).

The window is not the cause. A pad sweep, clean variant:

| lang | pad | well % | median ms | p95 abs ms | <=200 ms | end median | span ratio median / p05 | lines > 300 ms LATE |
|---|---|---|---|---|---|---|---|---|
| en | 0.05 s | **71.8** | -9.9 | 610.8 | 82.1 | +29.9 | 1.003 / 0.791 | **7** |
| en | 0.25 s | 53.8 | -9.6 | 611.0 | 76.9 | +69.7 | 1.010 / 0.791 | **7** |
| en | 0.75 s | 50.0 | -9.1 | 691.1 | 80.0 | +94.4 | 1.025 / 0.791 | **7** |
| en | 1.50 s | 55.0 | -18.0 | 1339.7 | 72.5 | +116.9 | 1.026 / 0.790 | **7** |
| en | 3.00 s | 50.0 | -17.7 | 2959.9 | 67.5 | +124.0 | 1.037 / 0.790 | 6 |
| hi | 0.05 s | 90.0 | +0.1 | 70.5 | 97.5 | +9.9 | 1.000 / 0.940 | 1 |
| hi | 0.25 s | 80.0 | -9.5 | 131.0 | 97.5 | +29.4 | 1.003 / 0.942 | 1 |
| hi | 0.75 s | 72.5 | -8.6 | 132.1 | 97.5 | +28.4 | 1.003 / 0.942 | 1 |

The same 7 lines are more than 300 ms late at **every** pad, including a pad of 50 ms where the
window opens essentially on the speech onset. The aligner is not being confused by a wide search;
it is choosing not to cover the first word. (The sweep does say something useful for production:
every language prefers a tight window - English 50.0 -> 71.8, Hindi 72.5 -> 90.0 - so "the hint
hurt" from the bake-off is a statement about *bad* hints, not about hints.)

## 6. Hypothesis 5 - the corpus register. Real differences, but they do not predict the failures

| lang | words/line median | words p95 | duration s median | words/s median | lines with a digit | lines with an acronym | mid-sentence capitals median | clip SNR dB median | ambiguous onsets |
|---|---|---|---|---|---|---|---|---|---|
| hi | 20.0 | 27.0 | 7.90 | 2.47 | 3 | 1 | 0 | 36.1 | 10 |
| te | 13.5 | 19.0 | 7.68 | 1.69 | 7 | 3 | 0 | 47.9 | 14 |
| **en** | **19.5** | **33.0** | 7.83 | **2.60** | **9** | 1 | **1.0** | 45.7 | **6** |
| ta | 13.0 | 19.0 | 9.12 | 1.54 | 9 | 0 | 0 | 39.3 | 12 |
| ml | 11.0 | 16.0 | 10.12 | 1.17 | 3 | 0 | 0 | 41.6 | 15 |
| kn | 12.0 | 16.0 | 9.55 | 1.25 | 3 | 0 | 0 | 47.2 | 11 |
| gu | 18.5 | 27.0 | 8.84 | 2.21 | 14 | 0 | 0 | 35.2 | 8 |

(`duration p95` and `chars median` are in `stage5_register.json`; they add nothing to the argument
and are left out of the table rather than half-filled.)

English is the fastest corpus (2.60 words/s), has the longest tail of long lines (p95 33 words),
the most mid-sentence capitals (proper nouns), and 9 of 40 lines with digits - but Gujarati has
14 digit lines and does not fail this way, and the correlations in 5c show digits and proper
nouns pointing the **wrong** way (lines with digits are placed slightly *better*). The one
register fact that does matter is indirect: within English, the male lines are the slow ones
(0.399 s per word against 0.281 s), and slow delivery is what leaves a lengthened leading
monosyllable and a pause for CTC to skip.

## 7. Three defective English lines - and none in any other language

Auditing every clip's trim against its source file length (`placed = clip length - lead trim -
tail trim`, which holds exactly everywhere, so the arithmetic is self-consistent) turns up three
English lines whose placed audio cannot possibly hold their text, and zero such lines in the
other six languages:

| lang | line | words | placed duration | s per word | source clip | lead trim | **tail trim** |
|---|---|---|---|---|---|---|---|
| en | 9 | 29 | 1.68 s | 0.058 | 10.92 s | 1.36 s | **7.88 s** |
| en | 16 | 29 | 3.11 s | 0.107 | 9.60 s | 0.91 s | **5.58 s** |
| en | 34 | 14 | 2.03 s | 0.145 | 6.42 s | 0.93 s | **3.46 s** |
| hi, te, ta, ml, kn, gu | - | - | - | - | - | - | 0 suspect lines |

The builder's end-trimmer cut into speech on those three clips - presumably it found a long
internal pause, which is the same English reading habit that causes the main failure. Line 9 is
the one big EARLY error in the English set (oracle -750 ms) and it is unfixable as it stands:
29 words are being asked to fit in 1.68 s, and the local ASR finds the clip's speech continuing
6.8 s past the recorded `true_end`.

Dropping the three lines:

| en arm | all 40 | 3 suspect lines dropped |
|---|---|---|
| clean chirp_3 | 51.3% | 48.6% |
| clean `fa` | 55.0% | 51.4% |
| clean oracle | 50.0% | 51.4% (p95 691 -> 611) |
| clean armC | 60.0% | 62.2% (w200 72.5 -> 75.7) |
| music `fa` | 67.5% | 64.9% |
| music armC | 52.5% | 54.1% |

Worth about 2 points on the alignment arms, in both directions. It is a real corpus defect and it
should be rebuilt, but it is not the explanation.

## 8. English audio on the box

The claim that every job holds the same two Hindi sources was **re-probed from the audio**, not
taken on trust: faster-whisper (local, CPU, no API spend) was run on a 30 s and a 200 s sample of
every job's audio and of every candidate asset:

| asset | probed language | probability | note |
|---|---|---|---|
| `dub_jobs/faprim01/audio_hq.wav` | hi | 0.99 / 0.98 | the 760 s "Desi Friends" source |
| `dub_jobs/1zy8g9bt/audio_hq.wav` | hi | 0.99 / 0.98 | same source |
| `dub_jobs/fno0wbe7/audio_hq.wav` | hi | 0.99 / 0.98 | same source |
| `dub_jobs/tfall3fx/audio_hq.wav` | hi | 0.99 / 0.98 | same source |
| `dub_jobs/tfg1copy/audio_hq.wav` | hi | 0.99 / 0.98 | same source |
| `dub_jobs/0hbcwywx/original.mp4` | hi | 0.97 | the second (546 s) Hindi clip |
| `dub_jobs/byfvvqk8/original.mp4` | hi | 0.97 | same |
| `dub_jobs/sbsx4lhl/` | - | - | empty directory |
| `/tmp/csvui_source.mp4`, `/tmp/vocals_src.wav` | hi | 0.98 / 0.79 | copies of the same source |
| **`/tmp/ui_en.mp4`** | **en** | 0.67 | **this pipeline's own English dub of the Hindi source** |
| **`/tmp/exp_en.mp4`** | **en** | 0.69 | same, an export |
| **`/home/ubuntu/out/dubbed_en.wav`** | **en** | - | host-side English dub, 26 MB |

Confirmed: **there is no English source video on the box.** There are three English **dubs** the
pipeline itself produced - synthetic TTS English over the Hindi source - and they were used,
because they are the only non-FLEURS English speech available. A TTS dub is a sequence of clips
separated by silence, so each region's energy onset is an unambiguous start time; the text was
recovered locally with faster-whisper small and aligned with MMS_FA in a +/-1.5 s window:

| asset | regions | well placed (-40/+120 ms) | median ms | p95 abs ms | \|e\| <= 100 ms | \|e\| <= 200 ms |
|---|---|---|---|---|---|---|
| `/home/ubuntu/out/dubbed_en.wav` (240 s) | 57 of 60 | **52.6%** | -15.1 | 1459.9 | 50.9% | 59.6% |
| `/tmp/exp_en.mp4` (48 s) | 11 | 36.4% | -36.4 | 1158.3 | 45.5% | 54.5% |
| Telugu dub of the same source (control) | 29 of 48 | 13.8% | -1319.6 | 1500.0 | 13.8% | 17.2% |

Read this with care. The English figure (52.6% well placed, 59.6% inside 200 ms) sits exactly
where FLEURS English sits, on completely different English audio, which is weak corroboration
that the effect is not a FLEURS artefact. **The Telugu control is not usable**: the local ASR
could not transcribe Telugu TTS well enough (19 of 48 regions produced fewer than three words,
and the aligner then failed on a wrong transcript), so the 13.8% measures the ASR, not the
aligner. Without a working control this experiment cannot be used to compare languages - only to
say the English number reappears outside FLEURS.

## 9. Summary table - where the English deficit does and does not come from

| stage removed / condition | en clean | en music | hi clean | te clean | conclusion |
|---|---|---|---|---|---|
| shipped `fa` cascade | 55.0 | 67.5 | 60.0 | 65.0 | recorded behaviour, reproduced |
| ground truth replaced by an independent onset measurement | 52.5 | 62.5 | 55.0 | 57.5 | **not the ground truth** |
| mapping removed (oracle window, aligner only) | 50.0 | 50.0 | 72.5 | 75.0 | **not the mapping** |
| mapping and windowing removed (whole-file alignment) | 60.0 | 52.5 | 80.0 | 82.5 | **not the window** |
| English spelling replaced by a CMUdict phonemic respelling | 50.0 | - | - | - | **not the orthography** |
| window tightened to +/-0.05 s | 71.8 | - | 90.0 | - | window helps everyone; 7 English lines never move |
| 3 defective corpus lines dropped | 51.4 (oracle) | - | - | - | worth ~2 points |
| onset snap that bridges one pause | **62.5** | - | 75.0 | 77.5 | **the fix that addresses the cause** |

## 10. Ranked fixes, with the measured gain and the cost

1. **Let the onset snap bridge one pause, and raise its ceiling for a late start.** This is the
   fix that targets the cause. The pipeline already has `chirp_wire._snap_onsets`, run on the
   separated vocals stem after `resolve_timeline` and before `breathe`, but it walks back only
   inside the **voiced run the aligned start already sits in** (`_run_onset`), with
   `SNAP_MAX_S = 0.60` and a **broadband** gate (`min(P97 - 35 dB, -45 dBFS)`). A pause between
   the abandoned leading word and the rest of the line puts the aligned start in a *different*
   run, so today's snap recovers nothing on exactly the lines that need it, and its 0.60 s cap
   would clip the 0.911 s case anyway.
   *Change*: band-limit the gate to 300-3400 Hz; if the previous voiced run ends within ~0.4 s of
   the aligned start and is not claimed by the previous line's end, snap to that run's start;
   raise the backward cap to ~1.0 s for this case only (the forward case must stay at 0.60 s).
   *Measured gain*: en/clean oracle 50.0 -> **62.5** (+12.5), p95 691 -> 314 ms, inside 200 ms
   80.0 -> 92.5; hi 72.5 -> 75.0; te 75.0 -> 77.5. No language lost.
   *Cost*: one 10 ms-frame energy pass over the vocals stem per job (milliseconds), no API, no
   GPU. It must run on the vocals stem, not the mix - the same detector on the music mix is
   median -267.6 ms wrong for English (section 2).
   *Risk*: it can only move a start EARLIER, which is the perceptually expensive direction, so it
   needs the existing guard against crossing the previous line's end. Keep `SNAP_LEAVE_S`.

2. **Fix the `per_line` split in `aligner.retime_segments`.** A one-line bug: split the aligned
   word list by the count `_tokenise` **kept**, not by the original word count, or have
   `align_window` return a placeholder for dropped words.
   *Measured gain*: up to **+57 points** in the worst case (whole-file window: en 2.5 -> 60.0,
   hi 10.0 -> 80.0, te 47.5 -> 82.5). In production the windows are 45 s so the exposure is the
   rest of the window after the first dropped word; 8 of 40 English lines contain such a word.
   *Cost*: two lines of code plus a test. No measurement risk - the correct split cannot be worse.
   *Caveat*: `fa_timing.retime_blocks` is already immune, so this only helps the
   `OMNIVOICE_TIMING_SOURCE=chirp` path, the `_words_from_lines` path and anything else calling
   `retime_segments`.

3. **Star tokens at the window edges in the wide pass, with the star spans stripped before the
   caller sees them.** MMS_FA carries a star label (id 28) that absorbs audio the transcript does
   not cover.
   *Measured gain* on a wide (+/-3 s) window: en/clean 50.0 -> **57.5**, hi/clean 65.0 -> **82.5**,
   hi/music 57.5 -> **77.5**, te/clean 70.0 -> **82.5**, te/music 60.0 -> **75.0**, en/music
   50.0 -> 50.0. Through the shipped cascade (`mode=fa`): en/clean 55.0 -> **60.0** with refusals
   collapsing to `{conf 3, length 1}` and 36 of 40 lines placed by alignment; hi/clean
   60.0 -> **70.0**; te/clean 65.0 -> **75.0**; hi/music and te/music unchanged (75.0, 70.0);
   en/music 67.5 -> 65.0, the one regression.
   *Cost*: about 10 lines in `align_window` plus a flag. **The stars must be stripped from the
   returned list**: a naive version that leaves them in makes `fa_timing._plausible` see a span
   touching the window edge and refuse every line - measured, and it silently reduced hi/clean to
   42.5 and te/clean to 52.5, i.e. exactly chirp_3's own numbers.
   *Note*: this does **not** fix the English tail (oracle-window English is unchanged at 50.0 with
   stars) - it fixes wide-window edge dumping, which is a different and mostly non-English problem.

4. **Rebuild or drop the three defective English corpus lines (9, 16, 34).** The end-trimmer cut
   3.5-7.9 s of speech off three clips. *Gain*: about 2 points of measurement honesty and a
   permanent floor removed; the audit query is in `r11_trim_audit.json` and should be run over any
   rebuilt corpus. *Cost*: a corpus rebuild for English only; no recogniser calls are needed for
   the alignment arms, but the cached chirp responses for `en_clean`/`en_music` would no longer
   match the audio, so re-running the chirp arms on a rebuilt English corpus would cost
   **4 cache entries x 5.6 min of audio = 22.3 min at $0.016/min, about $0.36**. Not spent; asking
   first, as instructed.

5. **Stop expecting Chirp to anchor English under a music bed.** en/music chirp_3 matches only
   70.0% of lines and finds 57.7% of the transcript's tokens (clean: 97.5% / 85.3%). The FA-primary
   path does not use Chirp's position, but it does use Chirp's length to bound the window, and an
   unmatched line has no bound at all. *Gain*: not measured as a code change; the size of the
   problem is the 27.5-point matched gap between en/clean and en/music. *Cost*: design work in
   `fa_timing`, e.g. bound the window by the neighbouring anchors' spacing when Chirp has nothing
   to say. Cheap to try, no API spend.

6. **Do not chase the orthography or the star token for English.** Both were measured and both are
   dead ends for this failure: CMUdict respelling changed the English times by 0.0 ms, and stars
   changed the oracle-window English result by 0.0 points. Recording this so the next person does
   not spend the day on it.

## 11. What was not checked

* **No English source video exists on the box**, so nothing here is a measurement on real English
  film dialogue. The English dub measurement in section 8 is TTS speech with an ASR-derived
  transcript and its Telugu control failed, so it corroborates only weakly.
* The mechanism in 5d was established on 8 English lines with a per-word dump and an independent
  ASR cross-check. It was **not** verified by listening, and no attempt was made to confirm the
  pause lengths phonetically.
* Fix 1 was measured as a post-hoc snap applied to the oracle-window starts, **not** as a patch to
  `chirp_wire._snap_onsets` (this task is read-only on `/app/backend`). The +12.5 points is
  therefore the size of the available gain, not a verified pipeline result, and part of it may
  already be captured by the existing snap on lines where no pause intervenes.
* Fix 3's cascade numbers were produced by monkey-patching `aligner.align_window` **in process**;
  no file was written. The drift guard fired differently in some of those runs (te/clean
  `cascade_star` reverted 12 lines, hi/clean 10), so those two cells mix two effects.
* Only en, hi and te were run through the forced-alignment arms. ta, ml, kn, gu have the chirp
  arms, the ground-truth verification and the register/trim audits only.
* The music variant was scored, but the ground truth is defined on the clean audio, so under music
  the "true" onset is the clean onset by construction.
* No recogniser call was made. Everything came from `/root/bench/cache`. Local models used:
  MMS_FA (already on the box) and faster-whisper tiny/small plus NLTK's CMUdict, all downloaded
  from public model hosts at no per-call cost.

## 12. Artefacts

On the box, all under `/tmp/_en_diag/` (JSON) with the run logs in `/tmp/_en_{diag,r2,r2b,r3,r4,r5,r6,r7,r8,r9,r10,r11}.log`:

| file | what |
|---|---|
| `stage1_onsets.json` | independent onset check on the assembled timeline, 7 langs x 2 variants, 9 parameter settings |
| `stage2_mapping.json` | per-line mapping records: hits, purity, lead-missed, span IoU, errors |
| `stage3_fa.json` | per-line errors for `fa`, `fa_then_chirp`, oracle and wide windows |
| `stage4_armc.json` | whole-file alignment, correct split and the `retime_segments` buggy split |
| `stage5_register.json`, `stage5_corr.json` | register table and rank correlations |
| `stage6_shapes.json`, `r3_buckets.json` | full error distributions and the bucketed histograms |
| `stage7_gtcheck.json` | source-clip cross-correlation and independent clip onsets |
| `stage8a_rescore.json`, `r7_rescore.json` | every arm re-scored against the independent onset and against the ASR's first word |
| `r3_bounds.json`, `r8_span.json` | start/end errors, word durations, span ratio, speech energy left outside |
| `r4_fixes.json` | star-token and CMUdict-respelling arms, including the shipped cascade |
| `r5_gender.json`, `r5_snap.json`, `r3_tail.json` | gender split, the onset-snap fix, tail-vs-core features |
| `r6_dub.json` | the English dub measurement and the failed Telugu control |
| `r7_asr.json`, `r10_gap.json` | local ASR word times against MMS's, and the level traces |
| `r9_density.json`, `r9_padsweep.json` | token density per language and the pad sweep |
| `r11_trim_audit.json` | the corpus trim audit that found en lines 9, 16 and 34 |

All 26 JSON files are copied back here as `research/english_timing_diagnosis_data.tgz`
(118 KB, the whole of `/tmp/_en_diag`).

Snapshot used for every measurement: `/tmp/_en_snap/services/{aligner,fa_timing,chirp_timing}.py`
(24677 / 18361 / 21213 bytes). Harness scripts on the box: `/tmp/_en_{diag,r2,r2b,r3,...,r11}.py`;
local copies of the drivers are `_en1_snap.sh` ... `_en33_const.sh` in the workspace root, and the
three snapshot modules were pulled to `_en_src/` for reading.
