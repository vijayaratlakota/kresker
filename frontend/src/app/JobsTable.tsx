/**
 * The jobs table, shared by Dubbing's "Recent dubs" and the Library.
 *
 * It exists because the two screens had the same seven-column table copied twice,
 * and both had the same defect: **the Download button was off the right edge.**
 * Seven columns with generous padding overflowed the card, so the one thing a
 * finished dub is for could only be reached by dragging the table sideways.
 *
 * Two independent fixes, because either alone is fragile:
 *
 *   1. **Columns drop out as the viewport narrows**, cheapest information first.
 *      Created and "deleted in" are context; language, state and the action are
 *      the point. So at a laptop width nothing overflows at all.
 *   2. **The action cell is sticky to the right edge.** If a narrow window or a
 *      long language name does force a scroll, Download stays put instead of
 *      hiding. Its background is opaque and follows the row hover, otherwise the
 *      scrolled content shows through it.
 *   3. **Under 640px there is no table at all** - `JobsList` stacks each dub, because
 *      on a phone even language + state + action did not fit, and the sticky cell then
 *      sat on top of the state pill.
 *
 * Colour: the language dot and the state are the two things somebody scans for in
 * a list of five simultaneous dubs, so those carry the hue. The row itself stays
 * neutral — colouring whole rows in a dense table is how a table becomes unreadable.
 */
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { type JobSummary } from '../lib/api';
import { languageDot, languageLabel, minutes, until, when } from '../lib/format';
import { buttonClass } from '../ui/Button';
import { JobStateBadge } from './JobStateBadge';
import { DownloadMenuIcon } from './DownloadMenu';

/**
 * "Open", as something that is obviously a button.
 *
 * It was a GHOST button - no fill, no border, grey text - so in a row of grey text it
 * read as a label, not as the way into the job. It is now the secondary style (a filled
 * pill with a 2px border), and it is a real link carrying the button's look rather than
 * a <button> inside an <a>.
 */
function OpenLink({ job }: { job: JobSummary }) {
  return (
    <Link
      to={`/app/jobs/${job.job_id}`}
      // The visible word first, so a voice user saying "Open" still hits it; the
      // language tells a screen-reader user WHICH of several Opens this is.
      aria-label={`Open ${languageLabel(job.target_lang)} dub`}
      className={buttonClass({ variant: 'secondary', size: 'sm' })}
    >
      Open
    </Link>
  );
}

/** The phone row's second line: how long the video is kept, or when the dub started. */
function keptFor(j: JobSummary): string {
  if (j.deleted_at) return 'video deleted';
  if (!j.expires_at) return when(j.created_at);
  const left = until(j.expires_at);
  return left === 'expired' ? 'video expired' : `deleted in ${left}`;
}

/** The row's action: the download menu when there is a file, otherwise Open. */
function RowAction({ job }: { job: JobSummary }) {
  // A menu, not a single link: there are four formats now, and the one a creator wants
  // is usually not the video.
  return job.can_download ? <DownloadMenuIcon jobId={job.job_id} /> : <OpenLink job={job} />;
}

/**
 * THE PHONE LAYOUT: one stacked row per dub, and no table at all.
 *
 * Under 640px the table needed more width than the screen had - the state pill alone is
 * ~240px for a working stage - so it scrolled sideways: the "Language" header was cut off
 * at the left and the sticky action column sat on top of the state pill. Here nothing
 * can overflow: the name and the pill truncate, and the action has its own column.
 */
