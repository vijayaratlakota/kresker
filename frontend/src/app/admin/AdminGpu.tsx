/**
 * GPU controls.
 *
 * The three buttons are deliberately not equals. "Stop if idle" obeys every
 * condition the watchdog obeys, so it cannot kill a render. "Force stop" ignores
 * all of them, which is why it is red, asks for confirmation, names what it will
 * interrupt, and is written to the audit log.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, type GpuState } from '../../lib/api';
import { ago, when } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Badge, Card, ErrorNote, InfoNote, Skeleton } from '../../ui/primitives';

const CONDITIONS = [
  ['A job is being worked on', 'obvious, and the expensive one to get wrong'],
  ['A job is queued', 'it is about to be worked on'],
  [
    'An upload has no job yet',
    'a slow uploader must not have the box shut down underneath them and pay for a second boot',
  ],
  [
    'The last job finished recently',
    'a boot costs about six minutes of GPU time either way, so stopping just before the next job arrives is the most expensive move available',
  ],
];

export function AdminGpu() {
  const [gpu, setGpu] = useState<GpuState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGpu(await api.admin.gpu());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the instance state.');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  async function act(what: 'start' | 'stop' | 'force') {
    if (what === 'force') {
      const holding = gpu?.hold_reason;
      const message = holding
        ? `Force stop ignores every safety condition. Right now: ${holding}. This WILL interrupt that. Continue?`
        : 'Force stop ignores every safety condition, including a render in progress. Continue?';
      if (!window.confirm(message)) return;
    }
    setBusy(what);
    try {
      // THE TOAST HAS TO MATCH WHAT HAPPENED. This used to say "Force stopped" for any
      // 200 - including a stop AWS had refused, while the box kept billing - and a green
      // "Stop requested" when the idle stop had declined to act at all.
      if (what === 'start') {
        const res = await api.admin.gpuStart();
        toast.success('Warming up', { description: res.note });
      } else if (what === 'force') {
        // A refused stop is an error from the server, so reaching here means AWS took it.
        const res = await api.admin.gpuStop(true);
        toast.success('Stop sent to AWS', {
          description: res.was_holding
            ? `It was holding for: ${res.was_holding}. The box takes a minute or two to shut down.`
            : 'The box takes a minute or two to shut down. This page updates by itself.',
        });
      } else {
        const res = await api.admin.gpuStop(false);
        const why = res.why ? String(res.why) : undefined;
        if (res.acted) {
          toast.success('Stopping', { description: why });
        } else if (why?.startsWith('stop failed')) {
          toast.error('The stop failed', { description: why });
        } else {
          // Declined on purpose: something still needs the box, or it is not running.
          toast.message('Not stopped', { description: why });
        }
      }
      window.setTimeout(load, 1500);
    } catch (err) {
      toast.error(what === 'force' ? 'Force stop failed' : 'That did not work', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  if (error && !gpu) {
    return (
      <div className="px-5 py-8 sm:px-8 lg:px-10">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }

  if (!gpu) {
    return (
      <div className="space-y-4 px-5 py-8 sm:px-8 lg:px-10">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-44" />
        <Skeleton className="h-56" />
      </div>
    );
  }

  const running = gpu.actual_state === 'running';
  const idleAndRunning = running && !gpu.hold_reason;

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      <header className="mb-7">
        <h1 className="text-h3">GPU box</h1>
        <p className="mt-1.5 text-body text-fg-muted">
          Starts by itself when a video is uploaded. Stops {gpu.idle_minutes} minutes after
          the last job finishes.
        </p>
      </header>

      {!gpu.enabled && (
        <div className="mb-6">
          <InfoNote>
            Automatic lifecycle is off — either the demo engine is in use, or
            <span className="font-mono"> VS_GPU_AUTO</span> is 0. Nothing here will start
            or stop a real machine.
          </InfoNote>
        </div>
      )}

      <Card className="mb-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                className={clsx(
                  'size-2.5 rounded-full',
                  running ? 'bg-bad' : gpu.actual_state === 'stopped' ? 'bg-good' : 'bg-warn',
                )}
              />
              <span className="text-h5">AWS says {gpu.actual_state}</span>
              {gpu.diverged && <Badge tone="bad">our table says {gpu.desired_state}</Badge>}
            </div>
            <p className="mt-2 font-mono text-tiny text-fg-subtle">
              {gpu.instance_id}
              {gpu.public_ip ? ` · ${gpu.public_ip}` : ''}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => act('start')} loading={busy === 'start'}>
              Warm it up
            </Button>
            <Button variant="secondary" onClick={() => act('stop')} loading={busy === 'stop'}>
              Stop if idle
            </Button>
            {/*
              Off when this server does not run the box (demo engine, or VS_GPU_AUTO=0):
              the note above promises nothing here touches a real machine, and the
              server now refuses a force stop in that state.
            */}
            <Button
              variant="danger"
              onClick={() => act('force')}
              loading={busy === 'force'}
              disabled={!gpu.enabled}
              title={gpu.enabled ? undefined : 'The GPU lifecycle is off on this server'}
            >
              Force stop
            </Button>
          </div>
        </div>

        <dl className="mt-6 grid gap-x-10 gap-y-2 text-small sm:grid-cols-2">
          <Row k="What is holding it" v={gpu.hold_reason ?? 'nothing'} tone={gpu.hold_reason ? 'hold' : 'free'} />
          <Row k="Idle shutdown after" v={`${gpu.idle_minutes} minutes`} />
          <Row k="Upload grace" v={`${gpu.upload_grace_minutes} minutes`} />
          <Row k="SSH tunnel" v={gpu.tunnel_up ? 'up' : 'down'} />
          <Row k="Engine answering" v={gpu.engine_answers ? 'yes' : 'no'} />
          <Row k="Last work finished" v={gpu.last_work_finished_at ? `${ago(gpu.last_work_finished_at)} (${when(gpu.last_work_finished_at)})` : 'never'} />
          <Row k="Last watchdog note" v={gpu.last_watchdog_note ?? '—'} />
          <Row k="Engine URL" v={gpu.engine_url ?? '—'} />
        </dl>

        {idleAndRunning && (
          <div className="mt-5">
            <ErrorNote>
              Running with nothing holding it. The watchdog will stop it within a minute.
              If it does not, the backend is probably not running — the scheduled task
              covers that case, but force stop is here either way.
            </ErrorNote>
          </div>
        )}
      </Card>

      <Card className="p-5 sm:p-6">
        <h2 className="text-h5">
          It refuses to stop while any of these hold
        </h2>
        <p className="mt-1.5 text-small text-fg-muted">
          Checked in this order, every 60 seconds, and re-checked under a lock right
          before the stop so a job arriving at the last moment is not lost.
        </p>
        <ol className="mt-5 space-y-3.5">
          {CONDITIONS.map(([what, why], i) => (
            <li key={what} className="flex gap-3.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink-800 font-mono text-tiny text-fg-subtle">
                {i + 1}
              </span>
              <div>
                <p className="text-small font-medium">{what}</p>
                <p className="mt-0.5 text-tiny leading-relaxed text-fg-subtle">{why}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'hold' | 'free' }) {
  return (
    <div className="flex justify-between gap-4 border-b border-ink-700/60 pb-2">
      <dt className="shrink-0 text-fg-subtle">{k}</dt>
      <dd
        className={clsx(
          'truncate text-right',
          tone === 'hold' && 'text-warn',
          tone === 'free' && 'text-fg-muted',
        )}
        title={v}
      >
        {v}
      </dd>
    </div>
  );
}
