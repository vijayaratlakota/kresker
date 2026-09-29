/**
 * Contact, and the data-rights request form.
 *
 * ONE PAGE, TWO MODES, and that is deliberate. A person who wants their data
 * deleted will use whichever form they find first, so both live here and both land
 * in the same admin inbox — a rights request that arrives as a general enquiry is
 * still a rights request and still runs against the statutory clock. Splitting them
 * across two pages with two backends would create the failure where one inbox is
 * answered and the other quietly is not.
 *
 * `/contact?kind=access` opens the rights mode directly, which is what the Privacy
 * Notice links to.
 *
 * No captcha, because there is none in this codebase to use (recorded as FINDING-7).
 * The backend rate limits both endpoints to five per hour per IP instead, and the
 * form surfaces that honestly when it trips rather than looking broken.
 */
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api, type RightsKind } from '../lib/api';
import { useSession } from '../lib/session';
import { Button } from '../ui/Button';
import { Card, ErrorNote, Field, InfoNote } from '../ui/primitives';
import { GrievanceBlock } from './Grievance';
import { LegalPage } from './LegalPage';
import { useNotice } from './useNotice';

// THE STATUTE REFERENCES CAME OFF THESE FIVE OPTIONS.
//
// They belong on a legal page, where citing the section lets a reader check the claim, and
// they are still there in the Privacy Notice and the Terms. Here they were sitting in the
// help text under a radio button, where the only job is to tell somebody which option to
// pick — and "DPDP s.12(3)" answers a question nobody choosing a form option is asking.
const RIGHTS: { kind: RightsKind; label: string; help: string }[] = [
  {
    kind: 'access',
    label: 'Send me a copy of my data',
    help: 'Everything we hold about you, as one file.',
  },
  {
    kind: 'correction',
    label: 'Correct something that is wrong',
    help: 'Tell us what is wrong and what it should say instead.',
  },
  {
    kind: 'erasure',
    label: 'Delete my data and close my account',
    help: 'Irreversible. Payment records are kept, with your name removed.',
  },
  {
    kind: 'withdraw',
    label: 'Withdraw a consent I gave',
    help: 'Say which one. Optional consents come off immediately.',
  },
  {
    kind: 'grievance',
    label: 'Raise a grievance',
    help: 'Something we did with your data that you are not happy about.',
  },
];

type Mode = 'contact' | 'rights';

