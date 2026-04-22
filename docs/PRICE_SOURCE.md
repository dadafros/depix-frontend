# Price Source — Sub-fase 0 Pre-flight

Pre-flight finding used by Sub-fase 4 (Home "Minha Carteira" — quotes).

## What SideSwap does today

`sideswap-io/sideswap_rust` (the technical reference declared in
`PLANO-FASE-1-WALLET.md`) pulls live quotes from **Bitfinex via WebSocket**.

Evidence (public, as of 2026-04-21):

- Directory: `sideswap_dealer_bitfinex/` (Cargo.toml, src/, config/).
- Pairs subscribed (`BfxExchangePair::bfx_bookname()`):
  - `tBTCUST` — BTC/USDT
  - `tBTCEUR` — BTC/EUR
  - `tEURUST` — EUR/USDT
- Transport: Bitfinex WebSocket API (not REST). Order-book updates drive
  bid/ask — SideSwap uses mid-price for display.
- Dependencies include `tokio-tungstenite` and `tungstenite` (WebSocket)
  plus `reqwest` (fallback HTTP).

**Key observation:** Bitfinex does not carry a BTC/BRL or USD/BRL pair.
SideSwap does not display BRL natively — they feed BTC in USD and let the
Brazilian user mentally convert. For DepixApp we need BRL, so the DepixApp
price proxy cannot be a direct copy of SideSwap's setup.

## Decision for DepixApp `/api/quotes`

The wallet UI needs `{ btcUsd, usdBrl, timestamp }`. We build these from
two independent sources, cached 30s in the backend (store chosen in `depix-backend`):

### `btcUsd`

- Source: **Bitfinex REST** (not WebSocket — REST is cheaper for a 30s-cached
  backend endpoint, no persistent connection).
- Endpoint: `GET https://api-pub.bitfinex.com/v2/ticker/tBTCUSD`
- Response shape: `[bid, bid_size, ask, ask_size, daily_change, daily_change_relative, last_price, ...]`.
  Use index 6 (`last_price`) for display.
- Why not `tBTCUST` (USDT)? For a 30s-cached public ticker, USD and USDT
  track each other within 0.1% and the USD endpoint avoids the USDT
  peg-risk footnote. Both are available; keep this as a revisit point if
  USD/USDT ever diverge meaningfully.

### `usdBrl`

- Source: **awesomeapi** (hosted in Brazil, free, no key required, stable
  for this exact use-case — many Brazilian fintechs use it).
- Endpoint: `GET https://economia.awesomeapi.com.br/last/USD-BRL`
- Response shape: `{ USDBRL: { ... "bid": "5.12", "ask": "5.14", "timestamp": "..." } }`.
  Use `bid` for display (consumer-friendly rate).
- Fallback: if awesomeapi is unavailable twice in a row, reuse last cached
  value up to 5 minutes old. Beyond that, the frontend shows "cotação
  indisponível" in the wallet home header but saldo amounts remain
  visible.

### Derived values

Frontend computes:
- `USDt/BRL ≈ usdBrl` (1 USD ≈ 1 USDt for our UI purposes).
- `DePix/BRL ≈ 1` (always).
- `L-BTC/BRL = btcUsd × usdBrl`.

## CSP impact

The frontend never talks to Bitfinex or awesomeapi directly. All quote
traffic hits `https://depix-backend.vercel.app/api/quotes`, which is
already covered by the existing `connect-src 'self' https://depix-backend.vercel.app ...`.

No CSP change is needed for quotes. (CSP does still change in Sub-fase 1
to add `'wasm-unsafe-eval'` and `https://blockstream.info` for the Liquid
explorer used by LWK — that is unrelated to price.)

## If SideSwap's source changes

Re-run this pre-flight before any wallet change that touches quotes.
Tripwire: if `sideswap_dealer_bitfinex/` is renamed or replaced in the
SideSwap repo, investigate what they migrated to and reconsider whether
our pairs (`tBTCUSD` + `USD-BRL`) still match their approach.

## What this note does not cover

- Historical candles (fase 1 shows only spot). If we ever add charts,
  pick a source then — Bitfinex REST supports candles, awesomeapi does
  not.
- Order-book depth (Sub-fase 5 builds tx against LWK, which signs
  off-chain — no book depth required).
- Commercial rate limits. Both sources are free tier and our 30s cache
  keeps us well under any observed rate limits for a single Vercel
  deployment.
