import { describe, it, expect, vi } from "vitest";
import { createQuotesClient } from "../wallet/quotes.js";

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; }
  };
}

function makeOkResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body
  };
}
function makeErrorResponse(status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({})
  };
}

describe("createQuotesClient", () => {
  it("throws when no fetch implementation is available", () => {
    const originalFetch = globalThis.fetch;
    delete globalThis.fetch;
    try {
      expect(() => createQuotesClient({ fetchImpl: undefined })).toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetches fresh quotes and caches for 30s", async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn().mockResolvedValue(
      makeOkResponse({ btcUsd: 100_000, usdBrl: 5 })
    );
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    const first = await client.getQuotes();
    expect(first.quotes).toEqual({ btcUsd: 100_000, usdBrl: 5 });
    expect(first.stale).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock.advance(29_000);
    const second = await client.getQuotes();
    expect(second.quotes).toEqual({ btcUsd: 100_000, usdBrl: 5 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches after the fresh window expires", async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(makeOkResponse({ btcUsd: 100_000, usdBrl: 5 }))
      .mockResolvedValueOnce(makeOkResponse({ btcUsd: 101_000, usdBrl: 5.1 }));
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    await client.getQuotes();
    clock.advance(31_000);
    const second = await client.getQuotes();
    expect(second.quotes.btcUsd).toBe(101_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns stale data inside the 5-minute fallback window on upstream error", async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(makeOkResponse({ btcUsd: 100_000, usdBrl: 5 }))
      .mockResolvedValueOnce(makeErrorResponse(502));
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    await client.getQuotes();
    clock.advance(60_000);
    const second = await client.getQuotes();
    expect(second.stale).toBe(true);
    expect(second.quotes).toEqual({ btcUsd: 100_000, usdBrl: 5 });
    expect(second.error).toBeDefined();
  });

  it("returns null when no cache is available and upstream fails", async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    const result = await client.getQuotes();
    expect(result).toBe(null);
  });

  it("returns null when the response is malformed", async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse({ btcUsd: "x", usdBrl: null }));
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    const result = await client.getQuotes();
    expect(result).toBe(null);
  });

  it("drops stale cache after the 5-minute window", async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(makeOkResponse({ btcUsd: 100_000, usdBrl: 5 }))
      .mockRejectedValue(new Error("still down"));
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    await client.getQuotes();
    clock.advance(6 * 60_000);
    const result = await client.getQuotes();
    expect(result).toBe(null);
  });

  it("dedupes concurrent fetches via the in-flight promise", async () => {
    const clock = makeClock();
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise(resolve => {
      resolveFetch = () => resolve(makeOkResponse({ btcUsd: 100_000, usdBrl: 5 }));
    }));
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    const p1 = client.getQuotes();
    const p2 = client.getQuotes();
    resolveFetch();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r1.quotes).toEqual(r2.quotes);
  });

  it("force=true bypasses the 30s cache", async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(makeOkResponse({ btcUsd: 100_000, usdBrl: 5 }))
      .mockResolvedValueOnce(makeOkResponse({ btcUsd: 200_000, usdBrl: 6 }));
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    await client.getQuotes();
    const second = await client.getQuotes({ force: true });
    expect(second.quotes.btcUsd).toBe(200_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("clear() wipes the cache and forces a refetch", async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn().mockResolvedValue(
      makeOkResponse({ btcUsd: 100_000, usdBrl: 5 })
    );
    const client = createQuotesClient({ fetchImpl, clock: clock.now });
    await client.getQuotes();
    client.clear();
    await client.getQuotes();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
