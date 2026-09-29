/**
 * The download button, which asks what you want before it gives it to you.
 *
 * It used to be two buttons side by side — "Download video" and "Audio only" — and
 * that stopped scaling the moment there were four formats. A menu also puts the
 * trade-off next to the choice: "lossless, what YouTube wants" beside M4A and
 * "roughly 11 MB a minute" beside WAV, at the moment somebody is deciding, rather
 * than in documentation they will not read.
 *
 * THE LIST COMES FROM THE SERVER. `/api/jobs/{id}/formats` is the source, so the
 * menu cannot offer something the exporter has no recipe for, and a format added
 * server-side appears here without a frontend change. It is fetched once, on first
 * open, because a list of four static rows is not worth a request on every row of
 * the library table.
 *
 * The click is a plain <a download> per row rather than fetch-and-blob: the browser
 * owns the save dialog, the progress and the 307 hop to /dl/, and a 200 MB WAV never
 * passes through JavaScript memory.
 *
 * Base UI's Menu because it handles the parts that are easy to get wrong — focus
 * return, roving tabindex, type-ahead, Escape, outside-click, and the collision
 * logic that keeps the panel on screen for the last row of a table.
 */
import { Menu } from '@base-ui/react/menu';
import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { api, type FormatOption } from '../lib/api';
import { Button, Chevron } from '../ui/Button';
import { DownloadGlyph } from './JobsTable';

