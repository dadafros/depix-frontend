// @vitest-environment jsdom
// Lightweight unit tests for the Carteira Externa modal CRUD flow.
// We don't load script.js (it has ~3800 lines of module-time side effects);
// instead we replicate the minimal wiring by importing addresses.js + the
// validator, then simulating what the handlers do. Behavioral coverage of
// the real event listeners is done end-to-end in the Playwright spec
// (depix-dev/tests/wallet/menu-navigation.spec.js).
import { describe, it, expect, beforeEach } from "vitest";

const store = {};
const localStorageMock = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear: () => { for (const k in store) delete store[k]; }
};
Object.defineProperty(global, "localStorage", { value: localStorageMock, writable: true });

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

// Dynamic imports so each test gets a clean module state relative to the
// reset localStorage. addresses.js reads localStorage lazily on each call.
async function importAddresses() {
  const mod = await import("../addresses.js");
  return mod;
}

async function importValidation() {
  return await import("../validation.js");
}

// Realistic max-length confidential Liquid address (95 chars, unbreakable)
// — the canonical fixture for layout + CRUD tests per CLAUDE.md Rule 6.
// Valid 95-char blech32 confidential Liquid address — same fixture the
// validation tests use. Long + unbreakable → exercises the list-render
// ellipsis truncation we care about under CLAUDE.md Rule 1.
const LONG_ADDR = "lq1qqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn5psx4kgu9l78v";

describe("Carteira Externa — CRUD behavior", () => {
  it("addAddress persists and setSelectedAddress drives the selection", async () => {
    const { addAddress, getAddresses, setSelectedAddress, getSelectedAddress } = await importAddresses();
    expect(addAddress(LONG_ADDR)).toBe(true);
    expect(getAddresses()).toContain(LONG_ADDR);
    setSelectedAddress(LONG_ADDR);
    expect(getSelectedAddress()).toBe(LONG_ADDR);
  });

  it("addAddress rejects duplicates (the unified modal surfaces 'Este endereço já está cadastrado')", async () => {
    const { addAddress } = await importAddresses();
    expect(addAddress(LONG_ADDR)).toBe(true);
    expect(addAddress(LONG_ADDR)).toBe(false);
  });

  it("validateLiquidAddress rejects obviously-bad strings so the Save button keeps the list clean", async () => {
    const { validateLiquidAddress } = await importValidation();
    expect(validateLiquidAddress("not a real address").valid).toBe(false);
    expect(validateLiquidAddress("").valid).toBe(false);
    // A 95-char confidential address should validate.
    expect(validateLiquidAddress(LONG_ADDR).valid).toBe(true);
  });

  it("removeAddress takes an address off the list and clears selection when it was selected", async () => {
    const { addAddress, removeAddress, getAddresses, setSelectedAddress, getSelectedAddress } = await importAddresses();
    const other = "ex1qqpzry9x8gf2tvdw0s3jn54khce6mua7lmkqn9x";
    addAddress(LONG_ADDR);
    addAddress(other);
    setSelectedAddress(LONG_ADDR);
    removeAddress(LONG_ADDR);
    expect(getAddresses()).not.toContain(LONG_ADDR);
    expect(getAddresses()).toContain(other);
    expect(getSelectedAddress()).not.toBe(LONG_ADDR);
  });
});
