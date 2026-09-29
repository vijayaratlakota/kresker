/**
 * The Dubbing page: upload, choose a language, watch it run.
 *
 * The flow deliberately mirrors what the backend does, because the honest version
 * is also the reassuring one:
 *
 *   upload  →  the GPU box starts NOW, underneath the upload, so nobody waits on
 *              a six-minute boot after their file has finished sending
 *   create  →  the job exists in the database from this moment
 *   poll    →  progress read from the database, which is why a refresh is free
 */
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  api,
  ApiError,
  type CreatedJobEntry,
  type Entitlement,
  type JobSummary,
  type UploadResult,
} from '../lib/api';
import {
  MAX_LANGS_PER_BATCH,
  STAGE_LABEL,
  duration,
  isTerminal,
  languageDot,
  languageLabel,
  minutes,
  stageColor,
  when,
} from '../lib/format';
import { isAdmin, useSession } from '../lib/session';
import { Button } from '../ui/Button';
import { Badge, Card, EmptyState, ErrorNote, InfoNote, Progress, Skeleton } from '../ui/primitives';
import { useUploadConsent } from '../legal/useUploadConsent';
import { Dropzone, FileSummary } from './Dropzone';
import { probeDuration } from '../lib/videoMeta';
import { useBatchProgress, type BatchProgress } from './useBatchProgress';
import { JobStateBadge } from './JobStateBadge';
import { JobsTable } from './JobsTable';
import { DownloadMenuIcon } from './DownloadMenu';
import { LanguagePicker } from './LanguagePicker';

type Phase = 'idle' | 'checking' | 'uploading' | 'probed' | 'starting' | 'running';

/** Stable empty array, so "not watching anything" is not a new value each render. */
const EMPTY: string[] = [];

