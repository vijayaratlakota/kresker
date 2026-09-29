/**
 * Pick one language, or several, from a searchable list.
 *
 * WHY A DROPDOWN AND NOT A ROW OF PILLS
 *
 * A row of pills scaled linearly with the catalogue — every language added made the
 * page worse, which is backwards when more languages are the roadmap. A dropdown is
 * flat in the number of options: the closed control is the same size at twelve
 * languages or at forty-three.
 *
 * WHY THIS IS NOW A COMBOBOX AND WAS A SELECT
 *
 * It was a `Select`, deliberately, and the comment here used to say a search box was
 * the wrong affordance: it asks the reader to think of a word before it will show them
 * anything, which is the opposite of what somebody browsing twelve options needs. That
 * was right at twelve. It stopped being right at forty-three — scrolling to find
 * Ukrainian past thirty other languages is the chore that comment said would be the
 * moment to add filtering back. This is that moment.
 *
 * So: the list still opens straight into the options, unfiltered, for browsing. The
 * search field is there for the person who already knows what they want. Neither
 * audience pays for the other.
 *
 * FILTERING IS OURS, NOT THE LIBRARY'S. Base UI would happily match on the label, but
 * that would mean typing `telugu` works and typing `te` or `తెలుగు` does not. The
 * `filteredItems` prop hands filtering to `languageMatches`, which matches the code,
 * the English name and the native name, and folds accents so `espanol` finds Español.
 *
 * WHY BASE UI AND NOT A HAND-ROLLED MENU
 *
 * A filterable multi-select is one of the genuinely hard components: roving focus,
 * `aria-activedescendant`, the input and the list sharing a focus loop, click-outside,
 * scroll containment, and keeping the popup anchored while the page scrolls. Base UI
 * owns all of that. Hand-rolling it is how you end up with a `<div>` that keyboard
 * users cannot operate. The styling here is entirely ours; only the behaviour is
 * borrowed.
 *
 * NOTHING IS SELECTED BY DEFAULT. A pre-picked language is a decision made on the
 * customer's behalf that costs them minutes if they miss it, and it is the kind of
 * default somebody only notices after they have paid for a dub they did not want.
 *
 * ORDER IS PRESERVED, and that is load-bearing: the order languages are picked in is
 * the order the jobs queue in, so the first chosen is the first dub back. The chips are
 * numbered so that reads as a queue rather than a set.
 *
 * THERE IS A CEILING, AND IT IS VISIBLE BEFORE YOU REACH IT. `MAX_LANGS_PER_BATCH` is
 * eight, because the dubs run serially on one GPU and a longer queue holds the box for
 * hours. Three things carry that here, and each covers a case the others do not:
 * the trigger reads "3 of 8" so the limit is known before it bites; the unchosen rows
 * go dead at eight with a line saying why; and `onValueChange` clamps, because a
 * disabled row is a property of the rendered list and the handler is the only place the
 * value is really set. The server enforces it regardless - this is courtesy, not
 * security.
 */
import { Combobox } from '@base-ui/react/combobox';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import {
  LANGUAGES,
  LANGUAGE_GROUPS,
  MAX_LANGS_PER_BATCH,
  languageDot,
  languageMatches,
  type Language,
} from '../lib/format';

/** What Base UI needs per row: a value it can select and a label it can announce. */
type Item = { value: string; label: string; native: string };
/** Base UI's grouped-items shape: `value` is the heading, `items` are the rows. */
type Group = { value: string; items: Item[] };

const toItem = (l: Language): Item => ({
  value: l.code,
  label: l.label,
  native: l.native,
});

/** Group the catalogue, keeping only what matches `query` and dropping empty groups. */
function buildGroups(query: string): Group[] {
  return LANGUAGE_GROUPS.map((g) => ({
    value: g.label,
    items: LANGUAGES.filter((l) => l.group === g.id && languageMatches(l, query)).map(
      toItem,
    ),
  })).filter((g) => g.items.length > 0);
}

