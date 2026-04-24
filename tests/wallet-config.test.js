// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createConfigClient } from "../wallet/config.js";

function jsonResp(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body
  };
}

describe("createConfigClient", () => {
  it("returns walletEnabled=true by default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ walletEnabled: true, timestamp: 1 }));
    const c = createConfigClient({ fetchImpl });
    await expect(c.isWalletEnabled()).resolves.toBe(true);
    // jsdom's default URL is http://localhost:3000, so the env-check in
    // config.js resolves to the absolute prod URL (the dev branch only fires
    // on localhost:2323 under the nginx proxy). See the DEFAULT_ENDPOINT note.
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://depix-backend.vercel.app/api/config",
      expect.objectContaining({ credentials: "omit" })
    );
  });

  it("returns walletEnabled=false when backend says so", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ walletEnabled: false, timestamp: 1 }));
    const c = createConfigClient({ fetchImpl });
    await expect(c.isWalletEnabled()).resolves.toBe(false);
  });

  it("caches results for 5 minutes", async () => {
    let now = 1000;
    const clock = () => now;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ walletEnabled: true }));
    const c = createConfigClient({ fetchImpl, clock });
    await c.isWalletEnabled();
    now += 60_000; // +1min
    await c.isWalletEnabled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 5 * 60_000 + 1; // past TTL
    await c.isWalletEnabled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails open (returns true) when network errors and nothing cached", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
    const c = createConfigClient({ fetchImpl });
    await expect(c.isWalletEnabled()).resolves.toBe(true);
  });

  it("serves stale cache when subsequent fetch fails", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) return Promise.resolve(jsonResp({ walletEnabled: false }));
      return Promise.reject(new Error("down"));
    });
    let now = 1000;
    const clock = () => now;
    const c = createConfigClient({ fetchImpl, clock });
    await expect(c.isWalletEnabled()).resolves.toBe(false);
    now += 10 * 60_000; // invalidate cache
    await expect(c.isWalletEnabled()).resolves.toBe(false); // keeps last known
  });

  it("throws synchronously when no fetch implementation is available", () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      expect(() => createConfigClient({ fetchImpl: null })).toThrow(
        /fetch implementation/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dedupes concurrent requests", async () => {
    let resolveFetch;
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise(resolve => { resolveFetch = () => resolve(jsonResp({ walletEnabled: true })); })
    );
    const c = createConfigClient({ fetchImpl });
    const [a, b] = [c.isWalletEnabled(), c.isWalletEnabled()];
    resolveFetch();
    await Promise.all([a, b]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("clear() resets the cache", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ walletEnabled: true }));
    const c = createConfigClient({ fetchImpl });
    await c.isWalletEnabled();
    c.clear();
    await c.isWalletEnabled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
