# DePix

[![CI](https://github.com/dadafros/depix/actions/workflows/ci.yml/badge.svg)](https://github.com/dadafros/depix/actions/workflows/ci.yml)
[![GitHub Pages](https://img.shields.io/badge/deploy-GitHub%20Pages-blue?logo=github)](https://depixapp.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa)](https://depixapp.com)

Progressive Web App for generating PIX QR codes and processing withdrawals via the [Liquid Network](https://liquid.net).

<p align="center">
  <img src="icon-512.png" alt="DePix" width="128" />
</p>

## Features

- **PIX Deposits** — Generate QR codes for receiving BRL payments
- **Liquid Withdrawals** — Convert Liquid assets to PIX with real-time quotes
- **User Accounts** — Registration with email verification, JWT authentication
- **Address Management** — Save multiple Liquid wallet addresses locally
- **Transaction Reports** — Request deposit/withdrawal reports delivered via email (PDF + CSV)
- **Área do Lojista** — Unlocked after ≥10 deposits + CNPJ verification: create charges, products, view sales, manage API keys and webhook logs
- **PWA** — Installable on mobile and desktop, works offline
- **Zero build step** — Pure vanilla JavaScript with ES modules

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | Vanilla JavaScript (ES modules) |
| Styling | Custom CSS (no framework) |
| Routing | Hash-based SPA router |
| Storage | `localStorage` (addresses, auth tokens) |
| API | Fetch wrapper with auto JWT refresh |
| PWA | Service Worker + Web App Manifest |
| Hosting | GitHub Pages |
| Backend | [depix-backend](https://github.com/dadafros/depix-backend) (Vercel) |

> **Zero npm dependencies.** No bundler, no framework, no build step.

## Project Structure

```
depix/
├── index.html          # All views (login, register, home, reports, modals)
├── script.js           # Main entry point — all view logic and event handlers
├── router.js           # Hash-based SPA router (#login, #home, #reports, etc.)
├── auth.js             # Auth state (JWT tokens in localStorage)
├── api.js              # Fetch wrapper with Authorization header + auto-refresh
├── addresses.js        # Address CRUD in localStorage + abbreviation
├── style.css           # All styles (dark teal theme, responsive, mobile-first)
├── service-worker.js   # Offline caching for static assets
├── manifest.json       # PWA manifest
├── sitemap.xml         # Sitemap with hreflang annotations
├── docs/               # API documentation (pt-BR + en)
│   ├── index.html      # Portuguese (default)
│   └── en/index.html   # English
├── btcpay/             # BTCPay Server plugin page (pt-BR + en)
│   ├── index.html      # Portuguese (default)
│   └── en/index.html   # English
├── icon-192.png        # App icon (192x192)
└── icon-512.png        # App icon (512x512)
```

## Screens

| Screen | Route | Description |
|--------|-------|-------------|
| Landing | `#landing` | Marketing page for logged-out visitors |
| Login | `#login` | Username + password authentication |
| Register | `#register` | Account creation (name, email, WhatsApp, username, password) |
| Verify | `#verify` | 6-digit email verification code |
| Forgot / Reset Password | `#forgot-password`, `#reset-password` | Request + apply password reset |
| Home | `#home` | QR code generation (deposit) + withdrawal with toggle |
| No Address | `#no-address` | Empty state — prompts user to add first wallet address |
| Transactions | `#transactions` | Transaction list + PDF/CSV report by date range |
| Affiliates / Commissions | `#affiliates`, `#commissions` | Referral link, referred-user list, commission balance |
| FAQ | `#faq` | Static help content |
| **Área do Lojista** | | Unlocked after ≥10 deposits + CNPJ verification |
| Verify Account | `#verify-account` | CNPJ + website gate into merchant area |
| Merchant dispatcher | `#merchant` | Routes to the right merchant sub-view |
| Criar Cobrança | `#merchant-charge` | Create on-demand checkout |
| Minhas Vendas | `#merchant-sales` | Checkout list with status filters + polling |
| Conta / Split | `#merchant-account` | Merchant profile, split address, commission |
| API Keys | `#merchant-api` | Create / list / revoke sk_live_ + sk_test_ keys |
| Produtos | `#merchant-products` (+ create/edit) | Product catalog management |
| Webhook Logs | `#webhook-logs` | Delivery attempts with payload inspector |

## Security

- **CSP**: Strict Content Security Policy via meta tag (no `unsafe-inline` for scripts)
- **Auth**: JWT access tokens (1h) + refresh tokens (30d) with auto-rotation
- **QR validation**: Image URLs validated against domain allowlist
- **Address changes**: Require password confirmation
- **Device ID**: Unique per-device UUID for rate limiting

## Setup

```bash
# Clone
git clone git@github.com:dadafros/depix.git
cd depix

# Install dev deps + build the wallet bundle once (required for the wallet
# feature; the rest of the app still runs without it).
npm ci
npm run build

# Serve locally (any static server works)
npx serve .
# or
python3 -m http.server 8000
```

**Build step — scoped to the wallet bundle only.** Everything under `wallet/`
is bundled to `dist/wallet-bundle-<hash>.js` via esbuild. The rest of the app
(`script.js`, `style.css`, icons) is served as-is with no build. If you only
touch the legacy files, you don't need to re-run `npm run build` locally —
CI rebuilds on every push to `main`.

## Testing

```bash
npx --yes eslint@9 .
npm test
```

## Deployment

Deployed automatically to GitHub Pages on push to `main`. The app is served at:

**https://depixapp.com**

## Static Pages

The repo includes standalone HTML pages (no framework, no build step) for documentation and the BTCPay plugin landing page. Each page exists in **Portuguese (default)** and **English**.

| Page | Portuguese | English |
|------|-----------|---------|
| API Docs | [`/docs`](https://depixapp.com/docs) | [`/docs/en`](https://depixapp.com/docs/en) |
| BTCPay Plugin | [`/btcpay`](https://depixapp.com/btcpay) | [`/btcpay/en`](https://depixapp.com/btcpay/en) |

### File structure

```
docs/
├── index.html        # Portuguese (default)
└── en/index.html     # English
btcpay/
├── index.html        # Portuguese (default)
└── en/index.html     # English
```

### Editing guidelines

- **Content parity**: PT-BR and EN versions must have identical content. Always update both when making changes.
- **Accentuation**: Portuguese text must have correct accents (é, ã, ç, í, etc.). Unaccented Portuguese is treated as a bug.
- **SEO**: Each page includes OG tags, Twitter Card tags, JSON-LD structured data, hreflang tags, and canonical URLs. Update all meta tags when changing page content.
- **Sitemap**: Listed in `sitemap.xml` with `xhtml:link` hreflang annotations.
- **CSS**: Duplicated per page intentionally — each page is fully standalone.
- **Icon paths**: Root pages use `../icon-192.png`, `/en/` pages use `../../icon-192.png`.

## Related

- **Backend**: [dadafros/depix-backend](https://github.com/dadafros/depix-backend) — Vercel serverless API
- **DePix API**: [depix.eulen.app](https://depix.eulen.app) — Underlying payment API

## License

[LICENSE](LICENSE)
