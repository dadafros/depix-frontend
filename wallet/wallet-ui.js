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
  ASSETS,
  DISPLAY_ORDER,
  getAssetByIdentifier,
  convertSatsToBrl,
  formatAssetAmount
} from "./asset-registry.js";
import { validateLiquidAddress } from "../validation.js";

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
 * Parse a user-typed amount like "1.5", "1,5", "0.00000001" into an integer
 * sats BigInt given the asset's `decimals`. Throws RangeError on any invalid
 * shape (non-numeric, too many decimals, non-positive, empty). Matches the
 * format the wallet send form accepts.
 */
export function parseAmountToSats(input, decimals) {
  if (typeof input !== "string") throw new TypeError("input");
  if (typeof decimals !== "number" || decimals < 0) throw new RangeError("decimals");
  const normalized = input.trim().replace(",", ".");
  if (!normalized || !/^\d+(\.\d+)?$/.test(normalized)) {
    throw new RangeError("invalid amount");
  }
  const [whole, frac = ""] = normalized.split(".");
  if (frac.length > decimals) throw new RangeError("too many decimals");
  const padded = frac.padEnd(decimals, "0");
  const combined = (whole + padded).replace(/^0+/, "") || "0";
  const n = BigInt(combined);
  if (n <= 0n) throw new RangeError("amount must be positive");
  return n;
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
    challenge: null, // { positions: number[], options: string[][], answered: boolean[] }
    restoreWords: new Array(12).fill(""),
    error: ""
  };

  function resetFlowState() {
    state.pendingMnemonic = null;
    state.pendingPin = null;
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
  // #wallet-create-seed — render the 12 words in a grid.
  // ====================================================================
  route("#wallet-create-seed", () => {
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
      await wallet.validateMnemonic(mnemonicStr);
      state.pendingMnemonic = mnemonicStr;
      navigate("#wallet-restore-pin");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.INVALID_MNEMONIC)) {
        showMsg(
          "wallet-restore-input-msg",
          "Uma ou mais das 12 palavras está errada. Confira sua anotação e tente novamente.",
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
        state.error = "Uma ou mais das 12 palavras está errada. Confira sua anotação e tente novamente.";
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
    state.restoreWords = new Array(12).fill("");
    if (showToast) showToast("Carteira restaurada com sucesso.");
  });

  q("wallet-restore-done-home")?.addEventListener("click", () => {
    resetFlowState();
    persistHomeMode("wallet");
    navigate("#home");
  });

  // ====================================================================
  // Wallet home panel — lives inside #home (telaCarteira). Driven by
  // CustomEvents `wallet-home:mount` / `wallet-home:unmount` dispatched
  // by script.js when the user toggles the 4-mode home switch.
  // ====================================================================
  const SYNC_INTERVAL_MS = 30_000;
  let homeSyncTimer = null;
  let homeMounted = false;
  let homeFilter = "all";
  let lastBalancesRender = 0;

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
    for (const asset of DISPLAY_ORDER) {
      const sats = balances[asset.id] ?? 0n;
      const brl = convertSatsToBrl(sats, asset, quoteValues);
      if (typeof brl === "number") {
        totalBrl += brl;
        anyBrl = true;
      }
      const row = d.createElement("div");
      row.className = "wallet-home-asset";
      const icon = d.createElement("div");
      icon.className = "wallet-home-asset-icon";
      icon.style.background = asset.color;
      icon.textContent = asset.symbol.charAt(0);
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
    totalEl.textContent = anyBrl ? formatBrlNumber(totalBrl) : "R$ —";
    lastBalancesRender = Date.now();

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

  async function syncAndRender({ background = false } = {}) {
    if (!homeMounted) return;
    if (!background) updateSyncState("Sincronizando…", null);
    try {
      await wallet.syncWallet();
      updateSyncState("Atualizado agora", "success");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.ESPLORA_UNAVAILABLE)) {
        updateSyncState("Sem conexão com o servidor. Mostrando último saldo conhecido.", "warning");
      } else {
        updateSyncState("Falha na sincronização.", "error");
      }
    }
    await renderWalletHomeBalances({ background });
  }

  function startHomeSyncTimer() {
    stopHomeSyncTimer();
    if (!w || typeof w.setInterval !== "function") return;
    homeSyncTimer = w.setInterval(() => {
      if (!homeMounted) return;
      if (d.visibilityState && d.visibilityState !== "visible") return;
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
    showMsg("wallet-home-msg", "", null);
    updateSyncState("Sincronizando…", null);
    // First paint from the cached Update blob (instant, offline-safe).
    try {
      await renderWalletHomeBalances({ background: true });
    } catch { /* noop */ }
    // Then trigger a fresh scan in the background.
    void syncAndRender({ background: false });
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
    // kicks a fresh sync immediately.
    d.addEventListener?.("visibilitychange", () => {
      if (homeMounted && d.visibilityState === "visible") {
        void syncAndRender({ background: true });
      }
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
    } catch { /* fallthrough */ }
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
      label.className = "wallet-tx-row-label";
      label.textContent = type === "incoming"
        ? "Recebido"
        : type === "outgoing"
          ? "Enviado"
          : String(type);
      const meta = d.createElement("div");
      meta.className = "wallet-tx-row-meta";
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
        other.classList.toggle("active", other === pill);
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

  // ====================================================================
  // #wallet-send — asset picker + preview + unlock + broadcast.
  //
  // prepareSend is view-only (no unlock required) so the fee preview shows
  // BEFORE we demand biometric / PIN. The unlock modal then gates the
  // confirmSend call. Success navigates to #wallet-send-success.
  // ====================================================================
  const sendState = {
    assetKey: "DEPIX",
    amountSats: null,
    destAddr: "",
    sendAll: false,
    preview: null,
    balances: null
  };

  function resetSendState() {
    sendState.assetKey = "DEPIX";
    sendState.amountSats = null;
    sendState.destAddr = "";
    sendState.sendAll = false;
    sendState.preview = null;
  }

  function currentSendAsset() {
    return ASSETS[sendState.assetKey];
  }

  function assetKeyFromObject(asset) {
    for (const key of Object.keys(ASSETS)) {
      if (ASSETS[key] === asset) return key;
    }
    return null;
  }

  async function loadSendBalances() {
    try {
      sendState.balances = await wallet.getBalances();
    } catch {
      sendState.balances = null;
    }
  }

  function renderSendAssets() {
    const host = q("wallet-send-assets");
    if (!host) return;
    host.textContent = "";
    for (const asset of DISPLAY_ORDER) {
      const key = assetKeyFromObject(asset);
      const btn = d.createElement("button");
      btn.type = "button";
      btn.className = "wallet-send-asset";
      btn.setAttribute("role", "radio");
      btn.dataset.assetKey = key;
      const selected = sendState.assetKey === key;
      btn.setAttribute("aria-checked", selected ? "true" : "false");
      if (selected) btn.classList.add("selected");
      const dot = d.createElement("span");
      dot.className = "wallet-send-asset-dot";
      dot.style.background = asset.color;
      btn.appendChild(dot);
      const name = d.createElement("span");
      name.className = "wallet-send-asset-name";
      name.textContent = asset.symbol;
      btn.appendChild(name);
      btn.addEventListener("click", () => selectSendAsset(key));
      host.appendChild(btn);
    }
  }

  function selectSendAsset(key) {
    sendState.assetKey = key;
    if (key !== "LBTC") sendState.sendAll = false;
    renderSendAssets();
    refreshSendFieldsForAsset();
    clearSendPreview();
  }

  function refreshSendFieldsForAsset() {
    const asset = currentSendAsset();
    const suffix = q("wallet-send-amount-suffix");
    if (suffix) suffix.textContent = asset.symbol;
    const sendAllWrap = q("wallet-send-sendall-wrap");
    if (sendAllWrap) sendAllWrap.classList.toggle("hidden", sendState.assetKey !== "LBTC");
    const sendAllInput = q("wallet-send-sendall");
    if (sendAllInput) sendAllInput.checked = sendState.sendAll;
    const amountInput = q("wallet-send-amount");
    if (amountInput) amountInput.disabled = sendState.sendAll;
    const balMap = sendState.balances;
    let bal = 0n;
    if (balMap && typeof balMap === "object") {
      const val = balMap[asset.id];
      if (typeof val === "bigint") bal = val;
      else if (typeof val === "number") bal = BigInt(val);
    }
    const balEl = q("wallet-send-balance");
    if (balEl) balEl.textContent = `Saldo disponível: ${formatAssetAmount(bal, asset)} ${asset.symbol}`;
  }

  function clearSendPreview() {
    sendState.preview = null;
    q("wallet-send-preview")?.classList.add("hidden");
    q("wallet-send-confirm")?.classList.add("hidden");
    const btn = q("wallet-send-preview-btn");
    if (btn) {
      btn.classList.remove("hidden");
      btn.disabled = false;
    }
  }

  function renderSendPreview(preview) {
    const asset = getAssetByIdentifier(preview.assetId);
    const lbtc = ASSETS.LBTC;
    const amountEl = q("wallet-send-preview-amount");
    const feeEl = q("wallet-send-preview-fee");
    const totalEl = q("wallet-send-preview-total");
    const destEl = q("wallet-send-preview-dest");
    const amountSats = preview.amountSats ?? 0n;
    if (amountEl) {
      if (preview.sendAll) amountEl.textContent = `Tudo (${asset?.symbol ?? ""})`;
      else amountEl.textContent = `${formatAssetAmount(amountSats, asset)} ${asset?.symbol ?? ""}`;
    }
    if (feeEl) {
      feeEl.textContent = `${formatAssetAmount(preview.feeSats, lbtc)} ${lbtc.symbol}`;
    }
    if (totalEl) {
      if (asset === lbtc) {
        const total = (amountSats ?? 0n) + preview.feeSats;
        totalEl.textContent = preview.sendAll
          ? `Tudo + taxa (${lbtc.symbol})`
          : `${formatAssetAmount(total, lbtc)} ${lbtc.symbol}`;
      } else {
        totalEl.textContent = `${formatAssetAmount(amountSats, asset)} ${asset?.symbol ?? ""} + ${formatAssetAmount(preview.feeSats, lbtc)} ${lbtc.symbol}`;
      }
    }
    if (destEl) destEl.textContent = preview.destAddr;
    q("wallet-send-preview")?.classList.remove("hidden");
    q("wallet-send-preview-btn")?.classList.add("hidden");
    q("wallet-send-confirm")?.classList.remove("hidden");
  }

  async function onSendPreviewClick() {
    clearMsg("wallet-send-msg");
    const asset = currentSendAsset();
    const destVal = (q("wallet-send-dest")?.value ?? "").trim();
    if (!sendState.sendAll) {
      const raw = q("wallet-send-amount")?.value ?? "";
      try {
        sendState.amountSats = parseAmountToSats(raw, asset.decimals);
      } catch {
        showMsg("wallet-send-msg", "Informe um valor válido (ex.: 10,50).", "error");
        return;
      }
    } else {
      sendState.amountSats = null;
    }
    const { valid, error } = validateLiquidAddress(destVal);
    if (!valid) {
      showMsg("wallet-send-msg", error || "Endereço Liquid inválido.", "error");
      return;
    }
    sendState.destAddr = destVal;
    const previewBtn = q("wallet-send-preview-btn");
    if (previewBtn) previewBtn.disabled = true;
    try {
      const preview = await wallet.prepareSend({
        asset: sendState.assetKey,
        amountSats: sendState.amountSats ?? undefined,
        destAddr: destVal,
        sendAll: sendState.sendAll
      });
      sendState.preview = preview;
      renderSendPreview(preview);
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.INSUFFICIENT_FUNDS)) {
        showMsg("wallet-send-msg", "Saldo insuficiente para este envio.", "error");
      } else if (isWalletError(err, ERROR_CODES.INVALID_ADDRESS)) {
        showMsg("wallet-send-msg", "Endereço Liquid inválido para esta rede.", "error");
      } else if (isWalletError(err, ERROR_CODES.INVALID_AMOUNT)) {
        showMsg("wallet-send-msg", "Informe um valor válido (ex.: 10,50).", "error");
      } else if (isWalletError(err, ERROR_CODES.ESPLORA_UNAVAILABLE)) {
        showMsg("wallet-send-msg", "Sem resposta do Esplora. Tente novamente.", "error");
      } else {
        renderError("wallet-send-msg", err);
      }
    } finally {
      if (previewBtn) previewBtn.disabled = false;
    }
  }

  async function doBroadcastAfterUnlock() {
    if (!sendState.preview) {
      showMsg("wallet-unlock-msg", "Sessão expirada. Reveja o envio.", "error");
      return;
    }
    const confirmBtn = q("wallet-unlock-confirm");
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      const { txid } = await wallet.confirmSend(sendState.preview.psetBase64);
      closeUnlockModal();
      showSendSuccess(txid);
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.BROADCAST_FAILED)) {
        showMsg("wallet-unlock-msg", "A rede recusou a transação. Verifique conexão e tente novamente.", "error");
      } else if (isWalletError(err, ERROR_CODES.ESPLORA_UNAVAILABLE)) {
        showMsg("wallet-unlock-msg", "Não foi possível alcançar o Esplora. Tente novamente.", "error");
      } else {
        renderError("wallet-unlock-msg", err);
      }
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  async function openUnlockModal() {
    const modal = q("wallet-unlock-modal");
    if (!modal) return;
    clearMsg("wallet-unlock-msg");
    const pinEl = q("wallet-unlock-pin");
    if (pinEl) pinEl.value = "";
    const bioSection = q("wallet-unlock-biometric");
    const pinSection = q("wallet-unlock-pin-section");
    bioSection?.classList.add("hidden");
    pinSection?.classList.remove("hidden");
    modal.classList.remove("hidden");
    try {
      const [has, supported] = await Promise.all([
        wallet.hasBiometric(),
        wallet.biometricSupported()
      ]);
      if (has && supported) {
        bioSection?.classList.remove("hidden");
        pinSection?.classList.add("hidden");
        q("wallet-unlock-biometric-btn")?.focus();
      } else {
        q("wallet-unlock-pin")?.focus();
      }
    } catch {
      q("wallet-unlock-pin")?.focus();
    }
  }

  function closeUnlockModal() {
    q("wallet-unlock-modal")?.classList.add("hidden");
    const pin = q("wallet-unlock-pin");
    if (pin) pin.value = "";
    clearMsg("wallet-unlock-msg");
  }

  async function unlockWithBiometricAndBroadcast() {
    clearMsg("wallet-unlock-msg");
    const btn = q("wallet-unlock-biometric-btn");
    if (btn) btn.disabled = true;
    try {
      await wallet.unlockWithBiometric();
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.BIOMETRIC_REJECTED)) {
        showMsg("wallet-unlock-msg", "Autenticação cancelada.", "warning");
      } else if (isWalletError(err, ERROR_CODES.BIOMETRIC_UNAVAILABLE)) {
        showMsg("wallet-unlock-msg", "Biometria indisponível. Use o PIN.", "warning");
      } else {
        renderError("wallet-unlock-msg", err);
      }
      if (btn) btn.disabled = false;
      return;
    }
    await doBroadcastAfterUnlock();
    if (btn) btn.disabled = false;
  }

  async function unlockWithPinAndBroadcast() {
    clearMsg("wallet-unlock-msg");
    const pin = q("wallet-unlock-pin")?.value ?? "";
    if (!isPinInputValid(pin)) {
      showMsg("wallet-unlock-msg", "Informe um PIN de 6 dígitos.", "error");
      return;
    }
    try {
      await wallet.unlockWithPin(pin);
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.WRONG_PIN)) {
        showMsg("wallet-unlock-msg", err.message || "PIN incorreto.", "error");
        return;
      }
      if (isWalletError(err, ERROR_CODES.WALLET_WIPED)) {
        showMsg("wallet-unlock-msg", "Muitas tentativas. Carteira apagada deste aparelho.", "error");
        setTimeout(() => {
          closeUnlockModal();
          persistHomeMode("deposit");
          navigate("#wallet-gate");
        }, 2000);
        return;
      }
      if (isWalletError(err, ERROR_CODES.PIN_RATE_LIMITED)) {
        showMsg("wallet-unlock-msg", err.message || "Aguarde alguns segundos antes de tentar novamente.", "warning");
        return;
      }
      renderError("wallet-unlock-msg", err);
      return;
    }
    await doBroadcastAfterUnlock();
  }

  function onUnlockConfirmClick() {
    if (wallet.isUnlocked()) {
      void doBroadcastAfterUnlock();
      return;
    }
    void unlockWithPinAndBroadcast();
  }

  function showSendSuccess(txid) {
    navigate("#wallet-send-success");
    const txEl = q("wallet-send-success-txid-text");
    if (txEl) txEl.textContent = txid;
    const explorer = q("wallet-send-success-explorer");
    if (explorer && typeof txid === "string" && txid) {
      explorer.setAttribute("href", `https://blockstream.info/liquid/tx/${encodeURIComponent(txid)}`);
    }
    resetSendState();
  }

  route("#wallet-send", async () => {
    clearMsg("wallet-send-msg");
    const amountInput = q("wallet-send-amount");
    const destInput = q("wallet-send-dest");
    if (amountInput) { amountInput.value = ""; amountInput.disabled = false; }
    if (destInput) destInput.value = "";
    q("wallet-send-dest-hint")?.classList.add("hidden");
    clearSendPreview();
    sendState.assetKey = "DEPIX";
    sendState.sendAll = false;
    sendState.destAddr = "";
    sendState.amountSats = null;
    sendState.preview = null;
    renderSendAssets();
    refreshSendFieldsForAsset();
    await loadSendBalances();
    refreshSendFieldsForAsset();
  });

  route("#wallet-send-success", () => {
    clearMsg("wallet-send-success-msg");
  });

  q("wallet-home-send")?.addEventListener("click", () => {
    navigate("#wallet-send");
  });
  q("wallet-send-back")?.addEventListener("click", () => {
    persistHomeMode("wallet");
    navigate("#home");
  });
  q("wallet-send-sendall")?.addEventListener("change", evt => {
    sendState.sendAll = Boolean(evt.target?.checked);
    refreshSendFieldsForAsset();
    clearSendPreview();
  });
  q("wallet-send-amount")?.addEventListener("input", () => clearSendPreview());
  q("wallet-send-dest")?.addEventListener("input", () => {
    const v = (q("wallet-send-dest")?.value ?? "").trim();
    const hint = q("wallet-send-dest-hint");
    if (!hint) return;
    if (!v) {
      hint.classList.add("hidden");
      hint.textContent = "";
      hint.classList.remove("success", "error");
      return;
    }
    const { valid, error } = validateLiquidAddress(v);
    if (valid) {
      hint.textContent = "Endereço válido.";
      hint.classList.remove("hidden", "error");
      hint.classList.add("success");
    } else {
      hint.textContent = error || "Endereço inválido.";
      hint.classList.remove("hidden", "success");
      hint.classList.add("error");
    }
    clearSendPreview();
  });
  q("wallet-send-preview-btn")?.addEventListener("click", () => { void onSendPreviewClick(); });
  q("wallet-send-confirm")?.addEventListener("click", () => { void openUnlockModal(); });

  q("wallet-unlock-cancel")?.addEventListener("click", closeUnlockModal);
  q("wallet-unlock-confirm")?.addEventListener("click", () => onUnlockConfirmClick());
  q("wallet-unlock-biometric-btn")?.addEventListener("click", () => { void unlockWithBiometricAndBroadcast(); });
  q("wallet-unlock-use-pin")?.addEventListener("click", () => {
    q("wallet-unlock-biometric")?.classList.add("hidden");
    q("wallet-unlock-pin-section")?.classList.remove("hidden");
    q("wallet-unlock-pin")?.focus();
  });
  q("wallet-unlock-pin")?.addEventListener("keydown", evt => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      onUnlockConfirmClick();
    }
  });

  q("wallet-send-success-copy")?.addEventListener("click", async () => {
    const txid = q("wallet-send-success-txid-text")?.textContent?.trim() || "";
    if (!txid) return;
    try {
      await (navigator.clipboard?.writeText?.(txid));
      if (showToast) showToast("ID copiado.");
      else showMsg("wallet-send-success-msg", "ID copiado.", "success");
    } catch {
      showMsg("wallet-send-success-msg", "Não foi possível copiar automaticamente.", "error");
    }
  });
  q("wallet-send-success-done")?.addEventListener("click", () => {
    persistHomeMode("wallet");
    navigate("#home");
  });

  // Expose a small handle for tests + potential future callers. Read-only.
  return Object.freeze({
    _mountWalletHome: onWalletHomeMount,
    _unmountWalletHome: onWalletHomeUnmount,
    _renderReceiveQr: renderReceiveQr,
    _renderTransactions: renderTransactions,
    _refreshBiometricRow: refreshBiometricRow,
    _lastBalancesRender: () => lastBalancesRender,
    _openUnlockModal: openUnlockModal,
    _closeUnlockModal: closeUnlockModal,
    _onSendPreviewClick: onSendPreviewClick,
    _sendState: () => ({ ...sendState })
  });
}
