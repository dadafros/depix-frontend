# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## DePix Frontend

## Project Overview

DePix is a Progressive Web App (PWA) for generating PIX QR codes (deposits) and processing Liquid-to-PIX withdrawals. It's a vanilla JavaScript SPA with zero npm runtime dependencies, hosted on GitHub Pages.

**This project is one of two repos:**
- **Frontend (this repo)**: `dadafros/depix-frontend` — Vanilla JS PWA on GitHub Pages
- **Backend**: `dadafros/depix-backend` — Vercel serverless API

**Live URL**: `https://depixapp.com`

## Code Language

All new code must be written in English — variable names, function names, table/column names, comments, error messages. Existing Portuguese names (e.g., `criado_em`, `valor_centavos`) are not renamed (breaking change), but all new additions must use English.

## Architecture

- **Language**: Vanilla JavaScript with ES Modules (`type="module"`)
- **Styling**: Custom CSS (no framework — dark teal theme, mobile-first, responsive)
- **Routing**: Hash-based SPA router (`#login`, `#home`, `#reports`, etc.)
- **Storage**: `localStorage` for addresses and auth tokens; IndexedDB for wallet (Phase 1)
- **PWA**: Service Worker for offline caching + Web App Manifest for installability
- **Build step**: Scoped to `wallet/` only. esbuild bundles `wallet/entry.js` to `dist/wallet-bundle-<hash>.js` + copies the LWK WASM binary with a hashed filename. All other files (`script.js`, `utils.js`, `style.css`, icons) are served directly with no build. CI runs `npm run build` before deploying to Pages; `dist/` is not committed to `main`.
- **Backend**: Communicates with `https://depix-backend.vercel.app` via authenticated fetch

### Design Philosophy
Legacy surface stays zero-dependency and framework-free — vanilla ES modules loaded directly by the browser. The wallet bundle is the single exception: LWK WASM cannot ship unbundled, so esbuild is scoped strictly to `wallet/` and its output is content-hashed (no `?v=` tracking needed for wallet assets; each build rotates the filename).

### Module Dependency Flow
`script.js` is the single entry point imported by `index.html`. It imports everything else:
- `router.js`, `auth.js`, `api.js`, `addresses.js` — core modules (no cross-dependencies except `api.js` → `auth.js`)
- `utils.js`, `validation.js` — pure functions, no side effects, no DOM access
- `script-helpers.js` — DOM helpers extracted for testability (depends on DOM but not other modules)

## File Structure

```
depix/
├── index.html          # All views as <section data-view="xxx"> + modals + toast
├── script.js           # Main entry point — imports all modules, event handlers, app state
├── script-helpers.js   # DOM helpers extracted from script.js (showToast, setMsg, goToAppropriateScreen)
├── router.js           # Hash-based SPA router (route, navigate, initRouter)
├── auth.js             # Auth state in localStorage (getToken, setAuth, clearAuth, isLoggedIn)
├── api.js              # Fetch wrapper with auto JWT refresh on 401 (apiFetch)
├── addresses.js        # Address CRUD in localStorage (add, remove, select, abbreviate)
├── affiliates.js       # Referral link rendering + commission balance view
├── image-resize.js     # Client-side logo/product image downscale before R2 upload
├── qr.js               # QR rendering helper used by deposit and checkout views
├── utils.js            # Pure utilities (isAllowedImageUrl, toCents, formatBRL)
├── validation.js       # Input validators (validateLiquidAddress, validatePhone)
├── style.css           # All styles — dark teal theme, responsive, animations
├── service-worker.js   # PWA cache: network-first HTML, cache-first versioned assets, auto-reload on update
├── manifest.json       # PWA manifest (name, icons, start_url, display)
├── package.json        # Dev dependencies only (vitest + jsdom for testing)
├── docs/               # API documentation (static HTML, pt-BR + en)
│   ├── index.html      # Portuguese version (default)
│   └── en/index.html   # English version
├── btcpay/             # BTCPay Server plugin page (static HTML, pt-BR + en)
│   ├── index.html      # Portuguese version (default)
│   └── en/index.html   # English version
└── tests/              # Vitest tests with jsdom environment
    ├── addresses.test.js
    ├── api.test.js
    ├── auth.test.js
    ├── integration.test.js
    ├── router.test.js
    ├── script-helpers.test.js
    ├── transactions.test.js
    ├── utils.test.js
    └── validation.test.js
```

