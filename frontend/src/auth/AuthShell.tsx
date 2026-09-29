import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../ui/Logo';

/**
 * Shared frame for login, signup and reset.
 *
 * The entrance is a single staggered rise on mount rather than a per-field
 * animation: these pages are seen occasionally, so one gentle entrance is the
 * right budget and animating each input would make signing in feel slow.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-5 py-12">
      <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_55%_45%_at_50%_0%,black,transparent)]" />
      <div className="glow-top pointer-events-none absolute left-1/2 top-[-18rem] h-[30rem] w-[42rem] -translate-x-1/2" />

      <div className="stagger relative w-full max-w-[400px]">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2.5">
          <Logo className="size-8" />
          <span className="text-body font-medium tracking-tight">Kresker</span>
        </Link>

        <div className="rounded-[var(--radius-card)] border border-ink-700 bg-ink-850/90 p-7 backdrop-blur-xl">
          <h1 className="text-h3">{title}</h1>
          {subtitle && <p className="mt-2 text-small leading-relaxed text-fg-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>

        {footer && <div className="mt-5 text-center text-small text-fg-muted">{footer}</div>}
      </div>
    </div>
  );
}
