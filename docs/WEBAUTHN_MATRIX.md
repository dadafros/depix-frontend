# WebAuthn PRF Smoke Matrix

Pre-flight smoke test for Phase 1 Wallet. **Purpose:** prove that WebAuthn
`PublicKeyCredential.create()` + `.get()` with the `prf` extension works on a
real iOS PWA installed standalone. If PRF fails on this baseline, the wallet
falls back to PIN-only and the biometric enrollment screen is silently skipped
on that device class.

This is an **internal** document. Keep it under `docs/` but not linked from
any public page.

## Why only one device is required here

SideSwap (our technical reference) does not maintain a formal multi-device
matrix. The goal of this document is to confirm that the floor device
(iPhone on iOS 18+ with passcode set and Face/Touch ID registered) unlocks
the happy path. Anything below that floor (older iOS, Android, desktop)
falls back to PIN-only — which is also tested, but not here.

Additional devices are added **reactively** when a user reports a
concrete problem on a combination we don't yet cover.

## Procedure

Run once before merging Sub-fase 2 (wallet module). Refresh before each
release that touches `wallet/wallet-biometric.js` or the WebAuthn calls in
`wallet/wallet-ui.js`.

### 1. Setup

- Device: 1 real iPhone, iOS 18+ (not a simulator — the simulator does not
  expose a platform authenticator).
- Install DePix as a standalone PWA (Safari → Share → Add to Home Screen).
- Ensure a device passcode is set and Face ID / Touch ID is registered in
  Settings.

### 2. Feature detection

Open DePix (PWA, not Safari tab). Open the DevTools via
`Mac Safari → Develop → <iPhone> → DePix` and run:

```js
await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
// expected: true
```

If `false`, stop. The device is below the floor.

### 3. Enroll credential with PRF

The blocks below wrap everything in an async IIFE because Safari's Web
Inspector console does not accept top-level `await` — without the IIFE
the parser treats `await` as an identifier and throws `SyntaxError:
Unexpected identifier 'navigator'`.

Run (paste the whole block):

```js
(async () => {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: "DePix", id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "smoke@depixapp.com",
        displayName: "Smoke Test"
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 }
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "discouraged"
      },
      extensions: { prf: { eval: { first: salt } } }
    }
  });
  const prf = cred.getClientExtensionResults().prf;
  console.log("PRF at enroll:", prf);
  // Persist to localStorage so steps 4 and 5 still have access after the
  // PWA is force-quit or the device reboots — window globals do not
  // survive process kill.
  localStorage.setItem("smokeSalt", [...salt].join(","));
  localStorage.setItem("smokeCredId", [...new Uint8Array(cred.rawId)].join(","));
  if (prf?.results?.first) {
    const first8 = [...new Uint8Array(prf.results.first)]
      .slice(0, 8)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    localStorage.setItem("smokePrfFirst8", first8);
    console.log("enroll PRF first 8 bytes hex:", first8);
  }
})();
```

Expected: iOS passkey sheet → Face ID prompt → `prf.results.first` is an
`ArrayBuffer` of 32 bytes. iOS 18+ always shows the "Add a Passkey?" sheet
for a platform authenticator even with `residentKey: "discouraged"` —
tap "Add Passkey" and continue. The resulting `smoke@depixapp.com` entry
lives in iOS Settings → Passwords and should be deleted after step 5 (see
Cleanup below).

Failure modes to flag below:
- Prompt never appears → PRF not supported (document the iOS version).
- Prompt appears but `prf.results` is `undefined` → PRF not wired (same).
- Prompt appears but `results.first` is zero-bytes or very short → bug, stop.

### 4. Unlock — cold (fresh session)

Force-quit the PWA (swipe up and drag off screen), reopen from the home
screen, reopen Web Inspector via
`Mac Safari → Develop → <iPhone> → DePix`, then paste:

```js
(async () => {
  const salt = new Uint8Array(localStorage.getItem("smokeSalt").split(",").map(Number));
  const credId = new Uint8Array(localStorage.getItem("smokeCredId").split(",").map(Number));
  const out = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: credId }],
      extensions: { prf: { eval: { first: salt } } }
    }
  });
  const prf = out.getClientExtensionResults().prf;
  console.log("PRF at unlock:", prf);
  if (prf?.results?.first) {
    const first8 = [...new Uint8Array(prf.results.first)]
      .slice(0, 8)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    const expected = localStorage.getItem("smokePrfFirst8");
    console.log(
      "unlock PRF first 8 bytes hex:",
      first8,
      "expected:",
      expected,
      first8 === expected ? "MATCH" : "MISMATCH"
    );
  }
})();
```

