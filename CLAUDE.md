# CLAUDE.md — DePix Frontend

## Project Overview

DePix is a Progressive Web App (PWA) for generating PIX QR codes (deposits) and processing Liquid-to-PIX withdrawals. It's a vanilla JavaScript SPA with zero npm runtime dependencies, hosted on GitHub Pages.

**This project is one of two repos:**
- **Frontend (this repo)**: `dadafros/depix` — Vanilla JS PWA on GitHub Pages
- **Backend**: `dadafros/depix-backend` — Vercel serverless API

**Live URL**: `https://dadafros.github.io/depix/`

## Architecture

- **Language**: Vanilla JavaScript with ES Modules (`type="module"`)
- **Styling**: Custom CSS (no framework — dark teal theme, mobile-first, responsive)
- **Routing**: Hash-based SPA router (`#login`, `#home`, `#reports`, etc.)
- **Storage**: `localStorage` for addresses and auth tokens
- **PWA**: Service Worker for offline caching + Web App Manifest for installability
- **Build step**: None. Zero bundler, zero framework, zero npm runtime dependencies.
- **Backend**: Communicates with `https://depix-backend.vercel.app` via authenticated fetch

### Design Philosophy
This project is intentionally zero-dependency and framework-free. All JS is vanilla ES modules loaded directly by the browser. This ensures fast loading, no build step, and simple deployment to any static hosting.

## File Structure

```
depix/
├── index.html          # All views as <section data-view="xxx"> + modals + toast
├── script.js           # Main entry point — imports all modules, all event handlers
├── router.js           # Hash-based SPA router (route, navigate, initRouter)
├── auth.js             # Auth state in localStorage (getToken, setAuth, clearAuth, isLoggedIn)
├── api.js              # Fetch wrapper with auto JWT refresh on 401 (apiFetch)
├── addresses.js        # Address CRUD in localStorage (add, remove, select, abbreviate)
├── style.css           # All styles — dark teal theme, responsive, animations
├── service-worker.js   # Offline cache (static assets only, never caches API calls)
├── manifest.json       # PWA manifest (name, icons, start_url, display)
├── icon-192.png        # App icon 192x192
├── icon-512.png        # App icon 512x512
├── package.json        # Dev dependencies only (vitest for testing)
└── tests/
    ├── addresses.test.js  # Tests for address management + abbreviation
    ├── auth.test.js       # Tests for auth state management
    └── router.test.js     # Tests for router module
```

## Screens / Views

Each view is a `<section data-view="name">` in index.html, shown/hidden by the router.

| Route | View | Description |
|-------|------|-------------|
| `#login` | Login | Username + password → JWT auth |
| `#register` | Register | Name, email, WhatsApp, username, password → create account |
| `#verify` | Verify Email | 6-digit code input → confirms email |
| `#home` | Home | Toggle between deposit (QR generation) and withdrawal (saque) |
| `#no-address` | Empty State | Shown when user has no addresses — prompts to add first one |
| `#reports` | Reports | Date range picker → requests PDF+CSV report via email |

### Home screen has two modes (toggle):
1. **Depósito**: Enter amount → Generate PIX QR code → Copy PIX code
2. **Saque**: Enter amount + PIX key → Get Liquid deposit address + QR code

## Key Patterns

### API communication (`api.js`):
- All calls go through `apiFetch(path, options)` which auto-attaches `Authorization: Bearer <jwt>`
- On 401 response: automatically attempts token refresh via `/api/auth/refresh`
- On refresh failure: clears auth, redirects to `#login`
- Device ID (`X-Device-Id` header) generated once, stored in localStorage

### Address management (`addresses.js`):
- Addresses stored in localStorage as JSON array (`depix-addresses`)
- Selected address stored separately (`depix-selected-address`)
- Abbreviation format: `tlq1qqv2...x3f8` (first 8 + ... + last 4 chars)
- Changing selected address requires password confirmation (calls `/api/auth/verify-password`)
- Adding addresses does NOT require password

### Routing (`router.js`):
- Hash-based: `window.location.hash` drives navigation
- `route(hash, onShowCallback)` registers handlers
- `navigate(hash)` changes location
- On hash change: hides all `section[data-view]`, shows matching one, calls handler

### Auth flow:
- Register → verify email code → login → get JWT + refresh token → stored in localStorage
- On app load: check `isLoggedIn()` → if yes, check `hasAddresses()` → route accordingly
- Logout: call `/api/auth/logout`, clear localStorage, navigate to `#login`

## Security

- **CSP**: Strict Content-Security-Policy in meta tag (no `unsafe-inline` for scripts since using `type="module"`)
- **img-src**: Only allows `self`, `data:` URIs, `*.eulen.app`, and `api.qrserver.com`
- **connect-src**: Only allows `https://depix-backend.vercel.app`
- **QR URL validation**: `isAllowedImageUrl()` validates every QR image URL against allowlist before setting `img.src`

## Commands

```bash
npm test            # Run all tests (vitest)
npm run test:watch  # Watch mode
```

## UI/UX Notes

- **Target audience**: Non-technical Brazilian users (leigos)
- **Language**: All UI text in Brazilian Portuguese
- **Theme**: Dark teal gradient (#0f3d3e → #071b1f), accent #4fd1c5
- **Typography**: system-ui, sans-serif
- **Mobile-first**: Max card width 420px, safe area insets for notch devices
- **Error messages**: Red (#ff6b6b), always user-friendly (no technical jargon)
- **Success messages**: Green (#68d391)
- **Toast notifications**: Bottom center, auto-dismiss after 2s

## Git

- Remote: `git@github-personal:dadafros/depix.git`
- SSH key alias `github-personal` maps to `~/.ssh/id_ed25519_outlook`
- Commit as: `dadafros <davi_bf@outlook.com>`
- Branch naming: `feat/*` for features, `claude/*` for Claude Code branches
- CI: GitHub Actions on push/PR to main
- Deploy: GitHub Pages from main branch
