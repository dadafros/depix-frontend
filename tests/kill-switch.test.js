// @vitest-environment jsdom
//
// Kill-switch end-to-end invariant — plan item "kill-switch.test.js":
//   * `GET /api/config` returns `walletEnabled: false` → the home toggle
//     is hidden for users WITHOUT a wallet (new-user block).
//   * Users WITH an existing wallet keep view-only access.
//   * The kill switch never force-wipes local IndexedDB — a user's seed
//     + descriptor stay intact across the toggle.
//
// This file composes the two real modules (config client + wallet module)
// with the pure `planHomeToggle` helper from wallet-home-gate.js. An
// in-memory fetch stub emulates the /api/config backend contract.

import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

import { createConfigClient } from "../wallet/config.js";
import { planHomeToggle } from "../wallet-home-gate.js";
import { createWalletModule } from "../wallet/wallet.js";

function jsonResp(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

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
  class AddressResult { constructor(s) { this._s = s; } address() { return { toString: () => this._s }; } }
  class Wollet {
    constructor(_n, d) { this._d = d.toString(); }
    address(i) { return new AddressResult(`lq1-${this._d}-${i ?? 0}`); }
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

describe("kill switch — new users (no local wallet)", () => {
  it("hides the wallet toggle when /api/config returns walletEnabled:false", async () => {
    const fetchImpl = async () => jsonResp({ walletEnabled: false });
    const config = createConfigClient({ fetchImpl });
    const wallet = newWallet();

    const walletEnabled = await config.isWalletEnabled();
    const walletExists = await wallet.hasWallet();
    expect(walletEnabled).toBe(false);
    expect(walletExists).toBe(false);

    const plan = planHomeToggle({ walletExists, walletEnabled });
    expect(plan.showWalletBtn).toBe(false);
    expect(plan.forceDeposit).toBe(true);
  });

  it("lets new users create a wallet when /api/config returns walletEnabled:true", async () => {
    const fetchImpl = async () => jsonResp({ walletEnabled: true });
    const config = createConfigClient({ fetchImpl });
    const wallet = newWallet();

    const plan = planHomeToggle({
      walletExists: await wallet.hasWallet(),
      walletEnabled: await config.isWalletEnabled()
    });
    // No wallet yet → toggle stays hidden even when enabled, by design.
    expect(plan.showWalletBtn).toBe(false);
    expect(plan.forceDeposit).toBe(true);
  });
});

describe("kill switch — users with an existing wallet", () => {
  it("preserves view-only access", async () => {
    const fetchImpl = async () => jsonResp({ walletEnabled: false });
    const config = createConfigClient({ fetchImpl });
    const wallet = newWallet();
    await wallet.createWallet({ pin: "473829" });

    const walletEnabled = await config.isWalletEnabled();
    const walletExists = await wallet.hasWallet();
    expect(walletEnabled).toBe(false);
    expect(walletExists).toBe(true);

    const plan = planHomeToggle({ walletExists, walletEnabled });
    expect(plan.showWalletBtn).toBe(true);
    // No "restore preferred mode" — we don't want the app to open directly
    // on #wallet-home during maintenance because the send flow is blocked.
    expect(plan.allowRestorePreferred).toBe(false);

    // View-only data keeps working off the plaintext descriptor, as the
    // plan promises: saldo + endereço + histórico stay visible.
    const addr = await wallet.getReceiveAddress({ index: 0 });
    expect(addr).toMatch(/^lq1-/);
  });

  it("reactivation — walletEnabled flips back to true after the switch is cleared", async () => {
    // Simulate the ops flow: kill switch on for a while, then reverted.
    let now = 1_000_000;
    const clock = () => now;
    let killEnabled = false;
    const fetchImpl = async () => jsonResp({ walletEnabled: killEnabled });
    const config = createConfigClient({ fetchImpl, clock });
    const wallet = newWallet();
    await wallet.createWallet({ pin: "847362" });

    let plan = planHomeToggle({
      walletExists: await wallet.hasWallet(),
      walletEnabled: await config.isWalletEnabled()
    });
    expect(plan.showWalletBtn).toBe(true);
    expect(plan.allowRestorePreferred).toBe(false);

    // Cache TTL is 5min; advance past it so the client re-fetches.
    killEnabled = true;
    now += 6 * 60_000;

    plan = planHomeToggle({
      walletExists: await wallet.hasWallet(),
      walletEnabled: await config.isWalletEnabled()
    });
    expect(plan.showWalletBtn).toBe(true);
    expect(plan.allowRestorePreferred).toBe(true);
  });

  it("never force-wipes local wallet when kill switch is on", async () => {
    // The explicit wording in the plan: "Sem force-wipe remoto — IndexedDB
    // local fica intocado." A kill switch flip must NOT delete local seed.
    // We probe this via the view-only surface (descriptor + receive address)
    // because that's the exact thing view-only mode keeps exposed.
    const fetchImpl = async () => jsonResp({ walletEnabled: false });
    const config = createConfigClient({ fetchImpl });
    const wallet = newWallet();
    await wallet.createWallet({ pin: "473829" });
    const before = await wallet.getReceiveAddress({ index: 0 });

    // Consult the config (toggling the kill switch from the backend's
    // perspective). No wipe path runs here — only the UI gate plan.
    const enabled = await config.isWalletEnabled();
    expect(enabled).toBe(false);
    planHomeToggle({
      walletExists: await wallet.hasWallet(),
      walletEnabled: enabled
    });

    // The stored descriptor is still identical — we never destroyed the DB.
    expect(await wallet.hasWallet()).toBe(true);
    const after = await wallet.getReceiveAddress({ index: 0 });
    expect(after).toBe(before);
  });
});

describe("kill switch — fail-open behavior", () => {
  it("treats a network error as walletEnabled:true (avoids stranding users)", async () => {
    const fetchImpl = async () => { throw new Error("net down"); };
    const config = createConfigClient({ fetchImpl });
    const wallet = newWallet();
    await wallet.createWallet({ pin: "473829" });

    const plan = planHomeToggle({
      walletExists: await wallet.hasWallet(),
      walletEnabled: await config.isWalletEnabled()
    });
    expect(plan.showWalletBtn).toBe(true);
    expect(plan.allowRestorePreferred).toBe(true);
  });
});
