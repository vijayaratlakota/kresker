/**
 * How long a chosen video is, according to the browser, before any of it is uploaded.
 *
 * WHY THIS EXISTS. A free account may dub sixty seconds. Somebody arrives with sixty-six.
 * The old flow uploaded all of it first — over a phone connection, which on the reported
 * case took long enough that Cloudflare abandoned the request at its hundred-second
 * ceiling and answered with an error page. So the customer waited, got no dub, and got no
 * usable reason either. Even when the upload did land, the refusal came only after the
 * wait was already spent.
 *
 * Reading the duration locally costs milliseconds and moves the refusal to before the
 * transfer, where it is useful: shorten the video and come back, having lost nothing.
 */
export function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    let settled = false;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      // Tells the media element to let go of the blob before it is revoked. Without it
      // Safari can keep a decoder alive on a URL that no longer exists.
      el.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    // A metadata read that has not landed in ten seconds is not going to. Without this,
    // a file the browser cannot parse leaves the picker stuck with no way forward.
    const timer = setTimeout(() => finish(null), 10_000);

    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => {
      const d = el.duration;
      finish(Number.isFinite(d) && d > 0 ? d : null);
    };
    el.onerror = () => finish(null);
    el.src = url;
  });
}

/**
 * `null` when the browser could not tell, which must NOT block the upload.
 *
 * A <video> element opens far less than ffprobe does, so a container it refuses is often
 * a perfectly good file. Guessing here would turn "we cannot read this" into "we reject
 * this". The server probes properly and refuses with `video_too_long` if it has to, so a
 * null answer costs one wasted upload in an uncommon case rather than blocking a valid
 * one in a common case.
 */
export function isUnknownDuration(seconds: number | null): boolean {
  return seconds == null;
}
