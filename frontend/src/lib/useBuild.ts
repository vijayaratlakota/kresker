/**
 * Has this tab been left behind by a deploy?
 *
 * WHY THIS EXISTS, FROM A REAL FAILURE. A browser keeps running whatever JavaScript it
 * loaded until something makes it fetch again. Usually that is harmless. Once it was not:
 * the checkout redirect was added, deployed and verified, and a tab that had been open
 * since before the deploy still ran the previous version — which showed a cheerful
 * "created" message and silently discarded the payment link. The customer got no payment
 * page and no error, and the server logs were spotless, because the server had done its
 * job correctly. Nothing in the product could have told anyone what was wrong.
 *
 * HOW IT WORKS, AND WHY THERE IS NO VERSION NUMBER. The server reports the content hash
 * of the build it is serving. This module remembers whatever it saw FIRST and compares
 * every later report against that. So the question being answered is exactly the useful
 * one — "has the server changed since this tab loaded?" — and it needs no version constant
 * to bump, no build-time injection, and nothing that can drift out of step with reality.
 *
 * FAILING QUIET IS THE RULE. Missing, null or unreadable means "cannot tell", which is
 * treated as up to date. A version check that nags people because a probe failed is worse
 * than no version check.
 */
import { create } from 'zustand';

interface BuildState {
  /** What the server reported the first time we asked. Null until then. */
  seen: string | null;
  /** True once the server reports a different build from the one this tab loaded. */
  stale: boolean;
  /** Feed every /api/site answer through here. */
  observe: (build: string | null | undefined) => void;
  /** Dismiss the notice. Does NOT clear `stale` — see the comment below. */
  dismissed: boolean;
  dismiss: () => void;
}

export const useBuild = create<BuildState>((set, get) => ({
  seen: null,
  stale: false,
  dismissed: false,

  observe: (build) => {
    if (!build) return; // cannot tell; never treated as out of date
    const { seen } = get();
    if (seen === null) {
      set({ seen: build });
      return;
    }
    if (seen !== build && !get().stale) set({ stale: true });
  },

  // Dismissing hides the BAR, and deliberately leaves `stale` true. The flag is also what
  // stops a payment being started on code the server has replaced, and somebody closing a
  // notice is not a reason to let that happen — see Billing.tsx.
  dismiss: () => set({ dismissed: true }),
}));

/**
 * Reload onto the current build.
 *
 * `location.reload()` is enough: index.html is served `no-cache`, so the browser
 * revalidates it and picks up whatever asset names it now points at. The hashed assets
 * themselves are immutable and cached forever, which is correct — a new build has new
 * names, so there is nothing stale to bust.
 */
export function reloadForNewBuild(): void {
  window.location.reload();
}
