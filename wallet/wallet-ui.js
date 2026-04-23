// Wallet onboarding UI — create + restore flows.
//
// Two surfaces coexist in this file:
//
//   1. Pure helpers (selectChallengeIndices, buildChallengeOptions,
//      filterBip39Words, isPinInputValid, classifyLockoutState). These are
//      exported for unit tests; the DOM registration uses them but they have
//      no DOM dependencies themselves.
//
//   2. `registerWalletRoutes({ route, navigate, wallet, ... })` — wires up
//      the 11 `#wallet-*` route handlers and their DOM listeners. Called once,
//      at bootstrap time, from the host app (script.js via the bundle loader).
//
// Flow state lives in a single in-memory object inside the closure — not
// localStorage. Crossing screens without re-entering data is fine; reloading
// mid-onboarding starts over. That matches the threat model: a half-created
// wallet is better lost than persisted in plaintext.

import { BIP39_WORDLIST } from "./bip39-wordlist.js";
import { isWalletError, ERROR_CODES } from "./wallet-errors.js";
import {
  MAX_PIN_ATTEMPTS,
  MIN_PIN_LENGTH,
  MAX_PIN_LENGTH
} from "./constants.js";
import {
  DISPLAY_ORDER,
  getAssetByIdentifier,
  convertSatsToBrl,
  formatAssetAmount
} from "./asset-registry.js";

// --------------------------------------------------------------------------
// Pure helpers — exported for tests.
// --------------------------------------------------------------------------

/**
 * Pick `n` distinct indices in the range [0, pool). Return them sorted.
 *
 * Used to choose which word positions (out of 12) the user is quizzed on.
 * `rand` defaults to Math.random but tests inject a deterministic PRNG.
 */
export function selectChallengeIndices(pool, n, rand = Math.random) {
  if (typeof pool !== "number" || pool < 1) throw new RangeError("pool");
  if (typeof n !== "number" || n < 0) throw new RangeError("n");
  if (n > pool) throw new RangeError("n > pool");
  const used = new Set();
  // Safety cap: bound the loop so a pathological PRNG (always-same-value, etc.)
  // cannot hang. 1000 iterations is >>> enough for any sane pool/n pair —
  // buildChallengeOptions uses the same guard.
  let safety = 1000;
  while (used.size < n && safety-- > 0) {
    used.add(Math.floor(rand() * pool));
  }
  if (used.size < n) {
    throw new Error("selectChallengeIndices: could not pick enough distinct indices");
  }
  return [...used].sort((a, b) => a - b);
}

/**
 * Return 3 word choices (1 correct + 2 distractors) in randomized order.
 * Distractors are pulled from the wordlist and must differ from the correct
 * word. Used to render the 4-position verification challenge.
 */
export function buildChallengeOptions(correctWord, wordlist, rand = Math.random) {
  if (typeof correctWord !== "string" || !correctWord) {
    throw new TypeError("correctWord");
  }
  if (!Array.isArray(wordlist) && typeof wordlist?.[0] !== "string") {
    throw new TypeError("wordlist");
  }
  const distractors = new Set();
  let safety = 1000;
  while (distractors.size < 2 && safety-- > 0) {
    const w = wordlist[Math.floor(rand() * wordlist.length)];
    if (w && w !== correctWord) distractors.add(w);
  }
  const options = [correctWord, ...distractors];
  // Fisher-Yates.
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return options;
}

/**
 * Case-insensitive BIP39 prefix filter for restore autocomplete.
 * Returns up to `limit` entries starting with `prefix`.
 */
