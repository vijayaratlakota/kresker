/**
 * The creator play, shown rather than described.
 *
 * The claim on this section is a workflow — dub the video, attach each dub to the
 * SAME YouTube video as a language audio track, reach the audiences you could not
 * reach before. Written out it is four paragraphs that read like every other growth
 * pitch. Shown as a sequence, with the view counter on one video going up while its
 * URL stays the same, it is the argument.
 *
 * Four scenes on one 28-second clock:
 *
 *    1  the problem      one video, one language, one audience
 *    2  the dubs         six language tracks cut as audio files
 *    3  the attach       YouTube Studio's audio-track panel, one video, six tracks
 *    4  the payoff       same URL, the audiences that were closed now open
 *
 * Same construction as DashboardDemo and DecisionsDemo, for the same reasons: every
 * element shares `--reach-cycle` with its beats written as percentages of it, so
 * nothing can drift out of step with anything else, and no element uses
 * `animation-delay` — a delay offsets an element's whole loop and they separate
 * after the first pass. CSS rather than JS because the motion is entirely
 * predetermined and CSS animations run off the main thread, so this keeps moving
 * while the rest of the page is still painting.
 *
 * Transform and opacity only, plus a handful of colour swaps. Nothing here costs a
 * layout pass.
 *
 * THE NUMBERS ARE ILLUSTRATIVE AND THE COMPONENT SAYS SO. A view count climbing on
 * a marketing page is the easiest place in a product to imply a guarantee by
 * accident, so there is a visible caption rather than a footnote nobody reads.
 *
 * With motion off, scene one is shown complete and the rest are hidden. A four-scene
 * sequence has no single finished frame, so the honest fallback is the first scene
 * rather than four stacked on top of each other.
 */
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

const SCENES = [
  { label: 'Today', claim: 'One video, one language, one audience' },
  { label: 'Step one', claim: 'Dub it — and take the audio on its own' },
  { label: 'Step two', claim: 'Attach each one to the same video' },
  { label: 'The result', claim: 'Same URL, every audience it can now reach' },
];

/**
 * The six languages, in the order they light up. `bar` is how much of that market's
 * bar fills — illustrative, and ordered so the first is the original.
 */
