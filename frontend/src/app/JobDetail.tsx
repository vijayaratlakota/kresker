/**
 * One job: progress while it runs, transcript and download when it is done.
 *
 * The transcript table is the reason this product has a database. It is read from
 * our own rows, never from the engine, so it is here after a refresh, after a
 * crash, and after the GPU box has been shut down and its scratch storage wiped.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, type JobDetail as Job } from '../lib/api';
import { bytes, duration, languageLabel, minutes, onDay, until, when } from '../lib/format';
import { Button } from '../ui/Button';
import { Badge, Card, ErrorNote, InfoNote, Progress, Skeleton } from '../ui/primitives';
import { useJobProgress } from './useJobProgress';
import { JobStateBadge } from './JobStateBadge';
import { DownloadMenu } from './DownloadMenu';
import { DubPlayer } from './DubPlayer';

export function JobDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const live = useJobProgress(job && !isDone(job.state) ? id : null);

  const load = useCallback(async () => {
    try {
      setJob(await api.jobs.get(id));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'That job does not exist, or it is not yours.'
          : err instanceof Error
            ? err.message
            : 'Could not load this job.',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload once for the real payload — the poll gives state and events, but the
  // transcript, retention date and download flag only come from the detail route.
  useEffect(() => {
    if (live.finished) void load();
  }, [live.finished, load]);

  async function deleteVideo() {
    if (
      !window.confirm(
        'Delete this video now? This cannot be undone, and it does not give the minutes back.',
      )
    )
      return;
    setDeleting(true);
    try {
      await api.jobs.deleteVideo(id);
      toast.success('Video deleted');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete it.');
    } finally {
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <div className="px-5 py-8 sm:px-8 lg:px-10">
        <ErrorNote>{error}</ErrorNote>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/app')}>
          Back to dubbing
        </Button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="space-y-4 px-5 py-8 sm:px-8 lg:px-10">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const state = live.state ?? job.state;
  const percent = live.state ? live.percent : job.percent;
  const running = !isDone(state);
  const events = live.events.length ? live.events : job.events;

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      {/* `-ml-2 px-2 py-2` plus `data-touch-target`: this was a bare 21px text line,
          and it is the only way back from a job page on a phone. */}
      <Link
        to="/app"
        data-touch-target
        className="-ml-2 mb-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-small text-fg-muted transition-colors duration-[160ms] hover:text-fg"
      >
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Dubbing
      </Link>

      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-h3">
            Dub into {languageLabel(job.target_lang)}
          </h1>
          <p className="mt-1 font-mono text-tiny text-fg-subtle">{job.job_id}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <JobStateBadge state={state} errorCode={job.error_code} />
          {job.can_download && <DownloadMenu jobId={job.job_id} />}
        </div>
      </header>

      {running && (
        <Card className="mb-6 p-5">
          <Progress value={percent} indeterminate={percent < 1} />
          <p className="mt-3 text-small text-fg-muted">
            {events.at(-1)?.detail ?? 'Working…'}
          </p>
        </Card>
      )}

      {state === 'failed' && (
        <div className="mb-6">
          {/*
            THE RAW DETAIL IS GONE FROM THE CUSTOMER'S VIEW.

            `error_detail` used to be printed here verbatim in a monospace block. What
            fails at this stage is almost always the engine describing itself, so a
            failed dub handed the customer internal stage names, the paths it would
            otherwise have served, and our own refusal messages. The backend now sends
            that field to admins only, so this renders it when it is there and shows a
            plain sentence when it is not.

            The code stays: it is short, stable, and the thing support asks them to quote.
          */}
          <ErrorNote>
            <p className="font-medium">This dub could not be completed</p>
            <p className="mt-1.5">
              Nothing was charged for it — the minutes are back on your plan. Try again,
              and if it keeps failing, contact us
              {job.error_code ? (
                <>
                  {' '}
                  and quote <span className="font-mono">{job.error_code}</span>
                </>
              ) : null}
              .
            </p>
            {job.error_detail && (
              <p className="mt-2 whitespace-pre-wrap font-mono text-tiny opacity-80">
                {job.error_detail.slice(0, 600)}
              </p>
            )}
          </ErrorNote>
        </div>
      )}

      {job.deleted_at && (
        <div className="mb-6">
          <InfoNote>
            This video was deleted {job.deleted_by === 'user' ? 'by you' : 'automatically'} on{' '}
            {onDay(job.deleted_at)}. The transcript and translation below are kept.
          </InfoNote>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Meta label="Minutes used" value={minutes(job.minutes_quoted)} />
        <Meta label="File size" value={bytes(job.output_bytes)} />
        <Meta label="Downloads" value={String(job.download_count)} />
        <Meta
          label="Deleted"
          value={job.deleted_at ? 'already' : until(job.expires_at)}
          hint={job.expires_at && !job.deleted_at ? onDay(job.expires_at) : undefined}
        />
      </div>

      {job.can_download && (
        <Card className="mb-6 p-5">
          {/* Watch it here first. See DubPlayer for why the src is a minted token
              rather than the download path. */}
          <DubPlayer jobId={job.job_id} targetLang={job.target_lang} />

          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-ink-700 pt-4">
            <div>
              <p className="text-small font-medium">Take it away</p>
              <p className="mt-1 text-tiny text-fg-subtle">
                The video has one audio track — the dub — set as default and tagged{' '}
                {languageLabel(job.target_lang)}. Unlimited downloads until{' '}
                {onDay(job.expires_at)}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {/*
                Iris, and the only iris on this page. Downloading the thing you paid
                for IS this screen — the button in the header above is the same action
                at a lower weight, so it stays white.
              */}
              <DownloadMenu jobId={job.job_id} variant="iris" />
              <Button variant="danger" onClick={deleteVideo} loading={deleting}>
                Delete now
              </Button>
            </div>
          </div>
          {/*
            Which format, and why. This is where that guidance lives now — the menu
            itself is just four extensions, because nobody reads a paragraph while
            picking a file type, and four paragraphs made the dropdown taller than the
            page it opened over.
          */}
          <div className="mt-3 space-y-1.5 border-t border-ink-700 pt-3 text-tiny leading-relaxed text-fg-subtle">
            <p>
              <span className="font-mono text-fg-muted">MP4</span> is the dubbed video.{' '}
              <span className="font-mono text-fg-muted">M4A</span> is the dub&rsquo;s
              audio on its own, cut out losslessly —{' '}
              <span className="font-mono text-fg-muted">MP3</span> and{' '}
              <span className="font-mono text-fg-muted">WAV</span> are there for tools
              that insist on them.
            </p>
            <p>
              <span className="text-fg-muted">Reaching more of YouTube:</span> add the
              M4A to your original video under Subtitles → Audio tracks. Same video,
              same URL, same view count — a viewer whose language matches hears the dub
              automatically. The track is the same length as your picture, which is what
              YouTube checks before accepting it.
            </p>
          </div>
        </Card>
      )}

      {job.segments.length > 0 && (
        <Card className="mb-6 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700 px-5 py-4">
            <div>
              <h2 className="text-body font-medium">Transcript and translation</h2>
              <p className="mt-0.5 text-tiny text-fg-subtle">
                Kept with your dub, not with the video file — which is
                why it is still here after a refresh.
              </p>
            </div>
            <Badge tone="neutral">{job.segments.length} lines</Badge>
          </div>

          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-left text-small">
              <thead className="sticky top-0 bg-ink-850">
                <tr className="border-b border-ink-700 text-eyebrow uppercase text-fg-subtle">
                  <th className="w-12 px-5 py-2.5 font-medium">#</th>
                  <th className="w-28 px-3 py-2.5 font-medium">Time</th>
                  <th className="w-24 px-3 py-2.5 font-medium">Speaker</th>
                  <th className="px-3 py-2.5 font-medium">Original</th>
                  <th className="px-5 py-2.5 font-medium">
                    {languageLabel(job.target_lang)}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700 align-top">
                {job.segments.map((s) => (
                  <tr key={s.seg_id} className="transition-colors duration-[160ms] hover:bg-ink-800/50">
                    <td className="px-5 py-3 font-mono text-tiny text-fg-subtle">
                      {s.ordinal}
                    </td>
                    <td className="px-3 py-3 font-mono text-tiny text-fg-subtle">
                      {s.start != null ? duration(s.start) : '—'}
                    </td>
                    <td className="px-3 py-3 text-tiny text-fg-muted">{s.speaker ?? '—'}</td>
                    <td className="px-3 py-3 text-fg-muted">{s.source_text ?? '—'}</td>
                    <td className="px-5 py-3">{s.translated_text ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-ink-700 px-5 py-4">
          <h2 className="text-body font-medium">What happened, step by step</h2>
        </div>
        <ol className="divide-y divide-ink-700">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex gap-4 px-5 py-2.5 text-tiny">
              <span className="w-32 shrink-0 font-mono text-fg-subtle">{when(e.at)}</span>
              <span className={clsx('w-24 shrink-0', e.state ? 'text-fg-muted' : 'text-transparent')}>
                {e.state ?? '·'}
              </span>
              <span className="min-w-0 flex-1 text-fg-muted">{e.detail}</span>
            </li>
          ))}
        </ol>
      </Card>

      {/*
        THE PRESET STAMP IS GONE FROM THE CUSTOMER'S PAGE.

        It printed our internal configuration version and the first twelve characters of
        its hash, in monospace, on every finished dub. The intent was good — it is the
        evidence that two dubs made a month apart were produced the same way — but the
        version string and the hash are ours, not theirs, and nobody outside this team can
        do anything with either. Both are still recorded on the job and still shown in the
        admin view, which is where that evidence is actually used.
      */}
    </div>
  );
}

function Meta({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3.5">
      <p className="text-eyebrow uppercase text-fg-subtle">{label}</p>
      <p className="mt-1 text-h5 font-medium tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-tiny text-fg-subtle">{hint}</p>}
    </div>
  );
}

const isDone = (s: string) => s === 'done' || s === 'failed' || s === 'cancelled';
