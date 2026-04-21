// Wallet-wide constants. Single source of truth.
//
// Rationale: the plan calls for MAX_PIN_ATTEMPTS = 5 and uses that number in
// copy ("PIN incorreto. Tentativas restantes: N") and in UI thresholds (warning
// at 4, red modal at 5). If the constant drifts between UI, backend copy, and
// the wipe threshold, we ship a subtle footgun. Keep them here.

export const MAX_PIN_ATTEMPTS = 5;

// UX progressive rate-limit: no delay on the first 2 mistakes, 10s between
// attempts starting from the 3rd consecutive wrong PIN. Defends against
// brute-force after an IndexedDB dump.
export const PIN_RATE_LIMIT_MS = 10_000;
export const PIN_RATE_LIMIT_AFTER_ATTEMPT = 3;

// Auto-lock the signer after this many minutes of inactivity, and immediately
// when the page goes to the background. View-only surface never locks.
export const AUTO_LOCK_MINUTES = 15;

// Argon2id — m=19 MiB, t=2, p=1. OWASP 2024 minimum. Floor target: iOS 18 PRF
// (A12+) ~600ms–1s; Android 2019 ~1.5–2s. Memory-hard; hard-coded.
export const ARGON2_MEMORY_KIB = 19 * 1024; // 19 MiB
export const ARGON2_ITERATIONS = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_HASH_LENGTH = 32; // AES-256-GCM key length

export const AES_IV_LENGTH_BYTES = 12;
export const SALT_LENGTH_BYTES = 16;

// Path where the build step writes the bundle manifest. The loader fetches
// this at runtime to discover the hashed WASM filename. See build.mjs.
export const BUNDLE_MANIFEST_URL = "/dist/manifest.json";

// WASM fetch timeout per attempt. After this, the loader either retries (up
// to MAX_LOAD_RETRIES) or fails degradedly.
export const WASM_FETCH_TIMEOUT_MS = 10_000;
export const MAX_LOAD_RETRIES = 3;
export const LOAD_BACKOFF_SCHEDULE_MS = [1000, 3000, 9000];

// Minimum PIN length. Plan calls for 6-digit numeric.
export const MIN_PIN_LENGTH = 6;
export const MAX_PIN_LENGTH = 6;

// Stable PBKDF2-style salts for Argon2id and AES must be per-wallet random.
// But the PRF extension for WebAuthn needs a stable per-credential salt, which
// we store plaintext alongside the credentialId — see wallet-biometric.js.
