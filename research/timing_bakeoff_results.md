# Dialogue-start timing bake-off, measured against a constructed ground truth

Run 20 Aug on the T4 box, inside the `omnivoice` container. Nothing under `/app/backend` was modified; the pipeline's own `services.chirp_timing` and `services.aligner` were imported read-only.

**Headline: no arm reaches 90% on any of the seven languages.** The best arm is C, MMS forced alignment of the known transcript against the audio with no timing hint at all, at 72.5-82.5% on the music variant for six languages and 50.0% for English. The arm the pipeline ships today (D, chirp_2 + MMS re-anchor) lands between 39% and 63%.

## 1. The corpus

Built from FLEURS (`google/fleurs`, test split) per language: `data/<cfg>/test.tsv` plus `data/<cfg>/audio/test.tar.gz`, matched on the wav filename. Clips are taken in filename order (deterministic), resampled to 16 kHz mono, end-trimmed, and kept only if they run 1.5-12.0 s. 40 clips per language.

Gaps between lines are drawn with a **fixed seed of 20250820**, freshly seeded per language, so every arm sees an identical timeline: 80% of gaps uniform in 0.3-1.2 s, 20% uniform in 1.5-3.0 s to mimic scene pauses. The same 39 gaps therefore appear in every language (median 0.92 s, 6 long gaps). A 0.5 s lead-in opens each file.

| Language | FLEURS cfg | lines | total s | speech s | median line s | words | music SNR dB (design) | music SNR dB (in speech) | clips skipped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | te_in | 40 | 366.6 | 303.8 | 7.26 | 539 | 12.2 | 12.2 | 15 |
| Hindi | hi_in | 40 | 358.7 | 287.7 | 7.28 | 810 | 12.2 | 11.8 | 24 |
| English | en_us | 40 | 334.4 | 272.2 | 6.87 | 843 | 12.2 | 12.7 | 19 |
| Tamil | ta_in | 40 | 387.4 | 313.1 | 7.62 | 543 | 12.2 | 12.2 | 32 |
| Malayalam | ml_in | 40 | 430.7 | 325.6 | 8.70 | 457 | 12.2 | 13.4 | 76 |
| Kannada | kn_in | 40 | 409.1 | 328.1 | 8.63 | 471 | 12.2 | 11.7 | 42 |
| Gujarati | gu_in | 40 | 382.1 | 306.7 | 7.58 | 738 | 12.2 | 12.9 | 13 |

Two variants per language, same timeline in both:

* `<lang>_gt.wav` - clean concatenation.
* `<lang>_gt_music.wav` - the same audio with a continuous music bed mixed in, taken from the `no_vocals` stem of job `dq1g7fxj` (`/root/.omnivoice/dub_jobs/dq1g7fxj/no_vocals.wav`), tiled to length. The bed is scaled so speech-region RMS sits 12.2 dB above full-length music RMS; because the bed is not stationary the SNR measured inside the speech regions lands where the table says. Gap-region level rises from about -70 dBFS to about -39 dBFS, so the bed is genuinely present between lines, which is what makes onset detection hard.

### 1a. What `true_start` means, and how much it can be trusted

This is the part that decides whether the whole exercise means anything, and the first definition was wrong. Taking the first 10 ms frame within 35 dB of the clip's peak put `true_start` on the breath before the sentence and on room tone: nudging that threshold moved 23 of 40 Kannada clips by more than 100 ms, and every arm consequently looked 500-760 ms late. Malayalam and Kannada were the worst affected.

