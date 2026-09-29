import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { Button } from '../ui/Button';
import { ErrorNote, Field, InfoNote } from '../ui/primitives';
import { AuthShell } from './AuthShell';
import { GoogleButton } from './GoogleButton';

/**
 * Email, password, done.
 *
 * The backend enforces a minimum of 8 characters and validates the email with a
 * real validator. Checking here too is not duplication for its own sake — it turns
 * a round trip into instant feedback. The server remains the authority; the client
 * is a courtesy.
 *
 * WHERE THE CONSENT WENT, because this used to carry three checkboxes.
 *
 * It is still collected and still recorded — it is just no longer a wall of ticks in
 * front of somebody trying to sign up. Pressing "Create account" is the affirmative
 * action, the line underneath says what that action agrees to, and the server writes
 * a `consent_records` row for `service_terms` stamped with the notice version and
 * `method='terms_acceptance'` so the audit trail says honestly how it was collected
 * rather than claiming a checkbox that no longer exists.
 *
 * The detail those checkboxes carried has not been deleted; it moved to where
 * somebody reading it actually has time to read it — Privacy Notice §2 and §5 for
 * what happens to a video and who receives it, and the Disclaimer for the voice
 * rights. Both are linked from here.
 *
 * THE ONE THING THAT DID NOT MOVE. Optional consent is still an explicit opt-in and
 * is deliberately NOT bundled into this line. Product email starts off and can only
 * be switched on from the privacy page; analytics starts refused and can only be
 * turned on from the banner. Folding either into "by continuing you agree" is the
 * precise thing DPDP s.6(1) exists to prohibit, and unlike the necessary purposes
 * there is no service reason to.
 */
export function Signup() {
  const signUp = useSession((s) => s.signUp);
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The address a confirmation link was just sent to, once the account exists. */
  const [pending, setPending] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);

  const passwordIssue = useMemo(() => {
    if (!touched || !password) return null;
    if (password.length < 8) return 'At least 8 characters.';
    return null;
  }, [password, touched]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (password.length < 8) return;
    setError(null);
    setBusy(true);
    try {
      // `service_terms` only. Nothing optional is granted here, because nothing
      // optional was asked.
      const res = await signUp(email.trim(), password, { service_terms: true });
      // REGISTERING NO LONGER SIGNS YOU IN. The address has to be confirmed first, so
      // the normal path ends on the panel below rather than in the app. The exception
      // is the operator's first account on a fresh database, which is confirmed at
      // creation and does come back with a session.
      if (res.verification_required) {
        setPending(res.email);
      } else {
        navigate('/app', { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiError && err.isSameInbox) {
        // A 409 too, but NOT the same thing as a duplicate, and the generic branch
        // below used to swallow it. `john+1@gmail.com` and `j.o.hn@gmail.com` reach the
        // inbox that holds `john@gmail.com`, so telling somebody "that email already
        // has an account" about an address they have demonstrably never used here is
        // how a support ticket starts. The backend's own wording explains it.
        setError(err.message);
      } else if (err instanceof ApiError && err.status === 409) {
        setError('That email already has an account. Try signing in instead.');
      } else if (err instanceof ApiError && err.isRateLimited) {
        setError(
          err.retryAfterSeconds
            ? `Too many sign-ups from here. Try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).`
            : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!pending) return;
    setResending(true);
    try {
      await api.auth.requestVerify(pending);
      setResent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that just now.');
    } finally {
      setResending(false);
    }
  }

  /*
    THE ACCOUNT EXISTS AND THE NEXT STEP IS IN THEIR INBOX.
    
    This replaces the form rather than sitting under it, because the form is finished —
    leaving it on screen invites somebody to press "Sign up" again and collect a 409.
    
    Naming the address is safe here in a way it would not be on the sign-in or
    reset pages: registration just succeeded, so telling the reader which address it
    went to reveals nothing they did not type themselves, and it is the one thing that
    catches a typo before it turns into a support ticket.
  */
  if (pending) {
    return (
      <AuthShell
        title="Check your inbox"
        subtitle="One click and the account is ready."
        footer={
          <>
            Already confirmed?{' '}
            <Link to="/login" className="text-fg underline-offset-2 hover:underline">
              Sign in
            </Link>
          </>
        }
      >
        <div role="status">
          <InfoNote>
            We sent a confirmation link to <span className="text-fg">{pending}</span>.
            Open it and then sign in — the link is good for 24 hours.
          </InfoNote>
        </div>

        <p className="mt-4 text-tiny leading-relaxed text-fg-subtle">
          Nothing arrived? Check the spam folder first. Asking for another link replaces
          the first one, so only the newest will work.
        </p>

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="mt-5 w-full"
          loading={resending}
          disabled={resent}
          onClick={resend}
        >
          {resent ? 'Sent again' : 'Send the link again'}
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create an account"
      subtitle="One free minute of dubbing. No card, and nothing renews on its own."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="text-fg underline-offset-2 hover:underline">
            Sign in
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
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched(true)}
          error={passwordIssue}
          hint="At least 8 characters."
          placeholder="••••••••"
        />

        {error && (
          <div className="mb-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <Button type="submit" className="w-full" size="lg" loading={busy}>
          {busy ? 'Creating your account…' : 'Sign up'}
        </Button>
      </form>

      {/*
        ABOVE the legal paragraph, so that "By continuing you agree…" sits under both
        ways of continuing. Signing up with Google records the same `service_terms`
        consent the form does — see the Google callback — so the sentence has to cover
        it, and a notice that appears above one button and below the other would be
        making a claim about which one it applies to.
      */}
      <GoogleButton next="/app" label="Sign up with Google" />

      {/*
        Outside the <form>, below the button, in the same place every other product
        puts it. Links, not a summary: a paragraph of paraphrase here would be a
        third copy of the notice to keep in sync.
      */}
      <p
        data-signup-legal="true"
        className="mt-5 text-center text-tiny leading-relaxed text-fg-subtle"
      >
        By continuing you agree to our{' '}
        <Link to="/terms" className="text-fg-muted underline underline-offset-2 hover:text-fg">
          Terms of Service
        </Link>
        ,{' '}
        <Link to="/privacy" className="text-fg-muted underline underline-offset-2 hover:text-fg">
          Privacy Notice
        </Link>{' '}
        and{' '}
        <Link to="/disclaimer" className="text-fg-muted underline underline-offset-2 hover:text-fg">
          Disclaimer
        </Link>
        .
      </p>
    </AuthShell>
  );
}
