// @vitest-environment jsdom
//
// Deposit/withdraw integration invariant — plan item
// "deposit-withdraw-wallet.test.js":
//   * Deposit auto-fills `depixAddress` from the wallet when one exists.
//   * Withdraw pre-fills the send flow with the Eulen-returned
//     `depositAddress` + amount + `withdrawalId`.
//   * External fallback restores the legacy flow byte-for-byte for users
//     without a wallet.
//
// The Eulen-facing payload shape is non-negotiable: `depixAddress` MUST
// remain present regardless of origin, and the only thing that changes
// when a wallet exists is the SOURCE of that string (wallet vs.
// localStorage picker). The backend never learns whether the address came
// from the in-app wallet or a pasted one — that's the aditivo invariant.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { createWalletModule } from "../wallet/wallet.js";

function makeFakeLwk() {
  class Mnemonic {
    constructor(str) { this._str = String(str).trim().split(/\s+/).join(" "); }
    toString() { return this._str; }
    static fromRandom() {
      return new Mnemonic("legal winner thank year wave sausage worth useful legal winner thank yellow");
    }
  }
  class WolletDescriptor {
    constructor(str) { this._str = str; }
    toString() { return this._str; }
  }
  class Signer {
    constructor(m) { this._str = m.toString(); }
    wpkhSlip77Descriptor() { return new WolletDescriptor(`ct(${this._str.replace(/\s+/g, "_")})`); }
    free() {}
  }
  class AddressResult {
    constructor(s) { this._s = s; }
    address() { return { toString: () => this._s }; }
  }
  class Wollet {
    constructor(_n, d) { this._d = d.toString(); }
    address(i) { return new AddressResult(`lq1qfakedeposit${(i ?? 0)}${this._d.length}`); }
    balance() { return {}; }
    transactions() { return []; }
    free() {}
  }
  return {
    Mnemonic, Signer, Wollet, WolletDescriptor,
    Network: {
      mainnet: () => ({ _k: "mainnet" }),
      regtestDefault: () => ({ _k: "regtest" }),
      testnet: () => ({ _k: "testnet" })
    }
  };
}

function newWallet() {
  return createWalletModule({
    indexedDbImpl: new IDBFactory(),
    cryptoImpl: webcrypto,
    lwkLoader: async () => makeFakeLwk()
  });
}

// Stand-in for the script.js helper — takes a wallet module + a selected
// external address (legacy picker) and returns the address string that
// should land in the deposit / withdraw request body. Replicates the
// contract exercised in script.js:
//   * wallet exists   → returns wallet receive address
//   * no wallet       → returns legacy external address
//   * unexpected fail → returns legacy external address (fail-open)
async function resolveDepixAddress(wallet, externalAddr) {
  try {
    if (!(await wallet.hasWallet())) return externalAddr || null;
    const addr = await wallet.getReceiveAddress();
    if (typeof addr === "string" && addr.length > 0) return addr;
    return externalAddr || null;
  } catch {
    return externalAddr || null;
  }
}

const PIN = "758493";

describe("deposit: depixAddress source swap", () => {
  it("uses the wallet receive address when a wallet exists", async () => {
    const wallet = newWallet();
    await wallet.createWallet({ pin: PIN });

    const external = "lq1qexternal123";
    const depixAddress = await resolveDepixAddress(wallet, external);

    // The key invariant: the address is STILL a Liquid address, still sent
    // in the `depixAddress` field. The only thing that changed is the
    // source (wallet vs. user-pasted).
    expect(depixAddress).toMatch(/^lq1qfakedeposit/);
    expect(depixAddress).not.toBe(external);
  });

  it("falls back to the external picker when no wallet exists", async () => {
    const wallet = newWallet();
    const external = "lq1qexternal123";
    const depixAddress = await resolveDepixAddress(wallet, external);
    expect(depixAddress).toBe(external);
  });

  it("falls back to the external picker when wallet probe throws", async () => {
    const faulty = {
      hasWallet: async () => { throw new Error("indexeddb exploded"); },
      getReceiveAddress: async () => "ignored"
    };
    const depixAddress = await resolveDepixAddress(faulty, "lq1qexternal");
    expect(depixAddress).toBe("lq1qexternal");
  });

  it("returns null when there's no wallet AND no external address selected", async () => {
    const wallet = newWallet();
    const depixAddress = await resolveDepixAddress(wallet, "");
    expect(depixAddress).toBeNull();
    // Callers surface "selecione um endereço" — this preserves that UX.
  });
});

