// Client for the /api/quotes proxy. Keeps { btcUsd, usdBrl } fresh with a 30s
// cache window; if the upstream proxy is down we serve the last successful
// response for up to 5 minutes before giving up and returning null. The UI
// renders "—" whenever the converter returns null, never a zero.
//
// Why an in-memory cache and not localStorage: the whole point is a fresh
// quote; persisting across reloads can hide a long-term outage. 5 minutes is
// short enough that a reload to bypass the cache is instant, and long enough
// to survive a transient 502 from the proxy.

const FRESH_WINDOW_MS = 30_000;
const STALE_WINDOW_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_ENDPOINT = "/api/quotes";

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function normalizeQuotes(raw) {
  if (!raw || typeof raw !== "object") return null;
  const btcUsd = Number(raw.btcUsd);
  const usdBrl = Number(raw.usdBrl);
  if (!isFiniteNumber(btcUsd) || !isFiniteNumber(usdBrl)) return null;
  return { btcUsd, usdBrl };
}

// Factory so tests can inject a stub `fetch`, `clock`, and endpoint without
// touching globals. The default client lives at the bottom of the module.
export function createQuotesClient({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl,
  clock,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const getNow = clock ?? (() => Date.now());
  if (!doFetch) {
    throw new Error("createQuotesClient requires a fetch implementation");
  }
  let lastGood = null;
  let lastGoodAt = 0;
  let inflight = null;

  async function fetchFresh() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(endpoint, { signal: ac.signal, credentials: "omit" });
      if (!res.ok) throw new Error(`quotes HTTP ${res.status}`);
      const body = await res.json();
      const quotes = normalizeQuotes(body);
      if (!quotes) throw new Error("quotes response missing btcUsd/usdBrl");
      lastGood = quotes;
      lastGoodAt = getNow();
      return { quotes, stale: false };
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns `{ quotes, stale, age }` or null when nothing usable is cached
  // AND the upstream is unreachable. Callers render "—" on null.
  async function getQuotes({ force = false } = {}) {
    const now = getNow();
    if (!force && lastGood && now - lastGoodAt < FRESH_WINDOW_MS) {
      return { quotes: lastGood, stale: false, age: now - lastGoodAt };
    }
    if (!inflight) {
      inflight = fetchFresh()
        .catch(err => {
          // Rethrow only when we don't have a serviceable fallback.
          const age = getNow() - lastGoodAt;
          if (lastGood && age < STALE_WINDOW_MS) {
            return { quotes: lastGood, stale: true, age, error: err };
          }
          return { quotes: null, stale: true, age, error: err };
        })
        .finally(() => {
          inflight = null;
        });
    }
    const result = await inflight;
    if (result.quotes) return result;
    return null;
  }

  function getLastGood() {
    if (!lastGood) return null;
    return { quotes: lastGood, at: lastGoodAt };
  }

  function clear() {
    lastGood = null;
    lastGoodAt = 0;
    inflight = null;
  }

  return Object.freeze({ getQuotes, getLastGood, clear });
}

let defaultClient = null;
export function getDefaultQuotesClient() {
  if (!defaultClient) defaultClient = createQuotesClient();
  return defaultClient;
}
