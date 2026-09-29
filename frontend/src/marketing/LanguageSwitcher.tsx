/**
 * The signature demo: one reel, six languages, and picking one keeps playing from
 * exactly where you were.
 *
 * ── WHY THIS IS ONE MEDIA ELEMENT ──────────────────────────────────────────────
 *
 * It used to be a muted <video> plus a separate <audio> element carrying the dub,
 * which is the obvious design: the picture never reloads, so a language change is
 * invisible. It also did not work on a phone, and the reason is worth recording
 * because it is not discoverable from a desktop browser.
 *
 * On iOS the second media element is suspended. It reports itself accurately —
 * `paused` false, `readyState` 4, `seeking` false — while its media clock never
 * advances and no sound is produced. Nothing in the page can detect that as an error
 * and nothing can talk it round: `play()` resolves, no exception is thrown, and the
 * element simply never emits. Three separate rounds of fixes went into the two-element
 * design (gesture ordering, seek ordering, replacing seek-based drift correction with
 * playback-rate nudging) and every one of them was correct on its own terms and
 * changed nothing on a phone, because the element that needed to make sound was never
 * going to be allowed to.
 *
 * So the audio now lives inside the element the visitor's tap actually unlocks. Each
 * language is its own MP4 carrying the identical picture and that language's dub, and
 * switching language switches the element's `src`.
 *
 * ── WHAT THAT COSTS, AND HOW IT IS PAID ────────────────────────────────────────
 *
 * Changing `src` reloads the element, so the frame would blank for as long as the new
 * file takes to become seekable. That blank is the only thing the old design bought,
 * and it is bought back here by painting the last displayed frame onto a <canvas> and
 * holding it over the video until the new track is running. The picture appears to
 * hold still for a moment instead of dropping to black, which reads as a switch rather
 * than as a reload.
 *
 * Two things fall out of the single element for free, and both were previously code:
 * there is no audio/video drift, because there is one clock rather than two, so the
 * whole rate-nudging corrector is gone; and there is no crossfade, because the volume
 * ramp it used is a no-op on iOS anyway — `volume` is read-only there.
 *
 * ── DELIVERY ───────────────────────────────────────────────────────────────────
 *
 * Six files at ~9 MB is far too much to sit in the JS bundle, so these belong on
 * object storage with a CDN in front rather than in `public/`. `MEDIA_BASE` is the
 * single place that changes: set `VITE_DEMO_BASE` and every URL below moves with it.
 * Nothing is downloaded until somebody presses play — `preload="metadata"` fetches
 * only the moov atom, and the files are written `+faststart` so that atom is at the
 * front.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LANGUAGES, languageDot } from '../lib/format';

/**
 * Where the demo media lives.
 *
 * Defaults to the app's own origin so a checkout with the files in `public/demo`
 * works with no configuration. Point `VITE_DEMO_BASE` at an R2 public bucket or a
 * CDN hostname to serve them from there instead — no trailing slash.
 */
