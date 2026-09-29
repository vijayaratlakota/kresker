/**
 * IndexNow: tell Bing, Yandex, Naver and Seznam that a page changed, so they fetch it
 * within minutes instead of on their own schedule.
 *
 * Google does not support IndexNow; for Google the sitemap (with real `lastmod` dates)
 * and Search Console are what count. This costs one HTTP request per deploy.
 *
 * Ownership is proven by a file at https://<host>/<key>.txt holding exactly the key. The
 * key is PUBLIC by design — it only lets somebody ask for a re-crawl of pages on a host
 * we already control — so it is configuration, not a secret. There is deliberately no
 * trigger on every database write: the public pages change when they are redeployed.
 */
import { INDEXNOW_KEY } from './config';
import { errText, pyDumps, pySlice, pyStrip } from './py';
import * as site from './site';

const ENDPOINT = 'https://api.indexnow.org/indexnow';

// The spec: 8 to 128 characters, and only these.
const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

export function key(): string {
  return pyStrip(INDEXNOW_KEY || '');
}

/** Whether a submission could succeed, and why not if it could not. */
export function configured(): [boolean, string] {
  const k = key();
  if (!k) return [false, 'VS_INDEXNOW_KEY is not set, so there is no key file to verify.'];
  if (!KEY_RE.test(k)) {
    return [false, "VS_INDEXNOW_KEY must be 8-128 characters of A-Z, a-z, 0-9 or '-'. Check for a stray space or newline."];
  }
  if (!site.baseUrl().startsWith('https://')) {
    return [false, 'PUBLIC_BASE_URL is not https, so this is not a live origin and there is nothing for a crawler to fetch.'];
  }
  return [true, ''];
}

export function keyFileName(): string {
  return `${key()}.txt`;
}

/** The whole file: the key, and nothing else. */
export function keyFileBody(): string {
  return key();
}

/**
 * Submit URLs. Never throws: this runs at the end of a deploy, and a search-engine ping
 * failing must not fail a deploy that has already installed working code.
 */
export async function submit(urls: string[] | null = null, timeoutS = 20.0): Promise<Record<string, unknown>> {
  const [ok, why] = configured();
  if (!ok) return { submitted: 0, status: null, skipped: why };

  const targets = urls !== null ? urls : site.sitemapUrls();
  if (!targets.length) return { submitted: 0, status: null, skipped: 'no URLs to submit' };

  const base = site.baseUrl();
  const host = base.slice(base.indexOf('://') + 3);
  const payload = {
    host,
    key: key(),
    // stated explicitly: a wrong default fails as "key not found" with no hint
    keyLocation: `${base}/${keyFileName()}`,
    urlList: targets,
  };

  let code: number;
  let body: string;
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      // urllib's json.dumps default: ", " and ": " separators, ASCII-escaped
      body: pyDumps(payload),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'kresker-indexnow/1.0' },
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    code = r.status;
    body = new TextDecoder('utf-8', { fatal: false }).decode((await r.arrayBuffer()).slice(0, 2000));
  } catch (e) {
    return { submitted: 0, status: null, error: errText(e), urls: targets };
  }
  // 200 accepted; 202 accepted while the key is still being verified.
  const accepted = code === 200 || code === 202;
  return {
    submitted: accepted ? targets.length : 0,
    status: code,
    accepted,
    body: pySlice(body, 400),
    urls: targets,
    key_url: payload.keyLocation,
  };
}