export function DownloadMenu({
  jobId,
  size = 'md',
  variant = 'primary',
  label = 'Download',
}: {
  jobId: string;
  size?: 'sm' | 'md';
  /** White is the default and the table's choice. `iris` is for the one highest
   *  intent action on a page — the delivery card, where the download IS the page. */
  variant?: 'primary' | 'secondary' | 'iris';
  label?: string;
}) {
  const [formats, setFormats] = useState<FormatOption[] | null>(null);
  const [failed, setFailed] = useState(false);

  // On first open only. Four static rows are not worth a request per table row.
  const load = useCallback(() => {
    if (formats || failed) return;
    api.jobs
      .formats(jobId)
      .then((r) => setFormats(r.formats))
      .catch(() => setFailed(true));
  }, [formats, failed, jobId]);

  return (
    <Menu.Root onOpenChange={(open) => open && load()}>
      <Menu.Trigger
        render={
          <Button size={size} variant={variant} className="group/dl gap-1.5">
            <DownloadGlyph />
            {label}
            {/*
              Rotated to point down, and flipped up while the menu is open, so the
              button says "there is more here" before it is pressed. Transform only.
            */}
            <Chevron className="rotate-90 group-data-[popup-open]/dl:-rotate-90" />
          </Button>
        }
      />
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50">
          <Menu.Popup
            className={clsx(
              // Narrow on purpose. The first version put each format's trade-off
              // under its name, which made a four-row menu taller than the table it
              // opened over — and nobody reads a paragraph while picking a file
              // type. The extension is the decision; the reasoning lives on the job
              // page, and the one caveat that costs real money (WAV's size) fires as
              // a toast on click, where it cannot be missed.
              'min-w-[9rem] overflow-hidden rounded-xl border-2',
              'border-ink-600 bg-ink-850 shadow-2xl outline-none',
              // Origin-aware, so it grows out of the button rather than from the
              // middle of nowhere. Transform and opacity only.
              'origin-[var(--transform-origin)]',
              'transition-[transform,opacity] duration-[160ms] ease-[var(--ease-out-strong)]',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              'motion-reduce:transition-none',
            )}
          >
            {failed ? (
              <p className="px-3.5 py-2.5 text-small text-fg-subtle">
                Could not load the formats.
              </p>
            ) : !formats ? (
              // Grey rows rather than a spinner: the menu is already open and its
              // height should not jump when the real rows arrive.
              <div className="space-y-1.5 p-2" aria-busy="true">
                <span className="sheen block h-7 rounded-md bg-ink-800" />
                <span className="sheen block h-7 rounded-md bg-ink-800" />
              </div>
            ) : (
              <div className="p-1.5">
                {formats.map((f) => (
                  <Menu.Item
                    key={f.format}
                    data-format={f.format}
                    className={clsx(
                      'group/row flex cursor-pointer select-none items-center gap-2.5',
                      'rounded-lg px-2.5 py-2 outline-none',
                      'transition-colors duration-[120ms] ease-[var(--ease-out-strong)]',
                      // THE HIGHLIGHT HAS TO BE VISIBLE. The first version used
                      // `bg-ink-800` on an `ink-850` popup — #16191e on #101317, a
                      // six-value step out of 255. It was technically present and
                      // effectively invisible, which is worse than no hover at all
                      // because the row looks dead.
                      //
                      // `ink-700` is a step you can actually see, and it is paired
                      // with an iris left edge so the highlight reads as "this row"
                      // rather than "the panel got lighter". Both are colour, so
                      // neither costs layout.
                      'relative before:absolute before:inset-y-1.5 before:left-0',
                      'before:w-[3px] before:rounded-full before:bg-iris',
                      'before:opacity-0 before:transition-opacity before:duration-[120ms]',
                      'hover:bg-ink-700 data-[highlighted]:bg-ink-700',
                      'hover:before:opacity-100 data-[highlighted]:before:opacity-100',
                      // On touch there is no hover and Base UI sets no `highlighted`
                      // until a keyboard drives the menu, so both signals above were
                      // simply absent on a phone — the rows read as dead. A coarse
                      // pointer gets the iris edge permanently instead: it stops
                      // meaning "this row" and starts meaning "these are the rows",
                      // which is the honest reading when nothing is hovered.
                      'pointer-coarse:before:opacity-60',
                      // Taller rows on a finger. ~40px was borderline; the menu has
                      // four items and mis-tapping downloads the wrong format.
                      'pointer-coarse:py-3',
                    )}
                    render={
                      <a
                        href={api.jobs.downloadHref(jobId, f.format)}
                        download
                        onClick={() => {
                          if (f.format === 'wav') {
                            // The one caveat that costs real bandwidth, said before
                            // the bytes start moving rather than after.
                            toast.message('WAV is uncompressed', {
                              description: f.note,
                            });
                          }
                        }}
                      />
                    }
                  >
                    {/*
                      The icon is what says video or audio, which is why the label can
                      be just the extension. Film for the one, waveform for the three.
                    */}
                    {f.kind === 'video' ? <FilmGlyph /> : <WaveGlyph />}
                    <span className="text-small font-medium uppercase text-fg">
                      {f.ext.replace('.', '')}
                    </span>
                    {/*
                      The arrow appears on the highlighted row only. It is the third
                      signal, and the useful one: it says which row a click will
                      actually download, not merely which row the pointer is over.
                    */}
                    <span
                      className={clsx(
                        'ml-auto text-fg-muted transition-opacity duration-[120ms]',
                        'opacity-0',
                        'group-hover/row:opacity-100 group-data-[highlighted]/row:opacity-100',
                        // Visible from the start on touch. The comment above calls this
                        // "the third signal, and the useful one" — and on a phone it
                        // never appeared, because there is no hover to reveal it. A
                        // dimmed arrow on every row still says "this row is a
                        // download", which is the part that was missing.
                        'pointer-coarse:opacity-60',
                      )}
                    >
                      <ArrowGlyph />
                    </span>
                  </Menu.Item>
                ))}
              </div>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The compact form for a table row: an icon that opens the same menu.
 *
 * Kept as a separate export rather than another size on DownloadMenu because the
 * two have different jobs — this one has no room for a word, so it needs a real
 * accessible name instead of a visible label.
 */
export function DownloadMenuIcon({ jobId }: { jobId: string }) {
  // White, like the button it replaced. Colour is spent on job STATE everywhere else
  // in these rows, which is exactly why the action is left monochrome — it makes it
  // the highest-contrast thing in the row without spending a hue on it.
  return <DownloadMenu jobId={jobId} size="sm" variant="primary" label="Get" />;
}

function FilmGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-iris" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m10 9.5 5 2.5-5 2.5v-5Z" />
    </svg>
  );
}

function ArrowGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v12m0 0 4-4m-4 4-4-4" />
    </svg>
  );
}

function WaveGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-cyan" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </svg>
  );
}
