import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, setCsrf } from '../lib/api';
import { useSession } from '../lib/session';
import { Button } from '../ui/Button';
import { ErrorNote, Field, InfoNote } from '../ui/primitives';
import { AuthShell } from './AuthShell';

/**
 * The page the confirmation link in the email lands on.
 *
 * THIS ROUTE DID NOT EXIST, and the link was already being sent. `notify.verify_email`
 * builds `{base_url}/verify?token=...`, App.tsx declared no `/verify`, so every
 * confirmation email anybody has ever received led to the 404 page. The address could
 * still be confirmed — by the test helper posting the token directly — but no customer
 * could ever have done it.
 *
 * Two halves, chosen the way Reset.tsx chooses:
 *
 *   with `?token=`  — spend it, then send them to sign in.
 *   without         — ask for the address and send a fresh link, for somebody whose
 *                     link expired. That form is the ONLY way back for an account
 *                     that cannot sign in, which is now every unconfirmed account.
 */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  return token ? <Spend token={token} /> : <AskForLink />;
}

function Spend({ token }: { token: string }) {
  const navigate = useNavigate();
  const refresh = useSession((s) => s.refresh);
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState<string | null>(null);

  // A ref, not a state flag: in development React mounts effects twice, and the token
  // is single-use — the second call would spend a token that is already gone and
  // report "invalid or expired" for a confirmation that had just succeeded.
  const spent = useRef(false);

  useEffect(() => {
    if (spent.current) return;
    spent.current = true;
    let alive = true;
    api.auth
      .verify(token)
      .then(async (res) => {
        if (!alive) return;

        // STRAIGHT INTO THE APP. The endpoint now returns a session, so there is nothing
        // left to ask for — sending somebody back to the login form to retype the
        // password they entered a minute ago proved nothing and lost people.
        //
        // `refresh()` rather than trusting the response: /api/auth/me is what carries the
        // entitlement, and the dashboard needs the plan and the minute balance the moment
        // it renders.
        if (res.csrf) {
          setCsrf(res.csrf);
          try {
            await refresh();
            if (!alive) return;
            navigate('/app', { replace: true });
            return;
          } catch {
            // The confirmation itself succeeded, so fall through to the confirmed screen
            // rather than reporting a failure. The button below still works.
            if (!alive) return;
          }
        }

        setState('done');
        setMessage(
          res.already
            ? 'That address was already confirmed. You can sign in.'
            : 'Your email address is confirmed. You can sign in now.',
        );
      })
      .catch((err) => {
        if (!alive) return;
        // A suspended account is confirmed but deliberately not signed in, and it needs
        // its own words — "invalid or expired" would send them to ask for another link
        // that will do exactly the same thing.
        if (err instanceof ApiError && err.isSuspended) {
          setState('failed');
          setMessage(err.message);
          return;
        }
        setState('failed');
        setMessage(
          err instanceof ApiError && err.status === 400
            ? 'That confirmation link is invalid or has expired. Ask for a new one below.'
            : err instanceof Error
              ? err.message
              : 'Something went wrong.',
        );
      });
    return () => {
      alive = false;
    };
  }, [token, navigate, refresh]);

  if (state === 'working') {
    return (
      <AuthShell title="Confirming your address" subtitle="One moment.">
        <InfoNote>Checking that link…</InfoNote>
      </AuthShell>
    );
  }

  if (state === 'failed') {
    return (
      <AuthShell
        title="That link did not work"
        subtitle="Links are good for 24 hours and can only be used once."
        footer={
          <>
            Remembered your password?{' '}
            <Link to="/login" className="text-fg underline-offset-2 hover:underline">
              Sign in
            </Link>
          </>
        }
      >
        <div className="mb-5">
          <ErrorNote>{message}</ErrorNote>
        </div>
        <RequestForm />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="You're confirmed" subtitle="That is the only step we ask for.">
      <div role="status">
        <InfoNote>{message}</InfoNote>
      </div>
      <Button
        className="mt-5 w-full"
        size="lg"
        onClick={() => navigate('/login', { replace: true })}
      >
        Go to sign in
      </Button>
    </AuthShell>
  );
}

function AskForLink() {
  return (
    <AuthShell
      title="Confirm your email"
      subtitle="Enter your address and we'll send a fresh link."
      footer={
        <>
          Already confirmed?{' '}
          <Link to="/login" className="text-fg underline-offset-2 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <RequestForm />
    </AuthShell>
  );
}

/**
 * Shared by both halves, because "my link expired" arrives at either one.
 *
 * The backend answers identically whether or not the address exists, so this must not
 * undo that by only saying "sent" for real ones. It says the same thing every time,
 * which is also the only honest thing it can say.
 */
function RequestForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.auth.requestVerify(email.trim());
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

  if (sent) {
    return (
      <div role="status">
        <InfoNote>
          If that address needs confirming, a new link is on its way. It is good for 24
          hours.
        </InfoNote>
        <p className="mt-3 text-tiny leading-relaxed text-fg-subtle">
          Check the spam folder before asking again — a second link replaces the first,
          so only the newest one works.
        </p>
      </div>
    );
  }

  return (
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
        {busy ? 'Sending…' : 'Send me a new link'}
      </Button>
    </form>
  );
}