const MEDIA_BASE = (import.meta.env.VITE_DEMO_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

/**
 * The real reel, built from the source the owner supplied.
 *
 * Hindi is FIRST and marked `original` because it is the video's own audio, not a
 * dub. That ordering is the argument: you hear the real speaker, then hear the same
 * speaker in five languages they never recorded.
 *
 * Every file is the same 86.60s picture with a different audio track, encoded once
 * and remuxed six times, so the video bitstream is byte-identical across all of them.
 */
const DEMO = {
  // WebP: this is the only asset every visitor downloads whether or not they press
  // play, so it is the one place bytes cost page speed. 47 KB, against 81 KB for
  // the same frame as JPEG.
  //
  // ── AND IT IS DELIBERATELY *NOT* ON `MEDIA_BASE` ──────────────────────────
  //
  // This frame is the homepage's LCP element — measured, 76,907 px², the largest
  // thing Google times. While it came from the R2 bucket the browser had to do a
  // fresh DNS lookup and a TLS handshake to a second origin before it could request
  // the one image that decides the score, and it discovered the need to do so only
  // after parsing this far into the JavaScript.
  //
  // 47 KB is small enough to keep in `public/`, so it now ships with the bundle and
  // is served from the same connection as the document. `scripts/prerender.mjs` also
  // emits a `<link rel="preload" as="image" fetchpriority="high">` for it, which
  // moves the request to the very start of the load instead of the middle.
  //
  // The SIX VIDEOS stay on `MEDIA_BASE`. They are ~9 MB each and 54 MB together,
  // which is not something to put in a build — and unlike the poster, nothing fetches
  // them until the reel is in view.
  //
  // `_ship_dist.ps1` used to delete `dist/demo` wholesale to keep the videos off the
  // server. It now deletes only the media files and keeps this one, so the poster
  // reaches production. If it ever goes missing the reel shows a black rectangle
  // rather than failing, which is exactly the sort of silent regression that check in
  // the ship script exists to prevent.
  poster: '/demo/poster.webp',
  tracks: [
    { code: 'hi', src: `${MEDIA_BASE}/demo/reel-hi.mp4`, original: true },
    { code: 'en', src: `${MEDIA_BASE}/demo/reel-en.mp4` },
    { code: 'te', src: `${MEDIA_BASE}/demo/reel-te.mp4` },
    { code: 'ta', src: `${MEDIA_BASE}/demo/reel-ta.mp4` },
    { code: 'kn', src: `${MEDIA_BASE}/demo/reel-kn.mp4` },
    { code: 'es', src: `${MEDIA_BASE}/demo/reel-es.mp4` },
  ] as { code: string; src: string; original?: boolean }[],
};

/** How long the held frame takes to hand over to the live picture. */
const HANDOVER_MS = 180;
/** Below this, the new file is already where we want it and no seek is issued. */
const SEEK_EPSILON_S = 0.05;

/**
 * Resolve on the first of `events`, or on `error`, or after `timeoutMs`.
 *
 * `error` and the timeout both resolve rather than reject, deliberately: this is a
 * decoration on a landing page and it must never be able to wedge itself waiting for
 * an event that is not coming. The caller checks the element's own state afterwards.
 */
function waitFor(el: HTMLMediaElement, events: string[], timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const e of events) el.removeEventListener(e, finish);
      el.removeEventListener('error', finish);
      window.clearTimeout(timer);
      resolve();
    };
    for (const e of events) el.addEventListener(e, finish);
    el.addEventListener('error', finish);
    const timer = window.setTimeout(finish, timeoutMs);
  });
}

/** Metadata is the first point at which assigning `currentTime` has any effect. */
const metadataReady = (v: HTMLVideoElement) =>
  v.readyState >= 1 ? Promise.resolve() : waitFor(v, ['loadedmetadata']);

/** A seek is asynchronous; acting before `seeked` is what stalls a decoder. */
const seekLanded = (v: HTMLVideoElement) =>
  v.seeking ? waitFor(v, ['seeked']) : Promise.resolve();

/**
 * Why playback could not start, in the browser's own words.
 *
 * The previous copy asserted a cause — "your browser blocked autoplay with sound" —
 * and that assertion cost two rounds of chasing a permissions problem that was
 * actually a suspended element. `NotAllowedError` is a policy refusal the visitor can
 * clear by tapping; anything else is ours to fix. Saying which one appeared is one
 * line and it stops the next person guessing.
 */
function mediaFault(v: HTMLVideoElement | null, err: unknown): string {
  const parts: string[] = [];
  if (err && typeof err === 'object' && 'name' in err) {
    const e = err as { name?: string; message?: string };
    parts.push([e.name, e.message].filter(Boolean).join(': '));
  }
  const code = v?.error?.code;
  if (code) parts.push(`media error ${code}`);
  return parts.join(' · ') || 'unknown';
}