Expected: same 32-byte value as enroll (`MATCH`). Determinism is what
makes PRF useful as a seed-wrap key.

### 5. Restart test

- Force-quit PWA, kill Safari, reboot iPhone, reopen PWA from the home
  screen, reopen Web Inspector.
- Run the step 4 block again (salt + credential id are in `localStorage`,
  which survives reboot).

Expected: `MATCH`. If `MISMATCH`, the authenticator lost state across
reboot — biometric wrap cannot be trusted on this device class.

### 6. Cleanup

After filling the results row:

```js
localStorage.removeItem("smokeSalt");
localStorage.removeItem("smokeCredId");
localStorage.removeItem("smokePrfFirst8");
```

Then iOS Settings → Passwords → search `depixapp.com` → delete the
`smoke@depixapp.com` entry.

## Results log

Fill a row per device tested. One row is enough to unblock Sub-fase 2. Sub-fase 1 (backend proxy, wallet scaffold) does **not** require a completed row — this smoke gates Sub-fase 2 (biometric enrollment UX) only.

| Date       | Device            | iOS     | Safari  | Step 2 | Step 3 | Step 4 | Step 5 | Notes |
|------------|-------------------|---------|---------|--------|--------|--------|--------|-------|
| 2026-04-22 | iPhone 15 Pro Max | 26.2.1  | 26.2.1  | pass   | pass   | pass   | fail   | PRF non-deterministic across reboot with iCloud Keychain sync active. Same salt + cred id: pre-reboot `f4eef31bee01a096`, post-reboot `f4ccf31bcc01a096` (bytes 1 and 4 differ by `0x22`). PRF is deterministic *within* a session (verified with repeat unlock) — only breaks at the reboot boundary. See "Decision: biometric wrap not shipped" below. |

## Interpretation

- **All four pass** → PRF path is viable on the floor device. Biometric
  enrollment screen is shown; `wallet-biometric.js:isAvailable()` can trust
  the functional test it performs at enroll time.
- **Step 2 fails** → device doesn't meet floor; expected, PIN-only.
- **Step 3 fails** → Safari iOS on that version does not support PRF. Ship
  wallet with biometric screen **hidden** until at least one iOS version
  passes. Biometric is opt-in on a device basis.
- **Step 4 or 5 fails but 3 passes** → do not ship biometric. Biometric
  decrypt across sessions is the whole point.

## Decision: biometric wrap not shipped (2026-04-22)

The floor-device smoke test showed PRF is not stable across reboot when
iCloud Keychain is active (which is the default on iOS and used by ~all
of the BR-consumer target segment). Apple's Passwords doc explicitly
confirms the passkey is synced/backed-up via iCloud Keychain — on reboot
the device appears to re-hydrate the passkey from iCloud, and the PRF
output changes with some structured delta (not random noise). Within a
session PRF is deterministic; across reboots it is not.

Consequence for Phase 1 wallet:

- **Biometric-wrap of the wallet seed is not viable.** Users who reboot
  would lose wallet access on every reboot.
- **PIN + Argon2id is the only wrap path** shipped (Sub-fase 2+).
- The biometric enrollment screen is either hidden or gated behind a
  disabled feature flag. Leaving the `wallet-biometric.js` code behind
  a flag lets us re-enable it cheaply if Apple changes behaviour
  (unlikely short term — this is how the API works, not a bug in one
  iOS version).
- Re-run this smoke test when Apple releases a subsequent major iOS and
  refresh the row if behaviour changes. Until then, biometric stays off.

## What this test does NOT cover

- Android Chrome (PIN-only fallback is known good there, PRF support
  varies per vendor).
- Desktop browsers (PIN-only by design — no platform authenticator in the
  wallet's sense).
- iOS Safari tab (not PWA). The wallet only ships as a PWA.
- iCloud backup behavior for the app's own localStorage. The plan's
  Tela 1 copy already warns that PWA localStorage does not enter iCloud
  backup. Note the **passkey itself** does sync via iCloud Keychain — that
  sync is what broke determinism in step 5 of the 2026-04-22 smoke run.

If any of those become necessary, add a new log row with the variant, run
the same 5 steps, and document deltas.
