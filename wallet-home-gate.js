// Pure decision logic for the home "Minha Carteira" toggle button and the
// kill-switch maintenance banner. Extracted from script.js so the truth
// table can be unit-tested without spinning up a full DOM + router + wallet
// bundle. script.js reads this plan and applies the DOM changes; tests
// exercise the plan directly.
//
// Inputs: { walletExists, walletEnabled } — both booleans.
// Output: { showWalletBtn, showBanner, forceDeposit, allowRestorePreferred }.
//
// Invariants:
//   * A user with no wallet never sees the wallet toggle, regardless of
//     kill-switch state — zero visual diff from the legacy 2-mode layout.
//   * The maintenance banner appears only when kill switch is ON *and* the
//     user already has a wallet (view-only is useful; create-wallet is not).
//   * When the wallet toggle is hidden, we also force-switch away from
//     #wallet-home so a user mid-scroll on Minha Carteira doesn't get
//     stranded on a hidden view.
//   * Restoring a previously selected mode ("depix-home-mode=wallet") only
//     makes sense when both the wallet exists AND the toggle is available.

export function planHomeToggle({ walletExists, walletEnabled }) {
  const existsBool = Boolean(walletExists);
  const enabledBool = walletEnabled !== false; // undefined ⇒ enabled (fail-open)

  if (!existsBool) {
    return Object.freeze({
      showWalletBtn: false,
      showBanner: false,
      forceDeposit: true,
      allowRestorePreferred: false
    });
  }

  if (!enabledBool) {
    return Object.freeze({
      showWalletBtn: true,
      showBanner: true,
      forceDeposit: false,
      allowRestorePreferred: false
    });
  }

  return Object.freeze({
    showWalletBtn: true,
    showBanner: false,
    forceDeposit: false,
    allowRestorePreferred: true
  });
}
