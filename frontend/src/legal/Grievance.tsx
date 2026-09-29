/**
 * The grievance contact block. DPDP s.13(1) requires the means of contacting the
 * person who answers grievances to be PUBLISHED, so it appears on the Privacy Notice
 * and on the Contact page, and in the site footer once there is somebody to name.
 *
 * THE UNCONFIGURED CASE, which is where the design choice lives.
 *
 * `VS_GRIEVANCE_NAME` and `VS_GRIEVANCE_EMAIL` default to empty. Decision D-6 said
 * that when they are empty this should be LOUD rather than a tidy blank, because a
 * policy naming nobody looks finished and looking finished while being unreachable is
 * worse than having no page. That reasoning still holds — but the first version acted
 * on it in the wrong place, putting a red alert in the footer of every page including
 * the homepage.
 *
 * The warning exists so the OPERATOR cannot ship without noticing. A visitor cannot
 * fix it, and shouting at them on the landing page is noise that also makes the
 * product look broken. The operator already gets told in three places that can
 * actually be acted on: `GET /api/admin/dpdp` reports it as a failing check with the
 * fix named, the admin inbox renders that checklist at the top of the page, and it is
 * item 1 in DPDP_PROGRESS.md §7.
 *
 * So `unconfigured` decides what an empty contact looks like:
 *
 *   'warn'  the legal pages. A reader of the Privacy Notice is entitled to know that
 *           the grievance route is not published yet — that absence is information.
 *   'hide'  the footer. Nothing rather than an alarm. The moment the env vars are
 *           set the real contact appears there on every page, which is what s.13(1)
 *           actually asks for.
 */
import clsx from 'clsx';
import { useNotice } from './useNotice';

/**
 * Whether there is a contact worth rendering. Exported so a caller can leave out its
 * own heading and divider too — a section wrapper around a component that returned
 * null is how you get a stray horizontal rule with nothing under it.
 */
export function useGrievance() {
  const { notice } = useNotice();
  const grievance = notice?.grievance ?? null;
  return {
    grievance,
    /** Loaded, and an officer has been named. */
    hasContact: grievance?.configured === true,
  };
}

export function GrievanceBlock({
  compact,
  unconfigured = 'warn',
}: {
  compact?: boolean;
  unconfigured?: 'warn' | 'hide';
}) {
  const { notice } = useNotice();
  const g = notice?.grievance;

  if (!g) {
    // No skeleton: a shimmering block in the footer of every page is noise. It
    // appears when it appears.
    return null;
  }

  if (!g.configured) {
    if (unconfigured === 'hide') return null;
    return (
      <div
        role="alert"
        data-grievance="unconfigured"
        className={clsx(
          'rounded-xl border border-bad/40 bg-bad/10 text-bad',
          compact ? 'px-3.5 py-2.5 text-tiny leading-relaxed' : 'px-4 py-3.5 text-small leading-relaxed',
        )}
      >
        <strong className="font-medium">Grievance Officer not yet appointed.</strong>{' '}
        {g.note ??
          'This site must publish a grievance contact before it serves real users.'}
      </div>
    );
  }

  // The card chrome belongs here, not at the call site. Both branches need a box and
  // they need DIFFERENT boxes — the warning is red-bordered, the contact is grey — so
  // a wrapper at the call site produced a red alert nested inside a grey card.
  // `compact` is the footer, which sits inside the footer's own dividers and wants
  // no box at all.
  return (
    <div
      data-grievance="configured"
      className={clsx(
        compact
          ? 'text-tiny'
          : 'rounded-xl border border-ink-700 bg-ink-900 px-4 py-4 text-small',
      )}
    >
      <p className="font-medium text-fg">Grievance Officer</p>
      <p className="mt-1 leading-relaxed text-fg-muted">
        {g.name}
        <br />
        <a
          href={`mailto:${g.email}`}
          className="text-fg underline-offset-2 transition-colors duration-[160ms] hover:underline"
        >
          {g.email}
        </a>
        {g.address && (
          <>
            <br />
            <span className="text-fg-subtle">{g.address}</span>
          </>
        )}
      </p>
      {notice && (
        <p className="mt-2 leading-relaxed text-fg-subtle">
          We answer data-rights requests within {notice.rights_response_days} days.
        </p>
      )}
    </div>
  );
}
