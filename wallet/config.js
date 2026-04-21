// Client for the /api/config kill-switch endpoint. Caches `walletEnabled`
// for 5 minutes in memory; on network error we default to `true` (fail-open
// for the happy path — the backend is the source of truth, not the cache).
//
// The server-side contract is enforced in `api/_lib/routes/config.js`:
//   - `{ walletEnabled: boolean, timestamp: number }`
//   - `walletEnabled` turns false only when WALLET_KILL_SWITCH env is set.
//
// Why in-memory only: we don't want a stale "false" persisted across reloads
// to block users when the operator has already cleared the switch. Every
// cold start re-checks, and the 5min window covers a single session.

const DEFAULT_ENDPOINT = "/api/config";
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