export function Contact() {
  const [params, setParams] = useSearchParams();
  const { notice } = useNotice();
  const me = useSession((s) => s.me);

  const urlKind = params.get('kind');
  const initialMode: Mode = RIGHTS.some((r) => r.kind === urlKind) ? 'rights' : 'contact';

  const [mode, setMode] = useState<Mode>(initialMode);
  const [kind, setKind] = useState<RightsKind>(
    (RIGHTS.find((r) => r.kind === urlKind)?.kind ?? 'access') as RightsKind,
  );

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: number; due: string | null } | null>(null);

  // Signed-in visitors should not have to type an address we already know. Still
  // editable: somebody may be asking about a different account.
  useEffect(() => {
    if (me?.email && !email) setEmail(me.email);
  }, [me, email]);

  const chosen = useMemo(() => RIGHTS.find((r) => r.kind === kind)!, [kind]);
  const bodyTooShort = mode === 'contact' && body.trim().length > 0 && body.trim().length < 10;

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    // Keep the URL honest, so the page can be linked and reloaded in this state.
    const p = new URLSearchParams(params);
    if (next === 'rights') p.set('kind', kind);
    else p.delete('kind');
    setParams(p, { replace: true });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'contact' && body.trim().length < 10) {
      setError('Tell us a little more — at least ten characters.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'contact') {
        const res = await api.privacy.contact({
          email: email.trim(),
          body: body.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(subject.trim() ? { subject: subject.trim() } : {}),
        });
        setSent({ id: res.id, due: null });
      } else {
        const res = await api.privacy.request(kind, email.trim(), body.trim());
        setSent({ id: res.id, due: res.due_at });
      }
      setBody('');
      setSubject('');
    } catch (err) {
      if (err instanceof ApiError && err.isRateLimited) {
        setError(
          err.retryAfterSeconds
            ? `That is as many messages as we accept from one address per hour. Try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s), or email the Grievance Officer directly.`
            : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : 'That did not send.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <LegalPage
      title={mode === 'rights' ? 'Your data rights' : 'Contact us'}
      lede={
        mode === 'rights'
          ? 'Ask us to show you, correct, or delete what we hold. Free, no reason needed, and it goes straight to the person who handles it.'
          : 'A real inbox, read by a person. Anything at all — a problem with a dub, a question about billing, or something about your data.'
      }
    >
      {/*
        THE ADDRESS, IN PLAIN SIGHT AND BEFORE THE FORM.

        Some people will not use a form — they want to see an address they can write to
        from their own mail client, keep a copy of, and reply into a thread. A contact
        page that only offers a form reads as though it is trying not to be contacted.

        Read from the API rather than hardcoded, so it stays in step with
        VS_GRIEVANCE_EMAIL. Hardcoding it here would mean two places to change and one of
        them eventually going stale, which on a legally-published contact is worse than
        useless. `GrievanceBlock` further down still shows the named officer for DPDP
        purposes; this is the everyday route.
      */}
      {/*
        Only a REAL address. When nobody is configured the API sends the placeholder
        string 'NOT CONFIGURED' in `email` - which is truthy, so testing `email` alone
        rendered "Write to NOT CONFIGURED" with a mailto: link to nowhere. An address
        has an @; the placeholder does not. (Not `configured`: that also needs a name,
        and a real email with no officer named yet is still worth offering.)
      */}
      {notice?.grievance?.email?.includes('@') && (
        <p className="mb-8 text-small leading-relaxed text-fg-muted">
          Prefer email? Write to{' '}
          <a
            href={`mailto:${notice.grievance.email}`}
            className="text-fg underline underline-offset-2"
          >
            {notice.grievance.email}
          </a>{' '}
          and it reaches the same place as this form.
        </p>
      )}

      {/* mode switch */}
      <div
        role="tablist"
        aria-label="What kind of message"
        className="mb-8 inline-flex gap-1 rounded-full border-2 border-ink-600 bg-ink-900 p-1"
      >
        {(['contact', 'rights'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            data-mode={m}
            onClick={() => switchMode(m)}
            className={clsx(
              'rounded-full px-4 py-2 text-small transition-[background-color,color] duration-[160ms] ease-[var(--ease-out-strong)]',
              mode === m ? 'bg-ink-800 font-medium text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {m === 'contact' ? 'General message' : 'Data rights request'}
          </button>
        ))}
      </div>

      {sent ? (
        <Card className="px-5 py-6">
          <p className="text-h4 text-fg">Got it.</p>
          <p className="mt-2 text-body leading-relaxed text-fg-muted">
            Reference <span className="font-mono text-fg">#{sent.id}</span>. A confirmation
            is on its way to {email || 'your email address'}, and it is now in the inbox a
            person actually reads.
          </p>
          {sent.due && (
            <p className="mt-3 text-small leading-relaxed text-fg-muted">
              This is a data-rights request, so it has a deadline: we will answer by{' '}
              <span className="text-fg">{sent.due.replace('T', ' ').replace('Z', ' UTC')}</span>
              . If you are not signed in we will verify who you are before acting on it —
              otherwise anyone who knows your email address could ask us to delete your
              account.
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-2.5">
            <Button variant="secondary" size="sm" onClick={() => setSent(null)}>
              Send another
            </Button>
            <Link to="/">
              <Button variant="ghost" size="sm">
                Back to the site
              </Button>
            </Link>
          </div>
        </Card>
      ) : (
        <form onSubmit={submit} noValidate className="max-w-xl">
          {mode === 'rights' && (
            <div className="mb-5">
              <label
                htmlFor="rights-kind"
                className="mb-1.5 block text-small font-medium text-fg-muted"
              >
                What would you like us to do
              </label>
              <select
                id="rights-kind"
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as RightsKind;
                  setKind(next);
                  const p = new URLSearchParams(params);
                  p.set('kind', next);
                  setParams(p, { replace: true });
                }}
                className="h-11 w-full rounded-xl border border-ink-700 bg-ink-900 px-3.5 text-body text-fg transition-colors duration-[160ms] hover:border-ink-750 focus:border-fg-subtle focus:outline-none"
              >
                {RIGHTS.map((r) => (
                  <option key={r.kind} value={r.kind}>
                    {r.label}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-tiny leading-relaxed text-fg-subtle">{chosen.help}</p>
            </div>
          )}

          {mode === 'contact' && (
            <Field
              label="Your name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional"
            />
          )}

          <Field
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            hint={
              mode === 'rights'
                ? 'The address on the account you are asking about.'
                : 'So we can reply.'
            }
            placeholder="you@company.com"
          />

          {mode === 'contact' && (
            <Field
              label="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Optional"
            />
          )}

          <div className="w-full">
            <label htmlFor="msg" className="mb-1.5 block text-small font-medium text-fg-muted">
              {mode === 'rights' ? 'Anything we should know' : 'Message'}
            </label>
            <textarea
              id="msg"
              rows={6}
              required={mode === 'contact'}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-invalid={bodyTooShort || undefined}
              placeholder={
                mode === 'rights'
                  ? kind === 'correction'
                    ? 'What is wrong, and what it should say.'
                    : kind === 'withdraw'
                      ? 'Which consent you are withdrawing.'
                      : 'Optional.'
                  : 'What happened, and what you were expecting instead.'
              }
              className={clsx(
                'w-full resize-y rounded-xl border bg-ink-900 px-3.5 py-3 text-body text-fg',
                'placeholder:text-fg-subtle',
                'transition-[border-color] duration-[160ms] ease-[var(--ease-out-strong)]',
                'focus:outline-none focus:ring-0',
                bodyTooShort ? 'border-bad/60 focus:border-bad' : 'border-ink-700 hover:border-ink-750 focus:border-fg-subtle',
              )}
            />
            <div className="mt-1.5 min-h-[18px]">
              {bodyTooShort && (
                <p role="alert" className="text-tiny text-bad">
                  A little more than that, please.
                </p>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-4">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}

          <Button type="submit" size="lg" loading={busy} className="w-full">
            {busy ? 'Sending…' : mode === 'rights' ? 'File the request' : 'Send message'}
          </Button>

          <p className="mt-4 text-tiny leading-relaxed text-fg-subtle">
            We store your email, your message, and the IP address it came from, so we can
            answer you and so a rights request has a record. Nothing else, and nowhere else.
            See the{' '}
            <Link to="/privacy" className="text-fg-muted underline underline-offset-2">
              Privacy Notice
            </Link>
            .
          </p>
        </form>
      )}

      <div className="mt-12 grid gap-4 sm:grid-cols-2">
        <GrievanceBlock />
        <div>
          <InfoNote>
            {me ? (
              <>
                You are signed in, so you do not have to wait for us. Your{' '}
                <Link to="/app/privacy" className="text-fg underline underline-offset-2">
                  privacy page
                </Link>{' '}
                exports everything we hold, and closes the account, immediately.
              </>
            ) : (
              <>
                Signing in makes access and erasure immediate — the session proves who you
                are, so there is nothing for us to verify.{' '}
                {notice && <>Otherwise we answer within {notice.rights_response_days} days.</>}
              </>
            )}
          </InfoNote>
        </div>
      </div>
    </LegalPage>
  );
}