export function Dubbing() {
  const me = useSession((s) => s.me);
  const setEntitlement = useSession((s) => s.setEntitlement);

  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [uploadPct, setUploadPct] = useState(0);
  const [probe, setProbe] = useState<UploadResult | null>(null);
  // A set of languages, not one. Order matters: it is the order they get queued
  // in, so the first one picked comes back first.
  //
  // Starts EMPTY. It used to default to Telugu, which is a decision made on the
  // customer's behalf that costs them minutes if they do not notice it — the kind
  // of default somebody only finds out about after paying for a dub they did not
  // ask for. The button says "Pick a language" until they have.
  const [langs, setLangs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<CreatedJobEntry[]>([]);
  // Set when a video is refused before it is uploaded, so the reason can be shown as a
  // proper explanation with the numbers in it rather than a one-line error.
  const [refused, setRefused] = useState<{
    file: File;
    durationS: number;
    reason: 'length' | 'minutes';
  } | null>(null);

  const [jobs, setJobs] = useState<JobSummary[] | null>(null);

  // Writes the DPDP s.6 record for the upload. It does not ask; see the note in
  // useUploadConsent about where the two checkboxes went.
  const uploadConsent = useUploadConsent();

  const watching = phase === 'running' ? batch.map((b) => b.job_id) : EMPTY;
  const progress = useBatchProgress(watching);

  const loadJobs = useCallback(async () => {
    try {
      const res = await api.jobs.list();
      setJobs(res.jobs);
      setEntitlement(res.entitlement);
    } catch {
      setJobs([]);
    }
  }, [setEntitlement]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // Refresh the list once the watched job finishes, so the table is right without
  // the customer reloading.
  useEffect(() => {
    if (progress.finished) void loadJobs();
  }, [progress.finished, loadJobs]);

  const reset = () => {
    setFile(null);
    setProbe(null);
    setPhase('idle');
    setUploadPct(0);
    setError(null);
    setBatch([]);
    setRefused(null);
  };

  // Toggling individual codes moved into LanguagePicker, which owns the selection
  // UI now. The page still holds the array, because the ORDER is the queue order.

  /**
   * Send the file. `trim` is set only when the customer chose a section.
   *
   * NOTHING IS WOKEN HERE ANY MORE. This used to fire a warm-up request the instant a
   * file was picked, so the six-minute boot ran underneath the transfer. Uploading is
   * not a decision to buy a dub, and paying for capacity from that moment meant paying
   * for every person who picked a file and changed their mind. The wake now happens
   * when `dub()` is called, which is where the minutes are charged too.
   */
  const send = useCallback(
    async (picked: File) => {
      setError(null);
      setRefused(null);
      setFile(picked);
      setPhase('uploading');
      setUploadPct(0);

      try {
        // Straight into storage where possible, through us when not. See `sendVideo`.
        const res = await api.jobs.upload(picked, setUploadPct);
        setProbe(res);
        setEntitlement(res.entitlement);
        setPhase('probed');
      } catch (err) {
        setFile(null);
        setPhase('idle');
        // The server refused it on length or minutes. Only reachable when the browser
        // could not read the duration itself — a container <video> will not open — so
        // show the same explanation, built from the server's numbers.
        if (err instanceof ApiError && err.detail) {
          const measured = Number(err.detail.duration_s);
          if (
            (err.code === 'video_too_long' || err.code === 'not_enough_minutes') &&
            Number.isFinite(measured) &&
            measured > 0
          ) {
            setRefused({
              file: picked,
              durationS: measured,
              reason: err.code === 'video_too_long' ? 'length' : 'minutes',
            });
            return;
          }
        }
        setError(err instanceof ApiError ? err.message : 'The upload failed.');
      }
    },
    [setEntitlement],
  );

  async function handlePick(picked: File) {
    setError(null);
    setRefused(null);

    // Recorded before a byte moves, so the row cannot be dated after the data it
    // covers. Best effort: it does not block the upload. See useUploadConsent.
    await uploadConsent.record();

    // MEASURED BEFORE ANYTHING IS SENT. This is the fix for the reported bug.
    //
    // A 1:06 video on a free plan used to be uploaded in full, over a phone connection,
    // and only then refused for being six seconds over. On a slow enough link Cloudflare
    // abandoned the request at a hundred seconds first and returned an error page, so the
    // customer got neither the dub nor a reason — and because the handler never ran, the
    // GPU was never even asked to start.
    //
    // Reading the length locally costs milliseconds and moves the refusal to before the
    // transfer, which is the only place it is any use.
    const ent0 = me?.entitlement;
    setFile(picked);
    setPhase('checking');
    const measured = await probeDuration(picked);

    // `null` means the browser could not tell, and that must not block the upload: a
    // <video> element opens far less than ffprobe does. The server still enforces both
    // limits and answers with a code `send` turns into the same explanation.
    if (measured != null && ent0 && !isAdmin(me)) {
      if (measured > ent0.max_video_seconds + 0.25) {
        setRefused({ file: picked, durationS: measured, reason: 'length' });
        setPhase('idle');
        return;
      }
      if (measured / 60 > ent0.minutes_left + 1e-6) {
        setRefused({ file: picked, durationS: measured, reason: 'minutes' });
        setPhase('idle');
        return;
      }
    }

    void send(picked);
  }

  async function startDub() {
    if (!probe || langs.length === 0) return;
    setError(null);
    setPhase('starting');
    try {
      const res = await api.jobs.create(probe.upload_id, langs);
      setBatch(res.jobs);
      setPhase('running');
      void loadJobs();
      toast.success(
        res.jobs.length === 1
          ? 'Your dub is running'
          : `${res.jobs.length} dubs are running`,
        {
          description:
            res.jobs.length === 1
              ? 'You can close this tab. It keeps going on our servers.'
              : 'They run one after another, so each gets our full attention. You can close this tab.',
        },
      );
    } catch (err) {
      setPhase('probed');
      setError(err instanceof ApiError ? err.message : 'Could not start the dub.');
    }
  }

  const ent = me?.entitlement;
  // What this batch will cost: the video's length once per language.
  const willUse = probe ? probe.minutes * langs.length : 0;
  const left = ent?.minutes_left ?? 0;
  // Checked here as well as on the server, so the button says no before the
  // request does. An admin bypasses the server check, so this stays advisory.
  const overBudget = !!ent && !isAdmin(me) && willUse > left + 1e-6;

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      <header className="mb-8">
        <h1 className="text-h3">Dubbing</h1>
        <p className="mt-1.5 text-body text-fg-muted">
          Upload a video, pick a language. Everything else is already set.
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <Card className="p-5 sm:p-6">
            {/*
              REFUSED BEFORE UPLOADING, and told why in full.

              This sits above the dropzone rather than replacing it, so the next attempt
              is one tap away. It is deliberately an explanation and not a one-line
              error: the customer has to know the video's real length, the limit it
              broke, and what to do about it — otherwise the only available guess is
              that the site is broken, which is what the raw Cloudflare page used to
              suggest.
            */}
            {phase === 'idle' && refused && (
              <div className="mb-5 rounded-xl border border-bad/40 bg-bad/[0.06] p-4">
                <p className="text-small font-medium text-fg">
                  {refused.reason === 'length'
                    ? 'This video is longer than your plan allows'
                    : 'This video needs more minutes than you have left'}
                </p>
                <p className="mt-1.5 text-tiny leading-relaxed text-fg-muted">
                  {refused.file.name} runs {duration(refused.durationS)}
                  {refused.reason === 'length' ? (
                    <>
                      , and {ent?.plan_name ?? 'your plan'} covers{' '}
                      {duration(ent?.max_video_seconds)} per video. Trim it to{' '}
                      {duration(ent?.max_video_seconds)} or less and upload it again.
                    </>
                  ) : (
                    <>
                      , which needs {minutes(refused.durationS / 60)}. You have{' '}
                      {minutes(left)} left on {ent?.plan_name ?? 'your plan'}. Upload a
                      shorter video, or top up your plan.
                    </>
                  )}
                </p>
                <p className="mt-2 text-tiny text-fg-subtle">
                  Nothing was uploaded, so none of your minutes were used.
                </p>
                {refused.reason === 'minutes' && (
                  <Link
                    to="/app/billing"
                    className="mt-3 inline-block text-tiny text-fg-muted underline underline-offset-2 hover:text-fg"
                  >
                    See plans
                  </Link>
                )}
              </div>
            )}

            {phase === 'idle' && (
              <>
                <Dropzone onPick={handlePick} maxSeconds={ent?.max_video_seconds} />
                {/*
                  One line instead of the two consent checkboxes that used to sit
                  above the dropzone. The voice-rights point is the part that
                  genuinely matters — it is the uploader asserting they may submit
                  somebody else's voice — so it is stated here rather than only
                  buried in the Disclaimer, and the rest is a link away.
                */}
                <p
                  data-upload-legal="true"
                  className="mt-4 text-center text-tiny leading-relaxed text-fg-subtle"
                >
                  By uploading you confirm you have the right to every voice in the file,
                  and agree to it being processed as described in our{' '}
                  <Link
                    to="/privacy"
                    className="text-fg-muted underline underline-offset-2 hover:text-fg"
                  >
                    Privacy Notice
                  </Link>{' '}
                  and{' '}
                  <Link
                    to="/disclaimer"
                    className="text-fg-muted underline underline-offset-2 hover:text-fg"
                  >
                    Disclaimer
                  </Link>
                  .
                </p>
              </>
            )}

            {/* Reading the length out of the file. Milliseconds normally, so this is
                only ever seen on a very large file, but without it the page looks
                frozen between the click and the upload starting. */}
            {phase === 'checking' && file && (
              <div className="stagger">
                <FileSummary file={file} onClear={reset} />
                <p className="mt-5 text-small text-fg-muted">Checking the length…</p>
              </div>
            )}

            {phase === 'uploading' && file && (
              <div className="stagger">
                <FileSummary file={file} onClear={reset} />
                <div className="mt-5">
                  <div className="mb-2 flex items-center justify-between text-small">
                    <span className="text-fg-muted">Uploading</span>
                    <span className="font-mono text-fg-subtle">
                      {Math.round(uploadPct * 100)}%
                    </span>
                  </div>
                  <Progress value={uploadPct * 100} />
                  <p className="mt-3 text-tiny leading-relaxed text-fg-subtle">
                    We start getting ready while this uploads, so there is no wait after
                    it finishes.
                  </p>
                </div>
              </div>
            )}

            {phase === 'probed' && probe && file && (
              <div className="stagger">
                <FileSummary file={file} onClear={reset} />

                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Fact label="Length" value={duration(probe.duration_s)} />
                  <Fact
                    label="Will use"
                    value={minutes(willUse)}
                    hint={
                      langs.length > 1
                        ? `${minutes(probe.minutes)} × ${langs.length} languages`
                        : undefined
                    }
                  />
                  <Fact
                    label="Left after this"
                    value={minutes(Math.max(0, left - willUse))}
                    tone={overBudget ? 'bad' : undefined}
                  />
                </div>

                <div className="mt-6 mb-2.5 flex items-end justify-between gap-4">
                  <div>
                    <p className="text-small font-medium text-fg-muted">Dub into</p>
                    <p className="mt-0.5 text-tiny text-fg-subtle">
                      Up to {MAX_LANGS_PER_BATCH} at a time. Each one is a separate
                      video, billed separately, and they run one after another.
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {/*
                      THE "ALL" BUTTON IS GONE, and this is the note explaining why so
                      nobody adds it back as an obvious missing convenience.

                      It selected the whole catalogue. That was fine at twelve. At
                      forty-three, with MAX_LANGS_PER_REQUEST at eight, it builds a
                      request the API answers with a 400 - a control whose only function
                      is to produce an error. Capping it to the first eight instead would
                      be worse: a button labelled "All" that quietly picks eight of
                      forty-three is a lie, and which eight is a product decision, not a
                      default. The picker has search, which is the faster path anyway.
                    */}
                    <MiniButton onClick={() => setLangs([])} disabled={langs.length === 0}>
                      None
                    </MiniButton>
                  </div>
                </div>

                <LanguagePicker value={langs} onChange={setLangs} />

                {overBudget && (
                  <div className="mt-5">
                    <ErrorNote>
                      {langs.length} languages need {minutes(willUse)} and you have{' '}
                      {minutes(left)} left. Take some languages off, or top up your plan.
                    </ErrorNote>
                  </div>
                )}

                {error && (
                  <div className="mt-5">
                    <ErrorNote>{error}</ErrorNote>
                  </div>
                )}

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <Button
                    size="lg"
                    onClick={startDub}
                    disabled={langs.length === 0 || overBudget}
                  >
                    {langs.length === 0
                      ? 'Pick a language'
                      : langs.length === 1
                        ? `Dub into ${languageLabel(langs[0])}`
                        : `Dub into ${langs.length} languages`}
                  </Button>
                  <Button size="lg" variant="ghost" onClick={reset}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {(phase === 'starting' || phase === 'running') && (
              <BatchPanel
                batch={batch}
                progress={progress}
                onAnother={() => {
                  reset();
                  void loadJobs();
                }}
              />
            )}

            {phase === 'idle' && error && (
              <div className="mt-5">
                <ErrorNote>{error}</ErrorNote>
              </div>
            )}
          </Card>

          <RecentDubs jobs={jobs} onChanged={loadJobs} />
        </div>

        <aside className="space-y-4">
          <PlanCard entitlement={ent} />
          <Card className="p-5">
            <h3 className="text-small font-medium">What you get back</h3>
            {/*
              A hue per promise. Five identical green ticks is a texture; five
              colours makes the list read as five distinct guarantees.
            */}
            <ul className="mt-3 space-y-2.5 text-tiny leading-relaxed text-fg-muted">
              {(
                [
                  ['One MP4 with the dub as its default audio track', 'text-stage-prepare'],
                  ['Tagged with the language, so players label it properly', 'text-stage-listen'],
                  ['The original audio is not bundled alongside it', 'text-stage-translate'],
                  ['Each line fitted to its original time slot', 'text-stage-speak'],
                  ['Your footage never stretched or retimed', 'text-good'],
                ] as const
              ).map(([t, hue]) => (
                <li key={t} className="flex gap-2">
                  <svg viewBox="0 0 24 24" className={clsx('mt-0.5 size-3.5 shrink-0', hue)} fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {t}
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'bad';
}) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-3">
      <p className="text-eyebrow uppercase text-fg-subtle">{label}</p>
      <p
        className={clsx(
          'mt-1 text-lead font-medium tabular-nums',
          tone === 'bad' && 'text-bad',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-tiny tabular-nums text-fg-subtle">{hint}</p>}
    </div>
  );
}

/** The small "None" affordance above the language picker. See the note at its use. */
function MiniButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'rounded-full border-2 border-ink-600 px-2.5 py-1 text-tiny',
        'transition-[background-color,color,border-color] duration-[160ms]',
        'ease-[var(--ease-out-strong)]',
        disabled
          ? 'cursor-not-allowed border-ink-700 text-fg-subtle/50'
          : 'text-fg-muted hover:border-ink-500 hover:bg-ink-800 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

const STAGES = ['preparing', 'transcribing', 'translating', 'rendering', 'exporting'] as const;

/** Where one job is up to. The current stage gets a pulsing dot; the rest are static. */
function StageList({
  currentIndex,
  done,
  failed,
}: {
  currentIndex: number;
  done: boolean;
  failed: boolean;
}) {
  return (
    <ol className="mt-5 space-y-2">
      {STAGES.map((s, i) => {
        const passed = currentIndex > i || done;
        const active = currentIndex === i && !done && !failed;
        const tone = stageColor(s);
        return (
          <li key={s} className="flex items-center gap-2.5 text-small">
            <span
              className={clsx(
                'grid size-4 shrink-0 place-items-center rounded-full',
                'transition-colors duration-[250ms] ease-[var(--ease-out-strong)]',
                passed ? 'bg-good/20 text-good' : active ? 'bg-ink-750' : 'bg-ink-800',
              )}
            >
              {passed ? (
                <svg viewBox="0 0 24 24" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : active ? (
                // The dot is the stage's own colour, matching the badge and the bar.
                <span
                  className={clsx(
                    'size-1.5 animate-pulse rounded-full motion-reduce:animate-none',
                    tone.bg,
                  )}
                />
              ) : (
                <span className="size-1 rounded-full bg-ink-700" />
              )}
            </span>
            <span
              className={clsx(
                'transition-colors duration-[250ms]',
                active ? tone.text : passed ? 'text-fg' : 'text-fg-subtle',
              )}
            >
              {STAGE_LABEL[s]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The headline, kept out of the JSX because five nested ternaries are unreadable. */
function batchHeadline(total: number, p: BatchProgress, firstLang: string): string {
  const single = total === 1;
  if (!p.finished) {
    return single ? `Dubbing into ${languageLabel(firstLang)}` : `Dubbing into ${total} languages`;
  }
  if (p.failed === 0) return single ? 'Your dub is ready' : `All ${total} dubs are ready`;
  if (p.done === 0) return single ? 'This dub failed' : 'These dubs failed';
  return `${p.done} of ${total} ready`;
}

function BatchPanel({
  batch,
  progress,
  onAnother,
}: {
  batch: CreatedJobEntry[];
  progress: BatchProgress;
  onAnother: () => void;
}) {
  const total = batch.length;
  const single = total === 1;
  // The one job's own row, used for the stage checklist and the state badge. Only
  // meaningful when there is exactly one.
  const first = progress.jobs[0];
  const state = first?.state ?? null;
  const currentIndex = state ? STAGES.indexOf(state as (typeof STAGES)[number]) : -1;
  const done = single && state === 'done';
  const failed = single && (state === 'failed' || state === 'cancelled');

  return (
    <div className="stagger">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-lead font-medium">
            {batchHeadline(total, progress, batch[0]?.target_lang ?? '')}
          </p>
          {single ? (
            first && <p className="mt-0.5 font-mono text-tiny text-fg-subtle">{first.job_id}</p>
          ) : (
            <p className="mt-0.5 text-tiny text-fg-subtle">
              {progress.done} ready
              {progress.failed > 0 && ` · ${progress.failed} failed`}
              {!progress.finished && ' · they run one after another, so each dub gets our full attention'}
            </p>
          )}
        </div>
        {/* Capped and truncating for the same reason as the batch rows: a long stage
            name must not squeeze the headline beside it down to one word per line. */}
        {single && state && (
          <span className="flex max-w-[55%] shrink-0 justify-end">
            <JobStateBadge state={state} truncate />
          </span>
        )}
      </div>

      <div className="mt-5">
        <Progress
          value={progress.percent}
          indeterminate={!progress.finished && progress.percent < 1}
        />
        <p className="mt-2.5 text-small text-fg-muted">
          {single
            ? (state ? STAGE_LABEL[state] ?? state : 'Starting…')
            : progress.finished
              ? 'Finished'
              : `${progress.done} of ${total} finished`}
          {!progress.finished && (
            <span className="ml-1.5 font-mono text-fg-subtle">
              {Math.round(progress.percent)}%
            </span>
          )}
        </p>
      </div>

      {/*
        One row per language. Deliberately not one stage checklist each: a full
        batch of eight would be forty rows of decoration. The stage a job is on is
        one line of text here, and the checklist below still appears when there is
        only one job to watch.
      */}
      {!single && (
        <ul className="mt-5 divide-y divide-ink-700 overflow-hidden rounded-xl border border-ink-700">
          {batch.map((entry, i) => {
            const row = progress.jobs.find((j) => j.job_id === entry.job_id);
            const rowState = row?.state ?? 'queued';
            const rowPct = rowState === 'done' ? 100 : (row?.percent ?? 0);
            const tone = stageColor(rowState);
            const active = !isTerminal(rowState) && rowState !== 'queued';
            return (
              <li
                key={entry.job_id}
                className="row-in flex items-start gap-3 px-4 py-3"
                // 40ms stagger, inside the skill's 30-80ms band. Decoration only:
                // the rows are rendered and interactive regardless.
                style={{ animationDelay: `${i * 40}ms` }}
              >
                {/*
                  The queue number carries the stage hue while the job is working,
                  so the eye lands on the one that is actually moving.
                */}
                <span
                  className={clsx(
                    'grid size-6 shrink-0 place-items-center rounded-full text-tiny tabular-nums',
                    'transition-colors duration-[250ms] ease-[var(--ease-out-strong)]',
                    active
                      ? clsx('bg-ink-800 font-medium ring-1', tone.text, tone.ring)
                      : rowState === 'done'
                        ? 'bg-good/15 text-good'
                        : rowState === 'failed' || rowState === 'cancelled'
                          ? 'bg-bad/15 text-bad'
                          : 'text-fg-subtle',
                  )}
                >
                  {i + 1}
                </span>
                {/*
                  THE WHOLE ROW LIVES IN ONE COLUMN NOW, with the state on the name's line.

                  It used to be [number] [column] [state pill], with the pill
                  `white-space: nowrap`. On a phone a working stage's pill ("Separating
                  speech from background", ~240px) left the column about zero pixels:
                  the language name truncated away to nothing, the stage line wrapped one
                  word per line, and the pill sat on top of it. The pill can no longer
                  take width from the text - it shares the top line, truncates, and while
                  a job is working it is not shown on a phone at all, because the stage
                  line underneath already says the same thing in the same colour.
                */}
                <div className="min-w-0 flex-1">
                  <div className="flex min-h-6 items-center gap-2">
                    <span
                      className={clsx(
                        'size-2 shrink-0 rounded-full',
                        languageDot(entry.target_lang),
                      )}
                      aria-hidden="true"
                    />
                    {/* The name keeps at least 4.5rem however long the pill beside it is,
                        so it can shorten to an ellipsis but never vanish again. */}
                    <Link
                      to={`/app/jobs/${entry.job_id}`}
                      className="min-w-[4.5rem] truncate text-small font-medium underline-offset-2 hover:underline"
                    >
                      {languageLabel(entry.target_lang)}
                    </Link>
                    {/* For support conversations, not for scanning: kept off a phone,
                        where it was what pushed the language name out of the row. */}
                    <span className="hidden shrink-0 font-mono text-[10px] text-fg-subtle sm:inline">
                      {entry.job_id}
                    </span>
                    {/* The cap and the show/hide live on this wrapper, not on the badge,
                        so no two classes on one element compete for the same property.
                        It may shrink (the badge then ends in an ellipsis); the download
                        button inside it may not. */}
                    <span
                      className={clsx(
                        'ml-auto min-w-0 max-w-[11rem] justify-end pl-1 sm:max-w-[16rem]',
                        row?.can_download && 'shrink-0',
                        active && !row?.can_download ? 'hidden sm:flex' : 'flex',
                      )}
                    >
                      {row?.can_download ? (
                        <DownloadMenuIcon jobId={row.job_id} />
                      ) : (
                        <JobStateBadge state={rowState} errorCode={row?.error_code} truncate />
                      )}
                    </span>
                  </div>
                  {/* ink-700 track, like the main bar: ink-800 vanished on the card. */}
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-700">
                    <div
                      className={clsx(
                        'h-full w-full origin-left rounded-full',
                        'transition-[transform,background-color] duration-500 ease-out',
                        'motion-reduce:transition-none',
                        // The bar is the stage colour, so it changes hue as the job
                        // moves through the pipeline rather than staying one shade.
                        tone.bg,
                      )}
                      style={{ transform: `scaleX(${Math.min(1, rowPct / 100)})` }}
                    />
                  </div>
                  <p className="mt-1 text-tiny">
                    <span className={active ? tone.text : 'text-fg-subtle'}>
                      {STAGE_LABEL[rowState] ?? rowState}
                    </span>
                    {!isTerminal(rowState) && (
                      <span className="tabular-nums text-fg-subtle">
                        {` · ${Math.round(rowPct)}%`}
                      </span>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        The stage checklist, only when there is one job to watch. For a batch the
        per-language list above already says what each one is doing, and eight
        checklists is forty rows of decoration.
      */}
      {single && <StageList currentIndex={currentIndex} done={done} failed={failed} />}

      {!progress.finished && (
        <div className="mt-5">
          <InfoNote>
            You can close this tab. {total > 1 ? 'They run' : 'The job runs'} on our
            servers and every stage is written down as it finishes — reopen the
            dashboard anywhere and {total > 1 ? 'they' : 'it'} will be right here.
          </InfoNote>
        </div>
      )}

      {progress.error && (
        <div className="mt-4">
          <ErrorNote>{progress.error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        {single && first && (done || failed) && (
          <Link to={`/app/jobs/${first.job_id}`}>
            <Button>{done ? 'Open and download' : 'See what happened'}</Button>
          </Link>
        )}
        {single && first && !done && !failed && (
          <Link to={`/app/jobs/${first.job_id}`}>
            <Button variant="secondary">Open this job</Button>
          </Link>
        )}
        <Button variant="ghost" onClick={onAnother}>
          Dub another video
        </Button>
      </div>
    </div>
  );
}

function PlanCard({ entitlement }: { entitlement?: Entitlement }) {
  if (!entitlement) return <Skeleton className="h-40" />;
  const e = entitlement;
  /*
    HOW FULL THE PLAN'S OWN ALLOWANCE IS, clamped, and NOT the same as how close they are to
    running out.

    Two things were wrong here. It was `minutes_used / minutes_allowance` unclamped, so a
    single month with any overage — an admin, or a refund arriving after a charge — scaled the
    bar past its own container. And `minutes_used` now counts minutes paid for out of a top-up
    pack, so buying extra minutes pushed the bar towards red, which is the opposite of what
    had just happened.
  */
  const used =
    e.minutes_allowance > 0
      ? Math.min(1, Math.max(0, 1 - e.minutes_plan_left / e.minutes_allowance))
      : 0;
  // The colour asks a different question: is this account actually short of minutes? A full
  // bar with a pack in reserve is not, so it stays neutral.
  const short = e.minutes_topup_left <= 0;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-small font-medium">{e.plan_name}</h3>
        {e.is_free ? <Badge tone="neutral">Free</Badge> : <Badge tone="brand">Paid</Badge>}
      </div>

      <div className="mt-4">
        {/*
          THE BIG NUMBER IS EVERYTHING THEY CAN SPEND, because that is what this card is for
          — deciding whether the video in front of them will go through. The line beside it
          names where it comes from, and has to, because `minutes_left` now includes minutes
          bought on top of the plan: without the second half it read "30.00 of 10 min", which
          looks like arithmetic going wrong rather than like a pack that was paid for.
        */}
        <div className="flex items-end justify-between">
          <span className="text-h3 tabular-nums leading-none">
            {e.minutes_left.toFixed(2)}
          </span>
          <span className="text-tiny text-fg-subtle">
            {e.minutes_topup_left > 0
              ? `${e.minutes_plan_left.toFixed(2)} of ${e.minutes_allowance} + ${e.minutes_topup_left.toFixed(2)} extra`
              : `of ${e.minutes_allowance} min`}
          </span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-800">
          <div
            className={clsx(
              'h-full w-full origin-left rounded-full transition-transform duration-500 ease-out',
              'motion-reduce:transition-none',
              short && used > 0.9
                ? 'bg-bad'
                : short && used > 0.7
                  ? 'bg-warn'
                  : 'bg-[linear-gradient(90deg,var(--color-iris),var(--color-cyan))]',
            )}
            style={{ transform: `scaleX(${Math.min(1, used)})` }}
          />
        </div>
      </div>

      <dl className="mt-4 space-y-2 text-tiny">
        <div className="flex justify-between">
          <dt className="text-fg-subtle">Longest video</dt>
          <dd>{Math.floor(e.max_video_seconds / 60) || 1} min</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-fg-subtle">Videos kept for</dt>
          <dd>{e.retention_days < 1 ? `${e.retention_days * 24} hours` : `${e.retention_days} days`}</dd>
        </div>
        {e.period_end && (
          <div className="flex justify-between">
            <dt className="text-fg-subtle">{e.auto_renew ? 'Renews' : 'Ends'}</dt>
            <dd>{when(e.period_end)}</dd>
          </div>
        )}
      </dl>

      <Link to="/app/billing" className="mt-4 block">
        <Button variant="secondary" size="sm" className="w-full">
          {e.is_free ? 'See plans' : 'Manage plan'}
        </Button>
      </Link>
    </Card>
  );
}

function RecentDubs({
  jobs,
  onChanged,
}: {
  jobs: JobSummary[] | null;
  onChanged: () => void;
}) {
  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-ink-700 px-5 py-4">
        <h2 className="text-body font-medium">Recent dubs</h2>
        <Button variant="ghost" size="sm" onClick={onChanged}>
          Refresh
        </Button>
      </div>

      {jobs === null ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState
          title="No dubs yet"
          body="Upload a video above and it will show up here, with its transcript and translation."
        />
      ) : (
        <JobsTable jobs={jobs} />
      )}
    </Card>
  );
}
