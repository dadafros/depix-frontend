// Fire-and-forget anonymous telemetry for the in-app wallet. We fetch
// without awaiting and swallow every error — telemetry must never block
// UI, retry on failure, or surface errors to the user.
//
// The server-side contract is enforced in `api/_lib/routes/wallet-telemetry.js`:
//   - 7 event names allowlist
//   - context keys allowlist (platform, pwa, errorCode, userAgent)
//   - per-value length cap, no userId, no addresses, no balances
//
// This client mirrors the allowlist so we fail fast in dev if someone
// tries to emit an unknown event.
//
// NOTE: this module is designed to work WITHOUT the wallet bundle being
// loaded — both the wallet-ui and the bootstrap code in script.js can
// import it. That's why the endpoint is hardcoded and we don't take a
// fetch injection dependency.

// Mirror api.js API_BASE: on the Docker dev env (localhost:2323) nginx proxies
// /api/* to the backend container, so a bare path keeps dev/test telemetry
// local. Everywhere else (depixapp.com) we must hit the backend absolute URL.
// Using a single hardcoded prod URL would pollute prod metrics with every
// manual-test/E2E event fired during development.
const DEFAULT_ENDPOINT = (typeof window !== "undefined" &&
  window.location?.hostname === "localhost" &&
  window.location?.port === "2323")
  ? "/api/wallet/telemetry"
  : "https://depix-backend.vercel.app/api/wallet/telemetry";

const EVENTS = Object.freeze({
  WALLET_CREATED: "wallet.created",
  WALLET_WIPED: "wallet.wiped",
  BIOMETRIC_ENROLL_SUCCESS: "biometric.enroll.success",
  BIOMETRIC_ENROLL_FAILED: "biometric.enroll.failed",
  UNLOCK_PIN_WRONG: "unlock.pin.wrong",
  SEND_BROADCAST_FAILED: "send.broadcast.failed",
  WASM_LOAD_TIMEOUT: "wasm.load.timeout"
});

const ALLOWED_EVENTS = new Set(Object.values(EVENTS));
const ALLOWED_CONTEXT_KEYS = new Set(["platform", "pwa", "errorCode", "userAgent"]);

function detectPlatform() {
  if (typeof navigator === "undefined") return undefined;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

function detectPwa() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return "standalone";
    if (window.navigator?.standalone === true) return "ios-standalone";
    return "browser";
  } catch {
    return undefined;
  }
}

export function createTelemetryClient({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl,
  autoContext = true
} = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);

  function buildContext(extra) {
    const base = autoContext ? { platform: detectPlatform(), pwa: detectPwa() } : {};
    const merged = { ...base, ...(extra || {}) };
    const sanitized = {};
    for (const [key, value] of Object.entries(merged)) {
      if (!ALLOWED_CONTEXT_KEYS.has(key)) continue;
      if (value === undefined || value === null || value === "") continue;
      sanitized[key] = String(value).slice(0, 64);
    }
    return sanitized;
  }

  function track(event, context) {
    if (!doFetch) return;
    if (!ALLOWED_EVENTS.has(event)) {
      // In dev this catches typos; in prod it's a no-op.
      if (typeof console !== "undefined") {
        console.warn("telemetry: unknown event", event);
      }
      return;
    }
    const payload = JSON.stringify({ event, context: buildContext(context) });
    // Prefer sendBeacon (can outlive page navigations, doesn't touch UI thread).
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function" &&
        typeof Blob === "function"
      ) {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
    } catch {
      // Fall through to fetch().
    }
    try {
      doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        credentials: "omit",
        keepalive: true
      }).catch(() => { /* best-effort */ });
    } catch {
      // Synchronous fetch errors are ignored too.
    }
  }

  return Object.freeze({ track });
}

let defaultClient = null;
export function getDefaultTelemetryClient() {
  if (!defaultClient) defaultClient = createTelemetryClient();
  return defaultClient;
}

export { EVENTS as TELEMETRY_EVENTS };
