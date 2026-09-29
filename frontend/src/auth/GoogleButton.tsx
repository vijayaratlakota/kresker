import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Button } from '../ui/Button';

/**
 * "Continue with Google", on the sign-in and sign-up pages.
 *
 * A LINK, NOT A FETCH, and it has to be. Google sign-in is a browser round trip: the
 * browser visits Google, the person picks an account, and Google redirects back to
 * `/api/auth/google/callback` where the backend sets the session cookie. None of that
 * can happen inside XHR, so this assigns `window.location` rather than calling the API.
 *
 * The backend builds the Google URL. The client id, the scopes and the PKCE challenge
 * never appear here — this only says where to start and where to land afterwards.
 *
 * IT DRAWS NOTHING WHEN GOOGLE IS NOT CONFIGURED. `/api/auth/google/*` answers 404
 * without credentials, and a button that leads to a 404 is worse than no button, so it
 * waits for `/api/site` to say the feature is on. That also means the operator turns it
 * on by putting credentials on the server, with no rebuild.
 */
export function GoogleButton({
  next,
  label = 'Continue with Google',
}: {
  /** Where to land after signing in. Same-site paths only — the backend re-checks. */
  next?: string;
  label?: string;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [going, setGoing] = useState(false);

  // Its own probe rather than reading App.tsx's copy: `site` there is local state, and
  // threading it down through two auth pages to reach this button would be a worse
  // trade than one extra GET on the two pages that need it. The response is small and
  // these pages are visited once.
  useEffect(() => {
    let alive = true;
    api
      .site()
      .then((s) => alive && setEnabled(Boolean(s.google_auth)))
      // A failed probe means "no button". The page still works — there is a password
      // form right above it — and guessing yes would render a 404.
      .catch(() => alive && setEnabled(false));
    return () => {
      alive = false;
    };
  }, []);

  if (!enabled) return null;

  return (
    <>
      {/*
        A labelled divider, not a bare second button. Without it the two paths read as
        "which of these is the real one?"; with it they read as alternatives.
        aria-hidden because "or" between two buttons is visual punctuation — a screen
        reader gets the two button labels, which is the whole meaning.
      */}
      <div aria-hidden="true" className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-ink-700" />
        <span className="text-tiny uppercase tracking-[0.14em] text-fg-subtle">or</span>
        <span className="h-px flex-1 bg-ink-700" />
      </div>

      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        loading={going}
        onClick={() => {
          setGoing(true);
          window.location.assign(api.auth.googleStart(next));
        }}
      >
        <GoogleMark />
        {going ? 'Taking you to Google…' : label}
      </Button>
    </>
  );
}

/**
 * Google's four-colour mark.
 *
 * Inlined rather than fetched: an <img> to a remote logo is a third-party request on
 * the sign-in page, and one that fails leaves a broken-image icon inside the button.
 * aria-hidden because the button's own text already says Google — announcing it twice
 * is noise.
 */
function GoogleMark() {
  return (
    <svg className="size-4 shrink-0" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}
