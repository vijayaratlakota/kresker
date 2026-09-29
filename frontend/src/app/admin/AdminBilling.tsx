/**
 * Money, in one place: which payment provider is live and how, what was paid, who is
 * subscribed, what the provider has told us (webhooks, including the ones we refused),
 * checkouts that were started, and chargebacks.
 *
 * READ-ONLY except for one button - the renewal-reminder and expiry sweep - and that is
 * the same sweep the worker already runs by itself every five minutes. Nothing here can
 * charge anybody or move money.
 *
 * Rows arrive as whole database rows, so each table names the columns it shows and
 * reads them defensively: a column the backend stops sending renders as a dash instead
 * of breaking the page.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, type AdminBilling as BillingData } from '../../lib/api';
import { rupees, when } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Badge, Card, EmptyState, ErrorNote, Skeleton } from '../../ui/primitives';

type Row = Record<string, unknown>;

interface Column {
  label: string;
  cell: (r: Row) => ReactNode;
  className?: string;
}

const text = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—' : String(v);

const stamp = (v: unknown): string => (typeof v === 'string' && v ? when(v) : '—');

const money = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? rupees(n) : '—';
};

const yesNo = (v: unknown): ReactNode =>
  v === null || v === undefined ? '—' : Number(v) ? 'yes' : 'no';

/** A status as a coloured pill: green for money that arrived, red for failures. */
function Status({ value }: { value: unknown }) {
  const s = text(value);
  const tone =
    /^(captured|paid|succeeded|active|completed|won)$/i.test(s)
      ? 'good'
      : /^(failed|refunded|cancelled|expired|lost|rejected)$/i.test(s)
        ? 'bad'
        : /^(pending|created|open|processing|needs_response|under_review)$/i.test(s)
          ? 'warn'
          : 'neutral';
  return <Badge tone={tone}>{s}</Badge>;
}

function Mono({ value }: { value: unknown }) {
  return <span className="font-mono text-tiny text-fg-subtle">{text(value)}</span>;
}

const PAYMENTS: Column[] = [
  { label: 'When', cell: (r) => stamp(r.at), className: 'whitespace-nowrap text-fg-subtle' },
  { label: 'Account', cell: (r) => text(r.email) },
  { label: 'Amount', cell: (r) => money(r.amount_paise), className: 'tabular-nums whitespace-nowrap' },
  { label: 'Status', cell: (r) => <Status value={r.status} /> },
  { label: 'Plan', cell: (r) => text(r.plan_code) },
  { label: 'Method', cell: (r) => text(r.method) },
  { label: 'Provider id', cell: (r) => <Mono value={r.provider_payment_id} /> },
];

const SUBSCRIPTIONS: Column[] = [
  { label: 'Account', cell: (r) => text(r.email) },
  { label: 'Plan', cell: (r) => text(r.plan_name ?? r.plan_code) },
  { label: 'Status', cell: (r) => <Status value={r.status} /> },
  { label: 'Renews', cell: (r) => yesNo(r.auto_renew) },
  { label: 'Period ends', cell: (r) => stamp(r.current_period_end), className: 'whitespace-nowrap' },
  { label: 'Change queued', cell: (r) => (r.scheduled_plan_code ? `${text(r.scheduled_plan_code)} (${text(r.scheduled_kind)})` : '—') },
  { label: 'Provider', cell: (r) => text(r.provider) },
];

const CHECKOUTS: Column[] = [
  { label: 'Started', cell: (r) => stamp(r.created_at), className: 'whitespace-nowrap text-fg-subtle' },
  { label: 'Plan', cell: (r) => text(r.plan_code) },
  { label: 'Amount', cell: (r) => money(r.amount_paise), className: 'tabular-nums whitespace-nowrap' },
  { label: 'Status', cell: (r) => <Status value={r.status} /> },
  { label: 'Mode', cell: (r) => text(r.mode) },
  { label: 'Why it failed', cell: (r) => text(r.failure_message ?? r.failure_code) },
];

const WEBHOOKS: Column[] = [
  { label: 'When', cell: (r) => stamp(r.at), className: 'whitespace-nowrap text-fg-subtle' },
  { label: 'Event', cell: (r) => text(r.event_type) },
  { label: 'Signature', cell: (r) => (Number(r.signature_ok) ? 'ok' : <Badge tone="bad">bad</Badge>) },
  { label: 'Handled', cell: (r) => yesNo(r.handled) },
  { label: 'Result', cell: (r) => <span className="text-tiny text-fg-muted">{text(r.result)}</span> },
];

const REJECTS: Column[] = [
  { label: 'When', cell: (r) => stamp(r.at), className: 'whitespace-nowrap text-fg-subtle' },
  { label: 'Why', cell: (r) => text(r.why) },
  { label: 'From', cell: (r) => <Mono value={r.ip} /> },
  { label: 'Bytes', cell: (r) => text(r.bytes), className: 'tabular-nums' },
];

const DISPUTES: Column[] = [
  { label: 'Updated', cell: (r) => stamp(r.updated_at), className: 'whitespace-nowrap text-fg-subtle' },
  { label: 'Account', cell: (r) => text(r.email) },
  { label: 'Amount', cell: (r) => money(r.amount_paise), className: 'tabular-nums whitespace-nowrap' },
  { label: 'Status', cell: (r) => <Status value={r.status} /> },
  { label: 'Stage', cell: (r) => text(r.stage) },
  { label: 'Outcome', cell: (r) => text(r.outcome) },
];

