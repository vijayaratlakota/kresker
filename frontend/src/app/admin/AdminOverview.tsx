/**
 * Admin overview.
 *
 * The GPU tile is the one that matters: it shows what AWS says, not what our own
 * table believes, because a box that is actually running while we think it is
 * stopped is the bug that quietly bills. When the two disagree the card says so
 * and tells you which to trust.
 */
import clsx from 'clsx';
import NumberFlow from '@number-flow/react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AdminOverview as Overview } from '../../lib/api';
import { ago } from '../../lib/format';
import { Badge, Card, ErrorNote, Skeleton } from '../../ui/primitives';

export function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.admin.overview());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the overview.');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (error) {
    return (
      <div className="px-5 py-8 sm:px-8 lg:px-10">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="grid gap-4 px-5 py-8 sm:grid-cols-2 sm:px-8 lg:grid-cols-4 lg:px-10">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  const gpu = data.gpu;
  const boxRunning = gpu.actual_state === 'running';

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      <header className="mb-7">
        <h1 className="text-h3">Overview</h1>
        <p className="mt-1.5 text-body text-fg-muted">{data.earnings.note}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Collected, all time" value={data.earnings.total_rupees} prefix="₹" />
        <Stat label="Today" value={data.earnings.today_rupees} prefix="₹" />
        <Stat label="This week" value={data.earnings.week_rupees} prefix="₹" />
        <Stat label="Subscribers" value={data.subscribers} />
        <Stat label="Accounts" value={data.users} />
        <Stat label="Signed in now" value={data.sessions_active} />
        <Stat label="Jobs today" value={data.jobs_today} />
        <Stat
          label="In flight"
          value={data.jobs_running + data.jobs_queued}
          hint={`${data.jobs_running} running · ${data.jobs_queued} queued`}
        />
      </div>

      <p className="mt-3 text-tiny text-fg-subtle">
        Earnings are cash collected with refunds subtracted, in {data.earnings.timezone}.
        A gifted subscription is recorded as a gift and never adds to this figure.
      </p>

      {/* GPU */}
      <Card className="mt-7 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-h5">The GPU box</h2>
              <Badge tone={boxRunning ? 'bad' : gpu.actual_state === 'stopped' ? 'good' : 'warn'} dot>
                AWS says {gpu.actual_state}
              </Badge>
              {gpu.diverged && <Badge tone="bad">Our table disagrees</Badge>}
            </div>
            <p className="mt-2 font-mono text-tiny text-fg-subtle">{gpu.instance_id}</p>

            <dl className="mt-4 grid gap-x-8 gap-y-1.5 text-small sm:grid-cols-2">
              <Row k="What is holding it" v={gpu.hold_reason ?? 'nothing'} />
              <Row k="Idle shutdown after" v={`${gpu.idle_minutes} min`} />
              <Row k="Last work finished" v={ago(gpu.last_work_finished_at)} />
              <Row k="Engine answering" v={gpu.engine_answers ? 'yes' : 'no'} />
            </dl>
          </div>

          <Link to="/app/admin/gpu">
            <span className="text-small text-fg underline-offset-2 hover:underline">Manage →</span>
          </Link>
        </div>

        {boxRunning && !gpu.hold_reason && (
          <div className="mt-5">
            <ErrorNote>
              The box is running with nothing holding it. The watchdog stops it within a
              minute — if it does not, force stop it from the GPU page. Every minute it
              runs idle is money.
            </ErrorNote>
          </div>
        )}

        {gpu.diverged && (
          <div className="mt-5">
            <ErrorNote>
              AWS and our own record disagree about the instance state. Trust AWS:{' '}
              {gpu.actual_state}.
            </ErrorNote>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * NumberFlow animates the digits rather than swapping the text, so a value that
 * ticks up on a 15-second poll reads as a change instead of a flicker. It is here
 * and nowhere else: this is a screen glanced at occasionally, not a working list.
 */
function Stat({
  label,
  value,
  prefix,
  hint,
}: {
  label: string;
  value: number;
  prefix?: string;
  hint?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-eyebrow uppercase text-fg-subtle">{label}</p>
      <p className="mt-1.5 flex items-baseline text-h3 tabular-nums leading-none">
        {prefix && <span className="mr-0.5 text-fg-muted">{prefix}</span>}
        <NumberFlow
          value={value}
          format={{ maximumFractionDigits: 2 }}
          respectMotionPreference
        />
      </p>
      {hint && <p className="mt-1.5 text-tiny text-fg-subtle">{hint}</p>}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-fg-subtle">{k}</dt>
      <dd className={clsx('text-right', v === 'nothing' && 'text-fg-muted')}>{v}</dd>
    </div>
  );
}
