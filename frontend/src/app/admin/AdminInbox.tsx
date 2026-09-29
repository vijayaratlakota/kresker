/**
 * The admin inbox: contact messages and data-rights requests, in one list.
 *
 * One list rather than two tabs by default, and that is the point of the design. A
 * rights request that arrives through the general contact form is still a rights
 * request and still runs against a statutory deadline; two separate inboxes make it
 * possible to answer one and quietly not the other.
 *
 * So the sort order is the priority order, computed server-side: unanswered first,
 * then by deadline, then newest. What is about to run out of time floats to the top
 * without anybody having to think about it.
 *
 * The deadline is rendered as days remaining AND an absolute date. A duration on its
 * own reads as a suggestion; a date reads as a fact.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  api,
  type DpdpReadiness,
  type InboxKind,
  type InboxMessage,
  type InboxPage,
  type InboxStatus,
} from '../../lib/api';
import { ago, onDay, when } from '../../lib/format';
import { Button } from '../../ui/Button';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Skeleton,
} from '../../ui/primitives';

const KIND_LABEL: Record<InboxKind, string> = {
  contact: 'Enquiry',
  access: 'Access request',
  correction: 'Correction',
  erasure: 'Erasure',
  withdraw: 'Withdraw consent',
  grievance: 'Grievance',
};

/** A rights kind is a legal obligation; a general enquiry is not. Coloured to match. */
const KIND_TONE: Record<InboxKind, 'neutral' | 'iris' | 'warn' | 'bad'> = {
  contact: 'neutral',
  access: 'iris',
  correction: 'iris',
  erasure: 'bad',
  withdraw: 'warn',
  grievance: 'bad',
};

const STATUS_TONE: Record<InboxStatus, 'warn' | 'iris' | 'good' | 'neutral'> = {
  new: 'warn',
  in_progress: 'iris',
  resolved: 'good',
  rejected: 'neutral',
};

const FILTERS: { label: string; status: string; kind: string }[] = [
  { label: 'Needs an answer', status: 'new', kind: '' },
  { label: 'In progress', status: 'in_progress', kind: '' },
  { label: 'Rights only', status: '', kind: 'rights' },
  { label: 'Everything', status: '', kind: '' },
];

