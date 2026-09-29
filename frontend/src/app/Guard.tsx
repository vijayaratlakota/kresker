/**
 * Route guards.
 *
 * `status === 'loading'` matters more than it looks: without waiting for the first
 * /api/auth/me, a signed-in customer who refreshes /app gets bounced to the login
 * page for a moment and then back. That flash is the kind of bug that makes an app
 * feel unreliable even when nothing is broken.
 *
 * These guards are convenience, not security. Every admin route on the backend
 * re-checks the role and answers 404 to a non-admin regardless of what the client
 * believes.
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { isAdmin, useSession } from '../lib/session';
import { Spinner } from '../ui/Button';

function Waiting() {
  return (
    <div className="grid min-h-dvh place-items-center text-fg-subtle">
      <Spinner className="size-5" />
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status);
  const location = useLocation();

  if (status === 'loading') return <Waiting />;
  if (status === 'signed-out') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status);
  const me = useSession((s) => s.me);

  if (status === 'loading') return <Waiting />;
  if (status === 'signed-out') return <Navigate to="/login?next=/app/admin" replace />;
  // Send a non-admin to their own dashboard rather than showing a wall. They are
  // not doing anything wrong by having the link.
  if (!isAdmin(me)) return <Navigate to="/app" replace />;
  return <>{children}</>;
}