export function filterBip39Words(prefix, wordlist = BIP39_WORDLIST, limit = 8) {
  if (typeof prefix !== "string" || prefix.length === 0) return [];
  const p = prefix.toLowerCase();
  const out = [];
  for (const w of wordlist) {
    if (w.startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * A syntactically valid 6-digit numeric PIN. Does NOT call assertStrongPin —
 * that happens in wallet-crypto during createWallet.
 */
export function isPinInputValid(pin) {
  if (typeof pin !== "string") return false;
  if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) return false;
  return /^\d+$/.test(pin);
}

/**
 * Classify the progressive-lockout UX state the caller should render.
 *   - "rate-limited"  : waiting for cooldown
 *   - "final-modal"   : 1 attempt left, caller should gate with red modal
 *   - "warning"       : 2 attempts left, caller should show amber banner
 *   - "discreet"      : >2 attempts left, inline "N tentativas restantes"
 *   - "none"          : already wiped or not engaged
 */
export function classifyLockoutState({
  attempts = 0,
  rateLimitUntil = 0,
  now = Date.now(),
  max = MAX_PIN_ATTEMPTS
} = {}) {
  if (rateLimitUntil > now) return "rate-limited";
  const remaining = max - attempts;
  if (remaining <= 0) return "none";
  if (remaining === 1) return "final-modal";
  if (remaining === 2) return "warning";
  return "discreet";
}

/**
 * Compute the 4-byte SHA-256 fingerprint of a wallet descriptor, formatted
 * as "XXXX-XXXX" (uppercase hex with a hyphen in the middle).
 *
 * Used as a short, human-readable "wallet identity" the user can write down
 * alongside the 12 seed words. On restore, the same derivation runs and the
 * user compares visually against their note.
 *
 * Space = 2^32 ≈ 4B possibilities — more than enough to distinguish one
 * wallet from another. Not a BIP standard; the `?` help modal makes clear
 * it's a DepixApp-generated fingerprint, not a secret.
 *
 * Returns "" for empty/non-string input. Async because Web Crypto is async.
 */
export async function computeFingerprint(descriptor) {
  if (typeof descriptor !== "string" || !descriptor) return "";
  const bytes = new TextEncoder().encode(descriptor);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const u8 = new Uint8Array(hash, 0, 4);
  const hex = Array.from(u8)
    .map(b => b.toString(16).padStart(2, "0").toUpperCase())
    .join("");
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

// --------------------------------------------------------------------------
// DOM registration.
// --------------------------------------------------------------------------

// Trim whitespace, collapse internal runs of spaces, lowercase.
function normalizeMnemonicString(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function splitMnemonic(s) {
  return normalizeMnemonicString(s).split(" ").filter(Boolean);
}

function q(id) {
  return document.getElementById(id);
}

function showMsg(id, text, kind) {
  const el = q(id);
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("success", "error", "warning");
  if (text && kind) el.classList.add(kind);
}

function clearMsg(id) {
  showMsg(id, "", null);
}

function renderError(id, err) {
  const msg = err?.message || "Não foi possível completar a ação. Tente novamente.";
  showMsg(id, msg, "error");
}

/**
 * Register the 11 `#wallet-*` routes on the provided router. Idempotent —
 * safe to call twice (second call simply overwrites handlers).
 *
 * Required deps:
 *   - route(hash, handler)         from router.js
 *   - navigate(hash)               from router.js
 *   - wallet                        the wallet module (createWallet, etc.)
 *   - showToast(text)              optional, used for non-blocking feedback
 */
export function registerWalletRoutes({
  route,
  navigate,
  wallet,
  quotes = null,
  showToast = null,
  getRandom = null,
  doc = null,
  win = null
} = {}) {
  if (typeof route !== "function") throw new TypeError("route");
  if (typeof navigate !== "function") throw new TypeError("navigate");
  if (!wallet || typeof wallet.createWallet !== "function") {
    throw new TypeError("wallet");
  }
  const rand = getRandom ?? Math.random;
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  const w = win ?? (typeof window !== "undefined" ? window : null);
  if (!d) throw new Error("registerWalletRoutes: document not available");

  // Scratch state carried across create/restore screens. Cleared at the end
  // of each flow. Never persisted.
  const state = {
    pendingMnemonic: null,
    pendingPin: null,
    pendingDescriptor: null, // set by restore "Validar e avançar"; consumed by confirm-identity
    challenge: null, // { positions: number[], options: string[][], answered: boolean[] }
    restoreWords: new Array(12).fill(""),
    error: ""
  };

  function resetFlowState() {
    state.pendingMnemonic = null;
    state.pendingPin = null;
    state.pendingDescriptor = null;
    state.challenge = null;
    state.restoreWords = new Array(12).fill("");
    state.error = "";
  }

  // ====================================================================
  // #wallet-gate — root of the flow. Branches into create/restore/existing.
  // ====================================================================
  route("#wallet-gate", async () => {
    clearMsg("wallet-gate-msg");
    const gateExisting = q("wallet-gate-existing");
    const gateNew = q("wallet-gate-new");
    try {
      const exists = await wallet.hasWallet();
      if (exists) {
        gateExisting?.classList.remove("hidden");
        gateNew?.classList.add("hidden");
      } else {
        gateExisting?.classList.add("hidden");
        gateNew?.classList.remove("hidden");
      }
    } catch (err) {
      renderError("wallet-gate-msg", err);
    }
  });

  q("wallet-gate-create")?.addEventListener("click", () => {
    resetFlowState();
    navigate("#wallet-create-intro");
  });
  q("wallet-gate-restore")?.addEventListener("click", () => {
    resetFlowState();
    navigate("#wallet-restore-input");
  });
  q("wallet-gate-existing-home")?.addEventListener("click", () => {
    navigate("#home");
  });

  // ====================================================================
  // #wallet-create-intro — consent checkboxes. Both must be ticked.
  // ====================================================================
  route("#wallet-create-intro", () => {
    const cb1 = q("wallet-create-consent-1");
    const cb2 = q("wallet-create-consent-2");
    const btn = q("wallet-create-intro-continue");
    if (cb1) cb1.checked = false;
    if (cb2) cb2.checked = false;
    if (btn) btn.disabled = true;
    clearMsg("wallet-create-intro-msg");
  });

  function refreshIntroButton() {
    const cb1 = q("wallet-create-consent-1");
    const cb2 = q("wallet-create-consent-2");
    const btn = q("wallet-create-intro-continue");
    if (btn) btn.disabled = !(cb1?.checked && cb2?.checked);
  }
  q("wallet-create-consent-1")?.addEventListener("change", refreshIntroButton);
  q("wallet-create-consent-2")?.addEventListener("change", refreshIntroButton);

  q("wallet-create-intro-continue")?.addEventListener("click", async () => {
    try {
      clearMsg("wallet-create-intro-msg");
      if (!state.pendingMnemonic) {
        state.pendingMnemonic = await wallet.generateMnemonic();
      }
      navigate("#wallet-create-seed");
    } catch (err) {
      renderError("wallet-create-intro-msg", err);
    }
  });

  q("wallet-create-intro-back")?.addEventListener("click", () => {
    resetFlowState();
    navigate("#wallet-gate");
  });

  // ====================================================================
  // #wallet-create-seed — render the 12 words in a grid + wallet identity.
  // ====================================================================
  route("#wallet-create-seed", async () => {
    const grid = q("wallet-create-seed-grid");
    if (!grid) return;
    clearMsg("wallet-create-seed-msg");
    if (!state.pendingMnemonic) {
      navigate("#wallet-create-intro");
      return;
    }
    const words = splitMnemonic(state.pendingMnemonic);
    grid.textContent = "";
    words.forEach((word, i) => {
      const cell = d.createElement("div");
      cell.className = "wallet-seed-cell";
      cell.setAttribute("role", "listitem");
      cell.setAttribute("aria-label", `Palavra ${i + 1}: ${word}`);
      const n = d.createElement("span");
      n.className = "wallet-seed-index";
      n.textContent = String(i + 1);
      const w = d.createElement("span");
      w.className = "wallet-seed-word";
      w.textContent = word;
      cell.appendChild(n);
      cell.appendChild(w);
      grid.appendChild(cell);
    });
    // Derive + show the wallet identity fingerprint alongside the 12 words
    // so the user writes both down in one go. LWK is already loaded (the
    // intro click awaited generateMnemonic), so this is effectively free.
    const identityEl = q("wallet-create-identity-value");
    if (identityEl) {
      identityEl.textContent = "…";
      try {
        const descriptor = await wallet.deriveDescriptor(state.pendingMnemonic);
        identityEl.textContent = await computeFingerprint(descriptor);
      } catch {
        // The 12 words are the primary artifact — never let an identity
        // failure block the seed display. Fall back to a discreet placeholder.
        identityEl.textContent = "—";
      }
    }
  });

  q("wallet-create-seed-continue")?.addEventListener("click", () => {
    if (!state.pendingMnemonic) {
      navigate("#wallet-create-intro");
      return;
    }
    const words = splitMnemonic(state.pendingMnemonic);
    const positions = selectChallengeIndices(12, 4, rand);
    const options = positions.map(i => buildChallengeOptions(words[i], BIP39_WORDLIST, rand));
    state.challenge = {
      positions,
      options,
      answered: new Array(positions.length).fill(null)
    };
    navigate("#wallet-create-verify");
  });

  q("wallet-create-seed-back")?.addEventListener("click", () => {
    navigate("#wallet-create-intro");
  });

  // ====================================================================
  // #wallet-create-verify — 4 position quiz.
  // ====================================================================
  route("#wallet-create-verify", () => {
    const host = q("wallet-create-verify-host");
    if (!host) return;
    // Modal lives outside the section so the router's hide doesn't clear it.
    // Re-entry (user bailed, clicked menu, came back) must start with it hidden.
    q("wallet-create-verify-modal")?.classList.add("hidden");
    clearMsg("wallet-create-verify-msg");
    if (!state.challenge || !state.pendingMnemonic) {
      navigate("#wallet-create-seed");
      return;
    }
    const words = splitMnemonic(state.pendingMnemonic);
    host.textContent = "";
    state.challenge.positions.forEach((pos, idx) => {
      const block = d.createElement("div");
      block.className = "wallet-verify-block";
      const label = d.createElement("div");
      label.className = "wallet-verify-label";
      label.textContent = `Qual é a palavra nº ${pos + 1}?`;
      const row = d.createElement("div");
      row.className = "wallet-verify-options";
      const options = state.challenge.options[idx];
      options.forEach(option => {
        const btn = d.createElement("button");
        btn.type = "button";
        btn.className = "wallet-verify-option";
        btn.textContent = option;
        btn.addEventListener("click", () => {
          const correct = option === words[pos];
          if (!correct) {
            q("wallet-create-verify-modal")?.classList.remove("hidden");
            return;
          }
          btn.classList.add("selected");
          block.querySelectorAll("button.wallet-verify-option").forEach(other => {
            if (other !== btn) other.disabled = true;
          });
          state.challenge.answered[idx] = true;
          if (state.challenge.answered.every(Boolean)) {
            navigate("#wallet-create-pin");
          }
        });
        row.appendChild(btn);
      });
      block.appendChild(label);
      block.appendChild(row);
      host.appendChild(block);
    });
  });

  q("wallet-create-verify-modal-dismiss")?.addEventListener("click", () => {
    q("wallet-create-verify-modal")?.classList.add("hidden");
    navigate("#wallet-create-seed");
  });

  q("wallet-create-verify-back")?.addEventListener("click", () => {
    navigate("#wallet-create-seed");
  });

  // ====================================================================
  // #wallet-create-pin — two-step PIN entry (enter then confirm).
  // ====================================================================
  route("#wallet-create-pin", () => {
    const input1 = q("wallet-create-pin-input");
    const input2 = q("wallet-create-pin-confirm");
    if (input1) input1.value = "";
    if (input2) input2.value = "";
    clearMsg("wallet-create-pin-msg");
  });

  q("wallet-create-pin-submit")?.addEventListener("click", async () => {
    clearMsg("wallet-create-pin-msg");
    const pin = q("wallet-create-pin-input")?.value ?? "";
    const confirm = q("wallet-create-pin-confirm")?.value ?? "";
    if (!isPinInputValid(pin)) {
      showMsg("wallet-create-pin-msg", "O PIN precisa ter 6 dígitos numéricos.", "error");
      return;
    }
    if (pin !== confirm) {
      showMsg("wallet-create-pin-msg", "A confirmação não bate com o PIN. Tente de novo.", "error");
      return;
    }
    if (!state.pendingMnemonic) {
      navigate("#wallet-create-intro");
      return;
    }
    const btn = q("wallet-create-pin-submit");
    if (btn) btn.disabled = true;
    try {
      await wallet.createWallet({
        pin,
        mnemonic: state.pendingMnemonic,
        enrollBiometric: false
      });
      // Seed is persisted (encrypted) and LWK holds the live Signer. No need
      // to keep the plaintext mnemonic in closure memory beyond this point.
      state.pendingMnemonic = null;
      state.pendingPin = pin;
      navigate("#wallet-create-biometric");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.WEAK_PIN)) {
        showMsg("wallet-create-pin-msg", "PIN muito comum ou previsível. Escolha outro.", "error");
      } else if (isWalletError(err, ERROR_CODES.WALLET_ALREADY_EXISTS)) {
        resetFlowState();
        navigate("#wallet-gate");
      } else {
        renderError("wallet-create-pin-msg", err);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  q("wallet-create-pin-back")?.addEventListener("click", () => {
    navigate("#wallet-create-verify");
  });

  // ====================================================================
  // #wallet-create-biometric — optional PRF enrollment.
  // ====================================================================
  route("#wallet-create-biometric", async () => {
    clearMsg("wallet-create-biometric-msg");
    const enrollBtn = q("wallet-create-biometric-enroll");
    const skipBtn = q("wallet-create-biometric-skip");
    // Plan Sub-fase 3 Tela 5: if PRF isn't available, the screen is skipped
    // silently — user proceeds with PIN-only, no "degraded" copy.
    let supported = false;
    try {
      supported = await wallet.biometricSupported();
    } catch {
      supported = false;
    }
    if (!supported) {
      state.pendingPin = null;
      navigate("#wallet-create-done");
      return;
    }
    enrollBtn?.classList.remove("hidden");
    if (skipBtn) skipBtn.disabled = false;
  });

  q("wallet-create-biometric-enroll")?.addEventListener("click", async () => {
    clearMsg("wallet-create-biometric-msg");
    const pin = state.pendingPin;
    if (!pin) {
      navigate("#wallet-create-pin");
      return;
    }
    const btn = q("wallet-create-biometric-enroll");
    if (btn) btn.disabled = true;
    let enrolled = false;
    try {
      await wallet.addBiometric(pin);
      enrolled = true;
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.BIOMETRIC_REJECTED)) {
        showMsg("wallet-create-biometric-msg", "Autenticação cancelada. Você pode ativar mais tarde.", "warning");
      } else {
        renderError("wallet-create-biometric-msg", err);
      }
    } finally {
      if (btn) btn.disabled = false;
      if (enrolled) {
        // PIN is no longer needed for any subsequent onboarding step — zero it
        // out before we leave this screen so the biometric view is the last
        // place it lives in memory.
        state.pendingPin = null;
      }
    }
    if (enrolled) navigate("#wallet-create-done");
  });

  q("wallet-create-biometric-skip")?.addEventListener("click", () => {
    state.pendingPin = null;
    navigate("#wallet-create-done");
  });

  // ====================================================================
  // #wallet-create-done — success.
  // ====================================================================
  route("#wallet-create-done", () => {
    state.pendingMnemonic = null;
    state.pendingPin = null;
    state.challenge = null;
    if (showToast) showToast("Carteira criada com sucesso.");
  });

  q("wallet-create-done-home")?.addEventListener("click", () => {
    resetFlowState();
    persistHomeMode("wallet");
    navigate("#home");
  });

  // ====================================================================
  // #wallet-restore-input — 12 typed inputs with autocomplete.
  // ====================================================================
  route("#wallet-restore-input", () => {
    const grid = q("wallet-restore-grid");
    if (!grid) return;
    // Honor a transient error set by a failed PIN-submit (bad checksum
    // surfacing late — plan positions this error on THIS screen, not the
    // PIN screen where "combinação" would be read as PIN+confirm).
    if (state.error) {
      showMsg("wallet-restore-input-msg", state.error, "error");
      state.error = "";
    } else {
      clearMsg("wallet-restore-input-msg");
    }
    grid.textContent = "";
    for (let i = 0; i < 12; i++) {
      const cell = d.createElement("div");
      cell.className = "wallet-restore-cell";

      const idx = d.createElement("span");
      idx.className = "wallet-restore-index";
      idx.textContent = String(i + 1);

      const wrapper = d.createElement("div");
      wrapper.className = "wallet-restore-input-wrapper";

      const input = d.createElement("input");
      input.type = "text";
      input.id = `wallet-restore-input-${i}`;
      input.className = "wallet-restore-input";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      // iOS Safari applies autocorrect independently of spellcheck and will
      // silently replace BIP39 words with English substitutions
      // ("abandon" → "abandoned"). Explicit attribute needed.
      input.setAttribute("autocorrect", "off");
      input.inputMode = "text";
      input.setAttribute("aria-label", `Palavra ${i + 1}`);
      input.value = state.restoreWords[i] || "";

      const dropdown = d.createElement("div");
      dropdown.className = "wallet-restore-dropdown hidden";
      dropdown.id = `wallet-restore-dropdown-${i}`;

      function closeDropdown() {
        dropdown.classList.add("hidden");
        dropdown.textContent = "";
      }
      function commitValue(val) {
        const clean = String(val || "").trim().toLowerCase();
        input.value = clean;
        state.restoreWords[i] = clean;
        validateCell(clean);
        closeDropdown();
      }
      function validateCell(val) {
        const clean = val.trim().toLowerCase();
        if (!clean) {
          input.classList.remove("invalid");
          return;
        }
        if (BIP39_WORDLIST.includes(clean)) {
          input.classList.remove("invalid");
        } else {
          input.classList.add("invalid");
        }
      }

      input.addEventListener("input", () => {
        const raw = input.value.trim().toLowerCase();
        // Keep the visible value in sync with the canonical form — otherwise
        // a user typing 'ABAN' sees 'ABAN' in the field while state has
        // 'aban', confusing anyone with first-letter auto-cap keyboards.
        if (input.value !== raw) input.value = raw;
        state.restoreWords[i] = raw;
        // Plan: autocomplete fires after 3+ chars.
        if (raw.length < 3) {
          closeDropdown();
          validateCell(raw);
          return;
        }
        const matches = filterBip39Words(raw, BIP39_WORDLIST, 6);
        dropdown.textContent = "";
        if (matches.length === 0) {
          closeDropdown();
          validateCell(raw);
          return;
        }
        matches.forEach(m => {
          const opt = d.createElement("button");
          opt.type = "button";
          opt.className = "wallet-restore-option";
          opt.textContent = m;
          opt.addEventListener("mousedown", evt => {
            evt.preventDefault();
            commitValue(m);
            const next = q(`wallet-restore-input-${i + 1}`);
            if (next) next.focus();
          });
          dropdown.appendChild(opt);
        });
        dropdown.classList.remove("hidden");
        validateCell(raw);
      });
      // Plan Sub-fase 3 Restore Tela 1: "Sem paste. User precisa digitar cada
      // palavra" — paste exposes users to clipboard-sniffing and short-
      // circuits the letter-by-letter verification.
      input.addEventListener("paste", evt => {
        evt.preventDefault();
        showMsg(
          "wallet-restore-input-msg",
          "Digite cada palavra — colar não é permitido.",
          "warning"
        );
      });
      input.addEventListener("blur", () => {
        setTimeout(() => closeDropdown(), 100);
        validateCell(input.value);
      });
      input.addEventListener("keydown", evt => {
        if (evt.key === "Enter" || evt.key === "Tab") {
          const raw = input.value.trim().toLowerCase();
          const matches = filterBip39Words(raw, BIP39_WORDLIST, 1);
          if (matches.length === 1) commitValue(matches[0]);
          closeDropdown();
        }
      });

      wrapper.appendChild(input);
      wrapper.appendChild(dropdown);
      cell.appendChild(idx);
      cell.appendChild(wrapper);
      grid.appendChild(cell);
    }
  });

  q("wallet-restore-input-continue")?.addEventListener("click", async () => {
    clearMsg("wallet-restore-input-msg");
    const words = state.restoreWords.map(w => (w || "").trim().toLowerCase());
    if (words.some(w => !w)) {
      showMsg("wallet-restore-input-msg", "Preencha todas as 12 palavras.", "error");
      return;
    }
    if (words.some(w => !BIP39_WORDLIST.includes(w))) {
      showMsg(
        "wallet-restore-input-msg",
        "Uma ou mais palavras estão com erro de digitação. Confira cuidadosamente.",
        "error"
      );
      return;
    }
    const mnemonicStr = words.join(" ");
    // Checksum validation via LWK. First call triggers WASM load (~9 MB) —
    // surface that as an explicit "Validando…" state instead of leaving a
    // silent async gap or deferring until after PIN entry.
    const btn = q("wallet-restore-input-continue");
    const originalLabel = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Validando…";
    }
    try {
      // deriveDescriptor does everything validateMnemonic does (checksum)
      // plus gives us the descriptor we need for the identity confirmation
      // screen. Single call, no double-parse.
      const descriptor = await wallet.deriveDescriptor(mnemonicStr);
      state.pendingMnemonic = mnemonicStr;
      state.pendingDescriptor = descriptor;
      navigate("#wallet-restore-confirm-identity");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.INVALID_MNEMONIC)) {
        showMsg(
          "wallet-restore-input-msg",
          "Essa combinação de 12 palavras não passou na verificação. Quase sempre é um erro de digitação ou de ordem — confira cada palavra com sua anotação.",
          "error"
        );
      } else {
        renderError("wallet-restore-input-msg", err);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    }
  });

  q("wallet-restore-input-back")?.addEventListener("click", () => {
    navigate("#wallet-gate");
  });

  // ====================================================================
  // #wallet-restore-confirm-identity — show the derived fingerprint and
  // ask the user to verify it matches what they wrote down before the
  // restore actually persists a new wallet. Closes the 1-in-16 BIP39
  // false-positive gap: a typo that happens to checksum correctly will
  // still produce a different fingerprint from what the user noted.
  // ====================================================================
  route("#wallet-restore-confirm-identity", async () => {
    if (!state.pendingDescriptor) {
      // Direct hash entry (bookmark / URL edit) — nothing to confirm.
      navigate("#wallet-restore-input");
      return;
    }
    const el = q("wallet-restore-confirm-identity-value");
    if (el) {
      el.textContent = "…";
      try {
        el.textContent = await computeFingerprint(state.pendingDescriptor);
      } catch {
        el.textContent = "—";
      }
    }
  });

  q("wallet-restore-confirm-yes")?.addEventListener("click", () => {
    navigate("#wallet-restore-pin");
  });

  q("wallet-restore-confirm-back")?.addEventListener("click", () => {
    // State preserved: restoreWords stay, pendingDescriptor stays (will be
    // recomputed on next "Validar e avançar" if the user edits a word).
    // The input screen reads state.error on render — surface a hint so the
    // user knows why they came back (otherwise the screen looks neutral and
    // the click seems unacknowledged).
    state.error = "A identidade gerada não bateu com a que você anotou. Revise cada palavra — uma pequena diferença muda toda a carteira.";
    navigate("#wallet-restore-input");
  });

  // ====================================================================
  // #wallet-restore-pin — PIN for the restored wallet.
  // ====================================================================
  route("#wallet-restore-pin", () => {
    const input1 = q("wallet-restore-pin-input");
    const input2 = q("wallet-restore-pin-confirm");
    if (input1) input1.value = "";
    if (input2) input2.value = "";
    clearMsg("wallet-restore-pin-msg");
  });

  q("wallet-restore-pin-submit")?.addEventListener("click", async () => {
    clearMsg("wallet-restore-pin-msg");
    const pin = q("wallet-restore-pin-input")?.value ?? "";
    const confirm = q("wallet-restore-pin-confirm")?.value ?? "";
    if (!isPinInputValid(pin)) {
      showMsg("wallet-restore-pin-msg", "O PIN precisa ter 6 dígitos numéricos.", "error");
      return;
    }
    if (pin !== confirm) {
      showMsg("wallet-restore-pin-msg", "A confirmação não bate com o PIN. Tente de novo.", "error");
      return;
    }
    if (!state.pendingMnemonic) {
      navigate("#wallet-restore-input");
      return;
    }
    const btn = q("wallet-restore-pin-submit");
    if (btn) btn.disabled = true;
    try {
      await wallet.restoreWallet({
        mnemonic: state.pendingMnemonic,
        pin,
        enrollBiometric: false
      });
      state.pendingPin = pin;
      navigate("#wallet-restore-biometric");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.WEAK_PIN)) {
        showMsg("wallet-restore-pin-msg", "PIN muito comum ou previsível. Escolha outro.", "error");
      } else if (isWalletError(err, ERROR_CODES.INVALID_MNEMONIC)) {
        // LWK's Mnemonic constructor validates checksum — by the time we
        // get here the user typed their PIN twice, so staying on this
        // screen with "Combinação inválida" reads as a PIN mismatch even
        // though it is about the 12 words. Send them back to the input
        // screen with an unambiguous message (plan Sub-fase 3 Restore
        // Tela 1: "Combinação inválida" is the intended copy THERE).
        state.error = "Essa combinação de 12 palavras não passou na verificação. Quase sempre é um erro de digitação ou de ordem — confira cada palavra com sua anotação.";
        navigate("#wallet-restore-input");
      } else if (isWalletError(err, ERROR_CODES.DESCRIPTOR_MISMATCH)) {
        // Plan Sub-fase 3 calls for a Continue/Cancel modal on the input
        // screen — full flow needs a wipe-without-old-PIN API path, tracked
        // as follow-up. For now we surface the plan's copy so the user knows
        // this is a distinct-wallet restore, not a typo.
        showMsg(
          "wallet-restore-pin-msg",
          "Esta recuperação vai criar uma carteira diferente da que estava aqui. Se as 12 palavras estão corretas, a carteira anterior tinha outra seed. Para prosseguir, remova a carteira existente.",
          "error"
        );
      } else {
        renderError("wallet-restore-pin-msg", err);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  q("wallet-restore-pin-back")?.addEventListener("click", () => {
    navigate("#wallet-restore-input");
  });

  // ====================================================================
  // #wallet-restore-biometric — optional PRF enrollment (mirror of create).
  // ====================================================================
  route("#wallet-restore-biometric", async () => {
    clearMsg("wallet-restore-biometric-msg");
    const enrollBtn = q("wallet-restore-biometric-enroll");
    // Mirror of create: silent skip when PRF isn't supported.
    let supported = false;
    try {
      supported = await wallet.biometricSupported();
    } catch {
      supported = false;
    }
    if (!supported) {
      state.pendingPin = null;
      navigate("#wallet-restore-done");
      return;
    }
    enrollBtn?.classList.remove("hidden");
  });

  q("wallet-restore-biometric-enroll")?.addEventListener("click", async () => {
    clearMsg("wallet-restore-biometric-msg");
    const pin = state.pendingPin;
    if (!pin) {
      navigate("#wallet-restore-pin");
      return;
    }
    const btn = q("wallet-restore-biometric-enroll");
    if (btn) btn.disabled = true;
    let enrolled = false;
    try {
      await wallet.addBiometric(pin);
      enrolled = true;
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.BIOMETRIC_REJECTED)) {
        showMsg("wallet-restore-biometric-msg", "Autenticação cancelada. Você pode ativar mais tarde.", "warning");
      } else {
        renderError("wallet-restore-biometric-msg", err);
      }
    } finally {
      if (btn) btn.disabled = false;
      if (enrolled) state.pendingPin = null;
    }
    if (enrolled) navigate("#wallet-restore-done");
  });

  q("wallet-restore-biometric-skip")?.addEventListener("click", () => {
    state.pendingPin = null;
    navigate("#wallet-restore-done");
  });

  // ====================================================================
  // #wallet-restore-done — success.
  // ====================================================================
  route("#wallet-restore-done", () => {
    state.pendingMnemonic = null;
    state.pendingPin = null;
    state.pendingDescriptor = null;
    state.restoreWords = new Array(12).fill("");
    if (showToast) showToast("Carteira restaurada com sucesso.");
  });

  q("wallet-restore-done-home")?.addEventListener("click", () => {
    resetFlowState();
    persistHomeMode("wallet");
    navigate("#home");
  });

  // ====================================================================
  // Wallet identity help modal — opened by the `?` button next to
  // "Identidade da carteira" on both the create-seed screen and the
  // restore-confirm-identity screen. One modal, two triggers.
  // ====================================================================
  function openIdentityInfoModal() {
    q("wallet-identity-info-modal")?.classList.remove("hidden");
  }
  q("wallet-create-identity-help")?.addEventListener("click", openIdentityInfoModal);
  q("wallet-restore-identity-help")?.addEventListener("click", openIdentityInfoModal);
  q("wallet-identity-info-close")?.addEventListener("click", () => {
    q("wallet-identity-info-modal")?.classList.add("hidden");
  });

  // ====================================================================
  // Wallet home panel — lives inside #home (telaCarteira). Driven by
  // CustomEvents `wallet-home:mount` / `wallet-home:unmount` dispatched
  // by script.js when the user toggles the 4-mode home switch.
  // ====================================================================
  const SYNC_INTERVAL_MS = 30_000;
  // Exponential backoff when Esplora rate-limits the wallet (HTTP 429).
  // Series: 60s → 120s → 240s → 480s → capped at 600s. Reset to 0 on the
  // first successful sync. The timer respects `nextSyncAllowedAt` and
  // skips ticks that fall inside the cool-down window.
  const RATE_LIMIT_BACKOFF_START_MS = 60_000;
  const RATE_LIMIT_BACKOFF_MAX_MS = 600_000;
  let homeSyncTimer = null;
  let homeMounted = false;
  let homeFilter = "all";
  let consecutiveRateLimits = 0;
  let nextSyncAllowedAt = 0;

  function persistHomeMode(mode) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("depix-home-mode", mode);
      }
    } catch { /* private mode / disabled */ }
  }

  function formatBrlNumber(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    return n.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // LWK wasm returns balances as a Map<AssetId, bigint|number>. Normalize
  // to a plain object keyed by asset id hex string so the rest of the UI
  // can iterate predictably in both the real bundle and the test mocks.
  function normalizeBalances(raw) {
    const out = Object.create(null);
    if (!raw) return out;
    const entries = typeof raw.entries === "function"
      ? raw.entries()
      : Array.isArray(raw) ? raw : null;
    if (entries) {
      for (const [k, v] of entries) {
        const keyStr = (k && typeof k.toString === "function") ? k.toString() : String(k);
        out[keyStr] = (typeof v === "bigint") ? v : BigInt(v ?? 0);
      }
      return out;
    }
    if (typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        out[k] = (typeof v === "bigint") ? v : BigInt(v ?? 0);
      }
    }
    return out;
  }

  async function renderWalletHomeBalances({ background = false } = {}) {
    const assetsHost = q("wallet-home-assets");
    const totalEl = q("wallet-home-total-brl");
    if (!assetsHost || !totalEl) return;
    if (!background) showMsg("wallet-home-msg", "", null);

    let balancesRaw;
    try {
      balancesRaw = await wallet.getBalances();
    } catch (err) {
      if (!background) renderError("wallet-home-msg", err);
      return;
    }
    const balances = normalizeBalances(balancesRaw);

    let quoteResult = null;
    if (quotes && typeof quotes.getQuotes === "function") {
      try {
        quoteResult = await quotes.getQuotes();
      } catch { /* quote fetch is best-effort */ }
    }
    const quoteValues = quoteResult?.quotes ?? null;

    assetsHost.textContent = "";
    let totalBrl = 0;
    let anyBrl = false;
    // If any asset with a non-zero balance couldn't convert (quote missing),
    // the partial sum would understate the total by orders of magnitude —
    // e.g. R$50 DePix + 100 USDt would show "R$ 50" when USDt can't convert.
    // Render "R$ —" whenever that happens; never a misleading partial.
    let anyMissingWithBalance = false;
    for (const asset of DISPLAY_ORDER) {
      const sats = balances[asset.id] ?? 0n;
      const brl = convertSatsToBrl(sats, asset, quoteValues);
      if (typeof brl === "number") {
        totalBrl += brl;
        anyBrl = true;
      } else if (sats > 0n) {
        anyMissingWithBalance = true;
      }
      const row = d.createElement("div");
      row.className = "wallet-home-asset";
      // Render the official brand logo via <img>. Source files live at
      // /icons/* (service-worker pre-cached) or /icon-192.png (DePix).
      // Set loading="lazy" as a cheap hint; at 36px these are tiny anyway.
      const icon = d.createElement("img");
      icon.className = "wallet-home-asset-icon";
      icon.src = asset.iconUrl;
      icon.alt = asset.symbol;
      icon.width = 36;
      icon.height = 36;
      icon.loading = "lazy";
      icon.decoding = "async";
      const body = d.createElement("div");
      body.className = "wallet-home-asset-body";
      const name = d.createElement("div");
      name.className = "wallet-home-asset-name";
      name.textContent = asset.symbol;
      const sub = d.createElement("div");
      sub.className = "wallet-home-asset-sub";
      sub.textContent = asset.name;
      body.appendChild(name);
      body.appendChild(sub);
      const amounts = d.createElement("div");
      amounts.className = "wallet-home-asset-amounts";
      const amount = d.createElement("div");
      amount.className = "wallet-home-asset-amount";
      amount.textContent = `${formatAssetAmount(sats, asset)} ${asset.symbol}`;
      const brlEl = d.createElement("div");
      brlEl.className = "wallet-home-asset-brl";
      brlEl.textContent = typeof brl === "number" ? formatBrlNumber(brl) : "—";
      amounts.appendChild(amount);
      amounts.appendChild(brlEl);
      row.appendChild(icon);
      row.appendChild(body);
      row.appendChild(amounts);
      assetsHost.appendChild(row);
    }
    totalEl.textContent = (anyBrl && !anyMissingWithBalance)
      ? formatBrlNumber(totalBrl)
      : "R$ —";

    if (quoteResult?.stale) {
      showMsg("wallet-home-msg", "Cotação com atraso. Valores em BRL podem estar desatualizados.", "warning");
    }
  }

  function updateSyncState(text, kind) {
    const el = q("wallet-home-sync-state");
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("success", "error", "warning");
    if (text && kind) el.classList.add(kind);
  }

  function formatBackoffSeconds(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    return `${m}min`;
  }

  async function syncAndRender({ background = false } = {}) {
    if (!homeMounted) return;
    if (!background) updateSyncState("Sincronizando…", null);
    try {
      await wallet.syncWallet();
      // Reset rate-limit state on any successful sync. Any prior 429 series
      // is considered resolved; the next failure starts backoff from 60s.
      consecutiveRateLimits = 0;
      nextSyncAllowedAt = 0;
      updateSyncState("Atualizado agora", "success");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.ESPLORA_RATE_LIMITED)) {
        consecutiveRateLimits++;
        const backoffMs = Math.min(
          RATE_LIMIT_BACKOFF_START_MS * 2 ** (consecutiveRateLimits - 1),
          RATE_LIMIT_BACKOFF_MAX_MS
        );
        nextSyncAllowedAt = Date.now() + backoffMs;
        updateSyncState(
          `Muitas sincronizações. Próxima tentativa em ${formatBackoffSeconds(backoffMs)}.`,
          "warning"
        );
      } else if (isWalletError(err, ERROR_CODES.ESPLORA_UNAVAILABLE)) {
        updateSyncState("Sem conexão com o servidor. Mostrando último saldo conhecido.", "warning");
      } else {
        updateSyncState("Falha na sincronização.", "error");
      }
    }
    await renderWalletHomeBalances({ background });
  }

  // `offsetParent === null` is true whenever any ancestor has `display: none`
  // (our `.hidden` class), so this catches BOTH a mode switch within #home
  // AND the router hiding the #home section entirely (navigation to
  // #wallet-receive etc.). homeMounted alone only flips on mode switch.
  function isWalletHomeVisible() {
    const host = q("telaCarteira");
    return !!host && host.offsetParent !== null;
  }

  function startHomeSyncTimer() {
    stopHomeSyncTimer();
    if (!w || typeof w.setInterval !== "function") return;
    homeSyncTimer = w.setInterval(() => {
      if (!homeMounted) return;
      if (d.visibilityState && d.visibilityState !== "visible") return;
      if (!isWalletHomeVisible()) return;
      // Respect the rate-limit backoff. Ticks inside the cool-down are
      // dropped silently; the user already sees "Próxima tentativa em Ns".
      if (Date.now() < nextSyncAllowedAt) return;
      void syncAndRender({ background: true });
    }, SYNC_INTERVAL_MS);
  }

  function stopHomeSyncTimer() {
    if (homeSyncTimer != null && w && typeof w.clearInterval === "function") {
      w.clearInterval(homeSyncTimer);
    }
    homeSyncTimer = null;
  }

  async function onWalletHomeMount() {
    homeMounted = true;
    // Invalidate the receive-address cache so wipe+restore in the same session
    // never shows an address derived from the previous seed. Module-scoped
    // cache from the old wallet would otherwise persist until a full reload.
    cachedReceiveAddress = null;
    showMsg("wallet-home-msg", "", null);
    // First paint from the cached Update blob (instant, offline-safe).
    try {
      await renderWalletHomeBalances({ background: true });
    } catch { /* noop */ }
    // If a previous sync left us inside a rate-limit cool-down, surface the
    // remaining wait instead of triggering a sync that will just 429 again.
    const remainingMs = nextSyncAllowedAt - Date.now();
    if (remainingMs > 0) {
      updateSyncState(
        `Muitas sincronizações. Próxima tentativa em ${formatBackoffSeconds(remainingMs)}.`,
        "warning"
      );
    } else {
      updateSyncState("Sincronizando…", null);
      void syncAndRender({ background: false });
    }
    startHomeSyncTimer();
  }

  function onWalletHomeUnmount() {
    homeMounted = false;
    stopHomeSyncTimer();
  }

  if (w && typeof w.addEventListener === "function") {
    w.addEventListener("wallet-home:mount", () => { void onWalletHomeMount(); });
    w.addEventListener("wallet-home:unmount", () => { onWalletHomeUnmount(); });
    // Also respond to visibility changes so a hidden-then-visible PWA
    // kicks a fresh sync immediately — unless we're in a rate-limit
    // cool-down, in which case focus-returns shouldn't bypass the backoff.
    d.addEventListener?.("visibilitychange", () => {
      if (!homeMounted || d.visibilityState !== "visible") return;
      if (Date.now() < nextSyncAllowedAt) return;
      void syncAndRender({ background: true });
    });
  }

  // Home panel action buttons.
  q("wallet-home-receive")?.addEventListener("click", () => {
    navigate("#wallet-receive");
  });
  q("wallet-home-qr")?.addEventListener("click", () => {
    void openFullscreenQr();
  });
  q("wallet-home-transactions")?.addEventListener("click", () => {
    navigate("#wallet-transactions");
  });
  q("wallet-home-settings")?.addEventListener("click", () => {
    navigate("#wallet-settings");
  });

  // ====================================================================
  // #wallet-receive — address + QR.
  // ====================================================================
  let cachedReceiveAddress = null;

  async function ensureReceiveAddress() {
    if (cachedReceiveAddress) return cachedReceiveAddress;
    cachedReceiveAddress = await wallet.getReceiveAddress();
    return cachedReceiveAddress;
  }

  async function renderReceiveQr() {
    const host = q("wallet-receive-qr");
    const addrEl = q("wallet-receive-address-text");
    if (!host || !addrEl) return;
    showMsg("wallet-receive-msg", "", null);
    host.textContent = "";
    const loading = d.createElement("span");
    loading.className = "spinner";
    host.appendChild(loading);
    addrEl.textContent = "Carregando…";
    let address;
    try {
      address = await ensureReceiveAddress();
    } catch (err) {
      host.textContent = "";
      const errSpan = d.createElement("div");
      errSpan.className = "error";
      errSpan.textContent = "Não foi possível carregar o endereço.";
      host.appendChild(errSpan);
      renderError("wallet-receive-msg", err);
      return;
    }
    addrEl.textContent = address;
    host.textContent = "";
    const img = d.createElement("img");
    img.className = "wallet-receive-qr-img";
    img.alt = "QR code do endereço Liquid";
    img.style.width = "100%";
    img.style.height = "auto";
    host.appendChild(img);
    const loadingEl = d.createElement("span");
    loadingEl.className = "spinner";
    host.appendChild(loadingEl);
    const errorEl = d.createElement("div");
    errorEl.className = "error hidden";
    errorEl.textContent = "Falha ao gerar QR.";
    host.appendChild(errorEl);
    try {
      const mod = await import("../qr.js");
      mod.renderBrandedQr(address, img, { loadingEl, errorEl });
    } catch {
      loadingEl.classList.add("hidden");
      errorEl.classList.remove("hidden");
    }
  }

  route("#wallet-receive", () => {
    void renderReceiveQr();
  });

  q("wallet-receive-copy")?.addEventListener("click", async () => {
    const addr = q("wallet-receive-address-text")?.textContent?.trim() || "";
    if (!addr || addr === "Carregando…") return;
    try {
      await (navigator.clipboard?.writeText?.(addr));
      if (showToast) showToast("Endereço copiado.");
      else showMsg("wallet-receive-msg", "Endereço copiado.", "success");
    } catch {
      showMsg("wallet-receive-msg", "Não foi possível copiar automaticamente.", "error");
    }
  });

  q("wallet-receive-qr-fullscreen")?.addEventListener("click", () => {
    void openFullscreenQr();
  });

  q("wallet-receive-back")?.addEventListener("click", () => {
    persistHomeMode("wallet");
    navigate("#home");
  });

  // ====================================================================
  // Fullscreen QR modal.
  // ====================================================================
  async function openFullscreenQr() {
    const modal = q("wallet-qr-fullscreen");
    const host = q("wallet-qr-fullscreen-qr");
    const addrEl = q("wallet-qr-fullscreen-address");
    if (!modal || !host || !addrEl) return;
    modal.classList.remove("hidden");
    host.textContent = "";
    const loading = d.createElement("span");
    loading.className = "spinner";
    host.appendChild(loading);
    addrEl.textContent = "";
    let address;
    try {
      address = await ensureReceiveAddress();
    } catch {
      host.textContent = "Erro ao carregar endereço.";
      return;
    }
    addrEl.textContent = address;
    host.textContent = "";
    const img = d.createElement("img");
    img.style.width = "100%";
    img.style.height = "auto";
    img.alt = "QR fullscreen";
    host.appendChild(img);
    const loadingEl = d.createElement("span");
    loadingEl.className = "spinner";
    host.appendChild(loadingEl);
    const errorEl = d.createElement("div");
    errorEl.className = "error hidden";
    errorEl.textContent = "Falha ao gerar QR.";
    host.appendChild(errorEl);
    try {
      const mod = await import("../qr.js");
      mod.renderBrandedQr(address, img, { loadingEl, errorEl });
    } catch {
      loadingEl.classList.add("hidden");
      errorEl.classList.remove("hidden");
    }
  }

  function closeFullscreenQr() {
    q("wallet-qr-fullscreen")?.classList.add("hidden");
  }

  q("wallet-qr-fullscreen-close")?.addEventListener("click", closeFullscreenQr);
  q("wallet-qr-fullscreen")?.addEventListener("click", evt => {
    if (evt.target?.id === "wallet-qr-fullscreen") closeFullscreenQr();
  });

  // ====================================================================
  // #wallet-transactions — on-chain history with asset filter.
  // ====================================================================
  function extractTxAssets(tx) {
    // Defensive: LWK `WalletTx.balance()` returns a Map<AssetId, number|bigint>.
    // If either the wasm changes or a test stubs it differently we fall
    // back to empty rather than crashing the history list.
    try {
      const raw = typeof tx?.balance === "function" ? tx.balance() : null;
      return normalizeBalances(raw);
    } catch {
      return {};
    }
  }

  function rowMatchesFilter(tx, filter) {
    if (filter === "all") return true;
    const assets = extractTxAssets(tx);
    for (const assetId of Object.keys(assets)) {
      const asset = getAssetByIdentifier(assetId);
      if (!asset) continue;
      if (filter === "DEPIX" && asset.symbol === "DePix") return true;
      if (filter === "USDT" && asset.symbol === "USDt") return true;
      if (filter === "LBTC" && asset.symbol === "L-BTC") return true;
    }
    return false;
  }

  function formatTxTimestamp(ts) {
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "—";
    const millis = ts < 1e12 ? ts * 1000 : ts;
    try {
      return new Date(millis).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return "—";
    }
  }

  function safeCall(obj, name) {
    try {
      const fn = obj?.[name];
      if (typeof fn === "function") return fn.call(obj);
    } catch (err) {
      // Log only when the handle actually threw — absent/non-function reads
      // stay silent (that path is structurally fine). Grep-able prefix so
      // LWK upgrades that rename balance()/type()/timestamp()/txid() surface
      // in devtools instead of silently rendering "—"/"tx" (OBS-01 follow-up
      // will wire a telemetry counter through this signal in Sub-fase 6).
      console.warn("[wallet-tx] safeCall", name, err);
    }
    return undefined;
  }

  async function renderTransactions() {
    const listEl = q("wallet-tx-list");
    const loadingEl = q("wallet-tx-loading");
    const emptyEl = q("wallet-tx-empty");
    if (!listEl || !loadingEl || !emptyEl) return;
    showMsg("wallet-tx-msg", "", null);
    listEl.textContent = "";
    loadingEl.classList.remove("hidden");
    emptyEl.classList.add("hidden");
    let txs;
    try {
      txs = await wallet.listTransactions();
    } catch (err) {
      loadingEl.classList.add("hidden");
      renderError("wallet-tx-msg", err);
      return;
    }
    loadingEl.classList.add("hidden");
    const filtered = (txs || []).filter(t => rowMatchesFilter(t, homeFilter));
    if (filtered.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    for (const tx of filtered) {
      const row = d.createElement("div");
      row.className = "wallet-tx-row";
      const body = d.createElement("div");
      body.className = "wallet-tx-row-body";
      const type = safeCall(tx, "type") ?? "tx";
      const label = d.createElement("div");
      label.className = "wallet-tx-row-title";
      label.textContent = type === "incoming"
        ? "Recebido"
        : type === "outgoing"
          ? "Enviado"
          : String(type);
      const meta = d.createElement("div");
      meta.className = "wallet-tx-row-sub";
      const ts = safeCall(tx, "timestamp");
      const txid = safeCall(tx, "txid");
      const txidStr = (txid && typeof txid.toString === "function") ? txid.toString() : String(txid ?? "");
      const short = txidStr ? `${txidStr.slice(0, 10)}…${txidStr.slice(-6)}` : "";
      meta.textContent = `${formatTxTimestamp(ts)}${short ? " · " + short : ""}`;
      body.appendChild(label);
      body.appendChild(meta);

      const amountCol = d.createElement("div");
      amountCol.className = "wallet-tx-row-amount";
      const assets = extractTxAssets(tx);
      const lines = [];
      for (const assetId of Object.keys(assets)) {
        const asset = getAssetByIdentifier(assetId);
        if (!asset) continue;
        const sats = assets[assetId];
        const display = formatAssetAmount(sats < 0n ? -sats : sats, asset);
        const sign = sats < 0n ? "-" : "+";
        lines.push(`${sign}${display} ${asset.symbol}`);
      }
      amountCol.textContent = lines.length > 0 ? lines.join(" · ") : "—";
      // Colour cue: if any positive → in; if all negative → out.
      const anyPositive = Object.values(assets).some(v => v > 0n);
      const anyNegative = Object.values(assets).some(v => v < 0n);
      if (anyPositive && !anyNegative) amountCol.classList.add("in");
      else if (anyNegative && !anyPositive) amountCol.classList.add("out");

      row.appendChild(body);
      row.appendChild(amountCol);
      listEl.appendChild(row);
    }
  }

  // Plan Sub-fase 4 preferred "Extrato unificado" (toggle inside #reports).
  // We shipped the dedicated #wallet-transactions view (plano B) because the
  // #reports refactor would exceed ~150 LOC — date range, pagination,
  // CSV/PDF export and polling all live there and would need to branch on
  // mode. Dedicated view keeps this PR's diff reviewable; future maintainer
  // can promote to unified extrato if desired without new wallet scope.
  route("#wallet-transactions", () => {
    void renderTransactions();
  });

  q("wallet-tx-back")?.addEventListener("click", () => {
    persistHomeMode("wallet");
    navigate("#home");
  });

  for (const pill of d.querySelectorAll?.("[data-wallet-filter]") ?? []) {
    pill.addEventListener("click", () => {
      const filter = pill.getAttribute("data-wallet-filter") || "all";
      homeFilter = filter;
      for (const other of d.querySelectorAll("[data-wallet-filter]")) {
        const selected = other === pill;
        other.classList.toggle("active", selected);
        // Flip aria-checked alongside .active so screen readers announce the
        // selected state — .active alone is not exposed to the a11y tree.
        other.setAttribute("aria-checked", selected ? "true" : "false");
      }
      void renderTransactions();
    });
  }

  // ====================================================================
  // #wallet-settings — biometric toggle + export + wipe.
  // ====================================================================
  async function refreshBiometricRow() {
    const status = q("wallet-settings-biometric-status");
    const toggle = q("wallet-settings-biometric-toggle");
    if (!status || !toggle) return;
    try {
      const supported = await wallet.biometricSupported();
      if (!supported) {
        status.textContent = "Seu aparelho não suporta biometria compatível (PRF).";
        toggle.disabled = true;
        toggle.textContent = "Indisponível";
        return;
      }
      const enrolled = await wallet.hasBiometric();
      if (enrolled) {
        status.textContent = "Biometria ativa neste aparelho.";
        toggle.disabled = false;
        toggle.textContent = "Remover";
        toggle.dataset.action = "remove";
      } else {
        status.textContent = "Biometria não configurada.";
        toggle.disabled = false;
        toggle.textContent = "Ativar";
        toggle.dataset.action = "add";
      }
    } catch {
      status.textContent = "Não foi possível verificar biometria.";
      toggle.disabled = true;
    }
  }

  route("#wallet-settings", () => {
    showMsg("wallet-settings-msg", "", null);
    void refreshBiometricRow();
  });

  q("wallet-settings-back")?.addEventListener("click", () => {
    persistHomeMode("wallet");
    navigate("#home");
  });

  q("wallet-settings-biometric-toggle")?.addEventListener("click", async () => {
    const toggle = q("wallet-settings-biometric-toggle");
    if (!toggle) return;
    const action = toggle.dataset.action;
    showMsg("wallet-settings-msg", "", null);
    if (action === "remove") {
      toggle.disabled = true;
      try {
        await wallet.removeBiometric();
        if (showToast) showToast("Biometria removida.");
      } catch (err) {
        renderError("wallet-settings-msg", err);
      } finally {
        await refreshBiometricRow();
      }
      return;
    }
    resetBiometricPinModal();
    q("wallet-biometric-pin-modal")?.classList.remove("hidden");
    q("wallet-biometric-pin-input")?.focus();
  });

  // --- Biometric enrollment PIN modal ---
  function resetBiometricPinModal() {
    const pin = q("wallet-biometric-pin-input");
    if (pin) pin.value = "";
    clearMsg("wallet-biometric-pin-msg");
    const btn = q("wallet-biometric-pin-confirm");
    if (btn) btn.disabled = false;
  }

  q("wallet-biometric-pin-cancel")?.addEventListener("click", () => {
    q("wallet-biometric-pin-modal")?.classList.add("hidden");
    resetBiometricPinModal();
  });

  q("wallet-biometric-pin-confirm")?.addEventListener("click", async () => {
    const pin = q("wallet-biometric-pin-input")?.value ?? "";
    const btn = q("wallet-biometric-pin-confirm");
    clearMsg("wallet-biometric-pin-msg");
    if (!isPinInputValid(pin)) {
      showMsg("wallet-biometric-pin-msg", "Informe um PIN de 6 dígitos.", "error");
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await wallet.addBiometric(pin);
      q("wallet-biometric-pin-modal")?.classList.add("hidden");
      resetBiometricPinModal();
      if (showToast) showToast("Biometria ativada.");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.BIOMETRIC_REJECTED)) {
        showMsg("wallet-biometric-pin-msg", "Autenticação cancelada.", "warning");
      } else {
        renderError("wallet-biometric-pin-msg", err);
      }
      if (btn) btn.disabled = false;
    } finally {
      await refreshBiometricRow();
    }
  });

  // --- Export mnemonic modal ---
  function resetExportModal() {
    const pin = q("wallet-export-pin");
    const words = q("wallet-export-words");
    if (pin) pin.value = "";
    if (words) {
      words.textContent = "";
      words.classList.add("hidden");
    }
    // Restore the pre-reveal layout: show PIN input + Cancelar button,
    // hide the identity fingerprint card, reset intro copy.
    q("wallet-export-pin-wrap")?.classList.remove("hidden");
    q("wallet-export-cancel")?.classList.remove("hidden");
    const identity = q("wallet-export-identity");
    if (identity) identity.classList.add("hidden");
    const identityValue = q("wallet-export-identity-value");
    if (identityValue) identityValue.textContent = "…";
    const intro = q("wallet-export-intro");
    if (intro) {
      intro.textContent = "Digite seu PIN. As palavras serão mostradas apenas nesta tela — anote em papel antes de fechar.";
    }
    clearMsg("wallet-export-msg");
    const confirm = q("wallet-export-confirm");
    if (confirm) {
      confirm.textContent = "Mostrar";
      confirm.disabled = false;
      confirm.dataset.shown = "";
    }
  }

  q("wallet-settings-export")?.addEventListener("click", () => {
    resetExportModal();
    q("wallet-export-modal")?.classList.remove("hidden");
  });

  q("wallet-export-cancel")?.addEventListener("click", () => {
    q("wallet-export-modal")?.classList.add("hidden");
    resetExportModal();
  });

  q("wallet-export-confirm")?.addEventListener("click", async () => {
    const pin = q("wallet-export-pin")?.value ?? "";
    const confirm = q("wallet-export-confirm");
    const wordsEl = q("wallet-export-words");
    clearMsg("wallet-export-msg");
    if (confirm?.dataset.shown === "1") {
      q("wallet-export-modal")?.classList.add("hidden");
      resetExportModal();
      return;
    }
    if (!isPinInputValid(pin)) {
      showMsg("wallet-export-msg", "Informe um PIN de 6 dígitos.", "error");
      return;
    }
    if (confirm) confirm.disabled = true;
    try {
      const mnemonic = await wallet.exportMnemonic(pin);
      if (!wordsEl) return;
      wordsEl.textContent = "";
      wordsEl.classList.remove("hidden");
      splitMnemonic(mnemonic).forEach((word, i) => {
        const cell = d.createElement("div");
        cell.className = "wallet-seed-cell";
        cell.setAttribute("aria-label", `Palavra ${i + 1}: ${word}`);
        const n = d.createElement("span");
        n.className = "wallet-seed-index";
        n.textContent = String(i + 1);
        const w = d.createElement("span");
        w.className = "wallet-seed-word";
        w.textContent = word;
        cell.appendChild(n);
        cell.appendChild(w);
        wordsEl.appendChild(cell);
      });
      // Post-reveal layout: the PIN input and the duplicate Cancelar
      // button are no longer useful; hide them so the only prominent
      // action is the now-relabeled "Fechar" confirm button. Also swap
      // the intro copy to the anote-em-papel emphasis.
      q("wallet-export-pin-wrap")?.classList.add("hidden");
      q("wallet-export-cancel")?.classList.add("hidden");
      const intro = q("wallet-export-intro");
      if (intro) {
        intro.textContent = "Anote em papel antes de fechar. Sem as 12 palavras e sem a identidade da carteira, os fundos não podem ser recuperados.";
      }
      // Mirror the create-seed screen: show the wallet identity fingerprint
      // alongside the 12 words so user writes both down together. Descriptor
      // is plaintext in IDB, no extra unlock needed.
      const identityCard = q("wallet-export-identity");
      const identityValue = q("wallet-export-identity-value");
      if (identityCard && identityValue) {
        identityCard.classList.remove("hidden");
        identityValue.textContent = "…";
        try {
          const descriptor = await wallet.getDescriptor();
          identityValue.textContent = descriptor
            ? await computeFingerprint(descriptor)
            : "—";
        } catch {
          // Fingerprint is a convenience, never block the word reveal.
          identityValue.textContent = "—";
        }
      }
      if (confirm) {
        confirm.textContent = "Fechar";
        confirm.disabled = false;
        confirm.dataset.shown = "1";
      }
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.WALLET_WIPED)) {
        showMsg("wallet-export-msg", "Muitas tentativas erradas. Carteira apagada deste aparelho.", "error");
        setTimeout(() => {
          q("wallet-export-modal")?.classList.add("hidden");
          navigate("#wallet-gate");
        }, 2000);
      } else if (isWalletError(err, ERROR_CODES.WRONG_PIN)) {
        showMsg("wallet-export-msg", err.message || "PIN incorreto.", "error");
      } else {
        renderError("wallet-export-msg", err);
      }
      if (confirm) confirm.disabled = false;
    }
  });

  // --- Wipe wallet modal ---
  function resetWipeModal() {
    const pin = q("wallet-wipe-pin");
    if (pin) pin.value = "";
    clearMsg("wallet-wipe-msg");
    const btn = q("wallet-wipe-confirm");
    if (btn) btn.disabled = false;
  }

  q("wallet-settings-wipe")?.addEventListener("click", () => {
    resetWipeModal();
    q("wallet-wipe-modal")?.classList.remove("hidden");
  });

  q("wallet-wipe-cancel")?.addEventListener("click", () => {
    q("wallet-wipe-modal")?.classList.add("hidden");
    resetWipeModal();
  });

  q("wallet-wipe-confirm")?.addEventListener("click", async () => {
    const pin = q("wallet-wipe-pin")?.value ?? "";
    const btn = q("wallet-wipe-confirm");
    clearMsg("wallet-wipe-msg");
    if (!isPinInputValid(pin)) {
      showMsg("wallet-wipe-msg", "Informe um PIN de 6 dígitos.", "error");
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await wallet.wipeWallet(pin);
      q("wallet-wipe-modal")?.classList.add("hidden");
      resetWipeModal();
      persistHomeMode("deposit");
      if (showToast) showToast("Carteira apagada deste aparelho.");
      navigate("#wallet-gate");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.WALLET_WIPED)) {
        showMsg("wallet-wipe-msg", "Muitas tentativas erradas. Carteira apagada.", "warning");
        setTimeout(() => {
          q("wallet-wipe-modal")?.classList.add("hidden");
          persistHomeMode("deposit");
          navigate("#wallet-gate");
        }, 1500);
      } else {
        renderError("wallet-wipe-msg", err);
      }
      if (btn) btn.disabled = false;
    }
  });

  // Any wallet modal that can hold sensitive residue (seed words, PIN input)
  // must close and reset on route change — otherwise a `.modal` with
  // `position: fixed; z-index: 2500` overlays the new view and the seed stays
  // readable in the DOM heap even after CSS hides it. Belt-and-suspenders for
  // SEC-07 (DOM residue after backup).
  if (w && typeof w.addEventListener === "function") {
    w.addEventListener("hashchange", () => {
      const exportModal = q("wallet-export-modal");
      if (exportModal && !exportModal.classList.contains("hidden")) {
        exportModal.classList.add("hidden");
        resetExportModal();
      }
      const wipeModal = q("wallet-wipe-modal");
      if (wipeModal && !wipeModal.classList.contains("hidden")) {
        wipeModal.classList.add("hidden");
        resetWipeModal();
      }
      const biometricModal = q("wallet-biometric-pin-modal");
      if (biometricModal && !biometricModal.classList.contains("hidden")) {
        biometricModal.classList.add("hidden");
        resetBiometricPinModal();
      }
    });
  }

  // Expose a small handle for tests + potential future callers. Read-only.
  return Object.freeze({
    _mountWalletHome: onWalletHomeMount,
    _unmountWalletHome: onWalletHomeUnmount,
    _renderReceiveQr: renderReceiveQr,
    _renderTransactions: renderTransactions,
    _refreshBiometricRow: refreshBiometricRow
  });
}