export function LanguageSwitcher() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const holdRef = useRef<HTMLCanvasElement>(null);
  const [lang, setLang] = useState('hi');
  const [playing, setPlaying] = useState(false);
  const [switching, setSwitching] = useState(false);
  /** Is the held frame covering the video right now? */
  const [holding, setHolding] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  /**
   * JS OWNS `src`, AND THAT IS LOAD-BEARING.
   *
   * The element must not also carry a React `src` prop or a <source> child. Setting
   * `src` invokes the media load algorithm *unconditionally* — the spec does not check
   * whether the value actually changed — so a re-render writing the same URL back
   * aborts whatever `choose` has in flight and resets the element to paused and
   * unloaded. That bug presented as "clicking a language does nothing until you pause
   * and play again", and it is why the initial source is assigned once, here, and
   * nowhere else.
   */
  useEffect(() => {
    const v = videoRef.current;
    if (v && !v.getAttribute('src')) v.setAttribute('src', DEMO.tracks[0].src);
  }, []);

  /**
   * Warm a language's metadata on hover or focus.
   *
   * Deliberately NOT the whole file: at ~9 MB apiece, prefetching on hover would
   * spend 54 MB of somebody's data plan to save a moment on a button they may never
   * press. A detached element at `preload="metadata"` fetches the moov atom and stops,
   * which is what makes the seek in `choose` land promptly. The rest arrives on demand
   * and the browser cache keeps it for the second visit to that language.
   */
  const warmed = useRef(new Set<string>());
  const warm = useCallback((src: string) => {
    if (warmed.current.has(src)) return;
    warmed.current.add(src);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    probe.src = src;
  }, []);

  /**
   * Paint the frame on screen into the canvas and raise it over the video.
   *
   * This is what stops a language change looking like a page reload. It runs before
   * `src` is touched, so the image is the last thing the visitor actually saw.
   *
   * A cross-origin file (the CDN case) taints the canvas, which blocks reading pixels
   * back but not drawing or displaying them — and display is all this needs, so no
   * CORS headers are required on the bucket. Wrapped anyway: if a browser ever refuses
   * the draw, the switch falls back to showing the poster for a moment rather than
   * throwing in the middle of a click handler.
   */
  const holdFrame = useCallback(() => {
    const v = videoRef.current;
    const c = holdRef.current;
    if (!v || !c || !v.videoWidth || !v.videoHeight) return false;
    try {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      setHolding(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  /**
   * Which switch is current. A second tap while the first is still loading has to
   * win, otherwise the slower load lands last and you hear the language you did not
   * pick.
   */
  const gen = useRef(0);

  const choose = useCallback(
    async (code: string) => {
      if (code === lang) return;
      const v = videoRef.current;
      const next = DEMO.tracks.find((t) => t.code === code);
      setLang(code);
      if (!v || !next) return;

      const mine = ++gen.current;
      const at = v.currentTime;
      const wasPlaying = !v.paused;

      // Hold the picture BEFORE the reload blanks it.
      holdFrame();
      setSwitching(true);

      v.pause();
      v.setAttribute('src', next.src);
      v.load();

      await metadataReady(v);
      if (mine !== gen.current) return;

      // Seek while paused and wait for it to land. Playing first and seeking after is
      // how you get a decoder that emits for a moment and then stalls.
      if (Math.abs(v.currentTime - at) > SEEK_EPSILON_S) {
        v.currentTime = at;
        await seekLanded(v);
        if (mine !== gen.current) return;
      }

      if (wasPlaying) {
        // Same element the visitor already started, so it keeps its permission and
        // this is allowed even though the tap is long finished.
        const ok = await v.play().then(
          () => true,
          (err) => {
            setFault(mediaFault(v, err));
            return false;
          },
        );
        if (mine !== gen.current) return;
        setFailed(!ok);
        if (ok) setFault(null);
        // Wait for real output before handing the picture back, so the held frame
        // covers the whole gap rather than revealing a stalled first frame.
        if (ok) {
          await waitFor(v, ['playing', 'timeupdate'], 4000);
          if (mine !== gen.current) return;
        }
      }

      setSwitching(false);
      setHolding(false);
    },
    [lang, holdFrame],
  );

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;

    if (!v.paused) {
      v.pause();
      setPlaying(false);
      return;
    }

    /*
      play() IS CALLED SYNCHRONOUSLY IN THE TAP, with nothing awaited before it.
      A media element is granted permission to produce sound only within the task
      that handled the gesture; an `await` earlier in this function would end that
      task and the element would be refused. There is also nothing to seek here —
      the element is wherever the visitor left it.
    */
    v.play().then(
      () => {
        setPlaying(true);
        setFailed(false);
        setFault(null);
      },
      (err) => {
        setFailed(true);
        setFault(mediaFault(v, err));
      },
    );
  }, []);

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-ink-700 bg-ink-900">
      <div className="relative aspect-video bg-black">
        {/*
          NO `src` PROP AND NO <source> CHILD — see the mount effect for why a second
          writer breaks the switch entirely.

          Not muted: the dub is this element's own audio track now, which is the entire
          point of the rewrite. `playsInline` keeps it in the page on iOS instead of
          taking over the screen in the native player.
        */}
        <video
          ref={videoRef}
          className="size-full object-cover"
          poster={DEMO.poster}
          playsInline
          loop
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />

        {/* The held frame. Raised instantly, handed back with a short fade. */}
        <canvas
          ref={holdRef}
          aria-hidden="true"
          className={clsx(
            'pointer-events-none absolute inset-0 size-full object-cover',
            holding ? 'opacity-100' : 'opacity-0',
          )}
          style={{ transition: holding ? 'none' : `opacity ${HANDOVER_MS}ms linear` }}
        />

        {/* Play affordance. Fades out while playing rather than disappearing. */}
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pause the demo' : 'Play the demo'}
          className={clsx(
            'group absolute inset-0 grid place-items-center',
            'transition-opacity duration-[250ms] ease-[var(--ease-out-strong)]',
            /*
              THE FADE-OUT IS GATED ON A FINE POINTER, and this was a real bug rather
              than a nicety.

              While playing, this used to be `opacity-0 hover:opacity-100`. On a phone
              there is no hover and no focus-visible, so the pause control became a
              100% transparent full-surface button: it still worked, but nothing on
              screen said it was there — and tapping a playing video is exactly what
              somebody does when they want to scrub. So the demo looked like it had no
              pause at all.

              With `pointer-fine:`, a mouse still gets the clean uncluttered frame it
              was designed for, and a finger keeps a visible control. `opacity-70`
              rather than full: it stays legible without sitting on top of the video
              the whole time.
            */
            playing
              ? clsx(
                  'opacity-70',
                  'pointer-fine:opacity-0 pointer-fine:hover:opacity-100',
                  'focus-visible:opacity-100',
                )
              : 'opacity-100',
          )}
        >
          <span
            className={clsx(
              'grid size-16 place-items-center rounded-full',
              'bg-black/45 backdrop-blur-sm ring-1 ring-white/20',
              'transition-transform duration-[160ms] ease-[var(--ease-out-strong)]',
              // :active is a real press on touch, so it needs no gate. The hover
              // grow does: Tailwind gates hover on (hover: hover), but a
              // touchscreen laptop reports that too, so the scale would stick
              // after a tap. `pointer-fine` adds the pointer check.
              'group-active:scale-[0.94] pointer-fine:group-hover:scale-105',
            )}
          >
            {playing ? (
              <svg viewBox="0 0 24 24" className="size-6 fill-white" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="size-6 fill-white" aria-hidden="true">
                <path d="M8 5.5v13l11-6.5-11-6.5Z" />
              </svg>
            )}
          </span>
        </button>

        <div
          aria-live="polite"
          className={clsx(
            'absolute left-4 top-4 rounded-full bg-black/60 px-3 py-1 text-tiny',
            'text-white backdrop-blur-sm ring-1 ring-white/15',
            'transition-opacity duration-[200ms] ease-[var(--ease-out-strong)]',
            switching ? 'opacity-100' : 'opacity-0',
          )}
        >
          Switching to {LANGUAGES.find((l) => l.code === lang)?.label}…
        </div>
      </div>

      <div className="border-t border-ink-700 p-4">
        <p className="mb-3 text-small text-fg-subtle">
          The original is Hindi. Every other language is the same speaker's voice,
          cloned. Pick one mid-sentence — it keeps playing from exactly where you are.
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Demo language">
          {DEMO.tracks.map((t) => {
            const active = t.code === lang;
            const meta = LANGUAGES.find((l) => l.code === t.code);
            return (
              <button
                key={t.code}
                type="button"
                onClick={() => void choose(t.code)}
                // Hover and focus both mean "about to click". Warming the metadata
                // here is what lets preload stay light without the switch feeling slow.
                onPointerEnter={() => warm(t.src)}
                onFocus={() => warm(t.src)}
                aria-pressed={active}
                className={clsx(
                  'flex items-center gap-1.5 rounded-full border-2 px-4 py-1.5',
                  'text-small font-medium',
                  'transition-[background-color,border-color,color,transform]',
                  'duration-[160ms] ease-[var(--ease-out-strong)] active:scale-[0.97]',
                  'motion-reduce:transition-none',
                  active
                    // The selected language is the one thing a visitor needs to
                    // find at a glance on this control, so it gets a white ring
                    // rather than a grey one.
                    ? 'border-white/60 bg-ink-750 text-fg'
                    : 'border-ink-600 bg-ink-850 text-fg-muted hover:border-ink-500 hover:text-fg',
                )}
              >
                <span
                  className={clsx('size-2 shrink-0 rounded-full', languageDot(t.code))}
                  aria-hidden="true"
                />
                {meta?.label ?? t.code}
                {t.original && (
                  <span className="text-tiny font-normal text-fg-subtle">original</span>
                )}
              </button>
            );
          })}
        </div>
        {failed && (
          <p className="mt-3 text-tiny text-warn">
            {fault?.startsWith('NotAllowedError')
              ? 'Your browser blocked sound until you interact with the page. Press play once and the language buttons will work.'
              : 'This clip could not start on this device.'}
            {fault && <span className="ml-1 text-fg-subtle">({fault})</span>}
          </p>
        )}
      </div>
    </div>
  );
}
