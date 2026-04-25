// Trusted Types policy registration. Imported FIRST by every entry point
// (script.js + wallet/entry.js) so the "depix" policy is registered before
// any innerHTML / insertAdjacentHTML write fires.
//
// The policy is identity by design: every sink in the codebase already
// passes user-supplied data through utils.js#escapeHtml. The policy exists
// purely to satisfy `require-trusted-types-for 'script'` in the CSP — it
// neither adds nor removes escaping. The defense-in-depth value comes from
// the CSP itself: an attacker who manages to inject a <script> tag cannot
// call `el.innerHTML = "..."` directly anymore; they would have to import
// our `toTrustedHTML` helper, which requires being inside our module graph.
//
// Registration is gated by a try/catch because:
//   1. esbuild bundles `trusted-types.js` into the wallet bundle, so the
//      bundle re-registers "depix" when it loads. CSP `'allow-duplicates'`
//      lets the second registration succeed; if a future browser changes
//      that, the catch keeps the page running with `policy = null` (sinks
//      receive plain strings — innocuous when CSP enforcement is off, and
//      a clear violation if enforcement is on, easy to spot in DevTools).
//   2. Older browsers without Trusted Types report `trustedTypes` as
//      undefined; the early-return path keeps the helper a no-op there.

let policy = null;

const tt = globalThis.trustedTypes;
if (tt && typeof tt.createPolicy === "function") {
  try {
    policy = tt.createPolicy("depix", {
      createHTML: s => s
    });
  } catch {
    policy = null;
  }
}

/**
 * Wrap a string for assignment to a Trusted-Types-protected DOM sink.
 * Returns a TrustedHTML in browsers that support it, otherwise the
 * unchanged string. Callers must keep their existing escaping (escapeHtml
 * for user data) — this helper does not sanitize.
 */
export function toTrustedHTML(html) {
  return policy ? policy.createHTML(html) : html;
}

/**
 * Convenience: assign HTML to `el.innerHTML` through the policy. Equivalent
 * to `el.innerHTML = toTrustedHTML(html)` but lets call-site refactors stay
 * compact. No-op when `el` is null/undefined so the optional-chain pattern
 * `q("foo")?.innerHTML = ...` migrates to `setInnerHTML(q("foo"), ...)`
 * without losing its null guard.
 */
export function setInnerHTML(el, html) {
  if (!el) return;
  el.innerHTML = toTrustedHTML(html);
}

/**
 * Convenience: insertAdjacentHTML through the policy.
 */
export function insertHTML(el, position, html) {
  if (!el) return;
  el.insertAdjacentHTML(position, toTrustedHTML(html));
}
