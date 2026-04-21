// Archives the on-chain Liquid txid of an in-app withdraw broadcast so
// support can reconcile the saque row with what left the wallet. This is
// fire-and-forget: failure here NEVER blocks the user — the Liquid tx is
// already on the network, and the telemetry client logs broadcast failures
// separately (which is what pages ops anyway).
//
// The server-side contract is enforced in `api/_lib/routes/withdraw.js`:
//   - body `{ withdrawalId: string, liquidTxid: string (64 hex) }`
//   - returns 204 on success, 404 if the saque row isn't the caller's,
//     409 if liquid_txid was already set.
//
// We import `apiFetch` so the call carries the JWT + X-Device-Id and so a
// 401 triggers the same auto-refresh path as every other authenticated call.

import { apiFetch } from "../api.js";

const TXID_RE = /^[0-9a-f]{64}$/i;

export async function archiveWithdrawTxid({ withdrawalId, liquidTxid } = {}) {
  if (typeof withdrawalId !== "string" || !withdrawalId) return { ok: false, reason: "missing-withdrawal-id" };
  if (typeof liquidTxid !== "string" || !TXID_RE.test(liquidTxid)) return { ok: false, reason: "bad-txid" };
  try {
    const res = await apiFetch("/api/withdraw/txid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ withdrawalId, liquidTxid: liquidTxid.toLowerCase() })
    });
    if (res.status === 204) return { ok: true };
    return { ok: false, reason: `http-${res.status}` };
  } catch (err) {
    return { ok: false, reason: "network", error: err };
  }
}
