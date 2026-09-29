/**
 * A working miniature of the dashboard, driving itself through the four steps
 * with a visible cursor.
 *
 * WHY THIS IS CODE AND NOT A GIF OR A SCREENSHOT
 *
 * A screen recording of a dark UI is the worst case for video and GIF compression:
 * large flat areas, thin borders, small text. GIF has 256 colours and no alpha, so
 * the gradients band and the type furs up. A 2x screenshot is ~400 KB and still
 * soft on a 3x phone. This is a couple of KB of CSS, stays sharp at any pixel
 * density, and reads the real design tokens — so when the palette changes the demo
 * changes with it instead of quietly becoming a picture of an older product.
 *
 * HOW THE CURSOR KNOWS WHERE TO GO
 *
 * The first version hard-coded the cursor's path in pixels, and it missed every
 * target — the arrow hovered above the dropzone, then between the file and the
 * pills, then below the Download button. Hand-computed coordinates were never
 * going to survive a padding change, let alone three breakpoints.
 *
 * So the targets are now MEASURED. Each one carries `data-target`, and on mount
 * (and on every resize) their centres are written to CSS custom properties on the
 * stage. The keyframes interpolate between `var(--t1x)`, `var(--t2x)` and so on.
 * The measuring is JS, but the animation is still pure CSS on the compositor — and
 * the cursor cannot drift from what it is pointing at, because it is derived from
 * that thing's real position.
 *
 * HOW THE CHOREOGRAPHY STAYS IN SYNC
 *
 * Every animated element shares ONE duration (`--demo-cycle`), with the timing
 * expressed as percentages of it. No `animation-delay` anywhere: a delay would
 * offset each element's loop and they would drift apart over time, which for a
 * cursor and the control it appears to press is the whole ballgame.
 *
 * THE BASE STYLES ARE THE FINISHED STATE
 *
 * With animations off, this renders as step four: three dubs complete, downloads
 * ready. Reduced motion, a screenshot tool, or a browser quirk all land on the
 * single most informative frame rather than on an empty box.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Shown ticked, in queue order. */
const PICKED = [
  { label: 'Telugu', native: 'తెలుగు', dot: 'bg-stage-speak' },
  { label: 'Hindi', native: 'हिन्दी', dot: 'bg-stage-translate' },
  { label: 'Tamil', native: 'தமிழ்', dot: 'bg-cyan' },
];
/** Also in the list, to show it is a catalogue rather than five buttons. */
const REST = [
  { label: 'Kannada', native: 'ಕನ್ನಡ', dot: 'bg-good' },
  { label: 'Spanish', native: 'Español', dot: 'bg-sky' },
];

/** The order the cursor visits them. Index+1 becomes --t1x/--t1y and so on. */
const TARGETS = ['drop', 'field', 'item1', 'item2', 'item3', 'cta', 'dl'] as const;