export function AdminInbox() {
  const [page, setPage] = useState<InboxPage | null>(null);
  const [readiness, setReadiness] = useState<DpdpReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);

  const f = FILTERS[filter];

  const load = useCallback(async () => {
    try {
      // `kind: 'rights'` is a client-side view, not a server filter: the server
      // filters one exact kind, and "any of the five" is a different question.
      const [p, r] = await Promise.all([
        api.admin.inbox(f.status, ''),
        api.admin.dpdp(),
      ]);
      setPage(p);
      setReadiness(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the inbox.');
    }
  }, [f.status]);

  useEffect(() => {
    void load();
  }, [load]);

  const messages = useMemo(() => {
    const all = page?.messages ?? [];
    return f.kind === 'rights' ? all.filter((m) => m.kind !== 'contact') : all;
  }, [page, f.kind]);

  return (
    <div className="px-5 py-8 sm:px-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-h2 tracking-tight">Inbox</h1>
          <p className="mt-1.5 max-w-xl text-small leading-relaxed text-fg-subtle">
            Contact messages and data-rights requests together, most urgent first. A
            request with a deadline is sorted ahead of one without.
          </p>
        </div>
        <div className="flex gap-2">
          {page && page.counts.new > 0 && (
            <Badge tone="warn" dot>
              {page.counts.new} unanswered
            </Badge>
          )}
          {page && page.counts.overdue > 0 && (
            <Badge tone="bad" dot pulse>
              {page.counts.overdue} past deadline
            </Badge>
          )}
          {page && page.counts.new === 0 && page.counts.overdue === 0 && (
            <Badge tone="good" dot>
              All clear
            </Badge>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {readiness && !readiness.ready && <ReadinessCard readiness={readiness} />}

      <div className="mb-5 flex flex-wrap gap-1 rounded-full border-2 border-ink-600 bg-ink-900 p-1 sm:inline-flex">
        {FILTERS.map((x, i) => (
          <button
            key={x.label}
            type="button"
            aria-pressed={filter === i}
            onClick={() => setFilter(i)}
            className={clsx(
              'rounded-full px-4 py-1.5 text-small transition-[background-color,color] duration-[160ms] ease-[var(--ease-out-strong)]',
              filter === i ? 'bg-ink-800 font-medium text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      {!page ? (
        <div className="space-y-2.5">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : messages.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing here"
            body={
              f.status === 'new'
                ? 'Every message has been picked up. That is the state you want this page in.'
                : 'No messages match this filter.'
            }
          />
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              m={m}
              open={openId === m.id}
              onToggle={() => setOpenId((cur) => (cur === m.id ? null : m.id))}
              onDone={load}
              responseDays={page.rights_response_days}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The configuration warning. It sits above the messages rather than on a separate
 * settings page, because the person reading the inbox is the person who will notice
 * that the policy names nobody.
 */
function ReadinessCard({ readiness }: { readiness: DpdpReadiness }) {
  const failing = readiness.checks.filter((c) => !c.ok);
  return (
    <Card className="mb-6 border-warn/35 bg-warn/[0.05]">
      <CardHeader
        title="DPDP setup is incomplete"
        subtitle={`${failing.length} of ${readiness.checks.length} checks are failing. Each one names its own fix.`}
        right={<Badge tone="warn">Action needed</Badge>}
      />
      <ul className="divide-y divide-ink-700">
        {failing.map((c) => (
          <li key={c.item} className="px-5 py-3">
            <p className="text-small font-medium text-fg">{c.item}</p>
            <p className="mt-0.5 text-tiny leading-relaxed text-fg-subtle">{c.fix}</p>
          </li>
        ))}
      </ul>
      {!readiness.grievance.configured && (
        <p className="border-t border-ink-700 px-5 py-3 text-tiny leading-relaxed text-bad">
          Until a Grievance Officer is named, every page footer shows a visible warning
          instead of a contact. That is deliberate — DPDP s.13(1) requires the contact to
          be published, and an empty block would look finished.
        </p>
      )}
    </Card>
  );
}

function MessageRow({
  m,
  open,
  onToggle,
  onDone,
  responseDays,
}: {
  m: InboxMessage;
  open: boolean;
  onToggle: () => void;
  onDone: () => void | Promise<void>;
  responseDays: number;
}) {
  const [note, setNote] = useState(m.handled_note ?? '');
  const [busy, setBusy] = useState<InboxStatus | null>(null);

  async function move(status: InboxStatus) {
    // Resolving without saying what was done is how "we answered it" becomes
    // unprovable six months later. Required for the kinds that carry a deadline.
    if (status === 'resolved' && m.kind !== 'contact' && !note.trim()) {
      toast.error('Say what was actually done', {
        description:
          'A rights request marked resolved with no note cannot be evidenced later.',
      });
      return;
    }
    setBusy(status);
    try {
      await api.admin.handleMessage(m.id, status, note.trim());
      toast.success(`#${m.id} marked ${status.replace('_', ' ')}`);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not save.');
    } finally {
      setBusy(null);
    }
  }

  const daysLeft = m.due_at
    ? Math.ceil((new Date(m.due_at).getTime() - Date.now()) / 86_400_000)
    : null;

  return (
    <li>
      <Card
        className={clsx(
          'overflow-hidden transition-colors duration-[160ms]',
          m.overdue ? 'border-bad/45' : m.status === 'new' ? 'border-ink-600' : 'border-ink-700',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors duration-[160ms] hover:bg-ink-800/40"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={KIND_TONE[m.kind]}>{KIND_LABEL[m.kind]}</Badge>
              <Badge tone={STATUS_TONE[m.status]}>{m.status.replace('_', ' ')}</Badge>
              {m.overdue && (
                <Badge tone="bad" dot pulse>
                  past deadline
                </Badge>
              )}
              {m.user_id == null && (
                <span className="text-tiny text-fg-subtle" title="Not signed in when they sent it">
                  no account matched
                </span>
              )}
            </div>
            <p className="mt-2 truncate text-body font-medium text-fg">
              {m.subject || m.body.slice(0, 80)}
            </p>
            <p className="mt-0.5 truncate text-small text-fg-subtle">
              {m.name ? `${m.name} · ` : ''}
              {m.email} · {ago(m.at)}
            </p>
          </div>

          <div className="shrink-0 text-right">
            {m.due_at ? (
              <>
                <p
                  className={clsx(
                    'text-small font-medium tabular-nums',
                    m.overdue ? 'text-bad' : daysLeft != null && daysLeft <= 7 ? 'text-warn' : 'text-fg-muted',
                  )}
                >
                  {m.overdue
                    ? `${Math.abs(daysLeft ?? 0)}d over`
                    : `${daysLeft}d left`}
                </p>
                <p className="mt-0.5 text-tiny text-fg-subtle">due {onDay(m.due_at)}</p>
              </>
            ) : (
              <p className="text-tiny text-fg-subtle">no deadline</p>
            )}
          </div>
        </button>

        {open && (
          <div className="border-t border-ink-700 px-5 py-4">
            <p className="whitespace-pre-wrap text-small leading-relaxed text-fg-muted">
              {m.body}
            </p>

            <dl className="mt-4 grid gap-x-6 gap-y-1.5 text-tiny sm:grid-cols-2">
              <Meta k="Received" v={when(m.at)} />
              <Meta k="From IP" v={m.ip ?? '—'} />
              <Meta k="Account" v={m.user_id ? `user #${m.user_id}` : 'not signed in'} />
              <Meta
                k="Deadline"
                v={m.due_at ? `${onDay(m.due_at)} (${responseDays}-day window)` : 'none'}
              />
              {m.handled_at && <Meta k="Last actioned" v={when(m.handled_at)} />}
              {m.handled_by && <Meta k="By" v={`admin #${m.handled_by}`} />}
            </dl>

            {m.kind === 'erasure' && (
              <p className="mt-4 rounded-xl border border-bad/35 bg-bad/10 px-3.5 py-2.5 text-tiny leading-relaxed text-bad">
                Verify who this is before doing anything. This endpoint is
                unauthenticated by necessity, so an erasure request proves only that
                somebody knows the email address. If they can sign in, point them at
                their own privacy page instead — it is immediate and it needs no trust
                from us.
              </p>
            )}

            <div className="mt-4">
              <label
                htmlFor={`note-${m.id}`}
                className="mb-1.5 block text-small font-medium text-fg-muted"
              >
                What was done
              </label>
              <textarea
                id={`note-${m.id}`}
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Identity verified against the account email, export sent 24 Aug."
                className="w-full resize-y rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2.5 text-small text-fg placeholder:text-fg-subtle transition-colors duration-[160ms] hover:border-ink-750 focus:border-fg-subtle focus:outline-none"
              />
              <p className="mt-1.5 text-tiny text-fg-subtle">
                Stored on the message and written to the audit log. Required to resolve a
                rights request.
              </p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2.5">
              {/* The address is encoded as well as the subject. It is a stored value
                  submitted by a member of the public, and unencoded it could carry
                  `?bcc=` or `&` and append its own mailto headers. */}
              <a href={`mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent(`Re: ${m.subject || 'your message'} (#${m.id})`)}`}>
                <Button size="sm" variant="secondary">
                  Reply by email
                </Button>
              </a>
              {m.status !== 'in_progress' && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === 'in_progress'}
                  onClick={() => void move('in_progress')}
                >
                  Picking this up
                </Button>
              )}
              <Button
                size="sm"
                loading={busy === 'resolved'}
                onClick={() => void move('resolved')}
              >
                Resolved
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === 'rejected'}
                onClick={() => void move('rejected')}
              >
                Reject
              </Button>
            </div>
          </div>
        )}
      </Card>
    </li>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-fg-subtle">{k}</dt>
      <dd className="min-w-0 truncate text-fg-muted">{v}</dd>
    </div>
  );
}
