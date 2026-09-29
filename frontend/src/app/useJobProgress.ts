/**
 * Job progress by polling.
 *
 * Polling rather than SSE, matching the backend, and the reason is worth keeping
 * in mind: progress lives in `job_events` in the database, so a poll survives a
 * refresh, a proxy and a closed laptop with no reconnect logic. An SSE stream
 * would need all three handled.
 *
 * Two details that make it behave:
 *  - `after_id` means each poll returns only NEW events, so a long job does not
 *    re-download its whole history every 1.5 seconds.
 *  - Polling stops the moment the job is terminal. A tab left open on a finished
 *    job should cost nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type JobEvent, type JobState } from '../lib/api';
import { isTerminal } from '../lib/format';

export interface Progress {
  state: JobState | null;
  percent: number;
  events: Required<JobEvent>[];
  error: string | null;
  finished: boolean;
}

export function useJobProgress(jobId: string | null, intervalMs = 1500): Progress {
  const [state, setState] = useState<JobState | null>(null);
  const [percent, setPercent] = useState(0);
  const [events, setEvents] = useState<Required<JobEvent>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef(0);

  const reset = useCallback(() => {
    lastId.current = 0;
    setState(null);
    setPercent(0);
    setEvents([]);
    setError(null);
  }, []);

  useEffect(() => {
    reset();
    if (!jobId) return;

    let alive = true;
    let timer = 0;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const page = await api.jobs.events(jobId, lastId.current, controller.signal);
        if (!alive) return;
        setState(page.state);
        setPercent(page.percent);
        if (page.events.length) {
          lastId.current = page.last_id;
          setEvents((prev) => [...prev, ...page.events]);
        }
        if (isTerminal(page.state)) return; // stop: nothing more will happen
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
  }, [jobId, intervalMs, reset]);

  return {
    state,
    percent,
    events,
    error,
    finished: state ? isTerminal(state) : false,
  };
}
