import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, type SiteStatus } from './lib/api';
import { ErrorBoundary } from './app/ErrorBoundary';
import { Maintenance } from './marketing/Maintenance';
import { useSession } from './lib/session';
import { useBuild } from './lib/useBuild';
import { NewVersionBar } from './app/NewVersionBar';
import { Landing } from './marketing/Landing';
import { RequireAdmin, RequireAuth } from './app/Guard';
import { ConsentBanner } from './legal/ConsentBanner';
import { Spinner } from './ui/Button';
import { Seo } from './app/Seo';

/*
  ── WHAT IS EAGER AND WHAT IS LAZY ───────────────────────────────────────────

  The build was ONE 664 KB chunk, because every route above used to be a static
  import. That meant a first-time visitor reading the homepage downloaded, parsed and
  evaluated the admin panel, the billing tables, five legal documents and the whole
  dashboard before the hero could paint — on a phone, over mobile data, to read one
  page they might bounce from.

  EAGER, and each for a reason:

    Landing         the page most visitors see first. Lazy-loading the thing you came
                    for is a spinner where the content should be.
    Maintenance     rendered INSTEAD of the router when the site is off. It cannot be
                    a chunk fetched on demand, because "the site is down" is exactly
                    when fetching a chunk may fail.
    ErrorBoundary   catches render crashes. A fallback that has to be downloaded
                    before it can apologise is not a fallback.
    Guard           decides which route renders at all, so it is on every path.
    ConsentBanner   mounts on first paint for everyone.
    Spinner         the Suspense fallback below. Importing it lazily would need a
                    fallback for the fallback.

  EVERYTHING ELSE IS LAZY. `lazy()` + a dynamic `import()` is what tells Rollup where
  to cut, so each of these becomes its own file in dist/assets and is fetched the
  first time its route is visited.

  The chunks stay FLAT in dist/assets deliberately — `_verify_ui.py` globs
  `dist/assets/*.js` non-recursively for two dozen unrelated content checks, so
  nesting them under assets/js/ would make those checks silently stop seeing the code
  they are asserting about.
*/
const Pricing = lazy(() => import('./marketing/Pricing').then((m) => ({ default: m.Pricing })));
const Languages = lazy(() =>
  import('./marketing/Languages').then((m) => ({ default: m.Languages })),
);
const NotFound = lazy(() => import('./marketing/NotFound').then((m) => ({ default: m.NotFound })));

const Login = lazy(() => import('./auth/Login').then((m) => ({ default: m.Login })));
const Signup = lazy(() => import('./auth/Signup').then((m) => ({ default: m.Signup })));
const Reset = lazy(() => import('./auth/Reset').then((m) => ({ default: m.Reset })));
const VerifyEmail = lazy(() =>
  import('./auth/VerifyEmail').then((m) => ({ default: m.VerifyEmail })),
);

const AppShell = lazy(() => import('./app/AppShell').then((m) => ({ default: m.AppShell })));
const Dubbing = lazy(() => import('./app/Dubbing').then((m) => ({ default: m.Dubbing })));
const Library = lazy(() => import('./app/Library').then((m) => ({ default: m.Library })));
const JobDetail = lazy(() => import('./app/JobDetail').then((m) => ({ default: m.JobDetail })));
const Billing = lazy(() => import('./app/Billing').then((m) => ({ default: m.Billing })));
const PrivacyCenter = lazy(() =>
  import('./app/PrivacyCenter').then((m) => ({ default: m.PrivacyCenter })),
);

