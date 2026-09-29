/**
 * Storage, outbox, rate limits, the pinned preset, portability and the database.
 *
 * Grouped onto one page on purpose: these are the things you look at when
 * something is wrong, and hunting across five screens during an incident is worse
 * than scrolling one.
 */
import { Tabs } from '@base-ui/react/tabs';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  api,
  type DbOverview,
  type MailStatus,
  type MaintenanceState,
  type Portability,
  type SeoStatus,
  type StorageStatus,
} from '../../lib/api';
import { bytes, when } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Badge, Card, EmptyState, ErrorNote, InfoNote, Skeleton } from '../../ui/primitives';

type Bundle = {
  storage: StorageStatus;
  mail: MailStatus;
  limits: { buckets: Record<string, { max_hits: number; window_s: number }>; scope: string; note: string };
  preset: Record<string, unknown>;
  portability: Portability;
  db: DbOverview;
};

const TABS = [
  { id: 'storage', label: 'Storage' },
  { id: 'mail', label: 'Outbox' },
  { id: 'limits', label: 'Rate limits' },
  { id: 'preset', label: 'Preset' },
  { id: 'move', label: 'Portability' },
  { id: 'db', label: 'Database' },
] as const;

export function AdminSystem() {
  const [data, setData] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [storage, mail, limits, preset, portability, db] = await Promise.all([
        api.admin.storage(),
        api.admin.mail(50),
        api.admin.limits(),
        api.admin.preset(),
        api.admin.portability(),
        api.admin.db(),
      ]);
      setData({ storage, mail, limits, preset, portability, db });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load system status.');
    }
  }, []);

  useEffect(() => {
    void load();
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
      <div className="space-y-4 px-5 py-8 sm:px-8 lg:px-10">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-10 w-full max-w-lg" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="px-5 py-8 sm:px-8 lg:px-10">
      <header className="mb-7">
        <h1 className="text-h3">System</h1>
        <p className="mt-1.5 text-body text-fg-muted">
          Where things are kept, what was sent, and what is enforced.
        </p>
      </header>

      {/*
        ABOVE the tabs, not inside one. It is the single most disruptive switch in the
        panel and the one you need in a hurry — burying it behind a tab is how you end
        up clicking through three panels while the site is broken.
      */}
      <MaintenanceCard />

      <Tabs.Root defaultValue="storage">
        <Tabs.List className="mb-6 flex flex-wrap gap-1 rounded-full border-2 border-ink-600 bg-ink-900 p-1">
          {TABS.map((t) => (
            <Tabs.Tab
              key={t.id}
              value={t.id}
              className={clsx(
                'rounded-full px-4 py-1.5 text-tiny',
                'transition-[background-color,color] duration-[160ms] ease-[var(--ease-out-strong)]',
                'text-fg-muted hover:text-fg',
                'data-[selected]:bg-ink-800 data-[selected]:font-medium data-[selected]:text-fg',
              )}
            >
              {t.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        {/* ── storage ─────────────────────────────────────────────────────── */}
        <Tabs.Panel value="storage">
          <Card className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-h5">
                Delivering from {data.storage.backend === 'cloudflare-r2' ? 'Cloudflare R2' : 'local disk'}
              </h2>
              <Badge tone={data.storage.backend === 'cloudflare-r2' ? 'good' : 'warn'}>
                {data.storage.backend}
              </Badge>
            </div>
            <p className="mt-2 text-small leading-relaxed text-fg-muted">{data.storage.note}</p>

            {/* `grid-cols-1` is `minmax(0,1fr)`, which is what lets a long value (the
                output directory path) truncate. With no explicit column the track grew to
                the full path and the page scrolled sideways on a phone. */}
            <dl className="mt-5 grid grid-cols-1 gap-x-10 gap-y-2 text-small sm:grid-cols-2">
              <KV k="Credentials present" v={data.storage.r2_configured ? 'yes' : 'no'} />
              <KV k="Switched on" v={data.storage.r2_enabled_flag ? 'yes' : 'no'} />
              <KV k="Bucket" v={data.storage.bucket ?? '—'} />
              <KV k="Prefix" v={data.storage.prefix} />
              <KV k="Videos on R2" v={String(data.storage.jobs_on_r2 ?? 0)} />
              <KV k="Videos on local disk only" v={String(data.storage.jobs_local_only ?? 0)} />
              <KV k="Download token lifetime" v={`${data.storage.download_token_ttl_s ?? 0}s`} />
              <KV k="Local output directory" v={data.storage.local_output_dir ?? '—'} />
            </dl>

            {data.storage.r2_configured && !data.storage.r2_enabled_flag && (
              <div className="mt-5">
                <InfoNote>
                  Credentials are in place but the switch is off. These are two different
                  states, and only one of them changes where the bytes go.
                </InfoNote>
              </div>
            )}
          </Card>
        </Tabs.Panel>

        {/* ── mail ────────────────────────────────────────────────────────── */}
        <Tabs.Panel value="mail">
          <Card className="overflow-hidden">
            <div className="border-b border-ink-700 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-body font-medium">Outbox</h2>
                {/* `resend` counts as healthy alongside `ses` — both actually send.
                    Only the `file` backend is a warning, because it writes to disk
                    and nobody receives anything. */}
                <Badge
                  tone={
                    data.mail.backend === 'file'
                      ? 'warn'
                      : data.mail.resend_key_present === false
                        ? 'bad'
                        : 'good'
                  }
                >
                  {data.mail.backend}
                </Badge>
                {data.mail.from && (
                  <span className="font-mono text-tiny text-fg-subtle">
                    from {data.mail.from}
                  </span>
                )}
                {(data.mail.failed_recently ?? 0) > 0 && (
                  <Badge tone="bad">{data.mail.failed_recently} failed</Badge>
                )}
              </div>
              {/* The silent failure this exists for: with the backend set to resend
                  and no key, every signup still succeeds and no confirmation email is
                  ever sent — indistinguishable from users ignoring their inbox. */}
              {data.mail.resend_key_present === false && (
                <p className="mt-2 text-tiny leading-relaxed text-red-300">
                  No Resend API key found, so nothing is being emailed. Put{' '}
                  <span className="font-mono">RESEND_API_KEY=…</span> in{' '}
                  <span className="font-mono">{data.mail.resend_key_file}</span> and
                  restart the backend.
                </p>
              )}
              <p className="mt-1 text-tiny leading-relaxed text-fg-subtle">
                {data.mail.note} Files land in{' '}
                <span className="font-mono">{data.mail.outbox_dir}</span>.
              </p>
            </div>
            {data.mail.emails.length === 0 ? (
              <EmptyState title="Nothing sent yet" />
            ) : (
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full text-left text-small">
                  <thead className="sticky top-0 bg-ink-850">
                    <tr className="border-b border-ink-700 text-eyebrow uppercase text-fg-subtle">
                      <th className="px-5 py-2.5 font-medium">When</th>
                      <th className="px-5 py-2.5 font-medium">To</th>
                      <th className="px-5 py-2.5 font-medium">Kind</th>
                      <th className="px-5 py-2.5 font-medium">Subject</th>
                      <th className="px-5 py-2.5 font-medium">Sent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-700">
                    {data.mail.emails.map((m) => (
                      <tr key={m.id}>
                        <td className="px-5 py-2.5 text-fg-subtle">{when(m.at)}</td>
                        <td className="px-5 py-2.5">{m.to_email}</td>
                        <td className="px-5 py-2.5 font-mono text-tiny text-fg-muted">
                          {m.kind}
                        </td>
                        <td className="px-5 py-2.5 text-fg-muted">{m.subject}</td>
                        <td className="px-5 py-2.5">
                          {m.ok ? (
                            <Badge tone="good">yes</Badge>
                          ) : (
                            <Badge tone="bad">{m.error?.slice(0, 30) ?? 'no'}</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </Tabs.Panel>

        {/* ── limits ──────────────────────────────────────────────────────── */}
        <Tabs.Panel value="limits">
          <Card className="p-5 sm:p-6">
            <h2 className="text-h5">What the rate limiter enforces</h2>
            <p className="mt-1.5 text-small text-fg-muted">
              {data.limits.scope}. {data.limits.note}
            </p>
            <div className="mt-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(data.limits.buckets).map(([name, b]) => (
                <div key={name} className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3">
                  <p className="font-mono text-tiny text-fg">{name}</p>
                  <p className="mt-1 text-small">
                    {b.max_hits} per{' '}
                    {b.window_s >= 3600
                      ? `${b.window_s / 3600} hour${b.window_s === 3600 ? '' : 's'}`
                      : `${b.window_s / 60} min`}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-5">
              <InfoNote>
                Useful when a customer says they were locked out — this tells you whether
                that was us.
              </InfoNote>
            </div>
          </Card>
        </Tabs.Panel>

        {/* ── preset ──────────────────────────────────────────────────────── */}
        <Tabs.Panel value="preset">
          <Card className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-h5">The pinned pipeline preset</h2>
              <Badge tone="brand">{String(data.preset.version)}</Badge>
            </div>
            <p className="mt-2 text-small leading-relaxed text-fg-muted">
              Read-only on purpose. This is exactly what is sent to the engine, and its
              fingerprint is recorded on every job so any dub can be traced to the settings
              that produced it. A client that tries to set a pipeline value is refused.
            </p>
            <pre className="mt-5 max-h-[440px] overflow-auto rounded-xl border border-ink-700 bg-ink-950 p-4 font-mono text-tiny leading-relaxed text-fg-muted">
              {JSON.stringify(data.preset, null, 2)}
            </pre>
          </Card>
        </Tabs.Panel>

        {/* ── portability ─────────────────────────────────────────────────── */}
        <Tabs.Panel value="move">
          <Card className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <h2 className="text-h5">Could this move to another AWS account</h2>
                <Badge tone={data.portability.movable ? 'good' : 'bad'}>
                  {data.portability.movable ? 'yes' : 'blocked'}
                </Badge>
              </div>
              <Button
                variant="secondary"
                loading={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    const res = await api.admin.export();
                    toast.success('Archive written', { description: res.archive });
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : 'Export failed.');
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                Write a migration archive
              </Button>
            </div>

            <p className="mt-2 font-mono text-tiny text-fg-subtle">
              schema {data.portability.schema_fingerprint.slice(0, 16)} · {data.portability.tables}{' '}
              tables
            </p>

            {data.portability.blockers.length > 0 && (
              <div className="mt-5 space-y-2.5">
                {data.portability.blockers.map((b) => (
                  <ErrorNote key={b.what}>
                    <p className="font-medium">{b.what}</p>
                    <p className="mt-1">{b.why}</p>
                    <p className="mt-1 opacity-80">Fix: {b.fix}</p>
                  </ErrorNote>
                ))}
              </div>
            )}

            {data.portability.warnings.length > 0 && (
              <div className="mt-5 space-y-2.5">
                {data.portability.warnings.map((w) => (
                  <div
                    key={w.what}
                    className="rounded-xl border border-warn/35 bg-warn/10 px-4 py-3 text-small text-warn"
                  >
                    <p className="font-medium">{w.what}</p>
                    <p className="mt-1 leading-relaxed opacity-90">{w.why}</p>
                    <p className="mt-1 opacity-75">Fix: {w.fix}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div>
                <p className="text-tiny font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Moves with the archive
                </p>
                <dl className="mt-3 space-y-2.5 text-tiny">
                  {Object.entries(data.portability.what_moves).map(([k, v]) => (
                    <div key={k}>
                      <dt className="font-medium capitalize">{k}</dt>
                      <dd className="mt-0.5 leading-relaxed text-fg-subtle">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div>
                <p className="text-tiny font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Does not move
                </p>
                <dl className="mt-3 space-y-2.5 text-tiny">
                  {Object.entries(data.portability.what_does_not_move).map(([k, v]) => (
                    <div key={k}>
                      <dt className="font-medium capitalize">{k}</dt>
                      <dd className="mt-0.5 leading-relaxed text-fg-subtle">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </Card>
        </Tabs.Panel>

        {/* ── database ────────────────────────────────────────────────────── */}
        <Tabs.Panel value="db">
          <Card className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-h5">The database</h2>
                <p className="mt-1 font-mono text-tiny text-fg-subtle">
                  {data.db.database_file} · {bytes(data.db.size_bytes)} · {data.db.engine}
                </p>
              </div>
              <a href="/db" target="_blank" rel="noreferrer">
                <Button variant="secondary">Open the browser</Button>
              </a>
            </div>

            <div className="mt-4">
              <InfoNote>
                Read-only, and not by politeness — the file is opened in read-only mode at
                the driver level, so a write is refused by SQLite itself rather than by a
                keyword check that could be talked around. Password hashes and session
                tokens are masked in every result.
              </InfoNote>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.db.tables.map((t) => (
                <div
                  key={t.table}
                  className="flex items-center justify-between rounded-xl border border-ink-700 bg-ink-900 px-4 py-2.5"
                >
                  <span className="font-mono text-tiny">{t.table}</span>
                  <span className="tabular-nums text-tiny text-fg-subtle">{t.rows}</span>
                </div>
              ))}
            </div>
          </Card>
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-ink-700/60 pb-2">
      <dt className="shrink-0 text-fg-subtle">{k}</dt>
      <dd className="truncate text-right" title={v}>
        {v}
      </dd>
    </div>
  );
}


/**
 * Maintenance mode, and what crawlers are being told.
 *
 * Two things that look unrelated and belong together: both are switches that change
 * what the outside world sees without changing a line of code, and both are silently
 * catastrophic when wrong. Maintenance left on is a site that is down; a non-https
 * PUBLIC_BASE_URL means robots.txt is serving `Disallow: /` and the whole site is
 * quietly de-indexed. Neither shows up anywhere else in the product.
 *
 * THE CONFIRM STEP. Turning it ON is armed first, because it takes the site off the
 * internet for everybody who is not an admin. Turning it OFF is one click — the
 * asymmetry is deliberate: the dangerous direction gets friction, and the recovery
 * direction gets none, because that is the one you will be doing under pressure.
 */
function MaintenanceCard() {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [seo, setSeo] = useState<SeoStatus | null>(null);
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.admin.maintenance().then(setState).catch(() => undefined);
    void api.admin.seo().then(setSeo).catch(() => undefined);
  }, []);

  useEffect(() => load(), [load]);

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      const res = await api.admin.setMaintenance(on, note);
      setState(res);
      setArmed(false);
      setNote('');
      toast[on ? 'warning' : 'success'](
        on ? 'The site is now in maintenance mode' : 'The site is public again',
        { description: res.note_to_admin },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not save.');
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2">
      <Card
        data-maintenance-card="true"
        className={clsx('p-5', state.on ? 'border-warn/45 bg-warn/[0.05]' : 'border-ink-700')}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-h5">Maintenance mode</h2>
              {state.on ? (
                <Badge tone="warn" dot pulse>
                  Site is off
                </Badge>
              ) : (
                <Badge tone="good" dot>
                  Live
                </Badge>
              )}
            </div>
            <p className="mt-1.5 max-w-md text-small leading-relaxed text-fg-subtle">
              {state.on
                ? 'Everyone except an admin session is getting a 503 with a Retry-After. You still see the real site, so you can check your changes.'
                : 'Turns the public site and the API off for everybody except admins, so you can make changes without anybody hitting a half-migrated database.'}
            </p>
            {state.on && state.since && (
              <p className="mt-2 text-tiny text-warn">
                On since {when(state.since)}
                {state.by ? ` · switched by ${state.by}` : ''}
              </p>
            )}
          </div>

          {state.on ? (
            // One click back. This is the direction you take under pressure.
            <Button variant="primary" loading={busy} onClick={() => void toggle(false)}>
              Bring the site back
            </Button>
          ) : !armed ? (
            <Button variant="secondary" onClick={() => setArmed(true)}>
              Take the site offline
            </Button>
          ) : null}
        </div>

        {state.on && (
          <p className="mt-4 rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2.5 text-tiny leading-relaxed text-fg-muted">
            <span className="text-fg-subtle">Visitors are seeing:</span> {state.note}
          </p>
        )}

        {armed && !state.on && (
          <div className="mt-4 rounded-xl border border-warn/40 bg-warn/[0.06] p-4">
            <label
              htmlFor="maint-note"
              className="mb-1.5 block text-small font-medium text-fg-muted"
            >
              What should visitors be told?
            </label>
            <textarea
              id="maint-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={400}
              placeholder="Migrating the database. Back in about 20 minutes."
              className="w-full resize-y rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2.5 text-small text-fg placeholder:text-fg-subtle focus:border-fg-subtle focus:outline-none"
            />
            <p className="mt-1.5 text-tiny text-fg-subtle">
              Optional. Left blank, the page says we are making changes and that nothing
              is being deleted.
            </p>
            <div className="mt-3 flex flex-wrap gap-2.5">
              <Button variant="danger" loading={busy} onClick={() => void toggle(true)}>
                Take it offline now
              </Button>
              <Button variant="ghost" onClick={() => setArmed(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* What crawlers are being told. Read-only — it is driven by PUBLIC_BASE_URL. */}
      {seo && (
        <Card className={clsx('p-5', seo.indexable ? 'border-ink-700' : 'border-bad/40 bg-bad/[0.05]')}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h5">Search engines</h2>
            {seo.indexable ? (
              <Badge tone="good" dot>
                Indexable
              </Badge>
            ) : (
              <Badge tone="bad" dot>
                Blocked
              </Badge>
            )}
          </div>
          {seo.why_not ? (
            <p className="mt-2 text-small leading-relaxed text-bad">{seo.why_not}</p>
          ) : (
            <p className="mt-2 text-small leading-relaxed text-fg-subtle">
              robots.txt allows crawling and points at the sitemap. Both are generated
              from the live origin, so neither can name the wrong domain.
            </p>
          )}
          <dl className="mt-3 space-y-1 text-tiny">
            <div className="flex gap-2">
              <dt className="shrink-0 text-fg-subtle">Origin</dt>
              <dd className="min-w-0 truncate font-mono text-fg-muted">
                {seo.public_base_url || '(unset)'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-fg-subtle">Sitemap</dt>
              <dd className="min-w-0 truncate font-mono text-fg-muted">
                {seo.pages.length} page{seo.pages.length === 1 ? '' : 's'}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/robots.txt" target="_blank" rel="noreferrer">
              <Button size="sm" variant="secondary">
                robots.txt
              </Button>
            </a>
            <a href="/sitemap.xml" target="_blank" rel="noreferrer">
              <Button size="sm" variant="secondary">
                sitemap.xml
              </Button>
            </a>
          </div>
        </Card>
      )}
    </div>
  );
}
