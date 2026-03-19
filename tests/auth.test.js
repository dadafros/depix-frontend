import { describe, it, expect, beforeEach } from "vitest";
import {
  getToken,
  getRefreshToken,
  getUser,
  isLoggedIn,
  setAuth,
  clearAuth
} from "../auth.js";

// Mock localStorage
const store = {};
const localStorageMock = {
  getItem: (key) => store[key] || null,
  setItem: (key, value) => { store[key] = value; },
  removeItem: (key) => { delete store[key]; },
  clear: () => { for (const k in store) delete store[k]; }
};
Object.defineProperty(global, "localStorage", { value: localStorageMock });

describe("Auth state management", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  describe("getToken / getRefreshToken / getUser", () => {
    it("should return null when not set", () => {
      expect(getToken()).toBeNull();
      expect(getRefreshToken()).toBeNull();
      expect(getUser()).toBeNull();
    });
  });

  describe("setAuth", () => {
    it("should store all auth data", () => {
      const user = { id: "1", nome: "Test", usuario: "test", email: "t@t.com" };
      setAuth("jwt-token", "refresh-token", user);

      expect(getToken()).toBe("jwt-token");
      expect(getRefreshToken()).toBe("refresh-token");
      expect(getUser()).toEqual(user);
    });
  });

  describe("isLoggedIn", () => {
    it("should return false when no token", () => {
      expect(isLoggedIn()).toBe(false);
    });

    it("should return true when token exists", () => {
      setAuth("jwt-token", "refresh", { id: "1" });
      expect(isLoggedIn()).toBe(true);
    });
  });

  describe("clearAuth", () => {
    it("should remove all auth data", () => {
      setAuth("jwt-token", "refresh-token", { id: "1" });
      clearAuth();

      expect(getToken()).toBeNull();
      expect(getRefreshToken()).toBeNull();
      expect(getUser()).toBeNull();
      expect(isLoggedIn()).toBe(false);
    });
  });

  describe("getUser", () => {
    it("should handle corrupted localStorage", () => {
      localStorageMock.setItem("depix-user", "not-json");
      expect(getUser()).toBeNull();
    });
  });
});
