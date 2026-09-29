/**
 * Five decisions, each one shown rather than asserted.
 *
 * The table below this reads "Each line fitted to its original slot" and asks you
 * to take it on trust. That is the weakest kind of claim on a marketing page:
 * every dubbing tool says something similar, so the words carry no information. A
 * diagram that shows a dubbed line landing inside the same slot, with the timeline
 * markers not moving, is checkable at a glance.
 *
 * So this is an EXPLANATION animation, which is the one purpose the animate skill
 * allows a longer, looping treatment for — and only on marketing surfaces. It
 * cycles five scenes on one 25-second clock:
 *
 *    1  speaker voices        one source voice, reused on every line
 *    2  timing                dubbed audio fitted into the original slots
 *    3  translation quality   a long line caught and shortened to fit
 *    4  background audio      speech replaced, music left alone
 *    5  the delivered file    one track, tagged, set as default
 *
 * Same construction as DashboardDemo: every element shares `--dec-cycle` with the
 * beats written as percentages of it, so no element can drift from another. CSS
 * rather than JS because the motion is entirely predetermined, and CSS animations
 * run off the main thread — this keeps moving while the page is still painting.
 *
 * Only `transform` and `opacity` animate, plus a few colour changes, so nothing
 * here costs layout.
 *
 * With motion off, scene one is shown and the rest are hidden. There is no single
 * "finished" frame for a carousel, so the honest fallback is the first scene
 * complete rather than five scenes stacked on top of each other.
 */
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

/**
 * The five decisions, each with the claim it is making.
 *
 * These claims used to live in a five-row table underneath this component, which
 * meant the page said everything twice — once as a diagram and once as a list of
 * ticks. The claim belongs in the header of the thing that demonstrates it, where
 * you read the sentence and watch it happen at the same time.
 */
const SCENES = [
  { label: 'Speaker voices', claim: 'Cloned per line from your own audio' },
  { label: 'Timing', claim: 'Each line fitted to its original slot' },
  { label: 'Translation quality', claim: 'Reflected and length-aware' },
  { label: 'Background audio', claim: 'Music and effects preserved' },
  { label: 'The delivered file', claim: 'One track, dubbed, set as default' },
];

