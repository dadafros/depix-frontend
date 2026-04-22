# LWK Audit — Sub-fase 0 Pre-flight

Pre-flight finding used by Sub-fase 1 (toolchain) and consumed as
baseline by Sub-fase 2 (wallet module).

## Package

- Name: `lwk_wasm`
- Registry: https://www.npmjs.com/package/lwk_wasm
- Source: https://github.com/Blockstream/lwk (monorepo — `lwk_wasm/` crate)
- Crate `lwk_wasm` in workspace depends on sibling crates `lwk_jade`,
  `lwk_signer`, `lwk_ledger`, `lwk_wollet`, `lwk_boltz`, `lwk_common`,
  `lwk_simplicity` — all pinned at `0.16.0` in the workspace we consume.

## Version

- Pinned: **`0.16.0`**
- npm published: 2026-03-23T14:57:51Z
- Prior version `0.15.0` published 2026-02-18. Cadence is roughly one
  minor per month; expect `0.17.0` in the next ~4–6 weeks.

## License

- SPDX: **`MIT OR BSD-2-Clause`** (dual-license permissive — consumer
  picks either).
- Source of truth: `lwk_wasm/Cargo.toml` on `master` and the published
  npm tarball.
- Both options are compatible with DepixApp's existing license posture
  (the frontend is private, the generated bundle ships the standard
  LWK license notice embedded as a comment — no action required on our
  side beyond preserving the notice).

## Upstream health

Signals that `0.16.0` is a reasonable pin for Sub-fase 2:

- Active project: 217 git tags, monthly minor releases, maintained by
  Blockstream.
- SideSwap (our technical reference) consumes LWK in production via the
  Rust crates on mobile (`lwk_wollet`, `lwk_signer`, `lwk_common`). They
  do not use the `lwk_wasm` binding this PR pins, but the underlying Rust
  crates — and therefore the core API surface (`Wollet`, `Signer`,
  `TxBuilder`, Esplora client) — are the same ones they exercise in
  production.
- `lwk_wollet` has a `prices` feature flag, suggesting price-lookup
  primitives live in LWK itself. We still route BRL through the
  backend proxy (see `PRICE_SOURCE.md`), because LWK does not carry a
  BRL reference — but if a future phase wants in-wallet L-BTC/USD
  display without a proxy, that feature is available.

## Features enabled in `lwk_wasm@0.16.0`

From `lwk_wasm/Cargo.toml`:

- `console_error_panic_hook` — default; WASM panics surface in browser
  console. Keep enabled for Sub-fase 2 — debuggability beats the small
  binary-size cost.
- `serial` — off by default. Disabled for browser use (would pull in
  web-sys SerialPort APIs we don't need).
- `simplicity` — off by default. Disabled; we don't use Simplicity
  contracts.
- `boltz_regtest` — off by default. Disabled; only for upstream test
  infrastructure.

## Known risks for our integration

1. **API churn on minor bumps.** `0.15 → 0.16` is not guaranteed
   source-compatible. When upgrading later, re-run the
   `wipe-restore-roundtrip.test.js` (Sub-fase 2 integration test) — it
   derives the descriptor from a fixed seed and fails loudly if LWK's
   BIP32 derivation output changes. That test is the canary, not a
   human-read changelog.
2. **WASM binary size.** ~5 MB gzipped. The service worker pre-caches
   it on install; the Sub-fase 1 fetch timeout (10s) + cache fallback
   prevents infinite spinner on slow cold starts.
3. **Esplora client coupling.** LWK's sync talks to
   `https://blockstream.info` by default; Sub-fase 1 adds this host to
   CSP `connect-src`. If Blockstream rate-limits or changes the
   API, the wallet degrades to "saldos antigos" — not "app broken".

## What this note does not cover

- Auditability of LWK's cryptographic primitives — treated as upstream,
  per the `Não fazer auditoria externa` decision in the plan. LWK uses
  `rust-bitcoin`/`rust-elements` which are the industry reference
  crates and are already audited upstream.
- Long-term version strategy. The plan pins `0.16.0` for Phase 1.
  Phase 2 / Phase 3 (SideSwap swaps, SideShift cross-chain) may force
  an upgrade; that is a decision for those phases.
