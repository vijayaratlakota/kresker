/**
 * Accounts, grants, refunds and sessions.
 *
 * The two actions that move money — granting a subscription and refunding a job —
 * ask for the admin password again. A stolen session should not be able to hand
 * out plans, and re-authenticating is cheap. The dialog says why rather than just
 * demanding it.
 */
import { Dialog } from '@base-ui/react/dialog';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  api,
  type AccessLogEntry,
  type AdminUser,
  type AdminUserJob,
  type AuditEntry,
  type ConsentRecord,
  type SignupReport,
} from '../../lib/api';
import { languageLabel, minutes, when } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Badge, Card, EmptyState, ErrorNote, Field, Skeleton } from '../../ui/primitives';
import { JobStateBadge } from '../JobStateBadge';

export function AdminPeople() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.admin.sessions>>['sessions']>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [granting, setGranting] = useState<AdminUser | null>(null);
  /**
   * The money action a dialog is open for, if any.
   *
   * ONE PIECE OF STATE FOR THREE ACTIONS rather than three booleans, because they are
   * mutually exclusive by nature — a dialog is open for one user and one decision — and
   * three flags make "two dialogs open at once" a state the type system permits.
   */
  const [acting, setActing] = useState<{ user: AdminUser; action: MoneyAction } | null>(null);
  /** The account whose dubs and consent record are open, if any. */
  const [viewing, setViewing] = useState<AdminUser | null>(null);

  const load = useCallback(async (q = '') => {
    try {
      const [u, a, s] = await Promise.all([
        api.admin.users(q),
        api.admin.audit(50),
        api.admin.sessions(),
      ]);
      setUsers(u.users);
      setAudit(a.audit);
      setSessions(s.sessions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load people.');
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !users?.length) {
    return (
      <div className="px-5 py-8 sm:px-8 lg:px-10">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      <header className="mb-7">
        <h1 className="text-h3">People</h1>
        <p className="mt-1.5 text-body text-fg-muted">
          Accounts, what they are on, and everything an admin has done.
        </p>
      </header>

      <form
        className="mb-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load(query);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by email"
          aria-label="Search accounts"
          className="h-9 max-w-xs flex-1 rounded-full border border-ink-700 bg-ink-900 px-4 text-small placeholder:text-fg-subtle focus:border-fg-subtle focus:outline-none"
        />
        <Button type="submit" size="sm" variant="secondary">
          Search
        </Button>
      </form>

      <Card className="overflow-hidden">
        {users === null ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : users.length === 0 ? (
          <EmptyState title="No accounts match that" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-small">
              <thead>
                <tr className="border-b border-ink-700 text-eyebrow uppercase text-fg-subtle">
                  <th className="px-5 py-2.5 font-medium">Email</th>
                  <th className="px-5 py-2.5 font-medium">Plan</th>
                  <th className="px-5 py-2.5 font-medium">Minutes</th>
                  <th className="px-5 py-2.5 font-medium">Dubs</th>
                  <th className="px-5 py-2.5 font-medium">Joined</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700">
                {users.map((u) => (
                  <tr key={u.id} className="transition-colors duration-[160ms] hover:bg-ink-800/60">
                    <td className="px-5 py-3">
                      <span className="flex flex-wrap items-center gap-2">
                        {u.email}
                        {u.role === 'admin' && <Badge tone="brand">admin</Badge>}
                        {u.status === 'suspended' && <Badge tone="bad">suspended</Badge>}
                        {/*
                          Shown because the block is otherwise invisible from the one screen
                          used to decide whether to apply it — an account blocked from buying
                          looks completely normal everywhere else, which is the point of the
                          lever and also how it gets forgotten about.
                        */}
                        {!u.can_purchase && <Badge tone="warn">no buying</Badge>}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {u.subscribed ? (
                        <span className="flex items-center gap-2">
                          {u.plan}
                          {!u.auto_renew && <Badge tone="warn">no renew</Badge>}
                        </span>
                      ) : (
                        <span className="text-fg-subtle">{u.plan}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 tabular-nums text-fg-muted">
                      {minutes(u.minutes_used)} used · {minutes(u.minutes_left)} left
                      {/*
                        Only when there is a balance, which is most of the time nothing. It is
                        called out separately because it does not behave like the rest: it
                        survives a renewal and is written off if the plan lapses, so "20 left"
                        and "20 left, all of it bought on top" lead to different answers.
                      */}
                      {u.minutes_topup > 0 && (
                        <span className="block text-tiny text-fg-subtle">
                          incl. {minutes(u.minutes_topup)} extra
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 tabular-nums">{u.jobs}</td>
                    <td className="px-5 py-3 text-fg-subtle">{when(u.created_at)}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setGranting(u)}>
                          Grant plan
                        </Button>
                        {/*
                          Only offered when there is something to stop. A cancel button on an
                          account with no subscription is a button that returns 404.
                        */}
                        {u.subscribed && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setActing({ user: u, action: 'cancel' })}
                          >
                            Stop plan
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setActing({ user: u, action: u.can_purchase ? 'block' : 'allow' })
                          }
                        >
                          {u.can_purchase ? 'Block buying' : 'Allow buying'}
                        </Button>
                        {/* Their dubs (with refunds) and what they have agreed to. */}
                        <Button size="sm" variant="ghost" onClick={() => setViewing(u)}>
                          Dubs &amp; consent
                        </Button>
                        {/*
                          Never offered on an admin: the server refuses it (an operator
                          cannot lock themselves, or the other operator, out of the panel).
                        */}
                        {u.role !== 'admin' &&
                          (u.status === 'suspended' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setActing({ user: u, action: 'unsuspend' })}
                            >
                              Reinstate
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-bad"
                              onClick={() => setActing({ user: u, action: 'suspend' })}
                            >
                              Suspend
                            </Button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-7 grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-b border-ink-700 px-5 py-4">
            <h2 className="text-body font-medium">Admin audit</h2>
            <p className="mt-0.5 text-tiny text-fg-subtle">
              Append-only. This is how “why does this account have Pro without paying”
              stays answerable.
            </p>
          </div>
          {audit.length === 0 ? (
            <EmptyState title="Nothing yet" body="Admin actions will be recorded here." />
          ) : (
            <ol className="max-h-80 divide-y divide-ink-700 overflow-auto">
              {audit.map((a) => (
                <li key={a.id} className="px-5 py-2.5 text-tiny">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{a.action}</span>
                    <span className="shrink-0 text-fg-subtle">{when(a.at)}</span>
                  </div>
                  <p className="mt-0.5 text-fg-subtle">
                    {a.admin_email ?? `#${a.admin_user_id}`}
                    {a.reason ? ` — ${a.reason}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-ink-700 px-5 py-4">
            <h2 className="text-body font-medium">Who is signed in</h2>
            <p className="mt-0.5 text-tiny text-fg-subtle">
              Only the hash of each session token is stored, so this list cannot be used to
              impersonate anyone.
            </p>
          </div>
          {sessions.length === 0 ? (
            <EmptyState title="Nobody is signed in" />
          ) : (
            <ul className="max-h-80 divide-y divide-ink-700 overflow-auto">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-2.5 text-tiny">
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{s.email}</p>
                    <p className="text-fg-subtle">
                      {s.ip ?? 'unknown ip'} · seen {when(s.last_seen_at)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await api.admin.killSession(s.id);
                        toast.success('Session ended');
                        void load(query);
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Could not end it.');
                      }
                    }}
                  >
                    End
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/*
        Both read other people's personal data, and each read is written to the access
        log - so they load when asked for, not on every visit to this page.
      */}
      <div className="mt-7 grid gap-6 lg:grid-cols-2">
        <SignupsCard />
        <AccessLogCard />
      </div>

      <UserDetailDialog
        user={viewing}
        onClose={() => setViewing(null)}
        onChanged={() => void load(query)}
      />

      <GrantDialog
        user={granting}
        onClose={() => setGranting(null)}
        onDone={() => {
          setGranting(null);
          void load(query);
        }}
      />

      <MoneyActionDialog
        target={acting}
        onClose={() => setActing(null)}
        onDone={() => {
          setActing(null);
          void load(query);
        }}
      />
    </div>
  );
}

/**
 * The decisions that move money or change what an account may do. All of them ask for
 * a reason and the admin password again, and all of them land in the audit log.
 */
type MoneyAction = 'cancel' | 'block' | 'allow' | 'suspend' | 'unsuspend';

function GrantDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState('starter');
  const [months, setMonths] = useState(1);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!reason.trim()) {
      setError('A reason is required — it goes in the audit log.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.admin.grant(user.id, plan, months, reason.trim(), password);
      toast.success(`${user.email} is on ${plan}`, {
        description: `Until ${res.period_end}. Recorded as a gift, so it does not touch earnings.`,
      });
      setPassword('');
      setReason('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The grant was refused.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={!!user} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        {/*
          Backdrop and panel animate together over 250ms so they read as one
          surface. The panel is centered and therefore exempt from the
          transform-origin rule — it is not anchored to a trigger.
        */}
        <Dialog.Backdrop
          className={clsx(
            'fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
            'transition-opacity duration-[250ms] ease-[var(--ease-out-strong)]',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            'motion-reduce:transition-none',
          )}
        />
        <Dialog.Popup
          className={clsx(
            'fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))]',
            '-translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)]',
            'border border-ink-700 bg-ink-850 p-6 shadow-2xl',
            'transition-[opacity,transform] duration-[250ms] ease-[var(--ease-out-strong)]',
            'data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0',
            'motion-reduce:transition-none',
          )}
        >
          <Dialog.Title className="text-h5">Grant a subscription</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-small leading-relaxed text-fg-muted">
            This writes a subscription only. It never touches the payments table, because
            a gift recorded as a sale would make the earnings figure on the very same
            dashboard wrong.
          </Dialog.Description>

          <form onSubmit={submit} className="mt-5">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-small font-medium text-fg-muted">Plan</span>
                <select
                  value={plan}
                  onChange={(e) => setPlan(e.target.value)}
                  className="h-11 w-full rounded-xl border border-ink-700 bg-ink-900 px-3 text-body focus:border-fg-subtle focus:outline-none"
                >
                  {['starter', 'creator', 'pro', 'starter_year', 'creator_year', 'pro_year'].map(
                    (p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-small font-medium text-fg-muted">Months</span>
                <input
                  type="number"
                  min={1}
                  max={36}
                  value={months}
                  onChange={(e) => setMonths(Number(e.target.value))}
                  className="h-11 w-full rounded-xl border border-ink-700 bg-ink-900 px-3 text-body focus:border-fg-subtle focus:outline-none"
                />
              </label>
            </div>

            <div className="mt-3">
              <Field
                label="Reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this account is getting a plan"
                hint="Goes in the audit log."
                required
              />
              <Field
                label="Your password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint="Asked again so a stolen session cannot hand out plans."
                required
              />
            </div>

            {error && (
              <div className="mb-4">
                <ErrorNote>{error}</ErrorNote>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close render={<Button variant="ghost" type="button">Cancel</Button>} />
              <Button type="submit" loading={busy}>
                Grant
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Stopping a subscription, and stopping an account from buying.
 *
 * ONE COMPONENT FOR THREE ACTIONS because they share everything that matters: the same
 * password re-auth, the same required reason, the same audit trail, the same "close then
 * refetch" ending. What differs is the wording and which method gets called, and three
 * near-identical dialogs is how the wording on one of them ends up wrong.
 *
 * THE PASSWORD IS ASKED FOR AGAIN, like granting and refunding, and here the argument is
 * stronger than for those: a stolen admin session that could cancel every subscription
 * would take the whole customer base offline in one pass.
 */
function MoneyActionDialog({
  target,
  onClose,
  onDone,
}: {
  target: { user: AdminUser; action: MoneyAction } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  /**
   * Only meaningful for `cancel`. Off by default, deliberately: stopping the renewal is the
   * common case and ending a period somebody has paid for should have to be asked for.
   */
  const [immediate, setImmediate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const action = target?.action;

  /*
    Reset when the dialog opens for a different decision. Without this, ticking "end it now"
    for one account and then opening the dialog for another would carry the tick across —
    which is the one piece of state here that destroys something.
  */
  useEffect(() => {
    if (target) {
      setImmediate(false);
      setError(null);
    }
  }, [target]);

  const copy =
    action === 'cancel'
      ? {
          title: 'Stop this subscription',
          body:
            'This tells the payment provider to stop taking money, not just our own records. ' +
            'It is the fastest way to stop a charge that should not be happening — suspending ' +
            'the account does not stop a card being debited.',
          confirm: 'Stop the plan',
          hint: 'Why this subscription is being stopped',
        }
      : action === 'block'
        ? {
            title: 'Block this account from buying',
            body:
              'They keep their plan, their minutes and their finished dubs. Only new purchases ' +
              'are refused — plans, extra minutes, and plan changes. Any subscription they ' +
              'already have keeps renewing; stop that separately if that is what you mean.',
            confirm: 'Block buying',
            hint: 'Why this account may not buy',
          }
        : action === 'suspend'
          ? {
              title: 'Suspend this account',
              body:
                'They are signed out everywhere at once and cannot sign in or dub until you ' +
                'reinstate them. Nothing is deleted. It does NOT stop a subscription charging - ' +
                'use Stop plan for that. They can still contact us and use their data rights.',
              confirm: 'Suspend',
              hint: 'Why this account is being suspended',
            }
          : action === 'unsuspend'
            ? {
                title: 'Reinstate this account',
                body:
                  'They can sign in and dub again. Their old sessions stay ended, so they sign ' +
                  'in afresh.',
                confirm: 'Reinstate',
                hint: 'Why this account is being reinstated',
              }
            : {
                title: 'Let this account buy again',
                body: 'Plans, extra minutes and plan changes all become available again.',
                confirm: 'Allow buying',
                hint: 'Why this is being reinstated',
              };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    const { user } = target;
    if (!reason.trim()) {
      setError('A reason is required — it goes in the audit log.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (target.action === 'cancel') {
        const res = await api.admin.cancelSubscription(
          user.id,
          reason.trim(),
          password,
          immediate,
        );
        toast.success(`${user.email}: ${res.plan_code} stopped`, {
          description: res.needs_operator
            ? 'Recorded here, but the payment provider did not confirm it. Check the billing view.'
            : res.immediate
              ? `Access ended now.${
                  res.topup_minutes_voided > 0
                    ? ` ${res.topup_minutes_voided} extra minutes written off.`
                    : ''
                }`
              : `No further payments. Access continues until ${res.keeps_access_until}.`,
        });
      } else if (target.action === 'suspend') {
        const res = await api.admin.suspend(user.id, reason.trim(), password);
        toast.success(`${user.email} is suspended`, {
          description: `Signed out of ${res.sessions_revoked} session${res.sessions_revoked === 1 ? '' : 's'}. Nothing was deleted.`,
        });
      } else if (target.action === 'unsuspend') {
        await api.admin.unsuspend(user.id, reason.trim(), password);
        toast.success(`${user.email} is reinstated`, {
          description: 'They can sign in again.',
        });
      } else {
        const allow = target.action === 'allow';
        await api.admin.setPurchases(user.id, allow, reason.trim(), password);
        toast.success(
          allow ? `${user.email} can buy again` : `${user.email} cannot buy anything`,
          {
            description: allow
              ? 'Plans, extra minutes and plan changes are available again.'
              : 'Their plan, minutes and finished dubs are untouched.',
          },
        );
      }
      setPassword('');
      setReason('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That was refused.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={!!target} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={clsx(
            'fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
            'transition-opacity duration-[250ms] ease-[var(--ease-out-strong)]',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            'motion-reduce:transition-none',
          )}
        />
        <Dialog.Popup
          className={clsx(
            'fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))]',
            '-translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)]',
            'border border-ink-700 bg-ink-850 p-6 shadow-2xl',
            'transition-[opacity,transform] duration-[250ms] ease-[var(--ease-out-strong)]',
            'data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0',
            'motion-reduce:transition-none',
          )}
        >
          <Dialog.Title className="text-h5">{copy.title}</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-small leading-relaxed text-fg-muted">
            {copy.body}
          </Dialog.Description>
          {target && (
            <p className="mt-3 text-small text-fg">
              <span className="text-fg-muted">Account:</span> {target.user.email}
            </p>
          )}

          <form onSubmit={submit} className="mt-5">
            {action === 'cancel' && (
              <label className="mb-4 flex items-start gap-2.5 text-small">
                <input
                  type="checkbox"
                  checked={immediate}
                  onChange={(e) => setImmediate(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-iris"
                />
                <span>
                  End it now instead of at the renewal
                  <span className="mt-0.5 block text-tiny text-fg-subtle">
                    Access drops to the free plan immediately and any extra minutes they have
                    bought are written off. Use this for fraud, not for a change of mind.
                  </span>
                </span>
              </label>
            )}

            <Field
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={copy.hint}
              hint="Goes in the audit log."
              required
            />
            <Field
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint="Asked again so a stolen session cannot do this."
              required
            />

            {error && (
              <div className="mb-4">
                <ErrorNote>{error}</ErrorNote>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close render={<Button variant="ghost" type="button">Cancel</Button>} />
              {/*
                `danger` for the two that take something away, and it is an outlined red tint
                rather than a solid fill — a destructive action should read as a warning, not
                as the thing the page wants you to press.
              */}
              <Button
                type="submit"
                loading={busy}
                variant={action === 'allow' || action === 'unsuspend' ? 'primary' : 'danger'}
              >
                {copy.confirm}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── shared dialog chrome for the screens below ──────────────────────────── */

const BACKDROP = clsx(
  'fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
  'transition-opacity duration-[250ms] ease-[var(--ease-out-strong)]',
  'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
  'motion-reduce:transition-none',
);

const POPUP = clsx(
  'fixed left-1/2 top-1/2 z-50',
  '-translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)]',
  'border border-ink-700 bg-ink-850 shadow-2xl',
  'transition-[opacity,transform] duration-[250ms] ease-[var(--ease-out-strong)]',
  'data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0',
  'data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0',
  'motion-reduce:transition-none',
);

/* ── one account: its dubs (with refunds) and its consent record ─────────── */

type UserConsent = Awaited<ReturnType<typeof api.admin.userConsent>>;

/**
 * The screen for "my minutes were taken but the dub was bad", and for "what did this
 * person agree to".
 *
 * A refund writes a NEW compensating ledger row; the original charge is never edited.
 * It asks for the admin password again, like every other action here that moves money.
 * Opening this is itself recorded in the access log - it reads one person's data.
 */
function UserDetailDialog({
  user,
  onClose,
  onChanged,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [jobs, setJobs] = useState<AdminUserJob[] | null>(null);
  const [consent, setConsent] = useState<UserConsent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<AdminUserJob | null>(null);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  const load = useCallback(async (id: number) => {
    setError(null);
    try {
      const [j, c] = await Promise.all([api.admin.userJobs(id), api.admin.userConsent(id)]);
      setJobs(j.jobs);
      setConsent(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this account.');
      setJobs([]);
    }
  }, []);

  // A different account, or none: start clean, so a half-typed refund reason or an
  // armed refund for one person can never carry over to the next.
  useEffect(() => {
    setJobs(null);
    setConsent(null);
    setRefunding(null);
    setReason('');
    setPassword('');
    setRefundError(null);
    if (user) void load(user.id);
  }, [user, load]);

  async function refund(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !refunding) return;
    if (!reason.trim()) {
      setRefundError('A reason is required — it goes in the audit log.');
      return;
    }
    setBusy(true);
    setRefundError(null);
    try {
      const res = await api.admin.refund(refunding.job_id, reason.trim(), password);
      toast.success(`${minutes(res.minutes_refunded)} refunded`, {
        description: `${user.email}, ${languageLabel(refunding.target_lang)} dub. The charge stays on record; a refund row was added next to it.`,
      });
      setRefunding(null);
      setReason('');
      setPassword('');
      await load(user.id);
      onChanged();
    } catch (err) {
      setRefundError(err instanceof Error ? err.message : 'The refund was refused.');
    } finally {
      setBusy(false);
    }
  }

  const purposes = consent ? Object.entries(consent.current) : [];

  return (
    <Dialog.Root open={!!user} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP} />
        <Dialog.Popup
          className={clsx(
            POPUP,
            'flex max-h-[min(88dvh,52rem)] w-[min(720px,calc(100vw-2rem))] flex-col',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-h5">{user?.email}</Dialog.Title>
              <Dialog.Description className="mt-1 text-small text-fg-muted">
                Their dubs, what each one cost, and what they have agreed to.
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={
                <Button variant="ghost" size="sm" type="button">
                  Close
                </Button>
              }
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            {error && (
              <div className="mb-4">
                <ErrorNote>{error}</ErrorNote>
              </div>
            )}

            <h3 className="text-eyebrow uppercase text-fg-subtle">Dubs</h3>
            {jobs === null ? (
              <div className="mt-3 space-y-2">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : jobs.length === 0 ? (
              <p className="mt-2 text-small text-fg-muted">No dubs yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-ink-700 overflow-hidden rounded-xl border border-ink-700">
                {jobs.map((j) => (
                  <li key={j.job_id} className="flex items-center gap-3 px-3.5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-small font-medium">
                        {languageLabel(j.target_lang)}
                        <span className="font-normal text-fg-subtle"> · {j.video_name}</span>
                      </p>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-tiny text-fg-subtle">
                        <span className="flex min-w-0 max-w-full">
                          <JobStateBadge state={j.state} errorCode={j.error_code} truncate />
                        </span>
                        <span className="tabular-nums">{minutes(j.minutes_charged)} charged</span>
                        {j.already_refunded && (
                          <span className="tabular-nums text-good">
                            {minutes(j.minutes_refunded)} refunded
                          </span>
                        )}
                        <span>{when(j.created_at)}</span>
                        <span className="font-mono">{j.job_id}</span>
                      </div>
                    </div>
                    {j.refundable && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="shrink-0"
                        onClick={() => {
                          setRefunding(j);
                          setRefundError(null);
                        }}
                      >
                        Refund
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/*
              The refund form, in place rather than in a second dialog: it is one
              decision about one row that is still visible above it.
            */}
            {refunding && (
              <form
                onSubmit={refund}
                className="mt-4 rounded-xl border border-warn/35 bg-warn/[0.06] p-4"
              >
                <p className="text-small font-medium text-fg">
                  Refund {minutes(refunding.minutes_charged)} for the{' '}
                  {languageLabel(refunding.target_lang)} dub of {refunding.video_name}?
                </p>
                <p className="mt-1 text-tiny leading-relaxed text-fg-muted">
                  The minutes go back to where they came from - the plan, or bought extra
                  minutes. The original charge is kept on record. This cannot be refunded
                  twice.
                </p>
                <div className="mt-4">
                  <Field
                    label="Reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why this dub is being refunded"
                    hint="Goes in the audit log."
                    required
                  />
                  <Field
                    label="Your password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    hint="Asked again so a stolen session cannot hand out minutes."
                    required
                  />
                </div>
                {refundError && (
                  <div className="mb-4">
                    <ErrorNote>{refundError}</ErrorNote>
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setRefunding(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={busy}>
                    Refund the minutes
                  </Button>
                </div>
              </form>
            )}

            <h3 className="mt-7 text-eyebrow uppercase text-fg-subtle">Consent</h3>
            {consent === null ? (
              <Skeleton className="mt-3 h-16" />
            ) : purposes.length === 0 ? (
              <p className="mt-2 text-small text-fg-muted">No consent recorded.</p>
            ) : (
              <>
                <ul className="mt-2 divide-y divide-ink-700 overflow-hidden rounded-xl border border-ink-700">
                  {/* Two lines per purpose, not one: on a phone the date and notice
                      version left the purpose name no width at all and pushed the
                      yes/no pill off the edge. */}
                  {purposes.map(([purpose, s]) => (
                    <li key={purpose} className="px-3.5 py-2.5 text-small">
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate">{purpose.replace(/_/g, ' ')}</span>
                        <Badge tone={s.granted ? 'good' : 'neutral'}>
                          {s.granted ? 'yes' : 'no'}
                        </Badge>
                      </div>
                      <p className="mt-0.5 truncate text-tiny text-fg-subtle">
                        {when(s.at)} · notice {s.notice_version}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-tiny text-fg-subtle">
                  {consent.history.length} change{consent.history.length === 1 ? '' : 's'} on
                  record. Current notice version: {consent.notice_version}.
                </p>
                {consent.history.length > 0 && (
                  <ol className="mt-2 max-h-48 space-y-1 overflow-auto text-tiny text-fg-subtle">
                    {consent.history.slice(0, 30).map((h: ConsentRecord, i: number) => (
                      <li key={`${h.at}-${h.purpose}-${i}`} className="truncate">
                        {when(h.at)} · {h.purpose.replace(/_/g, ' ')} ·{' '}
                        {h.granted ? 'granted' : 'withdrawn'} · {h.method}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── signups from one address ─────────────────────────────────────────────── */

const WINDOWS = [
  [24, 'last 24 hours'],
  [168, 'last 7 days'],
  [720, 'last 30 days'],
  [2160, 'last 90 days'],
] as const;

/**
 * Accounts created from the same address. A REPORT, not enforcement, and it says so:
 * offices, colleges and mobile networks put many real people behind one address.
 * Loaded when asked for, because each look is written to the access log.
 */
function SignupsCard() {
  const [hours, setHours] = useState<number>(168);
  const [report, setReport] = useState<SignupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(h: number) {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.admin.signups(h, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the report.');
    } finally {
      setBusy(false);
    }
  }

  const windowLabel = WINDOWS.find(([h]) => h === hours)?.[1] ?? `last ${hours} hours`;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-body font-medium">Signups from one address</h2>
          <p className="mt-0.5 text-tiny text-fg-subtle">
            Several accounts from the same address. A reason to look, not proof.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={hours}
            aria-label="How far back"
            onChange={(e) => {
              const h = Number(e.target.value);
              setHours(h);
              if (report) void load(h);
            }}
            className="h-8 rounded-full border border-ink-700 bg-ink-900 px-3 text-tiny focus:border-fg-subtle focus:outline-none"
          >
            {WINDOWS.map(([h, label]) => (
              <option key={h} value={h}>
                {label}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void load(hours)}>
            {report ? 'Refresh' : 'Show'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {!report ? (
        <EmptyState
          title="Not loaded yet"
          body="Opening this is recorded in the access log, because it shows other people's addresses."
        />
      ) : report.clusters.length === 0 ? (
        <EmptyState
          title="No shared addresses"
          body={`No address created two or more accounts in the ${windowLabel}.`}
        />
      ) : (
        <ul className="max-h-96 divide-y divide-ink-700 overflow-auto">
          {report.clusters.map((c) => (
            <li key={c.ip} className="px-5 py-3 text-tiny">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-mono text-small text-fg">{c.ip}</span>
                <span className="text-fg-subtle">
                  {c.accounts} accounts · {c.confirmed} confirmed
                  {c.suspended > 0 ? ` · ${c.suspended} suspended` : ''}
                </span>
              </div>
              <p className="mt-0.5 text-fg-subtle">
                {when(c.first_at)} to {when(c.last_at)}
              </p>
              <ul className="mt-1.5 space-y-1">
                {c.users.map((u) => (
                  <li key={u.id} className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-fg-muted">{u.email}</span>
                    {!u.confirmed && <Badge tone="neutral">unconfirmed</Badge>}
                    {u.status === 'suspended' && <Badge tone="bad">suspended</Badge>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {report && (
        <p className="border-t border-ink-700 px-5 py-2.5 text-tiny leading-relaxed text-fg-subtle">
          {report.accounts_without_signup_ip} account
          {report.accounts_without_signup_ip === 1 ? ' has' : 's have'} no recorded address.
          Signup limit: {report.ceiling.per_ip_per_hour} an hour and{' '}
          {report.ceiling.per_ip_per_day} a day from one address.
        </p>
      )}
    </Card>
  );
}

/* ── who looked at whose personal data ───────────────────────────────────── */

/**
 * The personal-data access log: every admin screen that read somebody's data, when, and
 * how many rows. Reading it is itself an access, so it logs itself - which is also why
 * it loads on request rather than on every visit.
 */
function AccessLogCard() {
  const [rows, setRows] = useState<AccessLogEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setRows((await api.admin.accessLog(100)).access_log);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the access log.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-body font-medium">Personal data access log</h2>
          <p className="mt-0.5 text-tiny text-fg-subtle">
            Which admin looked at whose data, and when. Newest first.
          </p>
        </div>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void load()}>
          {rows ? 'Refresh' : 'Show'}
        </Button>
      </div>

      {error && (
        <div className="p-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {!rows ? (
        <EmptyState title="Not loaded yet" body="Opening it adds a line to it, like any other look." />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing recorded yet" />
      ) : (
        <ol className="max-h-96 divide-y divide-ink-700 overflow-auto">
          {rows.map((r) => (
            <li key={r.id} className="px-5 py-2.5 text-tiny">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{r.surface}</span>
                <span className="shrink-0 text-fg-subtle">{when(r.at)}</span>
              </div>
              <p className="mt-0.5 text-fg-subtle">
                {r.admin_email ?? `#${r.admin_user_id}`}
                {r.target_user_id != null ? ` · account #${r.target_user_id}` : ''}
                {r.rows_returned != null ? ` · ${r.rows_returned} row${r.rows_returned === 1 ? '' : 's'}` : ''}
                {r.detail ? ` · ${r.detail}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
