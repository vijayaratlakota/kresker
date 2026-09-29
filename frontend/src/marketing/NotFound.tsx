import { Link } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Logo } from '../ui/Logo';

export function NotFound() {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-5 text-center">
      <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_50%_40%_at_50%_40%,black,transparent)]" />
      <div className="stagger relative">
        <Link to="/" className="mb-8 inline-flex items-center gap-2.5">
          <Logo className="size-8" />
          <span className="text-body font-medium tracking-tight">Kresker</span>
        </Link>
        <p className="font-mono text-small text-fg">404</p>
        <h1 className="mt-3 text-h2">
          There is nothing here
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-body text-fg-muted">
          The link may be old, or the page may have moved.
        </p>
        <div className="mt-7 flex justify-center gap-3">
          <Link to="/">
            <Button>Back to the homepage</Button>
          </Link>
          <Link to="/app">
            <Button variant="secondary">Open the dashboard</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
