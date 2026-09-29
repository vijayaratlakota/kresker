/**
 * The 500 page for a crash that happens in the browser.
 *
 * A server-rendered 500 covers the backend falling over. It cannot cover a React
 * component throwing during render — at that point the request already succeeded, and
 * without a boundary React unmounts the entire tree and leaves a blank white page.
 * A blank page is the worst possible failure: it looks like the product does not
 * exist, and it gives the person nothing to report.
 *
 * Deliberately a class component. Error boundaries are the one thing in React that
 * hooks still cannot express — there is no `useErrorBoundary`, and
 * `componentDidCatch` is the only way to catch a descendant's render error.
 *
 * WHAT IT DOES NOT DO: it does not show the stack trace. That is for the console and
 * the log, not for a customer — it names our files, occasionally quotes our data, and
 * tells the reader nothing they can act on. A short reference they can quote does.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  crashed: boolean;
  reference: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { crashed: false, reference: '' };

  static getDerivedStateFromError(): Partial<State> {
    // A short, human-quotable reference rather than a uuid. It is generated here
    // because a client-side crash never reaches the server, so nothing else can.
    return {
      crashed: true,
      reference: Math.random().toString(36).slice(2, 10),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is where a developer looks, and it is the only sink available for a
    // crash that by definition did not reach the backend.
    // eslint-disable-next-line no-console
    console.error('[kresker] render crash', this.state.reference, error, info);
  }

  render() {
    if (!this.state.crashed) return this.props.children;

    return (
      <div
        data-crashed="true"
        className="grid min-h-dvh place-items-center bg-ink-950 px-5 text-center"
      >
        <div className="max-w-md">
          <p className="text-tiny uppercase tracking-[0.16em] text-bad">Error</p>
          <h1 className="mt-3 text-h2 text-fg">Something broke on our side</h1>
          <p className="mt-4 text-body leading-relaxed text-fg-muted">
            This is our error, not yours. Any dub already running is unaffected — the
            work happens on our servers, so it will still be there when you come back.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            {/*
              A full page load, not a router navigation. The React tree is in an
              unknown state after a render crash, so re-rendering into it is how you
              get a second crash — `location.assign` throws the whole thing away.
            */}
            <button
              type="button"
              onClick={() => window.location.assign('/')}
              className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-body font-medium text-accent-ink transition-colors duration-[160ms] hover:bg-white/88"
            >
              Reload the app
            </button>
            <a
              href="/contact"
              className="inline-flex h-10 items-center rounded-full border-2 border-ink-600 px-5 text-body font-medium text-fg transition-colors duration-[160ms] hover:border-ink-500 hover:bg-white/[0.04]"
            >
              Report it
            </a>
          </div>
          <p className="mt-6 text-tiny text-fg-subtle">
            Reference{' '}
            <code className="font-mono text-fg-muted">{this.state.reference}</code> —
            quote this and we can find it.
          </p>
        </div>
      </div>
    );
  }
}