## Screens / Views

Each view is a `<section data-view="name">` in index.html, shown/hidden by the router.

| Route | View | Description |
|-------|------|-------------|
| `#landing` | Landing | Marketing page (shown to logged-out visitors on `/`) |
| `#login` | Login | Username + password → JWT auth |
| `#register` | Register | Name, email, WhatsApp, username, password → create account |
| `#verify` | Verify Email | 6-digit code input → confirms email |
| `#forgot-password` | Forgot Password | Email entry → request reset code |
| `#reset-password` | Reset Password | 6-digit code + new password |
| `#home` | Home | Toggle between deposit (QR generation) and withdrawal (saque) |
| `#no-address` | Empty State | Shown when user has no addresses — prompts to add first one |
| `#transactions` | Transactions | Date range → transaction list + PDF/CSV report via email |
| `#affiliates` | Affiliates | Referral link + referred-user list |
| `#commissions` | Commissions | Affiliate commission balance + withdrawal request |
| `#faq` | FAQ | Static help/FAQ content |
| **Área do Lojista** (unlocked via ≥10 deposits + verification) | | |
| `#verify-account` | Verify Account | CNPJ + website entry → gate into merchant area |
| `#merchant` | Merchant Dispatcher | Routes to setup / charge / sales depending on state |
| `#merchant-charge` | Criar Cobrança | Create on-demand checkout (amount + description) |
| `#merchant-sales` | Minhas Vendas | List of checkouts with status + filters + polling |
| `#merchant-account` | Conta / Split | Merchant profile, split address, commission rate |
| `#merchant-api` | API Keys | Create/list/revoke sk_live_ / sk_test_ keys |
| `#merchant-products` | Produtos | List of products with activate/deactivate |
| `#merchant-product-create` | Criar Produto | New product form (name, price, image) |
| `#merchant-product-edit` | Editar Produto | Edit existing product |
| `#webhook-logs` | Webhook Logs | Delivery attempts with status + payload inspector |

### Home screen has two modes (toggle):
1. **Depósito**: Enter amount → Generate PIX QR code → Copy PIX code
2. **Saque**: Enter amount + PIX key → Get Liquid deposit address + QR code

### Área do Lojista (merchant area):
- Gated by `merchantGuard(...)` — redirects to `#verify-account` if the user has no active merchant profile.
- State machine: novo/unverified → `#verify-account` → setup pending → `#merchant` dispatcher routes to the right child view.
- Product endpoints and checkout API calls from the dashboard use the user's JWT (the `jwt-or-api` backend auth path). API keys (`sk_live_` / `sk_test_`) are for external integrations.
- Sales polling: `#merchant-sales` polls `/api/checkouts` every ~10s while visible; `stopSalesPolling()` is called on navigation away (see `script.js` route table).

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
npx --yes eslint@9 .               # Run lint checks
npm test                           # Run all tests (vitest)
npm run test:watch                 # Watch mode
npm run test:coverage              # Tests with coverage report
npx vitest run tests/auth.test.js  # Run a single test file
npm run build                      # Build wallet bundle into dist/
npm run build:watch                # Rebuild on wallet/ changes
npm run build:check                # One-shot build used by CI
```

Requires Node.js >= 22.

## UI/UX Notes

- **Target audience**: Non-technical Brazilian users (leigos)
- **Language**: All UI text in Brazilian Portuguese
- **Theme**: Dark teal gradient (#0f3d3e → #071b1f), accent #4fd1c5
- **Typography**: system-ui, sans-serif
- **Mobile-first**: Max card width 420px, safe area insets for notch devices
- **Error messages**: Red (#ff6b6b), always user-friendly (no technical jargon)
- **Success messages**: Green (#68d391)
- **Toast notifications**: Bottom center, auto-dismiss after 2s

## Frontend Best Practices — Non-negotiable

The app renders tons of user-supplied strings — callback URLs, emails, names, Liquid addresses, product names, webhook URLs, affiliate codes. **Any of them can be arbitrarily long.** Every time we render one, the layout must survive the worst-case length without hiding buttons off-screen or forcing horizontal scroll. The 420px mobile card leaves zero slack.

Treat these as defaults. If you render user input without following them, you are shipping a bug.

### Rule 1 — Every user-supplied string must have a truncation strategy

Before writing `<span>${userString}</span>`, decide: **single-line truncate with ellipsis** (default for labels, names, URLs in lists) or **wrap to multiple lines** (long-form text: modal bodies, descriptions, webhook payload pre-blocks).

Single-line truncate (the default):
```css
.my-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Wrap long strings:
```css
.my-body {
  overflow-wrap: anywhere;   /* or word-break: break-all for URLs/hashes */
}
```

