/**
 * The doorman: /dl/{token}.
 *
 * It never makes an access decision of its own — it only verifies one the API already
 * made. It checks the signature and the expiry, and cannot be talked into serving a
 * different object, because the object is inside the signed payload.
 *
 * There is deliberately NO session check: the token IS the authorisation, which is what
 * lets a download work from a plain link, an email, or a player that sends no cookies.
 */
import { existsSync, statSync } from 'node:fs';
import { DOWNLOAD_TOKEN_TTL_S } from '../config';
import * as db from '../db';
import { ApiRouter, FileResponse, HTTPException, RedirectResponse } from '../http';
import * as media from '../media';
import * as paths from '../paths';
import { pyStr } from '../py';
import * as storage from '../storage';
import * as tokens from '../tokens';
import { t } from '../validate';

export const router = new ApiRouter('', ['delivery']);

function resolveQuiet(stored: string | null): string | null {
  try {
    return paths.resolve(stored);
  } catch {
    return null;
  }
}

router.get('/dl/{token}', { name: 'deliver', path: { token: t.str() } }, async (_req, _res, { token }) => {
  let payload: tokens.TokenPayload;
  try {
    payload = tokens.verify(token);
  } catch (e) {
    // 403 rather than 404: the link died, and the caller should know that
    if (e instanceof tokens.TokenError) throw new HTTPException(403, `link not valid: ${e.message}`);
    throw e;
  }
  const jobId = pyStr(payload.j || '');
  const job = db.one('SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw new HTTPException(404, 'not found');

  // re-check the window at serve time: a token must not outlive the retention it was issued against
  if (job.output_deleted_at) throw new HTTPException(410, 'this video has been deleted');
  if (job.output_expires_at && job.output_expires_at <= db.now()) throw new HTTPException(410, 'the download window has passed');

  const variant = pyStr(payload.v || 'video');
  const inline = pyStr(payload.d || '') === 'inline';

  // a play is not a download: scrubbing makes dozens of range requests
  if (!inline) {
    db.execute('UPDATE jobs SET download_count=download_count+1, first_downloaded_at=COALESCE(first_downloaded_at, ?) WHERE id=?', [db.now(), jobId]);
    db.addEvent(jobId, null, null, variant === 'video' ? 'downloaded' : `downloaded (${variant})`);
  }

  // ── the audio-only renditions: cut on demand from the MP4 and cached beside it ──
  if (Object.prototype.hasOwnProperty.call(media.AUDIO_FORMATS, variant)) {
    const spec = media.AUDIO_FORMATS[variant];
    const videoPath = resolveQuiet(job.output_path);
    if (!videoPath || !existsSync(videoPath)) throw new HTTPException(410, 'the file is no longer available');
    const audioPath = media.renditionPath(videoPath, variant);
    let small = true;
    try {
      small = statSync(audioPath).size < 512;
    } catch {
      small = true;
    }
    if (small) {
      try {
        await media.extractAudio(videoPath, audioPath, job.target_lang, variant);
      } catch (e) {
        // 409, not 500: the video is fine, this rendition of it is not
        if (e instanceof media.MediaError) throw new HTTPException(409, e.message);
        throw e;
      }
    }
    // no filename -> no Content-Disposition, so an <audio> element plays it
    return new FileResponse(audioPath, { mediaType: spec.mime, filename: inline ? null : media.downloadFilename(job.target_lang, jobId, variant) });
  }

  const filename = media.downloadFilename(job.target_lang, jobId, 'video');

  // Prefer storage: the bytes go straight from the bucket to the customer.
  const r2Key = 'output_r2_key' in job ? job.output_r2_key : null;
  if (r2Key && storage.enabled()) {
    const url = await storage.presign(r2Key, DOWNLOAD_TOKEN_TTL_S);
    if (url) return new RedirectResponse(url, 307);
  }

  // Local disk, which answers Range requests with 206 so the player can seek.
  const p = resolveQuiet(job.output_path);
  if (!p || !existsSync(p)) throw new HTTPException(410, 'the file is no longer available');
  return new FileResponse(p, { mediaType: 'video/mp4', filename: inline ? null : filename });
});
