/**
 * Progress for a batch of jobs, from ONE poll.
 *
 * The obvious approach — a `useJobProgress` per language — means N poll loops. A
 * full batch is eight languages, so that is five or six requests a second sustained
 * across a run that can take hours, for information one request already contains. The
 * jobs list returns `state`, `percent`, `can_download` and `error_code` for every job
 * the customer owns, so a single request covers the batch no matter how big it is.
 *
 * Polling stops the moment every job in the batch is terminal, so a tab left open
 * on a finished batch costs nothing.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type JobSummary } from '../lib/api';
import { isTerminal } from '../lib/format';

export interface BatchProgress {
  /** The batch's jobs, in the order the languages were picked. */
  jobs: JobSummary[];
  /** Mean percent across the batch. This is what the one top bar shows. */
  percent: number;
  done: number;
  failed: number;
  /** True once nothing in the batch can change again. */
  finished: boolean;
  error: string | null;
}

export function useBatchProgress(jobIds: string[], intervalMs = 1500): BatchProgress {
  // A joined string, because `jobIds` is a fresh array on every render and an
  // array in the dep list would restart the poll loop each time.
  const key = jobIds.join(',');
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setJobs([]);
    setError(null);
    if (!key) return;

    const wanted = key.split(',');
    let alive = true;
    let timer = 0;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const res = await api.jobs.list(controller.signal);
        if (!alive) return;
        const byId = new Map(res.jobs.map((j) => [j.job_id, j]));
        // Kept in the requested order, not the server's, so the list does not
        // reshuffle itself as jobs finish out of order.
        const mine = wanted
          .map((id) => byId.get(id))
          .filter((j): j is JobSummary => Boolean(j));
        setJobs(mine);
        if (mine.length === wanted.length && mine.every((j) => isTerminal(j.state))) {
          return; // stop: nothing more will happen
        }
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError && err.isUnauthenticated) {
          setError('Your session expired. Sign in again to keep watching.');
          return;
        }
        // A single failed poll is not worth showing. The next one usually works,
        // and a banner that flickers on every hiccup trains people to ignore it.
      }
      if (alive) timer = window.setTimeout(tick, intervalMs);
    };

    void tick();
    return () => {
      alive = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [key, intervalMs]);

  const done = jobs.filter((j) => j.state === 'done').length;
  const failed = jobs.filter((j) => j.state === 'failed' || j.state === 'cancelled').length;
  // `done` is forced to 100 rather than trusted, so the aggregate cannot sit at
  // 99% with every job finished.
  const percent = jobs.length
    ? jobs.reduce((sum, j) => sum + (j.state === 'done' ? 100 : j.percent), 0) / jobs.length
    : 0;

  return {
    jobs,
    percent,
    done,
    failed,
    finished:
      jobs.length > 0 && jobs.length === key.split(',').length && jobs.every((j) => isTerminal(j.state)),
    error,
  };
}