No third option. **Never leave a user string with default CSS** — the default is `white-space: normal` which wraps at spaces, and a long URL without spaces will overflow its container.

### Rule 2 — Flex children that truncate MUST have `min-width: 0`

Flex items default to `min-width: auto`, which means they refuse to shrink below their content's intrinsic size. `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` **will not work** on a flex child unless you also set `min-width: 0` — instead the child grows past the container and pushes siblings (edit buttons, dates, badges) off-screen.

Canonical row pattern (long value + trailing action):
```css
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row .value {
  flex: 1;
  min-width: 0;                   /* THIS IS THE LINE THAT FAILS SILENTLY WHEN OMITTED */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row .action {
  flex-shrink: 0;                 /* button/badge/date keeps its size, never gets pushed */
}
```

This is exactly the bug we hit with the "Editar Callback URL" button — it was a `display: table` row without `table-layout: fixed`, which has the same failure mode. **Prefer flex over table layouts.** If you must use `display: table`, always add `table-layout: fixed`.

### Rule 3 — Trailing actions use `flex-shrink: 0`

Edit buttons, copy buttons, delete icons, badges, timestamps, and any other "chrome" next to a user string must have `flex-shrink: 0`. Without it, a long value can compress the button until it disappears or wraps awkwardly.

### Rule 4 — Parent containers must constrain width

The outermost card is `max-width: 420px`. Inside, every container that holds user strings must either:
- Be a flex/grid child that inherits its width from the parent, OR
- Have `max-width: 100%` explicitly.

A `display: inline-block` element with long unbreakable content can still push past a 420px card if the parent doesn't constrain it.

### Rule 5 — Abbreviate long strings in JS as a second line of defense

For Liquid addresses, webhook URLs, API keys, we already abbreviate server-side values in JS (`abbreviateHash`, substring). This is **in addition to** the CSS truncation, not a replacement — CSS still has to truncate because the abbreviation still contains no spaces and can be pushed around by flex children without `min-width: 0`.

### Rule 6 — Test with a pathological string before shipping

Before marking any view done, paste a 200-character URL or a 50-character product name into the field and verify:
1. The edit/copy/action button is still visible and clickable.
2. Nothing causes horizontal scroll on the viewport.
3. The string is either truncated with `…` or wraps cleanly.

If you can't test in a browser (no dev server running), say so explicitly — don't claim the UI works based on the diff alone. Type-checks and unit tests verify code correctness, not layout.

### Rule 7 — Modal inputs get `width: 100%` and `box-sizing: border-box`

Inputs that receive user values (including pasted URLs) must not expand their modal. `<input type="text">` defaults to a fixed `size`-based width; always style modal inputs with `width: 100%; box-sizing: border-box` so they scroll horizontally internally instead of widening the modal.

### Rule 8 — When in doubt, prefer the safe default

- **Card titles / names / labels** → single-line truncate.
- **URLs, emails, addresses in lists** → single-line truncate (abbreviate in JS if long-form copy is needed elsewhere).
- **Long-form prose (modal bodies, descriptions, webhook payloads)** → `word-break: break-all` or `overflow-wrap: anywhere`.
- **Never**: leave a user string with default CSS and hope it's short enough.

### Red flags to grep for during code review

Before approving any frontend PR that renders user data:
- `white-space: nowrap` without a matching `overflow: hidden; text-overflow: ellipsis` nearby.
- Flex children rendering a user string without `min-width: 0`.
- `display: table` without `table-layout: fixed`.
- Action buttons inside flex rows without `flex-shrink: 0`.
- `escapeHtml(someUserField)` injected into a `<span>`/`<div>` with no CSS class that bounds its width.

