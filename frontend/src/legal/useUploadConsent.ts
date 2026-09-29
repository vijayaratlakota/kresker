/**
 * Records the upload consent. It no longer asks for it with checkboxes.
 *
 * WHAT CHANGED AND WHY. This used to render two unticked boxes above the dropzone
 * and disable the dropzone until both were ticked. It was correct and it was
 * clumsy: two paragraphs of third-party-processing detail in front of somebody who
 * came to dub a video, on every upload until the record existed. Nobody reads that,
 * and consent nobody reads is not informed consent — it is a speed bump that
 * teaches people to click past legal text.
 *
 * So the detail moved to where it can actually be read (Privacy Notice §2 and §5,
 * Disclaimer §3) and the dropzone carries one line pointing at it. Pressing upload
 * is the affirmative action.
 *
 * The RECORD is unchanged in substance and still written before the file is sent:
 * `process_video` and `voice_clone`, stamped with the notice version, so "what did
 * this account agree to, and when" still has an answer. `method` is
 * `terms_acceptance`, not `checkbox`, because the column exists to say how consent
 * was collected and it must not describe a control that is no longer there.
 *
 * Two deliberate differences from the old behaviour:
 *
 *  1. It no longer BLOCKS. A failed consent write used to abort the upload. That was
 *     defensible when the tick was the only evidence; now the acceptance also exists
 *     at signup, so refusing a paying customer's upload over a logging failure costs
 *     more than it protects. The gap is visible instead: `consent.readiness()`
 *     counts accounts with no record.
 *  2. It writes once per session per notice version rather than checking on every
 *     pick, so the second upload does not make a round trip to learn what the first
 *     one already established.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ConsentPurpose } from '../lib/api';
import { useNotice } from './useNotice';

export function useUploadConsent() {
  const { notice } = useNotice();
  const [current, setCurrent] =
    useState<Record<string, { granted: boolean; notice_version: string }> | null>(null);
  const wrote = useRef(false);

  useEffect(() => {
    let alive = true;
    api.privacy
      .myConsent()
      .then((r) => {
        if (alive) setCurrent(r.current);
      })
      .catch(() => {
        // Unknown. `satisfied` stays false, so the next upload records it — which is
        // the harmless direction: a duplicate row in an append-only ledger is noise,
        // a missing one is a hole in the evidence.
        if (alive) setCurrent({});
      });
    return () => {
      alive = false;
    };
  }, []);

  const purposes = useMemo<ConsentPurpose[]>(
    () => (notice?.purposes ?? []).filter((p) => p.where === 'upload'),
    [notice],
  );

  /** Already on record against the notice version now in force? */
  const satisfied = useMemo(() => {
    if (!notice || !current || purposes.length === 0) return false;
    return purposes.every(
      (p) =>
        current[p.key]?.granted === true &&
        current[p.key]?.notice_version === notice.notice_version,
    );
  }, [notice, current, purposes]);

  /**
   * Write the record. Awaited by the caller before the upload starts, so the row
   * cannot be dated after the data it covers — but a failure does not stop the
   * upload. Returns nothing on purpose: there is no decision for the caller to make.
   */
  const record = useCallback(async () => {
    if (wrote.current || satisfied || purposes.length === 0) return;
    wrote.current = true;
    const body: Record<string, boolean> = {};
    for (const p of purposes) body[p.key] = true;
    try {
      await api.privacy.setConsent(body, 'terms_acceptance');
      setCurrent((c) => ({
        ...(c ?? {}),
        ...Object.fromEntries(
          purposes.map((p) => [
            p.key,
            { granted: true, notice_version: notice?.notice_version ?? '' },
          ]),
        ),
      }));
    } catch {
      // Best effort. See note 1 above. Reset so a later upload tries again.
      wrote.current = false;
    }
  }, [purposes, satisfied, notice]);

  return { record };
}