The definition actually used is: **the first 10 ms frame whose 300-3400 Hz RMS exceeds max(P95 of the clip's own in-band frames - 20 dB, noise floor + 8 dB) and stays above it for 50 ms.** Band-limiting excludes breath, a percentile level stops one plosive raising the bar, and the 50 ms hold rejects clicks. The wavs were not rebuilt when this changed - only the recorded onset moved - so no recogniser output had to be re-fetched.

| Language | onset spread, median ms | onset spread, p90 ms | still ambiguous (>60 ms) | moved vs v1, median ms | moved vs v1, p90 ms |
| --- | --- | --- | --- | --- | --- |
| Telugu | 40 | 223 | 14 / 40 | +65 | +312 |
| Hindi | 10 | 228 | 10 / 40 | +255 | +650 |
| English | 10 | 161 | 6 / 40 | +0 | +967 |
| Tamil | 20 | 111 | 12 / 40 | +55 | +673 |
| Malayalam | 10 | 272 | 15 / 40 | +690 | +1127 |
| Kannada | 10 | 376 | 11 / 40 | +485 | +1218 |
| Gujarati | 20 | 120 | 8 / 40 | +355 | +753 |

`onset spread` is the range of the onset across nine parameter settings (level 15/20/25 dB below P95 x hold 30/50/80 ms). The median clip is stable to 10-40 ms, which is finer than the tolerance being measured. But 6-15 clips per language still move more than 60 ms, so every table below is also reported over the unambiguous subset in section 5. **Residual ground-truth uncertainty is of the same order as the -40 ms edge of the tolerance window, and that is a hard floor on how high any arm can score here.**

## 2. The arms

| Arm | What it is |
| --- | --- |
| A | `chirp_2` word timings, grouped into lines by matching the known transcripts to the word stream with the pipeline's own `chirp_timing.retime_by_words` (difflib, MIN_MATCH_RATIO 0.34, MIN_MATCH_WORDS 2). |
| B | `chirp_3` word timings, same grouping. |
| C | MMS forced alignment alone (`torchaudio` MMS_FA via `services.aligner`), the known transcript against the whole file. Emissions computed in 30 s chunks and stitched, one `forced_align` over the lot. No timing hint of any kind. |
| D | A then the MMS re-anchor pass - `aligner.retime_segments` + `resolve_timeline_v2`. This is what the pipeline ships today. |
| E | B then the same MMS re-anchor. |
| F | Whichever of B/E scores better, then a VAD onset snap: band-limited energy onset inside an asymmetric guard - may pull a start at most 40 ms earlier, push it at most 250 ms later, and is refused outright if it would cross the previous line's end. |
| G | `chirp_3` for word identity, and per line the timing the two models agree on within 100 ms (averaged); where they disagree, the one closer to the start interpolated from the agreed anchors either side. |
| H | *Extra, not requested, no API cost.* B, but when the matcher failed to find a line's leading words the start is extrapolated back over them at that line's own word rate (capped at 2 s, never past the previous line's end). |
| I | *Extra.* H then the arm-F snap. |

Line ORDER is given to every arm (the script order of a dialogue list is known); line TIMES never are. Arms A/B/D/E/G/H/I are handed `start = line index` purely so the pipeline functions see a monotonic sequence.

Ordering note on D and E: a line whose words `retime_by_words` cannot find gets no prediction at all here, because there is no upstream transcriber timeline to fall back to. That is why `matched` for A/B/D/E/G/H/I is the chirp match rate, while C is always 100%.

## 3. well_placed_asym, per language per arm

`well_placed_asym` = share of predicted starts with an error in **-40 ms to +120 ms** (audio early is perceptually worse than late - ITU-R BT.1359, EBU R37). The bracket is `matched`, the share of the 40 ground-truth lines the arm produced any line for at all. **Treat any cell whose bracket is under 95 as failing regardless of its percentage.**

### 3a. Clean

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | 5.4 [92] | 52.5 [100] | 77.5 [100] | 54.1 [92] | 62.5 [100] | 40.0 [100] | 25.0 [100] | 52.5 [100] | 27.5 [100] |
| Hindi | 7.7 [98] | 42.5 [100] | 80.0 [100] | 61.5 [98] | 65.0 [100] | 57.5 [100] | 27.5 [100] | 45.0 [100] | 37.5 [100] |
| English | 37.1 [88] | 51.3 [98] | 55.0 [100] | 45.7 [88] | 46.2 [98] | 53.8 [98] | 38.5 [98] | 48.7 [98] | 51.3 [98] |
| Tamil | 8.6 [88] | 60.0 [100] | 80.0 [100] | 45.7 [88] | 57.5 [100] | 47.5 [100] | 42.5 [100] | 62.5 [100] | 50.0 [100] |
| Malayalam | 7.9 [95] | 38.5 [98] | 82.5 [100] | 68.4 [95] | 71.8 [98] | 71.8 [98] | 30.8 [98] | 38.5 [98] | 38.5 [98] |
| Kannada | 2.7 [92] | 35.0 [100] | 82.5 [100] | 45.9 [92] | 57.5 [100] | 57.5 [100] | 20.0 [100] | 37.5 [100] | 45.0 [100] |
| Gujarati | 2.7 [92] | 47.5 [100] | 77.5 [100] | 32.4 [92] | 42.5 [100] | 37.5 [100] | 32.5 [100] | 52.5 [100] | 50.0 [100] |

### 3b. Music (the honest one)

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | 3.0 [82] | 62.5 [100] | 72.5 [100] | 45.5 [82] | 62.5 [100] | 47.5 [100] | 32.5 [100] | 62.5 [100] | 35.0 [100] |
| Hindi | 2.6 [98] | 56.4 [98] | 72.5 [100] | 53.8 [98] | 61.5 [98] | 53.8 [98] | 12.8 [98] | 59.0 [98] | 56.4 [98] |
| English | 31.0 [72] | 42.9 [70] | 50.0 [100] | 44.8 [72] | 46.4 [70] | 42.9 [70] | 39.3 [70] | 42.9 [70] | 32.1 [70] |
| Tamil | 14.3 [88] | 55.0 [100] | 80.0 [100] | 45.7 [88] | 52.5 [100] | 45.0 [100] | 37.5 [100] | 55.0 [100] | 45.0 [100] |
| Malayalam | 10.5 [95] | 51.3 [98] | 82.5 [100] | 68.4 [95] | 66.7 [98] | 69.2 [98] | 43.6 [98] | 51.3 [98] | 53.8 [98] |
| Kannada | 0.0 [70] | 31.2 [80] | 75.0 [100] | 35.7 [70] | 40.6 [80] | 40.6 [80] | 28.1 [80] | 31.2 [80] | 37.5 [80] |
| Gujarati | 0.0 [98] | 40.0 [100] | 80.0 [100] | 38.5 [98] | 40.0 [100] | 37.5 [100] | 17.5 [100] | 45.0 [100] | 45.0 [100] |

Same cells, symmetric +/-100 ms, for comparability with published numbers:

**clean**

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | 21.6 [92] | 70.0 [100] | 90.0 [100] | 67.6 [92] | 70.0 [100] | 70.0 [100] | 55.0 [100] | 72.5 [100] | 67.5 [100] |
| Hindi | 46.2 [98] | 70.0 [100] | 87.5 [100] | 76.9 [98] | 77.5 [100] | 82.5 [100] | 57.5 [100] | 70.0 [100] | 70.0 [100] |
| English | 62.9 [88] | 66.7 [98] | 67.5 [100] | 51.4 [88] | 48.7 [98] | 66.7 [98] | 64.1 [98] | 64.1 [98] | 64.1 [98] |
| Tamil | 20.0 [88] | 65.0 [100] | 85.0 [100] | 42.9 [88] | 57.5 [100] | 62.5 [100] | 50.0 [100] | 67.5 [100] | 70.0 [100] |
| Malayalam | 18.4 [95] | 61.5 [98] | 95.0 [100] | 81.6 [95] | 87.2 [98] | 82.1 [98] | 43.6 [98] | 61.5 [98] | 64.1 [98] |
| Kannada | 24.3 [92] | 50.0 [100] | 95.0 [100] | 56.8 [92] | 70.0 [100] | 65.0 [100] | 37.5 [100] | 52.5 [100] | 55.0 [100] |
| Gujarati | 18.9 [92] | 57.5 [100] | 87.5 [100] | 40.5 [92] | 55.0 [100] | 57.5 [100] | 45.0 [100] | 62.5 [100] | 67.5 [100] |

**music**

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | 15.2 [82] | 72.5 [100] | 90.0 [100] | 63.6 [82] | 70.0 [100] | 70.0 [100] | 52.5 [100] | 72.5 [100] | 70.0 [100] |
| Hindi | 41.0 [98] | 79.5 [98] | 87.5 [100] | 69.2 [98] | 74.4 [98] | 76.9 [98] | 51.3 [98] | 82.1 [98] | 84.6 [98] |
| English | 51.7 [72] | 64.3 [70] | 55.0 [100] | 58.6 [72] | 57.1 [70] | 57.1 [70] | 60.7 [70] | 64.3 [70] | 64.3 [70] |
| Tamil | 28.6 [88] | 60.0 [100] | 85.0 [100] | 45.7 [88] | 55.0 [100] | 60.0 [100] | 52.5 [100] | 62.5 [100] | 60.0 [100] |
| Malayalam | 18.4 [95] | 66.7 [98] | 95.0 [100] | 81.6 [95] | 87.2 [98] | 82.1 [98] | 59.0 [98] | 66.7 [98] | 66.7 [98] |
| Kannada | 10.7 [70] | 53.1 [80] | 85.0 [100] | 50.0 [70] | 56.2 [80] | 53.1 [80] | 50.0 [80] | 53.1 [80] | 46.9 [80] |
| Gujarati | 20.5 [98] | 55.0 [100] | 87.5 [100] | 46.2 [98] | 50.0 [100] | 50.0 [100] | 45.0 [100] | 60.0 [100] | 62.5 [100] |

## 4. Signed start error, median and p95

Median and p95 of the SIGNED error in ms, never the mean - forced alignment is monotonic so a handful of runaway lines would dominate a mean. Positive is late. p05 is included because on this metric the early tail is what fails.

**clean** - median / p05 / p95 (ms)

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | -128.9 / -4165.2 / 1092.6 | -21.8 / -1114.1 / 642.3 | 3.2 / -69.7 / 163.2 | 3.1 / -1053.0 / 846.6 | 8.0 / -50.8 / 919.4 | -22.1 / -79.3 / 934.0 | -46.9 / -1084.7 / 949.7 | -31.5 / -1114.1 / 288.6 | -56.6 / -1116.1 / 250.6 |
| Hindi | -73.2 / -1149.4 / 607.7 | -34.4 / -2218.0 / 639.3 | -2.5 / -104.0 / 85.3 | 1.8 / -87.6 / 468.3 | 4.6 / -56.9 / 601.2 | -10.0 / -86.6 / 601.2 | -51.5 / -841.3 / 620.3 | -36.7 / -2218.0 / 153.5 | -53.1 / -2218.0 / 113.5 |
| English | -28.2 / -206.2 / 895.4 | -18.9 / -892.0 / 587.1 | 7.4 / -148.9 / 710.0 | 24.9 / -806.6 / 1005.0 | 27.9 / -125.6 / 1016.5 | -15.3 / -892.0 / 619.6 | -15.3 / -378.6 / 679.3 | -20.0 / -892.0 / 576.5 | -17.9 / -892.0 / 619.6 |
| Tamil | -62.6 / -3098.4 / 2428.8 | -1.3 / -1643.4 / 1547.6 | 20.1 / -42.7 / 217.2 | 53.8 / -161.3 / 1400.2 | 30.7 / -41.5 / 1039.3 | -17.6 / -1645.4 / 1508.6 | -14.8 / -2430.7 / 1546.6 | -13.9 / -1643.4 / 58.0 | -34.8 / -1645.4 / 35.5 |
| Malayalam | -134.1 / -1687.6 / 1449.2 | -29.0 / -1487.2 / 920.9 | 4.6 / -70.1 / 97.3 | 10.0 / -108.9 / 1117.9 | 7.6 / -76.8 / 886.1 | -8.0 / -109.7 / 886.1 | -48.7 / -1578.4 / 1050.6 | -50.3 / -1487.2 / -1.3 | -48.7 / -1487.2 / -2.0 |
| Kannada | -90.0 / -2435.6 / 2782.1 | -16.3 / -1442.8 / 1061.6 | 4.1 / -53.8 / 76.3 | 19.2 / -319.1 / 2551.0 | 33.3 / -62.1 / 1366.3 | -1.1 / -102.1 / 1406.6 | -33.2 / -961.0 / 1073.3 | -55.2 / -1442.8 / 258.6 | -25.5 / -1442.8 / 222.6 |
| Gujarati | -87.0 / -1709.3 / 1827.8 | -11.3 / -1505.5 / 1392.4 | 5.0 / -73.5 / 738.7 | 201.2 / -84.7 / 1606.5 | 71.9 / -50.3 / 1638.0 | -23.7 / -1543.5 / 1352.4 | -34.9 / -1486.5 / 2262.4 | -21.1 / -1505.5 / 730.2 | -30.3 / -1543.5 / 728.2 |

**music** - median / p05 / p95 (ms)

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | -150.5 / -4306.9 / 732.2 | -15.7 / -886.7 / 1929.8 | 3.2 / -69.7 / 163.2 | -0.8 / -2685.8 / 852.2 | 8.0 / -73.1 / 846.7 | -19.3 / -81.8 / 872.0 | -29.3 / -992.5 / 1782.0 | -18.7 / -886.7 / 1123.8 | -42.3 / -765.2 / 1183.8 |
| Hindi | -89.8 / -1380.8 / 545.9 | -19.0 / -612.1 / 410.6 | -2.2 / -173.6 / 117.3 | 1.3 / -197.3 / 592.0 | -2.2 / -200.7 / 412.6 | -10.1 / -153.4 / 388.6 | -57.1 / -1907.5 / 401.2 | -22.7 / -612.1 / 112.9 | -23.2 / -606.1 / 72.9 |
| English | 4.7 / -184.8 / 1959.9 | -25.5 / -792.3 / 632.6 | 8.5 / -2700.7 / 710.0 | 25.7 / -130.9 / 1216.3 | 4.7 / -147.1 / 1084.2 | -3.8 / -147.1 / 1084.2 | -24.6 / -799.3 / 802.9 | -25.5 / -792.3 / 632.6 | -27.1 / -792.3 / 635.1 |
| Tamil | -102.4 / -1687.4 / 1484.5 | 3.2 / -525.8 / 1341.9 | 20.1 / -42.7 / 217.2 | 23.5 / -893.1 / 1186.0 | 37.0 / -56.3 / 1036.3 | -2.7 / -480.7 / 1301.9 | -5.2 / -514.0 / 1564.6 | -18.1 / -856.7 / 280.6 | -26.8 / -732.1 / 246.7 |
| Malayalam | -124.7 / -1486.3 / 1466.2 | -22.6 / -1311.8 / 990.5 | 8.0 / -69.3 / 97.3 | 10.1 / -79.4 / 1100.9 | 12.1 / -69.5 / 886.1 | -4.2 / -85.8 / 886.1 | -30.5 / -1235.3 / 1032.6 | -37.9 / -1311.8 / 7.1 | -33.2 / -1276.6 / 0.5 |
| Kannada | -105.7 / -4634.9 / 2368.4 | -23.2 / -1238.6 / 2419.1 | 20.4 / -61.3 / 904.9 | 54.6 / -3288.3 / 1951.0 | 52.3 / -91.1 / 2564.0 | 13.2 / -128.5 / 2524.0 | -23.2 / -1229.6 / 2738.5 | -55.2 / -1238.6 / 1112.6 | -29.8 / -1170.1 / 1112.6 |
| Gujarati | -89.8 / -833.2 / 1847.7 | -11.7 / -866.6 / 1387.7 | 5.0 / -73.5 / 738.7 | 253.0 / -45.4 / 1709.4 | 73.4 / -53.7 / 1625.0 | 33.4 / -93.7 / 1625.0 | -52.2 / -846.6 / 1388.7 | -22.9 / -866.6 / 509.1 | -23.9 / -809.6 / 473.1 |

### 4a. Which side do the failures fall on

For the two arms worth arguing about, the share of predictions more than 40 ms early and more than 120 ms late, music variant:

| Language | C early <-40ms % | C late >120ms % | C within +/-200ms % | A early <-40ms % | B early <-40ms % |
| --- | --- | --- | --- | --- | --- |
| Telugu | 20.0 | 7.5 | 95.0 | 78.8 | 22.5 |
| Hindi | 22.5 | 5.0 | 90.0 | 82.1 | 33.3 |
| English | 22.5 | 27.5 | 60.0 | 34.5 | 35.7 |
| Tamil | 7.5 | 12.5 | 92.5 | 65.7 | 15.0 |
| Malayalam | 12.5 | 5.0 | 97.5 | 65.8 | 33.3 |
| Kannada | 15.0 | 10.0 | 87.5 | 60.7 | 43.8 |
| Gujarati | 12.5 | 7.5 | 87.5 | 66.7 | 32.5 |

Arm C's misses are split roughly two-to-one early over late, and 87-97% of its starts sit within +/-200 ms for every language except English. Arm A's problem is different and much worse: 60-82% of chirp_2's starts are more than 40 ms EARLY, with a median of -90 to -150 ms. chirp_2 reports word onsets systematically ahead of the audio, and the asymmetric window punishes exactly that.

## 5. Two sanity checks on the metric

### 5a. Only the clips whose onset is unambiguous

Dropping the clips whose onset moved more than 60 ms under parameter perturbation. Music variant; `n` is how many lines survive per language.

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | 4.5 [22] | 61.5 [26] | 65.4 [26] | 40.9 [22] | 57.7 [26] | 46.2 [26] | 30.8 [26] | 61.5 [26] | 46.2 [26] |
| Hindi | 3.4 [29] | 58.6 [29] | 70.0 [30] | 48.3 [29] | 58.6 [29] | 51.7 [29] | 10.3 [29] | 62.1 [29] | 58.6 [29] |
| English | 32.0 [25] | 44.0 [25] | 52.9 [34] | 44.0 [25] | 48.0 [25] | 44.0 [25] | 40.0 [25] | 44.0 [25] | 36.0 [25] |
| Tamil | 8.7 [23] | 50.0 [28] | 78.6 [28] | 47.8 [23] | 53.6 [28] | 46.4 [28] | 28.6 [28] | 50.0 [28] | 46.4 [28] |
| Malayalam | 12.5 [24] | 60.0 [25] | 84.0 [25] | 62.5 [24] | 64.0 [25] | 68.0 [25] | 48.0 [25] | 60.0 [25] | 64.0 [25] |
| Kannada | 0.0 [19] | 34.8 [23] | 75.9 [29] | 31.6 [19] | 34.8 [23] | 34.8 [23] | 30.4 [23] | 34.8 [23] | 34.8 [23] |
| Gujarati | 0.0 [32] | 40.6 [32] | 78.1 [32] | 40.6 [32] | 43.8 [32] | 43.8 [32] | 18.8 [32] | 43.8 [32] | 40.6 [32] |

The ranking does not change and arm C does not reach 90% even here (65-84%). So the gap to 90% is not simply fuzzy ground truth.

### 5b. After a leave-one-language-out constant offset

Each arm has a systematic bias. Subtracting a per-arm constant calibrated on the OTHER six languages - never on the language being scored, so this is not fitted to its own answer - gives the following. Music variant.

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | 24.2 | 65.0 | 67.5 | 36.4 | 45.0 | 52.5 | 45.0 | 70.0 | 65.0 |
| Hindi | 59.0 | 76.9 | 70.0 | 43.6 | 48.7 | 56.4 | 41.0 | 76.9 | 71.8 |
| English | 41.4 | 53.6 | 45.0 | 41.4 | 32.1 | 42.9 | 57.1 | 60.7 | 53.6 |
| Tamil | 34.3 | 57.5 | 80.0 | 40.0 | 52.5 | 45.0 | 47.5 | 57.5 | 55.0 |
| Malayalam | 26.3 | 61.5 | 77.5 | 55.3 | 59.0 | 71.8 | 53.8 | 64.1 | 64.1 |
| Kannada | 10.7 | 37.5 | 75.0 | 32.1 | 37.5 | 43.8 | 43.8 | 40.6 | 46.9 |
| Gujarati | 28.2 | 52.5 | 72.5 | 35.9 | 40.0 | 37.5 | 35.0 | 57.5 | 57.5 |

The held-out offsets themselves (ms, music): A chirp_2 -96, B chirp_3 -21, C MMS FA +8, D c2+MMS +25, E c3+MMS +25, F snap(B/E) -3, G c3+c2 -28, H c3+backoff -24, I H+snap -27.

Calibration is worth 20-45 points to chirp_2 and nothing to arm C, which is already unbiased (+8 ms). Still nothing crosses 90%.

## 6. Coverage of true speech

`covered` = share of true speech duration overlapped by predicted lines, music variant.

| Language | A chirp_2 | B chirp_3 | C MMS FA | D c2+MMS | E c3+MMS | F snap(B/E) | G c3+c2 | H c3+backoff | I H+snap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telugu | 79.4 | 95.5 | 98.8 | 84.1 | 98.5 | 98.6 | 95.0 | 97.0 | 97.0 |
| Hindi | 91.7 | 92.9 | 98.7 | 94.5 | 94.8 | 94.9 | 95.6 | 93.4 | 93.4 |
| English | 70.8 | 68.4 | 91.6 | 74.1 | 74.9 | 74.8 | 68.0 | 68.4 | 68.3 |
| Tamil | 86.1 | 92.2 | 99.0 | 97.1 | 98.6 | 92.1 | 91.8 | 95.3 | 95.3 |
| Malayalam | 90.2 | 95.6 | 98.4 | 94.6 | 96.2 | 96.3 | 95.6 | 97.4 | 97.4 |
| Kannada | 55.7 | 71.2 | 98.1 | 65.7 | 73.1 | 73.2 | 70.5 | 73.7 | 73.7 |
| Gujarati | 93.0 | 95.5 | 98.1 | 94.0 | 97.7 | 97.9 | 96.1 | 98.1 | 98.2 |

## 7. Verdict

### Arms crossing 90%

**None. Not one arm, on one language, on either variant.**

### Best arm per language, counting only arms with matched >= 95%

| Language | music (best, matched>=95) | clean (best, matched>=95) |
| --- | --- | --- |
| Telugu | C MMS FA - 72.5% | C MMS FA - 77.5% |
| Hindi | C MMS FA - 72.5% | C MMS FA - 80.0% |
| English | C MMS FA - 50.0% | C MMS FA - 55.0% |
| Tamil | C MMS FA - 80.0% | C MMS FA - 80.0% |
| Malayalam | C MMS FA - 82.5% | C MMS FA - 82.5% |
| Kannada | C MMS FA - 75.0% | C MMS FA - 82.5% |
| Gujarati | C MMS FA - 80.0% | C MMS FA - 77.5% |

Arm C wins every language on both variants. Languages that do NOT reach 90% with any arm: **all seven** - Telugu, Hindi, English, Tamil, Malayalam, Kannada, Gujarati.

On the looser symmetric +/-200 ms band arm C does clear 87-97% for six languages (English 60%), so the shortfall is about tens of milliseconds of precision, not about lines landing in the wrong place.

### What the ranking says

1. **chirp_2 is the wrong timing source for a start-critical metric.** Its word onsets run 90-150 ms early with a long early tail (p05 down to -4.3 s), so arm A scores 0-31% and arm D, which the pipeline ships, inherits it. chirp_3 is materially better on timing (median -12 to -25 ms) and matches more lines under music.
2. **The MMS re-anchor helps chirp_2 a lot and chirp_3 little.** D beats A by 30-45 points; E beats B by 0-15. The re-anchor is repairing chirp_2's bias, not adding precision.
3. **Forced alignment with no timing hint beats every hinted combination.** Arm C wins everywhere, is essentially unbiased, and is the only arm that never drops a line. Handing an aligner a window derived from a recogniser that is itself 100 ms out makes things worse, not better.
4. **The VAD snap does not earn its place.** Arm F moves the median toward zero but gains at most a few points and loses points on four languages; onsets under a music bed are not reliable enough to snap to.
5. **Merging the two chirp models (G) is worse than chirp_3 alone** on every language. Agreement between two recognisers that share a bias is not evidence.
6. **Recovering missed leading words (H/I) fixes the late tail but not the score.** H cuts arm B's p95 hard - Malayalam from 1246 ms to 7 ms, Gujarati from 1388 to 509 - and then converts those lines into slightly-early ones instead, which the asymmetric window also rejects.

## 8. Caveats - read these before quoting any number

* **FLEURS is read speech: one speaker per clip, prompted, studio-quiet, no overlap, no emotion, no shouting, no laughter, no crosstalk, and every sentence begins cleanly after a pause. These numbers are an UPPER BOUND on what the same arms will do on real film audio.** Real dialogue has overlapping speakers, off-mic lines, sung and shouted delivery and reverberation, all of which move onsets and break word matching. Do not read 82% here as 82% on a movie.
* The timeline is synthetic. Lines are concatenated independent utterances, so there is no coarticulation across a cut and no speaker turn-taking behaviour. A real scene's onsets are harder.
* The music variant uses ONE bed from ONE job, tiled. It is a genuine mixed-music condition but not a sample of film beds, and it contains no sound effects, no crowd, no room tone change at cuts.
* 40 lines per language per variant. A one-line change is 2.5 percentage points, so differences under about 8 points between two arms on one language are inside the noise. The cross-language pattern is the reliable part, not any single cell.
* Residual ground-truth onset uncertainty is 10-40 ms at the median and 111-376 ms at p90 (section 1a). The -40 ms edge of the asymmetric window is inside that band for the ambiguous clips, so the absolute level of `well_placed_asym` carries maybe +/-5 points of definition, even though the ordering of the arms does not.
* English scores worst for arm C on both variants (55.0 / 50.0) and it is not a ground-truth artefact - English has the FEWEST ambiguous onsets of the seven (6 of 40). One en_us line is misaligned by 2.7 s, which alone costs 2.5 points. FLEURS' 'normalised' transcript column was tried in place of the raw one on the theory that digits, which MMS_FA's letters-only dictionary discards, were breaking English lines: it changed English scores by exactly nothing (the normalised column keeps digits at the same 18.9% of rows) and cost Hindi 40 points of chirp_3 match rate under music, so the raw column is what is reported.
* Chirp's synchronous endpoint caps at about 60 s, so audio was cut into <=55 s pieces on the quietest 20 ms nearby using the pipeline's own `_silence_cuts`, and word times were offset by each piece's start. Boundary effects are therefore possible at 7-8 places per file per arm.
* Arm C's stitched-emission alignment was checked against per-clip alignment on six Telugu lines and agreed within 30 ms, so the chunking is not inventing the result.
* Arms D and E use the shipped `retime_segments` + `resolve_timeline_v2` with their shipped constants, but with no upstream transcriber timeline to fall back on. In production a line chirp cannot match keeps the transcriber's own timestamp; here it gets nothing. D and E would look better on `matched` in production and no better on placement.

## 9. Coverage - what was actually spent

* Recognition requests: **210** (28 cache entries x 7-8 chunks each), all synchronous `v2 recognizers/_:recognize`.
* Audio sent: **177.9 minutes** (7 languages x 2 variants x 2 models, 89.0 min of distinct audio).
* Failed chunks: **0**. Every request returned words.
* Estimated cost at $0.016/min: **$2.85**.
* Arms C-I cost nothing: C/D/E/F run on the local T4, and G/H/I re-use the cached word streams. Every raw response is cached under `/root/bench/cache/<lang>_<variant>_<model>.json`, so re-scoring is free.

| cache key | calls | audio s | chunks | words returned | failed chunks |
| --- | --- | --- | --- | --- | --- |
| en_clean_chirp_2 | 7 | 334.4 | 7 | 681 | 0 |
| en_clean_chirp_3 | 7 | 334.4 | 7 | 760 | 0 |
| en_music_chirp_2 | 7 | 334.4 | 7 | 562 | 0 |
| en_music_chirp_3 | 7 | 334.4 | 7 | 541 | 0 |
| gu_clean_chirp_2 | 8 | 382.1 | 8 | 851 | 0 |
| gu_clean_chirp_3 | 8 | 382.1 | 8 | 752 | 0 |
| gu_music_chirp_2 | 7 | 382.1 | 7 | 813 | 0 |
| gu_music_chirp_3 | 7 | 382.1 | 7 | 757 | 0 |
| hi_clean_chirp_2 | 7 | 358.7 | 7 | 803 | 0 |
| hi_clean_chirp_3 | 7 | 358.7 | 7 | 808 | 0 |
| hi_music_chirp_2 | 7 | 358.7 | 7 | 787 | 0 |
| hi_music_chirp_3 | 7 | 358.7 | 7 | 805 | 0 |
| kn_clean_chirp_2 | 8 | 409.1 | 8 | 495 | 0 |
| kn_clean_chirp_3 | 8 | 409.1 | 8 | 488 | 0 |
| kn_music_chirp_2 | 8 | 409.1 | 8 | 356 | 0 |
| kn_music_chirp_3 | 8 | 409.1 | 8 | 369 | 0 |
| ml_clean_chirp_2 | 8 | 430.7 | 8 | 461 | 0 |
| ml_clean_chirp_3 | 8 | 430.7 | 8 | 466 | 0 |
| ml_music_chirp_2 | 8 | 430.7 | 8 | 457 | 0 |
| ml_music_chirp_3 | 8 | 430.7 | 8 | 459 | 0 |
| ta_clean_chirp_2 | 8 | 387.4 | 8 | 502 | 0 |
| ta_clean_chirp_3 | 8 | 387.4 | 8 | 563 | 0 |
| ta_music_chirp_2 | 8 | 387.4 | 8 | 534 | 0 |
| ta_music_chirp_3 | 8 | 387.4 | 8 | 561 | 0 |
| te_clean_chirp_2 | 7 | 366.6 | 7 | 555 | 0 |
| te_clean_chirp_3 | 7 | 366.6 | 7 | 584 | 0 |
| te_music_chirp_2 | 7 | 366.6 | 7 | 565 | 0 |
| te_music_chirp_3 | 7 | 366.6 | 7 | 587 | 0 |

## 10. Where the artefacts live

On the box:

* `/root/bench/<lang>_gt.wav`, `<lang>_gt_music.wav` - the two variants.
* `/root/bench/<lang>_gt.json` - the line list: `true_start`, `true_end`, transcript, source wav, onset spread, ambiguity flag.
* `/root/bench/cache/<lang>_<variant>_<model>.json` - every raw recogniser response.
* `/root/bench/results/per_line_errors.json` - per-line signed errors for all 9 arms x 7 languages x 2 variants.
* `/root/bench/results/summary.json`, `gt_sensitivity.json`, `gt_v2_report.json`.

Copied back here: `research/timing_bakeoff_summary.json` (summary, corpus facts, ground-truth sensitivity, leave-one-out calibration, API coverage) and `research/timing_bakeoff_error_breakdown.json`.
