/**
 * "Your data" — the signed-in self-service page.
 *
 * A signed-in person should not have to ask us for their own data. The session
 * already proves who they are, which is the entire thing that makes an anonymous
 * request slow: there is nothing left to verify. So access and erasure happen here
 * immediately, and the contact form exists for people who cannot get in.
 *
 * Three things it shows that a settings page normally would not:
 *
 *  - The consent LEDGER, not a set of switches. Every grant and withdrawal, with the
 *    notice version attached. If somebody disputes what they agreed to, this is the
 *    answer, and showing it to them is more honest than keeping it admin-only.
 *  - Erasure spelled out in advance — what is destroyed and what is retained and
 *    why — rather than a confirm dialog that says "this cannot be undone".
 *  - The retention timer as a date, from the same API the Privacy Notice reads.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ApiError,
  api,
  type ConsentPurpose,
  type ConsentRecord,
  type ConsentState,
} from '../lib/api';
import { when } from '../lib/format';
import { useSession } from '../lib/session';
import { Button } from '../ui/Button';
import { Badge, Card, CardHeader, ErrorNote, Field, InfoNote, Skeleton } from '../ui/primitives';

interface Loaded {
  notice_version: string;
  purposes: ConsentPurpose[];
  current: Record<string, ConsentState>;
  history: ConsentRecord[];
}

/**
 * The sentence a person agreed to, given its internal key.
 *
 * The history table printed the key itself in a monospace font, so the customer's own
 * consent record read `service_terms` / `process_video` / `voice_clone`. Those are
 * database values. The labels are already in the same payload, so this is a lookup and
 * not new copy — and it falls back to a tidied-up key rather than nothing, so a purpose
 * added later still reads as words before anybody remembers to label it.
 */