export function LanguagePicker({
  value,
  onChange,
  disabled,
}: {
  /** Language codes, in the order they were picked. */
  value: string[];
  onChange: (codes: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');

  // The unfiltered set stays as `items` because Base UI reads it to resolve a selected
  // code back to its label and to decide whether the list is empty. Only the rendered
  // rows are filtered.
  const allGroups = useMemo(() => buildGroups(''), []);
  const shown = useMemo(() => buildGroups(query), [query]);

  const atCap = value.length >= MAX_LANGS_PER_BATCH;

  return (
    <div className="space-y-2">
      <Combobox.Root
        items={allGroups}
        filteredItems={shown}
        multiple
        value={value}
        // Clamped as well as blocked. The rows past the cap are `disabled`, which is
        // what a person sees, but `disabled` is a property of a rendered row and this
        // handler is the only place the value is actually set - a keyboard select, a
        // paste, or a future Base UI version that fires anyway would otherwise walk
        // past the ceiling and the request would come back 400 at submit time.
        onValueChange={(next) => {
          const codes = next as string[];
          if (codes.length > MAX_LANGS_PER_BATCH) return;
          onChange(codes);
        }}
        onInputValueChange={setQuery}
        disabled={disabled}
      >
        <Combobox.Trigger
          className={clsx(
            'flex h-11 w-full items-center justify-between gap-2 rounded-xl',
            'border-2 border-ink-600 bg-ink-900 px-3.5 text-body text-fg',
            'transition-[border-color,background-color] duration-[160ms]',
            'ease-[var(--ease-out-strong)]',
            'hover:border-ink-500 data-[popup-open]:border-fg-subtle',
            'focus-visible:border-fg-subtle focus-visible:outline-none',
            disabled && 'pointer-events-none opacity-50',
          )}
        >
          {/*
            Once anything is picked the trigger reads "3 of 8", not "3 selected". The
            denominator is the point: it says there is a ceiling and how far away it is
            before you hit it, rather than letting you find out by a row going dead.
          */}
          <span className={clsx('truncate', !value.length && 'text-fg-subtle')}>
            {value.length === 0
              ? `Select languages — ${LANGUAGES.length} available`
              : `${value.length} of ${MAX_LANGS_PER_BATCH} selected`}
          </span>
          <Combobox.Icon
            className={clsx(
              'shrink-0 text-fg-muted',
              // Points down when closed, up when open. The only motion on the control,
              // and it is state indication rather than decoration.
              'transition-transform duration-[160ms] ease-[var(--ease-out-strong)]',
              'data-[popup-open]:rotate-180 motion-reduce:transition-none',
            )}
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </Combobox.Icon>
        </Combobox.Trigger>

        <Combobox.Portal>
          <Combobox.Positioner sideOffset={6} className="z-50">
            <Combobox.Popup
              className={clsx(
                // `dvh`, not `vh`. On mobile `vh` is the LARGE viewport — the height
                // with the browser chrome ignored — so a 65vh popup can extend under
                // the address bar and lose its last rows. `dvh` tracks what is
                // actually visible.
                //
                // `min-w-` is clamped against the viewport too: the popup is as wide
                // as its trigger, but on a 360px screen a 17rem (272px) floor plus
                // the page's own padding is wider than the space available.
                'flex max-h-[min(26rem,65dvh)] w-[var(--anchor-width)] flex-col',
                'min-w-[min(17rem,calc(100vw-2rem))]',
                'rounded-xl border-2 border-ink-600 bg-ink-850 shadow-2xl shadow-black/60',
                // Grows out of the trigger rather than appearing from nowhere.
                'origin-[var(--transform-origin)]',
                'transition-[opacity,transform] duration-[160ms] ease-[var(--ease-out-strong)]',
                'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
                'motion-reduce:transition-none',
              )}
            >
              {/* Pinned, not scrolled away with the list. A search field you have to
                  scroll back up to reach is worse than none. */}
              <div className="shrink-0 border-b border-ink-700 p-2">
                <Combobox.Input
                  // No visible label in this pattern — the trigger carries the name —
                  // so the input needs its own.
                  aria-label="Search languages"
                  placeholder="Search by name or code…"
                  className={clsx(
                    'h-9 w-full rounded-lg border-2 border-ink-600 bg-ink-900 px-3',
                    'text-body text-fg placeholder:text-fg-subtle',
                    'focus-visible:border-fg-subtle focus-visible:outline-none',
                  )}
                />
              </div>

              {/* Kept mounted rather than conditionally rendered, so screen readers
                  hear the change. Base UI renders its CHILDREN only when the list is
                  empty - the element itself is always there - so the padding must
                  collapse with them (`empty:p-0`). Without that, every open list
                  started with a 48px blank band above the first language. */}
              <Combobox.Empty className="px-3 py-6 text-center text-small text-fg-subtle empty:p-0">
                No language matches that.
              </Combobox.Empty>

              {/*
                Shown only at the ceiling, and it gives the REASON. A row that has gone
                grey with no explanation reads as a bug or as an upsell; neither is what
                is happening. `role="status"` so it is announced when it appears, since
                the thing it explains is rows becoming unclickable.
              */}
              {atCap && (
                <p
                  role="status"
                  className="shrink-0 border-b border-ink-700 bg-ink-800/60 px-3 py-2 text-tiny text-fg-muted"
                >
                  {MAX_LANGS_PER_BATCH} is the most in one go — they run one after
                  another. Take one off to swap it, or send another batch after this one.
                </p>
              )}

              <Combobox.List className="min-h-0 flex-1 overflow-y-auto p-1">
                {(group: Group) => (
                  <Combobox.Group key={group.value} items={group.items} className="mb-1">
                    {/*
                      NOT sticky any more. A sticky label in a scrolling list sits ON TOP
                      of the rows passing under it, and on iPhone Safari it lags behind a
                      momentum scroll - the reported bug was "MORE LANGUAGES" printed over
                      the Polish row. With two groups the label is only a divider, so it
                      simply scrolls with its group and can never cover a row.
                    */}
                    <Combobox.GroupLabel
                      className={clsx(
                        'px-2.5 pb-1 pt-2',
                        'text-tiny uppercase tracking-[0.14em] text-fg-subtle',
                      )}
                    >
                      {group.value}
                    </Combobox.GroupLabel>
                    <Combobox.Collection>
                      {(item: Item) => (
                        <Combobox.Item
                          key={item.value}
                          value={item.value}
                          // At the cap the rows you have NOT chosen go dead, and the
                          // ones you have stay live. Disabling everything would trap
                          // you: with eight picked and no way to deselect, the only
                          // exit is the None button or the chips below.
                          disabled={atCap && !value.includes(item.value)}
                          className={clsx(
                            'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-body',
                            'transition-colors duration-[120ms]',
                            'data-[highlighted]:bg-ink-800',
                            // Not `pointer-events-none`: the row has to stay
                            // hoverable and focusable or a keyboard user arrows into
                            // a silence with nothing to read.
                            'data-[disabled]:opacity-40',
                          )}
                        >
                          <span
                            className={clsx(
                              'size-2 shrink-0 rounded-full',
                              languageDot(item.value),
                            )}
                          />
                          <span className="flex-1 truncate">{item.label}</span>
                          <span className="shrink-0 text-small text-fg-subtle">
                            {item.native}
                          </span>
                          {/* A visible box, not just a tick on selection: an empty box
                              says "several of these can be on at once" before anything
                              is chosen, which a bare tick cannot. */}
                          <span
                            className={clsx(
                              'grid size-4 shrink-0 place-items-center rounded border-2',
                              'transition-[background-color,border-color] duration-[120ms]',
                              value.includes(item.value)
                                ? 'border-iris bg-iris text-white'
                                : 'border-ink-600',
                            )}
                          >
                            <Combobox.ItemIndicator>
                              <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            </Combobox.ItemIndicator>
                          </span>
                        </Combobox.Item>
                      )}
                    </Combobox.Collection>
                  </Combobox.Group>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>

      {/*
        The chosen languages live OUTSIDE the trigger, as removable chips. Putting them
        inside would make the closed control grow and shrink as you pick, which moves
        the button underneath it — and that button is the next thing you are going to
        press.
      */}
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((code, i) => {
            const l = LANGUAGES.find((x) => x.code === code);
            if (!l) return null;
            return (
              // `relative` + a z-index per chip: each chip's remove button carries an
              // invisible 44px tap area that reaches past the chip's edge (see
              // data-touch-inset below). Stacking the LATER chip above the earlier
              // one means that area can never paint over, or take taps from, the chip
              // next to it. `max-w-full` + `truncate` keep a long name inside its pill
              // on a narrow phone instead of pushing the row wider than the screen.
              <li key={code} className="relative max-w-full" style={{ zIndex: i + 1 }}>
                <span
                  className={clsx(
                    'flex max-w-full items-center gap-1.5 rounded-full border-2 border-iris/70',
                    'bg-iris/12 py-0.5 pl-1.5 pr-1 text-small font-medium text-fg',
                  )}
                >
                  <span className="grid size-4 shrink-0 place-items-center rounded-full bg-iris text-[10px] leading-none tabular-nums text-white">
                    {i + 1}
                  </span>
                  <span className="min-w-0 truncate">{l.label}</span>
                  {/*
                    `data-touch-inset`, and this is the one control in the app that
                    needs it.

                    It is a 20px ✕ inside a 24px-tall pill — the smallest target in
                    the product, and in the primary flow. The blanket coarse-pointer
                    floor in styles.css would make it 44px, which would make every
                    chip 44px tall and turn a two-line chip row into six lines. So it
                    opts out of the floor and gets a -12px inset pseudo-element
                    instead: the tap area is 44px, the layout is unchanged, and the
                    chips stay the size they were designed to be.
                  */}
                  <button
                    type="button"
                    data-touch-inset
                    aria-label={`Remove ${l.label}`}
                    onClick={() => onChange(value.filter((c) => c !== code))}
                    className={clsx(
                      'grid size-5 shrink-0 place-items-center rounded-full text-fg-muted',
                      'transition-colors duration-[160ms] hover:bg-white/10 hover:text-fg',
                    )}
                  >
                    <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.6">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
