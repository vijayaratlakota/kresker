/**
 * Loads /api/privacy/notice once and shares it.
 *
 * WHY THE PAGE DOES NOT HARD-CODE ANY OF THIS. Retention periods, the list of
 * recipients and the grievance contact all exist in the backend already — in
 * `config.py` and `consent.py`. Typing them into a React component creates a second
 * copy that nobody updates, and the copy people rely on is the published one. So the
 * notice fetches the truth from the implementation and renders it.
 *
 * The consequence is that these pages have a loading state, which a static legal
 * page normally would not. That is the trade: a notice that is occasionally a
 * skeleton for 80ms, against a notice that is occasionally a lie.
 */
import { useEffect, useState } from 'react';
import { api, type PrivacyNotice } from '../lib/api';

let cache: PrivacyNotice | null = null;
let inflight: Promise<PrivacyNotice> | null = null;

export function useNotice() {
  const [notice, setNotice] = useState<PrivacyNotice | null>(cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache) return;
    let alive = true;
    inflight ??= api.privacy.notice().then((n) => {
      cache = n;
      return n;
    });
    inflight
      .then((n) => {
        if (alive) setNotice(n);
      })
      .catch((err) => {
        // Reset so a transient failure does not poison every later mount.
        inflight = null;
        if (alive) {
          setError(err instanceof Error ? err.message : 'Could not load the notice.');
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return { notice, error };
}
