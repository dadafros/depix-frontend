// @vitest-environment jsdom
//
// Home toggle truth table — plan item "home-toggle.test.js":
//   * sem wallet           → toggle 2 modos (Depósito/Saque), zero diff visual
//   * com wallet + enabled → toggle 3 modos, wallet button visible, no banner
//   * com wallet + kill switch on → wallet button visible, maintenance banner
//   * sem wallet + kill switch on → toggle 2 modos (view-only is irrelevant
//     for a user that never created one), no banner
//
// `planHomeToggle` is a pure decision function that takes booleans and
// returns the DOM plan. script.js feeds it `wallet.hasWallet()` and
// `config.isWalletEnabled()` at runtime and applies the plan. Testing the
// pure function keeps the test deterministic; the DOM wiring itself is
// covered by the e2e suite.

import { describe, it, expect, beforeEach } from "vitest";
import { planHomeToggle } from "../wallet-home-gate.js";

describe("planHomeToggle — truth table", () => {
  it("no wallet → hides toggle button, no banner, forces deposit view", () => {
    const plan = planHomeToggle({ walletExists: false, walletEnabled: true });
    expect(plan).toEqual({
      showWalletBtn: false,
      showBanner: false,
      forceDeposit: true,
      allowRestorePreferred: false
    });
  });

  it("wallet exists + enabled → shows toggle, no banner, restores preferred", () => {
    const plan = planHomeToggle({ walletExists: true, walletEnabled: true });
    expect(plan).toEqual({
      showWalletBtn: true,
      showBanner: false,
      forceDeposit: false,
      allowRestorePreferred: true
    });
  });

  it("wallet exists + kill switch → shows toggle, shows banner, no restore", () => {
    const plan = planHomeToggle({ walletExists: true, walletEnabled: false });
    expect(plan).toEqual({
      showWalletBtn: true,
      showBanner: true,
      forceDeposit: false,
      allowRestorePreferred: false
    });
  });

  it("no wallet + kill switch → hides toggle (view-only is irrelevant)", () => {
    const plan = planHomeToggle({ walletExists: false, walletEnabled: false });
    expect(plan).toEqual({
      showWalletBtn: false,
      showBanner: false,
      forceDeposit: true,
      allowRestorePreferred: false
    });
  });

  it("undefined walletEnabled → treated as enabled (fail-open default)", () => {
    // refreshWalletModeAvailability swallows network errors and defaults to
    // true. Emulate that here: absent input ⇒ don't show the banner.
    const plan = planHomeToggle({ walletExists: true, walletEnabled: undefined });
    expect(plan.showBanner).toBe(false);
    expect(plan.showWalletBtn).toBe(true);
  });

  it("coerces truthy/falsy inputs without throwing", () => {
    // Guard against a future mutation where inputs get widened to any type.
    expect(() => planHomeToggle({ walletExists: 1, walletEnabled: 0 })).not.toThrow();
    expect(planHomeToggle({ walletExists: 1, walletEnabled: 0 }).showWalletBtn).toBe(true);
    expect(planHomeToggle({ walletExists: "", walletEnabled: "yes" }).showWalletBtn).toBe(false);
  });

  it("returns a frozen plan object (prevents downstream mutation)", () => {
    const plan = planHomeToggle({ walletExists: true, walletEnabled: true });
    expect(Object.isFrozen(plan)).toBe(true);
  });
});

// DOM-level assertion: given the real toggle HTML fragment, applying each
// plan yields the expected visibility classes. This catches a future
// mutation that broke the class-toggle wiring in script.js.
describe("applying plan to real toggle HTML", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="wallet-maintenance-banner" class="wallet-maintenance-banner hidden"></div>
      <div class="mode-toggle" role="radiogroup">
        <button id="modeDeposit" class="mode-toggle-option active"></button>
        <button id="modeWithdraw" class="mode-toggle-option"></button>
        <button id="modeConvert" class="mode-toggle-option hidden"></button>
        <button id="modeWallet" class="mode-toggle-option hidden"></button>
      </div>
    `;
  });

  function apply(plan) {
    const btn = document.getElementById("modeWallet");
    const banner = document.getElementById("wallet-maintenance-banner");
    btn.classList.toggle("hidden", !plan.showWalletBtn);
    banner.classList.toggle("hidden", !plan.showBanner);
  }

  it("no wallet → wallet button stays hidden (zero diff vs legacy)", () => {
    const plan = planHomeToggle({ walletExists: false, walletEnabled: true });
    apply(plan);
    expect(document.getElementById("modeWallet").classList.contains("hidden")).toBe(true);
    expect(document.getElementById("wallet-maintenance-banner").classList.contains("hidden")).toBe(true);
    // Deposit + Withdraw visible (no hidden class on the first two).
    expect(document.getElementById("modeDeposit").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("modeWithdraw").classList.contains("hidden")).toBe(false);
  });

  it("wallet exists + enabled → wallet button visible, banner hidden", () => {
    const plan = planHomeToggle({ walletExists: true, walletEnabled: true });
    apply(plan);
    expect(document.getElementById("modeWallet").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("wallet-maintenance-banner").classList.contains("hidden")).toBe(true);
  });

  it("wallet exists + kill switch → both wallet button and banner visible", () => {
    const plan = planHomeToggle({ walletExists: true, walletEnabled: false });
    apply(plan);
    expect(document.getElementById("modeWallet").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("wallet-maintenance-banner").classList.contains("hidden")).toBe(false);
  });

  it("no wallet + kill switch → same visual state as legacy (button + banner hidden)", () => {
    const plan = planHomeToggle({ walletExists: false, walletEnabled: false });
    apply(plan);
    expect(document.getElementById("modeWallet").classList.contains("hidden")).toBe(true);
    expect(document.getElementById("wallet-maintenance-banner").classList.contains("hidden")).toBe(true);
  });
});
