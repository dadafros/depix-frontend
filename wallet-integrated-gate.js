// Pure decision logic for the "Carteira Integrada" modal's CTAs.
// Extracted from script.js so the three state branches can be unit-tested
// without spinning up the DOM + wallet bundle + kill-switch client.
//
// Inputs: { walletExists, walletEnabled } — both booleans. `walletEnabled`
// accepts undefined ⇒ treated as enabled (fail-open, matches config.js).
// Output: { showAccess, showCreate, showRestore, showMaintenance,
//           disableCreate, disableRestore }
//
// Branches:
//   1. Wallet exists on this device → "Acessar minha carteira" only.
//   2. No wallet, kill-switch OFF   → "Criar" + "Restaurar", both enabled.
//   3. No wallet, kill-switch ON    → both shown but disabled + maintenance
//      notice (Variant 2: conservative — restore also installs a wallet
//      on this device, so we pause both until ops clears the switch).

export function planIntegratedWallet({ walletExists, walletEnabled } = {}) {
  const existsBool = Boolean(walletExists);
  const enabledBool = walletEnabled !== false;

  if (existsBool) {
    return Object.freeze({
      showAccess: true,
      showCreate: false,
      showRestore: false,
      showMaintenance: false,
      disableCreate: false,
      disableRestore: false
    });
  }

  if (!enabledBool) {
    return Object.freeze({
      showAccess: false,
      showCreate: true,
      showRestore: true,
      showMaintenance: true,
      disableCreate: true,
      disableRestore: true
    });
  }

  return Object.freeze({
    showAccess: false,
    showCreate: true,
    showRestore: true,
    showMaintenance: false,
    disableCreate: false,
    disableRestore: false
  });
}