export function DashboardDemo() {
  const stageRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);

  /**
   * Write each target's centre, relative to the cursor's containing block, onto
   * the stage as CSS variables.
   *
   * The cursor is `absolute left-0 top-0` inside `originRef`, so its zero point is
   * that element's PADDING box — hence `clientLeft/clientTop` rather than the
   * bounding rect alone. The arrow's tip sits ~6px in from its own top-left, so
   * that is subtracted to put the tip on the target instead of the arrow's corner.
   */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const origin = originRef.current;
    if (!stage || !origin) return;
    const o = origin.getBoundingClientRect();
    const ox = o.left + origin.clientLeft;
    const oy = o.top + origin.clientTop;
    const TIP_X = 6;
    const TIP_Y = 3;
    TARGETS.forEach((name, i) => {
      const el = origin.querySelector<HTMLElement>(`[data-target="${name}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      stage.style.setProperty('--t' + (i + 1) + 'x', `${r.left + r.width / 2 - ox - TIP_X}px`);
      stage.style.setProperty('--t' + (i + 1) + 'y', `${r.top + r.height / 2 - oy - TIP_Y}px`);
    });
    // Somewhere out of the way to rest between loops.
    stage.style.setProperty('--idlex', `${o.width * 0.72}px`);
    stage.style.setProperty('--idley', `${o.height * 0.86}px`);

    // The popup's own top edge, measured rather than guessed. It was hard-coded at
    // `top-[104px]`, which landed directly ON the select and hid it completely —
    // the control the demo is meant to be showing off was behind its own dropdown.
    // Anchoring to the field's bottom is what a real popup does.
    const field = origin.querySelector<HTMLElement>('[data-target="field"]');
    if (field) {
      const f = field.getBoundingClientRect();
      stage.style.setProperty('--listtop', `${f.bottom - oy + 4}px`);
    }
  }, []);

  useEffect(() => {
    measure();
    const stage = stageRef.current;
    if (!stage) return;
    // Targets move when the column reflows, so re-measure rather than assume.
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setRunning(true);
      return;
    }
    // An infinite animation off-screen still costs compositor work every frame,
    // and this one runs for twenty seconds at a stretch.
    const io = new IntersectionObserver(([e]) => setRunning(e.isIntersecting), {
      threshold: 0.25,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={stageRef}
      data-running={running ? 'true' : 'false'}
      className="demo-stage relative mx-auto w-full max-w-[560px] overflow-hidden rounded-[var(--radius-card)] border-2 border-ink-600 bg-ink-950"
      // Decorative. The four step cards beside it carry the same information as
      // text, which is what a screen reader gets.
      aria-hidden="true"
    >
      {/* browser chrome, so it reads as "this is the app" without a screenshot */}
      <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-3 py-2">
        <span className="size-2 rounded-full bg-bad/70" />
        <span className="size-2 rounded-full bg-warn/70" />
        <span className="size-2 rounded-full bg-good/70" />
        <span className="ml-2 truncate rounded-md bg-ink-850 px-2 py-0.5 text-[9px] text-fg-subtle">
          kresker.com/app
        </span>
      </div>

      <div className="flex min-h-[300px]">
        {/* ── sidebar ─────────────────────────────────────────────────────── */}
        <aside className="hidden w-[104px] shrink-0 flex-col gap-1 border-r border-ink-700 bg-ink-900 p-2.5 sm:flex">
          <div className="mb-2 flex items-center gap-1.5 px-1">
            <span className="grid size-4 place-items-center rounded bg-iris text-[8px] font-bold text-white">
              K
            </span>
            <span className="text-[10px] font-medium">Kresker</span>
          </div>
          {([
            ['Dubbing', 'text-iris', true],
            ['Library', 'text-cyan', false],
            ['Plan', 'text-good', false],
          ] as const).map(([label, tint, active]) => (
            <div
              key={label}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px]',
                active ? 'bg-ink-800 text-fg' : 'text-fg-subtle',
              )}
            >
              <span className={clsx('size-1.5 rounded-full', active ? 'bg-iris' : 'bg-ink-600')} />
              <span className={active ? tint : ''}>{label}</span>
            </div>
          ))}
          <div className="mt-auto rounded-md border border-ink-700 bg-ink-850 p-1.5">
            <p className="text-[8px] text-fg-subtle">Pro</p>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-800">
              <span className="demo-quota block h-full origin-left rounded-full bg-[linear-gradient(90deg,var(--color-iris),var(--color-cyan))]" />
            </div>
          </div>
        </aside>

        {/* ── main. Also the cursor's coordinate space. ────────────────────── */}
        <div ref={originRef} className="relative min-w-0 flex-1 p-3.5">
          <p className="text-[11px] font-medium">Dubbing</p>
          <p className="mt-0.5 text-[9px] text-fg-subtle">
            Upload a video, pick your languages.
          </p>

          <div className="mt-2.5 rounded-lg border border-ink-700 bg-ink-850 p-2.5">
            {/* slot one: the dropzone, then the uploaded file. Both are absolute
                inside a fixed-height slot, so only opacity and transform animate
                and the card never resizes mid-loop. */}
            <div className="relative h-[52px]">
              <div
                data-target="drop"
                className="demo-drop absolute inset-x-0 top-0 grid place-items-center rounded-md border-2 border-dashed border-ink-600 py-3.5"
              >
                <span className="text-[9px] text-fg-subtle">Drag a video in</span>
              </div>

              <div className="demo-file absolute inset-x-0 top-0 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="grid size-4 shrink-0 place-items-center rounded bg-ink-800 text-[8px]">
                    ▶
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[9px] font-medium">
                    product-launch.mp4
                  </span>
                  <span className="text-[8px] tabular-nums text-fg-subtle">1:26</span>
                </div>
                <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-ink-800">
                  <span className="demo-upload block h-full origin-left rounded-full bg-[linear-gradient(90deg,var(--color-iris),var(--color-cyan))]" />
                </div>
              </div>
            </div>

            {/* slot two: the picker, then the run */}
            <div className="relative mt-2 h-[104px]">
              <div className="demo-picker absolute inset-x-0 top-0">
                <p className="mb-1 text-[9px] text-fg-subtle">Dub into</p>

                {/* The closed select. Its label counts up as items get ticked, and
                    the chevron flips while the list is open — exactly what the real
                    control does. */}
                <div
                  data-target="field"
                  className="demo-field flex h-[24px] items-center justify-between gap-1 rounded-md border-2 border-ink-600 bg-ink-900 px-2"
                >
                  <span className="relative text-[9px]">
                    <span className="demo-ph text-fg-subtle">Select languages</span>
                    <span className="demo-count absolute left-0 top-0 whitespace-nowrap text-fg">
                      3 languages selected
                    </span>
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    className="demo-chev size-2.5 shrink-0 text-fg-muted"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </div>

                {/* The picked languages sit below the control, as they do for real,
                    so the control never changes height. */}
                <div className="mt-1 flex h-[14px] flex-wrap gap-1">
                  {PICKED.map((l, i) => (
                    <span
                      key={l.label}
                      className={clsx(
                        'flex items-center gap-1 rounded-full border border-iris/70 bg-iris/12',
                        'py-px pl-1 pr-1.5 text-[8px] font-medium text-fg',
                        `demo-chip-${i + 1}`,
                      )}
                    >
                      <span className="grid size-2.5 place-items-center rounded-full bg-iris text-[6px] leading-none text-white">
                        {i + 1}
                      </span>
                      {l.label}
                    </span>
                  ))}
                </div>

                <span className="demo-cta mt-1 inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-[9px] font-bold text-accent-ink">
                  <span data-target="cta">Dub into 3 languages</span>
                </span>
              </div>

              {/* steps 3-4 — the run, and the finished downloads */}
              <div className="demo-run absolute inset-x-0 top-0 space-y-1.5">
                {PICKED.map((l, i) => (
                  <div
                    key={l.label}
                    className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
                  >
                    <span className={clsx('size-1.5 shrink-0 rounded-full', l.dot)} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[9px] font-medium">{l.label}</p>
                      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-ink-800">
                        <span
                          className={clsx(
                            'block h-full origin-left rounded-full bg-good',
                            `demo-row-${i + 1}`,
                          )}
                        />
                      </div>
                    </div>
                    <span
                      {...(i === 0 ? { 'data-target': 'dl' } : {})}
                      className={clsx(
                        'demo-dl shrink-0 rounded-full bg-accent px-2 py-0.5 text-[8px] font-bold text-accent-ink',
                        i === 0 && 'demo-dl-first',
                      )}
                    >
                      Download
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/*
            The open list. Absolute and high z-index, exactly like a real popup, so
            it can overlay the CTA without the card growing to fit it.
          */}
          <div
            style={{ top: 'var(--listtop, 132px)' }}
            className="demo-list absolute left-3.5 right-3.5 z-10 origin-top rounded-lg border-2 border-ink-600 bg-ink-850 p-1 shadow-2xl shadow-black/70"
          >
            {[...PICKED, ...REST].map((l, i) => (
              <div
                key={l.label}
                {...(i < 3 ? { 'data-target': `item${i + 1}` } : {})}
                className={clsx(
                  'flex items-center gap-1.5 rounded px-1.5 py-1 text-[9px]',
                  i < 3 && `demo-item-${i + 1}`,
                )}
              >
                <span className={clsx('size-1.5 shrink-0 rounded-full', l.dot)} />
                <span className="flex-1 text-fg">{l.label}</span>
                <span className="text-[8px] text-fg-subtle">{l.native}</span>
                {/* An empty checkbox on the unpicked rows, so the list says "more
                    than one of these can be on" before anything is chosen. */}
                <span
                  className={clsx(
                    'grid size-2.5 shrink-0 place-items-center rounded-[2px] border',
                    i < 3 ? `demo-box-${i + 1}` : 'border-ink-600',
                  )}
                >
                  {i < 3 && (
                    <span className={clsx('text-white', `demo-tick-${i + 1}`)}>
                      <svg viewBox="0 0 24 24" className="size-2" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>

          {/* The cursor. Big, high-contrast, and it carries its own click ring. */}
          <span className="demo-cursor pointer-events-none absolute left-0 top-0 z-20">
            <span className="demo-ring absolute -left-3 -top-3 size-9 rounded-full border-2 border-white/70" />
            <svg viewBox="0 0 24 24" className="size-7 drop-shadow-[0_2px_6px_rgba(0,0,0,0.85)]">
              <path
                d="M5 2.5 19 12l-6.5 1.2L9.7 20 5 2.5Z"
                fill="white"
                stroke="#0a0b0d"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </div>

      {/* The reset veil. A twenty-second loop has to start over somewhere; without
          this, every element would visibly snap back at once. */}
      <span className="demo-veil pointer-events-none absolute inset-0 z-30 bg-ink-950" />
    </div>
  );
}
