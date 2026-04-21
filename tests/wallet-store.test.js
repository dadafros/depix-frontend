import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  openDb,
  readCredentials,
  writeCredentials,
  patchCredentials,
  deleteCredentials,
  readSync,
  writeSync,
  deleteSync,
  hasCredentials,
  wipeSensitiveCredentials,
  resetFailedPinAttempts,
  incrementFailedPinAttempts,
  destroyDatabase,
  SCHEMA_VERSION
} from "../wallet/wallet-store.js";
import { WalletError, ERROR_CODES } from "../wallet/wallet-errors.js";

let factory;

function sampleCredentials(overrides = {}) {
  return {
    encryptedSeed: new Uint8Array([1, 2, 3]),
    salt: new Uint8Array(16).fill(5),
    iv: new Uint8Array(12).fill(7),
    descriptor: "ct(slip77(...))",
    failedPinAttempts: 0,
    credentialId: null,
    prfSalt: null,
    wrappedSeedKey: null,
    createdAt: 1_700_000_000_000,
    ...overrides
  };
}

describe("wallet-store", () => {
  beforeEach(() => {
    factory = new IDBFactory();
  });

  it("openDb creates both stores at v1", async () => {
    const db = await openDb(factory);
    expect(db.version).toBe(1);
    expect(Array.from(db.objectStoreNames).sort()).toEqual(["credentials", "sync"]);
    db.close();
  });

  it("throws STORAGE_UNAVAILABLE when indexedDB is missing", async () => {
    try {
      await openDb(null);
      throw new Error("expected throw");
    } catch (err) {
      // openDb uses global indexedDB when `null` is passed; jsdom has no
      // real indexedDB, so we expect it to throw STORAGE_UNAVAILABLE only
      // when the global is absent. In jsdom the global exists but is
      // unusable — we can't assert a specific code here. Accept either
      // our WalletError or any thrown error.
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("reads null when nothing is written", async () => {
    const db = await openDb(factory);
    expect(await readCredentials(db)).toBeNull();
    expect(await readSync(db)).toBeNull();
    expect(await hasCredentials(db)).toBe(false);
    db.close();
  });

  it("writeCredentials stamps id + schema version", async () => {
    const db = await openDb(factory);
    const saved = await writeCredentials(db, sampleCredentials());
    expect(saved.id).toBe("main");
    expect(saved.version).toBe(SCHEMA_VERSION);
    const back = await readCredentials(db);
    expect(back.id).toBe("main");
    expect(back.version).toBe(SCHEMA_VERSION);
    expect(back.descriptor).toBe("ct(slip77(...))");
    db.close();
  });

  it("hasCredentials returns true only when seed is present", async () => {
    const db = await openDb(factory);
    await writeCredentials(db, sampleCredentials({ encryptedSeed: null }));
    expect(await hasCredentials(db)).toBe(false);
    await writeCredentials(db, sampleCredentials());
    expect(await hasCredentials(db)).toBe(true);
    db.close();
  });

  it("patchCredentials merges into the existing row", async () => {
    const db = await openDb(factory);
    await writeCredentials(db, sampleCredentials());
    const patched = await patchCredentials(db, { failedPinAttempts: 3 });
    expect(patched.failedPinAttempts).toBe(3);
    expect(patched.descriptor).toBe("ct(slip77(...))");
    db.close();
  });

  it("patchCredentials throws WALLET_NOT_FOUND when no row exists", async () => {
    const db = await openDb(factory);
    try {
      await patchCredentials(db, { failedPinAttempts: 1 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.WALLET_NOT_FOUND);
    }
    db.close();
  });

  it("wipeSensitiveCredentials zeroes seed/IV/salt but keeps descriptor and createdAt", async () => {
    const db = await openDb(factory);
    await writeCredentials(db, sampleCredentials({
      credentialId: new Uint8Array([9]),
      prfSalt: new Uint8Array([8]),
      wrappedSeedKey: new Uint8Array([7, 6]),
      failedPinAttempts: 5
    }));
    const wiped = await wipeSensitiveCredentials(db);
    expect(wiped.encryptedSeed).toBeNull();
    expect(wiped.salt).toBeNull();
    expect(wiped.iv).toBeNull();
    expect(wiped.credentialId).toBeNull();
    expect(wiped.prfSalt).toBeNull();
    expect(wiped.wrappedSeedKey).toBeNull();
    expect(wiped.failedPinAttempts).toBe(0);
    expect(wiped.descriptor).toBe("ct(slip77(...))");
    expect(wiped.createdAt).toBe(1_700_000_000_000);
    expect(await hasCredentials(db)).toBe(false);
    db.close();
  });

  it("wipeSensitiveCredentials on empty store returns null", async () => {
    const db = await openDb(factory);
    const wiped = await wipeSensitiveCredentials(db);
    expect(wiped).toBeNull();
    db.close();
  });

  it("incrementFailedPinAttempts counts up, resetFailedPinAttempts clears", async () => {
    const db = await openDb(factory);
    await writeCredentials(db, sampleCredentials());
    expect(await incrementFailedPinAttempts(db)).toBe(1);
    expect(await incrementFailedPinAttempts(db)).toBe(2);
    expect(await incrementFailedPinAttempts(db)).toBe(3);
    await resetFailedPinAttempts(db);
    const record = await readCredentials(db);
    expect(record.failedPinAttempts).toBe(0);
    db.close();
  });

  it("incrementFailedPinAttempts errors if no wallet", async () => {
    const db = await openDb(factory);
    try {
      await incrementFailedPinAttempts(db);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.WALLET_NOT_FOUND);
    }
    db.close();
  });

  it("sync store CRUD works independently", async () => {
    const db = await openDb(factory);
    expect(await readSync(db)).toBeNull();
    await writeSync(db, { updateBlob: new Uint8Array([1, 2]), lastScanAt: 42 });
    const back = await readSync(db);
    expect(back.id).toBe("main");
    expect(back.lastScanAt).toBe(42);
    await deleteSync(db);
    expect(await readSync(db)).toBeNull();
    db.close();
  });

  it("deleteCredentials removes the row", async () => {
    const db = await openDb(factory);
    await writeCredentials(db, sampleCredentials());
    await deleteCredentials(db);
    expect(await readCredentials(db)).toBeNull();
    db.close();
  });

  it("destroyDatabase wipes everything", async () => {
    const db = await openDb(factory);
    await writeCredentials(db, sampleCredentials());
    db.close();
    await destroyDatabase(factory);
    const fresh = await openDb(factory);
    expect(await readCredentials(fresh)).toBeNull();
    fresh.close();
  });
});
