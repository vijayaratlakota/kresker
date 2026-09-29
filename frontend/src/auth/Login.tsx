import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { Button } from '../ui/Button';
import { ErrorNote, Field, InfoNote } from '../ui/primitives';
import { AuthShell } from './AuthShell';
import { GoogleButton } from './GoogleButton';

/**
 * What went wrong on the way back from Google, in words.
 *
 * The callback cannot return a useful error body — whatever it returns is rendered in
 * the address bar — so it redirects here with a short code and this turns the code into
 * a sentence. Anything unrecognised falls back to something true but vague, because an
 * unknown code is our bug, not the reader's.
 */
const OAUTH_ERRORS: Record<string, string> = {
  cancelled: 'Google sign-in was cancelled. Nothing happened to your account.',
  expired: 'That Google sign-in took too long or was opened in another tab. Try again.',
  state_mismatch: 'That Google sign-in could not be verified. Please start again.',
  google_unverified:
    'Google has not verified that email address, so we cannot use it to sign in. Use a password instead.',
  account_closed: 'That account has been closed and cannot be reopened.',
  google_failed: 'Google sign-in did not complete. Try again, or use your password.',
};

export function Login() {
  const signIn = useSession((s) => s.signIn);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/app';
  const oauthError = params.get('oauth_error');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    oauthError ? (OAUTH_ERRORS[oauthError] ?? 'Google sign-in did not complete.') : null,
  );

  // The address is real and the password was right, but the address is not confirmed.
  // Held separately from `error` because it is not a failure to correct — it is a step
  // to complete, and it comes with an action rather than an apology.
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUnconfirmed(null);
    setResent(false);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      // The rate limiter is a real thing a real person will hit. Say how long,
      // because "too many attempts" with no number is just a locked door.
      if (err instanceof ApiError && err.isRateLimited) {
        setError(
          err.retryAfterSeconds
            ? `Too many attempts. Try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).`
            : err.message,
        );
      } else if (err instanceof ApiError && err.isSuspended) {
        // Ahead of the unconfirmed branch, matching the order the backend checks them.
        // An account that is both suspended and unconfirmed must not be offered a
        // "resend confirmation" button, because confirming would not let them back in
        // and the mail would look like the fix.
        setError(err.message);
      } else if (err instanceof ApiError && err.isEmailUnconfirmed) {
        // Branching on the CODE, not the status: a CSRF failure is also a 403, and not
        // on the message either, because that prose is meant to be rewritable.
        setUnconfirmed(email.trim());
      } else if (err instanceof ApiError && err.isUnauthenticated) {
        // Deliberately does not say which of the two was wrong.
        setError('That email and password do not match.');
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!unconfirmed) return;
    setResending(true);
    try {
      await api.auth.requestVerify(unconfirmed);
      setResent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that just now.');
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to pick up your dubs where you left them."
      footer={
        <>
          New here?{' '}
          <Link to="/signup" className="text-fg underline-offset-2 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
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
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />

        <div className="-mt-1 mb-4 text-right">
          <Link to="/reset" className="text-tiny text-fg-muted hover:text-fg">
            Forgot your password?
          </Link>
        </div>

        {error && (
          <div className="mb-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {/*
          Not an ErrorNote: the credentials were correct. This is the last step of
          signing up, arriving late, and it carries the action rather than telling
          somebody to go and find it. role="status" so it is announced — it appears
          after a button press and replaces what the reader expected to happen.
        */}
        {unconfirmed && (
          <div className="mb-4" role="status">
            <InfoNote>
              {resent
                ? 'A new confirmation link is on its way. It is good for 24 hours, and only the newest one works.'
                : 'Confirm your email address before signing in. We sent a link when you registered — check your inbox, including spam.'}
            </InfoNote>
            {!resent && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-3"
                loading={resending}
                onClick={resend}
              >
                Send the link again
              </Button>
            )}
          </div>
        )}

        <Button type="submit" className="w-full" size="lg" loading={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {/* Outside the <form> on purpose: it is a navigation, not a submission, and
          inside a form a stray Enter could trigger the wrong one. */}
      <GoogleButton next={next} label="Sign in with Google" />
    </AuthShell>
  );
}