const MARKETS = [
  { code: 'en', label: 'English', native: 'English', tone: 'reach-en' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', tone: 'reach-hi' },
  { code: 'te', label: 'Telugu', native: 'తెలుగు', tone: 'reach-te' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்', tone: 'reach-ta' },
  { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ', tone: 'reach-kn' },
  { code: 'es', label: 'Spanish', native: 'Español', tone: 'reach-es' },
];

export function ReachDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setRunning(true);
      return;
    }
    // A 28-second infinite loop running off-screen is pure waste.
    const io = new IntersectionObserver(([e]) => setRunning(e.isIntersecting), {
      threshold: 0.25,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <figure className="m-0">
      <div
        ref={ref}
        data-running={running ? 'true' : 'false'}
        data-reach-demo="true"
        className="reach-stage relative overflow-hidden rounded-[var(--radius-card)] border-2 border-ink-600 bg-ink-900"
        // Decorative. Every claim it makes is written out in the section around it.
        aria-hidden="true"
      >
        {/* Which beat is on screen, and what it says. */}
        <div className="flex items-start justify-between gap-3 border-b border-ink-700 px-4 py-3">
          <div className="min-w-0 flex-1">
            {/*
              Absolutely stacked and cut with the scene clock. Fixed heights are
              required because absolutely positioned children contribute none —
              two lines' worth on a narrow screen, one on a wide one.
            */}
            <p className="relative h-4">
              {SCENES.map((s, i) => (
                <span
                  key={s.label}
                  className={clsx(
                    'absolute left-0 top-0 whitespace-nowrap text-tiny uppercase',
                    'tracking-[0.14em] text-fg-subtle',
                    `reach-label-${i + 1}`,
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
                    `reach-claim-${i + 1}`,
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
                className={clsx('size-1.5 rounded-full bg-ink-600', `reach-dot-${i + 1}`)}
              />
            ))}
          </span>
        </div>

        <div className="relative h-[330px] sm:h-[290px]">
          {/* ── 1. the problem ──────────────────────────────────────────────
              One video with one audio track. Five of the six markets are drawn
              closed, which is the fact the rest of the sequence changes. */}
          <Scene n={1}>
            <div className="flex h-full flex-col justify-center gap-5">
              <VideoCard />
              <div>
                <p className="mb-2 text-tiny uppercase tracking-[0.14em] text-fg-subtle">
                  Who can watch it
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {MARKETS.map((m, i) => (
                    <span
                      key={m.code}
                      className={clsx(
                        'rounded-md border px-2 py-1 text-tiny',
                        i === 0
                          ? 'border-good/45 bg-good/10 text-good'
                          : 'border-ink-700 bg-ink-950 text-fg-subtle line-through decoration-ink-500',
                      )}
                    >
                      {m.label}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-tiny leading-relaxed text-fg-subtle">
                  Five of these are a re-upload, a second channel, or a subtitle file
                  nobody turns on.
                </p>
              </div>
            </div>
          </Scene>

          {/* ── 2. the dubs ─────────────────────────────────────────────────
              Six rows, each producing a file. The chip says .m4a on purpose: the
              audio on its own is the thing YouTube's uploader takes, and it is
              what makes this workflow possible at all. */}
          <Scene n={2}>
            <div className="flex h-full flex-col justify-center">
              <div className="flex items-center gap-2.5">
                <span className="reach-src flex items-center gap-2 rounded-lg border-2 border-ink-600 bg-ink-850 px-2.5 py-1.5">
                  <PlayGlyph />
                  <span className="text-tiny text-fg">your-video.mp4</span>
                </span>
                <span className="h-px flex-1 bg-ink-700" />
                <span className="text-tiny text-fg-subtle">one upload</span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {MARKETS.map((m, i) => (
                  <span
                    key={m.code}
                    className={clsx(
                      'flex items-center justify-between gap-2 rounded-lg border',
                      'border-ink-700 bg-ink-950 px-2 py-1.5',
                      `reach2-row-${i + 1}`,
                    )}
                  >
                    <span className="min-w-0 truncate text-tiny text-fg">{m.label}</span>
                    <span
                      className={clsx(
                        'flex shrink-0 items-center gap-1 text-tiny',
                        `reach2-file-${i + 1}`,
                      )}
                    >
                      <TickGlyph />
                      <span className="font-mono text-[10px] text-good">.m4a</span>
                    </span>
                  </span>
                ))}
              </div>

              <p className="mt-3 text-tiny leading-relaxed text-fg-subtle">
                Each one is your own voice, cut straight out of the dubbed video —
                lossless, and the same length as the picture.
              </p>
            </div>
          </Scene>

          {/* ── 3. the attach ───────────────────────────────────────────────
              A mock of YouTube Studio's audio-track panel. The URL is drawn ONCE
              at the top and never changes, because that is the whole point. */}
          <Scene n={3}>
            <div className="flex h-full flex-col justify-center">
              <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5">
                <YouTubeGlyph />
                <span className="truncate font-mono text-[10px] text-fg-subtle">
                  youtube.com/watch?v=…&nbsp;·&nbsp;Subtitles → Audio tracks
                </span>
                <span className="ml-auto shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[9px] text-fg-subtle">
                  unchanged
                </span>
              </div>

              <div className="reach-panel mt-2.5 overflow-hidden rounded-lg border border-ink-700">
                {MARKETS.map((m, i) => (
                  <span
                    key={m.code}
                    className={clsx(
                      'flex items-center gap-2 border-b border-ink-700 px-2.5 py-[7px] last:border-b-0',
                      i === 0 ? 'bg-ink-900' : 'bg-ink-950',
                    )}
                  >
                    <span className="w-16 shrink-0 truncate text-tiny text-fg sm:w-20">
                      {m.label}
                    </span>
                    <span className="hidden shrink-0 text-[10px] text-fg-subtle sm:inline">
                      {m.native}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {i === 0 ? (
                        <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[9px] text-fg-subtle">
                          Original
                        </span>
                      ) : (
                        <>
                          {/* "Add" gives way to "Published" on this row's beat. */}
                          <span className={clsx('text-[9px] text-fg-subtle', `reach3-add-${i}`)}>
                            Add
                          </span>
                          <span
                            className={clsx(
                              'flex items-center gap-1 rounded bg-good/12 px-1.5 py-0.5',
                              'text-[9px] text-good',
                              `reach3-done-${i}`,
                            )}
                          >
                            <TickGlyph />
                            Published
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                ))}
                {/*
                  The cursor. `transform` only, and it moves down the rows in step
                  with each one flipping to Published, so the two read as cause and
                  effect rather than two things happening near each other.
                */}
                <span className="reach-cursor pointer-events-none absolute right-8 top-0">
                  <CursorGlyph />
                </span>
              </div>
              <p className="mt-2.5 text-tiny leading-relaxed text-fg-subtle">
                Five uploads into one video. No new channel, no new URL, nothing to
                cross-promote.
              </p>
            </div>
          </Scene>

          {/* ── 4. the payoff ───────────────────────────────────────────────
              The same card from scene one, with the counter stepping up and the
              markets opening. The chain is spelled out underneath because it is
              the argument the section is making. */}
          <Scene n={4}>
            <div className="flex h-full flex-col justify-center gap-4">
              <VideoCard grown />
              <div className="space-y-1.5">
                {MARKETS.map((m, i) => (
                  <span key={m.code} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 truncate text-[10px] text-fg-subtle sm:w-16">
                      {m.label}
                    </span>
                    <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
                      <span
                        className={clsx(
                          'absolute inset-0 origin-left rounded-full',
                          m.tone,
                          `reach4-bar-${i + 1}`,
                        )}
                      />
                    </span>
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-tiny">
                {['More languages', 'more reach', 'more publicity'].map((t, i) => (
                  <span key={t} className="flex items-center gap-2">
                    <span className={clsx('text-fg-muted', `reach4-chain-${i + 1}`)}>
                      {t}
                    </span>
                    <ArrowGlyph className={`reach4-chain-${i + 1}`} />
                  </span>
                ))}
                <span className="reach4-chain-4 font-medium text-good">more money</span>
              </div>
            </div>
          </Scene>
        </div>
      </div>

      {/*
        Outside the aria-hidden stage so it is actually read out, and visible rather
        than a footnote. A counter going up on a marketing page is the easiest way to
        imply a guarantee by accident.
      */}
      <figcaption className="mt-3 text-tiny leading-relaxed text-fg-subtle">
        Illustration. The figures above are made up to show the mechanism — what you
        actually gain depends on your content and your audience. The workflow is
        real: YouTube&rsquo;s multi-language audio feature attaches one track per
        language to a single video.
      </figcaption>
    </figure>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function Scene({ n, children }: { n: 1 | 2 | 3 | 4; children: React.ReactNode }) {
  return (
    <div className={clsx('absolute inset-0 px-4 py-4', `reach-scene-${n}`)}>{children}</div>
  );
}

/**
 * The video card, in both states. `grown` is scene four: the same card, the same
 * title, a counter that steps up and a row of language chips instead of one.
 *
 * Deliberately the same component in both scenes. Two different-looking cards would
 * let a viewer read it as a different video, which is exactly the misunderstanding
 * the whole section exists to correct.
 */
function VideoCard({ grown }: { grown?: boolean }) {
  return (
    <div className="flex gap-3 rounded-xl border border-ink-700 bg-ink-950 p-2.5">
      <div className="relative grid h-16 w-28 shrink-0 place-items-center overflow-hidden rounded-lg bg-ink-850">
        <span className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,var(--color-ink-750),transparent_70%)]" />
        <PlayGlyph large />
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] text-fg-muted">
          12:04
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-small font-medium text-fg">
          How we built the whole thing in a week
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-fg-subtle">
          youtube.com/watch?v=…
        </p>
        {grown ? (
          <>
            {/* Stacked counters cut with steps(1). A crossfade between two numbers
                is mush; a cut reads as a counter ticking. */}
            <span className="relative mt-1.5 block h-5">
              {['142K views', '318K views', '640K views', '1.1M views'].map((v, i) => (
                <span
                  key={v}
                  className={clsx(
                    'absolute left-0 top-0 text-body font-medium tabular-nums text-good',
                    `reach-count-${i + 1}`,
                  )}
                >
                  {v}
                </span>
              ))}
            </span>
            <span className="mt-1 flex flex-wrap gap-1">
              {MARKETS.map((m, i) => (
                <span
                  key={m.code}
                  className={clsx(
                    'rounded border border-good/40 bg-good/10 px-1.5 py-0.5 text-[9px] text-good',
                    `reach4-chip-${i + 1}`,
                  )}
                >
                  {m.label}
                </span>
              ))}
            </span>
          </>
        ) : (
          <>
            <p className="mt-1.5 text-body font-medium tabular-nums text-fg-muted">
              142K views
            </p>
            <span className="mt-1 inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[9px] text-fg-subtle">
              <SpeakerGlyph />
              1 audio track
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* ── glyphs. Inline so they inherit colour and cost no request. ──────────── */

function PlayGlyph({ large }: { large?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={clsx('relative shrink-0 text-fg-muted', large ? 'size-6' : 'size-3.5')}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9 7.5v9l7.5-4.5L9 7.5Z" />
    </svg>
  );
}

function SpeakerGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-2.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5ZM16 9a4 4 0 0 1 0 6" />
    </svg>
  );
}

function TickGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-2.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

function ArrowGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={clsx('size-3 shrink-0 text-fg-subtle', className)} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14m0 0-5-5m5 5-5 5" />
    </svg>
  );
}

function YouTubeGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-bad" fill="currentColor" aria-hidden="true">
      <path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2C2 8.8 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8C22 15.2 22 12 22 12s0-3.2-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z" />
    </svg>
  );
}

/**
 * The cursor. A filled arrow with a stroke, so it stays visible over both the dark
 * rows and the lighter "Published" pills.
 */
function CursorGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" aria-hidden="true">
      <path
        d="M5 2.5l13 8.2-5.6.9 3 5.6-2.6 1.4-3-5.6-3.6 4.4V2.5Z"
        fill="var(--color-fg)"
        stroke="var(--color-ink-950)"
        strokeWidth="1.2"
      />
    </svg>
  );
}
