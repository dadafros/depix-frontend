// Trusted Types policy registration. Imported by every entry point
// (script.js + wallet/entry.js) so the "depix" policy is registered for
// any innerHTML / insertAdjacentHTML / scriptURL sink that wants to opt
// in via the wrappers below.
//
// The policy is identity by design: every sink in the codebase already
// passes user-supplied data through utils.js#escapeHtml. The named policy
// exists so this codebase has a clear, documented wrapper at every TT
// sink — and so `require-trusted-types-for 'script'` can be flipped on
// in a future change without rewriting call sites.
//
// Why enforcement is NOT on yet: Cloudflare Turnstile (loaded on the
// register/login flows for bot protection) writes innerHTML internally
// when its widget renders, and Cloudflare doesn't currently expose a
// way to route those writes through a Trusted Types policy. Enabling
// `require-trusted-types-for 'script'` today breaks the register flow
// in production. The CSP keeps `trusted-types depix` (declarative —
// declares the policy name, no enforcement) so the wrapper machinery
// stays exercised and the Playwright pre-flight test in depix-dev can
// verify the codebase WOULD be enforcement-clean once Turnstile is
// migrated or replaced.
//
// build.mjs marks this module as `external`, so the wallet bundle and
// the legacy side share a single module instance and only one
// `createPolicy` call ever runs across the whole site. That keeps the
// policy-name barrier intact: an injected attacker can't re-register
// "depix" because it already exists and the CSP omits `'allow-
// duplicates'`.
//
// Registration is gated by a try/catch because:
//   1. Older browsers without Trusted Types report `trustedTypes` as
//      undefined; the early-return path keeps the helper a no-op there.
//   2. Defensive: if a future change accidentally re-introduces a second
//      registration of "depix" (e.g. someone removes the `external`
//      setting in build.mjs), the catch keeps the page running with
//      `policy = null`. The `console.error` makes the underlying cause
//      visible immediately rather than via spurious user-side innerHTML
//      errors when enforcement is eventually turned on.

let policy = null;

const tt = globalThis.trustedTypes;
if (tt && typeof tt.createPolicy === "function") {
  try {
    policy = tt.createPolicy("depix", {
      createHTML: s => s,
      createScriptURL: u => u
    });
  } catch (err) {
    console.error("[trusted-types] createPolicy(\"depix\") failed:", err);
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

/**
 * Wrap a URL for assignment to a Trusted-Types-protected script-URL sink.
 * Required by `require-trusted-types-for 'script'` for sinks like
 * `ServiceWorkerContainer.register(scriptURL)`, `new Worker(scriptURL)`,
 * `new SharedWorker(scriptURL)`, and dynamic `<script src=...>` injection.
 * Returns a TrustedScriptURL in browsers that support it, otherwise the
 * unchanged string.
 */
export function toTrustedScriptURL(url) {
  return policy ? policy.createScriptURL(url) : url;
}