function JobsList({ jobs }: { jobs: JobSummary[] }) {
  return (
    <ul className="divide-y divide-ink-700 sm:hidden">
      {jobs.map((j) => (
        <li key={j.job_id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-2 text-small font-medium">
              <span
                className={clsx('size-2 shrink-0 rounded-full', languageDot(j.target_lang))}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">{languageLabel(j.target_lang)}</span>
            </p>
            <div className="mt-1.5 flex min-w-0">
              <JobStateBadge state={j.state} errorCode={j.error_code} truncate />
            </div>
            <p className="mt-1 truncate text-tiny text-fg-subtle">
              {minutes(j.minutes_quoted)} · {keptFor(j)}
            </p>
          </div>
          <div className="shrink-0">
            <RowAction job={j} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Shared so the header and the cells cannot drift apart. */
const COLS = {
  id: 'hidden sm:table-cell',
  lang: '',
  state: '',
  minutes: 'hidden md:table-cell',
  expires: 'hidden lg:table-cell',
  created: 'hidden xl:table-cell',
} as const;

export function JobsTable({ jobs }: { jobs: JobSummary[] }) {
  return (
    <>
    <JobsList jobs={jobs} />
    {/* From 640px up. `relative` is what the sticky cell positions against. */}
    <div className="relative hidden overflow-x-auto sm:block">
      <table className="w-full text-left text-small">
        <thead>
          <tr className="border-b border-ink-700 text-eyebrow uppercase text-fg-subtle">
            <th className={clsx('px-4 py-2.5 font-medium', COLS.id)}>Job</th>
            <th className={clsx('px-4 py-2.5 font-medium', COLS.lang)}>Language</th>
            <th className={clsx('px-4 py-2.5 font-medium', COLS.state)}>State</th>
            <th className={clsx('px-4 py-2.5 font-medium', COLS.minutes)}>Minutes</th>
            <th className={clsx('px-4 py-2.5 font-medium', COLS.expires)}>Deleted in</th>
            <th className={clsx('px-4 py-2.5 font-medium', COLS.created)}>Created</th>
            <th className="sticky right-0 bg-ink-850 px-4 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-700">
          {jobs.map((j) => (
            <tr
              key={j.job_id}
              className="group transition-colors duration-[160ms] ease-[var(--ease-out-strong)] hover:bg-ink-800/60"
            >
              <td className={clsx('px-4 py-3', COLS.id)}>
                <Link
                  to={`/app/jobs/${j.job_id}`}
                  className="font-mono text-tiny text-fg-muted underline-offset-2 transition-colors duration-[160ms] hover:text-fg hover:underline"
                >
                  {j.job_id}
                </Link>
              </td>

              <td className={clsx('px-4 py-3', COLS.lang)}>
                <span className="flex items-center gap-2 whitespace-nowrap font-medium">
                  <span
                    className={clsx('size-2 shrink-0 rounded-full', languageDot(j.target_lang))}
                    aria-hidden="true"
                  />
                  {languageLabel(j.target_lang)}
                </span>
              </td>

              <td className={clsx('px-4 py-3', COLS.state)}>
                {/* Capped below lg, so a long stage name cannot widen the table into a
                    sideways scroll that slides it under the sticky action cell. */}
                <span className="flex max-w-[13rem] lg:max-w-none">
                  <JobStateBadge state={j.state} errorCode={j.error_code} truncate />
                </span>
              </td>

              <td className={clsx('px-4 py-3 tabular-nums whitespace-nowrap text-fg-muted', COLS.minutes)}>
                {minutes(j.minutes_quoted)}
              </td>
              <td className={clsx('px-4 py-3 whitespace-nowrap text-fg-muted', COLS.expires)}>
                {j.deleted_at ? 'deleted' : until(j.expires_at)}
              </td>
              <td className={clsx('px-4 py-3 whitespace-nowrap text-fg-subtle', COLS.created)}>
                {when(j.created_at)}
              </td>

              {/*
                Sticky, opaque, and it tracks the row hover. `bg-ink-850` matches
                the Card; without an opaque background the scrolled columns would
                slide visibly underneath the button.
              */}
              <td className="sticky right-0 bg-ink-850 px-4 py-3 text-right transition-colors duration-[160ms] group-hover:bg-[#161a1f]">
                <RowAction job={j} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

/**
 * The download arrow, which nudges down 2px on hover.
 *
 * It used to be a whole `DownloadButton` — a white pill, monochrome because colour
 * is spent on state elsewhere in this table, so the action was the highest-contrast
 * thing in the row. Now that a download is a CHOICE of four formats rather than one
 * link, the button belongs to `DownloadMenu` and only the glyph is shared: it is the
 * affordance people have already learned, and dropping it because the button around
 * it changed would have thrown away the recognisable part.
 *
 * Frequency tier is "occasional" and the purpose is feedback, so it earns motion.
 * Gated to fine pointers because a tap on touch fires a false hover that would leave
 * the arrow parked in its moved position.
 */
export function DownloadGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className={clsx(
        'size-3.5 shrink-0',
        'transition-transform duration-[160ms] ease-[var(--ease-out-strong)]',
        'pointer-fine:group-hover/dl:translate-y-0.5',
        'motion-reduce:transition-none motion-reduce:group-hover/dl:translate-y-0',
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />
    </svg>
  );
}
