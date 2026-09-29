/**
 * Watch the dub without leaving the dashboard.
 *
 * Before this, the only way to hear what you had paid for was to download the file
 * and open it in something else. That is a strange thing to make somebody do at the
 * exact moment they most want to check the result, and it is also the moment they
 * decide whether the product worked.
 *
 * THE SRC IS A MINTED TOKEN, NOT A PATH. `/api/jobs/{id}/download` requires a
 * session cookie, and media elements are inconsistent about sending one — so
 * instead the player asks for a token and points at `/dl/{token}`, where the token
 * IS the authorisation. Three consequences worth knowing:
 *
 *   1. It is fetched on mount, not built as a string, so the component has a real
 *      loading state and a real error state.
 *   2. The token is minted `inline`, which means the bytes come back without a
 *      Content-Disposition header. With one, the browser downloads the file instead
 *      of playing it — the element just sits there showing nothing.
 *   3. It gets a longer TTL than a download token. A <video> does not fetch the
 *      file once; it fetches a byte range, and another every time the viewer seeks.
 *      On the download TTL the token would expire mid-watch and playback would stop
 *      with no explanation.
 *
 * Seeking works because Starlette's FileResponse answers Range requests with 206.
 * Without that the scrub bar is decorative.
 *
 * `preload="metadata"`, deliberately. `auto` would pull the whole dub the moment the
 * job page opens, for somebody who may only have come to read the transcript.
 * Metadata is enough for the duration and the scrub bar to be real.
 */
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { api, type DownloadFormat } from '../lib/api';
import { languageLabel } from '../lib/format';
import { Button } from '../ui/Button';
import { ErrorNote, Skeleton } from '../ui/primitives';

export function DubPlayer({
  jobId,
  targetLang,
  poster,
}: {
  jobId: string;
  targetLang: string;
  poster?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 'video' plays the picture; the audio formats play the track alone. */
  const [mode, setMode] = useState<Extract<DownloadFormat, 'video' | 'm4a'>>('video');
  const [failedToPlay, setFailedToPlay] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setError(null);
    setFailedToPlay(false);
    api.jobs
      .streamUrl(jobId, mode)
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch((err) => {
        if (alive) {
          setError(
            err instanceof Error ? err.message : 'Could not open the file for playback.',
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [jobId, mode]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-small font-medium">Your dub, in {languageLabel(targetLang)}</p>
          <p className="mt-0.5 text-tiny text-fg-subtle">
            Streaming — nothing has been downloaded to this device.
          </p>
        </div>
        {/*
          Video or just the audio. Not decoration: the audio track on its own is what
          gets attached to a YouTube video, so being able to hear exactly that,
          without the picture distracting from it, is how you check the dub itself.
        */}
        <div
          role="tablist"
          aria-label="What to play"
          className="flex gap-1 rounded-full border-2 border-ink-600 bg-ink-900 p-1"
        >
          {(
            [
              ['video', 'Video'],
              ['m4a', 'Audio only'],
            ] as const
          ).map(([m, text]) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              data-play-mode={m}
              onClick={() => setMode(m)}
              className={clsx(
                'rounded-full px-3.5 py-1.5 text-small',
                'transition-[background-color,color] duration-[160ms] ease-[var(--ease-out-strong)]',
                mode === m ? 'bg-ink-800 font-medium text-fg' : 'text-fg-muted hover:text-fg',
              )}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !src ? (
        <Skeleton className={mode === 'video' ? 'aspect-video w-full' : 'h-14 w-full'} />
      ) : failedToPlay ? (
        <div className="rounded-xl border border-warn/35 bg-warn/[0.06] px-4 py-3.5">
          <p className="text-small leading-relaxed text-warn">
            Your browser could not play this file here. It is a standard H.264 MP4, so
            downloading it and opening it locally will work.
          </p>
          <a href={api.jobs.downloadHref(jobId, mode)} download className="mt-3 inline-block">
            <Button size="sm" variant="secondary">
              Download it instead
            </Button>
          </a>
        </div>
      ) : mode === 'video' ? (
        <video
          key={src}
          src={src}
          poster={poster}
          controls
          preload="metadata"
          playsInline
          onError={() => setFailedToPlay(true)}
          data-dub-player="video"
          className="aspect-video w-full rounded-xl border border-ink-700 bg-black"
        />
      ) : (
        <audio
          key={src}
          src={src}
          controls
          preload="metadata"
          onError={() => setFailedToPlay(true)}
          data-dub-player="audio"
          className="w-full"
        />
      )}
    </div>
  );
}