function RowsCard({
  title,
  subtitle,
  rows,
  columns,
  empty,
}: {
  title: string;
  subtitle?: string;
  rows: Row[] | undefined;
  columns: Column[];
  empty: string;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-700 px-5 py-4">
        <h2 className="text-body font-medium">
          {title}
          {rows && rows.length > 0 && (
            <span className="ml-2 text-small font-normal tabular-nums text-fg-subtle">
              {rows.length}
            </span>
          )}
        </h2>
        {subtitle && <p className="mt-0.5 text-tiny text-fg-subtle">{subtitle}</p>}
      </div>
      {!rows || rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        // A dense operator table: it scrolls sideways on a phone, on purpose, rather than
        // hiding columns an operator needs to compare.
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-left text-small">
            <thead className="sticky top-0 z-10 bg-ink-850">
              <tr className="border-b border-ink-700 text-eyebrow uppercase text-fg-subtle">
                {columns.map((c) => (
                  <th key={c.label} className="whitespace-nowrap px-4 py-2.5 font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700">
              {rows.map((r, i) => (
                <tr key={String(r.id ?? r.dispute_id ?? r.event_id ?? i)}>
                  {columns.map((c) => (
                    <td key={c.label} className={clsx('px-4 py-2.5 align-top', c.className)}>
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The provider's configuration, as flags. Never a secret: the backend sends presence only. */
function ProviderCard({ provider }: { provider: Row }) {
  const entries = Object.entries(provider).filter(([k]) => k !== 'note');
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-body font-medium">Payment provider</h2>
        <Badge tone={provider.real_money_possible ? 'good' : 'warn'}>
          {provider.real_money_possible ? 'real money' : 'test mode'}
        </Badge>
      </div>
      {typeof provider.note === 'string' && (
        <p className="mt-1.5 text-small text-fg-muted">{provider.note}</p>
      )}
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-tiny sm:grid-cols-2">
        {entries.map(([k, v]) => (
          <div key={k} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-ink-800 pb-1.5">
            <dt className="shrink-0 text-fg-subtle">{k.replace(/_/g, ' ')}</dt>
            <dd className="min-w-0 truncate text-right font-mono text-fg-muted">
              {Array.isArray(v)
                ? v.length
                  ? v.join(', ')
                  : 'none'
                : typeof v === 'boolean'
                  ? v
                    ? 'yes'
                    : 'no'
                  : text(v)}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Counts out of whatever the sweep reports, e.g. {sent: [...]} -> "sent 2". */
function summarise(part: unknown): string {
  if (!part || typeof part !== 'object') return text(part);
  const bits = Object.entries(part as Row).map(([k, v]) =>
    Array.isArray(v) ? `${k.replace(/_/g, ' ')} ${v.length}` : `${k.replace(/_/g, ' ')} ${text(v)}`,
  );
  return bits.length ? bits.join(', ') : 'nothing due';
}

export function AdminBilling() {
  const [data, setData] = useState<BillingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.admin.billing(100));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load billing.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sweep() {
    setSweeping(true);
    try {
      const res = await api.admin.billingSweep();
      toast.success('Sweep finished', {
        description: `Reminders: ${summarise(res.reminders)}. Expiries: ${summarise(res.expiries)}. Plan changes: ${summarise(res.plan_changes)}.`,
      });
      void load();
    } catch (err) {
      toast.error('The sweep failed', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSweeping(false);
    }
  }

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-h3">Billing</h1>
          <p className="mt-1.5 text-body text-fg-muted">
            Payments, subscriptions and what the payment provider told us. Read-only.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
          {/*
            The same reminder-and-expiry sweep the worker runs every five minutes. Useful
            right after fixing a plan by hand; it sends only reminders that are already due.
          */}
          <Button size="sm" onClick={() => void sweep()} loading={sweeping}>
            Run the renewal sweep now
          </Button>
        </div>
      </header>

      {error && (
        <div className="mb-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {!data ? (
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="space-y-6">
          <ProviderCard provider={data.provider} />
          {data.disputes && data.disputes.length > 0 && (
            <RowsCard
              title="Chargebacks"
              subtitle="Open ones first: deciding whether to contest one has a deadline."
              rows={data.disputes}
              columns={DISPUTES}
              empty="No chargebacks"
            />
          )}
          <RowsCard title="Payments" rows={data.payments} columns={PAYMENTS} empty="No payments yet" />
          <RowsCard
            title="Subscriptions"
            rows={data.subscriptions}
            columns={SUBSCRIPTIONS}
            empty="No subscriptions yet"
          />
          <RowsCard
            title="Checkouts started"
            subtitle="Every checkout page opened, including the ones nobody finished."
            rows={data.checkout_sessions}
            columns={CHECKOUTS}
            empty="No checkouts yet"
          />
          <div className="grid gap-6 xl:grid-cols-2">
            <RowsCard
              title="Webhooks received"
              rows={data.webhook_events}
              columns={WEBHOOKS}
              empty="No webhooks yet"
            />
            <RowsCard
              title="Webhooks refused"
              subtitle="Bad signatures and malformed requests. A burst here is worth a look."
              rows={data.webhook_rejects}
              columns={REJECTS}
              empty="Nothing refused"
            />
          </div>
        </div>
      )}
    </div>
  );
}
