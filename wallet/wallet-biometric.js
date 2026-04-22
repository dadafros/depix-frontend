// WebAuthn + PRF extension wrapper.
//
// PRF (Pseudo-Random Function) is the only way to make biometrics genuinely
// protect the seed on the device. Without PRF, biometric unlock is just a UX
// convenience — someone with the IndexedDB dump and the PIN can still decrypt.
// With PRF, the authenticator derives a secret each `get()` that's unknowable
// without UV (user verification). We wrap the seed under that secret, so the
// authenticator is required at decrypt time.
//
// If the device can't do PRF (iOS ≤16, older Android, older Chrome), we return
// `isAvailable() === false` and onboarding silently skips the biometric step.
// No half-secured fallback, per the plan.
//
// All credentials are non-resident (no `rk: true`) — we store the credentialId
// locally and pass it via `allowCredentials`. This avoids consuming the
// device's resident-credential slots.

import { WalletError, ERROR_CODES } from "./wallet-errors.js";
import { randomBytes } from "./wallet-crypto.js";

const RP_NAME = "DePix";
const TIMEOUT_MS = 60_000;
const PRF_SALT_LENGTH = 32;

function hasWebAuthn() {
  return (
    typeof navigator !== "undefined" &&
    navigator.credentials &&
    typeof PublicKeyCredential !== "undefined"
  );
}

function getRpId() {
  if (typeof location === "undefined" || !location.hostname) {
    return "depixapp.com";
  }
  return location.hostname;
}

async function platformAuthenticatorAvailable() {
  if (!hasWebAuthn()) return false;
  if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
    return false;
  }
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// Two-step availability check. Step 1: platform authenticator is advertised.
// Step 2 (functional, caller-driven): an enroll with PRF actually returns PRF
// bytes. We don't run step 2 here because it would consume a real credential;
// the caller runs it during onboarding and passes the result back in.
export async function isAvailable() {
  return platformAuthenticatorAvailable();
}

function bufToArray(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  throw new TypeError("Expected Uint8Array or ArrayBuffer");
}

function ensureBufferSource(value) {
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new TypeError("Expected ArrayBuffer or Uint8Array");
}

// Create a non-resident credential with PRF extension. Returns the
// credentialId (so we can reference it again) and the PRF-derived secret (so
// we can wrap the seed immediately during onboarding).
//
// `userHandle` is an opaque per-credential identifier. Callers may pass one for
// stability across re-enrolls; otherwise we generate fresh random bytes each
// time. Non-resident credentials don't persist userHandle on the authenticator,
// so random-per-enroll is safe — plan Sub-fase 2 doesn't mandate stability.
export async function enroll({ userHandle, displayName, credentialsImpl } = {}) {
  if (!hasWebAuthn()) {
    throw new WalletError(
      ERROR_CODES.BIOMETRIC_UNAVAILABLE,
      "WebAuthn is not available in this browser"
    );
  }
  const credentials = credentialsImpl ?? navigator.credentials;
  const prfSalt = randomBytes(PRF_SALT_LENGTH);
  const challenge = randomBytes(32);
  const userId = userHandle ?? randomBytes(16);

  let credential;
  try {
    credential = await credentials.create({
      publicKey: {
        rp: { name: RP_NAME, id: getRpId() },
        user: {
          id: ensureBufferSource(userId),
          name: displayName ?? "DePix Wallet",
          displayName: displayName ?? "DePix Wallet"
        },
        challenge: ensureBufferSource(challenge),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },   // ES256
          { type: "public-key", alg: -257 }  // RS256
        ],
        timeout: TIMEOUT_MS,
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "discouraged",
          requireResidentKey: false,
          userVerification: "required"
        },
        attestation: "none",
        extensions: {
          prf: { eval: { first: ensureBufferSource(prfSalt) } }
        }
      }
    });
  } catch (err) {
    const isUserCancel = err?.name === "NotAllowedError";
    throw new WalletError(
      isUserCancel ? ERROR_CODES.BIOMETRIC_REJECTED : ERROR_CODES.BIOMETRIC_UNAVAILABLE,
      err?.message ?? "WebAuthn enroll failed",
      err
    );
  }

  if (!credential) {
    throw new WalletError(
      ERROR_CODES.BIOMETRIC_REJECTED,
      "WebAuthn enroll returned null"
    );
  }

  const extResults = credential.getClientExtensionResults?.() ?? {};
  const prfResult = extResults.prf?.results?.first;
  if (!prfResult) {
    // Device advertised UV platform auth but PRF is missing. This is the
    // "decorative biometrics" case — refuse to silently proceed.
    throw new WalletError(
      ERROR_CODES.BIOMETRIC_UNAVAILABLE,
      "Device does not support WebAuthn PRF extension"
    );
  }

  return {
    credentialId: bufToArray(credential.rawId),
    prfSalt: bufToArray(prfSalt),
    prfSecret: bufToArray(prfResult)
  };
}

// Call `get()` with PRF to recover the same secret. Used to decrypt the
// wrapped seed during unlock.
export async function derivePrfSecret({ credentialId, prfSalt, credentialsImpl } = {}) {
  if (!hasWebAuthn()) {
    throw new WalletError(
      ERROR_CODES.BIOMETRIC_UNAVAILABLE,
      "WebAuthn is not available in this browser"
    );
  }
  if (!credentialId || !prfSalt) {
    throw new WalletError(
      ERROR_CODES.BIOMETRIC_UNAVAILABLE,
      "Missing biometric enrollment data"
    );
  }
  const credentials = credentialsImpl ?? navigator.credentials;
  const challenge = randomBytes(32);

  let assertion;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: ensureBufferSource(challenge),
        rpId: getRpId(),
        timeout: TIMEOUT_MS,
        userVerification: "required",
        allowCredentials: [
          {
            id: ensureBufferSource(credentialId),
            type: "public-key",
            transports: ["internal"]
          }
        ],
        extensions: {
          prf: { eval: { first: ensureBufferSource(prfSalt) } }
        }
      }
    });
  } catch (err) {
    const isUserCancel = err?.name === "NotAllowedError";
    throw new WalletError(
      isUserCancel ? ERROR_CODES.BIOMETRIC_REJECTED : ERROR_CODES.BIOMETRIC_UNAVAILABLE,
      err?.message ?? "WebAuthn assertion failed",
      err
    );
  }

  if (!assertion) {
    throw new WalletError(
      ERROR_CODES.BIOMETRIC_REJECTED,
      "WebAuthn assertion returned null"
    );
  }

  const prfResult = assertion.getClientExtensionResults?.()?.prf?.results?.first;
  if (!prfResult) {
    throw new WalletError(
      ERROR_CODES.BIOMETRIC_UNAVAILABLE,
      "Authenticator returned no PRF secret"
    );
  }

  return bufToArray(prfResult);
}

// Convenience helper to import raw PRF bytes as an AES-GCM key (same as the
// PIN-derived path, but bypassing Argon2id).
export async function importPrfAsAesKey(prfBytes, cryptoImpl) {
  const c = cryptoImpl ?? crypto;
  return c.subtle.importKey(
    "raw",
    bufToArray(prfBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export function isPrfCredential(credentialRecord) {
  if (!credentialRecord) return false;
  return (
    credentialRecord.credentialId != null &&
    credentialRecord.prfSalt != null &&
    credentialRecord.wrappedSeedKey != null
  );
}


