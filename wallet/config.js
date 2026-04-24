// Client for the /api/config kill-switch endpoint. Caches `walletEnabled`
// for 5 minutes in memory; on network error we default to `true` (fail-open
// for the happy path — the backend is the source of truth, not the cache).
//
// The server-side contract is enforced in `api/_lib/routes/config.js`:
//   - `{ walletEnabled: boolean, timestamp: number }`
//   - `walletEnabled` turns false when the Redis flag `wallet:kill_switch`
//     is set. Toggled via the Telegram admin commands `/walletoff` and
//     `/walleton` — never via env vars.
//
// Why in-memory only: we don't want a stale "false" persisted across reloads
// to block users when the operator has already cleared the switch. Every
// cold start re-checks, and the 5min window covers a single session.

// Mirror api.js API_BASE: on the Docker dev env (localhost:2323) the nginx
// proxy forwards /api/* to the backend container, so a bare path is correct.
// Everywhere else (depixapp.com / GitHub Pages) we must hit the backend's
// absolute URL — a bare /api/config returns 404 and the kill switch falls
// open silently. See CLAUDE.md "Red flags" (bare /api/ path on GH Pages).
const DEFAULT_ENDPOINT = (typeof window !== "undefined" &&
  window.location?.hostname === "localhost" &&
  window.location?.port === "2323")
  ? "/api/config"
  : "https://depix-backend.vercel.app/api/config";
const CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 4_000;

export function createConfigClient({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl,
  clock,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const getNow = clock ?? (() => Date.now());
  if (!doFetch) {
    throw new Error("createConfigClient requires a fetch implementation");
  }

  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  async function fetchFresh() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(endpoint, { signal: ac.signal, credentials: "omit" });
      if (!res.ok) throw new Error(`config HTTP ${res.status}`);
      const body = await res.json();
      const walletEnabled = body?.walletEnabled !== false;
      cached = { walletEnabled };
      cachedAt = getNow();
      return cached;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getConfig({ force = false } = {}) {
    const now = getNow();
    if (!force && cached && now - cachedAt < CACHE_TTL_MS) {
      return cached;
    }
    if (!inflight) {
      inflight = fetchFresh()
        .catch(() => {
          // Fail-open: if the kill-switch endpoint is unreachable we keep
          // the previously cached answer; if none, assume wallet enabled.
          if (cached) return cached;
          return { walletEnabled: true };
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function isWalletEnabled(opts) {
    const cfg = await getConfig(opts);
    return cfg.walletEnabled !== false;
  }

  function clear() {
    cached = null;
    cachedAt = 0;
    inflight = null;
  }

  return Object.freeze({ getConfig, isWalletEnabled, clear });
}

let defaultClient = null;
export function getDefaultConfigClient() {
  if (!defaultClient) defaultClient = createConfigClient();
  return defaultClient;
}

// Drop the module-level singleton. Tests that swap fetch implementations or
// spec environments (jsdom vs node) need to force a rebuild; production code
// should not call this.
export function resetDefaultConfigClient() {
  defaultClient = null;
}