## Internationalization (i18n) — Static Pages

The `/docs` and `/btcpay` pages support Portuguese (default) and English:

- **Portuguese**: `{page}/index.html` — served at root path (e.g., `/docs`)
- **English**: `{page}/en/index.html` — served at `/en` subpath (e.g., `/docs/en`)

### Critical rule: content parity
The PT-BR and EN versions of each page must have **identical content** — same sections, same structure, same information. When adding, removing, or changing any content, **always apply the change to both languages**. Never leave one version ahead of the other.

### When editing these pages:
- Update **both language versions** when changing content
- Both files must have matching `hreflang` tags (pt-BR, en, x-default)
- CSS is duplicated intentionally (pages are standalone — no shared stylesheet)
- Each page has full SEO: OG tags, Twitter Card tags, JSON-LD structured data, hreflang, canonical
- Icon paths in `/en/` files use `../../icon-192.png` (one level deeper)
- Update `sitemap.xml` when adding new pages (with `xhtml:link` hreflang annotations)
- Nav links in EN pages point to EN counterparts (`/docs/en`, `/btcpay/en`) and vice versa
- Each page has a language switcher link in the nav

### Portuguese accentuation
All Portuguese text must have correct accentuation. This is non-negotiable — unaccented Portuguese reads as broken/unprofessional. Common patterns to watch for:
- **é** (not "e") when it means "is": *é possível*, *é enviado*, *é compatível*
- **ã/ão/ões**: *não*, *descrição*, *informações*, *requisições*, *produção*, *conversão*
- **í**: *possível*, *disponível*, *compatível*, *específico*, *início*, *válido*
- **ó**: *só*, *ótimo*
- **ú**: *útil*, *único*
- **ç**: *diferenças*, *reformatação*
- **ê**: *você*, *vê*
- **à**: *à* (crase)

After any edit to Portuguese content, grep for common unaccented words to catch regressions: `especifico`, `possivel`, `voce`, `producao`, `informacoes`, `disponivel`, `conversao`, etc.