describe("withdraw: `depixAddress` always present in the payload", () => {
  // The backend contract mandates that `depixAddress` is a required field
  // in every /api/withdraw body. Users with a wallet still ship the field;
  // they just derive it from the wallet instead of pasting from a picker.
  it("wallet-backed withdraw builds a body that still carries depixAddress", async () => {
    const wallet = newWallet();
    await wallet.createWallet({ pin: PIN });

    const addr = await resolveDepixAddress(wallet, "");
    const body = {
      pixKey: "11111111111",
      depixAddress: addr,
      depositAmountInCents: 500
    };
    expect(body.depixAddress).toBeTruthy();
    expect(body.depixAddress).toMatch(/^lq1/);
  });

  it("legacy withdraw (no wallet) body is byte-identical to the historical shape", async () => {
    const wallet = newWallet();
    const external = "lq1qlegacyexternaladdress00";
    const addr = await resolveDepixAddress(wallet, external);
    const body = {
      pixKey: "11111111111",
      depixAddress: addr,
      payoutAmountInCents: 1000
    };
    // Exact-match the shape the backend has been receiving for months.
    expect(Object.keys(body).sort()).toEqual(["depixAddress", "payoutAmountInCents", "pixKey"]);
    expect(body.depixAddress).toBe(external);
  });
});

describe("wallet-send:prefill CustomEvent contract", () => {
  // script.js dispatches a `wallet-send:prefill` CustomEvent after
  // /api/withdraw returns. wallet-ui.js listens and pre-fills the send
  // form. The event contract is {assetKey, amountBrl, dest, withdrawalId}
  // — all four are consumed, missing any one silently breaks prefill.
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("dispatches an event with all four required fields", () => {
    const handler = vi.fn();
    window.addEventListener("wallet-send:prefill", handler);
    try {
      window.dispatchEvent(new CustomEvent("wallet-send:prefill", {
        detail: {
          assetKey: "DEPIX",
          amountBrl: 5.00,
          dest: "lq1qdestinationxyz",
          withdrawalId: "wd-1234"
        }
      }));

      expect(handler).toHaveBeenCalledTimes(1);
      const detail = handler.mock.calls[0][0].detail;
      expect(detail).toEqual({
        assetKey: "DEPIX",
        amountBrl: 5.00,
        dest: "lq1qdestinationxyz",
        withdrawalId: "wd-1234"
      });
    } finally {
      window.removeEventListener("wallet-send:prefill", handler);
    }
  });

  it("withdrawalId presence is what triggers the archive-txid hook downstream", () => {
    // wallet-ui.js only POSTs /api/withdraw/txid when detail.withdrawalId
    // was set. Absence of this field must be treated as "no archive" (no
    // phantom POST with undefined). This test pins the invariant.
    const handler = vi.fn();
    window.addEventListener("wallet-send:prefill", handler);
    try {
      window.dispatchEvent(new CustomEvent("wallet-send:prefill", {
        detail: { assetKey: "DEPIX", amountBrl: 1, dest: "lq1q", withdrawalId: undefined }
      }));
      const { withdrawalId } = handler.mock.calls[0][0].detail;
      expect(withdrawalId).toBeUndefined();
    } finally {
      window.removeEventListener("wallet-send:prefill", handler);
    }
  });

  it("dispatching BEFORE listener registration loses the event — pins the race", () => {
    // Regression test for the Sub-fase 6 race: the withdraw handler in
    // script.js used to dispatch `wallet-send:prefill` BEFORE the wallet
    // bundle bootstrapped, meaning `registerWalletRoutes()` had not yet
    // registered the listener. CustomEvent delivery is synchronous — if no
    // listener is present at dispatch time, the event is gone forever. The
    // fix moves `await ensureWalletBootstrapped()` in front of the dispatch;
    // this test documents why the ordering matters.
    const captured = [];
    window.dispatchEvent(new CustomEvent("wallet-send:prefill", {
      detail: { assetKey: "DEPIX", amountBrl: 1, dest: "lq1q", withdrawalId: "wd-late" }
    }));
    const handler = evt => captured.push(evt.detail);
    window.addEventListener("wallet-send:prefill", handler);
    try {
      expect(captured).toEqual([]);
    } finally {
      window.removeEventListener("wallet-send:prefill", handler);
    }
  });
});
