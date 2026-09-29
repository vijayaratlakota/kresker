import type { ComponentProps } from 'react';
import { Badge } from '../ui/primitives';
import { STAGE_LABEL } from '../lib/format';

/**
 * Every working stage used to be the same grey `brand` tone, which made a list of
 * five simultaneous dubs a wall of identical pills — you had to read all five to
 * find the one that was nearly done. Each stage now has its own colour, running
 * cool to warm through the pipeline, so the position in the run is legible before
 * the label is read.
 */
const TONE: Record<string, ComponentProps<typeof Badge>['tone']> = {
  queued: 'neutral',
  claimed: 'prepare',
  preparing: 'prepare',
  transcribing: 'listen',
  translating: 'translate',
  rendering: 'speak',
  exporting: 'deliver',
  done: 'good',
  failed: 'bad',
  cancelled: 'warn',
};

/**
 * One place that decides how a job state looks, so the table, the detail page and
 * the running panel can never disagree about what "exporting" means.
 */
export function JobStateBadge({
  state,
  errorCode,
  truncate,
  className,
}: {
  state: string;
  errorCode?: string | null;
  /**
   * Let the pill shrink and end in an ellipsis instead of keeping its full width.
   * For rows where width is scarce - a phone - and the pill must never push, or sit on,
   * the text beside it. The full label stays in `title` and in the accessible text.
   */
  truncate?: boolean;
  className?: string;
}) {
  const working =
    state !== 'done' && state !== 'failed' && state !== 'cancelled' && state !== 'queued';
  const label = `${STAGE_LABEL[state] ?? state}${errorCode && state === 'failed' ? ` · ${errorCode}` : ''}`;
  return (
    <Badge
      tone={TONE[state] ?? 'neutral'}
      dot={working}
      pulse={working}
      truncate={truncate}
      className={className}
      title={truncate ? label : undefined}
    >
      {label}
    </Badge>
  );
}