### Docs page (`/docs`) — API documentation
- **Structure**: Nav + sidebar (section links) + main content with doc-section blocks
- **Code examples**: Multi-language tabs (curl, JavaScript, Python, PHP, C#, Go, Ruby, Java) using `setLang()` JS. User's choice is persisted in `localStorage`.
- **What to translate**: Headings, prose, table headers/descriptions, alert text, code labels ("Resposta — 201 Created" → "Response — 201 Created"), copy button text ("copiar"/"copiado!" → "copy"/"copied!"), code comments inside examples, badge labels ("obrigatório"/"opcional" → "required"/"optional")
- **What NOT to translate**: Code blocks, JSON payloads, curl commands, API paths, field names in tables (amount, description, etc.), technical terms standard in English (webhook, sandbox, endpoint, checkout, merchant, slug, payload)

### BTCPay page (`/btcpay`) — Plugin landing page
- **Structure**: Hero + MED banner + 3-step setup + benefits grid + FAQ accordion + final CTA + footer
- **Translate everything visible**: Hero text, step descriptions, benefit cards, FAQ questions/answers, CTA text, footer
- **FAQ accordion**: Uses `<details>/<summary>` elements — make sure both languages have the same questions

## Shared files with depix-backend

Some files in this repo exist as **byte-identical copies** under `../depix-backend/public/`. They are imported by backend-rendered server pages (checkout / merchant / product templates) in addition to the SPA, so any divergence between copies will cause one side to load helpers the other side doesn't define — and in dev, where everything is served from `localhost:2323`, both sides end up hitting the same file through nginx (see `../depix-dev/CLAUDE.md`), so drift breaks the landing page.

| File here | Copy in depix-backend | Imported by |
|-----------|----------------------|-------------|
| `qr.js` | `public/qr.js` | SPA (`script.js` imports `./qr.js`) + backend-rendered checkout/merchant/product pages (import `/qr.js`) |

**Rule: any edit to a shared file must be replicated in the other repo in the same change (both PRs if applicable).** Don't diverge `qr.js` to add frontend-only helpers — put those in a separate file (e.g. `qr-print.js`) and import them explicitly from the SPA. Keeping `qr.js` a single shared asset is what lets the server-rendered pages work in both prod and dev without branching logic.

Both copies carry a `SYNC NOTICE` header. Do not remove it. If you introduce a new shared file, add a row to the table above AND to the equivalent section in `../depix-backend/CLAUDE.md` AND drop a `SYNC NOTICE` header in both copies.

## Local Dev Environment

A Docker-based dev environment exists at `../depix-dev/`. Use it to test changes locally before pushing to production.

```bash
cd ../depix-dev && docker compose up -d
# Frontend + API: http://localhost:2323
# Blog: http://localhost:2324
```

Frontend changes reflect immediately (volume mount). See `../depix-dev/CLAUDE.md` for full instructions.

**E2E tests**: End-to-end tests live in `../depix-dev/tests/`. They run against the local dev environment and test full user flows (registration, login, blocking, webhooks, Telegram commands). See `../depix-dev/CLAUDE.md` for instructions on running and creating E2E tests.

**E2E runs in CI too**: Every push/PR to `main` of this repo fires a `repository_dispatch` (event-type `frontend-push`) at `dadafros/depix-dev`, which runs the full e2e suite against the PR's commit of this repo + `main` of the other two repos. The result is posted back as a commit status `depix-dev / e2e` on the PR, which can be marked as a required check in branch protection. See `../depix-dev/CLAUDE.md` section "CI — Testes E2E automáticos no GitHub Actions" for setup details and how to debug failures (artifact `docker-logs` on the depix-dev run).

## Git

- Remote: `git@github-personal:dadafros/depix-frontend.git`
- SSH key alias `github-personal` maps to `~/.ssh/id_ed25519_outlook`
- Commit as: `dadafros <davi_bf@outlook.com>`
- Branch naming: `feat/*` for features, `claude/*` for Claude Code branches
- CI: GitHub Actions runs ESLint + `npm test` on push to `main` and on PRs to `main`
- Deploy: GitHub Pages from main branch

## Service Worker & Cache Versioning

### How it works

The app uses a service worker with three caching strategies:
- **HTML (`index.html`)**: Network-first — always fetches from server, falls back to cache when offline
- **JS / CSS**: Network-first — prevents stale ES module drift (see "iOS PWA blank-screen incident" below). Falls back to cache when offline.
- **Images / icons / manifest**: Cache-first — served from cache for speed. Versioned via `?v=N`.

A single `APP_VERSION` constant in `service-worker.js` controls cache naming (`depix-v${APP_VERSION}`). When bumped, the install event creates a brand-new cache and the activate event deletes older ones.

The SW uses `skipWaiting()` + `clients.claim()` so new versions activate immediately. The app detects `controllerchange` and auto-reloads — users never stay stuck on an old version.

### CRITICAL: the unversioned-modules gotcha (iOS PWA blank-screen incident, 2026-04-16)

ES module imports in `script.js` use **unversioned specifiers**:

```js
import { slugify } from "./utils.js";  // NOT "./utils.js?v=123"
```

The browser resolves these relative to the importing module's URL but **drops the query string** during resolution, so the actual request is `https://depixapp.com/utils.js` — with no `?v=`. That means:

- Versioned entries in `STATIC_FILES` (like `./utils.js?v=124`) are **never hit by module imports**.
- If the SW's fetch handler uses cache-first and dynamically caches unversioned URLs, the cache can permanently retain a stale `./utils.js` from an earlier version. When a later `script.js` imports a newly-added export, the browser gets the old file, parsing fails with `SyntaxError: Importing binding name 'X' is not found`, and the whole app is dead before `serviceWorker.register` runs — so the SW can't even self-repair.

**Mitigations in place (do not remove without replacing):**

1. `STATIC_FILES` pre-caches JS modules under BOTH URLs — `./utils.js?v=${APP_VERSION}` (for the HTML references) AND `./utils.js` (for the ES module imports). Each install guarantees the unversioned entry matches the new source.
2. JS/CSS fetches are **network-first**. Even if the cache has a stale module, the network response takes precedence. Cache is only used when offline.

Images, icons, and the manifest remain cache-first because they don't cross-version-drift and cache-first is cheaper for them.

### CRITICAL: Deploy checklist

Two distinct cache-busting regimes live side by side — do not confuse them:

**A. Legacy files (`script.js`, `style.css`, `manifest.json`, icons, etc.)** — must be bumped manually every time you edit one:

1. **Bump `APP_VERSION`** in `service-worker.js` (line 3): e.g. `const APP_VERSION = 125;` → `const APP_VERSION = 126;`
2. **Update `?v=` query strings** in `index.html` to match the new version number. Search for `?v=` — there are ~6 occurrences (script.js, style.css, manifest.json, icons). Change all from `?v=125` to `?v=126`.

Both steps are required. If you only bump `APP_VERSION` but not the HTML query strings, the HTML will reference the old version. If you only bump the HTML but not `APP_VERSION`, the SW won't reinstall.

**B. Wallet bundle (`dist/wallet-bundle-<hash>.js`, `dist/lwk_wasm-<hash>.wasm`)** — no manual action required:

- esbuild stamps the filename with a content hash on every build. Any change in `wallet/` produces a new filename, so the browser treats it as a new resource and bypasses the cache automatically.
- `index.html` does NOT hardcode the hashed filename. Instead, the loader reads `dist/manifest.json` at runtime and imports the file it points to.
- You never edit `?v=` for anything under `dist/`.

The SW bump from regime A still controls the cache **namespace** (`depix-v${APP_VERSION}`), so a legacy-file edit invalidates the wallet cache too. If you only touch `wallet/`, you don't need to bump `APP_VERSION` — the content hash already does the job, and the SW precache doesn't include `dist/` (the loader fetches lazily).

### What happens if you forget

- Users will be served stale cached files from the old service worker
- New-export imports will break (classic blank-screen symptom) — the unversioned-modules mitigations help but don't cover every case
- There is no remote kill switch — stuck users must wait for the browser's 24h SW auto-update or reinstall the PWA manually

### Files involved

| File | What to change |
|------|---------------|
| `service-worker.js` line 3 | `APP_VERSION = N` → `APP_VERSION = N+1` |
| `index.html` (~6 places) | All `?v=N` → `?v=N+1` |

### Adding new files to the cache

If you create a new JS module, add it to the `JS_MODULES` array in `service-worker.js` (it gets spread into `STATIC_FILES` both with and without `?v=`). For CSS or other static files, add directly to `STATIC_FILES` using the versioned template:
```js
`./new-file.css?v=${APP_VERSION}`,
```
And reference it in `index.html` with the matching query string:
```html
<link rel="stylesheet" href="new-file.css?v=124" />
```

## Workflow Rules

- **Always start from latest main**: Before starting any task, pull the latest `main` from remote (`git pull origin main`) to ensure you're working with the most recent code.
- **Before pushing**: Always run lint (`npx --yes eslint@9 .`) and tests (`npm test`) locally before pushing. CI runs both on push — fix any failures locally first.
- **Default for simple or urgent fixes**: Small fixes, hotfixes, and urgent production issues should be committed and pushed directly to `main`.
- **Use PRs for large or complex work**: Large refactors, high-risk changes, or substantial multi-file work should go on a separate branch and be opened as a PR for review.
- **User instruction wins**: If the user explicitly asks for a different flow, follow the user's instruction.
- **Sync before branching**: If the work should go through a PR, always sync with `main` first (`git pull origin main`) before creating or updating the branch.

## Git Worktrees

Ciclo de vida completo em `~/.claude/CLAUDE.md`. Específico deste repo:

- **Localização**: `.claude/worktrees/<branch-slug>/`
- **Branch default**: `main`
- **Naming convention**: `feat/*` (features), `fix/*` (bugfixes), `claude/*` (agent work)
- **Fluxo padrão** (default): worktree com branch → commit → `git push origin HEAD:main` → cleanup imediato (remove worktree + delete branch + `git fetch --prune`)
- **Fluxo PR** (trabalho grande/complexo, ver "Workflow Rules"): worktree → `git push -u origin <branch>` → `gh pr create` → após merge, mesmo cleanup
- **Antes de criar**: `git worktree list` + `git branch -a` pra não duplicar trabalho existente
- **Reminder**: ao editar arquivos JS/CSS/HTML, o "Deploy checklist" acima (bump `APP_VERSION` + `?v=` query strings) aplica antes de pushar pra main — independente do fluxo