/*
  The admin panel was the clearest waste on the public path: it pulls @number-flow,
  Base UI's dialog and Base UI's tabs — none of it reachable without an admin session,
  all of it previously shipped to every anonymous visitor.
*/
const AdminOverview = lazy(() =>
  import('./app/admin/AdminOverview').then((m) => ({ default: m.AdminOverview })),
);
const AdminGpu = lazy(() => import('./app/admin/AdminGpu').then((m) => ({ default: m.AdminGpu })));
const AdminPeople = lazy(() =>
  import('./app/admin/AdminPeople').then((m) => ({ default: m.AdminPeople })),
);
const AdminSystem = lazy(() =>
  import('./app/admin/AdminSystem').then((m) => ({ default: m.AdminSystem })),
);
const AdminInbox = lazy(() =>
  import('./app/admin/AdminInbox').then((m) => ({ default: m.AdminInbox })),
);
const AdminBilling = lazy(() =>
  import('./app/admin/AdminBilling').then((m) => ({ default: m.AdminBilling })),
);

/*
  The toast container, lazily, and NOT because it is large — because of where it is
  needed. Nothing on the marketing site, the auth pages or the legal documents raises
  a toast; every `toast()` call in the app is inside a route that is itself lazy. So
  loading sonner for a visitor reading the homepage buys nothing.

  Rendered outside Suspense with no fallback of its own: there is nothing to show while
  a toast container loads, and it has no layout, so it can simply appear.
*/
const Toaster = lazy(() => import('sonner').then((m) => ({ default: m.Toaster })));

const About = lazy(() => import('./legal/About').then((m) => ({ default: m.About })));
const Contact = lazy(() => import('./legal/Contact').then((m) => ({ default: m.Contact })));
const Disclaimer = lazy(() =>
  import('./legal/Disclaimer').then((m) => ({ default: m.Disclaimer })),
);
const Privacy = lazy(() => import('./legal/Privacy').then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => import('./legal/Terms').then((m) => ({ default: m.Terms })));

/**
 * The glyph inside a notification's icon disc.
 *
 * One shape, four paths, `currentColor` throughout — which is the point: the disc's
 * tint and the glyph's colour are then set by a single CSS rule per tone, so a
 * success toast, a success badge and a finished progress bar cannot drift apart.
 *
 * `viewBox` is 20 and the rendered size is 11px, set in CSS. Drawing at a larger
 * coordinate space than it renders at keeps the 2.4 stroke from landing on a half
 * pixel at the sizes this appears in.
 */
