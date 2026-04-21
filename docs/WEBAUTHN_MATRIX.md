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

Run (paste the whole block):

```js
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
console.log("PRF at enroll:", cred.getClientExtensionResults().prf);
window.__smokeCred = cred;
window.__smokeSalt = salt;
```

Expected: Face ID prompt → `prf.results.first` is a `ArrayBuffer` of 32 bytes.

Failure modes to flag below:
- Prompt never appears → PRF not supported (document the iOS version).
- Prompt appears but `prf.results` is `undefined` → PRF not wired (same).
- Prompt appears but `results.first` is zero-bytes or very short → bug, stop.

### 4. Unlock — cold (fresh session)

Force-quit the PWA (swipe up) and reopen. Then:

```js
const out = await navigator.credentials.get({
  publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rpId: location.hostname,
    userVerification: "required",
    allowCredentials: [{ type: "public-key", id: window.__smokeCred.rawId }],
    extensions: { prf: { eval: { first: window.__smokeSalt } } }
  }
});
console.log("PRF at unlock:", out.getClientExtensionResults().prf);
```

Expected: same 32-byte value as enroll. Determinism is what makes PRF
useful as a seed-wrap key.

### 5. Restart test

- Force-quit. Kill Safari. Reboot iPhone. Reopen PWA from the home screen.
- Run step 4 again with a fresh challenge. Same value?

Expected: yes. If no, the authenticator lost state across reboot — biometric
wrap cannot be trusted on this device class.

## Results log

Fill a row per device tested. One row is enough to unblock Sub-fase 2.

| Date | Device | iOS | Safari | Step 2 | Step 3 | Step 4 | Step 5 | Notes |
|------|--------|-----|--------|--------|--------|--------|--------|-------|
| YYYY-MM-DD | iPhone ... | 18.x | 18.x | pass/fail | pass/fail | pass/fail | pass/fail | |

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

## What this test does NOT cover

- Android Chrome (PIN-only fallback is known good there, PRF support
  varies per vendor).
- Desktop browsers (PIN-only by design — no platform authenticator in the
  wallet's sense).
- iOS Safari tab (not PWA). The wallet only ships as a PWA.
- iCloud backup behavior for the underlying credential. The plan's Tela 1
  copy already warns that PWA data does not enter iCloud backup.

If any of those become necessary, add a new log row with the variant, run
the same 5 steps, and document deltas.
