import { describe, it, expect } from "vitest";
import { planIntegratedWallet } from "../wallet-integrated-gate.js";

describe("planIntegratedWallet", () => {
  it("wallet exists → only 'Acessar' button", () => {
    const plan = planIntegratedWallet({ walletExists: true, walletEnabled: true });
    expect(plan).toEqual({
      showAccess: true,
      showCreate: false,
      showRestore: false,
      showMaintenance: false,
      disableCreate: false,
      disableRestore: false
    });
  });

  it("wallet exists + kill-switch ON → still only 'Acessar' (view-only flow works)", () => {
    const plan = planIntegratedWallet({ walletExists: true, walletEnabled: false });
    expect(plan.showAccess).toBe(true);
    expect(plan.showMaintenance).toBe(false);
    expect(plan.showCreate).toBe(false);
    expect(plan.showRestore).toBe(false);
  });

  it("no wallet + kill-switch OFF → Criar + Restaurar both enabled", () => {
    const plan = planIntegratedWallet({ walletExists: false, walletEnabled: true });
    expect(plan).toEqual({
      showAccess: false,
      showCreate: true,
      showRestore: true,
      showMaintenance: false,
      disableCreate: false,
      disableRestore: false
    });
  });

  it("no wallet + kill-switch ON → Variant 2: both shown but disabled + maintenance notice", () => {
    const plan = planIntegratedWallet({ walletExists: false, walletEnabled: false });
    expect(plan).toEqual({
      showAccess: false,
      showCreate: true,
      showRestore: true,
      showMaintenance: true,
      disableCreate: true,
      disableRestore: true
    });
  });

  it("walletEnabled undefined → treated as enabled (fail-open, matches config.js)", () => {
    const plan = planIntegratedWallet({ walletExists: false });
    expect(plan.disableCreate).toBe(false);
    expect(plan.disableRestore).toBe(false);
    expect(plan.showMaintenance).toBe(false);
  });

  it("returns a frozen object (defense against accidental mutation)", () => {
    const plan = planIntegratedWallet({ walletExists: false, walletEnabled: true });
    expect(Object.isFrozen(plan)).toBe(true);
  });
});
