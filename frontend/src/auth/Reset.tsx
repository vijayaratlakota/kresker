import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { ErrorNote, Field, InfoNote } from '../ui/primitives';
import { AuthShell } from './AuthShell';

/**
 * Both halves of the reset flow, chosen by whether a `?token=` is present.
 *
 * Worth knowing about the request half: the backend answers identically whether or
 * not the address exists, so nobody can use this to find out who has an account.
 * The UI must not undo that by saying "we sent it" only for real addresses — so it
 * says the same thing either way, which is also the honest thing to say.
 */
export function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token');
  return token ? <ChooseNew token={token} /> : <AskForLink />;
}

function AskForLink() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.auth.requestReset(email.trim());
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.isRateLimited) {
        setError(
          err.retryAfterSeconds
            ? `Too many requests. Try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).`
            : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We will email a link that works once and expires in 30 minutes."
      footer={
        <Link to="/login" className="text-fg underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div className="stagger">
          <InfoNote>
            If that address has an account, a reset link is on its way. The link works
            once and expires in 30 minutes.
          </InfoNote>
          <p className="mt-4 text-tiny leading-relaxed text-fg-subtle">
            We say the same thing whether or not the address exists — otherwise this page
            would be a way to find out who has an account here.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
          {error && (
            <div className="mb-4">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
          <Button type="submit" className="w-full" size="lg" loading={busy}>
            {busy ? 'Sending…' : 'Send the reset link'}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

function ChooseNew({ token }: { token: string }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const issue = useMemo(() => {
    if (!touched) return null;
    if (password.length < 8) return 'At least 8 characters.';
    if (again && again !== password) return 'These do not match.';
    return null;
  }, [password, again, touched]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (password.length < 8 || password !== again) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.auth.confirmReset(token, password);
      setDone(res.sessions_revoked);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('That reset link is invalid or has expired. Ask for a new one.');
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <AuthShell title="Password changed" subtitle="You can sign in with it now.">
        <div className="stagger">
          <InfoNote>
            {done > 0
              ? `Signed out of ${done} other session${done === 1 ? '' : 's'}. A reset that leaves old sessions alive is not a reset.`
              : 'No other sessions were open.'}
          </InfoNote>
          <Button className="mt-5 w-full" size="lg" onClick={() => navigate('/login')}>
            Go to sign in
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="This also signs you out everywhere else."
      footer={
        <Link to="/reset" className="text-fg underline-offset-2 hover:underline">
          Need a new link?
        </Link>
      }
    >
      <form onSubmit={submit} noValidate>
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched(true)}
          hint="At least 8 characters."
        />
        <Field
          label="New password again"
          type="password"
          autoComplete="new-password"
          required
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          onBlur={() => setTouched(true)}
          error={issue}
        />
        {error && (
          <div className="mb-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </Button>
      </form>
    </AuthShell>
  );
}
