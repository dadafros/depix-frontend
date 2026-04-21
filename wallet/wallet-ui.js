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
  while (used.size < n) {
    used.add(Math.floor(rand() * pool));
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
  showToast = null,
  getRandom = null,
  doc = null
} = {}) {
  if (typeof route !== "function") throw new TypeError("route");
  if (typeof navigate !== "function") throw new TypeError("navigate");
  if (!wallet || typeof wallet.createWallet !== "function") {
    throw new TypeError("wallet");
  }
  const rand = getRandom ?? Math.random;
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  if (!d) throw new Error("registerWalletRoutes: document not available");

  // Scratch state carried across create/restore screens. Cleared at the end
  // of each flow. Never persisted.
  const state = {
    createPendingMnemonic: null,
    createPendingPin: null,
    challenge: null, // { positions: number[], options: string[][], answered: boolean[] }
    restoreWords: new Array(12).fill(""),
    error: ""
  };

  function resetFlowState() {
    state.createPendingMnemonic = null;
    state.createPendingPin = null;
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
      if (!state.createPendingMnemonic) {
        state.createPendingMnemonic = await wallet.generateMnemonic();
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
    if (!state.createPendingMnemonic) {
      navigate("#wallet-create-intro");
      return;
    }
    const words = splitMnemonic(state.createPendingMnemonic);
    grid.textContent = "";
    words.forEach((word, i) => {
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
      grid.appendChild(cell);
    });
  });

  q("wallet-create-seed-continue")?.addEventListener("click", () => {
    if (!state.createPendingMnemonic) {
      navigate("#wallet-create-intro");
      return;
    }
    const words = splitMnemonic(state.createPendingMnemonic);
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
    clearMsg("wallet-create-verify-msg");
    if (!state.challenge || !state.createPendingMnemonic) {
      navigate("#wallet-create-seed");
      return;
    }
    const words = splitMnemonic(state.createPendingMnemonic);
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
    if (!state.createPendingMnemonic) {
      navigate("#wallet-create-intro");
      return;
    }
    const btn = q("wallet-create-pin-submit");
    if (btn) btn.disabled = true;
    try {
      await wallet.createWallet({
        pin,
        mnemonic: state.createPendingMnemonic,
        enrollBiometric: false
      });
      state.createPendingPin = pin;
      navigate("#wallet-create-biometric");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.WEAK_PIN)) {
        showMsg("wallet-create-pin-msg", "PIN muito comum ou previsível. Escolha outro.", "error");
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
    const unavailable = q("wallet-create-biometric-unavailable");
    try {
      const supported = await wallet.biometricSupported();
      if (supported) {
        enrollBtn?.classList.remove("hidden");
        unavailable?.classList.add("hidden");
      } else {
        enrollBtn?.classList.add("hidden");
        unavailable?.classList.remove("hidden");
      }
    } catch {
      enrollBtn?.classList.add("hidden");
      unavailable?.classList.remove("hidden");
    }
    if (skipBtn) skipBtn.disabled = false;
  });

  q("wallet-create-biometric-enroll")?.addEventListener("click", async () => {
    clearMsg("wallet-create-biometric-msg");
    const pin = state.createPendingPin;
    if (!pin) {
      navigate("#wallet-create-pin");
      return;
    }
    const btn = q("wallet-create-biometric-enroll");
    if (btn) btn.disabled = true;
    try {
      await wallet.addBiometric(pin);
      navigate("#wallet-create-done");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.BIOMETRIC_REJECTED)) {
        showMsg("wallet-create-biometric-msg", "Autenticação cancelada. Você pode ativar mais tarde.", "warning");
      } else {
        renderError("wallet-create-biometric-msg", err);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  q("wallet-create-biometric-skip")?.addEventListener("click", () => {
    navigate("#wallet-create-done");
  });

  // ====================================================================
  // #wallet-create-done — success.
  // ====================================================================
  route("#wallet-create-done", () => {
    state.createPendingMnemonic = null;
    state.createPendingPin = null;
    state.challenge = null;
    if (showToast) showToast("Carteira criada com sucesso.");
  });

  q("wallet-create-done-home")?.addEventListener("click", () => {
    resetFlowState();
    navigate("#home");
  });

  // ====================================================================
  // #wallet-restore-input — 12 typed inputs with autocomplete.
  // ====================================================================
  route("#wallet-restore-input", () => {
    const grid = q("wallet-restore-grid");
    if (!grid) return;
    clearMsg("wallet-restore-input-msg");
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
        state.restoreWords[i] = raw;
        if (raw.length < 2) {
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
      showMsg("wallet-restore-input-msg", "Uma ou mais palavras não estão na lista BIP39.", "error");
      return;
    }
    state.createPendingMnemonic = words.join(" ");
    navigate("#wallet-restore-pin");
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
    if (!state.createPendingMnemonic) {
      navigate("#wallet-restore-input");
      return;
    }
    const btn = q("wallet-restore-pin-submit");
    if (btn) btn.disabled = true;
    try {
      await wallet.restoreWallet({
        mnemonic: state.createPendingMnemonic,
        pin,
        enrollBiometric: false
      });
      state.createPendingPin = pin;
      navigate("#wallet-restore-biometric");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.WEAK_PIN)) {
        showMsg("wallet-restore-pin-msg", "PIN muito comum ou previsível. Escolha outro.", "error");
      } else if (isWalletError(err, ERROR_CODES.INVALID_MNEMONIC)) {
        showMsg("wallet-restore-pin-msg", "Combinação inválida. Confira se digitou corretamente.", "error");
      } else if (isWalletError(err, ERROR_CODES.DESCRIPTOR_MISMATCH)) {
        showMsg(
          "wallet-restore-pin-msg",
          "Essas 12 palavras geram uma carteira diferente da anterior neste aparelho.",
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
    const unavailable = q("wallet-restore-biometric-unavailable");
    try {
      const supported = await wallet.biometricSupported();
      if (supported) {
        enrollBtn?.classList.remove("hidden");
        unavailable?.classList.add("hidden");
      } else {
        enrollBtn?.classList.add("hidden");
        unavailable?.classList.remove("hidden");
      }
    } catch {
      enrollBtn?.classList.add("hidden");
      unavailable?.classList.remove("hidden");
    }
  });

  q("wallet-restore-biometric-enroll")?.addEventListener("click", async () => {
    clearMsg("wallet-restore-biometric-msg");
    const pin = state.createPendingPin;
    if (!pin) {
      navigate("#wallet-restore-pin");
      return;
    }
    const btn = q("wallet-restore-biometric-enroll");
    if (btn) btn.disabled = true;
    try {
      await wallet.addBiometric(pin);
      navigate("#wallet-restore-done");
    } catch (err) {
      if (isWalletError(err, ERROR_CODES.BIOMETRIC_REJECTED)) {
        showMsg("wallet-restore-biometric-msg", "Autenticação cancelada. Você pode ativar mais tarde.", "warning");
      } else {
        renderError("wallet-restore-biometric-msg", err);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  q("wallet-restore-biometric-skip")?.addEventListener("click", () => {
    navigate("#wallet-restore-done");
  });

  // ====================================================================
  // #wallet-restore-done — success.
  // ====================================================================
  route("#wallet-restore-done", () => {
    state.createPendingMnemonic = null;
    state.createPendingPin = null;
    state.restoreWords = new Array(12).fill("");
    if (showToast) showToast("Carteira restaurada com sucesso.");
  });

  q("wallet-restore-done-home")?.addEventListener("click", () => {
    resetFlowState();
    navigate("#home");
  });
}