function ToastGlyph({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * What fills the gap while a route chunk is in flight.
 *
 * Centred and minimal on purpose. A skeleton of the page about to arrive would be a
 * second layout to keep in sync with the real one, and on a fast connection this is
 * visible for a single frame — the elaborate version is work nobody sees.
 *
 * `min-h-dvh`, not `min-h-screen`: `vh` on mobile means the viewport WITHOUT the
 * browser chrome subtracted, so a full-height box is taller than the visible area and
 * the page starts life scrollable for no reason.
 */
function RouteFallback() {
  return (
    <div className="grid min-h-dvh place-items-center bg-ink-950" aria-busy="true">
      <Spinner className="size-6 text-fg-subtle" />
    </div>
  );
}

/**
 * Anchor links like /#how only work if the browser is told to scroll after the
 * route renders. Without this, clicking "How it works" from /pricing lands at the
 * top of the landing page and looks broken.
 */
function ScrollBehaviour() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.querySelector(hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/**
 * Runs the entrance animation on whatever the route just rendered.
 *
 * `key={pathname}` is the whole mechanism: changing a key remounts the element, and a
 * CSS animation restarts on mount. No animation library, no state, no timers, and
 * nothing to clean up — which is why this is a wrapper rather than something wired
 * into each page.
 *
 * KEYED ON `pathname` ONLY, not on the search string. `/app/library?filter=done` and
 * `/app/library` are the same page with a different filter; replaying the entrance
 * when somebody clicks a filter chip would make the whole list flash on every tap.
 *
 * The class itself is 8px and 260ms — see `.page-in` in styles.css for why it is
 * deliberately smaller and faster than the scroll reveals.
 */
function PageTransition({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div key={pathname} className="page-in">
      {children}
    </div>
  );
}

export default function App() {
  const refresh = useSession((s) => s.refresh);
  const me = useSession((s) => s.me);
  const status = useSession((s) => s.status);
  const [site, setSite] = useState<SiteStatus | null>(null);

  // One session probe on boot. Everything downstream waits on `status`, so no
  // guard can flash the login page at somebody who is already signed in.
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  /**
   * And one site probe, for maintenance mode.
   *
   * `/api/site` is reachable while the site is off, which is the whole point — it is
   * how the app distinguishes "we turned it off" from "the API is down", two states
   * that look identical from the browser and need completely different pages.
   *
   * A failure here is NOT treated as maintenance. If the probe cannot complete we
   * render the app: a network blip must not put a maintenance page in front of
   * somebody when the site is fine.
   */
  useEffect(() => {
    let alive = true;
    const probe = () =>
      api
        .site()
        .then((s) => {
          if (!alive) return;
          setSite(s);
          // THE SAME PROBE ANSWERS A SECOND QUESTION: is this tab still running the code
          // the server is serving? Folded in here rather than given its own timer,
          // because it is one field on a response we were already fetching.
          useBuild.getState().observe(s.build);
        })
        .catch(() => undefined);
    void probe();
    // Slow poll, so the page clears itself when the admin switches it back on rather
    // than needing everybody to reload.
    const t = window.setInterval(probe, 60_000);

    // AND ON RETURNING TO THE TAB, which is when this matters most. The case that caused
    // the trouble is somebody who opened a page, left it for hours, and came back to
    // click Buy — by which time a minute-interval timer may not have fired since the
    // deploy, and a background tab is throttled by the browser anyway.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void probe();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // An admin passes through — the backend lets their session reach everything, so
  // showing them the maintenance page would be a lie about their own access. It is
  // also how they check their changes on the real pages.
  //
  // Maintenance renders OUTSIDE the router below, so it must not use react-router at
  // all (see Maintenance.tsx: a <Link> in it blanked the page for every visitor).
  if (site?.maintenance && me?.role !== 'admin') {
    // Not decided until we know who this is: the site probe can answer before the
    // session probe, and deciding then would show an admin the maintenance page.
    if (status === 'loading') return <RouteFallback />;
    return <Maintenance note={site.note} since={site.since} />;
  }

  return (
    <BrowserRouter>
      <ScrollBehaviour />
      {/*
        Keeps the title, description, canonical, Open Graph tags and JSON-LD in step
        with the route after a client-side navigation. The FIRST load of every public
        URL already has all of it baked into the HTML by scripts/prerender.mjs — this
        is only for the navigations that never hit the server. Renders nothing.
      */}
      <Seo />
      {/*
        OUTSIDE the error boundary and outside Suspense, on purpose. A tab running code
        the server has replaced is exactly the situation where a lazily-loaded chunk can
        404 and take the page down — so the offer to reload has to survive that rather
        than be inside the thing that broke.
      */}
      <NewVersionBar />
      {/*
        Inside the router so the fallback can link, and wrapping the routes rather
        than the whole tree so a crash in one page does not take the Toaster with it.
        Without a boundary, a render error unmounts everything and leaves a blank
        white page — which looks like the product does not exist.
      */}
      <ErrorBoundary>
      {/*
        ONE Suspense boundary around all the routes, not one per route.

        Per-route boundaries would let two chunks resolve at different times and paint
        in two steps. One boundary means the transition is a single swap: fallback,
        then the page. It also sits INSIDE ErrorBoundary, so a chunk that fails to
        download (a deploy mid-session invalidates the old hashed filenames) surfaces
        as the error page with a reload button rather than as a component that never
        arrives and a spinner that never stops.
      */}
      <Suspense fallback={<RouteFallback />}>
      <PageTransition>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/pricing" element={<Pricing />} />
        {/*
          The languages list. A real page rather than the `/#languages` anchor on the
          homepage, because an anchor cannot rank for "what languages does it dub into"
          — it has no title, no description and no URL of its own. The anchor stays; the
          nav and footer still point at it for people already on the homepage.
        */}
        <Route path="/languages" element={<Languages />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/reset" element={<Reset />} />
        {/*
          Where the confirmation email points. This route was missing while the emails
          were already being sent, so every link led to the 404 page — see the note in
          VerifyEmail.tsx. Public and unauthenticated by necessity: confirming is what
          you do BEFORE you can sign in.
        */}
        <Route path="/verify" element={<VerifyEmail />} />

        {/*
          The compliance surface. Public and unauthenticated on purpose: somebody
          locked out of their account still has DPDP s.11-13 rights, and a privacy
          notice behind a login is not published.
        */}
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/disclaimer" element={<Disclaimer />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />

        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Dubbing />} />
          <Route path="library" element={<Library />} />
          <Route path="jobs/:id" element={<JobDetail />} />
          <Route path="billing" element={<Billing />} />
          <Route path="privacy" element={<PrivacyCenter />} />

          <Route
            path="admin"
            element={
              <RequireAdmin>
                <AdminOverview />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/gpu"
            element={
              <RequireAdmin>
                <AdminGpu />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/people"
            element={
              <RequireAdmin>
                <AdminPeople />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/system"
            element={
              <RequireAdmin>
                <AdminSystem />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/inbox"
            element={
              <RequireAdmin>
                <AdminInbox />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/billing"
            element={
              <RequireAdmin>
                <AdminBilling />
              </RequireAdmin>
            }
          />
        </Route>

        <Route path="/dashboard" element={<Navigate to="/app" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </PageTransition>
      </Suspense>
      </ErrorBoundary>

      {/*
        Inside the router because it links to /privacy and hides itself on the legal
        pages. It renders nothing unless there is something to ask, and it never
        blocks the page — see the note in ConsentBanner about why there is no overlay.
      */}
      <ConsentBanner />

      {/*
        Sonner rather than a hand-rolled toast: it handles stacking, swipe to
        dismiss, focus and reduced motion, and the timing is tuned to the
        component's personality rather than to the generic UI budget.
      */}
      <Suspense fallback={null}>
        <Toaster
          theme="dark"
          /*
            Bottom-right on a desktop, but on a phone `bottom-center` is the reachable
            half of the screen and a right-anchored toast collides with the thumb that
            is holding the device. Sonner takes one position, so the narrow case wins:
            centre reads correctly at both widths, where right does not.
          */
          position="bottom-center"
          closeButton
          /* Clear of the iPhone home indicator and of the cookie banner. */
          offset="calc(1rem + env(safe-area-inset-bottom))"
          /*
            THE STYLING LIVES IN CSS, NOT HERE, and the `style` object that used to
            be on `toastOptions` had to go for that to be possible: a style
            attribute beats every stylesheet rule regardless of specificity, so it
            would have silently won against all of it.

            `vs-toaster` also fixes a real bug rather than only restyling. Sonner
            declares its own `font-family` on this element, which beats inheritance
            from `body` — so every notification the product has ever shown was in
            the operating system's font while the page around it was not. See the
            block in styles.css for that and for why the class selectors there look
            over-qualified.
          */
          className="vs-toaster"
          toastOptions={{
            classNames: {
              toast: 'material-raised vs-toast',
              title: 'vs-toast-title',
              description: 'vs-toast-desc',
              icon: 'vs-toast-icon',
              closeButton: 'vs-toast-x',
              actionButton: 'vs-toast-action',
              cancelButton: 'vs-toast-cancel',
            },
          }}
          /*
            Our own glyphs, so the icon is a tinted disc in the palette's semantic
            colours rather than sonner's filled default. `currentColor` throughout,
            which is what lets one CSS rule per tone colour the glyph and its disc
            together. `loading` is left alone — sonner's spinner is better than
            anything worth substituting.
          */
          icons={{
            success: <ToastGlyph d="M4.5 10.6 8 14l7.5-8" />,
            error: <ToastGlyph d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
            warning: <ToastGlyph d="M10 5v6M10 14.6h.01" />,
            info: <ToastGlyph d="M10 15V9M10 5.4h.01" />,
          }}
        />
      </Suspense>
    </BrowserRouter>
  );
}
