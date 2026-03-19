import { describe, it, expect, beforeEach } from "vitest";
import {
  getAddresses,
  addAddress,
  removeAddress,
  getSelectedAddress,
  setSelectedAddress,
  abbreviateAddress,
  hasAddresses
} from "../addresses.js";

// Mock localStorage
const store = {};
const localStorageMock = {
  getItem: (key) => store[key] || null,
  setItem: (key, value) => { store[key] = value; },
  removeItem: (key) => { delete store[key]; },
  clear: () => { for (const k in store) delete store[k]; }
};
Object.defineProperty(global, "localStorage", { value: localStorageMock });

describe("Address management", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  describe("getAddresses", () => {
    it("should return empty array when no addresses", () => {
      expect(getAddresses()).toEqual([]);
    });

    it("should return saved addresses", () => {
      localStorageMock.setItem("depix-addresses", JSON.stringify(["addr1", "addr2"]));
      expect(getAddresses()).toEqual(["addr1", "addr2"]);
    });

    it("should handle corrupted localStorage", () => {
      localStorageMock.setItem("depix-addresses", "not-json");
      expect(getAddresses()).toEqual([]);
    });
  });

  describe("addAddress", () => {
    it("should add an address", () => {
      const result = addAddress("liquid-address-123");
      expect(result).toBe(true);
      expect(getAddresses()).toEqual(["liquid-address-123"]);
    });

    it("should auto-select first address", () => {
      addAddress("first-address-here");
      expect(getSelectedAddress()).toBe("first-address-here");
    });

    it("should not auto-select second address", () => {
      addAddress("first-address-here");
      addAddress("second-address-here");
      expect(getSelectedAddress()).toBe("first-address-here");
    });

    it("should reject duplicate", () => {
      addAddress("liquid-address-123");
      const result = addAddress("liquid-address-123");
      expect(result).toBe(false);
      expect(getAddresses()).toHaveLength(1);
    });

    it("should reject empty string", () => {
      expect(addAddress("")).toBe(false);
      expect(addAddress("   ")).toBe(false);
    });

    it("should trim whitespace", () => {
      addAddress("  liquid-addr  ");
      expect(getAddresses()).toEqual(["liquid-addr"]);
    });
  });

  describe("removeAddress", () => {
    it("should remove an address", () => {
      addAddress("addr1");
      addAddress("addr2");
      removeAddress("addr1");
      expect(getAddresses()).toEqual(["addr2"]);
    });

    it("should clear selection if removed address was selected", () => {
      addAddress("addr1");
      addAddress("addr2");
      setSelectedAddress("addr1");
      removeAddress("addr1");
      expect(getSelectedAddress()).toBe("addr2"); // falls back to first
    });
  });

  describe("selectedAddress", () => {
    it("should return empty when nothing selected", () => {
      expect(getSelectedAddress()).toBe("");
    });

    it("should get/set selected address", () => {
      setSelectedAddress("my-address");
      expect(getSelectedAddress()).toBe("my-address");
    });
  });

  describe("hasAddresses", () => {
    it("should return false when empty", () => {
      expect(hasAddresses()).toBe(false);
    });

    it("should return true when addresses exist", () => {
      addAddress("addr1234567890");
      expect(hasAddresses()).toBe(true);
    });
  });
});

describe("abbreviateAddress", () => {
  it("should abbreviate long addresses", () => {
    const addr = "tlq1qqv2hf6ypnqk93yz7df5gk8qxn3c";
    const result = abbreviateAddress(addr);
    expect(result).toBe("tlq1qqv2...xn3c");
  });

  it("should not abbreviate short addresses", () => {
    expect(abbreviateAddress("short-addr")).toBe("short-addr");
  });

  it("should handle empty/null input", () => {
    expect(abbreviateAddress("")).toBe("");
    expect(abbreviateAddress(null)).toBe(null);
    expect(abbreviateAddress(undefined)).toBe(undefined);
  });

  it("should show first 8 and last 4 chars", () => {
    const addr = "abcdefghijklmnopqrstuvwxyz";
    const result = abbreviateAddress(addr);
    expect(result).toBe("abcdefgh...wxyz");
    expect(result.startsWith("abcdefgh")).toBe(true);
    expect(result.endsWith("wxyz")).toBe(true);
  });
});