export function DecisionsDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setRunning(true);
      return;
    }
    // A 25-second infinite loop off-screen is pure waste; pause it until seen.
    const io = new IntersectionObserver(([e]) => setRunning(e.isIntersecting), {
      threshold: 0.3,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-running={running ? 'true' : 'false'}
      className="dec-stage relative overflow-hidden rounded-[var(--radius-card)] border-2 border-ink-600 bg-ink-900"
      // Decorative: every claim here is also written out in the table below.
      aria-hidden="true"
    >
      {/* Which decision is on screen, and what it claims. */}
      <div className="flex items-start justify-between gap-3 border-b border-ink-700 px-4 py-3">
        <div className="min-w-0 flex-1">
          {/*
            Absolutely stacked and cut with the scene clock. Fixed heights are
            required because absolutely positioned children contribute none — two
            lines' worth on a narrow screen, one on a wide one.
          */}
          <p className="relative h-4">
            {SCENES.map((s, i) => (
              <span
                key={s.label}
                className={clsx(
                  'absolute left-0 top-0 whitespace-nowrap text-tiny uppercase',
                  'tracking-[0.14em] text-fg-subtle',
                  `dec-label-${i + 1}`,
                )}
              >
                {s.label}
              </span>
            ))}
          </p>
          <p className="relative mt-1 h-10 sm:h-6">
            {SCENES.map((s, i) => (
              <span
                key={s.label}
                className={clsx(
                  'absolute left-0 top-0 text-small font-medium text-fg sm:text-body',
                  `dec-claim-${i + 1}`,
                )}
              >
                {s.claim}
              </span>
            ))}
          </p>
        </div>
        <span className="mt-1 flex shrink-0 gap-1">
          {SCENES.map((s, i) => (
            <span
              key={s.label}
              className={clsx('size-1.5 rounded-full bg-ink-600', `dec-dot-${i + 1}`)}
            />
          ))}
        </span>
      </div>

      <div className="relative h-[228px]">
        {/* ── 1. speaker voices ─────────────────────────────────────────────
            One voice sampled from the source, then reused on every line. The
            crossed-out stock dropdown is the thing being ruled out. */}
        <Scene n={1}>
          <div className="flex items-center gap-3">
            <div className="dec1-src flex shrink-0 items-center gap-2 rounded-lg border-2 border-good/50 bg-good/10 px-2.5 py-1.5">
              <span className="flex items-end gap-[2px]">
                {[7, 12, 9, 14, 6].map((h, i) => (
                  <span
                    key={i}
                    className={clsx('w-[3px] rounded-full bg-good', `dec1-bar-${(i % 3) + 1}`)}
                    style={{ height: h }}
                  />
                ))}
              </span>
              <span className="text-tiny font-medium text-good">your speaker</span>
            </div>
            <span className="dec1-arrow text-fg-subtle">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M4 12h14m0 0-5-5m5 5-5 5" />
              </svg>
            </span>
          </div>

          <div className="mt-4 space-y-1.5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-right text-[9px] tabular-nums text-fg-subtle">
                  line {i + 1}
                </span>
                <span
                  className={clsx(
                    'flex h-5 flex-1 items-center gap-1 rounded border-2 px-1.5',
                    `dec1-line-${i + 1}`,
                  )}
                >
                  <span className="flex items-end gap-[2px]">
                    {[5, 8, 6, 9].map((h, k) => (
                      <span key={k} className="w-[2px] rounded-full bg-current" style={{ height: h }} />
                    ))}
                  </span>
                  <span className="text-[9px]">same voice</span>
                </span>
              </div>
            ))}
          </div>

          <div className="dec1-stock relative mt-2.5 inline-flex items-center gap-1.5 rounded-full border-2 border-ink-600 px-2.5 py-1">
            <span className="text-[9px] text-fg-subtle">Stock voice ▾</span>
            <span className="dec1-strike absolute left-1 right-1 top-1/2 h-[2px] origin-left rounded bg-bad" />
          </div>

          <p className="mt-2 text-[9px] leading-relaxed text-fg-subtle">
            Your speaker's own voice is sampled and reused on every line — not a
            stock voice picked from a dropdown.
          </p>
        </Scene>

        {/* ── 2. timing ─────────────────────────────────────────────────────
            The slots are fixed. Dubbed audio grows to fit inside them, and the
            end marker never moves — which is what "never retimed" means. */}
        <Scene n={2}>
          <div className="flex items-center justify-between text-[9px] text-fg-subtle">
            <span>0:00</span>
            <span className="dec2-keep rounded-full border border-good/40 bg-good/10 px-2 py-px text-good">
              timeline unchanged
            </span>
            <span>1:26</span>
          </div>

          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-1 text-[9px] text-fg-subtle">original</p>
              <div className="flex h-6 gap-1.5">
                {[34, 26, 22].map((w, i) => (
                  <span
                    key={i}
                    style={{ flexGrow: w }}
                    className="rounded border-2 border-dashed border-ink-500 bg-ink-800"
                  />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[9px] text-fg-subtle">dubbed</p>
              <div className="flex h-6 gap-1.5">
                {[34, 26, 22].map((w, i) => (
                  <span
                    key={i}
                    style={{ flexGrow: w }}
                    className="relative rounded border-2 border-dashed border-ink-500"
                  >
                    <span
                      className={clsx(
                        'absolute inset-0 origin-left rounded-sm bg-[linear-gradient(90deg,var(--color-iris),var(--color-cyan))]',
                        `dec2-fit-${i + 1}`,
                      )}
                    />
                  </span>
                ))}
              </div>
            </div>
          </div>

          <p className="mt-3 text-[9px] leading-relaxed text-fg-subtle">
            Each line is fitted to the slot it came from, so the picture is never
            slowed down to wait for the audio.
          </p>
        </Scene>

        {/* ── 3. translation quality ────────────────────────────────────────
            The first pass runs long; a second pass catches it and shortens it to
            fit the slot rather than letting it spill into the next line. */}
        <Scene n={3}>
          <p className="text-[9px] text-fg-subtle">the slot this line has to fit</p>
          <div className="relative mt-2 h-7 rounded border-2 border-dashed border-ink-500">
            <span className="dec3-bar absolute inset-y-[3px] left-[3px] origin-left rounded-sm" />
            <span className="dec3-over absolute -right-1 -top-5 rounded-full border border-warn/50 bg-warn/15 px-1.5 py-px text-[8px] text-warn">
              1.4× too long
            </span>
          </div>

          <div className="mt-4 space-y-1.5">
            <span className="dec3-pass1 flex items-center gap-1.5 text-[9px] text-fg-subtle">
              <span className="size-1.5 rounded-full bg-warn" />
              first pass — translated
            </span>
            <span className="dec3-pass2 flex items-center gap-1.5 text-[9px]">
              <span className="size-1.5 rounded-full bg-good" />
              <span className="text-good">second pass — rewritten shorter, same meaning</span>
            </span>
          </div>

          <p className="mt-4 text-[9px] leading-relaxed text-fg-subtle">
            A line that will not fit is rewritten, not crammed in or cut off
            mid-sentence.
          </p>
        </Scene>

        {/* ── 4. background audio ───────────────────────────────────────────
            Two lanes. The speech lane is replaced; the music lane is the same
            bars throughout, which is the whole point. */}
        <Scene n={4}>
          <div className="space-y-3">
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[9px] text-fg-subtle">
                speech
                <span className="dec4-swap rounded-full border border-iris/50 bg-iris/15 px-1.5 py-px text-[8px] text-iris">
                  replaced
                </span>
              </p>
              <div className="relative h-7">
                <span className="dec4-old absolute inset-0 flex items-end gap-[3px]">
                  {[9, 15, 11, 18, 8, 14, 10, 16, 12, 7, 13, 17, 9, 11].map((h, i) => (
                    <span key={i} className="flex-1 rounded-sm bg-ink-600" style={{ height: h }} />
                  ))}
                </span>
                <span className="dec4-new absolute inset-0 flex items-end gap-[3px]">
                  {[12, 8, 16, 10, 14, 18, 9, 13, 7, 15, 11, 17, 10, 12].map((h, i) => (
                    <span key={i} className="flex-1 rounded-sm bg-iris" style={{ height: h }} />
                  ))}
                </span>
              </div>
            </div>

            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[9px] text-fg-subtle">
                music &amp; effects
                <span className="dec4-kept flex items-center gap-1 rounded-full border border-good/50 bg-good/10 px-1.5 py-px text-[8px] text-good">
                  <svg viewBox="0 0 24 24" className="size-2" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  untouched
                </span>
              </p>
              <div className="dec4-music flex h-7 items-end gap-[3px]">
                {[6, 10, 8, 12, 7, 11, 9, 13, 8, 6, 10, 12, 7, 9].map((h, i) => (
                  <span key={i} className="flex-1 rounded-sm bg-good/70" style={{ height: h }} />
                ))}
              </div>
            </div>
          </div>

          <p className="mt-3 text-[9px] leading-relaxed text-fg-subtle">
            Speech is separated out and re-voiced. Everything under it survives, so
            the room does not go quiet when someone talks.
          </p>
        </Scene>

        {/* ── 5. the delivered file ─────────────────────────────────────────
            One MP4, one audio track, tagged and set as default — and the original
            audio deliberately not bundled alongside it. */}
        <Scene n={5}>
          <div className="dec5-card rounded-lg border-2 border-ink-600 bg-ink-850 p-2.5">
            <div className="flex items-center gap-2">
              <span className="grid size-6 shrink-0 place-items-center rounded bg-ink-800 text-[9px]">
                ▶
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] font-medium">
                product-launch · telugu.mp4
              </span>
              <span className="text-[9px] tabular-nums text-fg-subtle">1:26</span>
            </div>

            <div className="dec5-track mt-2.5 flex items-center gap-2 rounded border-2 border-good/45 bg-good/10 px-2 py-1.5">
              <span className="text-[9px] text-fg">audio track 1</span>
              <span className="dec5-tag rounded bg-good/20 px-1.5 py-px text-[8px] font-medium text-good">
                tel
              </span>
              <span className="dec5-default ml-auto rounded-full bg-good px-1.5 py-px text-[8px] font-bold text-ink-950">
                default
              </span>
            </div>

            <div className="dec5-absent mt-1.5 flex items-center gap-2 rounded border-2 border-dashed border-ink-600 px-2 py-1.5">
              <span className="text-[9px] text-fg-subtle">original audio</span>
              <span className="ml-auto text-[8px] text-fg-subtle">not bundled</span>
            </div>
          </div>

          <p className="mt-3 text-[9px] leading-relaxed text-fg-subtle">
            One track, tagged with its language so players label it, and set as the
            default so it plays without anybody choosing it.
          </p>
        </Scene>
      </div>
    </div>
  );
}

/** A scene slot. All five are stacked; only one is opaque at a time. */
function Scene({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className={clsx('absolute inset-0 px-4 py-3.5', `dec-scene-${n}`)}>{children}</div>
  );
}
