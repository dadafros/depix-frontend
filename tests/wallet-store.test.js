import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  openDb,
  readCredentials,
  writeCredentials,
  patchCredentials,
  deleteCredentials,
  getUpdate,
  putUpdate,
  clearAllUpdates,
  countUpdates,
  readMeta,
  writeMeta,
  deleteMeta,
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

  it("openDb creates v2 stores: credentials + wallet-updates-v1 + wallet-meta", async () => {
    const db = await openDb(factory);
    expect(db.version).toBe(2);
    expect(Array.from(db.objectStoreNames).sort()).toEqual([
      "credentials",
      "wallet-meta",
      "wallet-updates-v1"
    ]);
    db.close();
  });

  it("v1 → v2 migration drops the legacy `sync` store and creates the new ones", async () => {
    // Manually create a v1-shaped DB to simulate an existing user, then re-open
    // and assert the migration ran cleanly.
    const v1OpenReq = factory.open("depix-wallet", 1);
    await new Promise((resolve, reject) => {
      v1OpenReq.onupgradeneeded = () => {
        const db = v1OpenReq.result;
        db.createObjectStore("credentials", { keyPath: "id" });
        const sync = db.createObjectStore("sync", { keyPath: "id" });
        // Pre-populate the legacy blob to confirm the migration is destructive
        // (we don't try to salvage it — see store comment for rationale).
        sync.transaction.objectStore("sync").put({
          id: "main",
          updateBlob: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
          lastScanAt: 1234
        });
      };
      v1OpenReq.onsuccess = () => resolve();
      v1OpenReq.onerror = () => reject(v1OpenReq.error);
    });
    v1OpenReq.result.close();

    const db = await openDb(factory);
    expect(db.version).toBe(2);
    expect(Array.from(db.objectStoreNames).sort()).toEqual([
      "credentials",
      "wallet-meta",
      "wallet-updates-v1"
    ]);
    expect(Array.from(db.objectStoreNames).includes("sync")).toBe(false);
    // New stores start empty — migration does NOT carry the orphan delta over.
    expect(await countUpdates(db)).toBe(0);
    expect(await readMeta(db)).toBeNull();
    db.close();
  });

  it("throws STORAGE_UNAVAILABLE when indexedDB is missing", async () => {
    const originalIdb = globalThis.indexedDB;
    // Force the 'no indexedDB available' branch by both omitting the impl
    // arg AND removing the global. This is the exact path we want to pin:
    // openDb must surface WalletError(STORAGE_UNAVAILABLE), not a bare Error.
    delete globalThis.indexedDB;
    try {
      await openDb();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.STORAGE_UNAVAILABLE);
    } finally {
      if (originalIdb !== undefined) globalThis.indexedDB = originalIdb;
    }
  });

  it("reads null when nothing is written", async () => {
    const db = await openDb(factory);
    expect(await readCredentials(db)).toBeNull();
    expect(await readMeta(db)).toBeNull();
    expect(await getUpdate(db, "0")).toBeNull();
    expect(await hasCredentials(db)).toBe(false);
    expect(await countUpdates(db)).toBe(0);
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

  describe("chained-Update store (wallet-updates-v1)", () => {
    it("putUpdate + getUpdate round-trip a single entry", async () => {
      const db = await openDb(factory);
      const blob = new Uint8Array([1, 2, 3, 4]);
      await putUpdate(db, "abc", blob);
      const back = await getUpdate(db, "abc");
      expect(back.id).toBe("abc");
      expect(Array.from(back.updateBlob)).toEqual([1, 2, 3, 4]);
      expect(typeof back.savedAt).toBe("number");
      db.close();
    });

    it("putUpdate accepts multiple distinct status keys (the chain)", async () => {
      const db = await openDb(factory);
      await putUpdate(db, "EMPTY", new Uint8Array([1]));
      await putUpdate(db, "A", new Uint8Array([2]));
      await putUpdate(db, "B", new Uint8Array([3]));
      expect((await getUpdate(db, "EMPTY")).updateBlob[0]).toBe(1);
      expect((await getUpdate(db, "A")).updateBlob[0]).toBe(2);
      expect((await getUpdate(db, "B")).updateBlob[0]).toBe(3);
      expect(await countUpdates(db)).toBe(3);
      db.close();
    });

    it("putUpdate on existing key upserts (overwrites)", async () => {
      const db = await openDb(factory);
      await putUpdate(db, "abc", new Uint8Array([1]));
      await putUpdate(db, "abc", new Uint8Array([99]));
      const back = await getUpdate(db, "abc");
      expect(back.updateBlob[0]).toBe(99);
      expect(await countUpdates(db)).toBe(1);
      db.close();
    });

    it("getUpdate returns null for missing key", async () => {
      const db = await openDb(factory);
      expect(await getUpdate(db, "no-such-key")).toBeNull();
      db.close();
    });

    it("getUpdate returns null for empty/invalid status string", async () => {
      const db = await openDb(factory);
      expect(await getUpdate(db, "")).toBeNull();
      expect(await getUpdate(db, null)).toBeNull();
      expect(await getUpdate(db, undefined)).toBeNull();
      db.close();
    });

    it("putUpdate rejects empty status with WalletError", async () => {
      const db = await openDb(factory);
      await expect(putUpdate(db, "", new Uint8Array([1]))).rejects.toBeInstanceOf(WalletError);
      db.close();
    });

    it("putUpdate rejects empty/missing blob with WalletError", async () => {
      const db = await openDb(factory);
      await expect(putUpdate(db, "abc", new Uint8Array([]))).rejects.toBeInstanceOf(WalletError);
      await expect(putUpdate(db, "abc", null)).rejects.toBeInstanceOf(WalletError);
      db.close();
    });

    it("clearAllUpdates wipes the chain", async () => {
      const db = await openDb(factory);
      await putUpdate(db, "EMPTY", new Uint8Array([1]));
      await putUpdate(db, "A", new Uint8Array([2]));
      await clearAllUpdates(db);
      expect(await countUpdates(db)).toBe(0);
      expect(await getUpdate(db, "EMPTY")).toBeNull();
      db.close();
    });
  });

  describe("wallet-meta store", () => {
    it("readMeta returns null on empty store", async () => {
      const db = await openDb(factory);
      expect(await readMeta(db)).toBeNull();
      db.close();
    });

    it("writeMeta is patch-style: subsequent writes merge fields", async () => {
      const db = await openDb(factory);
      await writeMeta(db, { lastScanAt: 100 });
      await writeMeta(db, { quotaExceeded: true });
      const meta = await readMeta(db);
      expect(meta.id).toBe("main");
      expect(meta.lastScanAt).toBe(100);
      expect(meta.quotaExceeded).toBe(true);
      db.close();
    });

    it("writeMeta overwrites the same field, leaves others untouched", async () => {
      const db = await openDb(factory);
      await writeMeta(db, { lastScanAt: 100, lastSuccessAt: 100 });
      await writeMeta(db, { lastScanAt: 200 });
      const meta = await readMeta(db);
      expect(meta.lastScanAt).toBe(200);
      expect(meta.lastSuccessAt).toBe(100);
      db.close();
    });

    it("deleteMeta clears the row", async () => {
      const db = await openDb(factory);
      await writeMeta(db, { lastScanAt: 5 });
      await deleteMeta(db);
      expect(await readMeta(db)).toBeNull();
      db.close();
    });
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
