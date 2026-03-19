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

// Mock crypto
Object.defineProperty(global, "crypto", {
  value: { randomUUID: vi.fn(() => "mock-device-uuid-1234") },
  writable: true
});

// Mock auth module
vi.mock("../auth.js", () => ({
  getToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
  setAuth: vi.fn(),
  clearAuth: vi.fn()
}));

// Mock router module
vi.mock("../router.js", () => ({
  navigate: vi.fn()
}));

// Mock global fetch
global.fetch = vi.fn();

import { apiFetch } from "../api.js";
import { getToken, getRefreshToken, setAuth, clearAuth } from "../auth.js";
import { navigate } from "../router.js";

describe("apiFetch", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    getToken.mockReturnValue(null);
    getRefreshToken.mockReturnValue(null);
    fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
  });

  describe("basic requests", () => {
    it("should attach Authorization header when token exists", async () => {
      getToken.mockReturnValue("my-jwt-token");
      await apiFetch("/api/test");

      expect(fetch).toHaveBeenCalledWith(
        "https://depix-backend.vercel.app/api/test",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Authorization": "Bearer my-jwt-token"
          })
        })
      );
    });

    it("should not attach Authorization header when no token", async () => {
      getToken.mockReturnValue(null);
      await apiFetch("/api/test");

      const headers = fetch.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("should attach Content-Type: application/json", async () => {
      await apiFetch("/api/test");

      const headers = fetch.mock.calls[0][1].headers;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("should attach X-Device-Id header", async () => {
      await apiFetch("/api/test");

      const headers = fetch.mock.calls[0][1].headers;
      expect(headers["X-Device-Id"]).toBeDefined();
    });

    it("should prepend API_BASE to path", async () => {
      await apiFetch("/api/depix");

      expect(fetch).toHaveBeenCalledWith(
        "https://depix-backend.vercel.app/api/depix",
        expect.anything()
      );
    });

    it("should pass through method and body options", async () => {
      await apiFetch("/api/test", {
        method: "POST",
        body: JSON.stringify({ key: "value" })
      });

      expect(fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ key: "value" })
        })
      );
    });
  });

  describe("device ID", () => {
    it("should generate device ID on first call and store in localStorage", async () => {
      await apiFetch("/api/test");

      expect(localStorageMock.getItem("depix-device-id")).toBe("mock-device-uuid-1234");
    });

    it("should reuse device ID from localStorage on subsequent calls", async () => {
      localStorageMock.setItem("depix-device-id", "existing-device-id");
      await apiFetch("/api/test");

      const headers = fetch.mock.calls[0][1].headers;
      expect(headers["X-Device-Id"]).toBe("existing-device-id");
    });
  });

  describe("401 auto-refresh", () => {
    it("should attempt token refresh on 401 response", async () => {
      getToken.mockReturnValue("expired-token");
      getRefreshToken.mockReturnValue("my-refresh-token");

      fetch
        .mockResolvedValueOnce({ status: 401, ok: false })
        .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ token: "new-token", refreshToken: "new-refresh" }) })
        .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ data: "success" }) });

      const result = await apiFetch("/api/test");

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe(200);
    });

    it("should retry original request with new token after successful refresh", async () => {
      getToken
        .mockReturnValueOnce("expired-token")
        .mockReturnValue("new-access-token");

      getRefreshToken.mockReturnValue("my-refresh-token");

      fetch
        .mockResolvedValueOnce({ status: 401, ok: false })
        .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ token: "new-access-token", refreshToken: "new-refresh" }) })
        .mockResolvedValueOnce({ status: 200, ok: true });

      await apiFetch("/api/test");

      const retryHeaders = fetch.mock.calls[2][1].headers;
      expect(retryHeaders["Authorization"]).toBe("Bearer new-access-token");
    });

    it("should clear auth and navigate to #login on refresh failure", async () => {
      getToken.mockReturnValue("expired-token");
      getRefreshToken.mockReturnValue("bad-refresh-token");

      fetch
        .mockResolvedValueOnce({ status: 401, ok: false })
        .mockResolvedValueOnce({ status: 401, ok: false });

      await expect(apiFetch("/api/test")).rejects.toThrow("Sessão expirada");
      expect(clearAuth).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("#login");
    });

    it("should not attempt refresh if no token was set", async () => {
      getToken.mockReturnValue(null);

      fetch.mockResolvedValueOnce({ status: 401, ok: false });

      const res = await apiFetch("/api/test");
      expect(res.status).toBe(401);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
