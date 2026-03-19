import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage
const store = {};
const localStorageMock = {
  getItem: (key) => store[key] || null,
  setItem: (key, value) => { store[key] = value; },
  removeItem: (key) => { delete store[key]; },
  clear: () => { for (const k in store) delete store[k]; }
};
Object.defineProperty(global, "localStorage", { value: localStorageMock, writable: true });

Object.defineProperty(global, "crypto", {
  value: { randomUUID: vi.fn(() => "mock-device-uuid") },
  writable: true
});

// Mock router
vi.mock("../router.js", () => ({
  navigate: vi.fn()
}));

global.fetch = vi.fn();

import { setAuth, clearAuth, getToken, isLoggedIn } from "../auth.js";
import { apiFetch } from "../api.js";
import { navigate } from "../router.js";
import { goToAppropriateScreen } from "../script-helpers.js";
import { addAddress, getAddresses, hasAddresses } from "../addresses.js";

describe("Integration: 401 auto-refresh flow", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("should clear auth and redirect on full refresh failure", async () => {
    setAuth("expired-jwt", "bad-refresh", { id: "1" });

    fetch
      .mockResolvedValueOnce({ status: 401, ok: false })       // original request
      .mockResolvedValueOnce({ status: 401, ok: false });       // refresh also fails

    await expect(apiFetch("/api/test")).rejects.toThrow("Sessão expirada");

    expect(isLoggedIn()).toBe(false);
    expect(getToken()).toBeNull();
    expect(navigate).toHaveBeenCalledWith("#login");
  });

  it("should retry with new token after successful refresh", async () => {
    setAuth("expired-jwt", "valid-refresh", { id: "1" });

    fetch
      .mockResolvedValueOnce({ status: 401, ok: false })       // original fails
      .mockResolvedValueOnce({                                   // refresh succeeds
        status: 200, ok: true,
        json: async () => ({ token: "new-jwt", refreshToken: "new-refresh" })
      })
      .mockResolvedValueOnce({ status: 200, ok: true });       // retry succeeds

    const res = await apiFetch("/api/test");
    expect(res.status).toBe(200);

    // Auth was updated with new tokens
    expect(getToken()).toBe("new-jwt");

    // Retry used the new token
    const retryHeaders = fetch.mock.calls[2][1].headers;
    expect(retryHeaders["Authorization"]).toBe("Bearer new-jwt");
  });
});

describe("Integration: goToAppropriateScreen with real state", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("should route to #login when not authenticated", () => {
    const nav = vi.fn();
    goToAppropriateScreen({ isLoggedIn, hasAddresses, navigate: nav });
    expect(nav).toHaveBeenCalledWith("#login");
  });

  it("should route to #no-address when authenticated but no addresses", () => {
    setAuth("jwt", "refresh", { id: "1" });
    const nav = vi.fn();
    goToAppropriateScreen({ isLoggedIn, hasAddresses, navigate: nav });
    expect(nav).toHaveBeenCalledWith("#no-address");
  });

  it("should route to #home when authenticated with addresses", () => {
    setAuth("jwt", "refresh", { id: "1" });
    addAddress("tlq1qqv2abc123xyz456def789");
    const nav = vi.fn();
    goToAppropriateScreen({ isLoggedIn, hasAddresses, navigate: nav });
    expect(nav).toHaveBeenCalledWith("#home");
  });
});
