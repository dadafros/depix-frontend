import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import {
  enroll,
  derivePrfSecret,
  importPrfAsAesKey,
  isPrfCredential,
  isAvailable
} from "../wallet/wallet-biometric.js";
import { WalletError, ERROR_CODES } from "../wallet/wallet-errors.js";

const nodeCrypto = webcrypto;

// Minimal navigator.credentials stub. Returns shape that matches the real
// WebAuthn PublicKeyCredential enough to drive `wallet-biometric.js`.
function makeCredentialsMock({ prfBytes, failCreate = false, failGet = false } = {}) {
  const create = vi.fn(async (_opts) => {
    if (failCreate) throw new DOMException("user canceled", "NotAllowedError");
    const rawId = new Uint8Array([1, 2, 3, 4]);
    return {
      rawId,
      getClientExtensionResults: () => ({
        prf: { results: { first: prfBytes ?? new Uint8Array(32).fill(9) } }
      })
    };
  });
  const get = vi.fn(async (_opts) => {
    if (failGet) throw new DOMException("user canceled", "NotAllowedError");
    return {
      getClientExtensionResults: () => ({
        prf: { results: { first: prfBytes ?? new Uint8Array(32).fill(9) } }
      })
    };
  });
  return { create, get };
}

describe("isAvailable", () => {
  afterEach(() => {
    delete globalThis.navigator;
    delete globalThis.PublicKeyCredential;
  });

  it("returns false when WebAuthn is not available", async () => {
    // Explicitly clear the stubs.
    delete globalThis.navigator;
    delete globalThis.PublicKeyCredential;
    expect(await isAvailable()).toBe(false);
  });

  it("returns true when platform authenticator is available", async () => {
    globalThis.navigator = { credentials: { create: vi.fn(), get: vi.fn() } };
    globalThis.PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => true)
    };
    expect(await isAvailable()).toBe(true);
  });

  it("returns false when the platform method throws", async () => {
    globalThis.navigator = { credentials: { create: vi.fn(), get: vi.fn() } };
    globalThis.PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => {
        throw new Error("boom");
      })
    };
    expect(await isAvailable()).toBe(false);
  });
});

describe("enroll", () => {
  beforeEach(() => {
    globalThis.navigator = { credentials: {} };
    globalThis.PublicKeyCredential = {};
  });
  afterEach(() => {
    delete globalThis.navigator;
    delete globalThis.PublicKeyCredential;
  });

  it("returns credentialId, prfSalt and prfSecret on success", async () => {
    const credentialsImpl = makeCredentialsMock();
    const result = await enroll({ credentialsImpl });
    expect(result.credentialId).toBeInstanceOf(Uint8Array);
    expect(result.prfSalt).toBeInstanceOf(Uint8Array);
    expect(result.prfSalt.length).toBe(32);
    expect(result.prfSecret).toBeInstanceOf(Uint8Array);
    // The options passed to create() must demand UV and PRF evaluation.
    const opts = credentialsImpl.create.mock.calls[0][0];
    expect(opts.publicKey.authenticatorSelection.userVerification).toBe("required");
    expect(opts.publicKey.authenticatorSelection.residentKey).toBe("discouraged");
    expect(opts.publicKey.extensions.prf.eval.first).toBeDefined();
  });

  it("throws BIOMETRIC_REJECTED when credentials.create rejects", async () => {
    const credentialsImpl = makeCredentialsMock({ failCreate: true });
    try {
      await enroll({ credentialsImpl });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.BIOMETRIC_REJECTED);
    }
  });

  it("throws BIOMETRIC_UNAVAILABLE when the device returns no PRF bytes", async () => {
    const credentialsImpl = {
      create: vi.fn(async () => ({
        rawId: new Uint8Array([1]),
        getClientExtensionResults: () => ({})
      }))
    };
    try {
      await enroll({ credentialsImpl });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.BIOMETRIC_UNAVAILABLE);
    }
  });
});

describe("derivePrfSecret", () => {
  beforeEach(() => {
    globalThis.navigator = { credentials: {} };
    globalThis.PublicKeyCredential = {};
  });
  afterEach(() => {
    delete globalThis.navigator;
    delete globalThis.PublicKeyCredential;
  });

  it("returns the PRF secret from a successful assertion", async () => {
    const credentialsImpl = makeCredentialsMock();
    const secret = await derivePrfSecret({
      credentialId: new Uint8Array([1, 2, 3, 4]),
      prfSalt: new Uint8Array(32).fill(1),
      credentialsImpl
    });
    expect(secret).toBeInstanceOf(Uint8Array);
    const opts = credentialsImpl.get.mock.calls[0][0];
    expect(opts.publicKey.userVerification).toBe("required");
    expect(opts.publicKey.allowCredentials).toHaveLength(1);
    expect(opts.publicKey.allowCredentials[0].type).toBe("public-key");
  });

  it("throws BIOMETRIC_UNAVAILABLE on missing enrollment data", async () => {
    try {
      await derivePrfSecret({ credentialsImpl: makeCredentialsMock() });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.BIOMETRIC_UNAVAILABLE);
    }
  });

  it("throws BIOMETRIC_REJECTED when the user cancels", async () => {
    const credentialsImpl = makeCredentialsMock({ failGet: true });
    try {
      await derivePrfSecret({
        credentialId: new Uint8Array([1]),
        prfSalt: new Uint8Array(32),
        credentialsImpl
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.BIOMETRIC_REJECTED);
    }
  });
});

describe("importPrfAsAesKey", () => {
  it("wraps the PRF bytes as a usable AES-GCM key", async () => {
    const bytes = new Uint8Array(32).fill(3);
    const key = await importPrfAsAesKey(bytes, nodeCrypto);
    expect(key).toBeDefined();
    const iv = new Uint8Array(12).fill(5);
    const ct = await nodeCrypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode("hi")
    );
    expect(ct.byteLength).toBeGreaterThan(0);
  });
});

describe("isPrfCredential", () => {
  it("returns true only when all three biometric fields are present", () => {
    expect(isPrfCredential(null)).toBe(false);
    expect(isPrfCredential({})).toBe(false);
    expect(isPrfCredential({ credentialId: new Uint8Array([1]) })).toBe(false);
    expect(isPrfCredential({
      credentialId: new Uint8Array([1]),
      prfSalt: new Uint8Array([2]),
      wrappedSeedKey: new Uint8Array([3])
    })).toBe(true);
  });
});
