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
├── icon-192.png        # App icon (192x192)
└── icon-512.png        # App icon (512x512)
```

## Screens

| Screen | Route | Description |
|--------|-------|-------------|
| Login | `#login` | Username + password authentication |
| Register | `#register` | Account creation (name, email, WhatsApp, username, password) |
| Verify | `#verify` | 6-digit email verification code |
| Home | `#home` | QR code generation (deposit) + withdrawal with toggle |
| No Address | `#no-address` | Empty state — prompts user to add first wallet address |
| Reports | `#reports` | Request deposit/withdrawal reports by date range |

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

# Serve locally (any static server works)
npx serve .
# or
python3 -m http.server 8000
```

No build step required. Open `index.html` in a browser or deploy to any static hosting.

## Testing

```bash
npm test
```

## Deployment

Deployed automatically to GitHub Pages on push to `main`. The app is served at:

**https://depixapp.com**

## Related

- **Backend**: [dadafros/depix-backend](https://github.com/dadafros/depix-backend) — Vercel serverless API
- **DePix API**: [depix.eulen.app](https://depix.eulen.app) — Underlying payment API

## License

[MIT](LICENSE)
