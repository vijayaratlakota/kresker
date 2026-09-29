/**
 * Every dub this account has run.
 *
 * Deliberately plain: no row animations, no stagger. This is a working list
 * somebody scans for a specific job, which is the tier where the animate skill
 * says near-imperceptible or nothing. A row hover is the whole motion budget.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type JobSummary } from '../lib/api';
import { isTerminal, languageLabel } from '../lib/format';
import { Button } from '../ui/Button';
import { Card, EmptyState, Skeleton } from '../ui/primitives';
import { JobsTable } from './JobsTable';

type Filter = 'all' | 'running' | 'done' | 'failed';

export function Library() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.jobs.list();
      setJobs(res.jobs);
    } catch {
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep polling only while something is actually in flight.
  useEffect(() => {
    if (!jobs?.some((j) => !isTerminal(j.state))) return;
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [jobs, load]);

  const shown = useMemo(() => {
    if (!jobs) return null;
    return jobs.filter((j) => {
      if (filter === 'running' && isTerminal(j.state)) return false;
      if (filter === 'done' && j.state !== 'done') return false;
      if (filter === 'failed' && j.state !== 'failed') return false;
      if (query) {
        const q = query.toLowerCase();
        return (
          j.job_id.toLowerCase().includes(q) ||
          languageLabel(j.target_lang).toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [jobs, filter, query]);

  const counts = useMemo(() => {
    const c = { all: 0, running: 0, done: 0, failed: 0 };
    for (const j of jobs ?? []) {
      c.all += 1;
      if (!isTerminal(j.state)) c.running += 1;
      else if (j.state === 'done') c.done += 1;
      else if (j.state === 'failed') c.failed += 1;
    }
    return c;
  }, [jobs]);

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      <header className="mb-7">
        <h1 className="text-h3">Library</h1>
        <p className="mt-1.5 text-body text-fg-muted">
          Every dub you have run. Transcripts stay even after a video is deleted.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-full border-2 border-ink-600 bg-ink-900 p-1">
          {(['all', 'running', 'done', 'failed'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              // The space before each branch matters: without it the last base class
              // and the first state class ran together into one class that matched
              // nothing, so the selected filter never looked selected.
              className={
                'rounded-full px-3.5 py-1.5 text-tiny capitalize transition-[background-color,color] duration-[160ms] ease-[var(--ease-out-strong)]' +
                (filter === f
                  ? ' bg-ink-800 font-medium text-fg'
                  : ' text-fg-muted hover:text-fg')
              }
            >
              {f}
              <span className="ml-1.5 tabular-nums text-fg-subtle">{counts[f]}</span>
            </button>
          ))}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by file name or language"
          aria-label="Search dubs"
          className="h-9 min-w-[220px] flex-1 rounded-full border border-ink-700 bg-ink-900 px-4 text-small placeholder:text-fg-subtle focus:border-fg-subtle focus:outline-none"
        />

        <Button variant="ghost" size="sm" onClick={load}>
          Refresh
        </Button>
      </div>

      <Card className="overflow-hidden">
        {shown === null ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            title={jobs?.length ? 'Nothing matches that' : 'No dubs yet'}
            body={
              jobs?.length
                ? 'Try a different filter or search.'
                : 'Your first dub will appear here.'
            }
            action={
              !jobs?.length ? (
                <Link to="/app">
                  <Button>Dub a video</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <JobsTable jobs={shown} />
        )}
      </Card>
    </div>
  );
}