function purposeLabel(data: Loaded, key: string): string {
  const p = data.purposes.find((x) => x.key === key);
  if (p?.label) return p.label;
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function PrivacyCenter() {
  const me = useSession((s) => s.me);
  const signOut = useSession((s) => s.signOut);

  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.privacy.myConsent());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your consent record.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(purpose: ConsentPurpose, next: boolean) {
    setSaving(purpose.key);
    try {
      await api.privacy.setConsent({ [purpose.key]: next });
      toast.success(next ? 'Recorded — thank you' : 'Withdrawn', {
        description: next
          ? undefined
          : 'Nothing else about your account changes. It takes effect now.',
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not save.');
    } finally {
      setSaving(null);
    }
  }

  const optional = data?.purposes.filter((p) => !p.required) ?? [];
  const required = data?.purposes.filter((p) => p.required) ?? [];

  return (
    <div className="px-5 py-8 sm:px-8">
      <div className="mb-7">
        <h1 className="text-h2 tracking-tight">Your data</h1>
        <p className="mt-1.5 max-w-2xl text-small leading-relaxed text-fg-subtle">
          Everything we hold about you, what you agreed to and when, and the two buttons
          that let you take it away. No forms, no waiting — you are signed in, so there is
          nothing for us to verify.
        </p>
      </div>

      {error && (
        <div className="mb-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          {/* ── consent ─────────────────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="What you have agreed to"
              subtitle={
                data
                  ? 'This is the only place the optional ones can be turned on.'
                  : 'Loading your record'
              }
            />
            {!data ? (
              <div className="space-y-2.5 p-5">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : (
              <>
                <ul className="divide-y divide-ink-700">
                  {optional.map((p) => {
                    const st = data.current[p.key];
                    const on = st?.granted === true;
                    return (
                      <li key={p.key} className="flex items-start gap-4 px-5 py-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-small font-medium text-fg">{p.label}</p>
                          <p className="mt-1 text-tiny leading-relaxed text-fg-subtle">
                            {p.description}
                          </p>
                          <p className="mt-1.5 text-tiny text-fg-subtle">
                            {/* The notice version came off. It is our audit detail, and
                                it was printed beside every toggle. */}
                            {st
                              ? `${on ? 'Given' : 'Refused'} ${when(st.at)}`
                              : 'You have not been asked yet.'}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant={on ? 'secondary' : 'primary'}
                          loading={saving === p.key}
                          onClick={() => void toggle(p, !on)}
                        >
                          {on ? 'Withdraw' : 'Turn on'}
                        </Button>
                      </li>
                    );
                  })}
                </ul>

                {/*
                  The necessary ones are listed but have no switch, because a switch
                  that cannot be switched is worse than a statement. Withdrawing these
                  is account closure, and that is the button at the bottom of the page.
                */}
                <div className="border-t border-ink-700 px-5 py-4">
                  <p className="text-tiny uppercase tracking-[0.14em] text-fg-subtle">
                    Necessary to provide the service
                  </p>
                  <ul className="mt-3 space-y-3">
                    {required.map((p) => {
                      const st = data.current[p.key];
                      return (
                        <li key={p.key} className="flex items-start gap-3">
                          <span
                            aria-hidden="true"
                            className="mt-1 grid size-4 shrink-0 place-items-center rounded-full bg-good/15 text-good"
                          >
                            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m3.5 8.5 3 3 6-7" />
                            </svg>
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-small text-fg-muted">{p.label}</p>
                            <p className="mt-0.5 text-tiny text-fg-subtle">
                              {st
                                ? `Accepted ${when(st.at)}`
                                : 'No record — this account is older than this page.'}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-3 text-tiny leading-relaxed text-fg-subtle">
                    Accepted by creating your account and by uploading a file, with the{' '}
                    <Link to="/privacy" className="text-fg-muted underline underline-offset-2">
                      Privacy Notice
                    </Link>{' '}
                    linked beside both. They cannot be switched off and keep the service —
                    withdrawing them means closing the account, which is below.
                  </p>
                </div>
              </>
            )}
          </Card>

          {/* ── the ledger ──────────────────────────────────────────────── */}
          {data && data.history.length > 0 && (
            <Card>
              <CardHeader
                title="Your consent history"
                subtitle="Every decision, oldest first. Nothing here is ever overwritten."
                right={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowHistory((v) => !v)}
                    aria-expanded={showHistory}
                  >
                    {showHistory ? 'Hide' : `Show ${data.history.length}`}
                  </Button>
                }
              />
              {showHistory && (
                /*
                  THREE COLUMNS: when, what, and what was decided. That is the whole of
                  what this record is for.
                  
                  It had five. The other two were "which notice version applied" and
                  "whether it came from the banner or the form" — our own audit trail,
                  printed for the customer, in a table that then had to scroll sideways
                  on a phone to show them. The version and the method are still recorded
                  and still visible in the admin view of the same record; they are just
                  not something the person it describes has any use for.
                */
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[min(36rem,100%)] border-collapse text-left text-tiny">
                    <thead>
                      <tr className="border-b border-ink-700 bg-ink-900">
                        <th scope="col" className="px-3 py-2.5 font-medium text-fg-muted sm:px-5">When</th>
                        <th scope="col" className="px-3 py-2.5 font-medium text-fg-muted sm:px-5">Purpose</th>
                        <th scope="col" className="px-3 py-2.5 font-medium text-fg-muted sm:px-5">Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.history.map((h, i) => (
                        <tr key={i} className="border-b border-ink-700 last:border-b-0">
                          <td className="whitespace-nowrap px-3 py-2.5 text-fg-muted sm:px-5">{when(h.at)}</td>
                          {/*
                            THE LABEL, NOT THE KEY. This column printed the internal
                            identifier in a monospace font — `service_terms`,
                            `process_video`, `voice_clone` — which reads as a database
                            field because it is one. The person looking at their own
                            consent record needs the sentence they agreed to.
                          */}
                          <td className="px-3 py-2.5 text-fg-muted sm:px-5">
                            {purposeLabel(data, h.purpose)}
                          </td>
                          <td className="px-3 py-2.5 sm:px-5">
                            <span className={h.granted ? 'text-good' : 'text-fg-subtle'}>
                              {h.granted ? 'given' : 'withdrawn'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          <EraseCard email={me?.email ?? ''} onErased={() => void signOut()} />
        </div>

        {/* ── sidebar ───────────────────────────────────────────────────── */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Take a copy" subtitle="Everything we hold, as one file." />
            <div className="space-y-3 p-5">
              <p className="text-small leading-relaxed text-fg-muted">
                Your account, sign-ins, uploads, dubs, transcripts, payments, minutes
                used, messages and your consent history. Downloads immediately.
              </p>
              <a href={api.privacy.exportHref} download>
                <Button className="w-full">Download my data</Button>
              </a>
              <p className="text-tiny leading-relaxed text-fg-subtle">
                Your password hash and session tokens are deliberately left out. They are
                credentials, they are useless to you, and a file containing them would be
                one more place for them to leak from.
              </p>
            </div>
          </Card>

          <InfoNote>
            Want us to correct something, or prefer a person to do it?{' '}
            <Link to="/contact?kind=correction" className="text-fg underline underline-offset-2">
              Ask here
            </Link>
            . The full{' '}
            <Link to="/privacy" className="text-fg underline underline-offset-2">
              Privacy Notice
            </Link>{' '}
            lists what we keep and for how long.
          </InfoNote>
        </div>
      </div>
    </div>
  );
}

/**
 * Account closure.
 *
 * Two guards, and neither is decoration: the password again, because a stolen
 * session must not be enough to destroy an account, and typing DELETE, because a
 * misplaced click should not either. Both are enforced server-side; this form only
 * makes them visible.
 *
 * The list of what is RETAINED is shown before the button, not after. Telling
 * somebody afterwards that we kept their payment records is a surprise; telling them
 * first is a disclosure.
 */
function EraseCard({ email, onErased }: { email: string; onErased: () => void }) {
  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ deleted: Record<string, number>; retained: string[] } | null>(
    null,
  );

  async function erase() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.privacy.erase(password);
      setDone({ deleted: res.deleted, retained: res.retained });
      toast.success('Your account is closed');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('That password is not right.');
      } else {
        setError(err instanceof Error ? err.message : 'That did not work.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const rows = Object.entries(done.deleted).filter(([, n]) => n > 0);
    return (
      <Card className="border-good/35">
        <CardHeader title="Done" subtitle="Your account is closed and your data is gone." />
        <div className="space-y-4 p-5">
          <div>
            <p className="text-small font-medium text-fg">Deleted</p>
            <ul className="mt-2 space-y-1 text-tiny text-fg-muted">
              {rows.length === 0 ? (
                <li>Nothing was left to delete.</li>
              ) : (
                rows.map(([k, n]) => (
                  <li key={k} className="flex justify-between gap-4">
                    <span className="font-mono text-fg-subtle">{k}</span>
                    <span className="tabular-nums">{n}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div>
            <p className="text-small font-medium text-fg">Kept, and why</p>
            <ul className="mt-2 space-y-1.5 text-tiny leading-relaxed text-fg-muted">
              {done.retained.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
          <Button className="w-full" onClick={onErased}>
            Sign out
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="border-bad/30">
      <CardHeader
        title="Close my account and erase my data"
        subtitle="Irreversible. Read the second list before you start."
        right={<Badge tone="bad">Permanent</Badge>}
      />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-small font-medium text-fg">Destroyed</p>
            <ul className="mt-2 space-y-1 text-tiny leading-relaxed text-fg-muted">
              <li>Your uploaded videos and every dubbed output, on disk and in storage</li>
              <li>Transcripts, translations and the voice clips taken from your video</li>
              <li>Your sessions, so every signed-in device is logged out</li>
              <li>Emails we sent you, and the messages you sent us</li>
              <li>Your email address</li>
            </ul>
          </div>
          <div>
            <p className="text-small font-medium text-fg">Kept, de-linked from you</p>
            <ul className="mt-2 space-y-1 text-tiny leading-relaxed text-fg-muted">
              <li>
                Payment records — amount, date and the provider&rsquo;s reference — held for
                statutory financial record-keeping, with no name or email attached
              </li>
              <li>Minute-usage totals, so our financial records still add up</li>
            </ul>
            <p className="mt-2 text-tiny leading-relaxed text-fg-subtle">
              DPDP s.8(7) allows retention where another law requires it. We would rather
              say this now than claim everything is gone and be wrong.
            </p>
          </div>
        </div>

        {!armed ? (
          <Button variant="danger" onClick={() => setArmed(true)}>
            I want to close my account
          </Button>
        ) : (
          <div className="space-y-1 rounded-xl border border-bad/35 bg-bad/[0.06] p-4">
            <p className="mb-3 text-small text-fg-muted">
              Closing <span className="text-fg">{email}</span>. Confirm it is you.
            </p>
            <Field
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            <Field
              label="Type DELETE to confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="DELETE"
              hint="Capital letters, exactly."
            />
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className={clsx('mt-3 flex flex-wrap gap-2.5')}>
              <Button
                variant="danger"
                loading={busy}
                disabled={confirm !== 'DELETE' || password.length === 0}
                onClick={() => void erase()}
              >
                Erase everything
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setArmed(false);
                  setPassword('');
                  setConfirm('');
                  setError(null);
                }}
              >
                Keep my account
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
