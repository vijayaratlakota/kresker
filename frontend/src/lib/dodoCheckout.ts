/**
 * Send the customer to the payment page.
 *
 * A FULL-PAGE NAVIGATION, and this file used to be much bigger. Two attempts at embedding
 * the provider's checkout were tried and both were worse than simply going there:
 *
 *   overlay  a `position: fixed`, viewport-sized iframe that the SDK never resizes. The
 *            provider's page drew its own card inside it and, on anything short of a tall
 *            window, scrolled itself — a vertical AND a horizontal bar inside a cramped
 *            panel with the footer clipped. Not correctable: a cross-origin document's
 *            layout is not ours to style.
 *   inline    an iframe grown to its content height, inside a dialog of ours. No scrollbars,
 *            but the frame was narrow, so the provider served its single-column mobile
 *            layout to a desktop — a tall thin form on a wide screen.
 *
 * Given a whole window the same page is a two-column checkout: order summary on the left,
 * card and wallet buttons on the right, its own light/dark control, correctly responsive at
 * every width. It is well built. The mistake was giving it a letterbox to live in.
 *
 * THREE PROBLEMS DISAPPEAR WITH THE IFRAME:
 *   - the scrollbars, because the page has the room it was designed for;
 *   - the iOS zoom, because the form is no longer inside a document whose viewport meta we
 *     own — their page sets its own, and a focused input no longer magnifies ours;
 *   - the redirect, because `return_url` moves the TOP window. From inside an iframe the
 *     same navigation only moved the frame.
 *
 * WHAT IT COSTS is the thing to be honest about: the customer leaves the site. A first
 * purchase comes back on its own, because `/checkouts` carries a return url for success and
 * failure alike. An upgrade does not — the provider's change-plan endpoint has no such field
 * — so it is the backstop on the billing page that catches those, whenever they next return.
 */

/** Kept as a named function so the call sites read as intent, not as a raw assignment. */
export function goToPaymentPage(url: string): void {
  // `assign`, not `replace`: the browser's Back button should still return to billing if
  // somebody changes their mind at the payment page.
  window.location.assign(url);
}
